// Live preflight battery: launches a profile's hardened Chrome and drives it
// through every proxy + bot/fingerprint detector (same checks as signup gate).
// Prints a human-readable report so you can confirm the setup is LinkedIn-ready
// before enqueueing account creation.
//
// Spawned by `bless preflight-test` with TZ set from the profile's launch config.
import "../shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { api } from "../../convex/_generated/api.js";
import type { Doc, Id } from "../../convex/_generated/dataModel.js";
import { createEmitter } from "./emit.js";
import { launchSession } from "./session.js";
import {
  runPreflight,
  type CheckResult,
  type PreflightOutcome,
} from "./preflight.js";
import { createConvexBlobStore } from "../profile-store/convexBlobStore.js";
import { hydrateProfile } from "../profile-store/hydrate.js";
import { snapshotProfile } from "../profile-store/snapshot.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    strict: { type: "boolean", default: true },
    json: { type: "boolean", default: false },
    "keep-open": { type: "boolean", default: false },
  },
});

const profileId = positionals[0] as Id<"profiles"> | undefined;
if (!profileId) throw new Error("preflight-test: missing profileId argument");

const convexUrl = process.env.CONVEX_URL;
const workerKey = process.env.WORKER_KEY;
if (!convexUrl || !workerKey) throw new Error("preflight-test: CONVEX_URL/WORKER_KEY not set");

const convex = new ConvexHttpClient(convexUrl);

const bundle = await convex.mutation(api.sessions.openManual, { workerKey, profileId });
const profile = bundle.profile as Doc<"profiles">;
const launchConfig = bundle.launchConfig as Doc<"launchConfigs"> | null;
const proxyBinding = bundle.proxyBinding as Doc<"proxyBindings"> | null;
const currentSnapshot = bundle.currentSnapshot as Doc<"profileSnapshots"> | null;
const sessionId = bundle.sessionId as Id<"sessions">;

const emit = createEmitter({
  convex,
  workerKey,
  profileId: profile._id,
  sessionId,
  channel: "browser",
  ctx: { launchConfigHash: launchConfig?.hash },
});

const profilesDir = process.env.PROFILES_DIR ?? "./.profiles";
const userDataDir = path.resolve(profilesDir, profile._id);
fs.mkdirSync(userDataDir, { recursive: true });

const blobStore = createConvexBlobStore(convex, workerKey);
const hydrateOutcome = await hydrateProfile({
  profileDir: userDataDir,
  blobStore,
  latest: currentSnapshot
    ? { storageId: currentSnapshot.storageId, contentHash: currentSnapshot.contentHash }
    : null,
});
await emit("FingerprintLoaded", {
  hydrate: hydrateOutcome,
  launchConfigHash: launchConfig?.hash ?? null,
  snapshotHash: currentSnapshot?.contentHash ?? null,
});

const session = await launchSession({
  userDataDir,
  headless: false,
  locale: launchConfig?.locale,
  viewport: launchConfig
    ? { width: launchConfig.windowWidth, height: launchConfig.windowHeight }
    : undefined,
  proxy: proxyBinding
    ? {
        server: proxyBinding.server,
        username: proxyBinding.username,
        password: proxyBinding.password,
      }
    : undefined,
  fingerprint:
    process.env.FINGERPRINT_SPOOF !== "false" && launchConfig?.fingerprintSeed
      ? {
          seed: launchConfig.fingerprintSeed,
          hardwareConcurrency: launchConfig.hardwareConcurrency ?? undefined,
          deviceMemory: launchConfig.deviceMemory ?? undefined,
          languages: localeToLanguages(launchConfig.locale),
        }
      : undefined,
  args: ["--password-store=basic"],
});

await convex.mutation(api.tasks.setSessionEgress, {
  workerKey,
  sessionId,
  egressIp: session.egressIp,
  launchConfigHash: launchConfig?.hash,
});

const expectedGeo = proxyBinding?.geo;
const strict = values.strict !== false;

console.log("\n=== preflight test ===");
console.log(`profile:          ${profile.name} (${profile._id})`);
console.log(`egress IP:        ${session.egressIp}`);
console.log(`proxy:            ${proxyBinding ? `${proxyBinding.server} (${proxyBinding.geo})` : "none (direct)"}`);
console.log(`expected geo:     ${expectedGeo ?? "(none)"}`);
console.log(`fingerprint seed: ${launchConfig?.fingerprintSeed ?? "(none — re-provision to enable)"}`);
console.log(`strict mode:      ${strict}`);
console.log(`checks:           10 (6 proxy/network + 4 bot/fingerprint)`);
console.log("\nRunning checks — the browser will visit each detector page in turn.\n");

let outcome: PreflightOutcome;
try {
  outcome = await runPreflight({
    stagehand: session.stagehand,
    emit,
    egressIp: session.egressIp,
    expectedGeo,
    strict,
    onCheckComplete: (result, index, total) => {
      printCheckProgress(result, index, total);
    },
  });
} catch (err) {
  console.error("\n[preflight] failed:", err instanceof Error ? err.message : String(err));
  await emit("ActionFailed", { taskType: "preflight-test", error: String(err) });
  await session.close();
  await convex.mutation(api.sessions.closeManual, { workerKey, sessionId, outcome: "manual" });
  process.exit(1);
}

if (values.json) {
  console.log(JSON.stringify(formatJsonReport(outcome, profile, session.egressIp, proxyBinding), null, 2));
} else {
  printReport(outcome, profile, session.egressIp, proxyBinding);
}

if (values["keep-open"]) {
  console.log(
    "\nBrowser left open for inspection. Close the window or press Ctrl-C to snapshot and exit.\n",
  );
  await waitForEnd(userDataDir);
} else {
  console.log("\n[preflight-test] closing browser...");
}

await session.close();

const snapshot = await snapshotProfile({
  profileDir: userDataDir,
  blobStore,
  convex,
  workerKey,
  profileId: profile._id,
  sessionId,
  chromeVersion: profile.chromeVersion,
});
await emit("SnapshotCommitted", {
  snapshotId: snapshot.snapshotId,
  contentHash: snapshot.contentHash,
  sizeBytes: snapshot.sizeBytes,
});

await convex.mutation(api.sessions.closeManual, { workerKey, sessionId, outcome: "manual" });
console.log(`session closed, snapshot committed (${snapshot.sizeBytes} bytes).`);
process.exit(outcome.ok ? 0 : 1);

function statusLabel(status: CheckResult["status"]): string {
  if (status === "pass") return "PASS";
  if (status === "suspicious") return "FAIL";
  return "ERR ";
}

function printCheckProgress(result: CheckResult, index: number, total: number): void {
  const label = statusLabel(result.status);
  const detail =
    result.error ??
    (result.reasons.length > 0 ? result.reasons.join("; ") : result.verdict?.summary ?? "ok");
  console.log(`[${index}/${total}] ${label}  ${result.id.padEnd(22)} ${detail.slice(0, 120)}`);
}

function printReport(
  outcome: PreflightOutcome,
  profile: Doc<"profiles">,
  egressIp: string,
  proxyBinding: Doc<"proxyBindings"> | null,
): void {
  const proxyResults = outcome.results.filter((r) => r.category === "proxy");
  const fpResults = outcome.results.filter((r) => r.category === "fingerprint");

  console.log("\n" + "=".repeat(72));
  console.log("PREFLIGHT REPORT");
  console.log("=".repeat(72));
  console.log(`Profile:     ${profile.name} (${profile._id})`);
  console.log(`Egress IP:   ${egressIp}`);
  console.log(`Proxy:       ${proxyBinding ? `${proxyBinding.server} (${proxyBinding.geo})` : "none (direct)"}`);
  console.log(`Summary:     ${outcome.summary}`);
  console.log("");

  printSection("PROXY / NETWORK", proxyResults);
  printSection("FINGERPRINT / BOT", fpResults);

  const passed = outcome.results.filter((r) => r.status === "pass").length;
  const failed = outcome.results.filter((r) => r.status === "suspicious").length;
  const errored = outcome.results.filter((r) => r.status === "error").length;

  console.log("=".repeat(72));
  if (outcome.ok) {
    console.log(`VERDICT: CLEAN (${passed}/${outcome.results.length} pass)`);
    console.log("Safe to proceed to LinkedIn signup with this profile setup.");
  } else {
    console.log(
      `VERDICT: NOT READY (${passed} pass, ${failed} fail, ${errored} error)`,
    );
    console.log("Fix the issues above before enqueueing LinkedIn account creation.");
    const blockers = outcome.results
      .filter((r) => r.status !== "pass")
      .flatMap((r) => (r.reasons.length > 0 ? r.reasons : r.error ? [`${r.id}: ${r.error}`] : [`${r.id}: check errored`]));
    if (blockers.length > 0) {
      console.log("\nBlockers:");
      for (const b of blockers) console.log(`  • ${b}`);
    }
  }
  console.log("=".repeat(72));
}

function printSection(title: string, results: CheckResult[]): void {
  console.log(title);
  console.log("-".repeat(title.length));
  for (const r of results) {
    const label = statusLabel(r.status);
    console.log(`  [${label}] ${r.id}`);
    console.log(`         ${r.url}`);
    if (r.verdict) {
      const v = r.verdict;
      if (r.category === "proxy") {
        if (v.publicIps.length > 0) console.log(`         IPs: ${v.publicIps.join(", ")}`);
        if (v.reportedLocation) console.log(`         Location: ${v.reportedLocation}`);
        if (v.riskScore != null) console.log(`         Risk score: ${v.riskScore}`);
        if (v.proxyOrVpnDetected) console.log(`         Proxy/VPN flagged: yes`);
        if (v.explicitLeak) console.log(`         Leak: yes`);
      } else if (v.botOrHeadlessDetected) {
        console.log(`         Bot/headless: detected`);
      }
      console.log(`         ${v.summary}`);
    }
    for (const reason of r.reasons) console.log(`         ! ${reason}`);
    if (r.error) console.log(`         ! ${r.error}`);
    console.log("");
  }
}

function formatJsonReport(
  outcome: PreflightOutcome,
  profile: Doc<"profiles">,
  egressIp: string,
  proxyBinding: Doc<"proxyBindings"> | null,
) {
  return {
    ok: outcome.ok,
    summary: outcome.summary,
    profile: { id: profile._id, name: profile.name },
    egressIp,
    proxy: proxyBinding
      ? { server: proxyBinding.server, geo: proxyBinding.geo }
      : null,
    results: outcome.results.map((r) => ({
      id: r.id,
      category: r.category,
      url: r.url,
      status: r.status,
      reasons: r.reasons,
      error: r.error ?? null,
      verdict: r.verdict,
    })),
  };
}

function waitForEnd(dir: string): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      resolve();
    };
    process.once("SIGINT", () => {
      console.log("\n[preflight-test] SIGINT received.");
      finish();
    });
    const pidFile = path.join(dir, "chrome.pid");
    const timer = setInterval(() => {
      let pid: number | null = null;
      try {
        pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      } catch {
        return;
      }
      if (!pid || Number.isNaN(pid)) return;
      try {
        process.kill(pid, 0);
      } catch {
        console.log("\n[preflight-test] browser window closed.");
        finish();
      }
    }, 1000);
  });
}

function localeToLanguages(locale: string): string[] {
  const base = locale.split("-")[0];
  return base && base !== locale ? [locale, base] : [locale];
}

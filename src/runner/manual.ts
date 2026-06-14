// Manual session runner: launches a profile's hardened Chrome (same fingerprint,
// proxy, and WebRTC hardening as automated runs) for hands-on use, then waits
// for the human to finish. No agent, no preflight gate — Stagehand only opens
// the browser and stays out of the way. On exit the profile is snapshotted so
// manual logins/cookies persist exactly like an automated session.
//
// Spawned by `bless launch` with TZ set from the profile's launch config.
import "../shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { api } from "../../convex/_generated/api.js";
import type { Doc, Id } from "../../convex/_generated/dataModel.js";
import { createEmitter } from "./emit.js";
import { launchSession } from "./session.js";
import { createConvexBlobStore } from "../profile-store/convexBlobStore.js";
import { hydrateProfile } from "../profile-store/hydrate.js";
import { snapshotProfile } from "../profile-store/snapshot.js";

const DEFAULT_START_URL = "https://anti-detect-scanner-production.up.railway.app/";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { url: { type: "string" } },
});

const profileId = positionals[0] as Id<"profiles"> | undefined;
if (!profileId) throw new Error("manual: missing profileId argument");

const convexUrl = process.env.CONVEX_URL;
const workerKey = process.env.WORKER_KEY;
if (!convexUrl || !workerKey) throw new Error("manual: CONVEX_URL/WORKER_KEY not set");

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
  headless: false, // manual mode is always headful
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

const startUrl =
  values.url ?? process.env.MANUAL_START_URL ?? process.env.FINGERPRINT_SCANNER_URL ?? DEFAULT_START_URL;

try {
  const page = session.stagehand.context.activePage();
  if (page) await page.goto(startUrl, { waitUntil: "load" }).catch(() => {});
} catch {
  // best effort — the user can navigate manually
}

console.log("\n=== manual session live ===");
console.log(`profile:          ${profile.name} (${profile._id})`);
console.log(`egress IP:        ${session.egressIp}`);
console.log(`proxy:            ${proxyBinding ? `${proxyBinding.server} (${proxyBinding.geo})` : "none (direct)"}`);
console.log(`fingerprint seed: ${launchConfig?.fingerprintSeed ?? "(none — re-provision to enable)"}`);
console.log(`start URL:        ${startUrl}`);
console.log(
  "\nUse the browser freely. Close the window or press Ctrl-C here to end the\n" +
    "session — the profile is snapshotted on exit so logins/cookies persist.\n",
);

await waitForEnd(userDataDir);

console.log("\n[manual] closing browser and snapshotting profile...");
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
process.exit(0);

// Resolves when the user either closes the browser window (chrome.pid dies) or
// presses Ctrl-C in this terminal — whichever happens first.
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
      console.log("\n[manual] SIGINT received.");
      finish();
    });
    const pidFile = path.join(dir, "chrome.pid");
    const timer = setInterval(() => {
      let pid: number | null = null;
      try {
        pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      } catch {
        return; // pid file not written yet
      }
      if (!pid || Number.isNaN(pid)) return;
      try {
        process.kill(pid, 0); // existence check only
      } catch {
        console.log("\n[manual] browser window closed.");
        finish();
      }
    }, 1000);
  });
}

function localeToLanguages(locale: string): string[] {
  const base = locale.split("-")[0];
  return base && base !== locale ? [locale, base] : [locale];
}

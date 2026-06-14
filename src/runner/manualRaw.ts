// RAW manual session runner: launches the profile's Chrome DIRECTLY (no
// Stagehand, no CDP connection, no DevTools websocket, no v3 piercer). This is
// the closest possible thing to a real user-launched Chrome and serves two
// purposes:
//   1. A true hands-on browser ("not overtaken by Stagehand").
//   2. A decisive fingerprint baseline — if fingerprint.com is CLEAN here but
//      flagged under the Stagehand runner, the CDP/piercer surface is the cause.
//
// Differences vs manual.ts (the Stagehand runner):
//   - No CDP → no `developer_tools` signal, no `window.__stagehandV3__` /
//     patched attachShadow piercer globals.
//   - No init-script injection → the fingerprint noise patch does NOT apply
//     here (priority #3); this run reflects the machine's real canvas/WebGL.
//   - No `--disable-blink-features=AutomationControlled` → no "unsupported
//     flag" infobar, and navigator.webdriver is natively false anyway.
//
// Spawned by `bless launch --raw` with TZ set from the profile's launch config.
import "../shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { getChromePath } from "chrome-launcher";
import { api } from "../../convex/_generated/api.js";
import type { Doc, Id } from "../../convex/_generated/dataModel.js";
import { createEmitter } from "./emit.js";
import { resolveEgressIp } from "./session.js";
import { startProxyRelay, type ProxyRelay } from "./proxy.js";
import { resolveWebrtcIpPolicy, seedWebrtcPreference, webrtcFlags } from "./chromeFlags.js";
import { createConvexBlobStore } from "../profile-store/convexBlobStore.js";
import { hydrateProfile } from "../profile-store/hydrate.js";
import { snapshotProfile } from "../profile-store/snapshot.js";

const DEFAULT_START_URL = "https://anti-detect-scanner-production.up.railway.app/";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { url: { type: "string" } },
});

const profileId = positionals[0] as Id<"profiles"> | undefined;
if (!profileId) throw new Error("manualRaw: missing profileId argument");

const convexUrl = process.env.CONVEX_URL;
const workerKey = process.env.WORKER_KEY;
if (!convexUrl || !workerKey) throw new Error("manualRaw: CONVEX_URL/WORKER_KEY not set");

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
  mode: "raw",
});

// WebRTC leak prevention (same as the Stagehand runner): seed the pref on disk
// and pass the command-line flags.
const webrtcPolicy = resolveWebrtcIpPolicy();
seedWebrtcPreference(userDataDir, webrtcPolicy);

let relay: ProxyRelay | null = null;
let egressIp = "unknown";
try {
  if (proxyBinding) {
    relay = await startProxyRelay({
      server: proxyBinding.server,
      username: proxyBinding.username,
      password: proxyBinding.password,
    });
  }
  egressIp = await resolveEgressIp(relay?.server);
} catch (err) {
  console.error(`[manualRaw] egress IP resolution failed: ${String(err)}`);
}

await convex.mutation(api.tasks.setSessionEgress, {
  workerKey,
  sessionId,
  egressIp,
  launchConfigHash: launchConfig?.hash,
});

const startUrl =
  values.url ?? process.env.MANUAL_START_URL ?? process.env.FINGERPRINT_SCANNER_URL ?? DEFAULT_START_URL;

// Minimal, real-browser flag set. We deliberately DO NOT pass any
// automation/stealth flags here (no --disable-blink-features, no
// --remote-debugging-port). The goal is to look exactly like a user launch.
const chromeFlags: string[] = [
  `--user-data-dir=${userDataDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--password-store=basic",
  ...webrtcFlags(webrtcPolicy),
];
if (launchConfig) {
  chromeFlags.push(`--window-size=${launchConfig.windowWidth},${launchConfig.windowHeight}`);
  if (launchConfig.locale) chromeFlags.push(`--lang=${launchConfig.locale}`);
}
if (relay) chromeFlags.push(`--proxy-server=${relay.server}`);
chromeFlags.push(startUrl);

const chromePath = process.env.CHROME_PATH ?? getChromePath();

console.log("\n=== RAW manual session live (no CDP / no Stagehand) ===");
console.log(`profile:          ${profile.name} (${profile._id})`);
console.log(`chrome:           ${chromePath}`);
console.log(`egress IP:        ${egressIp}`);
console.log(`proxy:            ${proxyBinding ? `${proxyBinding.server} (${proxyBinding.geo})` : "none (direct)"}`);
console.log(`start URL:        ${startUrl}`);
console.log(
  "\nThis browser has NO automation attached. Use it freely; close the window\n" +
    "or press Ctrl-C here to end the session (profile is snapshotted on exit).\n",
);

const child = spawn(chromePath, chromeFlags, { stdio: "ignore", detached: false });

await new Promise<void>((resolve) => {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    resolve();
  };
  process.once("SIGINT", () => {
    console.log("\n[manualRaw] SIGINT — closing browser.");
    try {
      child.kill();
    } catch {
      // already gone
    }
    finish();
  });
  child.on("exit", () => {
    console.log("\n[manualRaw] browser closed.");
    finish();
  });
  child.on("error", (err) => {
    console.error(`[manualRaw] failed to launch chrome: ${String(err)}`);
    finish();
  });
});

// Give Chrome a moment to release SQLite/LevelDB locks before snapshotting.
await new Promise((r) => setTimeout(r, 1500));
if (relay) await relay.close();

console.log("[manualRaw] snapshotting profile...");
try {
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
    mode: "raw",
  });
  console.log(`[manualRaw] snapshot committed (${snapshot.sizeBytes} bytes).`);
} catch (err) {
  console.error(`[manualRaw] snapshot failed: ${String(err)}`);
}

await convex.mutation(api.sessions.closeManual, { workerKey, sessionId, outcome: "manual-raw" });
console.log("[manualRaw] session closed.");
process.exit(0);

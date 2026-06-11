// Subprocess entry: one session per process. TZ is set by the worker when
// spawning — never here.
import "../shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { api } from "../../convex/_generated/api.js";
import type { Doc, Id } from "../../convex/_generated/dataModel.js";
import { createEmitter } from "./emit.js";
import { classifyPage } from "./classify.js";
import { launchSession, DEFAULT_MODEL } from "./session.js";
import { createConvexBlobStore } from "../profile-store/convexBlobStore.js";
import { hydrateProfile } from "../profile-store/hydrate.js";
import { snapshotProfile } from "../profile-store/snapshot.js";

export interface RunnerBundle {
  task: Doc<"tasks"> | null;
  profile: Doc<"profiles">;
  persona: Doc<"personas"> | null;
  launchConfig: Doc<"launchConfigs"> | null;
  proxyBinding: Doc<"proxyBindings"> | null;
  currentSnapshot: Doc<"profileSnapshots"> | null;
  sessionId: Id<"sessions">;
}

const raw = process.argv[2];
if (!raw) throw new Error("runner: missing bundle JSON argument");
const bundle = JSON.parse(raw) as RunnerBundle;
if (!bundle.task) throw new Error("runner: bundle has no task");
const task = bundle.task;

const convexUrl = process.env.CONVEX_URL;
const workerKey = process.env.WORKER_KEY;
if (!convexUrl || !workerKey) throw new Error("runner: CONVEX_URL/WORKER_KEY not set");

const convex = new ConvexHttpClient(convexUrl);
const stagehandVersion = readStagehandVersion();

const emit = createEmitter({
  convex,
  workerKey,
  profileId: bundle.profile._id,
  sessionId: bundle.sessionId,
  taskId: task._id,
  channel: "browser",
  ctx: {
    launchConfigHash: bundle.launchConfig?.hash,
    personaVersion: bundle.persona?.version,
    model: DEFAULT_MODEL,
    stagehandVersion,
  },
});

const profilesDir = process.env.PROFILES_DIR ?? "./.profiles";
const userDataDir = path.resolve(profilesDir, bundle.profile._id);
fs.mkdirSync(userDataDir, { recursive: true });

const blobStore = createConvexBlobStore(convex, workerKey);
const hydrateOutcome = await hydrateProfile({
  profileDir: userDataDir,
  blobStore,
  latest: bundle.currentSnapshot
    ? {
        storageId: bundle.currentSnapshot.storageId,
        contentHash: bundle.currentSnapshot.contentHash,
      }
    : null,
});
await emit("FingerprintLoaded", {
  hydrate: hydrateOutcome,
  launchConfigHash: bundle.launchConfig?.hash ?? null,
  snapshotHash: bundle.currentSnapshot?.contentHash ?? null,
});

const session = await launchSession({
  userDataDir,
  headless: process.env.HEADLESS === "true",
  locale: bundle.launchConfig?.locale,
  viewport: bundle.launchConfig
    ? { width: bundle.launchConfig.windowWidth, height: bundle.launchConfig.windowHeight }
    : undefined,
  proxy: bundle.proxyBinding
    ? {
        server: bundle.proxyBinding.server,
        username: bundle.proxyBinding.username,
        password: bundle.proxyBinding.password,
      }
    : undefined,
  // Keeps profiles portable across Linux hosts; harmless on Windows dev.
  args: ["--password-store=basic"],
});

await convex.mutation(api.tasks.setSessionEgress, {
  workerKey,
  sessionId: bundle.sessionId,
  egressIp: session.egressIp,
  launchConfigHash: bundle.launchConfig?.hash,
});

let exitCode = 0;
try {
  const BROWSER_TASK_TYPES = ["browse", "warmup_feed", "engage_post"];
  if (!BROWSER_TASK_TYPES.includes(task.type)) {
    throw new Error(`unsupported task type: ${task.type}`);
  }
  const payload = (task.payload ?? {}) as {
    url?: string;
    instruction?: string;
    evaluate?: string;
    maxSteps?: number;
  };
  const url = payload.url ?? process.env.START_URL ?? "https://example.com";
  const maxSteps = payload.maxSteps ?? Number(process.env.MAX_STEPS ?? 15);

  const actionId = randomUUID();
  await emit(
    "ActionStarted",
    { url, instruction: payload.instruction ?? null, egressIp: session.egressIp },
    actionId,
  );
  try {
    const page = session.stagehand.context.activePage();
    if (!page) throw new Error("no active page after launch");
    await page.goto(url, { waitUntil: "load" });
    await classifyPage(session.stagehand, emit, actionId);

    let evalResult: unknown;
    if (payload.evaluate) {
      evalResult = await page.evaluate(payload.evaluate);
      await emit("ActionSucceeded", { evaluate: payload.evaluate, evalResult }, `${actionId}:eval`);
    }

    if (!payload.instruction) {
      await emit("ActionSucceeded", { message: "browse completed (no instruction)", evalResult }, actionId);
    } else {
      const agent = session.stagehand.agent({ mode: "hybrid" });
      const result = await agent.execute({
        instruction: payload.instruction,
        maxSteps,
      });
      // Per-step audit events from the agent trace (callbacks are experimental in v3).
      for (let i = 0; i < result.actions.length; i++) {
        const action = result.actions[i];
        await emit(
          "ActionSucceeded",
          {
            step: i + 1,
            actionType: action.type,
            reasoning: typeof action.reasoning === "string" ? action.reasoning.slice(0, 500) : undefined,
            pageUrl: action.pageUrl,
            timeMs: action.timeMs,
          },
          `${actionId}:step:${i + 1}`,
        );
      }
      await classifyPage(session.stagehand, emit, actionId);
      if (result.success) {
        await emit(
          "ActionSucceeded",
          { message: result.message, completed: result.completed, steps: result.actions.length },
          actionId,
        );
      } else {
        await emit("ActionFailed", { message: result.message }, actionId);
        exitCode = 1;
      }
    }
  } catch (err) {
    // Recorded via events, then fails the task through the exit code.
    await emit("ActionFailed", { error: String(err) }, actionId);
    exitCode = 1;
  }
} finally {
  await session.close();
}

// Archive only after Chrome is fully closed.
const snapshot = await snapshotProfile({
  profileDir: userDataDir,
  blobStore,
  convex,
  workerKey,
  profileId: bundle.profile._id,
  sessionId: bundle.sessionId,
  chromeVersion: bundle.profile.chromeVersion,
});
await emit("SnapshotCommitted", {
  snapshotId: snapshot.snapshotId,
  contentHash: snapshot.contentHash,
  sizeBytes: snapshot.sizeBytes,
});

process.exit(exitCode);

function readStagehandVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require("@browserbasehq/stagehand/package.json") as { version: string };
  return pkg.version;
}

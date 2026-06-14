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
import { runSignup, runLogin } from "./signup.js";
import { runPreflight } from "./preflight.js";
import { runFingerprintCheck } from "./fingerprintCheck.js";
import { buildBehavior, type PersonaLike } from "./behaviors.js";
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
  strategyVersionId: Id<"strategyVersions"> | null;
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
    strategyVersionId: bundle.strategyVersionId ?? undefined,
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
  fingerprint:
    process.env.FINGERPRINT_SPOOF !== "false" && bundle.launchConfig?.fingerprintSeed
      ? {
          seed: bundle.launchConfig.fingerprintSeed,
          hardwareConcurrency: bundle.launchConfig.hardwareConcurrency ?? undefined,
          deviceMemory: bundle.launchConfig.deviceMemory ?? undefined,
          languages: localeToLanguages(bundle.launchConfig.locale),
        }
      : undefined,
  // Base args only. launchSession merges in the WebRTC + stealth hardening
  // (see chromeFlags.ts); --password-store=basic keeps profiles portable across
  // Linux hosts and is harmless on Windows dev.
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
  const BROWSER_TASK_TYPES = ["browse", "signup", "login", "warmup_feed", "engage_post"];
  if (!BROWSER_TASK_TYPES.includes(task.type)) {
    throw new Error(`unsupported task type: ${task.type}`);
  }
  const payload = (task.payload ?? {}) as {
    url?: string;
    instruction?: string;
    evaluate?: string;
    maxSteps?: number;
    skipPreflight?: boolean;
  };

  // Gate: before creating a LinkedIn account, prove the proxy + fingerprint are
  // clean. A leaky setup aborts here so no account is ever born behind it.
  const preflightOn = task.type === "signup" && payload.skipPreflight !== true && process.env.PREFLIGHT !== "false";
  const fingerprintCheckOn =
    task.type === "signup" &&
    payload.skipPreflight !== true &&
    process.env.PREFLIGHT_FINGERPRINT !== "false" &&
    process.env.FINGERPRINT_SPOOF !== "false";
  if (preflightOn) {
    const preflight = await runPreflight({
      stagehand: session.stagehand,
      emit,
      egressIp: session.egressIp,
      expectedGeo: bundle.proxyBinding?.geo,
    });
    if (!preflight.ok) {
      await emit("ActionFailed", { phase: "preflight", error: preflight.summary }, randomUUID());
      exitCode = 1;
    }
  }

  if (exitCode === 0 && fingerprintCheckOn) {
    const fpCheck = await runFingerprintCheck({
      stagehand: session.stagehand,
      convex,
      workerKey,
      profileId: bundle.profile._id,
      emit,
    });
    if (!fpCheck.ok) {
      await emit(
        "ActionFailed",
        { phase: "fingerprint_check", error: fpCheck.reasons.join("; ") },
        randomUUID(),
      );
      exitCode = 1;
    }
  }

  if (exitCode === 0 && (task.type === "signup" || task.type === "login")) {
    // Account flows own their full action lifecycle (events, creds, transitions).
    const flowDeps = {
      stagehand: session.stagehand,
      convex,
      workerKey,
      emit,
      profile: bundle.profile,
      persona: bundle.persona,
      maxSteps: payload.maxSteps,
    };
    try {
      const ok = task.type === "signup" ? await runSignup(flowDeps) : await runLogin(flowDeps);
      if (!ok) exitCode = 1;
    } catch (err) {
      await emit("ActionFailed", { error: String(err) }, randomUUID());
      exitCode = 1;
    }
  } else if (exitCode === 0) {
    // browse / warmup_feed / engage_post — fall back to persona-driven LinkedIn
    // behaviors when the payload carries no explicit instruction.
    const personaLike = (bundle.persona?.data ?? null) as PersonaLike | null;
    const behavior = payload.instruction ? null : buildBehavior(task.type, personaLike);
    const url = payload.url ?? behavior?.url ?? process.env.START_URL ?? "https://example.com";
    const instruction = payload.instruction ?? behavior?.instruction;
    const maxSteps =
      payload.maxSteps ?? behavior?.maxSteps ?? Number(process.env.MAX_STEPS ?? 15);

    const actionId = randomUUID();
    await emit(
      "ActionStarted",
      { url, instruction: instruction ?? null, egressIp: session.egressIp },
      actionId,
    );
    try {
      const page = session.stagehand.context.activePage();
      if (!page) throw new Error("no active page after launch");
      await page.goto(url, { waitUntil: "load" });
      const pageState = await classifyPage(session.stagehand, emit, actionId);

      if (pageState === "login" && (task.type === "warmup_feed" || task.type === "engage_post")) {
        // Session expired: surface the anomaly, queue a login, fail this task.
        await emit("AnomalyObserved", { reason: "login_wall", taskType: task.type }, actionId);
        await convex.mutation(api.tasks.enqueue, {
          workerKey,
          profileId: bundle.profile._id,
          type: "login",
          payload: { reason: `login wall during ${task.type}` },
        });
        await emit(
          "ActionFailed",
          { error: "session not authenticated (login wall) — login task enqueued" },
          actionId,
        );
        exitCode = 1;
      } else {
        let evalResult: unknown;
        if (payload.evaluate) {
          evalResult = await page.evaluate(payload.evaluate);
          await emit("ActionSucceeded", { evaluate: payload.evaluate, evalResult }, `${actionId}:eval`);
        }

        if (!instruction) {
          await emit("ActionSucceeded", { message: "browse completed (no instruction)", evalResult }, actionId);
        } else {
          const agent = session.stagehand.agent({ mode: "hybrid" });
          const result = await agent.execute({
            instruction,
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
      }
    } catch (err) {
      // Recorded via events, then fails the task through the exit code.
      await emit("ActionFailed", { error: String(err) }, actionId);
      exitCode = 1;
    }
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

function localeToLanguages(locale: string): string[] {
  const base = locale.split("-")[0];
  return base && base !== locale ? [locale, base] : [locale];
}

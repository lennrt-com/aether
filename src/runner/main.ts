// Subprocess entry: one session per process. TZ is set by the worker when
// spawning — never here.
import "../shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { api } from "../../convex/_generated/api.js";
import type { Doc, Id } from "../../convex/_generated/dataModel.js";
import { createEmitter } from "./emit.js";
import { classifyPage } from "./classify.js";
import { evalInPage } from "./cdpEval.js";
import { launchSession } from "./session.js";
import { resolveAgentModel } from "../shared/agentModels.js";
import { runLogin } from "./signup.js";
import { runCompleteOnboarding } from "./completeOnboarding.js";
import { runPreflight } from "./preflight.js";
import { runFingerprintCheck } from "./fingerprintCheck.js";
import {
  buildBehavior,
  type PersonaLike,
  withDirectActInstruction,
} from "./behaviors.js";
import { loadAgentInstructions } from "./loadAgentInstructions.js";
import { createAgent } from "./agentDefaults.js";
import { createConvexBlobStore } from "../profile-store/convexBlobStore.js";
import { hydrateProfile } from "../profile-store/hydrate.js";
import { snapshotProfile } from "../profile-store/snapshot.js";
import { runSignupSession, runAgentSession, parseAgentPayloadFromTask, type SessionBundle } from "./sessionFlow.js";

export interface RunnerBundle extends SessionBundle {}

const raw = process.argv[2];
if (!raw) throw new Error("runner: missing bundle JSON argument");
const bundle = JSON.parse(raw) as RunnerBundle;
if (!bundle.task) throw new Error("runner: bundle has no task");
const task = bundle.task;

const taskPayload = (task.payload ?? {}) as {
  url?: string;
  instruction?: string;
  evaluate?: string;
  maxSteps?: number;
  skipPreflight?: boolean;
  model?: string;
};
const agentModel = resolveAgentModel(taskPayload.model);

const convexUrl = process.env.CONVEX_URL;
const workerKey = process.env.WORKER_KEY;
if (!convexUrl || !workerKey) throw new Error("runner: CONVEX_URL/WORKER_KEY not set");

const convex = new ConvexHttpClient(convexUrl);

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
    model: agentModel,
  },
});

// Signup uses the shared sequenced flow.
if (task.type === "signup") {
  const result = await runSignupSession({
    convex,
    workerKey,
    emit,
    bundle,
    maxSteps: taskPayload.maxSteps,
    skipPreflight: taskPayload.skipPreflight,
    model: taskPayload.model,
  });
  process.exit(result.exitCode);
}

if (task.type === "agent") {
  const agentPayload = parseAgentPayloadFromTask(task.payload);
  const result = await runAgentSession({
    convex,
    workerKey,
    emit,
    bundle,
    payload: agentPayload,
  });
  process.exit(result.exitCode);
}

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
  model: agentModel,
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
  const BROWSER_TASK_TYPES = ["browse", "login", "complete_onboarding", "warmup_feed", "engage_post"];
  if (!BROWSER_TASK_TYPES.includes(task.type)) {
    throw new Error(`unsupported task type: ${task.type}`);
  }
  const payload = taskPayload;

  if (task.type === "login") {
    const flowDeps = {
      stagehand: session.stagehand,
      convex,
      workerKey,
      emit,
      profile: bundle.profile,
      persona: bundle.persona,
      maxSteps: payload.maxSteps,
      proxy: bundle.proxyBinding
        ? {
            server: bundle.proxyBinding.server,
            username: bundle.proxyBinding.username,
            password: bundle.proxyBinding.password,
          }
        : undefined,
    };
    try {
      const ok = await runLogin(flowDeps);
      if (!ok) exitCode = 1;
    } catch (err) {
      await emit("ActionFailed", { error: String(err) }, randomUUID());
      exitCode = 1;
    }
  } else if (task.type === "complete_onboarding") {
    const flowDeps = {
      stagehand: session.stagehand,
      convex,
      workerKey,
      emit,
      profile: bundle.profile,
      persona: bundle.persona,
      maxSteps: payload.maxSteps,
      proxy: bundle.proxyBinding
        ? {
            server: bundle.proxyBinding.server,
            username: bundle.proxyBinding.username,
            password: bundle.proxyBinding.password,
          }
        : undefined,
    };
    try {
      const ok = await runCompleteOnboarding(flowDeps);
      if (!ok) exitCode = 1;
    } catch (err) {
      await emit("ActionFailed", { error: String(err) }, randomUUID());
      exitCode = 1;
    }
  } else {
    const personaLike = (bundle.persona?.data ?? null) as PersonaLike | null;
    const templates = await loadAgentInstructions(convex, workerKey);
    const behavior = payload.instruction ? null : buildBehavior(task.type, personaLike, templates);
    const url = payload.url ?? behavior?.url ?? process.env.START_URL;
    const instruction = payload.instruction ?? behavior?.instruction;
    const maxSteps =
      payload.maxSteps ?? behavior?.maxSteps ?? Number(process.env.MAX_STEPS ?? 15);

    const actionId = randomUUID();
    await emit(
      "ActionStarted",
      { url: url ?? null, instruction: instruction ?? null, egressIp: session.egressIp },
      actionId,
    );
    try {
      const page = session.stagehand.context.activePage();
      if (!page) throw new Error("no active page after launch");

      let agentResult: Awaited<ReturnType<ReturnType<typeof session.stagehand.agent>["execute"]>> | null = null;

      if (instruction) {
        // Let the AGENT navigate to the URL itself instead of a manual
        // page.goto. A pre-navigation suppresses Stagehand's visible cursor
        // (its overlay is injected on the next navigation after the agent
        // starts), so we hand the destination to the agent — mirroring
        // `bless experiment` without --start-url, where the cursor shows.
        // The scroll preamble settles lazy feed content the way the old
        // settlePage step did.
        const navPrefix = url ? `First, navigate the browser directly to ${url}.\n\n` : "";
        const agentInstruction = navPrefix + withDirectActInstruction(instruction, templates);
        const agent = createAgent(session.stagehand, { mode: "hybrid" });
        agentResult = await agent.execute({
          instruction: agentInstruction,
          maxSteps,
        });
        for (let i = 0; i < agentResult.actions.length; i++) {
          const action = agentResult.actions[i];
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
      } else {
        // No agent step: navigate directly (no Stagehand cursor involved).
        await page.goto(url ?? "https://example.com", { waitUntil: "load" });
      }

      let evalResult: unknown;
      if (payload.evaluate) {
        evalResult = await evalInPage(page, payload.evaluate);
        await emit("ActionSucceeded", { evaluate: payload.evaluate, evalResult }, `${actionId}:eval`);
      }

      const pageState = await classifyPage(session.stagehand, emit, actionId);

      if (pageState === "login" && (task.type === "warmup_feed" || task.type === "engage_post")) {
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
      } else if (agentResult) {
        if (agentResult.success) {
          await emit(
            "ActionSucceeded",
            { message: agentResult.message, completed: agentResult.completed, steps: agentResult.actions.length },
            actionId,
          );
        } else {
          await emit("ActionFailed", { message: agentResult.message }, actionId);
          exitCode = 1;
        }
      } else {
        await emit("ActionSucceeded", { message: "browse completed (no instruction)", evalResult }, actionId);
      }
    } catch (err) {
      await emit("ActionFailed", { error: String(err) }, randomUUID());
      exitCode = 1;
    }
  }
} finally {
  await session.close();
}

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

function localeToLanguages(locale: string): string[] {
  const base = locale.split("-")[0];
  return base && base !== locale ? [locale, base] : [locale];
}

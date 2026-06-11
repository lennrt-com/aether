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
import { launchSession, DEFAULT_MODEL } from "./session.js";

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
});

await convex.mutation(api.tasks.setSessionEgress, {
  workerKey,
  sessionId: bundle.sessionId,
  egressIp: session.egressIp,
  launchConfigHash: bundle.launchConfig?.hash,
});

let exitCode = 0;
try {
  if (task.type !== "browse") throw new Error(`unsupported task type: ${task.type}`);
  const payload = (task.payload ?? {}) as {
    url?: string;
    instruction?: string;
    maxSteps?: number;
  };
  const url = payload.url ?? process.env.START_URL ?? "https://example.com";
  const instruction = payload.instruction ?? "Summarize the page.";
  const maxSteps = payload.maxSteps ?? Number(process.env.MAX_STEPS ?? 15);

  const actionId = randomUUID();
  await emit("ActionStarted", { url, instruction, egressIp: session.egressIp }, actionId);
  try {
    const agent = session.stagehand.agent({ mode: "hybrid" });
    let stepIdx = 0;
    const result = await agent.execute({
      instruction: `Go to ${url} first. Then: ${instruction}`,
      maxSteps,
      callbacks: {
        onStepFinish: async (step) => {
          stepIdx += 1;
          await emit(
            "ActionSucceeded",
            {
              step: stepIdx,
              toolCalls: step.toolCalls.map((tc) => tc.toolName),
              text: step.text.slice(0, 500),
            },
            `${actionId}:step:${stepIdx}`,
          );
        },
      },
    });
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
  } catch (err) {
    // Recorded via events, then fails the task through the exit code.
    await emit("ActionFailed", { error: String(err) }, actionId);
    exitCode = 1;
  }
} finally {
  await session.close();
}

process.exit(exitCode);

function readStagehandVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require("@browserbasehq/stagehand/package.json") as { version: string };
  return pkg.version;
}

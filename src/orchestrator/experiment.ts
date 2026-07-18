// Foreground experiment orchestrator — spawned by `bless experiment`. No
// worker/task queue. Opens a pipeline session through a selected profile and
// turns a generic agent loose on the page to act on a free-form prompt.
import "../shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { parseArgs } from "node:util";
import { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel.js";
import { createEmitter } from "../runner/emit.js";
import { runExperimentSession, type SessionBundle } from "../runner/sessionFlow.js";
import { createConsoleReporter, formatStagehandLog } from "./reporter.js";
import { resolveAgentModel } from "../shared/agentModels.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    prompt: { type: "string" },
    "start-url": { type: "string" },
    "max-steps": { type: "string" },
    model: { type: "string" },
  },
});

const profileId = positionals[0] as Id<"profiles"> | undefined;
if (!profileId) throw new Error("orchestrator: missing profileId argument");

const prompt = values.prompt;
if (!prompt || !prompt.trim()) throw new Error("orchestrator: missing --prompt argument");

const convexUrl = process.env.CONVEX_URL;
const workerKey = process.env.WORKER_KEY;
if (!convexUrl || !workerKey) throw new Error("orchestrator: CONVEX_URL/WORKER_KEY not set");

const convex = new ConvexHttpClient(convexUrl);
const reporter = createConsoleReporter();

const bundle = (await convex.mutation(api.sessions.openPipeline, {
  workerKey,
  profileId,
  taskType: "experiment",
})) as SessionBundle;

const agentModel = resolveAgentModel(values.model);
const rawEmit = createEmitter({
  convex,
  workerKey,
  profileId: bundle.profile._id,
  sessionId: bundle.sessionId,
  channel: "browser",
  ctx: {
    launchConfigHash: bundle.launchConfig?.hash,
    personaVersion: bundle.persona?.version,
    model: agentModel,
  },
});
const emit = reporter.wrapEmit(rawEmit);

reporter.phase("experiment started");
console.log(`profile: ${bundle.profile.name} (${bundle.profile._id})`);
if (bundle.proxyBinding) {
  console.log(`proxy: ${bundle.proxyBinding.server} (${bundle.proxyBinding.geo})`);
}
console.log(`\nprompt:\n  ${prompt}\n`);

let exitCode = 1;
try {
  const result = await runExperimentSession({
    convex,
    workerKey,
    emit,
    bundle,
    prompt,
    startUrl: values["start-url"],
    maxSteps: values["max-steps"] ? Number(values["max-steps"]) : undefined,
    model: values.model,
    onLog: (line) => {
      const formatted = formatStagehandLog(line);
      if (formatted) reporter.info(`agent: ${formatted}`);
    },
  });
  exitCode = result.exitCode;
  if (exitCode === 0) {
    reporter.phase("experiment completed");
  } else {
    reporter.phase("experiment finished with errors");
  }
} catch (err) {
  reporter.phase(`experiment error: ${String(err)}`);
  exitCode = 1;
} finally {
  await convex.mutation(api.sessions.closePipeline, {
    workerKey,
    sessionId: bundle.sessionId,
    outcome: exitCode === 0 ? "ok" : "failed",
    status: exitCode === 0 ? "done" : "failed",
  });
}

process.exit(exitCode);

// Foreground signup orchestrator — spawned by `bless create`. No worker/task queue.
import "../shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { parseArgs } from "node:util";
import { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel.js";
import { createEmitter } from "../runner/emit.js";
import { runSignupSession, type SessionBundle } from "../runner/sessionFlow.js";
import { createConsoleReporter, formatStagehandLog } from "./reporter.js";
import { resolveAgentModel } from "../shared/agentModels.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "max-steps": { type: "string" },
    "skip-preflight": { type: "boolean", default: false },
    "skip-proxy-check": { type: "boolean", default: false },
    model: { type: "string" },
  },
});

const profileId = positionals[0] as Id<"profiles"> | undefined;
if (!profileId) throw new Error("orchestrator: missing profileId argument");

const convexUrl = process.env.CONVEX_URL;
const workerKey = process.env.WORKER_KEY;
if (!convexUrl || !workerKey) throw new Error("orchestrator: CONVEX_URL/WORKER_KEY not set");

const convex = new ConvexHttpClient(convexUrl);
const reporter = createConsoleReporter();

const bundle = (await convex.mutation(api.sessions.openPipeline, {
  workerKey,
  profileId,
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

reporter.phase("signup pipeline started");
console.log(`profile: ${bundle.profile.name} (${bundle.profile._id})`);
if (bundle.proxyBinding) {
  console.log(`proxy: ${bundle.proxyBinding.server} (${bundle.proxyBinding.geo})`);
}
if (values["skip-preflight"]) {
  reporter.info("skipping proxy + fingerprint checks — LinkedIn signup directly");
} else if (values["skip-proxy-check"]) {
  reporter.info("skipping proxy checks — fingerprint checks still run");
}

let exitCode = 1;
try {
  const result = await runSignupSession({
    convex,
    workerKey,
    emit,
    bundle,
    maxSteps: values["max-steps"] ? Number(values["max-steps"]) : undefined,
    skipPreflight: values["skip-preflight"] ?? false,
    skipProxyCheck: values["skip-proxy-check"] ?? false,
    model: values.model,
    onLog: (line) => {
      const formatted = formatStagehandLog(line);
      if (formatted) reporter.info(`agent: ${formatted}`);
    },
  });
  exitCode = result.exitCode;
  if (exitCode === 0) {
    reporter.phase("signup completed successfully");
  } else {
    reporter.phase("signup failed");
  }
} catch (err) {
  reporter.phase(`signup error: ${String(err)}`);
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

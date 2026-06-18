// Worker loop: register → poll claimNext every 15s → spawn runner subprocess
// per claim (crash isolation + per-profile TZ) → heartbeat → complete/fail.
import "../shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { api } from "../../convex/_generated/api.js";
import type { FunctionReturnType } from "convex/server";
import { CHANNEL } from "../channels/router.js";
import { createUnipileClient, UnipileApiError } from "../channels/unipile.js";
import { createEmitter } from "../runner/emit.js";
import type { TaskType } from "../shared/types.js";
import { resolveAgentModel } from "../shared/agentModels.js";

type ClaimBundle = NonNullable<FunctionReturnType<typeof api.tasks.claimNext>>;

const POLL_MS = 15_000;
const TASK_HEARTBEAT_MS = 2 * 60 * 1000;
const WORKER_HEARTBEAT_MS = 60_000;
const workerAgentModel = resolveAgentModel(process.env.AGENT_MODEL);

const convexUrl = process.env.CONVEX_URL;
const workerKey = process.env.WORKER_KEY;
if (!convexUrl || !workerKey) throw new Error("worker: CONVEX_URL/WORKER_KEY not set");
const key = workerKey;

const convex = new ConvexHttpClient(convexUrl);
const maxSessions = Number(process.env.MAX_SESSIONS ?? 2);
const workerName = process.env.WORKER_NAME ?? "local-1";

const workerId = await convex.mutation(api.workers.register, {
  workerKey: key,
  name: workerName,
  maxSessions,
});
console.log(`[worker] registered ${workerName} (${workerId}), maxSessions=${maxSessions}`);
console.log(`[worker] agent model: ${workerAgentModel}`);

setInterval(() => {
  convex
    .mutation(api.workers.heartbeat, { workerKey: key, workerId })
    .catch((err) => console.error("[worker] heartbeat failed:", err));
}, WORKER_HEARTBEAT_MS);

let activeSessions = 0;

// API-channel tasks run in-process — no subprocess, no browser.
async function runApiTask(bundle: ClaimBundle): Promise<void> {
  const task = bundle.task;
  if (!task) return;
  const emit = createEmitter({
    convex,
    workerKey: key,
    profileId: task.profileId,
    sessionId: bundle.sessionId,
    taskId: task._id,
    channel: "api",
    ctx: {
      personaVersion: bundle.persona?.version ?? undefined,
      strategyVersionId: bundle.strategyVersionId ?? undefined,
    },
  });
  const actionId = randomUUID();
  try {
    const accountId = bundle.profile.unipileAccountId;
    if (!accountId) throw new Error("profile has no unipileAccountId");
    const unipile = createUnipileClient();
    const payload = (task.payload ?? {}) as { userId?: string; text?: string; message?: string };
    if (!payload.userId) throw new Error(`${task.type} payload requires userId`);

    await emit("ActionStarted", { taskType: task.type, userId: payload.userId }, actionId);
    let data: Record<string, unknown>;
    switch (task.type) {
      case "fetch_profile": {
        const profile = await unipile.getProfile(accountId, payload.userId);
        data = {
          userId: profile.id,
          displayName: profile.display_name,
          publicIdentifier: profile.public_identifier ?? null,
          profileUrl: profile.profile_url ?? null,
        };
        break;
      }
      case "send_message": {
        if (!payload.text) throw new Error("send_message payload requires text");
        const res = await unipile.sendMessage(accountId, payload.userId, payload.text);
        data = { chatId: res.chat_id, messageId: res.message_id };
        break;
      }
      case "send_invitation": {
        const res = await unipile.sendInvitation(accountId, payload.userId, payload.message);
        data = { requestId: res.id };
        break;
      }
      default:
        throw new Error(`unsupported api task type: ${task.type}`);
    }
    await emit("ActionSucceeded", data, actionId);
    await convex.mutation(api.tasks.complete, { workerKey: key, taskId: task._id, outcome: "ok" });
    console.log(`[worker] api task ${task._id} (${task.type}) done`);
  } catch (err) {
    const httpStatus = err instanceof UnipileApiError ? err.status : undefined;
    await emit("ActionFailed", { error: String(err), httpStatus }, actionId);
    await convex.mutation(api.tasks.fail, { workerKey: key, taskId: task._id, error: String(err) });
    console.log(`[worker] api task ${task._id} failed: ${String(err)}`);
  }
}

function runTask(bundle: ClaimBundle): Promise<void> {
  return new Promise((resolve) => {
    const task = bundle.task;
    if (!task) {
      resolve();
      return;
    }
    const tz = bundle.launchConfig?.timezone ?? process.env.TZ ?? "UTC";
    console.log(`[worker] spawning runner for task ${task._id} (${task.type}), TZ=${tz}`);

    const child = spawn(
      "node",
      ["--import", "tsx", "src/runner/main.ts", JSON.stringify(bundle)],
      {
        env: {
          ...process.env,
          TZ: tz,
          AGENT_MODEL: process.env.AGENT_MODEL ?? workerAgentModel,
        },
        stdio: "inherit",
      },
    );

    const heartbeat = setInterval(() => {
      convex
        .mutation(api.tasks.heartbeatTask, { workerKey: key, taskId: task._id })
        .catch((err) => console.error("[worker] task heartbeat failed:", err));
    }, TASK_HEARTBEAT_MS);

    const finish = async (result: { code: number | null; error?: Error }) => {
      clearInterval(heartbeat);
      try {
        if (result.code === 0) {
          await convex.mutation(api.tasks.complete, {
            workerKey: key,
            taskId: task._id,
            outcome: "ok",
          });
          console.log(`[worker] task ${task._id} done`);
        } else {
          const error = result.error
            ? String(result.error)
            : `runner exited with code ${result.code}`;
          await convex.mutation(api.tasks.fail, { workerKey: key, taskId: task._id, error });
          console.log(`[worker] task ${task._id} failed: ${error}`);
        }
      } catch (err) {
        console.error(`[worker] failed to report task ${task._id} result:`, err);
      }
      resolve();
    };

    child.on("exit", (code) => void finish({ code }));
    child.on("error", (error) => void finish({ code: 1, error }));
  });
}

console.log(`[worker] polling every ${POLL_MS / 1000}s`);
for (;;) {
  if (activeSessions < maxSessions) {
    try {
      const bundle = await convex.mutation(api.tasks.claimNext, {
        workerKey: key,
        workerId,
      });
      if (bundle) {
        activeSessions += 1;
        const channel = bundle.task ? (CHANNEL[bundle.task.type as TaskType] ?? "browser") : "browser";
        const execution = channel === "api" ? runApiTask(bundle) : runTask(bundle);
        void execution.finally(() => {
          activeSessions -= 1;
        });
        continue; // immediately try to claim more if capacity remains
      }
    } catch (err) {
      console.error("[worker] claimNext failed:", err);
    }
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}

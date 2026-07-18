import { mutation, internalMutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { taskStatus } from "./schema";
import { assertWorkerKey, isProfileDisabled } from "./lib/guards";
import { appendEvent } from "./events";
import { internal } from "./_generated/api";

const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 30 * 60 * 1000;
const CLAIMABLE_STATUSES = ["active", "provisioning"];
const AGENT_TASK_TYPES = ["agent", "browse"];

function leaseMs(): number {
  const override = process.env.LEASE_MS;
  return override ? Number(override) : DEFAULT_LEASE_MS;
}

async function scheduleAgentWebhook(ctx: MutationCtx, task: Doc<"tasks">): Promise<void> {
  if (task.type !== "agent") return;
  const payload = (task.payload ?? {}) as { webhookUrl?: string };
  if (!payload.webhookUrl) return;
  // n8n /webhook-test/ URLs are delivered from the local worker (one-shot, editor-bound).
  if (payload.webhookUrl.includes("/webhook-test/")) return;
  await ctx.db.patch(task._id, {
    webhookDelivery: { status: "pending", attempt: 0 },
  });
  await ctx.scheduler.runAfter(0, internal.webhooks.deliver, { taskId: task._id, attempt: 1 });
}

export const enqueue = mutation({
  args: {
    workerKey: v.string(),
    profileId: v.id("profiles"),
    type: v.string(),
    payload: v.any(),
    dueAt: v.optional(v.number()),
    priority: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    return await ctx.db.insert("tasks", {
      profileId: args.profileId,
      type: args.type,
      payload: args.payload,
      status: "pending",
      priority: args.priority ?? 0,
      dueAt: args.dueAt ?? Date.now(),
      attempts: 0,
    });
  },
});

export const get = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    return await ctx.db.get(taskId);
  },
});

export const listFor = query({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    return await ctx.db
      .query("tasks")
      .withIndex("by_profile", (q) => q.eq("profileId", profileId))
      .collect();
  },
});

export const listByStatus = query({
  args: { status: taskStatus },
  handler: async (ctx, { status }) => {
    return await ctx.db
      .query("tasks")
      .withIndex("by_status_dueAt", (q) => q.eq("status", status))
      .collect();
  },
});

export const cancel = mutation({
  args: { workerKey: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { workerKey, taskId }) => {
    assertWorkerKey(workerKey);
    const task = await ctx.db.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.status !== "pending") throw new Error(`cannot cancel ${task.status} task`);
    await ctx.db.patch(taskId, { status: "cancelled" });
  },
});

export const stats = query({
  args: {},
  handler: async (ctx) => {
    const statuses = ["pending", "claimed", "done", "failed", "cancelled"] as const;
    const counts: Record<string, number> = {};
    for (const status of statuses) {
      const rows = await ctx.db
        .query("tasks")
        .withIndex("by_status_dueAt", (q) => q.eq("status", status))
        .collect();
      counts[status] = rows.length;
    }
    return counts;
  },
});

export const sessionForTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    return await ctx.db
      .query("sessions")
      .withIndex("by_task", (q) => q.eq("taskId", taskId))
      .first();
  },
});

export const claimNext = mutation({
  args: { workerKey: v.string(), workerId: v.id("workers") },
  handler: async (ctx, { workerKey, workerId }) => {
    assertWorkerKey(workerKey);
    const now = Date.now();
    const pending = ctx.db
      .query("tasks")
      .withIndex("by_status_dueAt", (q) => q.eq("status", "pending").lte("dueAt", now))
      .order("asc");

    for await (const task of pending) {
      const profile = await ctx.db.get(task.profileId);
      if (!profile) continue;
      if (profile.activeSessionId !== undefined) continue;
      if (isProfileDisabled(profile)) continue;

      const claimable =
        CLAIMABLE_STATUSES.includes(profile.status) ||
        (AGENT_TASK_TYPES.includes(task.type) && profile.ephemeral === true);
      if (!claimable) continue;

      const sessionId = await ctx.db.insert("sessions", {
        profileId: profile._id,
        taskId: task._id,
        workerId,
        channel: "browser",
        status: "running",
        startedAt: now,
      });
      await ctx.db.patch(task._id, {
        status: "claimed",
        claimedBy: workerId,
        leaseExpiresAt: now + leaseMs(),
      });
      await ctx.db.patch(profile._id, { activeSessionId: sessionId });
      await appendEvent(ctx, {
        profileId: profile._id,
        sessionId,
        taskId: task._id,
        type: "SessionStarted",
        ts: now,
        channel: "browser",
        data: { taskType: task.type },
        ctx: {},
      });

      const [claimedTask, persona, launchConfig, proxyBinding, currentSnapshot] =
        await Promise.all([
          ctx.db.get(task._id),
          profile.personaId ? ctx.db.get(profile.personaId) : null,
          profile.launchConfigId ? ctx.db.get(profile.launchConfigId) : null,
          profile.proxyBindingId ? ctx.db.get(profile.proxyBindingId) : null,
          profile.currentSnapshotId ? ctx.db.get(profile.currentSnapshotId) : null,
        ]);

      return {
        task: claimedTask,
        profile: { ...profile, activeSessionId: sessionId },
        persona,
        launchConfig,
        proxyBinding,
        currentSnapshot,
        sessionId,
        strategyVersionId: null,
      };
    }
    return null;
  },
});

export const setSessionEgress = mutation({
  args: {
    workerKey: v.string(),
    sessionId: v.id("sessions"),
    egressIp: v.string(),
    launchConfigHash: v.optional(v.string()),
  },
  handler: async (ctx, { workerKey, sessionId, egressIp, launchConfigHash }) => {
    assertWorkerKey(workerKey);
    await ctx.db.patch(sessionId, { egressIp, launchConfigHash });
  },
});

export const heartbeatTask = mutation({
  args: { workerKey: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { workerKey, taskId }) => {
    assertWorkerKey(workerKey);
    const task = await ctx.db.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.status !== "claimed") throw new Error(`cannot heartbeat ${task.status} task`);
    await ctx.db.patch(taskId, { leaseExpiresAt: Date.now() + leaseMs() });
  },
});

async function closeSession(
  ctx: MutationCtx,
  task: Doc<"tasks">,
  sessionStatus: "done" | "failed",
  outcome: string,
): Promise<void> {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_task", (q) => q.eq("taskId", task._id))
    .filter((q) => q.eq(q.field("status"), "running"))
    .first();
  const now = Date.now();
  if (session) {
    await ctx.db.patch(session._id, { status: sessionStatus, endedAt: now, outcome });
  }
  const profile = await ctx.db.get(task.profileId);
  if (profile && profile.activeSessionId !== undefined) {
    await ctx.db.patch(profile._id, { activeSessionId: undefined });
  }
  await appendEvent(ctx, {
    profileId: task.profileId,
    sessionId: session?._id,
    taskId: task._id,
    type: "SessionEnded",
    ts: now,
    channel: session?.channel ?? "system",
    data: { status: sessionStatus, outcome },
    ctx: {},
  });
}

export const setResult = mutation({
  args: {
    workerKey: v.string(),
    taskId: v.id("tasks"),
    result: v.any(),
  },
  handler: async (ctx, { workerKey, taskId, result }) => {
    assertWorkerKey(workerKey);
    const task = await ctx.db.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    await ctx.db.patch(taskId, { result });
  },
});

export const complete = mutation({
  args: { workerKey: v.string(), taskId: v.id("tasks"), outcome: v.optional(v.string()) },
  handler: async (ctx, { workerKey, taskId, outcome }) => {
    assertWorkerKey(workerKey);
    const task = await ctx.db.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.status !== "claimed") throw new Error(`cannot complete ${task.status} task`);
    await ctx.db.patch(taskId, {
      status: "done",
      claimedBy: undefined,
      leaseExpiresAt: undefined,
    });
    await closeSession(ctx, task, "done", outcome ?? "ok");
    const updated = await ctx.db.get(taskId);
    if (updated) await scheduleAgentWebhook(ctx, updated);
  },
});

async function failTask(ctx: MutationCtx, task: Doc<"tasks">, error: string): Promise<void> {
  const attempts = task.attempts + 1;
  if (attempts < MAX_ATTEMPTS) {
    await ctx.db.patch(task._id, {
      status: "pending",
      attempts,
      lastError: error,
      dueAt: Date.now() + RETRY_BACKOFF_MS * attempts,
      claimedBy: undefined,
      leaseExpiresAt: undefined,
    });
  } else {
    await ctx.db.patch(task._id, {
      status: "failed",
      attempts,
      lastError: error,
      claimedBy: undefined,
      leaseExpiresAt: undefined,
    });
  }
  await closeSession(ctx, task, "failed", error);
  const updated = await ctx.db.get(task._id);
  if (updated && updated.status === "failed") {
    await scheduleAgentWebhook(ctx, updated);
  }
}

export const fail = mutation({
  args: { workerKey: v.string(), taskId: v.id("tasks"), error: v.string() },
  handler: async (ctx, { workerKey, taskId, error }) => {
    assertWorkerKey(workerKey);
    const task = await ctx.db.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.status !== "claimed") throw new Error(`cannot fail ${task.status} task`);
    await failTask(ctx, task, error);
  },
});

export const reclaimExpiredLeases = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const claimed = await ctx.db
      .query("tasks")
      .withIndex("by_status_dueAt", (q) => q.eq("status", "claimed"))
      .collect();
    for (const task of claimed) {
      if (task.leaseExpiresAt !== undefined && task.leaseExpiresAt < now) {
        await failTask(ctx, task, "lease expired");
      }
    }
  },
});

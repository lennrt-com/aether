import { mutation, internalMutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { taskStatus } from "./schema";
import { assertWorkerKey, isProfileRestricted } from "./lib/guards";
import { appendEvent } from "./events";
import { getActiveStrategy } from "./policies";

// Pinned (Phase 2): lease 10 min, max 3 attempts, 30 min * attempts backoff.
// LEASE_MS deployment env var exists only for verification scripts.
const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 30 * 60 * 1000;
const CLAIMABLE_STATUSES = ["warming", "active", "cooldown"];
// signup/login are the only tasks runnable before the profile leaves provisioning.
const PROVISIONING_TASK_TYPES = ["signup", "login", "complete_onboarding"];
// Mirror of src/channels/router.ts (Convex can't import from src/).
const API_TASK_TYPES = ["send_message", "send_invitation", "fetch_profile"];

function leaseMs(): number {
  const override = process.env.LEASE_MS;
  return override ? Number(override) : DEFAULT_LEASE_MS;
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

// Queue depth by status (CLI `status` view).
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

// Single serializable mutation = the concurrency control. No extra locks.
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
      if (profile.maintained === false) continue;
      if (isProfileRestricted(profile)) continue;
      const claimable =
        CLAIMABLE_STATUSES.includes(profile.status) ||
        (profile.status === "provisioning" && PROVISIONING_TASK_TYPES.includes(task.type));
      if (!claimable) continue;

      // API tasks still create a sessions row (channel api) — one audit trail.
      const channel = API_TASK_TYPES.includes(task.type) ? ("api" as const) : ("browser" as const);
      const strategy = await getActiveStrategy(ctx, profile.cohortTag);
      const sessionId = await ctx.db.insert("sessions", {
        profileId: profile._id,
        taskId: task._id,
        workerId,
        channel,
        status: "running",
        startedAt: now,
        strategyVersionId: strategy?._id,
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
        channel,
        data: { taskType: task.type },
        ctx: { strategyVersionId: strategy?._id },
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
        strategyVersionId: strategy?._id ?? null,
      };
    }
    return null;
  },
});

// Egress IP is only known once the runner resolves it through the session proxy.
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

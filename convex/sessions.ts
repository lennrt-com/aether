// Manual (hands-on) sessions: a human drives the browser instead of an agent.
// These mirror the task-session lifecycle (one active session per profile,
// SessionStarted/SessionEnded events, snapshot anchor) without a task/worker.
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { assertWorkerKey } from "./lib/guards";
import { appendEvent } from "./events";
import { getActiveStrategy } from "./policies";

// Open a manual session and return the identity bundle the runner needs to
// launch Chrome (launch config, proxy, latest snapshot). Throws if the profile
// already has an active session to avoid two Chrome instances on one userDataDir.
export const openManual = mutation({
  args: { workerKey: v.string(), profileId: v.id("profiles") },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    const profile = await ctx.db.get(args.profileId);
    if (!profile) throw new Error(`profile not found: ${args.profileId}`);
    if (profile.activeSessionId !== undefined) {
      throw new Error(
        "profile already has an active session — close it first or pass --force to release a stale one",
      );
    }

    const now = Date.now();
    const sessionId = await ctx.db.insert("sessions", {
      profileId: profile._id,
      kind: "manual",
      channel: "browser",
      status: "running",
      startedAt: now,
    });
    await ctx.db.patch(profile._id, { activeSessionId: sessionId });
    await appendEvent(ctx, {
      profileId: profile._id,
      sessionId,
      type: "SessionStarted",
      ts: now,
      channel: "browser",
      data: { kind: "manual" },
      ctx: {},
    });

    const [launchConfig, proxyBinding, currentSnapshot] = await Promise.all([
      profile.launchConfigId ? ctx.db.get(profile.launchConfigId) : null,
      profile.proxyBindingId ? ctx.db.get(profile.proxyBindingId) : null,
      profile.currentSnapshotId ? ctx.db.get(profile.currentSnapshotId) : null,
    ]);

    return {
      sessionId,
      profile: { ...profile, activeSessionId: sessionId },
      launchConfig,
      proxyBinding,
      currentSnapshot,
    };
  },
});

// Foreground pipeline (bless create / bless experiment): session without a
// task/worker. taskType labels the pipeline in events (default: signup).
export const openPipeline = mutation({
  args: {
    workerKey: v.string(),
    profileId: v.id("profiles"),
    taskType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    const profile = await ctx.db.get(args.profileId);
    if (!profile) throw new Error(`profile not found: ${args.profileId}`);
    if (profile.activeSessionId !== undefined) {
      throw new Error(
        "profile already has an active session — close it first or run forceRelease",
      );
    }

    const taskType = args.taskType ?? "signup";
    const now = Date.now();
    const strategy = await getActiveStrategy(ctx, profile.cohortTag);
    const sessionId = await ctx.db.insert("sessions", {
      profileId: profile._id,
      kind: "pipeline",
      channel: "browser",
      status: "running",
      startedAt: now,
      strategyVersionId: strategy?._id,
    });
    await ctx.db.patch(profile._id, { activeSessionId: sessionId });
    await appendEvent(ctx, {
      profileId: profile._id,
      sessionId,
      type: "SessionStarted",
      ts: now,
      channel: "browser",
      data: { kind: "pipeline", taskType },
      ctx: { strategyVersionId: strategy?._id },
    });

    const [persona, launchConfig, proxyBinding, currentSnapshot] = await Promise.all([
      profile.personaId ? ctx.db.get(profile.personaId) : null,
      profile.launchConfigId ? ctx.db.get(profile.launchConfigId) : null,
      profile.proxyBindingId ? ctx.db.get(profile.proxyBindingId) : null,
      profile.currentSnapshotId ? ctx.db.get(profile.currentSnapshotId) : null,
    ]);

    return {
      task: null,
      profile: { ...profile, activeSessionId: sessionId },
      persona,
      launchConfig,
      proxyBinding,
      currentSnapshot,
      sessionId,
      strategyVersionId: strategy?._id ?? null,
    };
  },
});

export const closePipeline = mutation({
  args: {
    workerKey: v.string(),
    sessionId: v.id("sessions"),
    outcome: v.optional(v.string()),
    status: v.optional(v.union(v.literal("done"), v.literal("failed"))),
  },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error(`session not found: ${args.sessionId}`);
    const now = Date.now();
    const sessionStatus = args.status ?? "done";
    if (session.status === "running") {
      await ctx.db.patch(session._id, {
        status: sessionStatus,
        endedAt: now,
        outcome: args.outcome ?? sessionStatus,
      });
    }
    const profile = await ctx.db.get(session.profileId);
    if (profile && profile.activeSessionId === session._id) {
      await ctx.db.patch(profile._id, { activeSessionId: undefined });
    }
    await appendEvent(ctx, {
      profileId: session.profileId,
      sessionId: session._id,
      type: "SessionEnded",
      ts: now,
      channel: "browser",
      data: { kind: "pipeline", outcome: args.outcome ?? sessionStatus },
      ctx: {},
    });
  },
});

export const closeManual = mutation({
  args: {
    workerKey: v.string(),
    sessionId: v.id("sessions"),
    outcome: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error(`session not found: ${args.sessionId}`);
    const now = Date.now();
    if (session.status === "running") {
      await ctx.db.patch(session._id, {
        status: "done",
        endedAt: now,
        outcome: args.outcome ?? "manual",
      });
    }
    const profile = await ctx.db.get(session.profileId);
    if (profile && profile.activeSessionId === session._id) {
      await ctx.db.patch(profile._id, { activeSessionId: undefined });
    }
    await appendEvent(ctx, {
      profileId: session.profileId,
      sessionId: session._id,
      type: "SessionEnded",
      ts: now,
      channel: "browser",
      data: { kind: "manual", outcome: args.outcome ?? "manual" },
      ctx: {},
    });
  },
});

// Crash recovery: clear a stuck activeSessionId left by a manual session whose
// process died before closeManual ran. Marks the dangling session failed.
export const forceRelease = mutation({
  args: { workerKey: v.string(), profileId: v.id("profiles") },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    const profile = await ctx.db.get(args.profileId);
    if (!profile) throw new Error(`profile not found: ${args.profileId}`);
    const sid = profile.activeSessionId;
    if (!sid) return { released: false };
    const session = await ctx.db.get(sid);
    if (session && session.status === "running") {
      await ctx.db.patch(sid, {
        status: "failed",
        endedAt: Date.now(),
        outcome: "force-released",
      });
    }
    await ctx.db.patch(profile._id, { activeSessionId: undefined });
    return { released: true };
  },
});

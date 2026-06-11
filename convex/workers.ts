import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertWorkerKey } from "./lib/guards";

const STALE_MS = 120 * 1000;

export const register = mutation({
  args: {
    workerKey: v.string(),
    name: v.string(),
    maxSessions: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    return await ctx.db.insert("workers", {
      name: args.name,
      status: "online",
      lastHeartbeatAt: Date.now(),
      maxSessions: args.maxSessions ?? 2,
    });
  },
});

export const heartbeat = mutation({
  args: { workerKey: v.string(), workerId: v.id("workers") },
  handler: async (ctx, { workerKey, workerId }) => {
    assertWorkerKey(workerKey);
    await ctx.db.patch(workerId, { status: "online", lastHeartbeatAt: Date.now() });
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const workers = await ctx.db.query("workers").collect();
    return workers.map((w) => ({ ...w, stale: now - w.lastHeartbeatAt > STALE_MS }));
  },
});

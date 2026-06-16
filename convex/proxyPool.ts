import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertWorkerKey } from "./lib/guards";

export const add = mutation({
  args: {
    workerKey: v.string(),
    label: v.string(),
    server: v.string(),
    username: v.optional(v.string()),
    password: v.optional(v.string()),
    geo: v.string(),
    timezone: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    return await ctx.db.insert("proxyPool", {
      label: args.label,
      server: args.server,
      username: args.username,
      password: args.password,
      geo: args.geo.toUpperCase(),
      timezone: args.timezone,
      status: "active",
      notes: args.notes,
    });
  },
});

export const list = query({
  args: { status: v.optional(v.union(v.literal("active"), v.literal("disabled"))) },
  handler: async (ctx, { status }) => {
    if (status !== undefined) {
      return await ctx.db
        .query("proxyPool")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect();
    }
    return await ctx.db.query("proxyPool").collect();
  },
});

export const remove = mutation({
  args: { workerKey: v.string(), proxyPoolId: v.id("proxyPool") },
  handler: async (ctx, { workerKey, proxyPoolId }) => {
    assertWorkerKey(workerKey);
    const entry = await ctx.db.get(proxyPoolId);
    if (!entry) throw new Error(`proxy pool entry not found: ${proxyPoolId}`);
    await ctx.db.delete(proxyPoolId);
    return { removed: true, label: entry.label };
  },
});

export const get = query({
  args: { proxyPoolId: v.id("proxyPool") },
  handler: async (ctx, { proxyPoolId }) => {
    return await ctx.db.get(proxyPoolId);
  },
});

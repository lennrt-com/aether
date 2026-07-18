import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertWorkerKey } from "./lib/guards";
import { appendEvent } from "./events";

export const create = mutation({
  args: {
    workerKey: v.string(),
    profileId: v.id("profiles"),
    server: v.string(),
    username: v.optional(v.string()),
    password: v.optional(v.string()),
    geo: v.string(),
  },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    return await ctx.db.insert("proxyBindings", {
      profileId: args.profileId,
      provider: "http",
      server: args.server,
      username: args.username,
      password: args.password,
      geo: args.geo,
      status: "active",
    });
  },
});

export const get = query({
  args: { proxyBindingId: v.id("proxyBindings") },
  handler: async (ctx, { proxyBindingId }) => {
    return await ctx.db.get(proxyBindingId);
  },
});

export const listFor = query({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    return await ctx.db
      .query("proxyBindings")
      .withIndex("by_profile", (q) => q.eq("profileId", profileId))
      .collect();
  },
});

export const attachToProfile = mutation({
  args: {
    workerKey: v.string(),
    profileId: v.id("profiles"),
    proxyBindingId: v.id("proxyBindings"),
  },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    const binding = await ctx.db.get(args.proxyBindingId);
    if (!binding) throw new Error("proxy binding not found");
    await ctx.db.patch(args.profileId, { proxyBindingId: args.proxyBindingId });
    await appendEvent(ctx, {
      profileId: args.profileId,
      type: "ProfileProvisioned",
      ts: Date.now(),
      channel: "system",
      data: {
        component: "proxy",
        proxyBindingId: args.proxyBindingId,
        geo: binding.geo,
        server: binding.server,
      },
      ctx: {},
    });
  },
});

export const setStatus = mutation({
  args: {
    workerKey: v.string(),
    proxyBindingId: v.id("proxyBindings"),
    status: v.union(
      v.literal("active"),
      v.literal("unhealthy"),
      v.literal("retired"),
    ),
  },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    const binding = await ctx.db.get(args.proxyBindingId);
    if (!binding) throw new Error("proxy binding not found");
    await ctx.db.patch(args.proxyBindingId, { status: args.status });
    await appendEvent(ctx, {
      profileId: binding.profileId,
      type: "ProxyChanged",
      ts: Date.now(),
      channel: "system",
      data: {
        proxyBindingId: args.proxyBindingId,
        status: args.status,
      },
      ctx: {},
    });
  },
});

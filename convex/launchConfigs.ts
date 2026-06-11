import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertWorkerKey } from "./lib/guards";
import { appendEvent } from "./events";

export const create = mutation({
  args: {
    workerKey: v.string(),
    profileId: v.id("profiles"),
    version: v.number(),
    timezone: v.string(),
    locale: v.string(),
    windowWidth: v.number(),
    windowHeight: v.number(),
    chromeVersion: v.string(),
    hash: v.string(),
  },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    return await ctx.db.insert("launchConfigs", {
      profileId: args.profileId,
      version: args.version,
      timezone: args.timezone,
      locale: args.locale,
      windowWidth: args.windowWidth,
      windowHeight: args.windowHeight,
      chromeVersion: args.chromeVersion,
      hash: args.hash,
    });
  },
});

export const get = query({
  args: { launchConfigId: v.id("launchConfigs") },
  handler: async (ctx, { launchConfigId }) => {
    return await ctx.db.get(launchConfigId);
  },
});

export const listFor = query({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    return await ctx.db
      .query("launchConfigs")
      .withIndex("by_profile", (q) => q.eq("profileId", profileId))
      .collect();
  },
});

export const attachToProfile = mutation({
  args: {
    workerKey: v.string(),
    profileId: v.id("profiles"),
    launchConfigId: v.id("launchConfigs"),
  },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    const config = await ctx.db.get(args.launchConfigId);
    if (!config) throw new Error("launch config not found");
    await ctx.db.patch(args.profileId, {
      launchConfigId: args.launchConfigId,
      chromeVersion: config.chromeVersion,
    });
    await appendEvent(ctx, {
      profileId: args.profileId,
      type: "ProfileProvisioned",
      ts: Date.now(),
      channel: "system",
      data: {
        component: "launchConfig",
        launchConfigId: args.launchConfigId,
        version: config.version,
        hash: config.hash,
      },
      ctx: {},
    });
  },
});

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertWorkerKey } from "./lib/guards";

export const record = mutation({
  args: {
    workerKey: v.string(),
    profileId: v.id("profiles"),
    visitorId: v.string(),
    eventId: v.string(),
    tampering: v.optional(v.boolean()),
    vpn: v.optional(v.boolean()),
    proxy: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    return await ctx.db.insert("fingerprintObservations", {
      profileId: args.profileId,
      visitorId: args.visitorId,
      eventId: args.eventId,
      tampering: args.tampering,
      vpn: args.vpn,
      proxy: args.proxy,
      ts: Date.now(),
    });
  },
});

export const collisions = query({
  args: {
    workerKey: v.string(),
    visitorId: v.string(),
    profileId: v.id("profiles"),
  },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    const matches = await ctx.db
      .query("fingerprintObservations")
      .withIndex("by_visitorId", (q) => q.eq("visitorId", args.visitorId))
      .collect();
    return matches.filter((row) => row.profileId !== args.profileId);
  },
});

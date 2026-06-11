import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertWorkerKey } from "./lib/guards";
import { appendEvent } from "./events";

export const create = mutation({
  args: {
    workerKey: v.string(),
    profileId: v.id("profiles"),
    version: v.number(),
    data: v.any(),
  },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    return await ctx.db.insert("personas", {
      profileId: args.profileId,
      version: args.version,
      data: args.data,
    });
  },
});

export const get = query({
  args: { personaId: v.id("personas") },
  handler: async (ctx, { personaId }) => {
    return await ctx.db.get(personaId);
  },
});

export const listFor = query({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    return await ctx.db
      .query("personas")
      .withIndex("by_profile", (q) => q.eq("profileId", profileId))
      .collect();
  },
});

export const attachToProfile = mutation({
  args: {
    workerKey: v.string(),
    profileId: v.id("profiles"),
    personaId: v.id("personas"),
  },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    const persona = await ctx.db.get(args.personaId);
    if (!persona) throw new Error("persona not found");
    await ctx.db.patch(args.profileId, { personaId: args.personaId });
    await appendEvent(ctx, {
      profileId: args.profileId,
      type: "ProfileProvisioned",
      ts: Date.now(),
      channel: "system",
      data: {
        component: "persona",
        personaId: args.personaId,
        version: persona.version,
      },
      ctx: {},
    });
  },
});

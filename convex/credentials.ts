import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertWorkerKey } from "./lib/guards";

export const create = mutation({
  args: {
    workerKey: v.string(),
    profileId: v.id("profiles"),
    email: v.string(),
    password: v.string(),
    emailProvider: v.string(),
    mailboxId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    const existing = await ctx.db
      .query("accountCredentials")
      .withIndex("by_profile", (q) => q.eq("profileId", args.profileId))
      .first();
    if (existing) throw new Error(`profile already has credentials: ${args.profileId}`);
    return await ctx.db.insert("accountCredentials", {
      profileId: args.profileId,
      email: args.email,
      password: args.password,
      emailProvider: args.emailProvider,
      mailboxId: args.mailboxId,
      status: "active",
    });
  },
});

// Returns the password — workerKey-guarded even though it's a query.
export const getFor = query({
  args: { workerKey: v.string(), profileId: v.id("profiles") },
  handler: async (ctx, { workerKey, profileId }) => {
    assertWorkerKey(workerKey);
    return await ctx.db
      .query("accountCredentials")
      .withIndex("by_profile", (q) => q.eq("profileId", profileId))
      .first();
  },
});

export const setStatus = mutation({
  args: {
    workerKey: v.string(),
    credentialId: v.id("accountCredentials"),
    status: v.union(v.literal("active"), v.literal("invalid")),
  },
  handler: async (ctx, { workerKey, credentialId, status }) => {
    assertWorkerKey(workerKey);
    await ctx.db.patch(credentialId, { status });
  },
});

import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { profileStatus } from "./schema";
import {
  assertWorkerKey,
  assertTransition,
  type ProfileStatus,
} from "./lib/guards";
import { appendEvent } from "./events";

export const create = mutation({
  args: {
    workerKey: v.string(),
    name: v.string(),
    chromeVersion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    return await ctx.db.insert("profiles", {
      name: args.name,
      status: "provisioning",
      riskScore: 0,
      chromeVersion: args.chromeVersion ?? "unpinned",
    });
  },
});

export const get = query({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    return await ctx.db.get(profileId);
  },
});

export const list = query({
  args: {
    status: v.optional(profileStatus),
  },
  handler: async (ctx, { status }) => {
    if (status !== undefined) {
      return await ctx.db
        .query("profiles")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect();
    }
    return await ctx.db.query("profiles").collect();
  },
});

export async function applyTransition(
  ctx: MutationCtx,
  profileId: Id<"profiles">,
  to: ProfileStatus,
  reason?: string,
): Promise<void> {
  const profile = await ctx.db.get(profileId);
  if (!profile) throw new Error(`profile not found: ${profileId}`);
  const from = profile.status as ProfileStatus;
  assertTransition(from, to);
  const now = Date.now();
  await ctx.db.patch(profileId, { status: to });
  await appendEvent(ctx, {
    profileId,
    type: "ProfileStateChanged",
    ts: now,
    channel: "system",
    data: { from, to, reason: reason ?? null },
    ctx: {},
  });
}

export const transition = mutation({
  args: {
    workerKey: v.string(),
    profileId: v.id("profiles"),
    to: profileStatus,
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    await applyTransition(ctx, args.profileId, args.to as ProfileStatus, args.reason);
  },
});

import { internalMutation, mutation, query } from "./_generated/server";
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
    cohortTag: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    return await ctx.db.insert("profiles", {
      name: args.name,
      status: "provisioning",
      riskScore: 0,
      warmupAgeDays: 0,
      linkedinAgeDays: 0,
      cohortTag: args.cohortTag ?? "default",
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
    restricted: v.optional(v.boolean()),
  },
  handler: async (ctx, { status, restricted }) => {
    if (restricted === true) {
      const rows = await ctx.db
        .query("profiles")
        .withIndex("by_isRestricted", (q) => q.eq("isRestricted", true))
        .collect();
      return status !== undefined ? rows.filter((p) => p.status === status) : rows;
    }
    if (status !== undefined) {
      return await ctx.db
        .query("profiles")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect();
    }
    return await ctx.db.query("profiles").collect();
  },
});

// Set restriction benchmark columns once on first detection.
export async function markRestricted(
  ctx: MutationCtx,
  profileId: Id<"profiles">,
  source?: string,
): Promise<void> {
  const profile = await ctx.db.get(profileId);
  if (!profile) throw new Error(`profile not found: ${profileId}`);
  if (profile.isRestricted) return;
  await ctx.db.patch(profileId, {
    isRestricted: true,
    restrictedAt: Date.now(),
    restrictedAtPhase: profile.status,
    restrictionSource: source,
  });
}

// State changes and their events are atomic: same mutation.
// This is the ONLY way profiles.status may change (also reused by health/Phase 6).
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
  const patch: {
    status: ProfileStatus;
    linkedinCreatedAt?: number;
    linkedinAgeDays?: number;
  } = { status: to };
  if (to === "warming" && profile.linkedinCreatedAt === undefined) {
    patch.linkedinCreatedAt = now;
    patch.linkedinAgeDays = 0;
  }
  await ctx.db.patch(profileId, patch);
  await appendEvent(ctx, {
    profileId,
    type: "ProfileStateChanged",
    ts: now,
    channel: "system",
    data: { from, to, reason: reason ?? null },
    ctx: {},
  });
}

// Unipile account connection is manual for v1 (hosted auth) — the resulting
// accountId is stored via CLI.
export const setUnipileAccount = mutation({
  args: {
    workerKey: v.string(),
    profileId: v.id("profiles"),
    unipileAccountId: v.string(),
  },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    await ctx.db.patch(args.profileId, { unipileAccountId: args.unipileAccountId });
    await appendEvent(ctx, {
      profileId: args.profileId,
      type: "ProfileProvisioned",
      ts: Date.now(),
      channel: "system",
      data: { component: "unipileAccount", unipileAccountId: args.unipileAccountId },
      ctx: {},
    });
  },
});

export const setLinkedInProfileUrl = mutation({
  args: {
    workerKey: v.string(),
    profileId: v.id("profiles"),
    linkedInProfileUrl: v.string(),
  },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    await ctx.db.patch(args.profileId, { linkedInProfileUrl: args.linkedInProfileUrl });
    await appendEvent(ctx, {
      profileId: args.profileId,
      type: "ProfileProvisioned",
      ts: Date.now(),
      channel: "system",
      data: { component: "linkedInProfileUrl", linkedInProfileUrl: args.linkedInProfileUrl },
      ctx: {},
    });
  },
});

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

// Backfill restriction columns for profiles already in status restricted.
async function backfillRestrictionFieldsCore(ctx: MutationCtx): Promise<{ patched: number }> {
  let patched = 0;
  const restricted = await ctx.db
    .query("profiles")
    .withIndex("by_status", (q) => q.eq("status", "restricted"))
    .collect();
  for (const profile of restricted) {
    if (profile.isRestricted) continue;
    const events = await ctx.db
      .query("events")
      .withIndex("by_profile_ts", (q) => q.eq("profileId", profile._id))
      .collect();
    const transitionEvent = [...events]
      .reverse()
      .find(
        (e) =>
          e.type === "ProfileStateChanged" &&
          (e.data as { to?: string })?.to === "restricted",
      );
    const restrictionEvent = [...events]
      .reverse()
      .find((e) => e.type === "RestrictionDetected");
    const data = (transitionEvent?.data ?? {}) as { from?: ProfileStatus };
    const source = (restrictionEvent?.data as { source?: string })?.source ?? "browser";
    await ctx.db.patch(profile._id, {
      isRestricted: true,
      restrictedAt: transitionEvent?.ts ?? restrictionEvent?.ts ?? Date.now(),
      restrictedAtPhase: data.from ?? "active",
      restrictionSource: source,
    });
    patched += 1;
  }
  return { patched };
}

export const backfillRestrictionFields = internalMutation({
  args: {},
  handler: async (ctx) => backfillRestrictionFieldsCore(ctx),
});

export const backfillRestrictions = mutation({
  args: { workerKey: v.string() },
  handler: async (ctx, { workerKey }) => {
    assertWorkerKey(workerKey);
    return await backfillRestrictionFieldsCore(ctx);
  },
});

export const restrictionBenchmark = query({
  args: {},
  handler: async (ctx) => {
    const restricted = await ctx.db
      .query("profiles")
      .withIndex("by_isRestricted", (q) => q.eq("isRestricted", true))
      .collect();
    const byPhase = new Map<string, number>();
    for (const p of restricted) {
      const phase = p.restrictedAtPhase ?? "unknown";
      byPhase.set(phase, (byPhase.get(phase) ?? 0) + 1);
    }
    return {
      total: restricted.length,
      byPhase: Object.fromEntries(byPhase),
    };
  },
});

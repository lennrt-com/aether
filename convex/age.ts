import { internalMutation, mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { assertWorkerKey } from "./lib/guards";
import {
  resolveWarmupAgeDays,
  type ProfileWithLegacyAge,
} from "./lib/profileAge";

// Hourly tick — 24 runs ≈ 1 calendar day on the warmup curve.
const AGE_INCREMENT_PER_HOUR = 1 / 24;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const WARMUP_AGING_STATUSES = [
  "warming",
  "active",
  "cooldown",
  "warning",
  "restricted",
  "recovering",
] as const;

const LINKEDIN_AGING_STATUSES = [
  "warming",
  "active",
  "cooldown",
  "warning",
  "restricted",
  "recovering",
  "retired",
] as const;

export async function bumpWarmupAgeCore(
  ctx: MutationCtx,
): Promise<{ bumped: number; skipped: number }> {
  let bumped = 0;
  let skipped = 0;

  for (const status of WARMUP_AGING_STATUSES) {
    const profiles = await ctx.db
      .query("profiles")
      .withIndex("by_status", (q) => q.eq("status", status))
      .collect();

    for (const profile of profiles) {
      if (profile.maintained === false) {
        skipped += 1;
        continue;
      }
      const current = resolveWarmupAgeDays(profile as ProfileWithLegacyAge);
      await ctx.db.patch(profile._id, {
        warmupAgeDays: current + AGE_INCREMENT_PER_HOUR,
      });
      bumped += 1;
    }
  }

  return { bumped, skipped };
}

export async function updateLinkedInAgeCore(
  ctx: MutationCtx,
): Promise<{ updated: number; skipped: number }> {
  const now = Date.now();
  let updated = 0;
  let skipped = 0;

  for (const status of LINKEDIN_AGING_STATUSES) {
    const profiles = await ctx.db
      .query("profiles")
      .withIndex("by_status", (q) => q.eq("status", status))
      .collect();

    for (const profile of profiles) {
      if (profile.linkedinCreatedAt === undefined) {
        skipped += 1;
        continue;
      }
      await ctx.db.patch(profile._id, {
        linkedinAgeDays: (now - profile.linkedinCreatedAt) / MS_PER_DAY,
      });
      updated += 1;
    }
  }

  return { updated, skipped };
}

async function backfillAgeFieldsCore(ctx: MutationCtx): Promise<{
  patched: number;
  warmupFromLegacy: number;
  linkedinAnchored: number;
  legacyRemoved: number;
}> {
  let patched = 0;
  let warmupFromLegacy = 0;
  let linkedinAnchored = 0;
  let legacyRemoved = 0;
  const now = Date.now();
  const profiles = await ctx.db.query("profiles").collect();

  for (const profile of profiles) {
    const legacy = profile as ProfileWithLegacyAge;
    const hasLegacy = legacy.accountAgeDays !== undefined;

    const warmupAgeDays = profile.warmupAgeDays ?? legacy.accountAgeDays ?? 0;
    if (hasLegacy && profile.warmupAgeDays === undefined) warmupFromLegacy += 1;

    let anchor = profile.linkedinCreatedAt;
    if (anchor === undefined && profile.status !== "provisioning") {
      const events = await ctx.db
        .query("events")
        .withIndex("by_profile_ts", (q) => q.eq("profileId", profile._id))
        .collect();
      const accountCreated = [...events]
        .reverse()
        .find((e) => e.type === "AccountCreated");
      const warmingTransition = [...events].find(
        (e) =>
          e.type === "ProfileStateChanged" &&
          (e.data as { to?: string })?.to === "warming",
      );
      anchor = accountCreated?.ts ?? warmingTransition?.ts;
      if (anchor !== undefined) linkedinAnchored += 1;
    }

    const linkedinAgeDays =
      profile.linkedinAgeDays ??
      (anchor !== undefined ? (now - anchor) / MS_PER_DAY : 0);

    const needsPatch =
      hasLegacy ||
      profile.warmupAgeDays === undefined ||
      profile.linkedinAgeDays === undefined ||
      (anchor !== undefined && profile.linkedinCreatedAt === undefined);

    if (!needsPatch) continue;

    const patch: Record<string, number | undefined> = {
      warmupAgeDays,
      linkedinAgeDays,
    };
    if (anchor !== undefined && profile.linkedinCreatedAt === undefined) {
      patch.linkedinCreatedAt = anchor;
    }
    if (hasLegacy) {
      patch.accountAgeDays = undefined;
      legacyRemoved += 1;
    }

    await ctx.db.patch(profile._id, patch);
    patched += 1;
  }

  return { patched, warmupFromLegacy, linkedinAnchored, legacyRemoved };
}

export const bumpWarmupAge = internalMutation({
  args: {},
  handler: async (ctx) => bumpWarmupAgeCore(ctx),
});

export const updateLinkedInAge = internalMutation({
  args: {},
  handler: async (ctx) => updateLinkedInAgeCore(ctx),
});

export const backfillAgeFields = internalMutation({
  args: {},
  handler: async (ctx) => backfillAgeFieldsCore(ctx),
});

export const runWarmup = mutation({
  args: { workerKey: v.string() },
  handler: async (ctx, { workerKey }) => {
    assertWorkerKey(workerKey);
    return await bumpWarmupAgeCore(ctx);
  },
});

export const runLinkedIn = mutation({
  args: { workerKey: v.string() },
  handler: async (ctx, { workerKey }) => {
    assertWorkerKey(workerKey);
    return await updateLinkedInAgeCore(ctx);
  },
});

export const backfill = mutation({
  args: { workerKey: v.string() },
  handler: async (ctx, { workerKey }) => {
    assertWorkerKey(workerKey);
    return await backfillAgeFieldsCore(ctx);
  },
});

export { resolveWarmupAgeDays, resolveLinkedInAgeDays } from "./lib/profileAge";

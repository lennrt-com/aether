import { internalMutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { applyTransition, markRestricted } from "./profiles";

// Appendix C values — final for v1, do not tune.
// Duplicated from src/shared/constants.ts (Convex can't import from src/).
const WEIGHTS = { captcha: 15, checkpoint: 30, restriction: 100, anomaly: 5, http429: 10 };
const HALF_LIFE_HOURS = 72;
const WINDOW_DAYS = 14;
const WARNING_THRESHOLD = 40;
const RECOVERY_THRESHOLD = 20;

const SIGNAL_TYPES = [
  "ChallengeDetected",
  "AnomalyObserved",
  "RestrictionDetected",
  "ActionFailed",
];

export function isSignalEvent(type: string): boolean {
  return SIGNAL_TYPES.includes(type);
}

function weightFor(event: Doc<"events">): number {
  const data = (event.data ?? {}) as { pageState?: string; httpStatus?: number };
  switch (event.type) {
    case "ChallengeDetected":
      return data.pageState === "checkpoint" ? WEIGHTS.checkpoint : WEIGHTS.captcha;
    case "RestrictionDetected":
      return WEIGHTS.restriction;
    case "AnomalyObserved":
      return WEIGHTS.anomaly;
    case "ActionFailed":
      return data.httpStatus === 429 ? WEIGHTS.http429 : 0;
    default:
      return 0;
  }
}

export async function computeRiskScore(
  ctx: QueryCtx,
  profileId: Id<"profiles">,
): Promise<number> {
  const now = Date.now();
  const since = now - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const events = await ctx.db
    .query("events")
    .withIndex("by_profile_ts", (q) => q.eq("profileId", profileId).gte("ts", since))
    .collect();
  let score = 0;
  for (const event of events) {
    const weight = weightFor(event);
    if (weight === 0) continue;
    const ageHours = (now - event.ts) / (60 * 60 * 1000);
    score += weight * Math.pow(0.5, ageHours / HALF_LIFE_HOURS);
  }
  return score;
}

export async function evaluateCore(
  ctx: MutationCtx,
  profileId: Id<"profiles">,
  opts?: { restrictionDetected?: boolean; restrictionSource?: string },
): Promise<number> {
  const profile = await ctx.db.get(profileId);
  if (!profile) throw new Error(`profile not found: ${profileId}`);
  const score = await computeRiskScore(ctx, profileId);
  await ctx.db.patch(profileId, { riskScore: score });

  const status = profile.status;
  if (
    opts?.restrictionDetected &&
    ["warming", "active", "cooldown", "warning", "recovering"].includes(status)
  ) {
    await markRestricted(ctx, profileId, opts.restrictionSource);
    await applyTransition(ctx, profileId, "restricted", "RestrictionDetected signal");
  } else if (
    score >= WARNING_THRESHOLD &&
    ["warming", "active", "cooldown"].includes(status)
  ) {
    await applyTransition(ctx, profileId, "warning", `risk score ${score.toFixed(1)} >= ${WARNING_THRESHOLD}`);
  } else if (status === "warning" && score < RECOVERY_THRESHOLD) {
    await applyTransition(ctx, profileId, "active", `risk score ${score.toFixed(1)} < ${RECOVERY_THRESHOLD}`);
  }
  return score;
}

export const riskScore = query({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    return await computeRiskScore(ctx, profileId);
  },
});

export const evaluate = internalMutation({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    return await evaluateCore(ctx, profileId);
  },
});

// One-time cleanup: prior to the monitoring fix, already-restricted accounts
// were re-probed hourly, appending a fresh RestrictionDetected event (+100 each)
// and inflating riskScore. Keep the original detection per account, drop the
// re-probe duplicates, and recompute the score (it then decays from ~100).
export const dedupeRestrictionEvents = internalMutation({
  args: {},
  handler: async (ctx) => {
    const restricted = await ctx.db
      .query("profiles")
      .withIndex("by_isRestricted", (q) => q.eq("isRestricted", true))
      .collect();

    let profilesProcessed = 0;
    let eventsDeleted = 0;
    const updates: Array<{
      profileId: Id<"profiles">;
      name: string;
      removed: number;
      before: number;
      after: number;
    }> = [];

    for (const profile of restricted) {
      const events = await ctx.db
        .query("events")
        .withIndex("by_profile_ts", (q) => q.eq("profileId", profile._id))
        .collect();
      const restrictionEvents = events
        .filter((e) => e.type === "RestrictionDetected")
        .sort((a, b) => a.ts - b.ts);
      if (restrictionEvents.length <= 1) continue;

      // Keep the earliest (the detection that triggered the restriction).
      for (const dup of restrictionEvents.slice(1)) {
        await ctx.db.delete(dup._id);
        eventsDeleted += 1;
      }

      const before = profile.riskScore;
      const after = await computeRiskScore(ctx, profile._id);
      await ctx.db.patch(profile._id, { riskScore: after });
      updates.push({
        profileId: profile._id,
        name: profile.name,
        removed: restrictionEvents.length - 1,
        before,
        after,
      });
      profilesProcessed += 1;
    }

    return { profilesProcessed, eventsDeleted, updates };
  },
});

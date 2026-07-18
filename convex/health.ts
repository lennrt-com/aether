import { internalMutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";

const WEIGHTS = { captcha: 15, checkpoint: 30, restriction: 100, anomaly: 5, http429: 10 };
const HALF_LIFE_HOURS = 72;
const WINDOW_DAYS = 14;

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

/** Update riskScore only — no LinkedIn lifecycle transitions. */
export async function evaluateCore(
  ctx: MutationCtx,
  profileId: Id<"profiles">,
  _opts?: { restrictionDetected?: boolean; restrictionSource?: string },
): Promise<number> {
  const profile = await ctx.db.get(profileId);
  if (!profile) throw new Error(`profile not found: ${profileId}`);
  const score = await computeRiskScore(ctx, profileId);
  await ctx.db.patch(profileId, { riskScore: score });
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

import { query } from "./_generated/server";
import { requireUser } from "./lib/auth";

const DAY_MS = 24 * 60 * 60 * 1000;

const LIVE_POOL_STATUSES = new Set(["warming", "active", "cooldown"]);
const ACTIVE_POOL_STATUSES = new Set(["warming", "active", "cooldown"]);

const AGE_BUCKETS = [
  { label: "0-7d", min: 0, max: 7 },
  { label: "8-14d", min: 8, max: 14 },
  { label: "15-30d", min: 15, max: 30 },
  { label: "31-60d", min: 31, max: 60 },
  { label: "61-90d", min: 61, max: 90 },
  { label: "90d+", min: 91, max: Infinity },
] as const;

function accountAgeDays(profile: {
  linkedinAgeDays?: number;
  linkedinCreatedAt?: number;
}): number | null {
  if (profile.linkedinAgeDays !== undefined) {
    return profile.linkedinAgeDays;
  }
  if (profile.linkedinCreatedAt === undefined) {
    return null;
  }
  return (Date.now() - profile.linkedinCreatedAt) / DAY_MS;
}

function restrictionAgeDays(profile: {
  restrictedAt?: number;
  linkedinCreatedAt?: number;
}): number | null {
  if (
    profile.restrictedAt === undefined ||
    profile.linkedinCreatedAt === undefined
  ) {
    return null;
  }
  return (profile.restrictedAt - profile.linkedinCreatedAt) / DAY_MS;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

export const poolOverview = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const profiles = await ctx.db.query("profiles").collect();

    const byStatus: Record<string, number> = {};
    let activePool = 0;
    let atRisk = 0;
    let restricted = 0;
    let retired = 0;
    let linkedinAgeSum = 0;
    let linkedinAgeCount = 0;

    for (const profile of profiles) {
      byStatus[profile.status] = (byStatus[profile.status] ?? 0) + 1;

      if (ACTIVE_POOL_STATUSES.has(profile.status)) {
        activePool += 1;
      }
      if (profile.status === "warning") {
        atRisk += 1;
      }
      if (profile.isRestricted === true || profile.status === "restricted") {
        restricted += 1;
      }
      if (profile.status === "retired") {
        retired += 1;
      }

      if (LIVE_POOL_STATUSES.has(profile.status)) {
        const age = accountAgeDays(profile);
        if (age !== null) {
          linkedinAgeSum += age;
          linkedinAgeCount += 1;
        }
      }
    }

    return {
      total: profiles.length,
      byStatus,
      activePool,
      atRisk,
      restricted,
      retired,
      avgLinkedinAgeDays:
        linkedinAgeCount > 0 ? linkedinAgeSum / linkedinAgeCount : null,
    };
  },
});

export const banRate = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const profiles = await ctx.db.query("profiles").collect();
    const withLinkedin = profiles.filter(
      (profile) => profile.linkedinCreatedAt !== undefined,
    );
    const restrictedProfiles = withLinkedin.filter(
      (profile) => profile.isRestricted === true,
    );

    const byPhase: Record<string, number> = {};
    for (const profile of restrictedProfiles) {
      const phase = profile.restrictedAtPhase ?? "unknown";
      byPhase[phase] = (byPhase[phase] ?? 0) + 1;
    }

    const total = withLinkedin.length;
    const restrictedCount = restrictedProfiles.length;

    return {
      total,
      restricted: restrictedCount,
      ratePct: total > 0 ? (restrictedCount / total) * 100 : 0,
      byPhase,
    };
  },
});

export const ageAtRestriction = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const restricted = await ctx.db
      .query("profiles")
      .withIndex("by_isRestricted", (q) => q.eq("isRestricted", true))
      .collect();

    const buckets = AGE_BUCKETS.map((bucket) => ({
      label: bucket.label,
      count: 0,
    }));

    for (const profile of restricted) {
      const days = restrictionAgeDays(profile);
      if (days === null) {
        continue;
      }
      const bucketIndex = AGE_BUCKETS.findIndex(
        (bucket) => days >= bucket.min && days <= bucket.max,
      );
      if (bucketIndex >= 0) {
        buckets[bucketIndex]!.count += 1;
      }
    }

    return { buckets };
  },
});

export const survivalCurve = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const profiles = await ctx.db.query("profiles").collect();
    const withLinkedin = profiles.filter(
      (profile) => profile.linkedinCreatedAt !== undefined,
    );

    const restrictionAges = withLinkedin
      .map((profile) => restrictionAgeDays(profile))
      .filter((days): days is number => days !== null);

    const points: { ageDays: number; survivalPct: number; eligible: number }[] =
      [];

    for (let ageDays = 0; ageDays <= 120; ageDays += 7) {
      const eligible = withLinkedin.filter((profile) => {
        const age = accountAgeDays(profile);
        return age !== null && age >= ageDays;
      });

      const survived = eligible.filter((profile) => {
        const restrictionAge = restrictionAgeDays(profile);
        return restrictionAge === null || restrictionAge > ageDays;
      });

      const eligibleCount = eligible.length;
      points.push({
        ageDays,
        survivalPct:
          eligibleCount > 0 ? (survived.length / eligibleCount) * 100 : 100,
        eligible: eligibleCount,
      });
    }

    return {
      points,
      medianSurvivalDays: median(restrictionAges),
    };
  },
});

export const accounts = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const profiles = await ctx.db.query("profiles").collect();

    return profiles
      .map((profile) => ({
        id: profile._id,
        name: profile.name,
        status: profile.status,
        linkedInProfileUrl: profile.linkedInProfileUrl ?? null,
        linkedinAgeDays: profile.linkedinAgeDays ?? null,
        riskScore: profile.riskScore,
        isRestricted: profile.isRestricted === true,
        cohortTag: profile.cohortTag,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

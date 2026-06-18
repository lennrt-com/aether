import { query } from "./_generated/server";
import { requireUser } from "./lib/auth";

const DAY_MS = 24 * 60 * 60 * 1000;

const LIVE_POOL_STATUSES = new Set(["warming", "active", "cooldown"]);
const ACTIVE_POOL_STATUSES = new Set(["warming", "active", "cooldown"]);
const CREATION_CHALLENGE_STATES = new Set(["captcha", "checkpoint"]);
const CAPTCHA_TOOL_NAMES = new Set([
  "solve_recaptcha",
  "prepare_captcha_view",
  "pan_captcha_view",
]);

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

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isSignupSessionStarted(data: unknown): boolean {
  const session = (data ?? {}) as { taskType?: string; kind?: string };
  if (session.taskType === "signup") {
    return true;
  }
  return session.kind === "pipeline" && session.taskType !== "login";
}

function isCreationChallenge(data: unknown): boolean {
  const pageState = (data as { pageState?: string })?.pageState;
  return pageState !== undefined && CREATION_CHALLENGE_STATES.has(pageState);
}

function isCaptchaToolAction(data: unknown): boolean {
  const tool = (data as { tool?: string })?.tool;
  return tool !== undefined && CAPTCHA_TOOL_NAMES.has(tool);
}

function inTimeWindow(
  ts: number,
  window: { start: number; end: number } | undefined,
): boolean {
  if (window === undefined) {
    return false;
  }
  return ts >= window.start && ts <= window.end;
}

export const kpiOverview = query({
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

    const banDurationsDays = restrictedProfiles
      .map((profile) => {
        if (
          profile.restrictedAt === undefined ||
          profile.linkedinCreatedAt === undefined
        ) {
          return null;
        }
        return (profile.restrictedAt - profile.linkedinCreatedAt) / DAY_MS;
      })
      .filter((days): days is number => days !== null);

    let longestBannedLifespanDays: number | null = null;
    let longestBannedAccountName: string | null = null;
    for (const profile of restrictedProfiles) {
      if (
        profile.restrictedAt === undefined ||
        profile.linkedinCreatedAt === undefined
      ) {
        continue;
      }
      const days = (profile.restrictedAt - profile.linkedinCreatedAt) / DAY_MS;
      if (
        longestBannedLifespanDays === null ||
        days > longestBannedLifespanDays
      ) {
        longestBannedLifespanDays = days;
        longestBannedAccountName = profile.name;
      }
    }

    const activePoolProfiles = profiles.filter((profile) =>
      ACTIVE_POOL_STATUSES.has(profile.status),
    );

    const activeAgesDays = activePoolProfiles
      .map((profile) => accountAgeDays(profile))
      .filter((days): days is number => days !== null);

    let oldestActiveAccountAgeDays: number | null = null;
    let oldestActiveAccountName: string | null = null;
    for (const profile of activePoolProfiles) {
      const age = accountAgeDays(profile);
      if (age === null) {
        continue;
      }
      if (oldestActiveAccountAgeDays === null || age > oldestActiveAccountAgeDays) {
        oldestActiveAccountAgeDays = age;
        oldestActiveAccountName = profile.name;
      }
    }

    const activeRiskScores = activePoolProfiles.map((profile) => profile.riskScore);

    const [
      accountCreatedEvents,
      challengeEvents,
      sessionStartedEvents,
      sessionEndedEvents,
      actionSucceededEvents,
      actionFailedEvents,
    ] = await Promise.all([
      ctx.db
        .query("events")
        .withIndex("by_type_ts", (q) => q.eq("type", "AccountCreated"))
        .collect(),
      ctx.db
        .query("events")
        .withIndex("by_type_ts", (q) => q.eq("type", "ChallengeDetected"))
        .collect(),
      ctx.db
        .query("events")
        .withIndex("by_type_ts", (q) => q.eq("type", "SessionStarted"))
        .collect(),
      ctx.db
        .query("events")
        .withIndex("by_type_ts", (q) => q.eq("type", "SessionEnded"))
        .collect(),
      ctx.db
        .query("events")
        .withIndex("by_type_ts", (q) => q.eq("type", "ActionSucceeded"))
        .collect(),
      ctx.db
        .query("events")
        .withIndex("by_type_ts", (q) => q.eq("type", "ActionFailed"))
        .collect(),
    ]);

    const accountCreatedTsByProfile = new Map<string, number>();
    for (const event of accountCreatedEvents) {
      const existing = accountCreatedTsByProfile.get(event.profileId);
      if (existing === undefined || event.ts < existing) {
        accountCreatedTsByProfile.set(event.profileId, event.ts);
      }
    }

    const signupStartTsByProfile = new Map<string, number>();
    const signupSessionIdByProfile = new Map<string, string>();
    for (const event of sessionStartedEvents) {
      if (!isSignupSessionStarted(event.data)) {
        continue;
      }
      const existing = signupStartTsByProfile.get(event.profileId);
      if (existing === undefined || event.ts < existing) {
        signupStartTsByProfile.set(event.profileId, event.ts);
        if (event.sessionId !== undefined) {
          signupSessionIdByProfile.set(event.profileId, event.sessionId);
        }
      }
    }

    const signupEndTsByProfile = new Map<string, number>();
    for (const event of sessionEndedEvents) {
      const signupSessionId = signupSessionIdByProfile.get(event.profileId);
      if (signupSessionId === undefined || event.sessionId !== signupSessionId) {
        continue;
      }
      const existing = signupEndTsByProfile.get(event.profileId);
      if (existing === undefined || event.ts > existing) {
        signupEndTsByProfile.set(event.profileId, event.ts);
      }
    }

    const creationWindowByProfile = new Map<
      string,
      { start: number; end: number }
    >();
    for (const profile of profiles) {
      const endCandidates = [
        profile.linkedinCreatedAt,
        accountCreatedTsByProfile.get(profile._id),
        signupEndTsByProfile.get(profile._id),
      ].filter((ts): ts is number => ts !== undefined);
      if (endCandidates.length === 0) {
        continue;
      }

      const start =
        signupStartTsByProfile.get(profile._id) ?? profile._creationTime;
      const end = Math.max(...endCandidates);
      if (end < start) {
        continue;
      }
      creationWindowByProfile.set(profile._id, { start, end });
    }

    const profilesWithCreationCaptcha = new Set<string>();

    for (const event of challengeEvents) {
      if (!isCreationChallenge(event.data)) {
        continue;
      }
      const window = creationWindowByProfile.get(event.profileId);
      if (!inTimeWindow(event.ts, window)) {
        continue;
      }
      profilesWithCreationCaptcha.add(event.profileId);
    }

    for (const event of [...actionSucceededEvents, ...actionFailedEvents]) {
      if (!isCaptchaToolAction(event.data)) {
        continue;
      }
      const window = creationWindowByProfile.get(event.profileId);
      if (!inTimeWindow(event.ts, window)) {
        continue;
      }
      profilesWithCreationCaptcha.add(event.profileId);
    }

    const activeCreatedProfiles = activePoolProfiles.filter((profile) =>
      creationWindowByProfile.has(profile._id),
    );
    const activeCreatedWithCaptchaCount = activeCreatedProfiles.filter((profile) =>
      profilesWithCreationCaptcha.has(profile._id),
    ).length;
    const creationCaptchaPct =
      activeCreatedProfiles.length > 0
        ? (activeCreatedWithCaptchaCount / activeCreatedProfiles.length) * 100
        : 0;

    const creationDurationsMinutes: number[] = [];
    for (const [profileId, createdTs] of accountCreatedTsByProfile) {
      const signupStartTs = signupStartTsByProfile.get(profileId);
      if (signupStartTs === undefined || createdTs < signupStartTs) {
        continue;
      }
      creationDurationsMinutes.push((createdTs - signupStartTs) / (60 * 1000));
    }

    const banTotal = withLinkedin.length;
    const banCount = restrictedProfiles.length;

    return {
      avgTimeToBanDays: average(banDurationsDays),
      avgTimeToBanSample: banDurationsDays.length,
      longestBannedLifespanDays,
      longestBannedAccountName,
      avgActiveAccountAgeDays: average(activeAgesDays),
      avgActiveAccountAgeSample: activeAgesDays.length,
      oldestActiveAccountAgeDays,
      oldestActiveAccountName,
      avgActiveRiskScore: average(activeRiskScores),
      avgActiveRiskScoreSample: activeRiskScores.length,
      avgCreationCaptchaPct: creationCaptchaPct,
      avgCreationCaptchaSample: activeCreatedProfiles.length,
      creationCaptchaHitCount: activeCreatedWithCaptchaCount,
      avgCreationTimeMinutes: average(creationDurationsMinutes),
      avgCreationTimeSample: creationDurationsMinutes.length,
      banRatePct: banTotal > 0 ? (banCount / banTotal) * 100 : 0,
      banRateSample: banTotal,
      banCount,
      activePool: activePoolProfiles.length,
    };
  },
});

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

export const poolPixels = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const profiles = await ctx.db.query("profiles").collect();

    const byStatus: Record<string, number> = {};
    let active = 0;
    let restricted = 0;
    let other = 0;

    for (const profile of profiles) {
      byStatus[profile.status] = (byStatus[profile.status] ?? 0) + 1;

      if (profile.status === "restricted" || profile.isRestricted === true) {
        restricted += 1;
      } else if (ACTIVE_POOL_STATUSES.has(profile.status)) {
        active += 1;
      } else {
        other += 1;
      }
    }

    const total = profiles.length;
    const operationalTotal = active + restricted;

    return {
      total,
      active,
      restricted,
      other,
      operationalTotal,
      activePct:
        operationalTotal > 0 ? (active / operationalTotal) * 100 : 0,
      byStatus,
    };
  },
});

export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const user = await ctx.db.get(userId);
    if (!user) {
      return null;
    }
    return {
      name: user.name ?? null,
      email: user.email ?? null,
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

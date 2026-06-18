import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
} from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { assertWorkerKey, type ProfileStatus } from "./lib/guards";
import { appendEvent } from "./events";
import { evaluateCore } from "./health";
import {
  getUserProfile,
  isInsufficientPermissions,
  probeUserProfileRaw,
  UnipileApiError,
} from "./lib/unipile";

const RESTRICTION_HTTP_STATUS = 403;
const RESTRICTION_ERROR_TYPE = "provider/insufficient_permissions";

// Statuses worth probing for a NEW restriction. "restricted" is intentionally
// excluded: those accounts are already restricted, so re-probing them wastes
// probe calls and inflates the `restricted` counter without changing the DB.
const MONITOR_STATUSES = [
  "provisioning",
  "warming",
  "active",
  "cooldown",
  "warning",
  "recovering",
] as const;

const LINKEDIN_PROFILE_PATH = /^\/in\/([a-zA-Z0-9\-_%]+)\/?$/;
const SLUG_BLOCKLIST = new Set(["me", "company", "pub", "learning", "sales"]);

function publicIdentifierFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("linkedin.com")) return null;
    const match = u.pathname.match(LINKEDIN_PROFILE_PATH);
    if (!match) return null;
    const slug = match[1];
    if (SLUG_BLOCKLIST.has(slug.toLowerCase())) return null;
    return slug;
  } catch {
    return null;
  }
}

type CheckTarget = {
  profileId: Id<"profiles">;
  publicIdentifier: string;
  name: string;
};

function targetFromProfile(
  profile: {
    _id: Id<"profiles">;
    name: string;
    linkedInProfileUrl?: string;
    maintained?: boolean;
    isRestricted?: boolean;
    status: string;
  },
  opts?: { explicit?: boolean },
): CheckTarget | { skipReason: string } {
  if (profile.maintained === false) {
    return { skipReason: "profile is not maintained" };
  }
  if (!opts?.explicit) {
    if (profile.isRestricted) {
      return { skipReason: "profile is already restricted" };
    }
    if (!MONITOR_STATUSES.includes(profile.status as (typeof MONITOR_STATUSES)[number])) {
      return { skipReason: `status ${profile.status} is not monitored` };
    }
  }
  if (!profile.linkedInProfileUrl) {
    return { skipReason: "profile has no linkedInProfileUrl" };
  }
  const publicIdentifier = publicIdentifierFromUrl(profile.linkedInProfileUrl);
  if (!publicIdentifier) {
    return { skipReason: "linkedInProfileUrl has no usable public identifier" };
  }
  return {
    profileId: profile._id,
    publicIdentifier,
    name: profile.name,
  };
}

const MAX_PROBE_ATTEMPTS = 3;
const PROBE_RETRY_BASE_MS = 750;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type ProbeOutcome = "ok" | "restricted" | "error";

interface ProbeAttempt {
  outcome: ProbeOutcome;
  // A transient failure (rate-limit / 5xx / network) worth retrying — as opposed
  // to a definitive answer (ok / restricted) or a persistent error (e.g. 404/401).
  transient: boolean;
  httpStatus?: number;
  errorType?: string;
  message?: string;
  displayName?: string;
  profileUrl?: string;
}

// A restriction (403 insufficient_permissions) is NEVER transient — it is the
// signal we are looking for. Rate-limits, 5xx, and raw network failures are.
function isTransientError(err: unknown): boolean {
  if (err instanceof UnipileApiError) {
    return err.status === 429 || err.status >= 500;
  }
  return true; // fetch/network failure
}

async function attemptProbe(
  apiKey: string,
  probeAccountId: string,
  target: CheckTarget,
): Promise<ProbeAttempt> {
  try {
    const profile = await getUserProfile(apiKey, probeAccountId, target.publicIdentifier);
    return {
      outcome: "ok",
      transient: false,
      httpStatus: 200,
      displayName: profile.display_name,
      profileUrl: profile.profile_url,
    };
  } catch (err) {
    if (isInsufficientPermissions(err)) {
      return {
        outcome: "restricted",
        transient: false,
        httpStatus: err.status,
        errorType: err.body?.type,
      };
    }
    return {
      outcome: "error",
      transient: isTransientError(err),
      httpStatus: err instanceof UnipileApiError ? err.status : undefined,
      errorType: err instanceof UnipileApiError ? err.body?.type : undefined,
      message: String(err).slice(0, 500),
    };
  }
}

// Probe with bounded retries on transient failures so a rate-limit/5xx blip
// cannot hide a real restriction behind an "error" outcome.
async function probeWithRetry(
  apiKey: string,
  probeAccountId: string,
  target: CheckTarget,
): Promise<ProbeAttempt> {
  let attempt = await attemptProbe(apiKey, probeAccountId, target);
  let tries = 1;
  while (attempt.outcome === "error" && attempt.transient && tries < MAX_PROBE_ATTEMPTS) {
    await sleep(PROBE_RETRY_BASE_MS * tries);
    attempt = await attemptProbe(apiKey, probeAccountId, target);
    tries += 1;
  }
  return attempt;
}

async function writeOutcome(
  ctx: Pick<ActionCtx, "runMutation">,
  target: CheckTarget,
  attempt: ProbeAttempt,
): Promise<void> {
  if (attempt.outcome === "ok") {
    await ctx.runMutation(internal.monitoring.recordCheckResult, {
      profileId: target.profileId,
      publicIdentifier: target.publicIdentifier,
      outcome: "ok",
      displayName: attempt.displayName,
      profileUrl: attempt.profileUrl,
    });
    return;
  }
  if (attempt.outcome === "restricted") {
    await ctx.runMutation(internal.monitoring.recordCheckResult, {
      profileId: target.profileId,
      publicIdentifier: target.publicIdentifier,
      outcome: "restricted",
      httpStatus: attempt.httpStatus,
      errorType: attempt.errorType,
    });
    return;
  }
  await ctx.runMutation(internal.monitoring.recordCheckResult, {
    profileId: target.profileId,
    publicIdentifier: target.publicIdentifier,
    outcome: "error",
    error: attempt.message,
    httpStatus: attempt.httpStatus,
    errorType: attempt.errorType,
  });
}

interface ProbeErrorDetail {
  profileId: Id<"profiles">;
  name: string;
  publicIdentifier: string;
  httpStatus: number | null;
  errorType: string | null;
  message: string | null;
}

type RestrictionCheckResult = {
  total: number;
  checked: number;
  restricted: number;
  errors: number;
  skipReason?: string;
  profileId?: Id<"profiles">;
  name?: string;
  outcome?: ProbeOutcome;
  retriedAfterTransient?: number;
  errorDetails: ProbeErrorDetail[];
};

function errorDetail(target: CheckTarget, attempt: ProbeAttempt): ProbeErrorDetail {
  return {
    profileId: target.profileId,
    name: target.name,
    publicIdentifier: target.publicIdentifier,
    httpStatus: attempt.httpStatus ?? null,
    errorType: attempt.errorType ?? null,
    message: attempt.message ?? null,
  };
}

export const profilesToCheck = internalQuery({
  args: {},
  handler: async (ctx) => {
    const targets: Array<{
      profileId: Id<"profiles">;
      publicIdentifier: string;
      name: string;
    }> = [];

    for (const status of MONITOR_STATUSES) {
      const profiles = await ctx.db
        .query("profiles")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect();

      for (const profile of profiles) {
        const target = targetFromProfile(profile);
        if ("skipReason" in target) continue;
        targets.push(target);
      }
    }

    return targets;
  },
});

export const profileToCheck = internalQuery({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    const profile = await ctx.db.get(profileId);
    if (!profile) return { target: null, skipReason: "profile not found" };
    const target = targetFromProfile(profile, { explicit: true });
    if ("skipReason" in target) return { target: null, skipReason: target.skipReason };
    return { target, skipReason: null };
  },
});

type DiagnosticTarget = {
  profileId: Id<"profiles">;
  name: string;
  status: string;
  isRestricted: boolean;
  linkedInProfileUrl: string | null;
  publicIdentifier: string | null;
  skipReason: string | null;
};

type ProbeDiagnosticResult = {
  profileId: Id<"profiles">;
  name: string;
  status: string;
  isRestricted: boolean;
  publicIdentifier: string | null;
  outcome: "ok" | "restricted" | "error" | "skipped";
  httpStatus: number | null;
  errorType: string | null;
  wouldFlagRestricted: boolean;
  mismatch: boolean;
  detail: string;
  raw: unknown;
};

// Read-only target list for diagnostics. Unlike profilesToCheck this also
// surfaces already-restricted profiles and reports WHY a profile would be
// skipped, so false negatives can be inspected.
export const diagnosticTargets = internalQuery({
  args: {
    profileId: v.optional(v.id("profiles")),
    includeRestricted: v.optional(v.boolean()),
  },
  handler: async (ctx, { profileId, includeRestricted }) => {
    const out: DiagnosticTarget[] = [];

    const push = (profile: {
      _id: Id<"profiles">;
      name: string;
      status: string;
      isRestricted?: boolean;
      linkedInProfileUrl?: string;
    }) => {
      const url = profile.linkedInProfileUrl ?? null;
      const publicIdentifier = url ? publicIdentifierFromUrl(url) : null;
      let skipReason: string | null = null;
      if (!url) skipReason = "no linkedInProfileUrl";
      else if (!publicIdentifier) skipReason = "no usable public identifier in URL";
      out.push({
        profileId: profile._id,
        name: profile.name,
        status: profile.status,
        isRestricted: Boolean(profile.isRestricted),
        linkedInProfileUrl: url,
        publicIdentifier,
        skipReason,
      });
    };

    if (profileId) {
      const profile = await ctx.db.get(profileId);
      if (profile) push(profile);
      return out;
    }

    const statuses: ProfileStatus[] = includeRestricted
      ? [...MONITOR_STATUSES, "restricted"]
      : [...MONITOR_STATUSES];
    for (const status of statuses) {
      const profiles = await ctx.db
        .query("profiles")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect();
      for (const profile of profiles) {
        if (profile.maintained === false) continue;
        push(profile);
      }
    }
    return out;
  },
});

// Dry-run probe: hits Unipile for each target and returns the RAW outcome
// (http status, error type, body) plus what the live logic WOULD classify it
// as — without writing any events or mutating profiles. Built to debug why
// some genuinely restricted accounts are not flagged.
export const probeDiagnostics = action({
  args: {
    workerKey: v.string(),
    profileId: v.optional(v.id("profiles")),
    includeRestricted: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { workerKey, profileId, includeRestricted },
  ): Promise<{ count: number; results: ProbeDiagnosticResult[] }> => {
    assertWorkerKey(workerKey);
    const apiKey = process.env.UNIPILE_API_KEY;
    const probeAccountId = process.env.UNIPILE_PROBE_ACCOUNT_ID;
    if (!apiKey) throw new Error("UNIPILE_API_KEY is not configured on the deployment");
    if (!probeAccountId) {
      throw new Error("UNIPILE_PROBE_ACCOUNT_ID is not configured on the deployment");
    }

    const targets = await ctx.runQuery(internal.monitoring.diagnosticTargets, {
      profileId,
      includeRestricted: includeRestricted ?? Boolean(profileId),
    });

    const results: ProbeDiagnosticResult[] = [];
    for (const t of targets) {
      const common = {
        profileId: t.profileId,
        name: t.name,
        status: t.status,
        isRestricted: t.isRestricted,
        publicIdentifier: t.publicIdentifier,
      };

      if (!t.publicIdentifier) {
        results.push({
          ...common,
          outcome: "skipped" as "ok" | "restricted" | "error" | "skipped",
          httpStatus: null as number | null,
          errorType: null as string | null,
          wouldFlagRestricted: false,
          mismatch: false,
          detail: t.skipReason ?? "no public identifier",
          raw: null as unknown,
        });
        continue;
      }

      const probe = await probeUserProfileRaw(apiKey, probeAccountId, t.publicIdentifier);
      const wouldFlagRestricted =
        !probe.ok &&
        probe.httpStatus === RESTRICTION_HTTP_STATUS &&
        probe.errorType === RESTRICTION_ERROR_TYPE;
      const liveOutcome = probe.ok ? "ok" : wouldFlagRestricted ? "restricted" : "error";
      const displayName =
        probe.ok && typeof probe.body === "object" && probe.body !== null
          ? (probe.body as { display_name?: string }).display_name
          : undefined;

      results.push({
        ...common,
        outcome: liveOutcome as "ok" | "restricted" | "error",
        httpStatus: probe.httpStatus,
        errorType: probe.errorType ?? null,
        wouldFlagRestricted,
        // Highlights the false-negative case: DB says restricted but the live
        // probe would treat it as healthy (or vice-versa).
        mismatch: t.isRestricted !== wouldFlagRestricted,
        detail: displayName ?? probe.errorType ?? `HTTP ${probe.httpStatus}`,
        raw: probe.body,
      });
    }

    return { count: results.length, results };
  },
});

export const recordCheckResult = internalMutation({
  args: {
    profileId: v.id("profiles"),
    publicIdentifier: v.string(),
    outcome: v.union(v.literal("ok"), v.literal("restricted"), v.literal("error")),
    displayName: v.optional(v.string()),
    profileUrl: v.optional(v.string()),
    error: v.optional(v.string()),
    httpStatus: v.optional(v.number()),
    errorType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const base = {
      source: "unipile_probe",
      publicIdentifier: args.publicIdentifier,
    };

    if (args.outcome === "restricted") {
      const profile = await ctx.db.get(args.profileId);
      if (profile?.isRestricted) {
        await appendEvent(ctx, {
          profileId: args.profileId,
          type: "ActionSucceeded",
          ts: now,
          channel: "system",
          data: { ...base, restricted: true, alreadyRestricted: true },
          ctx: {},
        });
        return;
      }

      await appendEvent(ctx, {
        profileId: args.profileId,
        type: "RestrictionDetected",
        ts: now,
        channel: "system",
        data: {
          ...base,
          httpStatus: args.httpStatus ?? 403,
          errorType: args.errorType ?? "provider/insufficient_permissions",
        },
        ctx: {},
      });
      await evaluateCore(ctx, args.profileId, {
        restrictionDetected: true,
        restrictionSource: "unipile_probe",
      });
      await appendEvent(ctx, {
        profileId: args.profileId,
        type: "ActionSucceeded",
        ts: now,
        channel: "system",
        data: { ...base, restricted: true },
        ctx: {},
      });
      return;
    }

    if (args.outcome === "error") {
      await appendEvent(ctx, {
        profileId: args.profileId,
        type: "ActionFailed",
        ts: now,
        channel: "system",
        data: {
          ...base,
          error: args.error,
          httpStatus: args.httpStatus,
          errorType: args.errorType,
        },
        ctx: {},
      });
      return;
    }

    await appendEvent(ctx, {
      profileId: args.profileId,
      type: "ActionSucceeded",
      ts: now,
      channel: "system",
      data: {
        ...base,
        restricted: false,
        displayName: args.displayName,
        profileUrl: args.profileUrl,
      },
      ctx: {},
    });
  },
});

export const runRestrictionChecks = internalAction({
  args: { profileId: v.optional(v.id("profiles")) },
  handler: async (ctx, { profileId }): Promise<RestrictionCheckResult> => {
    const apiKey = process.env.UNIPILE_API_KEY;
    const probeAccountId = process.env.UNIPILE_PROBE_ACCOUNT_ID;
    if (!apiKey) throw new Error("UNIPILE_API_KEY is not configured on the deployment");
    if (!probeAccountId) {
      throw new Error("UNIPILE_PROBE_ACCOUNT_ID is not configured on the deployment");
    }

    if (profileId) {
      const { target, skipReason } = await ctx.runQuery(internal.monitoring.profileToCheck, {
        profileId,
      });
      if (!target) {
        return { total: 0, checked: 0, restricted: 0, errors: 0, skipReason, errorDetails: [] };
      }

      const attempt = await probeWithRetry(apiKey, probeAccountId, target);
      await writeOutcome(ctx, target, attempt);
      return {
        total: 1,
        checked: attempt.outcome === "ok" ? 1 : 0,
        restricted: attempt.outcome === "restricted" ? 1 : 0,
        errors: attempt.outcome === "error" ? 1 : 0,
        profileId: target.profileId,
        name: target.name,
        outcome: attempt.outcome,
        errorDetails: attempt.outcome === "error" ? [errorDetail(target, attempt)] : [],
      };
    }

    const targets = await ctx.runQuery(internal.monitoring.profilesToCheck, {});
    let checked = 0;
    let restricted = 0;
    let errors = 0;
    const errorDetails: ProbeErrorDetail[] = [];

    // Pass 1: probe everything. Transient failures (after per-probe retries) are
    // deferred — they get a clean second pass once the request burst has eased,
    // so a rate-limit blip can't leave a restricted account silently unflagged.
    const deferred: CheckTarget[] = [];
    for (const target of targets) {
      const attempt = await probeWithRetry(apiKey, probeAccountId, target);
      if (attempt.outcome === "error" && attempt.transient) {
        deferred.push(target);
        continue;
      }
      await writeOutcome(ctx, target, attempt);
      if (attempt.outcome === "ok") checked += 1;
      else if (attempt.outcome === "restricted") restricted += 1;
      else {
        errors += 1;
        errorDetails.push(errorDetail(target, attempt));
      }
    }

    // Pass 2: re-probe the transient failures and record whatever they resolve to.
    for (const target of deferred) {
      const attempt = await probeWithRetry(apiKey, probeAccountId, target);
      await writeOutcome(ctx, target, attempt);
      if (attempt.outcome === "ok") checked += 1;
      else if (attempt.outcome === "restricted") restricted += 1;
      else {
        errors += 1;
        errorDetails.push(errorDetail(target, attempt));
      }
    }

    return {
      total: targets.length,
      checked,
      restricted,
      errors,
      retriedAfterTransient: deferred.length,
      errorDetails,
    };
  },
});

export const run = mutation({
  args: {
    workerKey: v.string(),
    profileId: v.optional(v.id("profiles")),
  },
  handler: async (ctx, { workerKey, profileId }) => {
    assertWorkerKey(workerKey);
    await ctx.scheduler.runAfter(0, internal.monitoring.runRestrictionChecks, { profileId });
    return { scheduled: true, profileId: profileId ?? null };
  },
});

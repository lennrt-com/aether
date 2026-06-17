import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { campaignProxyStrategy, campaignStatus } from "./schema";
import { assertWorkerKey, isProfileRestricted } from "./lib/guards";

const HEALTHY_STATUSES = new Set([
  "warming",
  "active",
  "cooldown",
  "warning",
  "recovering",
]);

/** Steady-state re-check when target is already met. */
const STEADY_STATE_RECHECK_MS = 60_000;

/** Minimum spacing between attempt starts (90–110% of even interval). */
function spacingIntervalMs(maxPerHour: number): number {
  const base = 3_600_000 / maxPerHour;
  return Math.floor(base * (0.9 + Math.random() * 0.2));
}

export interface CampaignStats {
  healthy: number;
  restricted: number;
  pending: number;
  retired: number;
  other: number;
  total: number;
  targetHealthy: number;
  maxPerHour: number;
}

async function membersForCampaign(
  ctx: QueryCtx | MutationCtx,
  campaignId: Id<"campaigns">,
): Promise<Doc<"profiles">[]> {
  return await ctx.db
    .query("profiles")
    .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
    .collect();
}

export function computeStats(
  campaign: Doc<"campaigns">,
  profiles: Doc<"profiles">[],
): CampaignStats {
  let healthy = 0;
  let restricted = 0;
  let pending = 0;
  let retired = 0;
  let other = 0;

  for (const p of profiles) {
    if (isProfileRestricted(p)) {
      restricted += 1;
      continue;
    }
    if (p.status === "provisioning") {
      pending += 1;
      continue;
    }
    if (p.status === "retired") {
      retired += 1;
      continue;
    }
    if (HEALTHY_STATUSES.has(p.status)) {
      healthy += 1;
      continue;
    }
    other += 1;
  }

  return {
    healthy,
    restricted,
    pending,
    retired,
    other,
    total: profiles.length,
    targetHealthy: campaign.targetHealthy,
    maxPerHour: campaign.maxPerHour,
  };
}

export const create = mutation({
  args: {
    workerKey: v.string(),
    name: v.string(),
    targetHealthy: v.number(),
    maxPerHour: v.number(),
    cohortTag: v.optional(v.string()),
    geo: v.optional(v.string()),
    timezone: v.optional(v.string()),
    role: v.optional(v.string()),
    agentModel: v.optional(v.string()),
    personaModel: v.optional(v.string()),
    personaPrompt: v.optional(v.string()),
    location: v.optional(v.string()),
    skipPreflight: v.optional(v.boolean()),
    proxyStrategy: campaignProxyStrategy,
    proxyPoolId: v.optional(v.id("proxyPool")),
  },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    if (args.targetHealthy < 1) throw new Error("targetHealthy must be >= 1");
    if (args.maxPerHour < 1) throw new Error("maxPerHour must be >= 1");
    if (args.proxyStrategy === "single" && !args.proxyPoolId) {
      throw new Error("proxyStrategy single requires proxyPoolId");
    }

    return await ctx.db.insert("campaigns", {
      name: args.name,
      status: "running",
      targetHealthy: args.targetHealthy,
      maxPerHour: args.maxPerHour,
      cohortTag: args.cohortTag ?? "default",
      geo: args.geo,
      timezone: args.timezone,
      role: args.role,
      agentModel: args.agentModel,
      personaModel: args.personaModel,
      personaPrompt: args.personaPrompt,
      location: args.location,
      skipPreflight: args.skipPreflight,
      proxyStrategy: args.proxyStrategy,
      proxyPoolId: args.proxyPoolId,
      proxyCursor: 0,
    });
  },
});

export const get = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, { campaignId }) => {
    return await ctx.db.get(campaignId);
  },
});

export const list = query({
  args: {
    status: v.optional(campaignStatus),
  },
  handler: async (ctx, { status }) => {
    if (status !== undefined) {
      return await ctx.db
        .query("campaigns")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect();
    }
    return await ctx.db.query("campaigns").collect();
  },
});

export const stats = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, { campaignId }) => {
    const campaign = await ctx.db.get(campaignId);
    if (!campaign) throw new Error(`campaign not found: ${campaignId}`);
    const profiles = await membersForCampaign(ctx, campaignId);
    return computeStats(campaign, profiles);
  },
});

export const members = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, { campaignId }) => {
    return await membersForCampaign(ctx, campaignId);
  },
});

export const attachProfile = mutation({
  args: {
    workerKey: v.string(),
    campaignId: v.id("campaigns"),
    profileId: v.id("profiles"),
  },
  handler: async (ctx, { workerKey, campaignId, profileId }) => {
    assertWorkerKey(workerKey);
    const campaign = await ctx.db.get(campaignId);
    if (!campaign) throw new Error(`campaign not found: ${campaignId}`);
    const profile = await ctx.db.get(profileId);
    if (!profile) throw new Error(`profile not found: ${profileId}`);
    if (profile.campaignId !== undefined && profile.campaignId !== campaignId) {
      throw new Error(`profile already belongs to campaign ${profile.campaignId}`);
    }
    await ctx.db.patch(profileId, {
      campaignId,
      cohortTag: campaign.cohortTag,
    });
  },
});

export const setStatus = mutation({
  args: {
    workerKey: v.string(),
    campaignId: v.id("campaigns"),
    status: campaignStatus,
  },
  handler: async (ctx, { workerKey, campaignId, status }) => {
    assertWorkerKey(workerKey);
    const campaign = await ctx.db.get(campaignId);
    if (!campaign) throw new Error(`campaign not found: ${campaignId}`);
    await ctx.db.patch(campaignId, { status });
  },
});

export const beginAttempt = mutation({
  args: {
    workerKey: v.string(),
    campaignId: v.id("campaigns"),
    now: v.optional(v.number()),
  },
  handler: async (ctx, { workerKey, campaignId, now: nowArg }) => {
    assertWorkerKey(workerKey);
    const now = nowArg ?? Date.now();
    const campaign = await ctx.db.get(campaignId);
    if (!campaign) throw new Error(`campaign not found: ${campaignId}`);

    if (campaign.status !== "running") {
      return {
        go: false as const,
        reason: `campaign status is ${campaign.status}`,
        waitMs: STEADY_STATE_RECHECK_MS,
        stats: null,
      };
    }

    const profiles = await membersForCampaign(ctx, campaignId);
    const stats = computeStats(campaign, profiles);

    // Steady state: enough healthy + in-flight signups to meet target.
    if (stats.healthy + stats.pending >= campaign.targetHealthy) {
      return {
        go: false as const,
        reason: "target met",
        waitMs: STEADY_STATE_RECHECK_MS,
        stats,
      };
    }

    const lastStart = campaign.lastAttemptStartedAt;
    if (lastStart !== undefined) {
      const requiredGap = spacingIntervalMs(campaign.maxPerHour);
      const elapsed = now - lastStart;
      if (elapsed < requiredGap) {
        return {
          go: false as const,
          reason: "spacing",
          waitMs: requiredGap - elapsed,
          stats,
        };
      }
    }

    const proxyCursor = (campaign.proxyCursor ?? 0) + 1;
    await ctx.db.patch(campaignId, {
      lastAttemptStartedAt: now,
      proxyCursor,
    });

    return {
      go: true as const,
      proxyCursor: proxyCursor - 1,
      proxyStrategy: campaign.proxyStrategy,
      proxyPoolId: campaign.proxyPoolId ?? null,
      stats,
      attemptIndex: profiles.length + 1,
    };
  },
});

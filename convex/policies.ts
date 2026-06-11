import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { assertWorkerKey } from "./lib/guards";

// Appendix E params shape — enforced with Convex validators at the boundary.
export const strategyParams = v.object({
  budgetMultiplier: v.number(),
  dailyBudgets: v.object({
    send_invitation: v.number(),
    send_message: v.number(),
    engage_post: v.number(),
    warmup_feed: v.number(),
    fetch_profile: v.number(),
  }),
  minDelayBetweenSessionsMin: v.number(),
  warmupCurve: v.array(v.object({ maxAgeDays: v.number(), factor: v.number() })),
  warmingActionMixOverride: v.object({
    warmup_feed: v.number(),
    engage_post: v.number(),
  }),
});

// Appendix E v1 defaults — final, do not tune.
export const DEFAULT_STRATEGY_PARAMS = {
  budgetMultiplier: 1.0,
  dailyBudgets: {
    send_invitation: 5,
    send_message: 10,
    engage_post: 8,
    warmup_feed: 3,
    fetch_profile: 20,
  },
  minDelayBetweenSessionsMin: 90,
  warmupCurve: [
    { maxAgeDays: 14, factor: 0.2 },
    { maxAgeDays: 30, factor: 0.5 },
    { maxAgeDays: 60, factor: 0.8 },
    { maxAgeDays: 99999, factor: 1.0 },
  ],
  warmingActionMixOverride: { warmup_feed: 0.8, engage_post: 0.2 },
};

export async function getActiveStrategy(
  ctx: QueryCtx,
  cohortTag = "default",
): Promise<Doc<"strategyVersions"> | null> {
  return await ctx.db
    .query("strategyVersions")
    .withIndex("by_cohort_status", (q) => q.eq("cohortTag", cohortTag).eq("status", "active"))
    .first();
}

export const getActive = query({
  args: { cohortTag: v.optional(v.string()) },
  handler: async (ctx, { cohortTag }) => {
    return await getActiveStrategy(ctx, cohortTag ?? "default");
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("strategyVersions").collect();
  },
});

export const createDraft = mutation({
  args: {
    workerKey: v.string(),
    params: strategyParams,
    basedOnIncidentIds: v.optional(v.array(v.id("incidents"))),
    notes: v.optional(v.string()),
    cohortTag: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    const cohortTag = args.cohortTag ?? "default";
    const all = await ctx.db
      .query("strategyVersions")
      .withIndex("by_cohort_status", (q) => q.eq("cohortTag", cohortTag))
      .collect();
    const nextVersion = Math.max(0, ...all.map((s) => s.version)) + 1;
    return await ctx.db.insert("strategyVersions", {
      version: nextVersion,
      cohortTag,
      status: "draft",
      params: args.params,
      basedOnIncidentIds: args.basedOnIncidentIds,
      notes: args.notes,
    });
  },
});

// Human approval — sets active, retires the previous active for the cohort.
export const approve = mutation({
  args: {
    workerKey: v.string(),
    strategyVersionId: v.id("strategyVersions"),
    approvedBy: v.string(),
  },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);
    const draft = await ctx.db.get(args.strategyVersionId);
    if (!draft) throw new Error("strategy version not found");
    if (draft.status !== "draft") throw new Error(`cannot approve ${draft.status} strategy`);
    const current = await getActiveStrategy(ctx, draft.cohortTag);
    if (current) await ctx.db.patch(current._id, { status: "retired" });
    await ctx.db.patch(args.strategyVersionId, {
      status: "active",
      approvedBy: args.approvedBy,
    });
  },
});

export const seedDefaultStrategy = mutation({
  args: { workerKey: v.string() },
  handler: async (ctx, { workerKey }) => {
    assertWorkerKey(workerKey);
    const existing = await ctx.db
      .query("strategyVersions")
      .withIndex("by_cohort_status", (q) => q.eq("cohortTag", "default"))
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("strategyVersions", {
      version: 1,
      cohortTag: "default",
      status: "active",
      params: DEFAULT_STRATEGY_PARAMS,
      notes: "Appendix E v1 defaults",
      approvedBy: "seed",
    });
  },
});

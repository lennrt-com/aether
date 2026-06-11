import { internalMutation, mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { assertWorkerKey } from "./lib/guards";
import { appendEvent } from "./events";
import { getActiveStrategy } from "./policies";

interface StrategyParams {
  budgetMultiplier: number;
  dailyBudgets: Record<string, number>;
  minDelayBetweenSessionsMin: number;
  warmupCurve: Array<{ maxAgeDays: number; factor: number }>;
  warmingActionMixOverride: Record<string, number>;
}

interface PersonaBehavior {
  timezone?: string;
  activeHours?: Array<{ start: number; end: number }>;
  actionMix?: Record<string, number>;
}

const SCHEDULABLE_STATUSES = ["warming", "active"] as const;
const JITTER_MAX_MS = 25 * 60 * 1000;

function tzOffsetMs(ts: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(new Date(ts)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(ts / 1000) * 1000;
}

function tzMidnightUtc(now: number, timeZone: string): number {
  const offset = tzOffsetMs(now, timeZone);
  const local = now + offset;
  return Math.floor(local / 86400000) * 86400000 - offset;
}

function hourInTz(now: number, timeZone: string): number {
  return Math.floor(((now + tzOffsetMs(now, timeZone)) % 86400000) / 3600000);
}

function warmupFactor(params: StrategyParams, accountAgeDays: number): number {
  const sorted = [...params.warmupCurve].sort((a, b) => a.maxAgeDays - b.maxAgeDays);
  for (const step of sorted) {
    if (accountAgeDays <= step.maxAgeDays) return step.factor;
  }
  return 1.0;
}

type ScheduleOutcome =
  | { enqueued: Id<"tasks">; taskType: string }
  | { skipped: string };

async function scheduleProfile(
  ctx: MutationCtx,
  profile: Doc<"profiles">,
  strategy: Doc<"strategyVersions">,
  now: number,
): Promise<ScheduleOutcome> {
  const params = strategy.params as StrategyParams;
  const persona = profile.personaId ? await ctx.db.get(profile.personaId) : null;
  if (!persona) return { skipped: "no persona attached" };
  const behavior = ((persona.data ?? {}) as { behavior?: PersonaBehavior }).behavior ?? {};
  const timezone = behavior.timezone ?? "UTC";

  const hour = hourInTz(now, timezone);
  const activeHours = behavior.activeHours ?? [];
  const inHours = activeHours.some((r) => hour >= r.start && hour < r.end);
  if (!inHours) return { skipped: `outside active hours (local hour ${hour})` };

  const lastSession = await ctx.db
    .query("sessions")
    .withIndex("by_profile", (q) => q.eq("profileId", profile._id))
    .order("desc")
    .first();
  if (lastSession && now - lastSession.startedAt < params.minDelayBetweenSessionsMin * 60000) {
    return { skipped: "min delay between sessions not elapsed" };
  }

  // Budgets count everything scheduled for today (pending/claimed/done) so the
  // scheduler can't over-enqueue while tasks sit in the queue.
  const midnight = tzMidnightUtc(now, timezone);
  const todaysTasks = (
    await ctx.db
      .query("tasks")
      .withIndex("by_profile", (q) => q.eq("profileId", profile._id))
      .collect()
  ).filter(
    (t) => t.dueAt >= midnight && ["pending", "claimed", "done"].includes(t.status),
  );
  const countByType = new Map<string, number>();
  for (const t of todaysTasks) countByType.set(t.type, (countByType.get(t.type) ?? 0) + 1);

  const factor = warmupFactor(params, profile.accountAgeDays);
  // ceil so warming caps (e.g. 3 * 0.2) still allow at least one task
  const capFor = (type: string) =>
    Math.ceil((params.dailyBudgets[type] ?? 0) * params.budgetMultiplier * factor);

  const mix: Record<string, number> =
    profile.status === "warming"
      ? params.warmingActionMixOverride
      : (behavior.actionMix ?? {});
  const candidates = Object.entries(mix).filter(
    ([type, weight]) => weight > 0 && (countByType.get(type) ?? 0) < capFor(type),
  );
  if (candidates.length === 0) return { skipped: "daily budgets exhausted" };

  const totalWeight = candidates.reduce((sum, [, w]) => sum + w, 0);
  let roll = Math.random() * totalWeight;
  let chosen = candidates[0][0];
  for (const [type, weight] of candidates) {
    roll -= weight;
    if (roll <= 0) {
      chosen = type;
      break;
    }
  }

  const dueAt = now + Math.floor(Math.random() * JITTER_MAX_MS);
  const taskId = await ctx.db.insert("tasks", {
    profileId: profile._id,
    type: chosen,
    payload: { scheduledAt: now, scheduler: true },
    status: "pending",
    priority: 0,
    dueAt,
    attempts: 0,
  });
  return { enqueued: taskId, taskType: chosen };
}

export async function runSchedulerCore(
  ctx: MutationCtx,
  now: number,
): Promise<{ enqueued: number; skipped: number }> {
  const strategy = await getActiveStrategy(ctx);
  if (!strategy) return { enqueued: 0, skipped: 0 };

  let enqueued = 0;
  let skipped = 0;
  for (const status of SCHEDULABLE_STATUSES) {
    const profiles = await ctx.db
      .query("profiles")
      .withIndex("by_status", (q) => q.eq("status", status))
      .collect();
    for (const profile of profiles) {
      const outcome = await scheduleProfile(ctx, profile, strategy, now);
      if ("enqueued" in outcome) {
        enqueued += 1;
      } else {
        skipped += 1;
        // At most ONE PolicyDecision per profile per cron run.
        await appendEvent(ctx, {
          profileId: profile._id,
          type: "PolicyDecision",
          ts: now,
          channel: "system",
          data: {
            decision: "skip",
            reason: outcome.skipped,
            runAt: now,
            strategyVersion: strategy.version,
          },
          ctx: { strategyVersionId: strategy._id },
        });
      }
    }
  }
  return { enqueued, skipped };
}

export const cronRun = internalMutation({
  args: {},
  handler: async (ctx) => {
    return await runSchedulerCore(ctx, Date.now());
  },
});

// workerKey-guarded entry with a mockable clock for verification scripts.
export const run = mutation({
  args: { workerKey: v.string(), now: v.optional(v.number()) },
  handler: async (ctx, { workerKey, now }) => {
    assertWorkerKey(workerKey);
    return await runSchedulerCore(ctx, now ?? Date.now());
  },
});

import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const RESCUE_TASK_TYPE = "complete_onboarding";

function minAgeMs(): number {
  const override = process.env.PROVISIONING_RESCUE_MIN_AGE_MS;
  return override ? Number(override) : DEFAULT_MIN_AGE_MS;
}

async function hasStoredCredentials(ctx: MutationCtx, profileId: Id<"profiles">): Promise<boolean> {
  const creds = await ctx.db
    .query("accountCredentials")
    .withIndex("by_profile", (q) => q.eq("profileId", profileId))
    .first();
  return creds !== null;
}

async function hasProfileSnapshot(ctx: MutationCtx, profileId: Id<"profiles">): Promise<boolean> {
  const profile = await ctx.db.get(profileId);
  if (profile?.currentSnapshotId) return true;
  const snap = await ctx.db
    .query("profileSnapshots")
    .withIndex("by_profile", (q) => q.eq("profileId", profileId))
    .first();
  return snap !== null;
}

async function hasActiveRescueTask(ctx: MutationCtx, profileId: Id<"profiles">): Promise<boolean> {
  const tasks = await ctx.db
    .query("tasks")
    .withIndex("by_profile", (q) => q.eq("profileId", profileId))
    .collect();
  return tasks.some(
    (t) =>
      t.type === RESCUE_TASK_TYPE &&
      (t.status === "pending" || t.status === "claimed"),
  );
}

async function detectStuckProvisioningCore(ctx: MutationCtx): Promise<Id<"profiles">[]> {
  const cutoff = Date.now() - minAgeMs();
  const profiles = await ctx.db
    .query("profiles")
    .withIndex("by_status", (q) => q.eq("status", "provisioning"))
    .collect();

  const eligible: Id<"profiles">[] = [];
  for (const profile of profiles) {
    if (profile._creationTime > cutoff) continue;
    if (profile.maintained === false) continue;
    if (profile.activeSessionId) continue;

    const [hasCreds, hasSnap, hasTask] = await Promise.all([
      hasStoredCredentials(ctx, profile._id),
      hasProfileSnapshot(ctx, profile._id),
      hasActiveRescueTask(ctx, profile._id),
    ]);
    if (hasTask) continue;
    if (!hasCreds && !hasSnap) continue;
    eligible.push(profile._id);
  }
  return eligible;
}

export const cronEnqueueRescue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const profileIds = await detectStuckProvisioningCore(ctx);
    let enqueued = 0;
    const now = Date.now();
    for (const profileId of profileIds) {
      await ctx.db.insert("tasks", {
        profileId,
        type: RESCUE_TASK_TYPE,
        payload: { reason: "stuck provisioning auto-rescue" },
        status: "pending",
        priority: 1,
        dueAt: now,
        attempts: 0,
      });
      enqueued += 1;
    }
    return { enqueued, eligible: profileIds.length };
  },
});

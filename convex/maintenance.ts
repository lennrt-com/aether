import { mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { assertWorkerKey } from "./lib/guards";

async function deleteProfileFully(
  ctx: { db: import("./_generated/server").MutationCtx["db"]; storage: import("./_generated/server").MutationCtx["storage"] },
  profileId: Id<"profiles">,
): Promise<void> {
  const personas = await ctx.db
    .query("personas")
    .withIndex("by_profile", (q) => q.eq("profileId", profileId))
    .collect();
  for (const row of personas) await ctx.db.delete(row._id);

  const launchConfigs = await ctx.db
    .query("launchConfigs")
    .withIndex("by_profile", (q) => q.eq("profileId", profileId))
    .collect();
  for (const row of launchConfigs) await ctx.db.delete(row._id);

  const proxyBindings = await ctx.db
    .query("proxyBindings")
    .withIndex("by_profile", (q) => q.eq("profileId", profileId))
    .collect();
  for (const row of proxyBindings) await ctx.db.delete(row._id);

  const tasks = await ctx.db
    .query("tasks")
    .withIndex("by_profile", (q) => q.eq("profileId", profileId))
    .collect();
  for (const row of tasks) await ctx.db.delete(row._id);

  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_profile", (q) => q.eq("profileId", profileId))
    .collect();
  for (const row of sessions) await ctx.db.delete(row._id);

  const events = await ctx.db
    .query("events")
    .withIndex("by_profile_ts", (q) => q.eq("profileId", profileId))
    .collect();
  for (const row of events) await ctx.db.delete(row._id);

  const snapshots = await ctx.db
    .query("profileSnapshots")
    .withIndex("by_profile", (q) => q.eq("profileId", profileId))
    .collect();
  for (const snap of snapshots) {
    try {
      await ctx.storage.delete(snap.storageId);
    } catch {
      // blob may already be gone
    }
    await ctx.db.delete(snap._id);
  }

  const fpObs = await ctx.db
    .query("fingerprintObservations")
    .withIndex("by_profile", (q) => q.eq("profileId", profileId))
    .collect();
  for (const row of fpObs) await ctx.db.delete(row._id);

  const creds = await ctx.db
    .query("accountCredentials")
    .withIndex("by_profile", (q) => q.eq("profileId", profileId))
    .collect();
  for (const row of creds) await ctx.db.delete(row._id);

  await ctx.db.delete(profileId);
}

async function trimProfileHistory(
  ctx: { db: import("./_generated/server").MutationCtx["db"]; storage: import("./_generated/server").MutationCtx["storage"] },
  profileId: Id<"profiles">,
  keepSnapshotId: Id<"profileSnapshots"> | undefined,
): Promise<void> {
  const tasks = await ctx.db
    .query("tasks")
    .withIndex("by_profile", (q) => q.eq("profileId", profileId))
    .collect();
  for (const row of tasks) await ctx.db.delete(row._id);

  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_profile", (q) => q.eq("profileId", profileId))
    .collect();
  for (const row of sessions) await ctx.db.delete(row._id);

  const events = await ctx.db
    .query("events")
    .withIndex("by_profile_ts", (q) => q.eq("profileId", profileId))
    .collect();
  for (const row of events) await ctx.db.delete(row._id);

  const snapshots = await ctx.db
    .query("profileSnapshots")
    .withIndex("by_profile", (q) => q.eq("profileId", profileId))
    .collect();
  for (const snap of snapshots) {
    if (keepSnapshotId && snap._id === keepSnapshotId) continue;
    try {
      await ctx.storage.delete(snap.storageId);
    } catch {
      // blob may already be gone
    }
    await ctx.db.delete(snap._id);
  }

  const fpObs = await ctx.db
    .query("fingerprintObservations")
    .withIndex("by_profile", (q) => q.eq("profileId", profileId))
    .collect();
  for (const row of fpObs) await ctx.db.delete(row._id);
}

/** Delete one or more profiles and all attached rows + snapshot blobs. */
export const removeProfiles = mutation({
  args: {
    workerKey: v.string(),
    profileIds: v.array(v.id("profiles")),
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, { workerKey, profileIds, force }) => {
    assertWorkerKey(workerKey);
    const deletedProfileIds: Id<"profiles">[] = [];

    for (const profileId of profileIds) {
      const profile = await ctx.db.get(profileId);
      if (!profile) throw new Error(`profile not found: ${profileId}`);

      if (profile.activeSessionId !== undefined) {
        if (!force) {
          throw new Error(
            `profile ${profileId} (${profile.name}) has an active session — pass force or release it first`,
          );
        }
        const sid = profile.activeSessionId;
        const session = await ctx.db.get(sid);
        if (session && session.status === "running") {
          await ctx.db.patch(sid, {
            status: "failed",
            endedAt: Date.now(),
            outcome: "removed-while-active",
          });
        }
        await ctx.db.patch(profile._id, { activeSessionId: undefined });
      }

      await deleteProfileFully(ctx, profileId);
      deletedProfileIds.push(profileId);
    }

    return { deletedProfileIds, deletedCount: deletedProfileIds.length };
  },
});

/** Remove profiles that never received accountCredentials and all attached rows. */
export const removeProfilesWithoutCredentials = mutation({
  args: { workerKey: v.string() },
  handler: async (ctx, { workerKey }) => {
    assertWorkerKey(workerKey);

    const profiles = await ctx.db.query("profiles").collect();
    const deletedProfileIds: Id<"profiles">[] = [];

    for (const profile of profiles) {
      const creds = await ctx.db
        .query("accountCredentials")
        .withIndex("by_profile", (q) => q.eq("profileId", profile._id))
        .first();

      if (!creds) {
        await deleteProfileFully(ctx, profile._id);
        deletedProfileIds.push(profile._id);
      }
    }

    return {
      deletedProfileIds,
      deletedCount: deletedProfileIds.length,
      preservedCount: profiles.length - deletedProfileIds.length,
    };
  },
});

/** Dev helper: delete all profiles (+ children). Keeps proxyPool / workers / auth. */
export const purgeAllProfiles = mutation({
  args: { workerKey: v.string() },
  handler: async (ctx, { workerKey }) => {
    assertWorkerKey(workerKey);
    const profiles = await ctx.db.query("profiles").collect();
    for (const profile of profiles) {
      await deleteProfileFully(ctx, profile._id);
    }
    return { profilesDeleted: profiles.length };
  },
});

/** Wipe moving DB state for dev resets. Preserves proxy pool and accounts with credentials. */
export const reset = mutation({
  args: { workerKey: v.string() },
  handler: async (ctx, { workerKey }) => {
    assertWorkerKey(workerKey);

    const profiles = await ctx.db.query("profiles").collect();
    const deletedProfileIds: Id<"profiles">[] = [];
    const preservedProfileIds: Id<"profiles">[] = [];

    for (const profile of profiles) {
      const creds = await ctx.db
        .query("accountCredentials")
        .withIndex("by_profile", (q) => q.eq("profileId", profile._id))
        .first();

      if (creds) {
        await trimProfileHistory(ctx, profile._id, profile.currentSnapshotId);
        await ctx.db.patch(profile._id, {
          activeSessionId: undefined,
          maintained: false,
        });
        preservedProfileIds.push(profile._id);
      } else {
        await deleteProfileFully(ctx, profile._id);
        deletedProfileIds.push(profile._id);
      }
    }

    const workers = await ctx.db.query("workers").collect();
    for (const w of workers) await ctx.db.delete(w._id);

    return {
      deletedProfileIds,
      preservedProfileIds,
      workersRemoved: workers.length,
    };
  },
});

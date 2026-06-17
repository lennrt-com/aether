import { mutation, query, internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { assertWorkerKey } from "./lib/guards";

async function deleteSnapshotRow(
  ctx: {
    db: import("./_generated/server").MutationCtx["db"];
    storage: import("./_generated/server").MutationCtx["storage"];
  },
  snapshotId: Id<"profileSnapshots">,
  storageId: string,
): Promise<void> {
  try {
    await ctx.storage.delete(storageId);
  } catch {
    // blob may already be gone
  }
  await ctx.db.delete(snapshotId);
}

export const generateUploadUrl = mutation({
  args: { workerKey: v.string() },
  handler: async (ctx, { workerKey }) => {
    assertWorkerKey(workerKey);
    return await ctx.storage.generateUploadUrl();
  },
});

export const getDownloadUrl = query({
  args: { storageId: v.string() },
  handler: async (ctx, { storageId }) => {
    return await ctx.storage.getUrl(storageId);
  },
});

export const deleteBlob = mutation({
  args: { workerKey: v.string(), storageId: v.string() },
  handler: async (ctx, { workerKey, storageId }) => {
    assertWorkerKey(workerKey);
    await ctx.storage.delete(storageId);
  },
});

// Inserting the row and updating profiles.currentSnapshotId in one mutation
// is the atomic commit point (composed with the single-session lease).
// Latest-only: replaces all prior snapshot rows + blobs for this profile.
export const commit = mutation({
  args: {
    workerKey: v.string(),
    profileId: v.id("profiles"),
    sessionId: v.id("sessions"),
    storageId: v.string(),
    contentHash: v.string(),
    chromeVersion: v.string(),
    sizeBytes: v.number(),
  },
  handler: async (ctx, args) => {
    assertWorkerKey(args.workerKey);

    const existing = await ctx.db
      .query("profileSnapshots")
      .withIndex("by_profile", (q) => q.eq("profileId", args.profileId))
      .collect();
    for (const snap of existing) {
      await deleteSnapshotRow(ctx, snap._id, snap.storageId);
    }

    const snapshotId = await ctx.db.insert("profileSnapshots", {
      profileId: args.profileId,
      sessionId: args.sessionId,
      storageId: args.storageId,
      contentHash: args.contentHash,
      chromeVersion: args.chromeVersion,
      sizeBytes: args.sizeBytes,
    });
    await ctx.db.patch(args.profileId, { currentSnapshotId: snapshotId });
    return snapshotId;
  },
});

export const latestFor = query({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    return await ctx.db
      .query("profileSnapshots")
      .withIndex("by_profile", (q) => q.eq("profileId", profileId))
      .order("desc")
      .first();
  },
});

export const listFor = query({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    return await ctx.db
      .query("profileSnapshots")
      .withIndex("by_profile", (q) => q.eq("profileId", profileId))
      .order("desc")
      .collect();
  },
});

// Safety net: keep only profiles.currentSnapshotId per profile (latest-only policy).
export const applyRetention = internalMutation({
  args: {},
  handler: async (ctx) => {
    const profiles = await ctx.db.query("profiles").collect();
    let deletedRows = 0;

    for (const profile of profiles) {
      const snapshots = await ctx.db
        .query("profileSnapshots")
        .withIndex("by_profile", (q) => q.eq("profileId", profile._id))
        .collect();

      for (const snap of snapshots) {
        if (profile.currentSnapshotId === snap._id) continue;
        await deleteSnapshotRow(ctx, snap._id, snap.storageId);
        deletedRows++;
      }
    }

    return { deletedRows };
  },
});

/** Worker-triggered one-time / manual enforcement of latest-only retention. */
export const enforceLatestOnly = mutation({
  args: { workerKey: v.string() },
  handler: async (ctx, { workerKey }) => {
    assertWorkerKey(workerKey);
    const profiles = await ctx.db.query("profiles").collect();
    let deletedRows = 0;
    let bytesReclaimed = 0;

    for (const profile of profiles) {
      const snapshots = await ctx.db
        .query("profileSnapshots")
        .withIndex("by_profile", (q) => q.eq("profileId", profile._id))
        .collect();

      for (const snap of snapshots) {
        if (profile.currentSnapshotId === snap._id) continue;
        bytesReclaimed += snap.sizeBytes;
        await deleteSnapshotRow(ctx, snap._id, snap.storageId);
        deletedRows++;
      }
    }

    return { deletedRows, bytesReclaimed };
  },
});

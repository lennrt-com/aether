import { mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { assertWorkerKey } from "./lib/guards";

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

function isoWeekKey(ts: number): string {
  const d = new Date(ts);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${week}`;
}

// Daily retention: per profile keep the 5 newest snapshots + the newest per
// ISO-week for the last 8 weeks; delete other rows AND their storage objects.
export const applyRetention = internalMutation({
  args: {},
  handler: async (ctx) => {
    const profiles = await ctx.db.query("profiles").collect();
    const eightWeeksAgo = Date.now() - 56 * 24 * 60 * 60 * 1000;
    for (const profile of profiles) {
      const snapshots = await ctx.db
        .query("profileSnapshots")
        .withIndex("by_profile", (q) => q.eq("profileId", profile._id))
        .order("desc")
        .collect();
      const keep = new Set<string>();
      for (const snap of snapshots.slice(0, 5)) keep.add(snap._id);
      const newestPerWeek = new Map<string, string>();
      for (const snap of snapshots) {
        if (snap._creationTime < eightWeeksAgo) continue;
        const week = isoWeekKey(snap._creationTime);
        if (!newestPerWeek.has(week)) newestPerWeek.set(week, snap._id);
      }
      for (const id of newestPerWeek.values()) keep.add(id);
      if (profile.currentSnapshotId) keep.add(profile.currentSnapshotId);
      for (const snap of snapshots) {
        if (keep.has(snap._id)) continue;
        await ctx.storage.delete(snap.storageId);
        await ctx.db.delete(snap._id);
      }
    }
  },
});

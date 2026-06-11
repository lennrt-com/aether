import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v, type Infer } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { assertWorkerKey } from "./lib/guards";

// Closed taxonomy for v1 (Appendix B). Mirror of src/shared/types.ts.
const EVENT_TYPES = [
  "SessionStarted", "SessionEnded",
  "ActionPlanned", "ActionStarted", "ActionSucceeded", "ActionFailed",
  "PageObserved", "ChallengeDetected", "AnomalyObserved", "RestrictionDetected",
  "ProfileStateChanged", "ProfileProvisioned", "ProxyChanged",
  "FingerprintLoaded", "SnapshotCommitted",
  "PolicyDecision", "MessageReceived", "InvitationAccepted",
] as const;

const eventCtx = v.object({
  egressIp: v.optional(v.string()),
  launchConfigHash: v.optional(v.string()),
  personaVersion: v.optional(v.number()),
  strategyVersionId: v.optional(v.id("strategyVersions")),
  model: v.optional(v.string()),
  stagehandVersion: v.optional(v.string()),
});

export const envelopeArgs = {
  profileId: v.id("profiles"),
  sessionId: v.optional(v.id("sessions")),
  taskId: v.optional(v.id("tasks")),
  actionId: v.optional(v.string()),
  type: v.string(),
  ts: v.number(),
  channel: v.union(v.literal("browser"), v.literal("api"), v.literal("system")),
  data: v.any(),
  ctx: eventCtx,
  artifactRefs: v.optional(v.array(v.string())),
};

export interface EventEnvelope {
  profileId: Id<"profiles">;
  sessionId?: Id<"sessions">;
  taskId?: Id<"tasks">;
  actionId?: string;
  type: string;
  ts: number;
  channel: "browser" | "api" | "system";
  data: unknown;
  ctx: Infer<typeof eventCtx>;
  artifactRefs?: string[];
}

// THE single write path to `events`. Never insert into `events` anywhere else.
export async function appendEvent(
  ctx: MutationCtx,
  envelope: EventEnvelope,
): Promise<Id<"events">> {
  if (!(EVENT_TYPES as readonly string[]).includes(envelope.type)) {
    throw new Error(`unknown event type: ${envelope.type}`);
  }
  return await ctx.db.insert("events", envelope);
}

export const append = mutation({
  args: { workerKey: v.string(), ...envelopeArgs },
  handler: async (ctx, { workerKey, ...envelope }) => {
    assertWorkerKey(workerKey);
    return await appendEvent(ctx, envelope);
  },
});

export const forProfile = query({
  args: { profileId: v.id("profiles"), sinceTs: v.optional(v.number()) },
  handler: async (ctx, { profileId, sinceTs }) => {
    return await ctx.db
      .query("events")
      .withIndex("by_profile_ts", (q) =>
        sinceTs !== undefined
          ? q.eq("profileId", profileId).gte("ts", sinceTs)
          : q.eq("profileId", profileId),
      )
      .collect();
  },
});

export const forSession = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    return await ctx.db
      .query("events")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();
  },
});

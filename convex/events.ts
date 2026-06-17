import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v, type Infer } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { assertWorkerKey } from "./lib/guards";
import { evaluateCore, isSignalEvent } from "./health";

// Closed taxonomy for v1 (Appendix B). Mirror of src/shared/types.ts.
const EVENT_TYPES = [
  "SessionStarted", "SessionEnded",
  "ActionPlanned", "ActionStarted", "ActionSucceeded", "ActionFailed",
  "PageObserved", "ChallengeDetected", "AnomalyObserved", "RestrictionDetected",
  "ProfileStateChanged", "ProfileProvisioned", "ProxyChanged",
  "FingerprintLoaded", "SnapshotCommitted",
  "PolicyDecision", "MessageReceived", "InvitationAccepted",
  "AccountCreated", "LoginSucceeded",
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
    const id = await appendEvent(ctx, envelope);
    // Soft-signal events feed the health state machine in the same transaction.
    if (isSignalEvent(envelope.type)) {
      const data = (envelope.data ?? {}) as { source?: string };
      await evaluateCore(ctx, envelope.profileId, {
        restrictionDetected: envelope.type === "RestrictionDetected",
        restrictionSource:
          envelope.type === "RestrictionDetected"
            ? (data.source ?? "browser")
            : undefined,
      });
    }
    return id;
  },
});

// Unipile webhook → same event log, same envelope (one audit trail).
const WEBHOOK_TYPE_MAP: Record<string, string> = {
  "message.new": "MessageReceived",
  "relation.request.accept": "InvitationAccepted",
};

export const appendFromWebhook = internalMutation({
  args: { body: v.any() },
  handler: async (ctx, { body }) => {
    const payload = (body ?? {}) as Record<string, unknown>;
    const eventName = (payload.event ?? payload.type) as string | undefined;
    const accountId = (payload.account_id ?? payload.accountId) as string | undefined;

    const mappedType = eventName ? WEBHOOK_TYPE_MAP[eventName] : undefined;
    if (!mappedType) return { stored: false, reason: `unhandled event: ${eventName}` };
    if (!accountId) return { stored: false, reason: "missing account_id" };

    const profile = await ctx.db
      .query("profiles")
      .filter((q) => q.eq(q.field("unipileAccountId"), accountId))
      .first();
    if (!profile) return { stored: false, reason: `no profile for account ${accountId}` };

    const eventId = await appendEvent(ctx, {
      profileId: profile._id,
      type: mappedType,
      ts: Date.now(),
      channel: "api",
      data: payload,
      ctx: {},
    });
    return { stored: true, eventId };
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

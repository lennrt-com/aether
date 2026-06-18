// Mirrors of the Convex schema unions (Appendix A/B of executionplan.md).
// Convex functions cannot import from src/ — keep these in sync with convex/schema.ts.

export const PROFILE_STATUSES = [
  "provisioning",
  "warming",
  "active",
  "cooldown",
  "warning",
  "restricted",
  "recovering",
  "retired",
] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

export const TASK_STATUSES = [
  "pending",
  "claimed",
  "done",
  "failed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_TYPES = [
  "browse",
  "signup",
  "login",
  "complete_onboarding",
  "warmup_feed",
  "engage_post",
  "send_message",
  "send_invitation",
  "fetch_profile",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const CHANNELS = ["browser", "api", "system"] as const;
export type Channel = (typeof CHANNELS)[number];

// Closed list for v1 — adding a type requires editing this file AND executionplan.md.
export const EVENT_TYPES = [
  "SessionStarted",
  "SessionEnded",
  "ActionPlanned",
  "ActionStarted",
  "ActionSucceeded",
  "ActionFailed",
  "PageObserved",
  "ChallengeDetected",
  "AnomalyObserved",
  "RestrictionDetected",
  "ProfileStateChanged",
  "ProfileProvisioned",
  "ProxyChanged",
  "FingerprintLoaded",
  "SnapshotCommitted",
  "PolicyDecision",
  "MessageReceived",
  "InvitationAccepted",
  "AccountCreated",
  "LoginSucceeded",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const PAGE_STATES = [
  "normal",
  "login",
  "captcha",
  "checkpoint",
  "restriction_notice",
  "error_page",
  "unknown",
] as const;
export type PageState = (typeof PAGE_STATES)[number];

export interface EventCtx {
  egressIp?: string;
  launchConfigHash?: string;
  personaVersion?: number;
  strategyVersionId?: string;
  model?: string;
  stagehandVersion?: string;
}

export interface EventEnvelope {
  profileId: string;
  sessionId?: string;
  taskId?: string;
  actionId?: string;
  type: EventType;
  ts: number;
  channel: Channel;
  data: unknown;
  ctx: EventCtx;
  artifactRefs?: string[];
}

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const profileStatus = v.union(
  v.literal("provisioning"), v.literal("warming"), v.literal("active"),
  v.literal("cooldown"), v.literal("warning"), v.literal("restricted"),
  v.literal("recovering"), v.literal("retired"));

export const taskStatus = v.union(
  v.literal("pending"), v.literal("claimed"), v.literal("done"),
  v.literal("failed"), v.literal("cancelled"));

export default defineSchema({
  profiles: defineTable({
    name: v.string(),
    status: profileStatus,
    riskScore: v.number(),
    accountAgeDays: v.number(),            // for warmup curve; bump via daily cron
    personaId: v.optional(v.id("personas")),
    launchConfigId: v.optional(v.id("launchConfigs")),
    proxyBindingId: v.optional(v.id("proxyBindings")),
    currentSnapshotId: v.optional(v.id("profileSnapshots")),
    activeSessionId: v.optional(v.id("sessions")),
    hindsightBankId: v.optional(v.string()),
    unipileAccountId: v.optional(v.string()),   // added in Phase 8
    linkedInProfileUrl: v.optional(v.string()), // canonical /in/{slug} after signup
    cohortTag: v.string(),                       // "default" for v1
    chromeVersion: v.string(),
    maintained: v.optional(v.boolean()),           // false = not picked up by worker after reset
  }).index("by_status", ["status"]),

  proxyPool: defineTable({
    label: v.string(),
    server: v.string(),
    username: v.optional(v.string()),
    password: v.optional(v.string()),
    geo: v.string(),
    timezone: v.optional(v.string()),
    status: v.union(v.literal("active"), v.literal("disabled")),
    notes: v.optional(v.string()),
  }).index("by_status", ["status"]),

  personas: defineTable({
    profileId: v.id("profiles"),
    version: v.number(),
    data: v.any(),            // validated by zod (Appendix D) before insert
  }).index("by_profile", ["profileId"]),

  launchConfigs: defineTable({
    profileId: v.id("profiles"),
    version: v.number(),
    timezone: v.string(),
    locale: v.string(),
    windowWidth: v.number(),
    windowHeight: v.number(),
    chromeVersion: v.string(),
    fingerprintSeed: v.optional(v.string()),
    hardwareConcurrency: v.optional(v.number()),
    deviceMemory: v.optional(v.number()),
    hash: v.string(),         // sha256 of the above, stamped into event ctx
  }).index("by_profile", ["profileId"]),

  fingerprintObservations: defineTable({
    profileId: v.id("profiles"),
    visitorId: v.string(),
    eventId: v.string(),
    tampering: v.optional(v.boolean()),
    vpn: v.optional(v.boolean()),
    proxy: v.optional(v.boolean()),
    ts: v.number(),
  })
    .index("by_visitorId", ["visitorId"])
    .index("by_profile", ["profileId"]),

  proxyBindings: defineTable({
    profileId: v.id("profiles"),
    provider: v.literal("coronium"),
    server: v.string(),
    username: v.optional(v.string()),
    password: v.optional(v.string()),
    geo: v.string(),
    status: v.union(v.literal("active"), v.literal("unhealthy"), v.literal("retired")),
  }).index("by_profile", ["profileId"]),

  accountCredentials: defineTable({
    profileId: v.id("profiles"),
    email: v.string(),
    password: v.string(),
    emailProvider: v.string(),            // "smtp.dev" for v1
    mailboxId: v.optional(v.string()),    // smtp.dev account id (inbox re-derivable via API)
    status: v.union(v.literal("active"), v.literal("invalid")),
  }).index("by_profile", ["profileId"]),

  tasks: defineTable({
    profileId: v.id("profiles"),
    type: v.string(),
    payload: v.any(),
    status: taskStatus,
    priority: v.number(),
    dueAt: v.number(),
    claimedBy: v.optional(v.id("workers")),
    leaseExpiresAt: v.optional(v.number()),
    attempts: v.number(),
    lastError: v.optional(v.string()),
  }).index("by_status_dueAt", ["status", "dueAt"])
    .index("by_profile", ["profileId"]),

  sessions: defineTable({
    profileId: v.id("profiles"),
    // Optional: manual (hands-on) sessions have no task/worker behind them.
    taskId: v.optional(v.id("tasks")),
    workerId: v.optional(v.id("workers")),
    kind: v.optional(v.union(v.literal("task"), v.literal("manual"), v.literal("pipeline"))),
    channel: v.union(v.literal("browser"), v.literal("api")),
    status: v.union(v.literal("running"), v.literal("done"), v.literal("failed")),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    egressIp: v.optional(v.string()),
    launchConfigHash: v.optional(v.string()),
    strategyVersionId: v.optional(v.id("strategyVersions")),
    outcome: v.optional(v.string()),
  }).index("by_profile", ["profileId"]).index("by_task", ["taskId"]),

  events: defineTable({
    profileId: v.id("profiles"),
    sessionId: v.optional(v.id("sessions")),
    taskId: v.optional(v.id("tasks")),
    actionId: v.optional(v.string()),
    type: v.string(),                 // Appendix B taxonomy
    ts: v.number(),
    channel: v.union(v.literal("browser"), v.literal("api"), v.literal("system")),
    data: v.any(),
    ctx: v.object({
      egressIp: v.optional(v.string()),
      launchConfigHash: v.optional(v.string()),
      personaVersion: v.optional(v.number()),
      strategyVersionId: v.optional(v.id("strategyVersions")),
      model: v.optional(v.string()),
      stagehandVersion: v.optional(v.string()),
    }),
    artifactRefs: v.optional(v.array(v.string())),
  }).index("by_profile_ts", ["profileId", "ts"])
    .index("by_session", ["sessionId"])
    .index("by_type_ts", ["type", "ts"]),

  profileSnapshots: defineTable({
    profileId: v.id("profiles"),
    sessionId: v.id("sessions"),
    storageId: v.string(),
    contentHash: v.string(),
    chromeVersion: v.string(),
    sizeBytes: v.number(),
  }).index("by_profile", ["profileId"]),

  incidents: defineTable({
    profileId: v.id("profiles"),
    triggerEventId: v.id("events"),
    status: v.union(v.literal("open"), v.literal("dossier_retained"), v.literal("closed")),
    strategyVersionId: v.optional(v.id("strategyVersions")),
    dossier: v.any(),
  }).index("by_profile", ["profileId"]).index("by_status", ["status"]),

  strategyVersions: defineTable({
    version: v.number(),
    cohortTag: v.string(),
    status: v.union(v.literal("draft"), v.literal("active"), v.literal("retired")),
    params: v.any(),          // Appendix E, zod-validated before insert
    basedOnIncidentIds: v.optional(v.array(v.id("incidents"))),
    notes: v.optional(v.string()),
    approvedBy: v.optional(v.string()),
  }).index("by_cohort_status", ["cohortTag", "status"]),

  workers: defineTable({
    name: v.string(),
    status: v.union(v.literal("online"), v.literal("offline")),
    lastHeartbeatAt: v.number(),
    maxSessions: v.number(),
  }),
});

import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/** Aether browser identity lifecycle — no LinkedIn fleet phases. */
export const profileStatus = v.union(
  v.literal("provisioning"),
  v.literal("active"),
  v.literal("disabled"),
);

export const taskStatus = v.union(
  v.literal("pending"),
  v.literal("claimed"),
  v.literal("done"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export default defineSchema({
  ...authTables,

  /** Durable browser identity slot (sticky fingerprint + proxy + snapshot). */
  profiles: defineTable({
    name: v.string(),
    status: profileStatus,
    riskScore: v.number(),
    personaId: v.optional(v.id("personas")),
    launchConfigId: v.optional(v.id("launchConfigs")),
    proxyBindingId: v.optional(v.id("proxyBindings")),
    currentSnapshotId: v.optional(v.id("profileSnapshots")),
    activeSessionId: v.optional(v.id("sessions")),
    chromeVersion: v.string(),
    /** API-created disposable slot for one-off agent jobs. */
    ephemeral: v.optional(v.boolean()),
    /** false = worker will not claim tasks for this profile. */
    maintained: v.optional(v.boolean()),
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
    data: v.any(),
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
    hash: v.string(),
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
    provider: v.string(),
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
    emailProvider: v.string(),
    mailboxId: v.optional(v.string()),
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
    result: v.optional(v.any()),
    webhookDelivery: v.optional(
      v.object({
        status: v.union(
          v.literal("pending"),
          v.literal("delivered"),
          v.literal("retrying"),
          v.literal("failed"),
        ),
        attempt: v.number(),
        lastError: v.optional(v.string()),
        deliveredAt: v.optional(v.number()),
      }),
    ),
  })
    .index("by_status_dueAt", ["status", "dueAt"])
    .index("by_profile", ["profileId"]),

  sessions: defineTable({
    profileId: v.id("profiles"),
    taskId: v.optional(v.id("tasks")),
    workerId: v.optional(v.id("workers")),
    kind: v.optional(v.union(v.literal("task"), v.literal("manual"), v.literal("pipeline"))),
    channel: v.union(v.literal("browser"), v.literal("api")),
    status: v.union(v.literal("running"), v.literal("done"), v.literal("failed")),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    egressIp: v.optional(v.string()),
    launchConfigHash: v.optional(v.string()),
    outcome: v.optional(v.string()),
  })
    .index("by_profile", ["profileId"])
    .index("by_task", ["taskId"]),

  events: defineTable({
    profileId: v.id("profiles"),
    sessionId: v.optional(v.id("sessions")),
    taskId: v.optional(v.id("tasks")),
    actionId: v.optional(v.string()),
    type: v.string(),
    ts: v.number(),
    channel: v.union(v.literal("browser"), v.literal("api"), v.literal("system")),
    data: v.any(),
    ctx: v.object({
      egressIp: v.optional(v.string()),
      launchConfigHash: v.optional(v.string()),
      personaVersion: v.optional(v.number()),
      model: v.optional(v.string()),
      stagehandVersion: v.optional(v.string()),
    }),
    artifactRefs: v.optional(v.array(v.string())),
  })
    .index("by_profile_ts", ["profileId", "ts"])
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

  workers: defineTable({
    name: v.string(),
    status: v.union(v.literal("online"), v.literal("offline")),
    lastHeartbeatAt: v.number(),
    maxSessions: v.number(),
  }),

  agentInstructions: defineTable({
    key: v.string(),
    template: v.string(),
    updatedAt: v.number(),
    notes: v.optional(v.string()),
  }).index("by_key", ["key"]),

  /** Named MCP server connections (no secrets — worker injects env at runtime). */
  mcpConnections: defineTable({
    name: v.string(),
    transport: v.union(v.literal("stdio"), v.literal("http")),
    command: v.optional(v.string()),
    args: v.optional(v.array(v.string())),
    envFromWorker: v.optional(v.array(v.string())),
    url: v.optional(v.string()),
    headersFromWorker: v.optional(
      v.array(
        v.object({
          header: v.string(),
          envVar: v.string(),
        }),
      ),
    ),
    enabled: v.boolean(),
    notes: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_name", ["name"]),
});

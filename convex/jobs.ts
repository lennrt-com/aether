import { internalMutation, internalQuery, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { createEphemeralProfile } from "./lib/ephemeralProfile";
import { workerKeyFromEnv } from "./lib/apiAuth";
import { requireUser } from "./lib/auth";
import { assertWorkerKey } from "./lib/guards";

const agentPayloadValidator = v.object({
  startUrl: v.string(),
  instructions: v.string(),
  model: v.optional(v.string()),
  proxy: v.optional(
    v.object({
      server: v.string(),
      username: v.optional(v.string()),
      password: v.optional(v.string()),
    }),
  ),
  login: v.optional(
    v.object({
      username: v.string(),
      password: v.string(),
    }),
  ),
  secretRefs: v.optional(v.record(v.string(), v.string())),
  mcpServers: v.optional(v.array(v.string())),
  maxSteps: v.optional(v.number()),
  tools: v.optional(v.array(v.union(v.literal("captcha"), v.literal("email"), v.literal("phone")))),
  webhookUrl: v.string(),
  webhookSecret: v.optional(v.string()),
  preferredWorkerName: v.optional(v.string()),
  metadata: v.optional(v.any()),
});

function validateAgentPayload(payload: {
  startUrl: string;
  instructions: string;
  webhookUrl: string;
}): void {
  if (!payload.startUrl.trim()) throw new Error("startUrl is required");
  if (!payload.instructions.trim()) throw new Error("instructions is required");
  if (!payload.webhookUrl.trim()) throw new Error("webhookUrl is required");
  try {
    new URL(payload.webhookUrl);
  } catch {
    throw new Error("webhookUrl must be a valid URL");
  }
}

export const create = internalMutation({
  args: { payload: agentPayloadValidator },
  handler: async (ctx, { payload }) => {
    validateAgentPayload(payload);
    const preferredWorkerName = payload.preferredWorkerName?.trim() || undefined;
    const workerKey = workerKeyFromEnv();
    const stamp = Date.now();
    const profileId = await createEphemeralProfile(ctx, {
      name: `job-${stamp}`,
      geo: process.env.DEFAULT_GEO ?? "US",
      timezone: process.env.DEFAULT_TZ ?? "UTC",
      proxy: payload.proxy,
    });

    const taskPayload = {
      ...payload,
      preferredWorkerName,
      model: payload.model?.trim() || "gemini-3-flash-preview",
    };

    const taskId = await ctx.db.insert("tasks", {
      profileId,
      type: "agent",
      payload: taskPayload,
      status: "pending",
      priority: 0,
      dueAt: Date.now(),
      attempts: 0,
    });

    return { id: taskId, profileId, status: "pending" as const };
  },
});

export const getPublic = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task || task.type !== "agent") return null;

    const payload = (task.payload ?? {}) as Record<string, unknown>;
    const result = task.result as Record<string, unknown> | undefined;
    const webhook = task.webhookDelivery;

    return {
      id: task._id,
      status: task.status,
      createdAt: task._creationTime,
      startUrl: payload.startUrl ?? null,
      instructions: payload.instructions ?? null,
      model: payload.model ?? null,
      preferredWorkerName: payload.preferredWorkerName ?? null,
      metadata: payload.metadata ?? null,
      mcpServers: payload.mcpServers ?? null,
      result: result ?? null,
      error: task.lastError ?? null,
      webhookDelivery: webhook ?? null,
    };
  },
});

export const getInternal = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    return await ctx.db.get(taskId);
  },
});

export const listRecent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    await requireUser(ctx);
    return await listAgentJobs(ctx, limit ?? 50);
  },
});

export const listRecentWorker = query({
  args: { workerKey: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { workerKey, limit }) => {
    assertWorkerKey(workerKey);
    return await listAgentJobs(ctx, limit ?? 50);
  },
});

async function listAgentJobs(ctx: QueryCtx, limit: number) {
  const rows = await ctx.db.query("tasks").collect();
  return rows
    .filter((t) => t.type === "agent")
    .sort((a, b) => b._creationTime - a._creationTime)
    .slice(0, limit)
    .map((task) => {
      const payload = (task.payload ?? {}) as Record<string, unknown>;
      return {
        id: task._id,
        status: task.status,
        startUrl: payload.startUrl ?? null,
        model: payload.model ?? null,
        createdAt: task._creationTime,
        error: task.lastError ?? null,
        webhookStatus: task.webhookDelivery?.status ?? null,
      };
    });
}

export const cancel = internalMutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task) throw new Error(`job not found: ${taskId}`);
    if (task.type !== "agent") throw new Error("only agent jobs can be cancelled via API");
    if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
      throw new Error(`cannot cancel ${task.status} job`);
    }

    if (task.status === "pending") {
      await ctx.db.patch(taskId, { status: "cancelled" });
      await ctx.scheduler.runAfter(0, internal.webhooks.deliver, { taskId, attempt: 1 });
      return { id: taskId, status: "cancelled" as const };
    }

    throw new Error("claimed jobs cannot be cancelled yet");
  },
});

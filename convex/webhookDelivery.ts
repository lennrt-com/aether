import { internalMutation, mutation } from "./_generated/server";
import { v } from "convex/values";
import { assertWorkerKey } from "./lib/guards";

export const recordDelivery = internalMutation({
  args: {
    taskId: v.id("tasks"),
    status: v.union(
      v.literal("pending"),
      v.literal("delivered"),
      v.literal("retrying"),
      v.literal("failed"),
    ),
    attempt: v.number(),
    lastError: v.optional(v.string()),
  },
  handler: async (ctx, { taskId, status, attempt, lastError }) => {
    await ctx.db.patch(taskId, {
      webhookDelivery: {
        status,
        attempt,
        lastError,
        deliveredAt: status === "delivered" ? Date.now() : undefined,
      },
    });
  },
});

export const recordFromWorker = mutation({
  args: {
    workerKey: v.string(),
    taskId: v.id("tasks"),
    status: v.union(
      v.literal("pending"),
      v.literal("delivered"),
      v.literal("retrying"),
      v.literal("failed"),
    ),
    attempt: v.number(),
    lastError: v.optional(v.string()),
  },
  handler: async (ctx, { workerKey, taskId, status, attempt, lastError }) => {
    assertWorkerKey(workerKey);
    await ctx.db.patch(taskId, {
      webhookDelivery: {
        status,
        attempt,
        lastError,
        deliveredAt: status === "delivered" ? Date.now() : undefined,
      },
    });
  },
});

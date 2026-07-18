"use node";

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { createHmac } from "crypto";

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [0, 15_000, 60_000];

type AgentPayload = {
  webhookUrl?: string;
  webhookSecret?: string;
  metadata?: Record<string, unknown>;
};

type AgentResult = {
  success?: boolean;
  summary?: string;
  steps?: number;
  finalUrl?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
  artifacts?: Array<{
    name: string;
    contentType: string;
    sizeBytes: number;
    storageId: string;
    url: string;
  }>;
};

function signingSecret(payload: AgentPayload): string {
  return payload.webhookSecret ?? process.env.AETHER_WEBHOOK_SECRET ?? process.env.WORKER_KEY ?? "aether";
}

export const deliver = internalAction({
  args: {
    taskId: v.id("tasks"),
    attempt: v.number(),
  },
  handler: async (ctx, { taskId, attempt }) => {
    const task = await ctx.runQuery(internal.jobs.getInternal, { taskId });
    if (!task || task.type !== "agent") return;

    const payload = (task.payload ?? {}) as AgentPayload;
    const webhookUrl = payload.webhookUrl;
    if (!webhookUrl) return;

    // Worker delivers n8n test webhooks locally; skip cloud delivery.
    if (webhookUrl.includes("/webhook-test/")) return;

    if (task.webhookDelivery?.status === "delivered") return;

    const terminal = ["done", "failed", "cancelled"].includes(task.status);
    if (!terminal) return;

    const result = (task.result ?? {}) as AgentResult;
    const body = JSON.stringify({
      jobId: taskId,
      status: task.status,
      summary: result.summary ?? null,
      steps: result.steps ?? null,
      finalUrl: result.finalUrl ?? null,
      error: task.lastError ?? result.error ?? null,
      metadata: payload.metadata ?? result.metadata ?? null,
      artifacts: result.artifacts ?? [],
    });

    const signature = createHmac("sha256", signingSecret(payload)).update(body).digest("hex");

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Aether-Signature": `sha256=${signature}`,
        },
        body,
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new Error(
          `webhook returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
        );
      }

      await ctx.runMutation(internal.webhookDelivery.recordDelivery, {
        taskId,
        status: "delivered",
        attempt,
      });
    } catch (err) {
      const message = String(err);
      if (attempt < MAX_ATTEMPTS) {
        await ctx.runMutation(internal.webhookDelivery.recordDelivery, {
          taskId,
          status: "retrying",
          attempt,
          lastError: message,
        });
        const delay = BACKOFF_MS[attempt] ?? 60_000;
        await ctx.scheduler.runAfter(delay, internal.webhooks.deliver, {
          taskId,
          attempt: attempt + 1,
        });
      } else {
        await ctx.runMutation(internal.webhookDelivery.recordDelivery, {
          taskId,
          status: "failed",
          attempt,
          lastError: message,
        });
      }
    }
  },
});

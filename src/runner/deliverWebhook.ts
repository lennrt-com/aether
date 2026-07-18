import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel.js";
import type { AgentJobPayload, AgentJobResult } from "../shared/agentPayload.js";
import {
  buildAgentWebhookPayload,
  isN8nTestWebhookUrl,
  postAgentWebhook,
  webhookSigningSecret,
  type AgentWebhookStatus,
} from "../shared/agentWebhook.js";

export async function deliverAgentWebhookFromWorker(opts: {
  convex: ConvexHttpClient;
  workerKey: string;
  taskId: Id<"tasks">;
  payload: AgentJobPayload;
  status: AgentWebhookStatus;
  result?: AgentJobResult | null;
  lastError?: string | null;
}): Promise<void> {
  const { webhookUrl, webhookSecret } = opts.payload;
  if (!webhookUrl || !isN8nTestWebhookUrl(webhookUrl)) return;

  const body = buildAgentWebhookPayload({
    jobId: opts.taskId,
    status: opts.status,
    result: opts.result,
    lastError: opts.lastError,
    metadata: opts.payload.metadata ?? null,
  });

  const signingSecret = webhookSigningSecret({
    webhookSecret,
    envSecret: process.env.AETHER_WEBHOOK_SECRET,
    workerKey: opts.workerKey,
  });

  const outcome = await postAgentWebhook({
    webhookUrl,
    body,
    signingSecret,
  });

  if (outcome.ok) {
    console.log(`[webhook] delivered to n8n test URL (${opts.taskId})`);
    await opts.convex.mutation(api.webhookDelivery.recordFromWorker, {
      workerKey: opts.workerKey,
      taskId: opts.taskId,
      status: "delivered",
      attempt: 1,
    });
    return;
  }

  console.error(`[webhook] test URL delivery failed: ${outcome.error}`);
  await opts.convex.mutation(api.webhookDelivery.recordFromWorker, {
    workerKey: opts.workerKey,
    taskId: opts.taskId,
    status: "failed",
    attempt: 1,
    lastError: outcome.error,
  });
}

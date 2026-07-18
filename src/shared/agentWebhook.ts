import type { AgentArtifact, AgentJobResult } from "./agentPayload.js";
import { createHmac } from "node:crypto";

export type AgentWebhookStatus = "done" | "failed" | "cancelled";

export interface AgentWebhookPayload {
  jobId: string;
  status: AgentWebhookStatus;
  summary: string | null;
  steps: number | null;
  finalUrl: string | null;
  error: string | null;
  metadata: Record<string, unknown> | null;
  artifacts: AgentArtifact[];
}

/** n8n test URLs only accept one request while the editor is listening — deliver from the worker. */
export function isN8nTestWebhookUrl(url: string): boolean {
  try {
    return new URL(url).pathname.includes("/webhook-test/");
  } catch {
    return url.includes("/webhook-test/");
  }
}

export function webhookSigningSecret(opts: {
  webhookSecret?: string;
  envSecret?: string;
  workerKey?: string;
}): string {
  return opts.webhookSecret ?? opts.envSecret ?? opts.workerKey ?? "aether";
}

export function buildAgentWebhookPayload(opts: {
  jobId: string;
  status: AgentWebhookStatus;
  result?: AgentJobResult | null;
  lastError?: string | null;
  metadata?: Record<string, unknown> | null;
}): AgentWebhookPayload {
  const result = opts.result;
  return {
    jobId: opts.jobId,
    status: opts.status,
    summary: result?.summary ?? null,
    steps: result?.steps ?? null,
    finalUrl: result?.finalUrl ?? null,
    error: opts.lastError ?? result?.error ?? null,
    metadata: opts.metadata ?? result?.metadata ?? null,
    artifacts: result?.artifacts ?? [],
  };
}

export function signAgentWebhookBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export async function postAgentWebhook(opts: {
  webhookUrl: string;
  body: AgentWebhookPayload;
  webhookSecret?: string;
  signingSecret?: string;
}): Promise<{ ok: true } | { ok: false; status?: number; error: string }> {
  const json = JSON.stringify(opts.body);
  const secret = opts.signingSecret ?? webhookSigningSecret({ webhookSecret: opts.webhookSecret });
  const signature = signAgentWebhookBody(json, secret);

  try {
    const response = await fetch(opts.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Aether-Signature": `sha256=${signature}`,
      },
      body: json,
    });

    if (!response.ok) {
      const text = (await response.text()).slice(0, 300);
      return {
        ok: false,
        status: response.status,
        error: `webhook returned HTTP ${response.status}${text ? `: ${text}` : ""}`,
      };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

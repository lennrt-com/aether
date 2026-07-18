// Generic Aether agent run: arbitrary start URL + instructions with configurable tools.
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import type { Stagehand } from "@browserbasehq/stagehand";
import { tool, type AgentConfig } from "@browserbasehq/stagehand";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import type { Emit } from "./emit.js";
import { buildCaptchaTools } from "./captchaTools.js";
import { buildEmailTools } from "./emailTools.js";
import { buildPhoneTools } from "./phoneTools.js";
import { classifyPage } from "./classify.js";
import { createAgent } from "./agentDefaults.js";
import {
  type AgentJobPayload,
  type AgentJobResult,
  type AgentToolName,
  DEFAULT_AGENT_TOOLS,
} from "../shared/agentPayload.js";
import { redactSecrets } from "../shared/redactSecrets.js";
import { evalInPage } from "./cdpEval.js";
import { resolveSecretRefs } from "./secrets/bitwarden.js";
import { loadMcpTools, type McpConnectionConfig } from "./mcp/client.js";
import { DownloadCollector, uploadArtifacts } from "./artifacts.js";

const DEFAULT_AGENT_MAX_STEPS = 50;

export interface RunAgentDeps {
  stagehand: Stagehand;
  emit: Emit;
  payload: AgentJobPayload;
  convex: ConvexHttpClient;
  workerKey: string;
  downloadDir?: string;
}

async function emitAgentSteps(
  emit: Emit,
  actions: Array<Record<string, unknown>>,
  actionId: string,
): Promise<void> {
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    await emit(
      "ActionSucceeded",
      {
        step: i + 1,
        actionType: action.type,
        reasoning: typeof action.reasoning === "string" ? action.reasoning.slice(0, 500) : undefined,
        pageUrl: action.pageUrl,
        timeMs: action.timeMs,
      },
      `${actionId}:step:${i + 1}`,
    );
  }
}

function buildInstruction(payload: AgentJobPayload, hasCredentials: boolean): string {
  const parts: string[] = [];
  if (hasCredentials) {
    parts.push(
      "If the site requires login, use the provided credentials (username/email and password). " +
        "Do not invent credentials. If a TOTP variable is provided, use it for 2FA prompts.",
    );
  }
  if (payload.mcpServers && payload.mcpServers.length > 0) {
    parts.push(
      "External MCP tools are available (prefixed mcp_). Use them for email OTP, vault lookups, or other side tasks when needed.",
    );
  }
  parts.push(payload.instructions);
  return parts.join("\n\n");
}

async function buildAgentTools(
  stagehand: Stagehand,
  emit: Emit,
  actionId: string,
  toolNames: AgentToolName[],
  proxy: RunAgentDeps["payload"]["proxy"],
  personaName: string,
  payload: AgentJobPayload,
  convex: ConvexHttpClient,
  workerKey: string,
  downloadCollector: DownloadCollector,
) {
  const enabled = new Set(toolNames.length > 0 ? toolNames : DEFAULT_AGENT_TOOLS);
  const tools: Record<string, unknown> = {};
  let toolCall = 0;

  const audit = async (toolName: string, data: Record<string, unknown>, ok: boolean) => {
    toolCall += 1;
    await emit(
      ok ? "ActionSucceeded" : "ActionFailed",
      { tool: toolName, ...(redactSecrets(data) as Record<string, unknown>) },
      `${actionId}:tool:${toolCall}`,
    );
  };

  if (enabled.has("captcha")) {
    Object.assign(
      tools,
      buildCaptchaTools({
        getPage: () => stagehand.context.activePage(),
        getProxy: () => proxy ?? null,
        audit,
      }),
    );
  }

  if (enabled.has("email")) {
    Object.assign(
      tools,
      buildEmailTools({
        localPartBase: personaName.replace(/\s+/g, "").slice(0, 12) || "user",
        accountPassword: randomUUID().slice(0, 16),
        audit,
      }).tools,
    );
  }

  if (enabled.has("phone")) {
    Object.assign(
      tools,
      buildPhoneTools({
        geo: process.env.DEFAULT_GEO ?? "US",
        audit,
      }).tools,
    );
  }

  tools.list_downloads = tool({
    description: "List files downloaded during this browser session.",
    inputSchema: z.object({}),
    execute: async () => {
      await downloadCollector.waitForDownloads(5_000);
      const files = downloadCollector.newFiles().map((filePath) => ({
        name: path.basename(filePath),
        sizeBytes: fs.statSync(filePath).size,
      }));
      await audit("list_downloads", { count: files.length }, true);
      return { files };
    },
  });

  if (payload.mcpServers && payload.mcpServers.length > 0) {
    const connections = (await convex.query(api.mcpConnections.listWorker, {
      workerKey,
      names: payload.mcpServers,
    })) as McpConnectionConfig[];

    const missing = payload.mcpServers.filter(
      (name) => !connections.some((c) => c.name === name),
    );
    if (missing.length > 0) {
      throw new Error(`unknown or disabled MCP connections: ${missing.join(", ")}`);
    }

    const { tools: mcpTools, bridge } = await loadMcpTools({ connections, audit });
    Object.assign(tools, mcpTools);
    (tools as Record<string, unknown>).__mcpBridge = bridge;
  }

  return tools;
}

export async function runAgent(deps: RunAgentDeps): Promise<AgentJobResult> {
  const { stagehand, emit, payload, convex, workerKey } = deps;
  const actionId = randomUUID();
  const maxSteps = payload.maxSteps ?? DEFAULT_AGENT_MAX_STEPS;
  const proxy = payload.proxy;

  const downloadBase = deps.downloadDir ?? path.join(process.cwd(), ".aether-downloads", actionId);
  const downloadCollector = new DownloadCollector(downloadBase);

  let resolvedVars: Record<string, string> = {};
  if (payload.secretRefs) {
    resolvedVars = await resolveSecretRefs(payload.secretRefs);
  } else if (payload.login) {
    resolvedVars = {
      username: payload.login.username,
      email: payload.login.username,
      password: payload.login.password,
    };
  }

  const personaName = resolvedVars.username?.split("@")[0] ?? "agent";

  const agentTools = await buildAgentTools(
    stagehand,
    emit,
    actionId,
    payload.tools ?? DEFAULT_AGENT_TOOLS,
    proxy,
    personaName,
    payload,
    convex,
    workerKey,
    downloadCollector,
  );

  const mcpBridge = (agentTools as Record<string, unknown>).__mcpBridge as
    | { close: () => Promise<void> }
    | undefined;
  delete (agentTools as Record<string, unknown>).__mcpBridge;

  try {
    await emit(
      "ActionStarted",
      {
        taskType: "agent",
        startUrl: payload.startUrl,
        maxSteps,
        tools: payload.tools ?? DEFAULT_AGENT_TOOLS,
        mcpServers: payload.mcpServers ?? [],
        hasSecretRefs: Boolean(payload.secretRefs),
      },
      actionId,
    );

    const page = stagehand.context.activePage();
    if (!page) throw new Error("no active page after launch");

    await downloadCollector.configure(page).catch(() => {});

    await page
      .goto(payload.startUrl, { waitUntil: "domcontentloaded", timeoutMs: 30_000 })
      .catch(() => {});
    await classifyPage(stagehand, emit, actionId);

    const variables: Record<string, string> = { ...resolvedVars };

    const agent = createAgent(stagehand, {
      mode: "hybrid",
      tools: agentTools as NonNullable<AgentConfig["tools"]>,
    });
    const result = await agent.execute({
      instruction: buildInstruction(payload, Object.keys(variables).length > 0),
      maxSteps,
      variables: Object.keys(variables).length > 0 ? variables : undefined,
      output: z.object({
        success: z.boolean().describe("Whether the requested task was completed"),
        summary: z
          .string()
          .describe("Short summary of what was done, including any extracted info or blockers"),
      }),
    });

    await emitAgentSteps(emit, result.actions, actionId);
    await classifyPage(stagehand, emit, actionId);

    let finalUrl: string | null = null;
    try {
      finalUrl = await evalInPage<string>(page, "window.location.href");
    } catch {
      finalUrl = null;
    }

    await downloadCollector.waitForDownloads();
    const downloadedFiles = downloadCollector.newFiles();
    const artifacts = await uploadArtifacts({ convex, workerKey, files: downloadedFiles });

    const output = (result.output ?? {}) as { success?: boolean; summary?: string };
    const summary = output.summary?.trim() || result.message || "";
    const success = result.success && output.success !== false;

    const agentResult: AgentJobResult = {
      success,
      summary,
      steps: result.actions.length,
      finalUrl,
      error: success ? null : summary || result.message || "agent run failed",
      metadata: payload.metadata,
      artifacts: artifacts.length > 0 ? artifacts : undefined,
    };

    await emit(
      success ? "ActionSucceeded" : "ActionFailed",
      redactSecrets({
        taskType: "agent",
        message: result.message,
        ...agentResult,
        output: result.output ?? null,
        artifactCount: artifacts.length,
      }) as Record<string, unknown>,
      actionId,
    );

    return agentResult;
  } finally {
    if (mcpBridge) await mcpBridge.close();
  }
}

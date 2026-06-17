// Free-form experiment run: turns a Stagehand agent loose on the page and lets
// it act on an arbitrary user prompt. Unlike runSignup, this attaches no
// LinkedIn-specific behavior (no email/persona/credentials) — just the captcha
// tools so the agent can clear challenges on any site, then it executes the
// prompt and reports a summary. Shares the exact launch design as account
// creation (see sessionFlow.runExperimentSession).
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Stagehand } from "@browserbasehq/stagehand";
import type { Emit } from "./emit.js";
import { buildCaptchaTools } from "./captchaTools.js";
import { classifyPage } from "./classify.js";

const DEFAULT_EXPERIMENT_MAX_STEPS = 50;

export interface ExperimentDeps {
  stagehand: Stagehand;
  emit: Emit;
  /** Free-form instruction the agent should act on. */
  prompt: string;
  maxSteps?: number;
  /** Optional URL to open before the agent starts. */
  startUrl?: string;
  proxy?: { server: string; username?: string; password?: string };
}

export interface ExperimentResult {
  success: boolean;
  summary: string;
  steps: number;
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

export async function runExperiment(deps: ExperimentDeps): Promise<ExperimentResult> {
  const { stagehand, emit, prompt, proxy } = deps;
  const actionId = randomUUID();
  const maxSteps = deps.maxSteps ?? DEFAULT_EXPERIMENT_MAX_STEPS;

  let captchaCall = 0;
  const captchaTools = buildCaptchaTools({
    getPage: () => stagehand.context.activePage(),
    getProxy: () => proxy ?? null,
    audit: async (toolName, data, ok) => {
      captchaCall += 1;
      await emit(
        ok ? "ActionSucceeded" : "ActionFailed",
        { tool: toolName, ...data },
        `${actionId}:captcha:${captchaCall}`,
      );
    },
  });

  await emit(
    "ActionStarted",
    { taskType: "experiment", prompt, url: deps.startUrl ?? null, maxSteps },
    actionId,
  );

  const page = stagehand.context.activePage();
  if (!page) throw new Error("no active page after launch");
  if (deps.startUrl) {
    await page
      .goto(deps.startUrl, { waitUntil: "domcontentloaded", timeoutMs: 30_000 })
      .catch(() => {});
  }
  await classifyPage(stagehand, emit, actionId);

  const agent = stagehand.agent({ mode: "hybrid", tools: captchaTools });
  const result = await agent.execute({
    instruction: prompt,
    maxSteps,
    output: z.object({
      success: z.boolean().describe("Whether the requested task was completed"),
      summary: z
        .string()
        .describe("Short summary of what was done, including any extracted info or blockers"),
    }),
  });

  await emitAgentSteps(emit, result.actions, actionId);
  await classifyPage(stagehand, emit, actionId);

  const output = (result.output ?? {}) as { success?: boolean; summary?: string };
  const summary = output.summary?.trim() || result.message || "";
  const success = result.success && output.success !== false;

  await emit(
    success ? "ActionSucceeded" : "ActionFailed",
    {
      taskType: "experiment",
      message: result.message,
      summary,
      steps: result.actions.length,
      output: result.output ?? null,
    },
    actionId,
  );

  return { success, summary, steps: result.actions.length };
}

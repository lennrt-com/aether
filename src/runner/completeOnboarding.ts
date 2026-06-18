// Rescue flow for profiles stuck in provisioning: verify email via smtp.dev link,
// capture profile URL, promote to warming, or mark restricted on hard failures.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import type { PageState } from "../shared/types.js";
import { classifyPage } from "./classify.js";
import { buildCaptchaTools } from "./captchaTools.js";
import { buildEmailTools } from "./emailTools.js";
import { buildCompleteOnboardingInstruction, FEED_URL } from "./behaviors.js";
import { loadAgentInstructions } from "./loadAgentInstructions.js";
import {
  captureLinkedInProfileUrl,
  runLogin,
  type AccountFlowDeps,
} from "./signup.js";

const COMPLETE_ONBOARDING_MAX_STEPS = 500;

async function restrictProfile(
  deps: AccountFlowDeps,
  source: string,
  reason: string,
): Promise<void> {
  const { convex, workerKey, profile } = deps;
  await convex.mutation(api.profiles.restrictProfile, {
    workerKey,
    profileId: profile._id,
    source,
    reason,
  });
}

async function handlePageState(
  deps: AccountFlowDeps,
  pageState: PageState,
  actionId: string,
  phase: string,
): Promise<"ok" | "restricted" | "login"> {
  const { emit } = deps;
  if (pageState === "restriction_notice") {
    await restrictProfile(deps, "browser_rescue", `${phase}: restriction_notice`);
    return "restricted";
  }
  if (pageState === "login") {
    await emit("AnomalyObserved", { phase, reason: "login_wall" }, actionId);
    return "login";
  }
  return "ok";
}

export async function runCompleteOnboarding(deps: AccountFlowDeps): Promise<boolean> {
  const { stagehand, convex, workerKey, emit, profile, proxy } = deps;
  const actionId = randomUUID();

  if (profile.status !== "provisioning") {
    await emit(
      "ActionFailed",
      { error: `profile must be in provisioning, got ${profile.status}` },
      actionId,
    );
    return false;
  }

  const page = stagehand.context.activePage();
  if (!page) throw new Error("no active page after launch");

  await emit("ActionStarted", { taskType: "complete_onboarding", url: FEED_URL }, actionId);
  await page.goto(FEED_URL, { waitUntil: "load" });

  let pageState = await classifyPage(stagehand, emit, actionId);
  let outcome = await handlePageState(deps, pageState, actionId, "initial");
  if (outcome === "restricted") return false;

  if (outcome === "login") {
    const creds = await convex.query(api.credentials.getFor, {
      workerKey,
      profileId: profile._id,
    });
    if (!creds) {
      await restrictProfile(deps, "no_credentials", "login wall with no stored credentials");
      return false;
    }
    const loginOk = await runLogin(deps, { transition: false });
    if (!loginOk) {
      await restrictProfile(deps, "login_failed", "login agent failed during onboarding rescue");
      return false;
    }
    await page.goto(FEED_URL, { waitUntil: "load" });
    pageState = await classifyPage(stagehand, emit, actionId);
    outcome = await handlePageState(deps, pageState, actionId, "post_login");
    if (outcome === "restricted") return false;
    if (outcome === "login") {
      await emit("ActionFailed", { error: "still on login wall after login attempt" }, actionId);
      return false;
    }
  }

  const creds = await convex.query(api.credentials.getFor, {
    workerKey,
    profileId: profile._id,
  });
  const templates = await loadAgentInstructions(convex, workerKey);

  let emailCall = 0;
  let captchaCall = 0;
  const canReadEmail = creds?.emailProvider === "smtp.dev" && creds.mailboxId;
  const { tools: emailTools } = buildEmailTools({
    localPartBase: "rescue",
    accountPassword: creds?.password ?? "",
    existing: canReadEmail
      ? { address: creds!.email, smtpDevAccountId: creds!.mailboxId! }
      : undefined,
    audit: async (toolName, data, ok) => {
      emailCall += 1;
      await emit(
        ok ? "ActionSucceeded" : "ActionFailed",
        { tool: toolName, ...data },
        `${actionId}:email:${emailCall}`,
      );
    },
  });
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
  const tools = { ...emailTools, ...captchaTools };

  const agent = stagehand.agent({ mode: "hybrid", tools });
  const result = await agent.execute({
    instruction: buildCompleteOnboardingInstruction(templates),
    maxSteps: deps.maxSteps ?? COMPLETE_ONBOARDING_MAX_STEPS,
    output: z.object({
      success: z
        .boolean()
        .describe(
          "True when logged in on the feed with no email verification banner. False on login wall, restriction, or failed verification.",
        ),
      notes: z.string().describe("Short summary of what happened"),
    }),
  });

  for (let i = 0; i < result.actions.length; i++) {
    const action = result.actions[i];
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

  pageState = await classifyPage(stagehand, emit, actionId);
  if (pageState === "restriction_notice") {
    await restrictProfile(deps, "browser_rescue", "restriction after onboarding agent");
    return false;
  }

  const agentOk = result.success && (result.output as { success?: boolean } | undefined)?.success !== false;
  if (!agentOk || pageState === "login") {
    await emit(
      "ActionFailed",
      {
        message: result.message,
        output: result.output ?? null,
        pageState,
      },
      actionId,
    );
    return false;
  }

  const linkedInProfileUrl = await captureLinkedInProfileUrl(
    stagehand,
    convex,
    workerKey,
    profile._id,
    emit,
    actionId,
  );
  if (!linkedInProfileUrl) {
    await emit(
      "AnomalyObserved",
      {
        phase: "complete_onboarding_profile_url",
        reason: "profile_url_not_captured",
        message: "onboarding rescue succeeded but LinkedIn profile URL could not be captured",
      },
      actionId,
    );
  }

  await convex.mutation(api.profiles.transition, {
    workerKey,
    profileId: profile._id,
    to: "warming",
    reason: linkedInProfileUrl
      ? "onboarding completed (rescue)"
      : "onboarding completed (rescue, profile URL pending)",
  });

  await emit(
    "ActionSucceeded",
    {
      message: result.message,
      steps: result.actions.length,
      linkedInProfileUrl: linkedInProfileUrl ?? undefined,
      profileUrlCaptured: Boolean(linkedInProfileUrl),
      notes: (result.output as { notes?: string } | undefined)?.notes,
    },
    actionId,
  );
  return true;
}

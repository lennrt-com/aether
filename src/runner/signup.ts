// LinkedIn account creation + login flows. Both are Stagehand agent runs with
// smtp.dev email tools + optional 5sim phone tools attached; signup additionally
// persists credentials and promotes the profile out of provisioning.
import { randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Stagehand } from "@browserbasehq/stagehand";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import type { Doc } from "../../convex/_generated/dataModel.js";
import type { Emit } from "./emit.js";
import { classifyPage } from "./classify.js";
import { evalInPage } from "./cdpEval.js";
import { buildCaptchaTools } from "./captchaTools.js";
import { buildEmailTools } from "./emailTools.js";
import { buildPhoneTools } from "./phoneTools.js";
import {
  buildLoginInstruction,
  buildSignupInstruction,
  FEED_URL,
  LINKEDIN_PROFILE_ENTRY,
  LOGIN_URL,
  type PersonaLike,
} from "./behaviors.js";

const DEFAULT_SIGNUP_URL = "https://www.linkedin.com/signup";
const SIGNUP_MAX_STEPS = 1250;
const LOGIN_MAX_STEPS = 500;
const DEFAULT_FEED_WARMUP_MS = 30_000;
const PROFILE_URL_WAIT_MS = 20_000;

const LINKEDIN_PROFILE_PATH = /^\/in\/([a-zA-Z0-9\-_%]+)\/?$/;

/** Canonical https://www.linkedin.com/in/{slug} */
export function normalizeLinkedInProfileUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (!u.hostname.endsWith("linkedin.com")) return null;
    const match = u.pathname.match(LINKEDIN_PROFILE_PATH);
    if (!match) return null;
    return `https://www.linkedin.com/in/${match[1]}/`;
  } catch {
    return null;
  }
}

async function persistCredentials(
  deps: AccountFlowDeps,
  actionId: string,
  email: string,
  password: string,
  mailboxId: string | undefined,
  notes: string,
  opts?: { transition?: boolean },
): Promise<void> {
  const { convex, workerKey, profile, emit } = deps;
  await convex.mutation(api.credentials.create, {
    workerKey,
    profileId: profile._id,
    email,
    password,
    emailProvider: "smtp.dev",
    mailboxId,
  });
  await emit("AccountCreated", { email, notes }, actionId);
  if (opts?.transition !== false && profile.status === "provisioning") {
    await convex.mutation(api.profiles.transition, {
      workerKey,
      profileId: profile._id,
      to: "warming",
      reason: "signup completed",
    });
  }
}

/** Visit /in/ while logged in; LinkedIn redirects to the member's canonical profile URL. */
async function captureLinkedInProfileUrl(
  stagehand: Stagehand,
  convex: ConvexHttpClient,
  workerKey: string,
  profileId: Doc<"profiles">["_id"],
  emit: Emit,
  actionId: string,
): Promise<string | null> {
  const page = stagehand.context.activePage();
  if (!page) return null;

  const phaseId = `${actionId}:profile-url`;
  await emit("ActionStarted", { phase: "signup_profile_url", url: LINKEDIN_PROFILE_ENTRY }, phaseId);

  try {
    await page.goto(LINKEDIN_PROFILE_ENTRY, {
      waitUntil: "domcontentloaded",
      timeoutMs: 45_000,
    });

    const deadline = Date.now() + PROFILE_URL_WAIT_MS;
    let normalized: string | null = null;
    while (Date.now() < deadline) {
      normalized = normalizeLinkedInProfileUrl(page.url());
      if (normalized) break;
      await page.waitForTimeout(500);
    }

    if (!normalized) {
      await emit(
        "ActionFailed",
        {
          phase: "signup_profile_url",
          error: "LinkedIn did not redirect to a profile URL",
          lastUrl: page.url(),
        },
        phaseId,
      );
      return null;
    }

    await convex.mutation(api.profiles.setLinkedInProfileUrl, {
      workerKey,
      profileId,
      linkedInProfileUrl: normalized,
    });

    await emit(
      "ActionSucceeded",
      { phase: "signup_profile_url", linkedInProfileUrl: normalized },
      phaseId,
    );
    return normalized;
  } catch (err) {
    await emit(
      "ActionFailed",
      { phase: "signup_profile_url", error: String(err) },
      phaseId,
    );
    return null;
  }
}

export interface AccountFlowDeps {
  stagehand: Stagehand;
  convex: ConvexHttpClient;
  workerKey: string;
  emit: Emit;
  profile: Doc<"profiles">;
  persona: Doc<"personas"> | null;
  maxSteps?: number;
  proxy?: { server: string; username?: string; password?: string };
}

// Strong password the runner knows exactly (passed to the agent via variables).
export function generatePassword(): string {
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const upper = "ABCDEFGHJKMNPQRSTUVWXYZ";
  const digits = "23456789";
  const symbols = "!#$%&*+-?@";
  const all = lower + upper + digits + symbols;
  const pick = (set: string) => set[randomInt(set.length)];
  const chars = [pick(lower), pick(upper), pick(digits), pick(symbols)];
  while (chars.length < 16) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

function personaData(persona: Doc<"personas"> | null): {
  fullName: string;
  firstName: string;
  lastName: string;
} {
  const data = (persona?.data ?? {}) as { fullName?: string };
  const fullName = data.fullName?.trim() || "Alex Carter";
  const parts = fullName.split(/\s+/);
  return {
    fullName,
    firstName: parts[0],
    lastName: parts.length > 1 ? parts[parts.length - 1] : "Carter",
  };
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

/** Slow, human-like feed scroll after signup before the session closes. */
async function scrollFeedWarmup(
  stagehand: Stagehand,
  emit: Emit,
  actionId: string,
  durationMs: number,
): Promise<boolean> {
  const page = stagehand.context.activePage();
  if (!page) return false;

  await emit("ActionStarted", { phase: "signup_feed_warmup", durationMs }, `${actionId}:feed`);

  try {
    await page.goto(FEED_URL, { waitUntil: "domcontentloaded", timeoutMs: 30_000 }).catch(() => {});
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      await evalInPage(page, () => {
        window.scrollBy({
          top: 250 + Math.floor(Math.random() * 350),
          behavior: "smooth",
        });
      });
      await page.waitForTimeout(900 + Math.floor(Math.random() * 700));
    }
    await classifyPage(stagehand, emit, `${actionId}:feed`);
    await emit(
      "ActionSucceeded",
      { phase: "signup_feed_warmup", durationMs, url: FEED_URL },
      `${actionId}:feed`,
    );
    return true;
  } catch (err) {
    await emit(
      "ActionFailed",
      { phase: "signup_feed_warmup", error: String(err) },
      `${actionId}:feed`,
    );
    return false;
  }
}

export async function runSignup(deps: AccountFlowDeps): Promise<boolean> {
  const { stagehand, convex, workerKey, emit, profile, persona, proxy } = deps;
  const actionId = randomUUID();
  const signupUrl = process.env.LINKEDIN_SIGNUP_URL ?? DEFAULT_SIGNUP_URL;
  const feedWarmupMs = Number(process.env.SIGNUP_FEED_WARMUP_MS ?? DEFAULT_FEED_WARMUP_MS);

  const existing = await convex.query(api.credentials.getFor, {
    workerKey,
    profileId: profile._id,
  });
  if (existing) {
    await emit(
      "ActionFailed",
      { error: "profile already has account credentials — enqueue a login task instead" },
      actionId,
    );
    return false;
  }

  const { fullName, firstName, lastName } = personaData(persona);
  const personaLike = (persona?.data ?? null) as PersonaLike | null;
  const password = generatePassword();
  let emailCall = 0;
  let captchaCall = 0;
  let phoneCall = 0;
  const { tools: emailTools, state } = buildEmailTools({
    localPartBase: `${firstName}${lastName}`,
    accountPassword: password,
    audit: async (toolName, data, ok) => {
      emailCall += 1;
      await emit(ok ? "ActionSucceeded" : "ActionFailed", { tool: toolName, ...data }, `${actionId}:email:${emailCall}`);
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
  const { tools: phoneTools } = buildPhoneTools({
    geo: profile.geo,
    audit: async (toolName, data, ok) => {
      phoneCall += 1;
      await emit(
        ok ? "ActionSucceeded" : "ActionFailed",
        { tool: toolName, ...data },
        `${actionId}:phone:${phoneCall}`,
      );
    },
  });
  const tools = { ...emailTools, ...captchaTools, ...phoneTools };

  await emit("ActionStarted", { taskType: "signup", url: signupUrl, persona: fullName }, actionId);

  const page = stagehand.context.activePage();
  if (!page) throw new Error("no active page after launch");
  await page.goto(signupUrl, { waitUntil: "load" });
  await classifyPage(stagehand, emit, actionId);

  const agent = stagehand.agent({ mode: "hybrid", tools });
  const result = await agent.execute({
    instruction: buildSignupInstruction(personaLike),
    maxSteps: deps.maxSteps ?? SIGNUP_MAX_STEPS,
    variables: {
      password: { value: password, description: "The password for the new LinkedIn account" },
    },
    output: z.object({
      email: z.string().describe("The email address used for the account ('' if none was created)"),
      success: z.boolean().describe("Whether onboarding finished and the normal LinkedIn feed is visible"),
      notes: z.string().describe("Short summary of what happened, including any blockers"),
    }),
  });

  await emitAgentSteps(emit, result.actions, actionId);
  const pageState = await classifyPage(stagehand, emit, actionId);

  const onboardingOk = result.success && state.address !== null && pageState === "normal";
  if (!onboardingOk) {
    await emit(
      "ActionFailed",
      { message: result.message, output: result.output ?? null, pageState, email: state.address },
      actionId,
    );
    return false;
  }

  const notes = (result.output as { notes?: string } | undefined)?.notes ?? result.message;

  // Save credentials before profile URL capture so they are not lost if navigation fails.
  await persistCredentials(
    deps,
    actionId,
    state.address!,
    password,
    state.smtpDevAccountId ?? undefined,
    notes,
    { transition: false },
  );

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
      "ActionFailed",
      {
        message: "signup wizard finished but LinkedIn profile URL could not be captured",
        email: state.address,
      },
      actionId,
    );
    return false;
  }

  if (profile.status === "provisioning") {
    await convex.mutation(api.profiles.transition, {
      workerKey,
      profileId: profile._id,
      to: "warming",
      reason: "signup onboarding completed",
    });
  }

  const feedOk = await scrollFeedWarmup(stagehand, emit, actionId, feedWarmupMs);
  if (!feedOk) {
    await emit(
      "AnomalyObserved",
      {
        phase: "signup_feed_warmup",
        reason: "feed_warmup_failed",
        note: "credentials saved; feed scroll did not complete cleanly",
      },
      actionId,
    );
  }

  await emit(
    "ActionSucceeded",
    {
      message: result.message,
      steps: result.actions.length,
      feedWarmupMs,
      feedWarmupOk: feedOk,
      email: state.address,
      linkedInProfileUrl,
    },
    actionId,
  );
  return true;
}

export async function runLogin(deps: AccountFlowDeps): Promise<boolean> {
  const { stagehand, convex, workerKey, emit, profile, proxy } = deps;
  const actionId = randomUUID();

  const creds = await convex.query(api.credentials.getFor, {
    workerKey,
    profileId: profile._id,
  });
  if (!creds) {
    await emit(
      "ActionFailed",
      { error: "profile has no account credentials — run signup first" },
      actionId,
    );
    return false;
  }

  let emailCall = 0;
  let captchaCall = 0;
  let phoneCall = 0;
  const canReadEmail = creds.emailProvider === "smtp.dev" && creds.mailboxId;
  const { tools: emailTools } = buildEmailTools({
    localPartBase: "login",
    accountPassword: creds.password,
    existing: canReadEmail
      ? { address: creds.email, smtpDevAccountId: creds.mailboxId! }
      : undefined,
    audit: async (toolName, data, ok) => {
      emailCall += 1;
      await emit(ok ? "ActionSucceeded" : "ActionFailed", { tool: toolName, ...data }, `${actionId}:email:${emailCall}`);
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
  const { tools: phoneTools } = buildPhoneTools({
    geo: profile.geo,
    audit: async (toolName, data, ok) => {
      phoneCall += 1;
      await emit(
        ok ? "ActionSucceeded" : "ActionFailed",
        { tool: toolName, ...data },
        `${actionId}:phone:${phoneCall}`,
      );
    },
  });
  const tools = { ...emailTools, ...captchaTools, ...phoneTools };

  await emit("ActionStarted", { taskType: "login", url: LOGIN_URL, email: creds.email }, actionId);

  const page = stagehand.context.activePage();
  if (!page) throw new Error("no active page after launch");
  await page.goto(LOGIN_URL, { waitUntil: "load" });
  await classifyPage(stagehand, emit, actionId);

  const agent = stagehand.agent({ mode: "hybrid", tools });
  const result = await agent.execute({
    instruction: buildLoginInstruction(),
    maxSteps: deps.maxSteps ?? LOGIN_MAX_STEPS,
    variables: {
      email: { value: creds.email, description: "The LinkedIn account email" },
      password: { value: creds.password, description: "The LinkedIn account password" },
    },
  });

  await emitAgentSteps(emit, result.actions, actionId);
  const pageState = await classifyPage(stagehand, emit, actionId);

  const succeeded = result.success && pageState === "normal";
  if (!succeeded) {
    await emit("ActionFailed", { message: result.message, pageState }, actionId);
    return false;
  }

  await emit("LoginSucceeded", { email: creds.email }, actionId);
  if (profile.status === "provisioning") {
    await convex.mutation(api.profiles.transition, {
      workerKey,
      profileId: profile._id,
      to: "warming",
      reason: "login succeeded",
    });
  }
  await emit("ActionSucceeded", { message: result.message, steps: result.actions.length }, actionId);
  return true;
}

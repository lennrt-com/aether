// LinkedIn account creation + login flows. Both are Stagehand agent runs with
// smtp.dev email tools attached; signup additionally persists credentials and
// promotes the profile out of provisioning.
import { randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Stagehand } from "@browserbasehq/stagehand";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import type { Doc } from "../../convex/_generated/dataModel.js";
import type { Emit } from "./emit.js";
import { classifyPage } from "./classify.js";
import { buildEmailTools } from "./emailTools.js";
import { buildLoginInstruction, LOGIN_URL } from "./behaviors.js";

const DEFAULT_SIGNUP_URL = "https://www.linkedin.com/signup";
const SIGNUP_MAX_STEPS = 40;
const LOGIN_MAX_STEPS = 25;

export interface AccountFlowDeps {
  stagehand: Stagehand;
  convex: ConvexHttpClient;
  workerKey: string;
  emit: Emit;
  profile: Doc<"profiles">;
  persona: Doc<"personas"> | null;
  maxSteps?: number;
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

export async function runSignup(deps: AccountFlowDeps): Promise<boolean> {
  const { stagehand, convex, workerKey, emit, profile, persona } = deps;
  const actionId = randomUUID();
  const signupUrl = process.env.LINKEDIN_SIGNUP_URL ?? DEFAULT_SIGNUP_URL;

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
  const password = generatePassword();
  let emailCall = 0;
  const { tools, state } = buildEmailTools({
    localPartBase: `${firstName}${lastName}`,
    accountPassword: password,
    audit: async (toolName, data, ok) => {
      emailCall += 1;
      await emit(ok ? "ActionSucceeded" : "ActionFailed", { tool: toolName, ...data }, `${actionId}:email:${emailCall}`);
    },
  });

  await emit("ActionStarted", { taskType: "signup", url: signupUrl, persona: fullName }, actionId);

  const page = stagehand.context.activePage();
  if (!page) throw new Error("no active page after launch");
  await page.goto(signupUrl, { waitUntil: "load" });
  await classifyPage(stagehand, emit, actionId);

  const agent = stagehand.agent({ mode: "hybrid", tools });
  const result = await agent.execute({
    instruction: [
      `You are ${fullName}, creating a brand-new LinkedIn account for yourself.`,
      "Step 1: call the create_email_address tool to get a fresh email address with a working inbox.",
      `Step 2: on the LinkedIn signup page, fill the form using that email address and the password %password%.`,
      `Use first name "${firstName}" and last name "${lastName}" when asked.`,
      "Step 3: submit the form. When LinkedIn asks for an email verification code, call the read_verification_code tool and type the code it returns.",
      "Step 4: complete any remaining mandatory onboarding steps with minimal, plausible answers. Skip every optional step (photo upload, contact sync, follows, premium offers).",
      "You are done when you reach the logged-in LinkedIn feed or homepage.",
      "If a CAPTCHA or security puzzle appears that you cannot solve, stop and report it honestly instead of guessing.",
    ].join(" "),
    maxSteps: deps.maxSteps ?? SIGNUP_MAX_STEPS,
    variables: {
      password: { value: password, description: "The password for the new LinkedIn account" },
    },
    output: z.object({
      email: z.string().describe("The email address used for the account ('' if none was created)"),
      success: z.boolean().describe("Whether the account was fully created and verified"),
      notes: z.string().describe("Short summary of what happened, including any blockers"),
    }),
  });

  await emitAgentSteps(emit, result.actions, actionId);
  const pageState = await classifyPage(stagehand, emit, actionId);

  const succeeded = result.success && state.address !== null && pageState === "normal";
  if (!succeeded) {
    await emit(
      "ActionFailed",
      { message: result.message, output: result.output ?? null, pageState, email: state.address },
      actionId,
    );
    return false;
  }

  await convex.mutation(api.credentials.create, {
    workerKey,
    profileId: profile._id,
    email: state.address!,
    password,
    emailProvider: "smtp.dev",
    mailboxId: state.smtpDevAccountId ?? undefined,
  });
  await emit(
    "AccountCreated",
    { email: state.address, notes: (result.output as { notes?: string } | undefined)?.notes ?? result.message },
    actionId,
  );
  if (profile.status === "provisioning") {
    await convex.mutation(api.profiles.transition, {
      workerKey,
      profileId: profile._id,
      to: "warming",
      reason: "signup completed",
    });
  }
  await emit("ActionSucceeded", { message: result.message, steps: result.actions.length }, actionId);
  return true;
}

export async function runLogin(deps: AccountFlowDeps): Promise<boolean> {
  const { stagehand, convex, workerKey, emit, profile } = deps;
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
  const canReadEmail = creds.emailProvider === "smtp.dev" && creds.mailboxId;
  const { tools } = buildEmailTools({
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

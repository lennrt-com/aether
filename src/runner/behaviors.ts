// Persona-driven LinkedIn instruction builders. Templates are loaded from Convex at
// runtime; see src/shared/agentInstructionDefaults.ts for built-in fallbacks.

import {
  DEFAULT_AGENT_INSTRUCTION_TEMPLATES,
  type AgentInstructionKey,
  type AgentInstructionTemplates,
} from "../shared/agentInstructionDefaults.js";

export interface PersonaLike {
  fullName?: string;
  role?: string;
  industry?: string;
  geo?: string;
  location?: string;
  backstory?: string;
  tone?: string;
  interests?: string[];
}

export interface Behavior {
  url: string;
  instruction: string;
  maxSteps: number;
}

export const FEED_URL = "https://www.linkedin.com/feed/";
export const LOGIN_URL = "https://www.linkedin.com/login";
/** Logged-in shortcut — LinkedIn redirects /in/me/ to the member's canonical /in/{slug}. */
export const LINKEDIN_PROFILE_ENTRY = "https://www.linkedin.com/in/me/";

function interpolateTemplate(template: string, vars: Record<string, string | undefined>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.split(`{{${key}}}`).join(value ?? "");
  }
  return result;
}

function prefixFormGuidance(
  instruction: string,
  templates: AgentInstructionTemplates = DEFAULT_AGENT_INSTRUCTION_TEMPLATES,
): string {
  const formGuidance = templates.general_form_guidance?.trim();
  if (!formGuidance) return instruction;
  return `${formGuidance}\n\n${instruction}`;
}

/** Prepends form-field guidance and optional first-action step for hybrid browse tasks. */
export function withDirectActInstruction(
  instruction: string,
  templates: AgentInstructionTemplates = DEFAULT_AGENT_INSTRUCTION_TEMPLATES,
): string {
  const withForm = prefixFormGuidance(instruction, templates);
  if (process.env.FORCE_AGENT_ACT === "false") return withForm;
  return `${templates.direct_act_preamble}\n\n${withForm}`;
}

/** Form-field guidance only (signup/login — no mandatory scroll-first step). */
export function withFormGuidance(
  instruction: string,
  templates: AgentInstructionTemplates = DEFAULT_AGENT_INSTRUCTION_TEMPLATES,
): string {
  return prefixFormGuidance(instruction, templates);
}

export function needsFeedSettle(taskType: string, url: string): boolean {
  if (taskType === "warmup_feed" || taskType === "engage_post") return true;
  try {
    const u = new URL(url);
    return u.hostname.endsWith("linkedin.com") && u.pathname.startsWith("/feed");
  } catch {
    return false;
  }
}

function interestsClause(persona: PersonaLike | null): string {
  const interests = persona?.interests?.slice(0, 5);
  return interests?.length
    ? `Topics you genuinely care about: ${interests.join(", ")}.`
    : "";
}

function toneClause(persona: PersonaLike | null): string {
  return persona?.tone ? `Your writing tone is: ${persona.tone}.` : "";
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  return {
    firstName: parts[0] || "Alex",
    lastName: parts.length > 1 ? parts[parts.length - 1] : "Carter",
  };
}

/** Onboarding-relevant persona fields for LinkedIn signup wizard steps. */
function personaSignupContext(persona: PersonaLike | null): string {
  if (!persona) return "";
  const lines: string[] = [];
  if (persona.role) lines.push(`Job title / role: ${persona.role}`);
  if (persona.industry) lines.push(`Industry: ${persona.industry}`);
  if (persona.location) lines.push(`Location (city/region/country): ${persona.location}`);
  else if (persona.geo) lines.push(`Location (country): ${persona.geo}`);
  if (persona.interests?.length) {
    lines.push(`Professional interests: ${persona.interests.slice(0, 6).join(", ")}`);
  }
  if (persona.backstory) {
    const brief = persona.backstory.trim().slice(0, 500);
    lines.push(`Background: ${brief}${persona.backstory.length > 500 ? "…" : ""}`);
  }
  if (persona.tone) lines.push(`Tone: ${persona.tone}`);
  if (!lines.length) return "";
  return [
    "Persona details — use these consistently when LinkedIn asks for location, job title, industry, experience level, company, or similar onboarding fields:",
    ...lines.map((l) => `- ${l}`),
  ].join("\n");
}

export function buildBehavior(
  taskType: string,
  persona: PersonaLike | null,
  templates: AgentInstructionTemplates = DEFAULT_AGENT_INSTRUCTION_TEMPLATES,
): Behavior | null {
  switch (taskType) {
    case "warmup_feed":
      return {
        url: FEED_URL,
        maxSteps: 1000,
        instruction: interpolateTemplate(templates.warmup_feed, {
          interestsClause: interestsClause(persona),
        }),
      };
    case "engage_post":
      return {
        url: FEED_URL,
        maxSteps: 1000,
        instruction: interpolateTemplate(templates.engage_post, {
          interestsClause: interestsClause(persona),
          toneClause: toneClause(persona),
        }),
      };
    default:
      return null;
  }
}

// Login is orchestrated separately (needs credentials as variables + email
// tools for verification codes) — only the instruction text lives here.
export function buildLoginInstruction(
  templates: AgentInstructionTemplates = DEFAULT_AGENT_INSTRUCTION_TEMPLATES,
): string {
  return withFormGuidance(
    interpolateTemplate(templates.login, {
      phoneVerification: templates.phone_verification,
    }),
    templates,
  );
}

export function buildSignupInstruction(
  persona: PersonaLike | null,
  templates: AgentInstructionTemplates = DEFAULT_AGENT_INSTRUCTION_TEMPLATES,
): string {
  const fullName = persona?.fullName?.trim() || "Alex Carter";
  const { firstName, lastName } = splitName(fullName);
  const personaBlock = personaSignupContext(persona);

  return withFormGuidance(
    interpolateTemplate(templates.signup, {
      fullName,
      firstName,
      lastName,
      personaBlock: personaBlock ? `${personaBlock} ` : "",
      phoneVerification: templates.phone_verification,
    }),
    templates,
  );
}

export function normalizeAgentInstructionTemplates(
  remote: Record<string, string>,
): AgentInstructionTemplates {
  const merged = { ...DEFAULT_AGENT_INSTRUCTION_TEMPLATES };
  for (const key of Object.keys(DEFAULT_AGENT_INSTRUCTION_TEMPLATES) as AgentInstructionKey[]) {
    const value = remote[key];
    if (typeof value === "string" && value.length > 0) {
      merged[key] = value;
    }
  }
  return merged;
}

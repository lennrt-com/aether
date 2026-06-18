// Shared defaults applied to EVERY Stagehand agent in this project.
//
// The systemPrompt below is rendered by Stagehand into a top-level
// <customInstructions> block at the very start of the agent's system prompt
// on every step (see node_modules/@browserbasehq/stagehand .../agentSystemPrompt.js),
// so it acts as a universal rule for any agent regardless of task (signup,
// login, onboarding, warmup, experiment, agent-test, …).
//
// Always create agents through `createAgent()` instead of calling
// `stagehand.agent()` directly, so this rule can never be forgotten.

import type { Stagehand, AgentConfig } from "@browserbasehq/stagehand";

/**
 * Universal rule: clear a text field completely before typing into it.
 * Fixes the recurring failure where the agent drops the cursor into
 * pre-filled / placeholder / leftover text and types on top of it,
 * producing garbled, concatenated values.
 */
export const AGENT_SYSTEM_PROMPT = [
  "CLEARING TEXT INPUTS (CRITICAL — applies to every text field, every time):",
  "Before typing into ANY text input, textarea, search box, or contenteditable field, you MUST first clear whatever is already in it — do this even if the field looks empty or only shows placeholder, pre-filled, or leftover text.",
  "Required procedure for every field:",
  "1. Click the field to focus it.",
  "2. Select all existing content (Ctrl+A, or Cmd+A on macOS).",
  "3. Press Delete or Backspace until the field is completely empty.",
  "4. Only then type the new value.",
  "NEVER place the cursor in the middle of existing text and type on top of it — that creates garbled, merged, or duplicated values.",
  "If after typing a field shows wrong, duplicated, or concatenated text, clear it entirely (steps 1–3) and type the value again from scratch.",
].join(" ");

type NonStreamingAgentConfig = AgentConfig & { stream?: false };
type StagehandAgent = ReturnType<Stagehand["agent"]>;

/**
 * Create a Stagehand agent with the project-wide system prompt applied.
 * Any caller-supplied `systemPrompt` is appended after the universal rule
 * so the clearing rule is always present.
 */
export function createAgent(
  stagehand: Stagehand,
  options: NonStreamingAgentConfig = {},
): StagehandAgent {
  const { systemPrompt, ...rest } = options;
  const mergedSystemPrompt = systemPrompt
    ? `${AGENT_SYSTEM_PROMPT}\n\n${systemPrompt}`
    : AGENT_SYSTEM_PROMPT;
  return stagehand.agent({ ...rest, systemPrompt: mergedSystemPrompt });
}

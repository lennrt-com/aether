// Stagehand agent model aliases for CLI and task payloads.
// Full strings use the provider/model format expected by Stagehand v3.

export const AGENT_MODEL_ALIASES = {
  "gemini-3-flash-preview": "google/gemini-3-flash-preview",
  "claude-opus-4-8": "anthropic/claude-opus-4-8",
  "claude-sonnet-4-6": "anthropic/claude-sonnet-4-6",
} as const;

export type AgentModelAlias = keyof typeof AGENT_MODEL_ALIASES;

export const AGENT_MODEL_CHOICES = Object.keys(AGENT_MODEL_ALIASES) as AgentModelAlias[];

export const DEFAULT_AGENT_MODEL = AGENT_MODEL_ALIASES["claude-sonnet-4-6"];

/** Resolve a CLI alias, full provider/model string, or AGENT_MODEL env fallback. */
export function resolveAgentModel(input?: string | null): string {
  const trimmed = input?.trim();
  if (trimmed) {
    if (trimmed in AGENT_MODEL_ALIASES) {
      return AGENT_MODEL_ALIASES[trimmed as AgentModelAlias];
    }
    if (trimmed.includes("/")) return trimmed;
    throw new Error(
      `unknown agent model "${trimmed}" — choose one of: ${AGENT_MODEL_CHOICES.join(", ")}`,
    );
  }

  const fromEnv = process.env.AGENT_MODEL?.trim();
  if (fromEnv) return resolveAgentModel(fromEnv);

  return DEFAULT_AGENT_MODEL;
}

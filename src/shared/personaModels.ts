// Persona-generation LLM aliases (structured output via @ai-sdk/google / @ai-sdk/anthropic).

export const PERSONA_MODEL_ALIASES = {
  "gemini-3-flash-preview": "google/gemini-3-flash-preview",
  "claude-opus-4-8": "anthropic/claude-opus-4-8",
  "claude-sonnet-4-6": "anthropic/claude-sonnet-4-6",
} as const;

export type PersonaModelAlias = keyof typeof PERSONA_MODEL_ALIASES;

export const PERSONA_MODEL_CHOICES = Object.keys(PERSONA_MODEL_ALIASES) as PersonaModelAlias[];

export const DEFAULT_PERSONA_MODEL = PERSONA_MODEL_ALIASES["gemini-3-flash-preview"];

/** Resolve a CLI alias, full provider/model string, or PERSONA_MODEL env fallback. */
export function resolvePersonaModelAlias(input?: string | null): string {
  const trimmed = input?.trim();
  if (trimmed) {
    if (trimmed in PERSONA_MODEL_ALIASES) {
      return PERSONA_MODEL_ALIASES[trimmed as PersonaModelAlias];
    }
    if (trimmed.includes("/")) return trimmed;
    throw new Error(
      `unknown persona model "${trimmed}" — choose one of: ${PERSONA_MODEL_CHOICES.join(", ")}`,
    );
  }

  const fromEnv = process.env.PERSONA_MODEL?.trim();
  if (fromEnv) return resolvePersonaModelAlias(fromEnv);

  return DEFAULT_PERSONA_MODEL;
}

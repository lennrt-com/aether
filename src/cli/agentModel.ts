import { select } from "@inquirer/prompts";
import {
  AGENT_MODEL_ALIASES,
  AGENT_MODEL_CHOICES,
  type AgentModelAlias,
  resolveAgentModel,
} from "../shared/agentModels.js";

function asAlias(value: string | undefined | null): AgentModelAlias | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed in AGENT_MODEL_ALIASES) return trimmed as AgentModelAlias;
  // Stored full provider path — map back to alias when possible.
  const alias = (Object.entries(AGENT_MODEL_ALIASES) as Array<[AgentModelAlias, string]>).find(
    ([, full]) => full === trimmed,
  )?.[0];
  return alias;
}

/** Interactive picker for browser automation model. */
export async function promptAgentModel(stored?: string | null): Promise<AgentModelAlias> {
  const defaultAlias = asAlias(stored) ?? "claude-sonnet-4-6";
  return select({
    message: "Agent model (browser automation)",
    choices: AGENT_MODEL_CHOICES.map((m) => ({ name: m, value: m })),
    default: defaultAlias,
  });
}

/**
 * Resolve the agent model alias at process startup.
 * Priority: CLI flag → interactive prompt (TTY) → stored campaign value → AGENT_MODEL env → default.
 */
export async function resolveAgentModelForStartup(opts: {
  cliModel?: string;
  storedModel?: string | null;
  /** When false, skip the interactive picker even on a TTY. */
  prompt?: boolean;
}): Promise<AgentModelAlias> {
  const cliAlias = asAlias(opts.cliModel);
  if (cliAlias) return cliAlias;

  const shouldPrompt = opts.prompt ?? process.stdin.isTTY;
  if (shouldPrompt) {
    return promptAgentModel(opts.storedModel);
  }

  const storedAlias = asAlias(opts.storedModel);
  if (storedAlias) return storedAlias;

  const fromEnv = asAlias(process.env.AGENT_MODEL);
  if (fromEnv) return fromEnv;

  return "claude-sonnet-4-6";
}

/** Set AGENT_MODEL for child runners from a startup alias. */
export function applyAgentModelEnv(alias: AgentModelAlias): string {
  const resolved = resolveAgentModel(alias);
  process.env.AGENT_MODEL = alias;
  return resolved;
}

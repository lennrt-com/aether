import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import {
  DEFAULT_AGENT_INSTRUCTION_TEMPLATES,
  type AgentInstructionTemplates,
} from "../shared/agentInstructionDefaults.js";
import { normalizeAgentInstructionTemplates } from "./behaviors.js";

/** Fetch live agent instruction templates from Convex (merged over code defaults). */
export async function loadAgentInstructions(
  convex: ConvexHttpClient,
  workerKey: string,
): Promise<AgentInstructionTemplates> {
  try {
    const remote = await convex.query(api.agentInstructions.getForRunner, { workerKey });
    return normalizeAgentInstructionTemplates(remote);
  } catch {
    return DEFAULT_AGENT_INSTRUCTION_TEMPLATES;
  }
}

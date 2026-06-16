import type { LanguageModel } from "ai";
import { google } from "@ai-sdk/google";
import { anthropic } from "@ai-sdk/anthropic";
import { resolvePersonaModelAlias } from "../shared/personaModels.js";

/** Resolve persona model alias to an AI SDK LanguageModel instance. */
export function resolvePersonaModel(input?: string | null): LanguageModel {
  const resolved = resolvePersonaModelAlias(input);
  const slash = resolved.indexOf("/");
  if (slash === -1) throw new Error(`invalid persona model: ${resolved}`);
  const provider = resolved.slice(0, slash);
  const modelId = resolved.slice(slash + 1);
  switch (provider) {
    case "google":
      return google(modelId);
    case "anthropic":
      return anthropic(modelId);
    default:
      throw new Error(`unsupported persona provider: ${provider}`);
  }
}

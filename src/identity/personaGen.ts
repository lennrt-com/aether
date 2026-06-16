import { generateObject } from "ai";
import { z } from "zod";
import { resolvePersonaModel } from "./personaModel.js";

// Appendix D — persona zod schema. Stored verbatim in `personas.data`.
export const PersonaSchema = z.object({
  fullName: z.string(),
  role: z.string(),
  industry: z.string(),
  geo: z.string(),
  backstory: z.string().max(1200),
  tone: z.string(),
  interests: z.array(z.string()).min(3).max(8),
  behavior: z.object({
    timezone: z.string(),
    activeHours: z
      .array(
        z.object({
          start: z.number().min(0).max(23),
          end: z.number().min(1).max(24),
        }),
      )
      .min(1)
      .max(3),
    weekdayActivity: z.array(z.number().min(0).max(1)).length(7),
    sessionsPerDay: z.object({ min: z.number().min(0), max: z.number().max(6) }),
    actionMix: z.object({
      warmup_feed: z.number(),
      engage_post: z.number(),
      send_invitation: z.number(),
      send_message: z.number(),
      fetch_profile: z.number(),
    }),
  }),
});

export type Persona = z.infer<typeof PersonaSchema>;

export async function generatePersona(input: {
  seed: string;
  geo: string;
  timezone: string;
  roleArchetype: string;
  model?: string;
  userPrompt?: string;
}): Promise<Persona> {
  const lines = [
    `Generate one distinct, realistic professional LinkedIn persona.`,
    `Generation seed (use it to make the persona reproducible and distinct from other seeds): "${input.seed}".`,
    `Constraints:`,
    `- geo: ${input.geo} (set the "geo" field to exactly this value; name, industry and backstory must be plausible for it)`,
    `- behavior.timezone must be exactly "${input.timezone}"`,
    `- role archetype: ${input.roleArchetype}`,
    `- backstory: max 1200 characters, first person, grounded and unremarkable (no extraordinary claims)`,
    `- behavior.activeHours must fall inside plausible waking hours for a working professional in that timezone`,
    `- behavior.weekdayActivity is 7 numbers 0..1 (Mon..Sun), weekends noticeably lower`,
    `- behavior.actionMix is relative weights; warmup_feed and fetch_profile should dominate for a normal user`,
  ];
  if (input.userPrompt?.trim()) {
    lines.push(
      `Additional creative direction from the operator (incorporate naturally, do not contradict geo/timezone constraints):`,
      input.userPrompt.trim(),
    );
  }

  const { object } = await generateObject({
    model: resolvePersonaModel(input.model),
    schema: PersonaSchema,
    prompt: lines.join("\n"),
    allowSystemInMessages: true,
  });
  return object;
}

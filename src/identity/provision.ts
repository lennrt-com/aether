// Provision a complete identity bundle: profile row, Faker+AI persona, deterministic
// launch config, proxy binding. Shared by `bless provision` and `bless create`.
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel.js";
import { generatePersona, PersonaSchema, type Persona } from "./personaGen.js";
import { generateLaunchConfig, type LaunchConfig } from "./launchConfigGen.js";

export interface ProvisionLog {
  info?: (message: string) => void;
  phase?: (message: string) => void;
}

export interface ProvisionOptions {
  name: string;
  geo: string;
  timezone: string;
  role: string;
  personaModel?: string;
  personaPrompt?: string;
  /** Override Faker city for LinkedIn location, e.g. "Frankfurt, Hesse, Germany". */
  location?: string;
  /** Omit for a direct (no-proxy) profile — only sensible for manual/local testing. */
  proxy?: { server: string; username?: string; password?: string };
  /** Leave the profile in `provisioning` (required before a signup task). */
  stayProvisioning?: boolean;
  log?: ProvisionLog;
}

export interface ProvisionedBundle {
  profileId: Id<"profiles">;
  persona: Persona;
  launchConfig: LaunchConfig;
}

export async function provisionProfile(
  client: ConvexHttpClient,
  workerKey: string,
  opts: ProvisionOptions,
): Promise<ProvisionedBundle> {
  const log = opts.log ?? {};
  const info = log.info ?? ((m: string) => console.log(m));
  const phase = log.phase;

  const profileId = await client.mutation(api.profiles.create, {
    workerKey,
    name: opts.name,
    chromeVersion: process.env.PINNED_CHROME_VERSION,
  });
  info(`profile created: ${profileId}`);

  if (phase) phase("generating persona (Faker + AI)...");
  else info("generating persona (Faker + AI)...");
  const persona = PersonaSchema.parse(
    await generatePersona({
      seed: profileId,
      geo: opts.geo,
      timezone: opts.timezone,
      roleArchetype: opts.role,
      location: opts.location,
      model: opts.personaModel,
      userPrompt: opts.personaPrompt,
    }),
  );
  const personaId = await client.mutation(api.personas.create, {
    workerKey,
    profileId,
    version: 1,
    data: persona,
  });
  await client.mutation(api.personas.attachToProfile, { workerKey, profileId, personaId });
  info(`persona generated: ${persona.fullName} (${persona.role}) — ${persona.location}`);

  const launchConfig = generateLaunchConfig({
    profileKey: profileId,
    geo: opts.geo,
    timezone: opts.timezone,
  });
  const launchConfigId = await client.mutation(api.launchConfigs.create, {
    workerKey,
    profileId,
    version: 1,
    ...launchConfig,
  });
  await client.mutation(api.launchConfigs.attachToProfile, {
    workerKey,
    profileId,
    launchConfigId,
  });
  info(
    `launch config: ${launchConfig.timezone}, ${launchConfig.locale}, ` +
      `${launchConfig.windowWidth}x${launchConfig.windowHeight}`,
  );

  if (opts.proxy) {
    const proxyBindingId = await client.mutation(api.proxies.create, {
      workerKey,
      profileId,
      server: opts.proxy.server,
      username: opts.proxy.username,
      password: opts.proxy.password,
      geo: opts.geo,
    });
    await client.mutation(api.proxies.attachToProfile, { workerKey, profileId, proxyBindingId });
    info(`proxy attached: ${opts.proxy.server} (${opts.geo})`);
  } else {
    info("no proxy attached (direct connection)");
  }

  if (opts.stayProvisioning) {
    info("staying in provisioning (signup will promote to warming)");
  } else {
    await client.mutation(api.profiles.transition, {
      workerKey,
      profileId,
      to: "warming",
      reason: "provisioned",
    });
  }

  return { profileId, persona, launchConfig };
}

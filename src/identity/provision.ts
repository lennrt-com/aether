// Provision a complete identity bundle: profile row, LLM persona, deterministic
// launch config, proxy binding. Shared by `bless provision` and `bless create`.
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel.js";
import { generatePersona, PersonaSchema, type Persona } from "./personaGen.js";
import { generateLaunchConfig, type LaunchConfig } from "./launchConfigGen.js";

export interface ProvisionOptions {
  name: string;
  geo: string;
  timezone: string;
  role: string;
  /** Omit for a direct (no-proxy) profile — only sensible for manual/local testing. */
  proxy?: { server: string; username?: string; password?: string };
  /** Leave the profile in `provisioning` (required before a signup task). */
  stayProvisioning?: boolean;
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
  const profileId = await client.mutation(api.profiles.create, {
    workerKey,
    name: opts.name,
    chromeVersion: process.env.PINNED_CHROME_VERSION,
  });
  console.log(`profile created: ${profileId}`);

  console.log("generating persona (LLM)...");
  const persona = PersonaSchema.parse(
    await generatePersona({
      seed: profileId,
      geo: opts.geo,
      timezone: opts.timezone,
      roleArchetype: opts.role,
    }),
  );
  const personaId = await client.mutation(api.personas.create, {
    workerKey,
    profileId,
    version: 1,
    data: persona,
  });
  await client.mutation(api.personas.attachToProfile, { workerKey, profileId, personaId });
  console.log(`persona attached: ${personaId} (${persona.fullName}, ${persona.role})`);

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
  console.log(
    `launchConfig attached: ${launchConfigId} (${launchConfig.timezone}, ${launchConfig.locale}, ` +
      `${launchConfig.windowWidth}x${launchConfig.windowHeight}, chrome ${launchConfig.chromeVersion})`,
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
    console.log(`proxy attached: ${proxyBindingId} (${opts.proxy.server}, ${opts.geo})`);
  } else {
    console.log("no proxy attached (direct connection — manual/local profile)");
  }

  if (opts.stayProvisioning) {
    console.log("staying in provisioning (signup task will promote to warming)");
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

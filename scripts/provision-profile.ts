// CLI: provision a complete identity bundle in one run.
// pnpm tsx scripts/provision-profile.ts --name jane --geo DE --tz Europe/Berlin \
//   --proxy-server host:port [--proxy-user u] [--proxy-pass p] [--role "sales lead"]
//   [--stay-provisioning]  (leave in provisioning for a follow-up signup task)
import "../src/shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { parseArgs } from "node:util";
import { api } from "../convex/_generated/api.js";
import { generatePersona, PersonaSchema } from "../src/identity/personaGen.js";
import { generateLaunchConfig } from "../src/identity/launchConfigGen.js";

const { values: args } = parseArgs({
  options: {
    name: { type: "string" },
    geo: { type: "string" },
    tz: { type: "string" },
    "proxy-server": { type: "string" },
    "proxy-user": { type: "string" },
    "proxy-pass": { type: "string" },
    role: { type: "string", default: "experienced professional" },
    "stay-provisioning": { type: "boolean", default: false },
  },
});

const { name, geo, tz } = args;
const proxyServer = args["proxy-server"];
if (!name || !geo || !tz || !proxyServer) {
  throw new Error("required: --name --geo --tz --proxy-server");
}

const url = process.env.CONVEX_URL;
const workerKey = process.env.WORKER_KEY;
if (!url || !workerKey) throw new Error("CONVEX_URL/WORKER_KEY not set");
const client = new ConvexHttpClient(url);

const profileId = await client.mutation(api.profiles.create, {
  workerKey,
  name,
  chromeVersion: process.env.PINNED_CHROME_VERSION,
});
console.log(`profile created: ${profileId}`);

console.log("generating persona (LLM)...");
const persona = PersonaSchema.parse(
  await generatePersona({ seed: profileId, geo, timezone: tz, roleArchetype: args.role! }),
);
const personaId = await client.mutation(api.personas.create, {
  workerKey,
  profileId,
  version: 1,
  data: persona,
});
await client.mutation(api.personas.attachToProfile, { workerKey, profileId, personaId });
console.log(`persona attached: ${personaId} (${persona.fullName}, ${persona.role})`);

const launchConfig = generateLaunchConfig({ profileKey: profileId, geo, timezone: tz });
const launchConfigId = await client.mutation(api.launchConfigs.create, {
  workerKey,
  profileId,
  version: 1,
  ...launchConfig,
});
await client.mutation(api.launchConfigs.attachToProfile, { workerKey, profileId, launchConfigId });
console.log(
  `launchConfig attached: ${launchConfigId} (${launchConfig.timezone}, ${launchConfig.locale}, ` +
    `${launchConfig.windowWidth}x${launchConfig.windowHeight}, chrome ${launchConfig.chromeVersion})`,
);

const proxyBindingId = await client.mutation(api.proxies.create, {
  workerKey,
  profileId,
  server: proxyServer,
  username: args["proxy-user"],
  password: args["proxy-pass"],
  geo,
});
await client.mutation(api.proxies.attachToProfile, { workerKey, profileId, proxyBindingId });
console.log(`proxy attached: ${proxyBindingId} (${proxyServer}, ${geo})`);

if (args["stay-provisioning"]) {
  console.log("staying in provisioning (run a signup task to promote to warming)");
} else {
  await client.mutation(api.profiles.transition, {
    workerKey,
    profileId,
    to: "warming",
    reason: "provisioned",
  });
}

const profile = await client.query(api.profiles.get, { profileId });
console.log("\nprovisioned bundle:");
console.log(JSON.stringify({ profile, persona, launchConfig }, null, 2));

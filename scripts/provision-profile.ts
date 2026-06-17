// CLI: provision a complete identity bundle in one run.
// pnpm tsx scripts/provision-profile.ts --name jane --geo DE --tz Europe/Berlin \
//   --proxy-server host:port [--proxy-user u] [--proxy-pass p] [--role "sales lead"]
//   [--stay-provisioning]  (leave in provisioning for a follow-up signup task)
import "../src/shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { parseArgs } from "node:util";
import { api } from "../convex/_generated/api.js";
import { provisionProfile } from "../src/identity/provision.js";

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
    "persona-model": { type: "string" },
    "persona-prompt": { type: "string" },
    location: { type: "string" },
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

const { profileId, persona, launchConfig } = await provisionProfile(client, workerKey, {
  name,
  geo,
  timezone: tz,
  role: args.role!,
  personaModel: args["persona-model"],
  personaPrompt: args["persona-prompt"],
  location: args.location,
  proxy: {
    server: proxyServer,
    username: args["proxy-user"],
    password: args["proxy-pass"],
  },
  stayProvisioning: args["stay-provisioning"],
});

const profile = await client.query(api.profiles.get, { profileId });
console.log("\nprovisioned bundle:");
console.log(JSON.stringify({ profile, persona, launchConfig }, null, 2));

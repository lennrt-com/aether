// Dev utility: dump the event chain for a profile (arg 1).
import "../src/shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";

const profileId = process.argv[2] as Id<"profiles">;
if (!profileId) throw new Error("usage: debug-events.ts <profileId>");
const client = new ConvexHttpClient(process.env.CONVEX_URL!);
const events = await client.query(api.events.forProfile, { profileId });
for (const e of events) {
  console.log(`${new Date(e.ts).toISOString()} ${e.type} ${JSON.stringify(e.data).slice(0, 600)}`);
}

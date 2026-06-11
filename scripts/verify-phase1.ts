import "../src/shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const url = process.env.CONVEX_URL;
const workerKey = process.env.WORKER_KEY;
if (!url) throw new Error("CONVEX_URL not set");
if (!workerKey) throw new Error("WORKER_KEY not set");

const client = new ConvexHttpClient(url);

const profileId = await client.mutation(api.profiles.create, {
  workerKey,
  name: `verify-p1-${Date.now()}`,
});

await client.mutation(api.profiles.transition, {
  workerKey,
  profileId,
  to: "warming",
  reason: "verify-phase1",
});

const eventTypes = ["ActionStarted", "ActionSucceeded", "SessionEnded"] as const;
const eventIds: string[] = [];
for (let i = 0; i < eventTypes.length; i++) {
  const id = await client.mutation(api.events.append, {
    workerKey,
    profileId,
    type: eventTypes[i],
    ts: Date.now(),
    channel: "system",
    data: { step: i },
    ctx: {},
  });
  eventIds.push(id);
}

const events = await client.query(api.events.forProfile, { profileId });

const returnedTypes = new Set(events.map((e) => e.type));
for (const type of eventTypes) {
  if (!returnedTypes.has(type)) {
    throw new Error(`missing appended event type: ${type}`);
  }
}
if (!returnedTypes.has("ProfileStateChanged")) {
  throw new Error("missing ProfileStateChanged event from transition");
}
if (events.length < 4) {
  throw new Error(`expected at least 4 events, got ${events.length}`);
}

let illegalThrew = false;
try {
  await client.mutation(api.profiles.transition, {
    workerKey,
    profileId,
    to: "recovering",
    reason: "verify-phase1-illegal",
  });
} catch {
  illegalThrew = true;
}
if (!illegalThrew) throw new Error("illegal transition did not throw");
console.log("illegal transition guard works");

console.log("phase 1 OK — profile", profileId, "events", events.length);

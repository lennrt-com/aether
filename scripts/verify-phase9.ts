import "../src/shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import type { Doc, Id } from "../convex/_generated/dataModel.js";
import { PersonaSchema } from "../src/identity/personaGen.js";

const url = process.env.CONVEX_URL;
const workerKey = process.env.WORKER_KEY;
if (!url || !workerKey) throw new Error("CONVEX_URL/WORKER_KEY not set");
const client = new ConvexHttpClient(url);

await client.mutation(api.policies.seedDefaultStrategy, { workerKey });
const strategy = await client.query(api.policies.getActive, {});
if (!strategy) throw new Error("no active strategy after seed");
console.log(`active strategy v${strategy.version} (${strategy._id})`);

const TZ = "Europe/Berlin";

function makePersona(name: string, activeHours: Array<{ start: number; end: number }>) {
  return PersonaSchema.parse({
    fullName: name,
    role: "verification dummy",
    industry: "Testing",
    geo: "DE",
    backstory: "Synthetic persona used only to verify the scheduler.",
    tone: "neutral",
    interests: ["a", "b", "c"],
    behavior: {
      timezone: TZ,
      activeHours,
      weekdayActivity: [1, 1, 1, 1, 1, 1, 1],
      sessionsPerDay: { min: 1, max: 3 },
      actionMix: {
        warmup_feed: 5,
        engage_post: 2,
        send_invitation: 1,
        send_message: 1,
        fetch_profile: 3,
      },
    },
  });
}

async function makeProfile(
  suffix: string,
  activeHours: Array<{ start: number; end: number }>,
): Promise<Id<"profiles">> {
  const profileId = await client.mutation(api.profiles.create, {
    workerKey,
    name: `verify-p9-${suffix}-${Date.now()}`,
  });
  await client.mutation(api.profiles.transition, {
    workerKey,
    profileId,
    to: "warming",
    reason: "verify-phase9",
  });
  const personaId = await client.mutation(api.personas.create, {
    workerKey,
    profileId,
    version: 1,
    data: makePersona(`P9 ${suffix}`, activeHours),
  });
  await client.mutation(api.personas.attachToProfile, { workerKey, profileId, personaId });
  return profileId;
}

const HOURS_A = [{ start: 8, end: 12 }];
const HOURS_B = [{ start: 14, end: 18 }];
const profileA = await makeProfile("a", HOURS_A);
const profileB = await makeProfile("b", HOURS_B);

// Simulated day: tomorrow, stepping 30 minutes x 48 runs (Berlin = UTC+2 in June).
const base = Math.ceil(Date.now() / 86400000 + 1) * 86400000;
const runs: number[] = [];
for (let i = 0; i < 48; i++) runs.push(base + i * 30 * 60 * 1000);

for (const now of runs) {
  await client.mutation(api.scheduler.run, { workerKey, now });
}
console.log(`ran scheduler ${runs.length} times across the simulated day`);

function berlinHour(ts: number): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, hour: "2-digit" })
      .format(new Date(ts))
      .replace("24", "0"),
  );
}

// warming caps: ceil(budget * multiplier * warmupFactor(age 0 -> 0.2))
const CAPS: Record<string, number> = {
  warmup_feed: Math.ceil(3 * 1.0 * 0.2),
  engage_post: Math.ceil(8 * 1.0 * 0.2),
};

async function checkProfile(
  profileId: Id<"profiles">,
  label: string,
  hours: Array<{ start: number; end: number }>,
): Promise<Doc<"tasks">[]> {
  const tasks = (await client.query(api.tasks.listFor, { profileId })).filter(
    (t) => (t.payload as { scheduler?: boolean })?.scheduler === true,
  );
  const events = await client.query(api.events.forProfile, { profileId });
  const decisions = events.filter((e) => e.type === "PolicyDecision");

  const counts = new Map<string, number>();
  const jitters: number[] = [];
  for (const task of tasks) {
    const scheduledAt = (task.payload as { scheduledAt: number }).scheduledAt;
    const h = berlinHour(scheduledAt);
    if (!hours.some((r) => h >= r.start && h < r.end)) {
      throw new Error(`${label}: task scheduled outside active hours (local hour ${h})`);
    }
    const jitter = task.dueAt - scheduledAt;
    if (jitter < 0 || jitter >= 25 * 60 * 1000) {
      throw new Error(`${label}: jitter ${jitter}ms outside [0, 25min)`);
    }
    jitters.push(jitter);
    counts.set(task.type, (counts.get(task.type) ?? 0) + 1);
    if (!(task.type in CAPS)) {
      throw new Error(`${label}: unexpected warming task type ${task.type}`);
    }
  }
  for (const [type, count] of counts) {
    if (count > CAPS[type]) {
      throw new Error(`${label}: budget exceeded for ${type}: ${count} > ${CAPS[type]}`);
    }
  }

  // every run without an enqueue must be explained by a PolicyDecision
  const enqueuedAt = new Set(
    tasks.map((t) => (t.payload as { scheduledAt: number }).scheduledAt),
  );
  const decisionAt = new Set(decisions.map((d) => (d.data as { runAt: number }).runAt));
  for (const now of runs) {
    if (!enqueuedAt.has(now) && !decisionAt.has(now)) {
      throw new Error(`${label}: run at ${new Date(now).toISOString()} has no task and no PolicyDecision`);
    }
    if (enqueuedAt.has(now) && decisionAt.has(now)) {
      throw new Error(`${label}: run produced both a task and a skip decision`);
    }
  }
  for (const d of decisions) {
    if (!d.ctx.strategyVersionId) throw new Error(`${label}: PolicyDecision missing strategyVersionId`);
  }

  console.log(
    `${label}: ${tasks.length} tasks (${[...counts.entries()].map(([t, c]) => `${t}=${c}`).join(", ")}), ` +
      `${decisions.length} policy decisions, jitters ${jitters.map((j) => Math.round(j / 60000)).join("/")}min`,
  );
  return tasks;
}

const tasksA = await checkProfile(profileA, "A (08-12)", HOURS_A);
const tasksB = await checkProfile(profileB, "B (14-18)", HOURS_B);

const allJitters = [...tasksA, ...tasksB].map(
  (t) => t.dueAt - (t.payload as { scheduledAt: number }).scheduledAt,
);
if (allJitters.length >= 2 && new Set(allJitters).size === 1) {
  throw new Error("no jitter spread — all dueAt offsets identical");
}
if (tasksA.length === 0 || tasksB.length === 0) {
  throw new Error("expected at least one scheduled task per profile");
}

console.log("phase 9 OK — hours, budgets, jitter and PolicyDecision audit all hold");

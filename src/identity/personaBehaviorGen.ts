import { createHash } from "node:crypto";
import type { Persona } from "./personaGen.js";

type PersonaBehavior = Persona["behavior"];

const ACTIVE_HOUR_WINDOWS: Array<Array<{ start: number; end: number }>> = [
  [{ start: 7, end: 9 }, { start: 12, end: 13 }, { start: 17, end: 19 }],
  [{ start: 8, end: 11 }, { start: 14, end: 17 }],
  [{ start: 9, end: 12 }, { start: 19, end: 21 }],
  [{ start: 7, end: 10 }, { start: 16, end: 18 }],
  [{ start: 8, end: 12 }],
  [{ start: 10, end: 13 }, { start: 18, end: 20 }],
];

const WEEKDAY_PROFILES: Array<number[]> = [
  [0.95, 1, 0.95, 0.9, 0.85, 0.35, 0.25],
  [0.9, 0.95, 0.9, 0.85, 0.8, 0.4, 0.3],
  [0.85, 0.9, 0.85, 0.8, 0.75, 0.45, 0.35],
  [1, 0.95, 0.9, 0.85, 0.7, 0.3, 0.2],
];

const ACTION_MIX_PROFILES: Array<PersonaBehavior["actionMix"]> = [
  { warmup_feed: 45, engage_post: 18, send_invitation: 4, send_message: 6, fetch_profile: 27 },
  { warmup_feed: 50, engage_post: 15, send_invitation: 3, send_message: 5, fetch_profile: 27 },
  { warmup_feed: 40, engage_post: 20, send_invitation: 5, send_message: 8, fetch_profile: 27 },
  { warmup_feed: 48, engage_post: 14, send_invitation: 2, send_message: 4, fetch_profile: 32 },
];

function seedBucket(seed: string, salt: string, mod: number): number {
  const n = parseInt(createHash("sha256").update(`${seed}:${salt}`).digest("hex").slice(0, 8), 16);
  return n % mod;
}

/** Deterministic behavioral parameters — no LLM, reproducible from profile seed. */
export function generatePersonaBehavior(input: { seed: string; timezone: string }): PersonaBehavior {
  const hours = ACTIVE_HOUR_WINDOWS[seedBucket(input.seed, "hours", ACTIVE_HOUR_WINDOWS.length)];
  const weekdayActivity = WEEKDAY_PROFILES[seedBucket(input.seed, "weekday", WEEKDAY_PROFILES.length)];
  const actionMix = ACTION_MIX_PROFILES[seedBucket(input.seed, "actions", ACTION_MIX_PROFILES.length)];
  const sessionMin = seedBucket(input.seed, "sess-min", 2);
  const sessionMax = sessionMin + 1 + seedBucket(input.seed, "sess-max", 3);

  return {
    timezone: input.timezone,
    activeHours: hours,
    weekdayActivity,
    sessionsPerDay: { min: sessionMin, max: Math.min(sessionMax, 6) },
    actionMix,
  };
}

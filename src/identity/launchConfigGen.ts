import { createHash } from "node:crypto";
import { WINDOW_SIZES, clampWindowSize } from "../shared/constants.js";
import { localeForGeo } from "../shared/geo.js";

export interface LaunchConfig {
  timezone: string;
  locale: string;
  windowWidth: number;
  windowHeight: number;
  chromeVersion: string;
  fingerprintSeed: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  hash: string;
}

// Deterministic — no LLM. Timezone comes from the proxy geo (param),
// window size is seeded by the profile key, Chrome version is pinned via env.
export function generateLaunchConfig(input: {
  profileKey: string;
  geo: string;
  timezone: string;
}): LaunchConfig {
  const locale = localeForGeo(input.geo);
  const seed = parseInt(
    createHash("sha256").update(input.profileKey).digest("hex").slice(0, 8),
    16,
  );
  const picked = WINDOW_SIZES[seed % WINDOW_SIZES.length];
  const win = clampWindowSize(picked.width, picked.height);
  const chromeVersion = process.env.PINNED_CHROME_VERSION ?? "unpinned";
  const fingerprintSeed = createHash("sha256")
    .update(`${input.profileKey}:fp`)
    .digest("hex")
    .slice(0, 16);
  const hwPool = [4, 8, 8, 12, 16];
  const memPool = [4, 8, 8];
  const hardwareConcurrency = hwPool[seed % hwPool.length];
  const deviceMemory = memPool[(seed >>> 8) % memPool.length];

  const fields = {
    timezone: input.timezone,
    locale,
    windowWidth: win.width,
    windowHeight: win.height,
    chromeVersion,
    fingerprintSeed,
    hardwareConcurrency,
    deviceMemory,
  };
  const hash = createHash("sha256").update(JSON.stringify(fields)).digest("hex");
  return { ...fields, hash };
}

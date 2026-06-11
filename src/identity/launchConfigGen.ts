import { createHash } from "node:crypto";
import { WINDOW_SIZES } from "../shared/constants.js";

const GEO_LOCALES: Record<string, string> = {
  US: "en-US",
  GB: "en-GB",
  UK: "en-GB",
  IE: "en-IE",
  CA: "en-CA",
  AU: "en-AU",
  DE: "de-DE",
  AT: "de-AT",
  CH: "de-CH",
  FR: "fr-FR",
  ES: "es-ES",
  IT: "it-IT",
  NL: "nl-NL",
  BE: "nl-BE",
  SE: "sv-SE",
  DK: "da-DK",
  NO: "nb-NO",
  PL: "pl-PL",
  PT: "pt-PT",
  BR: "pt-BR",
};

export interface LaunchConfig {
  timezone: string;
  locale: string;
  windowWidth: number;
  windowHeight: number;
  chromeVersion: string;
  hash: string;
}

// Deterministic — no LLM. Timezone comes from the proxy geo (param),
// window size is seeded by the profile key, Chrome version is pinned via env.
export function generateLaunchConfig(input: {
  profileKey: string;
  geo: string;
  timezone: string;
}): LaunchConfig {
  const locale = GEO_LOCALES[input.geo.toUpperCase()] ?? "en-US";
  const seed = parseInt(
    createHash("sha256").update(input.profileKey).digest("hex").slice(0, 8),
    16,
  );
  const win = WINDOW_SIZES[seed % WINDOW_SIZES.length];
  const chromeVersion = process.env.PINNED_CHROME_VERSION ?? "unpinned";

  const fields = {
    timezone: input.timezone,
    locale,
    windowWidth: win.width,
    windowHeight: win.height,
    chromeVersion,
  };
  const hash = createHash("sha256").update(JSON.stringify(fields)).digest("hex");
  return { ...fields, hash };
}

// Geo → locale, timezone, and country defaults for persona/launch config provisioning.

export const GEO_LOCALES: Record<string, string> = {
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

export const GEO_TIMEZONES: Record<string, string> = {
  US: "America/New_York",
  GB: "Europe/London",
  UK: "Europe/London",
  IE: "Europe/Dublin",
  CA: "America/Toronto",
  AU: "Australia/Sydney",
  DE: "Europe/Berlin",
  AT: "Europe/Vienna",
  CH: "Europe/Zurich",
  FR: "Europe/Paris",
  ES: "Europe/Madrid",
  IT: "Europe/Rome",
  NL: "Europe/Amsterdam",
  BE: "Europe/Brussels",
  SE: "Europe/Stockholm",
  DK: "Europe/Copenhagen",
  NO: "Europe/Oslo",
  PL: "Europe/Warsaw",
  PT: "Europe/Lisbon",
  BR: "America/Sao_Paulo",
};

export const GEO_COUNTRIES: Record<string, string> = {
  US: "United States",
  GB: "United Kingdom",
  UK: "United Kingdom",
  IE: "Ireland",
  CA: "Canada",
  AU: "Australia",
  DE: "Germany",
  AT: "Austria",
  CH: "Switzerland",
  FR: "France",
  ES: "Spain",
  IT: "Italy",
  NL: "Netherlands",
  BE: "Belgium",
  SE: "Sweden",
  DK: "Denmark",
  NO: "Norway",
  PL: "Poland",
  PT: "Portugal",
  BR: "Brazil",
};

export function localeForGeo(geo: string): string {
  return GEO_LOCALES[geo.toUpperCase()] ?? "en-US";
}

export function timezoneForGeo(geo: string, fallback = "UTC"): string {
  return GEO_TIMEZONES[geo.toUpperCase()] ?? fallback;
}

export function countryForGeo(geo: string, fallback = "United States"): string {
  return GEO_COUNTRIES[geo.toUpperCase()] ?? fallback;
}

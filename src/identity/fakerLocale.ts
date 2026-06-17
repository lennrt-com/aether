import { allFakers, type Faker } from "@faker-js/faker";

/** Maps blessGTM geo codes to prebuilt Faker locale instances. */
const GEO_FAKER_KEY: Record<string, keyof typeof allFakers> = {
  US: "en_US",
  GB: "en_GB",
  UK: "en_GB",
  IE: "en_IE",
  CA: "en_CA",
  AU: "en_AU",
  DE: "de",
  AT: "de_AT",
  CH: "de_CH",
  FR: "fr",
  ES: "es",
  IT: "it",
  NL: "nl",
  BE: "nl_BE",
  SE: "sv",
  DK: "da",
  NO: "nb_NO",
  PL: "pl",
  PT: "pt_PT",
  BR: "pt_BR",
};

export function fakerForGeo(geo: string): Faker {
  const key = GEO_FAKER_KEY[geo.toUpperCase()] ?? "en_US";
  return allFakers[key];
}

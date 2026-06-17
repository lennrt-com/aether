import { createHash } from "node:crypto";
import { countryForGeo } from "../shared/geo.js";
import { fakerForGeo } from "./fakerLocale.js";

/** Raw profile ingredients from Faker — fed to the LLM for LinkedIn flattening. */
export interface PersonaRawSeed {
  seed: string;
  geo: string;
  roleArchetype: string;
  fullName: string;
  firstName: string;
  lastName: string;
  sex: string;
  jobTitle: string;
  jobArea: string;
  jobType: string;
  company: string;
  previousCompany: string;
  city: string;
  state: string;
  country: string;
  bioSnippet: string;
  companyBuzz: string;
  companyCatchphrase: string;
  productArea: string;
  department: string;
  yearsExperience: number;
  musicGenres: string[];
  bookGenres: string[];
  topicWords: string[];
  /** LinkedIn-style "City, Region, Country" — derived from city/state/country. */
  location: string;
}

function seedToNumber(seed: string): number {
  return parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16);
}

function pickUnique<T>(count: number, pick: () => T): T[] {
  const out = new Set<T>();
  let guard = 0;
  while (out.size < count && guard++ < count * 8) {
    out.add(pick());
  }
  return [...out];
}

/** Format a LinkedIn location string from seeded city/state/country. */
export function formatPersonaLocation(parts: {
  city: string;
  state?: string;
  country: string;
}): string {
  const city = parts.city.trim();
  const state = parts.state?.trim();
  const country = parts.country.trim();
  if (city && state && state.toLowerCase() !== city.toLowerCase()) {
    return `${city}, ${state}, ${country}`;
  }
  if (city) return `${city}, ${country}`;
  return country;
}

export function generatePersonaRawSeed(input: {
  seed: string;
  geo: string;
  roleArchetype: string;
}): PersonaRawSeed {
  const faker = fakerForGeo(input.geo);
  faker.seed(seedToNumber(input.seed));

  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  const fullName = faker.person.fullName();
  const musicGenres = pickUnique(3, () => faker.music.genre());
  const bookGenres = pickUnique(2, () => faker.book.genre());
  const topicWords = pickUnique(6, () => faker.word.noun());

  const city = faker.location.city();
  const state = faker.location.state();
  const country = countryForGeo(input.geo);

  return {
    seed: input.seed,
    geo: input.geo,
    roleArchetype: input.roleArchetype,
    fullName,
    firstName,
    lastName,
    sex: faker.person.sex(),
    jobTitle: faker.person.jobTitle(),
    jobArea: faker.person.jobArea(),
    jobType: faker.person.jobType(),
    company: faker.company.name(),
    previousCompany: faker.company.name(),
    city,
    state,
    country,
    location: formatPersonaLocation({ city, state, country }),
    bioSnippet: faker.person.bio(),
    companyBuzz: faker.company.buzzPhrase(),
    companyCatchphrase: faker.company.catchPhrase(),
    productArea: faker.commerce.productName(),
    department: faker.commerce.department(),
    yearsExperience: faker.number.int({ min: 2, max: 22 }),
    musicGenres,
    bookGenres,
    topicWords,
  };
}

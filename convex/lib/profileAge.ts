import type { Doc } from "../_generated/dataModel";

export type ProfileWithLegacyAge = Doc<"profiles"> & { accountAgeDays?: number };

export function resolveWarmupAgeDays(profile: ProfileWithLegacyAge): number {
  return profile.warmupAgeDays ?? profile.accountAgeDays ?? 0;
}

export function resolveLinkedInAgeDays(profile: Doc<"profiles">, now = Date.now()): number {
  if (profile.linkedinAgeDays !== undefined) return profile.linkedinAgeDays;
  if (profile.linkedinCreatedAt !== undefined) {
    return (now - profile.linkedinCreatedAt) / (24 * 60 * 60 * 1000);
  }
  return 0;
}

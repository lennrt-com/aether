// Profile helpers — mirror convex/lib/guards.ts (Convex can't import from src/).

export function isProfileRestricted(profile: {
  isRestricted?: boolean;
  status?: string;
}): boolean {
  return profile.isRestricted === true || profile.status === "restricted";
}

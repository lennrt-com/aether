// Profile helpers — mirror convex/lib/guards.ts (Convex can't import from src/).

export function isProfileDisabled(profile: {
  status?: string;
  maintained?: boolean;
}): boolean {
  return profile.status === "disabled" || profile.maintained === false;
}

/** @deprecated use isProfileDisabled */
export const isProfileRestricted = isProfileDisabled;

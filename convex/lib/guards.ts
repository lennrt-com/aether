// Worker auth + simple profile status transitions for Aether.

export function assertWorkerKey(key: string): void {
  const expected = process.env.WORKER_KEY;
  if (!expected) throw new Error("WORKER_KEY is not configured on the deployment");
  if (key !== expected) throw new Error("invalid worker key");
}

export type ProfileStatus = "provisioning" | "active" | "disabled";

export const ALLOWED_TRANSITIONS: Record<ProfileStatus, ProfileStatus[]> = {
  provisioning: ["active", "disabled"],
  active: ["disabled", "provisioning"],
  disabled: ["active", "provisioning"],
};

export function assertTransition(from: ProfileStatus, to: ProfileStatus): void {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`illegal profile transition: ${from} -> ${to}`);
  }
}

export function isProfileDisabled(profile: { status?: string; maintained?: boolean }): boolean {
  return profile.status === "disabled" || profile.maintained === false;
}

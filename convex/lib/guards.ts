// Worker auth + profile state machine guards (executionplan.md Appendix C).

export function assertWorkerKey(key: string): void {
  const expected = process.env.WORKER_KEY;
  if (!expected) throw new Error("WORKER_KEY is not configured on the deployment");
  if (key !== expected) throw new Error("invalid worker key");
}

export type ProfileStatus =
  | "provisioning" | "warming" | "active" | "cooldown"
  | "warning" | "restricted" | "recovering" | "retired";

export const ALLOWED_TRANSITIONS: Record<ProfileStatus, ProfileStatus[]> = {
  provisioning: ["warming", "restricted"],
  warming: ["active", "warning", "restricted", "retired"],
  active: ["cooldown", "warning", "restricted", "retired"],
  cooldown: ["active", "warning", "restricted"],
  warning: ["active", "restricted", "retired"],
  restricted: ["recovering", "retired"],
  recovering: ["warming", "restricted", "retired"],
  retired: [],
};

export function assertTransition(from: ProfileStatus, to: ProfileStatus): void {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`illegal profile transition: ${from} -> ${to}`);
  }
}

export function isProfileRestricted(profile: {
  isRestricted?: boolean;
  status?: string;
}): boolean {
  return profile.isRestricted === true || profile.status === "restricted";
}

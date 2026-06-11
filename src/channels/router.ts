import type { TaskType } from "../shared/types.js";

// Pinned channel map — no logic beyond lookup. Every action moved off the
// browser is one that can't trip behavioral detection.
export const CHANNEL: Record<TaskType, "api" | "browser"> = {
  send_message: "api",
  send_invitation: "api",
  fetch_profile: "api",
  browse: "browser",
  signup: "browser",
  login: "browser",
  warmup_feed: "browser",
  engage_post: "browser",
};

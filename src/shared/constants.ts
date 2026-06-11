// Pinned values from executionplan.md Appendix C/E. Do not tune for v1.
// convex/health.ts duplicates the risk constants (Convex can't import from src/).

export const RISK_WEIGHTS = {
  captcha: 15,
  checkpoint: 30,
  restriction: 100,
  anomaly: 5,
  http429: 10,
} as const;

export const RISK_HALF_LIFE_HOURS = 72;
export const RISK_WINDOW_DAYS = 14;
export const RISK_WARNING_THRESHOLD = 40; // >= 40 → warning
export const RISK_RECOVERY_THRESHOLD = 20; // < 20 while warning → active

// Task queue (Phase 2)
export const LEASE_MS = 10 * 60 * 1000;
export const WORKER_HEARTBEAT_MS = 2 * 60 * 1000;
export const WORKER_STALE_MS = 120 * 1000;
export const MAX_TASK_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = 30 * 60 * 1000; // * attempts

// Chrome profile snapshot prune list (Appendix C) — paths relative to userDataDir root.
export const SNAPSHOT_PRUNE_LIST = [
  "Default/Cache",
  "Default/Code Cache",
  "Default/GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "Crashpad",
  "BrowserMetrics",
] as const;

// Must survive pruning: Local State (root, cookie encryption key),
// Default/Network/Cookies, Default/Local Storage, Default/IndexedDB, Default/Preferences.
export const SNAPSHOT_MUST_KEEP = [
  "Local State",
  "Default/Network/Cookies",
  "Default/Local Storage",
  "Default/IndexedDB",
  "Default/Preferences",
] as const;

export const SNAPSHOT_MARKER_FILE = ".blessgtm-snapshot";

// Launch config window sizes (Phase 5) — picked by profileId hash.
export const WINDOW_SIZES = [
  { width: 1920, height: 1080 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 2560, height: 1440 },
] as const;

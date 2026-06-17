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

// Chrome profile snapshot prune list — paths relative to userDataDir root.
// Removed locally before archiving (rebuildable / non-identity).
export const SNAPSHOT_PRUNE_LIST = [
  "Default/Cache",
  "Default/Code Cache",
  "Default/GPUCache",
  "Default/DawnGraphiteCache",
  "Default/DawnWebGPUCache",
  "Default/Service Worker",
  "Default/Extensions",
  "Default/History",
  "Default/Sessions",
  "Default/Visited Links",
  "GrShaderCache",
  "ShaderCache",
  "Crashpad",
  "BrowserMetrics",
  "Safe Browsing",
  "optimization_guide_model_store",
  "component_crx_cache",
  "extensions_crx_cache",
] as const;

// Identity paths archived exclusively (whitelist) — see architecture.md §5.4.
export const SNAPSHOT_MUST_KEEP = [
  "Local State",
  "Default/Network/Cookies",
  "Default/Local Storage",
  "Default/Session Storage",
  "Default/IndexedDB",
  "Default/Preferences",
] as const;

/** Convex blob Content-Type for profile archives (gzip-compressed tar). */
export const SNAPSHOT_BLOB_CONTENT_TYPE = "application/gzip";

export const SNAPSHOT_MARKER_FILE = ".blessgtm-snapshot";

// Launch config window sizes (Phase 5) — picked by profileId hash.
// Capped at 1080p so local stealth testing stays manageable on big monitors.
export const MAX_WINDOW_WIDTH = 1920;
export const MAX_WINDOW_HEIGHT = 1080;

export const WINDOW_SIZES = [
  { width: 1920, height: 1080 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
] as const;

/** Scale down oversized launch configs (e.g. profiles provisioned before the 1080p cap). */
export function clampWindowSize(width: number, height: number): { width: number; height: number } {
  let w = width;
  let h = height;
  if (h > MAX_WINDOW_HEIGHT) {
    w = Math.round(w * (MAX_WINDOW_HEIGHT / h));
    h = MAX_WINDOW_HEIGHT;
  }
  if (w > MAX_WINDOW_WIDTH) {
    h = Math.round(h * (MAX_WINDOW_WIDTH / w));
    w = MAX_WINDOW_WIDTH;
  }
  return { width: w, height: h };
}

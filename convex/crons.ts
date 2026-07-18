import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Aether control-plane maintenance only — no LinkedIn/Unipile fleet loops.
crons.interval(
  "reclaim expired leases",
  { minutes: 1 },
  internal.tasks.reclaimExpiredLeases,
  {},
);

crons.daily(
  "snapshot retention",
  { hourUTC: 3, minuteUTC: 30 },
  internal.snapshots.applyRetention,
  {},
);

export default crons;

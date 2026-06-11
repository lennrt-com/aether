import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

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

crons.interval(
  "persona-driven scheduler",
  { minutes: 30 },
  internal.scheduler.cronRun,
  {},
);

export default crons;

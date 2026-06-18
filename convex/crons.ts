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

crons.interval(
  "restriction monitoring",
  { hours: 1 },
  internal.monitoring.runRestrictionChecks,
  {},
);

crons.interval(
  "warmup age bump",
  { hours: 1 },
  internal.age.bumpWarmupAge,
  {},
);

crons.interval(
  "linkedin age update",
  { hours: 1 },
  internal.age.updateLinkedInAge,
  {},
);

crons.interval(
  "provisioning rescue enqueue",
  { hours: 6 },
  internal.provisioningRescue.cronEnqueueRescue,
  {},
);

export default crons;

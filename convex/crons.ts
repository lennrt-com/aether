import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "reclaim expired leases",
  { minutes: 1 },
  internal.tasks.reclaimExpiredLeases,
  {},
);

export default crons;

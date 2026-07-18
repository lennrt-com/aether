import { query } from "./_generated/server";
import { requireUser } from "./lib/auth";

/** Aether fleet overview — jobs, workers, sessions, proxies. */
export const fleetOverview = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);

    const [tasks, sessions, workers, profiles, proxies] = await Promise.all([
      ctx.db.query("tasks").collect(),
      ctx.db.query("sessions").collect(),
      ctx.db.query("workers").collect(),
      ctx.db.query("profiles").collect(),
      ctx.db.query("proxyPool").withIndex("by_status", (q) => q.eq("status", "active")).collect(),
    ]);

    const agentTasks = tasks.filter((t) => t.type === "agent");
    const taskByStatus: Record<string, number> = {};
    for (const t of agentTasks) {
      taskByStatus[t.status] = (taskByStatus[t.status] ?? 0) + 1;
    }

    const runningSessions = sessions.filter((s) => s.status === "running").length;
    const recentSessions = sessions
      .slice()
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 20)
      .map((s) => ({
        id: s._id,
        profileId: s.profileId,
        taskId: s.taskId ?? null,
        status: s.status,
        channel: s.channel,
        startedAt: s.startedAt,
        endedAt: s.endedAt ?? null,
        outcome: s.outcome ?? null,
        egressIp: s.egressIp ?? null,
      }));

    const staleCutoff = Date.now() - 120_000;
    const workersOnline = workers.filter(
      (w) => w.status === "online" && w.lastHeartbeatAt >= staleCutoff,
    ).length;

    const ephemeralProfiles = profiles.filter((p) => p.ephemeral === true).length;
    const activeProfiles = profiles.filter((p) => p.activeSessionId !== undefined).length;

    const webhookStats = { pending: 0, delivered: 0, retrying: 0, failed: 0 };
    for (const t of agentTasks) {
      const status = t.webhookDelivery?.status;
      if (status && status in webhookStats) {
        webhookStats[status as keyof typeof webhookStats] += 1;
      }
    }

    return {
      jobs: {
        total: agentTasks.length,
        byStatus: taskByStatus,
        pending: taskByStatus.pending ?? 0,
        claimed: taskByStatus.claimed ?? 0,
        done: taskByStatus.done ?? 0,
        failed: taskByStatus.failed ?? 0,
        cancelled: taskByStatus.cancelled ?? 0,
      },
      webhooks: webhookStats,
      sessions: {
        running: runningSessions,
        total: sessions.length,
        recent: recentSessions,
      },
      workers: {
        total: workers.length,
        online: workersOnline,
      },
      profiles: {
        total: profiles.length,
        ephemeral: ephemeralProfiles,
        withActiveSession: activeProfiles,
      },
      proxies: {
        active: proxies.length,
      },
    };
  },
});

/** Recent browser sessions for the Sessions page. */
export const recentSessions = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const sessions = await ctx.db.query("sessions").collect();
    const profiles = await ctx.db.query("profiles").collect();
    const profileName = new Map(profiles.map((p) => [p._id, p.name]));

    return sessions
      .slice()
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 100)
      .map((s) => ({
        id: s._id,
        profileName: profileName.get(s.profileId) ?? s.profileId,
        profileId: s.profileId,
        taskId: s.taskId ?? null,
        status: s.status,
        channel: s.channel,
        startedAt: s.startedAt,
        endedAt: s.endedAt ?? null,
        outcome: s.outcome ?? null,
        egressIp: s.egressIp ?? null,
      }));
  },
});

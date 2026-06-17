// Sequential account-creation campaign runner.
// One browser session at a time; pacing and target checks live in Convex.
import "../shared/env.js";
import { number as numberPrompt, input, confirm } from "@inquirer/prompts";
import { api } from "../../convex/_generated/api.js";
import type { Doc, Id } from "../../convex/_generated/dataModel.js";
import { provisionProfile } from "../identity/provision.js";
import { timezoneForGeo } from "../shared/geo.js";
import { createConsoleReporter } from "../orchestrator/reporter.js";
import { promptCreateSharedSettings, type CreateOptions } from "../cli/createShared.js";
import {
  acctStamp,
  convex,
  spawnTsxScriptTagged,
  table,
  fmtTs,
  type ProxyPoolEntry,
} from "../cli/helpers.js";

const DEFAULT_PROBE_INTERVAL_MS = 0; // off unless --probe-interval set
const EMPTY_POOL_RETRY_MS = 5 * 60_000;

export interface CampaignRunOptions extends CreateOptions {
  id?: string;
  name?: string;
  target?: number;
  perHour?: number;
  probeIntervalMs?: number;
  proxyStrategy?: "rotate_pool" | "single";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function resolveProxyForAttempt(
  pool: ProxyPoolEntry[],
  attempt: {
    proxyStrategy: "rotate_pool" | "single";
    proxyPoolId: Id<"proxyPool"> | null;
    proxyCursor: number;
  },
): Promise<{ proxy: ProxyPoolEntry; geo: string; timezone: string } | null> {
  if (pool.length === 0) return null;

  if (attempt.proxyStrategy === "single" && attempt.proxyPoolId) {
    const entry = pool.find((p) => p._id === attempt.proxyPoolId);
    if (!entry) throw new Error(`proxy pool entry not found: ${attempt.proxyPoolId}`);
    return {
      proxy: entry,
      geo: entry.geo,
      timezone: entry.timezone ?? timezoneForGeo(entry.geo, "Europe/Berlin"),
    };
  }

  const entry = pool[attempt.proxyCursor % pool.length];
  return {
    proxy: entry,
    geo: entry.geo,
    timezone: entry.timezone ?? timezoneForGeo(entry.geo, "Europe/Berlin"),
  };
}

async function probeCampaignMembers(
  campaignId: Id<"campaigns">,
  probeIntervalMs: number,
  lastProbeAt: number,
): Promise<number> {
  if (probeIntervalMs <= 0) return lastProbeAt;
  const now = Date.now();
  if (now - lastProbeAt < probeIntervalMs) return lastProbeAt;

  const { client, workerKey } = convex();
  const members = (await client.query(api.campaigns.members, { campaignId })) as Doc<"profiles">[];
  const probeTargets = members.filter(
    (p) => p.linkedInProfileUrl && p.isRestricted !== true && p.status !== "restricted",
  );

  if (probeTargets.length > 0) {
    console.log(`[campaign] probing ${probeTargets.length} member(s) for restrictions...`);
    for (const p of probeTargets) {
      await client.mutation(api.monitoring.run, { workerKey, profileId: p._id });
      // Action is async in Convex — small gap between schedules.
      await sleep(500);
    }
  }

  return now;
}

export async function promptCampaignRunOptions(
  opts: CampaignRunOptions,
): Promise<CampaignRunOptions> {
  const { client } = convex();
  const shared = await promptCreateSharedSettings(client, opts);

  const target =
    opts.target ??
    (await numberPrompt({
      message: "Target number of healthy (non-restricted) accounts",
      default: 10,
      min: 1,
      required: true,
    }));

  const perHour =
    opts.perHour ??
    (await numberPrompt({
      message: "Max account creations per hour (even spacing)",
      default: 5,
      min: 1,
      max: 60,
      required: true,
    }));

  const name =
    opts.name ??
    (await input({
      message: "Campaign name",
      default: `campaign-${acctStamp()}`,
    }));

  let proxyStrategy = opts.proxyStrategy;
  if (!proxyStrategy && shared.useProxy) {
    const pool = (await client.query(api.proxyPool.list, { status: "active" })) as ProxyPoolEntry[];
    if (pool.length > 1) {
      proxyStrategy = (await confirm({
        message: "Rotate through all pool proxies (round-robin)?",
        default: true,
      }))
        ? "rotate_pool"
        : "single";
    } else {
      proxyStrategy = shared.resolved.poolEntry ? "single" : "rotate_pool";
    }
  } else if (!proxyStrategy) {
    proxyStrategy = "rotate_pool";
  }

  let probeIntervalMs = opts.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
  if (opts.probeIntervalMs === undefined) {
    const useFastProbe = await confirm({
      message: "Run extra restriction probes between signups (faster replenishment, more Unipile calls)?",
      default: false,
    });
    if (useFastProbe) {
      probeIntervalMs = 15 * 60_000;
    }
  }

  return {
    ...opts,
    geo: shared.geo,
    tz: shared.timezone,
    role: shared.role,
    model: shared.agentModel,
    personaModel: shared.personaModel,
    personaPrompt: shared.personaPrompt,
    location: shared.location,
    skipPreflight: shared.skipPreflight,
    noProxy: !shared.useProxy,
    proxyServer: shared.resolved.proxy?.server,
    proxyUser: shared.resolved.proxy?.username,
    proxyPass: shared.resolved.proxy?.password,
    proxyPoolId: shared.resolved.poolEntry?._id,
    name,
    target,
    perHour,
    proxyStrategy,
    probeIntervalMs,
  };
}

export async function runCampaign(opts: CampaignRunOptions): Promise<number> {
  const { client, workerKey } = convex();
  const reporter = createConsoleReporter();

  let campaignId = opts.id as Id<"campaigns"> | undefined;
  let campaign: Doc<"campaigns"> | null = null;

  if (campaignId) {
    campaign = (await client.query(api.campaigns.get, { campaignId })) as Doc<"campaigns"> | null;
    if (!campaign) throw new Error(`campaign not found: ${campaignId}`);
    if (campaign.status === "cancelled" || campaign.status === "done") {
      throw new Error(`campaign is ${campaign.status} — cannot resume`);
    }
    console.log(`[campaign] resuming ${campaign.name} (${campaignId})`);
  } else {
    const needsPrompt = opts.target == null || opts.perHour == null;
    const settings = needsPrompt ? await promptCampaignRunOptions(opts) : opts;

    if (settings.target == null || settings.perHour == null) {
      throw new Error("campaign requires --target and --per-hour");
    }

    const pool = (await client.query(api.proxyPool.list, { status: "active" })) as ProxyPoolEntry[];
    const useProxy = settings.noProxy !== true;
    if (useProxy && pool.length === 0 && !settings.proxyServer) {
      throw new Error("no active proxies in pool — add proxies with `bless proxy add` or pass --no-proxy");
    }

    const proxyStrategy = settings.proxyStrategy ?? (pool.length > 1 ? "rotate_pool" : "single");
    let proxyPoolId: Id<"proxyPool"> | undefined;
    if (proxyStrategy === "single") {
      if (settings.proxyPoolId) {
        proxyPoolId = settings.proxyPoolId as Id<"proxyPool">;
      } else if (pool.length === 1) {
        proxyPoolId = pool[0]._id;
      }
      if (useProxy && !proxyPoolId && !settings.proxyServer) {
        throw new Error("single proxy strategy requires --proxy-pool-id or a pool entry");
      }
    }

    const geo = settings.geo ?? pool[0]?.geo ?? process.env.DEFAULT_GEO ?? "DE";
    const timezone =
      settings.tz ??
      pool.find((p) => p._id === proxyPoolId)?.timezone ??
      timezoneForGeo(geo, process.env.DEFAULT_TZ ?? "Europe/Berlin");

    campaignId = await client.mutation(api.campaigns.create, {
      workerKey,
      name: settings.name ?? `campaign-${acctStamp()}`,
      targetHealthy: settings.target,
      maxPerHour: settings.perHour,
      geo,
      timezone,
      role: settings.role,
      agentModel: settings.model,
      personaModel: settings.personaModel,
      personaPrompt: settings.personaPrompt,
      location: settings.location,
      skipPreflight: settings.skipPreflight,
      proxyStrategy,
      proxyPoolId,
    });
    campaign = (await client.query(api.campaigns.get, { campaignId })) as Doc<"campaigns">;
    console.log(
      `[campaign] started ${campaign!.name} (${campaignId}) — target ${campaign!.targetHealthy} healthy, max ${campaign!.maxPerHour}/hr`,
    );
  }

  const probeIntervalMs = opts.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
  let lastProbeAt = 0;

  for (;;) {
    campaign = (await client.query(api.campaigns.get, { campaignId: campaignId! })) as Doc<"campaigns">;
    if (!campaign) throw new Error(`campaign disappeared: ${campaignId}`);

    if (campaign.status === "cancelled" || campaign.status === "done") {
      console.log(`[campaign] stopped (${campaign.status})`);
      return 0;
    }

    if (campaign.status === "paused") {
      console.log("[campaign] paused — checking again in 30s");
      await sleep(30_000);
      continue;
    }

    lastProbeAt = await probeCampaignMembers(campaignId!, probeIntervalMs, lastProbeAt);

    const attempt = await client.mutation(api.campaigns.beginAttempt, {
      workerKey,
      campaignId: campaignId!,
    });

    if (!attempt.go) {
      const s = attempt.stats;
      if (s) {
        reporter.info(
          `${attempt.reason}: healthy ${s.healthy}/${s.targetHealthy} ` +
            `(restricted ${s.restricted}, pending ${s.pending}) — wait ${Math.ceil(attempt.waitMs / 1000)}s`,
        );
      } else {
        reporter.info(`${attempt.reason} — wait ${Math.ceil(attempt.waitMs / 1000)}s`);
      }
      await sleep(attempt.waitMs);
      continue;
    }

    const pool = (await client.query(api.proxyPool.list, { status: "active" })) as ProxyPoolEntry[];
    const resolved = await resolveProxyForAttempt(pool, {
      proxyStrategy: attempt.proxyStrategy,
      proxyPoolId: attempt.proxyPoolId,
      proxyCursor: attempt.proxyCursor,
    });

    if (!resolved && campaign.geo) {
      // Direct connection fallback only when campaign explicitly allows no proxy.
      reporter.info("no proxy pool entries — provisioning without proxy (direct)");
    } else if (!resolved) {
      console.error("[campaign] no active proxies in pool — retrying in 5 min");
      await sleep(EMPTY_POOL_RETRY_MS);
      continue;
    }

    const geo = resolved?.geo ?? campaign.geo ?? process.env.DEFAULT_GEO ?? "DE";
    const timezone =
      resolved?.timezone ??
      campaign.timezone ??
      timezoneForGeo(geo, process.env.DEFAULT_TZ ?? "Europe/Berlin");

    const profileName = `${campaign.name}-${attempt.attemptIndex}-${acctStamp()}`;
    reporter.phase(`provisioning ${profileName} (${geo}${resolved ? ` via ${resolved.proxy.label}` : ""})`);

    const { profileId, launchConfig } = await provisionProfile(client, workerKey, {
      name: profileName,
      geo,
      timezone,
      role: campaign.role ?? "experienced professional",
      personaModel: campaign.personaModel,
      personaPrompt: campaign.personaPrompt,
      location: campaign.location,
      proxy: resolved?.proxy
        ? {
            server: resolved.proxy.server,
            username: resolved.proxy.username,
            password: resolved.proxy.password,
          }
        : undefined,
      stayProvisioning: true,
      log: reporter,
    });

    await client.mutation(api.campaigns.attachProfile, {
      workerKey,
      campaignId: campaignId!,
      profileId,
    });

    reporter.phase(`signup ${profileName} (${profileId})`);
    const orchArgs: string[] = [profileId];
    if (campaign.agentModel) orchArgs.push("--model", campaign.agentModel);
    if (campaign.skipPreflight) orchArgs.push("--skip-preflight");

    const signupResult = await spawnTsxScriptTagged(
      profileName,
      "src/orchestrator/signup.ts",
      orchArgs,
      { TZ: launchConfig.timezone },
    );

    if (signupResult.code !== 0) {
      reporter.info(`signup failed for ${profileName} — orphan left in provisioning (clean up with bless remove)`);
    } else {
      reporter.phase(`signup succeeded for ${profileName}`);
      const profile = (await client.query(api.profiles.get, { profileId })) as Doc<"profiles"> | null;
      if (profile?.linkedInProfileUrl) {
        await client.mutation(api.monitoring.run, { workerKey, profileId });
        reporter.info("scheduled immediate restriction probe");
      }
    }

    const stats = await client.query(api.campaigns.stats, { campaignId: campaignId! });
    console.log(
      `[campaign] progress: healthy ${stats.healthy}/${stats.targetHealthy}, ` +
        `restricted ${stats.restricted}, pending ${stats.pending}, total ${stats.total}`,
    );
  }
}

export async function listCampaigns(): Promise<void> {
  const { client } = convex();
  const campaigns = (await client.query(api.campaigns.list, {})) as Doc<"campaigns">[];
  if (campaigns.length === 0) {
    console.log("(no campaigns)");
    return;
  }

  const rows = [];
  for (const c of campaigns) {
    const stats = await client.query(api.campaigns.stats, { campaignId: c._id });
    rows.push({
      id: c._id,
      name: c.name,
      status: c.status,
      healthy: `${stats.healthy}/${stats.targetHealthy}`,
      restricted: stats.restricted,
      pending: stats.pending,
      maxPerHour: c.maxPerHour,
      lastAttempt: c.lastAttemptStartedAt ? fmtTs(c.lastAttemptStartedAt) : "-",
    });
  }
  table(rows);
}

export async function showCampaignStatus(campaignId: string): Promise<number> {
  const { client } = convex();
  const id = campaignId as Id<"campaigns">;
  const campaign = (await client.query(api.campaigns.get, { campaignId: id })) as Doc<"campaigns"> | null;
  if (!campaign) {
    console.error(`campaign not found: ${campaignId}`);
    return 1;
  }

  const stats = await client.query(api.campaigns.stats, { campaignId: id });
  console.log(JSON.stringify({ campaign, stats }, null, 2));

  const members = (await client.query(api.campaigns.members, { campaignId: id })) as Doc<"profiles">[];
  if (members.length > 0) {
    console.log("\nmembers:");
    table(
      members.map((p) => ({
        id: p._id,
        name: p.name,
        status: p.status,
        restricted: p.isRestricted ? "yes" : "no",
        linkedin: p.linkedInProfileUrl ?? "-",
      })),
    );
  }
  return 0;
}

export async function setCampaignStatus(
  campaignId: string,
  status: "paused" | "running" | "cancelled" | "done",
): Promise<number> {
  const { client, workerKey } = convex();
  await client.mutation(api.campaigns.setStatus, {
    workerKey,
    campaignId: campaignId as Id<"campaigns">,
    status,
  });
  console.log(`campaign ${campaignId} -> ${status}`);
  return 0;
}

// CLI entry when run directly: node --import tsx src/campaign/main.ts
const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("src/campaign/main.ts");
if (isMain) {
  const args = process.argv.slice(2);
  const opts: CampaignRunOptions = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--id" && args[i + 1]) opts.id = args[++i];
    else if (a === "--target" && args[i + 1]) opts.target = Number(args[++i]);
    else if (a === "--per-hour" && args[i + 1]) opts.perHour = Number(args[++i]);
    else if (a === "--name" && args[i + 1]) opts.name = args[++i];
    else if (a === "--probe-interval" && args[i + 1]) opts.probeIntervalMs = Number(args[++i]) * 60_000;
  }
  process.exitCode = await runCampaign(opts);
}

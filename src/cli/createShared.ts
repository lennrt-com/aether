import { select, input, confirm, number as numberPrompt } from "@inquirer/prompts";
import { api } from "../../convex/_generated/api.js";
import type { ConvexHttpClient } from "convex/browser";
import { AGENT_MODEL_CHOICES } from "../shared/agentModels.js";
import { PERSONA_MODEL_CHOICES } from "../shared/personaModels.js";
import { timezoneForGeo } from "../shared/geo.js";
import {
  acctStamp,
  resolveProxyForCli,
  type ProxyPoolEntry,
  type ResolvedProxy,
} from "./helpers.js";

export interface CreateOptions {
  name?: string;
  geo?: string;
  tz?: string;
  role?: string;
  proxyPoolId?: string;
  noProxy?: boolean;
  proxyServer?: string;
  proxyUser?: string;
  proxyPass?: string;
  personaPrompt?: string;
  location?: string;
  maxSteps?: string;
  skipPreflight?: boolean | undefined;
  model?: string;
  personaModel?: string;
}

export interface CreateParallelOptions extends CreateOptions {
  count?: number;
}

export interface SharedCreateSettings {
  geo: string;
  timezone: string;
  role: string;
  agentModel: string;
  personaModel: string;
  personaPrompt?: string;
  location?: string;
  skipPreflight: boolean;
  useProxy: boolean;
  resolved: ResolvedProxy;
}

const DEFAULT_PARALLEL_CREATE_MAX = Number(process.env.PARALLEL_CREATE_MAX ?? 10);

/** Interactive prompts shared by single and parallel account creation. */
export async function promptCreateSharedSettings(
  client: ConvexHttpClient,
  opts: CreateOptions,
): Promise<SharedCreateSettings> {
  const resolved = await resolveProxyForCli(client, {
    noProxy: opts.noProxy,
    proxyPoolId: opts.proxyPoolId,
    proxyServer: opts.proxyServer,
    proxyUser: opts.proxyUser,
    proxyPass: opts.proxyPass,
  });
  const useProxy = resolved.useProxy;
  const selectedProxy = resolved.poolEntry ?? null;

  let geo = opts.geo ?? selectedProxy?.geo ?? process.env.DEFAULT_GEO ?? "DE";
  if (!opts.geo && !selectedProxy) {
    geo = await input({
      message: "Persona location (geo code)",
      default: geo,
    });
  } else if (selectedProxy && !opts.geo) {
    const editGeo = await confirm({
      message: `Use proxy geo ${selectedProxy.geo}?`,
      default: true,
    });
    if (!editGeo) {
      geo = await input({ message: "Persona location (geo code)", default: selectedProxy.geo });
    } else {
      geo = selectedProxy.geo;
    }
  }

  const timezone =
    opts.tz ??
    selectedProxy?.timezone ??
    timezoneForGeo(geo, process.env.DEFAULT_TZ ?? "Europe/Berlin");

  const agentModel =
    opts.model ??
    (await select({
      message: "Agent model (browser automation)",
      choices: AGENT_MODEL_CHOICES.map((m) => ({ name: m, value: m })),
      default: "claude-sonnet-4-6",
    }));

  const personaModel =
    opts.personaModel ??
    (await select({
      message: "Persona model (identity generation)",
      choices: PERSONA_MODEL_CHOICES.map((m) => ({ name: m, value: m })),
      default: "gemini-3-flash-preview",
    }));

  let personaPrompt = opts.personaPrompt;
  if (!personaPrompt) {
    personaPrompt = await input({
      message: "Persona creative prompt (optional)",
      default: "",
    });
    if (!personaPrompt.trim()) personaPrompt = undefined;
  }

  let location = opts.location;
  if (!location) {
    location = await input({
      message: "LinkedIn location override (optional — Faker picks a city if blank)",
      default: "",
    });
    if (!location.trim()) location = undefined;
  }

  const role = opts.role ?? "experienced professional";

  const skipPreflight =
    opts.skipPreflight === true
      ? true
      : opts.skipPreflight === false
        ? false
        : await select({
            message: "Before LinkedIn signup",
            choices: [
              {
                name: "Run proxy + fingerprint checks (recommended for new setups)",
                value: false,
              },
              {
                name: "Skip checks — go to LinkedIn signup directly",
                value: true,
              },
            ],
            default: false,
          });

  if (useProxy && !resolved.proxy) {
    throw new Error("no proxy configured");
  }

  return {
    geo,
    timezone,
    role,
    agentModel,
    personaModel,
    personaPrompt,
    location,
    skipPreflight,
    useProxy,
    resolved,
  };
}

export interface ParallelJobTarget {
  name: string;
  geo: string;
  timezone: string;
  proxy?: { server: string; username?: string; password?: string };
  poolEntry?: ProxyPoolEntry;
}

function jobFromPoolEntry(
  name: string,
  entry: ProxyPoolEntry,
  geo: string,
  timezone: string,
): ParallelJobTarget {
  return {
    name,
    geo,
    timezone,
    proxy: {
      server: entry.server,
      username: entry.username,
      password: entry.password,
    },
    poolEntry: entry,
  };
}

/**
 * Assign proxies/geo per parallel slot.
 * Uses the explicitly selected proxy for all jobs unless rotatePool is true.
 */
export function planParallelJobs(
  count: number,
  shared: SharedCreateSettings,
  pool: ProxyPoolEntry[],
  rotatePool: boolean,
): ParallelJobTarget[] {
  const stamp = acctStamp();
  const jobs: ParallelJobTarget[] = [];
  const selected = shared.resolved.poolEntry;

  for (let i = 0; i < count; i++) {
    const name = `acct-${stamp}-${i + 1}`;
    if (!shared.useProxy) {
      jobs.push({
        name,
        geo: shared.geo,
        timezone: shared.timezone,
      });
      continue;
    }

    if (rotatePool && pool.length > 0) {
      const entry = pool[i % pool.length];
      jobs.push(
        jobFromPoolEntry(
          name,
          entry,
          entry.geo,
          entry.timezone ?? timezoneForGeo(entry.geo, shared.timezone),
        ),
      );
      continue;
    }

    if (selected) {
      jobs.push(jobFromPoolEntry(name, selected, shared.geo, shared.timezone));
      continue;
    }

    jobs.push({
      name,
      geo: shared.geo,
      timezone: shared.timezone,
      proxy: shared.resolved.proxy,
      poolEntry: shared.resolved.poolEntry,
    });
  }

  return jobs;
}

/** Whether parallel create should round-robin the pool vs use the selected proxy for all. */
export async function promptParallelProxyRotation(
  count: number,
  shared: SharedCreateSettings,
  pool: ProxyPoolEntry[],
  opts: CreateParallelOptions,
): Promise<boolean> {
  if (!shared.useProxy || count <= 1 || pool.length <= 1) return false;
  if (shared.resolved.poolEntry || opts.proxyPoolId) return false;
  return confirm({
    message: `Rotate through all ${pool.length} pool proxies (round-robin)?`,
    default: false,
  });
}

export async function promptParallelCount(explicit?: number): Promise<number> {
  if (explicit != null) {
    if (!Number.isInteger(explicit) || explicit < 1 || explicit > DEFAULT_PARALLEL_CREATE_MAX) {
      throw new Error(`count must be an integer from 1 to ${DEFAULT_PARALLEL_CREATE_MAX}`);
    }
    return explicit;
  }

  return numberPrompt({
    message: "How many accounts to create in parallel?",
    default: 2,
    min: 1,
    max: DEFAULT_PARALLEL_CREATE_MAX,
    required: true,
  });
}

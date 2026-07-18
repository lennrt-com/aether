import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { appendEvent } from "../events";

const WINDOW_SIZES = [
  { width: 1920, height: 1080 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
] as const;

/** Deterministic hash for Convex mutations (default runtime — no Node crypto). */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hashHex(input: string, length: number): string {
  let out = "";
  let seed = input;
  while (out.length < length) {
    out += fnv1a32(seed).toString(16).padStart(8, "0");
    seed = `${seed}:${out.length}`;
  }
  return out.slice(0, length);
}

function localeForGeo(geo: string): string {
  const map: Record<string, string> = {
    US: "en-US",
    DE: "de-DE",
    GB: "en-GB",
    FR: "fr-FR",
  };
  return map[geo.toUpperCase()] ?? "en-US";
}

function launchConfigForProfile(profileId: string, geo: string, timezone: string) {
  const seed = parseInt(hashHex(profileId, 8), 16);
  const picked = WINDOW_SIZES[seed % WINDOW_SIZES.length];
  const chromeVersion = process.env.PINNED_CHROME_VERSION ?? "unpinned";
  const fingerprintSeed = hashHex(`${profileId}:fp`, 16);
  const hwPool = [4, 8, 8, 12, 16];
  const memPool = [4, 8, 8];
  const fields = {
    timezone,
    locale: localeForGeo(geo),
    windowWidth: picked.width,
    windowHeight: picked.height,
    chromeVersion,
    fingerprintSeed,
    hardwareConcurrency: hwPool[seed % hwPool.length],
    deviceMemory: memPool[(seed >>> 8) % memPool.length],
  };
  const hash = hashHex(JSON.stringify(fields), 64);
  return { ...fields, hash };
}

export async function createEphemeralProfile(
  ctx: MutationCtx,
  opts: {
    name: string;
    geo?: string;
    timezone?: string;
    proxy?: { server: string; username?: string; password?: string };
  },
): Promise<Id<"profiles">> {
  const geo = opts.geo ?? "US";
  const timezone = opts.timezone ?? "UTC";
  const now = Date.now();

  const profileId = await ctx.db.insert("profiles", {
    name: opts.name,
    status: "active",
    riskScore: 0,
    chromeVersion: process.env.PINNED_CHROME_VERSION ?? "unpinned",
    ephemeral: true,
    maintained: true,
  });

  const launch = launchConfigForProfile(profileId, geo, timezone);
  const launchConfigId = await ctx.db.insert("launchConfigs", {
    profileId,
    version: 1,
    ...launch,
  });
  await ctx.db.patch(profileId, { launchConfigId, chromeVersion: launch.chromeVersion });

  if (opts.proxy) {
    const proxyBindingId = await ctx.db.insert("proxyBindings", {
      profileId,
      provider: "http",
      server: opts.proxy.server,
      username: opts.proxy.username,
      password: opts.proxy.password,
      geo,
      status: "active",
    });
    await ctx.db.patch(profileId, { proxyBindingId });
  }

  await appendEvent(ctx, {
    profileId,
    type: "ProfileProvisioned",
    ts: now,
    channel: "system",
    data: { ephemeral: true, launchConfigId },
    ctx: {},
  });

  return profileId;
}

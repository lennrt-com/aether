// bless — ops CLI for the LinkedIn multi-agent engine.
//   pnpm cli <command>   (or `bless <command>` when linked via package bin)
import "../shared/env.js";
import { Command } from "commander";
import { spawn } from "node:child_process";
import { input, confirm, password } from "@inquirer/prompts";
import { api } from "../../convex/_generated/api.js";
import type { Doc, Id } from "../../convex/_generated/dataModel.js";
import { AGENT_MODEL_CHOICES, resolveAgentModel } from "../shared/agentModels.js";
import { timezoneForGeo } from "../shared/geo.js";
import { convex, table, fmtTs, acctStamp, resolveProxyForCli, type ProxyPoolEntry } from "./helpers.js";
import { runCreateInteractive, runReset, showMainMenu } from "./interactive.js";

const program = new Command();
program
  .name("bless")
  .description(
    "Ops CLI for blessGTM — interactive account creation (step 1) and fleet worker (step 2)",
  );

function runScript(script: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("node", ["--import", "tsx", script, ...args], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", (err) => {
      console.error(String(err));
      resolve(1);
    });
  });
}

const AGENT_MODEL_OPTION_DESC =
  `agent LLM (${AGENT_MODEL_CHOICES.join(" | ")}, default: gemini-3-flash-preview)`;

// ---------------------------------------------------------------- provision
program
  .command("provision")
  .description("provision a complete identity bundle (persona, launch config, proxy)")
  .requiredOption("--name <name>")
  .requiredOption("--geo <geo>")
  .requiredOption("--tz <timezone>")
  .requiredOption("--proxy-server <hostPort>")
  .option("--proxy-user <user>")
  .option("--proxy-pass <pass>")
  .option("--role <role>", "persona role archetype", "experienced professional")
  .option("--persona-model <alias>", "persona LLM model")
  .option("--persona-prompt <text>", "optional persona creative prompt")
  .option("--stay-provisioning", "leave the profile in provisioning for a follow-up signup task")
  .action(async (opts) => {
    const args = [
      "--name", opts.name,
      "--geo", opts.geo,
      "--tz", opts.tz,
      "--proxy-server", opts.proxyServer,
      "--role", opts.role,
    ];
    if (opts.proxyUser) args.push("--proxy-user", opts.proxyUser);
    if (opts.proxyPass) args.push("--proxy-pass", opts.proxyPass);
    if (opts.personaModel) args.push("--persona-model", opts.personaModel);
    if (opts.personaPrompt) args.push("--persona-prompt", opts.personaPrompt);
    if (opts.stayProvisioning) args.push("--stay-provisioning");
    process.exitCode = await runScript("scripts/provision-profile.ts", args);
  });

// ------------------------------------------------------------------- create
program
  .command("create")
  .description(
    "interactive: provision identity + run LinkedIn signup in foreground (no worker)",
  )
  .option("--name <name>", "profile label (default: acct-<timestamp>)")
  .option("--geo <geo>", "persona/proxy geo")
  .option("--tz <timezone>", "IANA timezone")
  .option("--role <role>", "persona role archetype", "experienced professional")
  .option("--proxy-pool-id <id>", "proxy pool entry id")
  .option("--proxy-server <hostPort>", "proxy server (bypasses pool)")
  .option("--proxy-user <user>")
  .option("--proxy-pass <pass>")
  .option("--no-proxy", "launch without a proxy (direct connection)")
  .option("--persona-prompt <text>", "optional persona creative prompt")
  .option("--persona-model <alias>", "persona LLM model")
  .option("--max-steps <n>", "signup agent step budget")
  .option("--skip-preflight", "skip proxy + fingerprint checks; go to LinkedIn signup directly")
  .option("--model <alias>", AGENT_MODEL_OPTION_DESC, "gemini-3-flash-preview")
  .action(async (opts) => {
    process.exitCode = await runCreateInteractive({
      name: opts.name,
      geo: opts.geo,
      tz: opts.tz,
      role: opts.role,
      proxyPoolId: opts.proxyPoolId,
      noProxy: opts.proxy === false,
      proxyServer: opts.proxyServer,
      proxyUser: opts.proxyUser,
      proxyPass: opts.proxyPass,
      personaPrompt: opts.personaPrompt,
      personaModel: opts.personaModel,
      maxSteps: opts.maxSteps,
      skipPreflight: opts.skipPreflight,
      model: opts.model,
    });
  });

// ------------------------------------------------------------------- proxy
const proxyCmd = program.command("proxy").description("manage persistent proxy pool");

proxyCmd
  .command("list")
  .description("list proxies in the pool")
  .option("--all", "include disabled entries")
  .action(async (opts) => {
    const { client } = convex();
    const entries = (await client.query(
      api.proxyPool.list,
      opts.all ? {} : { status: "active" },
    )) as ProxyPoolEntry[];
    table(
      entries.map((p) => ({
        id: p._id,
        label: p.label,
        server: p.server,
        user: p.username ?? "-",
        geo: p.geo,
        timezone: p.timezone ?? "-",
        status: p.status,
      })),
    );
  });

proxyCmd
  .command("add")
  .description("add a proxy to the pool")
  .option("--label <label>")
  .option("--server <hostPort>")
  .option("--user <user>")
  .option("--pass <pass>")
  .option("--geo <geo>")
  .option("--tz <timezone>")
  .option("--notes <notes>")
  .action(async (opts) => {
    const { client, workerKey } = convex();
    const label =
      opts.label ??
      (await input({ message: "Label (short name)", default: `proxy-${acctStamp()}` }));
    const server =
      opts.server ?? (await input({ message: "Proxy server (host:port)" }));
    const username =
      opts.user ??
      (await input({
        message: "Proxy username",
        default: process.env.PROXY_USERNAME ?? "",
      })).trim();
    const pass =
      opts.pass ??
      (await password({
        message: "Proxy password",
        mask: "*",
      }));
    const geo =
      opts.geo ??
      (await input({ message: "Geo code (e.g. DE, US)", default: process.env.DEFAULT_GEO ?? "DE" }));
    const timezone =
      opts.tz ?? timezoneForGeo(geo, process.env.DEFAULT_TZ ?? "Europe/Berlin");
    const notes = opts.notes;

    const id = await client.mutation(api.proxyPool.add, {
      workerKey,
      label,
      server,
      username: username || undefined,
      password: pass || undefined,
      geo,
      timezone,
      notes: notes || undefined,
    });
    console.log(`proxy added: ${id} (${label}, ${server}, ${geo})`);
  });

proxyCmd
  .command("remove <proxyPoolId>")
  .description("remove a proxy from the pool")
  .action(async (proxyPoolId) => {
    const { client, workerKey } = convex();
    const ok = await confirm({
      message: `Remove proxy ${proxyPoolId}?`,
      default: false,
    });
    if (!ok) {
      console.log("cancelled");
      return;
    }
    const res = (await client.mutation(api.proxyPool.remove, {
      workerKey,
      proxyPoolId: proxyPoolId as Id<"proxyPool">,
    })) as { removed: boolean; label: string };
    console.log(`removed proxy "${res.label}"`);
  });

// ------------------------------------------------------------------- reset
program
  .command("reset")
  .description(
    "wipe moving DB state + local profile files (keeps proxy pool, strategies, accounts with credentials)",
  )
  .option("--yes", "skip confirmation prompt")
  .action(async (opts) => {
    await runReset(opts.yes ?? false);
  });

// ------------------------------------------------------------------- launch
program
  .command("launch [profileId]")
  .description("open a profile in a manual (non-automated) browser for hands-on testing")
  .option("--create", "provision a fresh profile first, then launch it")
  .option("--name <name>", "profile label when creating (default: manual-<timestamp>)")
  .option("--geo <geo>", "geo when creating", process.env.DEFAULT_GEO ?? "DE")
  .option("--tz <timezone>", "timezone when creating", process.env.DEFAULT_TZ ?? "Europe/Berlin")
  .option("--role <role>", "persona role when creating", "experienced professional")
  .option("--proxy-server <hostPort>", "proxy (defaults to PROXY_SERVER env)")
  .option("--proxy-user <user>", "defaults to PROXY_USERNAME env")
  .option("--proxy-pass <pass>", "defaults to PROXY_PASSWORD env")
  .option("--no-proxy", "launch/create without a proxy (direct connection)")
  .option("--force", "release a stale active session on the profile before launching")
  .option("--raw", "launch Chrome directly with NO Stagehand/CDP (true clean browser; fingerprint baseline)")
  .option("--url <url>", "start URL (default: the fingerprint scanner)")
  .action(async (profileIdArg, opts) => {
    const { client, workerKey } = convex();
    let profileId = profileIdArg as Id<"profiles"> | undefined;
    let tz: string = process.env.TZ ?? "UTC";

    if (opts.create) {
      const name = opts.name ?? `manual-${acctStamp()}`;
      const proxyServer = opts.proxyServer ?? process.env.PROXY_SERVER;
      const useProxy = opts.proxy !== false && Boolean(proxyServer);
      if (opts.proxy !== false && !proxyServer) {
        console.log("no proxy configured — launching direct");
      }

      const { provisionProfile } = await import("../identity/provision.js");
      const { profileId: newId, persona } = await provisionProfile(client, workerKey, {
        name,
        geo: opts.geo,
        timezone: opts.tz,
        role: opts.role,
        proxy: useProxy
          ? {
              server: proxyServer as string,
              username: opts.proxyUser ?? process.env.PROXY_USERNAME,
              password: opts.proxyPass ?? process.env.PROXY_PASSWORD,
            }
          : undefined,
        stayProvisioning: true,
      });
      profileId = newId;
      tz = opts.tz;
      console.log(`\ncreated profile ${profileId} (${name}, persona ${persona.fullName})`);
    } else {
      if (!profileId) {
        throw new Error("provide a profileId, or use --create to provision a new one");
      }
      const profile = (await client.query(api.profiles.get, {
        profileId,
      })) as Doc<"profiles"> | null;
      if (!profile) throw new Error(`profile not found: ${profileId}`);
      if (profile.launchConfigId) {
        const lc = (await client.query(api.launchConfigs.get, {
          launchConfigId: profile.launchConfigId,
        })) as Doc<"launchConfigs"> | null;
        if (lc?.timezone) tz = lc.timezone;
      }
    }

    if (opts.force && profileId) {
      const res = (await client.mutation(api.sessions.forceRelease, {
        workerKey,
        profileId,
      })) as { released: boolean };
      if (res.released) console.log(`released stale active session on ${profileId}`);
    }

    const runner = opts.raw ? "src/runner/manualRaw.ts" : "src/runner/manual.ts";
    const args = ["--import", "tsx", runner, profileId as string];
    if (opts.url) args.push("--url", opts.url);

    const code = await new Promise<number>((resolve) => {
      const child = spawn("node", args, {
        stdio: "inherit",
        env: { ...process.env, TZ: tz },
      });
      child.on("exit", (c) => resolve(c ?? 1));
      child.on("error", (err) => {
        console.error(String(err));
        resolve(1);
      });
    });
    process.exitCode = code;
  });

// --------------------------------------------------------------- agent-test
program
  .command("agent-test [profileId]")
  .description("launch a profile and turn a live Stagehand agent loose on the page")
  .option("--create", "provision a fresh profile first, then run the agent on it")
  .option("--name <name>", "profile label when creating")
  .option("--geo <geo>", "geo when creating", process.env.DEFAULT_GEO ?? "DE")
  .option("--tz <timezone>", "timezone when creating", process.env.DEFAULT_TZ ?? "Europe/Berlin")
  .option("--role <role>", "persona role when creating", "experienced professional")
  .option("--proxy-server <hostPort>", "proxy (defaults to PROXY_SERVER env)")
  .option("--proxy-user <user>")
  .option("--proxy-pass <pass>")
  .option("--no-proxy", "launch/create without a proxy")
  .option("--force", "release a stale active session on the profile before launching")
  .option("--url <url>", "start URL")
  .option("--instruction <text>", "override the agent instruction")
  .option("--max-steps <n>", "agent step budget (default: 15)")
  .option("--model <alias>", AGENT_MODEL_OPTION_DESC, "gemini-3-flash-preview")
  .action(async (profileIdArg, opts) => {
    const { client, workerKey } = convex();
    let profileId = profileIdArg as Id<"profiles"> | undefined;
    let tz: string = process.env.TZ ?? "UTC";

    if (opts.create) {
      const name = opts.name ?? `agent-${acctStamp()}`;
      const proxyServer = opts.proxyServer ?? process.env.PROXY_SERVER;
      const useProxy = opts.proxy !== false && Boolean(proxyServer);

      const { provisionProfile } = await import("../identity/provision.js");
      const { profileId: newId, persona } = await provisionProfile(client, workerKey, {
        name,
        geo: opts.geo,
        timezone: opts.tz,
        role: opts.role,
        proxy: useProxy
          ? {
              server: proxyServer as string,
              username: opts.proxyUser ?? process.env.PROXY_USERNAME,
              password: opts.proxyPass ?? process.env.PROXY_PASSWORD,
            }
          : undefined,
        stayProvisioning: true,
      });
      profileId = newId;
      tz = opts.tz;
      console.log(`\ncreated profile ${profileId} (${name}, persona ${persona.fullName})`);
    } else {
      if (!profileId) throw new Error("provide a profileId, or use --create");
      const profile = (await client.query(api.profiles.get, { profileId })) as Doc<"profiles"> | null;
      if (!profile) throw new Error(`profile not found: ${profileId}`);
      if (profile.launchConfigId) {
        const lc = (await client.query(api.launchConfigs.get, {
          launchConfigId: profile.launchConfigId,
        })) as Doc<"launchConfigs"> | null;
        if (lc?.timezone) tz = lc.timezone;
      }
    }

    if (opts.force && profileId) {
      await client.mutation(api.sessions.forceRelease, { workerKey, profileId });
    }

    const args = ["--import", "tsx", "src/runner/agentTest.ts", profileId as string];
    if (opts.url) args.push("--url", opts.url);
    if (opts.instruction) args.push("--instruction", opts.instruction);
    if (opts.maxSteps) args.push("--max-steps", String(opts.maxSteps));
    args.push("--model", opts.model ?? "gemini-3-flash-preview");

    process.exitCode = await new Promise<number>((resolve) => {
      const child = spawn("node", args, {
        stdio: "inherit",
        env: { ...process.env, TZ: tz },
      });
      child.on("exit", (c) => resolve(c ?? 1));
      child.on("error", (err) => {
        console.error(String(err));
        resolve(1);
      });
    });
  });

// --------------------------------------------------------------- stealthtest
function normalizeStealthTestUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

program
  .command("stealthtest <url> [profileId]")
  .description("open a URL in the stealth-hardened browser (same setup as LinkedIn signup)")
  .option("--create", "provision a fresh profile first (default when profileId is omitted)")
  .option("--name <name>", "profile label when creating (default: stealth-<timestamp>)")
  .option("--geo <geo>", "geo when creating", process.env.DEFAULT_GEO ?? "DE")
  .option("--tz <timezone>", "timezone when creating", process.env.DEFAULT_TZ ?? "Europe/Berlin")
  .option("--role <role>", "persona role when creating", "experienced professional")
  .option("--proxy-pool-id <id>", "proxy pool entry id")
  .option("--proxy-server <hostPort>", "proxy (bypasses pool picker)")
  .option("--proxy-user <user>", "defaults to PROXY_USERNAME env")
  .option("--proxy-pass <pass>", "defaults to PROXY_PASSWORD env")
  .option("--no-proxy", "launch/create without a proxy (direct connection)")
  .option("--force", "release a stale active session on the profile before launching")
  .action(async (urlArg, profileIdArg, opts) => {
    const { client, workerKey } = convex();
    const url = normalizeStealthTestUrl(urlArg);
    let profileId = profileIdArg as Id<"profiles"> | undefined;
    let tz: string = process.env.TZ ?? "UTC";

    const shouldCreate = opts.create || !profileId;
    if (shouldCreate) {
      const name = opts.name ?? `stealth-${acctStamp()}`;

      const resolved = await resolveProxyForCli(
        client,
        {
          noProxy: opts.proxy === false,
          proxyPoolId: opts.proxyPoolId,
          proxyServer: opts.proxyServer,
          proxyUser: opts.proxyUser,
          proxyPass: opts.proxyPass,
        },
        "Proxy for stealth test",
      );

      const geo = opts.geo ?? resolved.poolEntry?.geo ?? process.env.DEFAULT_GEO ?? "DE";
      const tzForProfile =
        opts.tz ??
        resolved.poolEntry?.timezone ??
        timezoneForGeo(geo, process.env.DEFAULT_TZ ?? "Europe/Berlin");

      const { provisionProfile } = await import("../identity/provision.js");
      const { profileId: newId, persona } = await provisionProfile(client, workerKey, {
        name,
        geo,
        timezone: tzForProfile,
        role: opts.role,
        proxy: resolved.useProxy ? resolved.proxy : undefined,
        stayProvisioning: true,
      });
      profileId = newId;
      tz = tzForProfile;
      console.log(`\ncreated profile ${profileId} (${name}, persona ${persona.fullName})`);
    } else {
      const profile = (await client.query(api.profiles.get, {
        profileId,
      })) as Doc<"profiles"> | null;
      if (!profile) throw new Error(`profile not found: ${profileId}`);
      if (profile.launchConfigId) {
        const lc = (await client.query(api.launchConfigs.get, {
          launchConfigId: profile.launchConfigId,
        })) as Doc<"launchConfigs"> | null;
        if (lc?.timezone) tz = lc.timezone;
      }
    }

    if (opts.force && profileId) {
      const res = (await client.mutation(api.sessions.forceRelease, {
        workerKey,
        profileId,
      })) as { released: boolean };
      if (res.released) console.log(`released stale active session on ${profileId}`);
    }

    const args = ["--import", "tsx", "src/runner/stealthTest.ts", profileId as string, "--url", url];

    process.exitCode = await new Promise<number>((resolve) => {
      const child = spawn("node", args, {
        stdio: "inherit",
        env: { ...process.env, TZ: tz },
      });
      child.on("exit", (c) => resolve(c ?? 1));
      child.on("error", (err) => {
        console.error(String(err));
        resolve(1);
      });
    });
  });

// ------------------------------------------------------------- preflight-test
program
  .command("preflight-test [profileId]")
  .description("run proxy + fingerprint detector battery")
  .option("--create", "provision a fresh profile first")
  .option("--name <name>")
  .option("--geo <geo>", process.env.DEFAULT_GEO ?? "DE")
  .option("--tz <timezone>", process.env.DEFAULT_TZ ?? "Europe/Berlin")
  .option("--role <role>", "experienced professional")
  .option("--proxy-server <hostPort>")
  .option("--proxy-user <user>")
  .option("--proxy-pass <pass>")
  .option("--no-proxy")
  .option("--force")
  .option("--no-strict")
  .option("--json")
  .option("--keep-open")
  .action(async (profileIdArg, opts) => {
    const { client, workerKey } = convex();
    let profileId = profileIdArg as Id<"profiles"> | undefined;
    let tz: string = process.env.TZ ?? "UTC";

    if (opts.create) {
      const name = opts.name ?? `preflight-${acctStamp()}`;
      const proxyServer = opts.proxyServer ?? process.env.PROXY_SERVER;
      const useProxy = opts.proxy !== false && Boolean(proxyServer);

      const { provisionProfile } = await import("../identity/provision.js");
      const { profileId: newId, persona } = await provisionProfile(client, workerKey, {
        name,
        geo: opts.geo,
        timezone: opts.tz,
        role: opts.role,
        proxy: useProxy
          ? {
              server: proxyServer as string,
              username: opts.proxyUser ?? process.env.PROXY_USERNAME,
              password: opts.proxyPass ?? process.env.PROXY_PASSWORD,
            }
          : undefined,
        stayProvisioning: true,
      });
      profileId = newId;
      tz = opts.tz;
      console.log(`\ncreated profile ${profileId} (${name}, persona ${persona.fullName})`);
    } else {
      if (!profileId) throw new Error("provide a profileId, or use --create");
      const profile = (await client.query(api.profiles.get, { profileId })) as Doc<"profiles"> | null;
      if (!profile) throw new Error(`profile not found: ${profileId}`);
      if (profile.launchConfigId) {
        const lc = (await client.query(api.launchConfigs.get, {
          launchConfigId: profile.launchConfigId,
        })) as Doc<"launchConfigs"> | null;
        if (lc?.timezone) tz = lc.timezone;
      }
    }

    if (opts.force && profileId) {
      await client.mutation(api.sessions.forceRelease, { workerKey, profileId });
    }

    const args = ["--import", "tsx", "src/runner/preflightTest.ts", profileId as string];
    if (opts.noStrict) args.push("--strict=false");
    if (opts.json) args.push("--json");
    if (opts.keepOpen) args.push("--keep-open");

    process.exitCode = await new Promise<number>((resolve) => {
      const child = spawn("node", args, {
        stdio: "inherit",
        env: { ...process.env, TZ: tz },
      });
      child.on("exit", (c) => resolve(c ?? 1));
      child.on("error", (err) => {
        console.error(String(err));
        resolve(1);
      });
    });
  });

// -------------------------------------------------------- account lifecycle
async function enqueueTask(
  profileId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const { client, workerKey } = convex();
  const taskId = await client.mutation(api.tasks.enqueue, {
    workerKey,
    profileId: profileId as Id<"profiles">,
    type,
    payload,
  });
  console.log(`enqueued ${type} task: ${taskId}`);
}

program
  .command("signup <profileId>")
  .description("enqueue a LinkedIn signup task (worker picks it up)")
  .option("--max-steps <n>")
  .option("--skip-preflight")
  .option("--model <alias>", AGENT_MODEL_OPTION_DESC, "gemini-3-flash-preview")
  .action(async (profileId, opts) => {
    await enqueueTask(profileId, "signup", {
      ...(opts.maxSteps ? { maxSteps: Number(opts.maxSteps) } : {}),
      ...(opts.skipPreflight ? { skipPreflight: true } : {}),
      model: resolveAgentModel(opts.model),
    });
  });

program
  .command("login <profileId>")
  .description("enqueue a LinkedIn login task (uses stored credentials)")
  .option("--max-steps <n>")
  .option("--model <alias>", AGENT_MODEL_OPTION_DESC, "gemini-3-flash-preview")
  .action(async (profileId, opts) => {
    await enqueueTask(profileId, "login", {
      ...(opts.maxSteps ? { maxSteps: Number(opts.maxSteps) } : {}),
      model: resolveAgentModel(opts.model),
    });
  });

program
  .command("enqueue <profileId> <type>")
  .description("enqueue an arbitrary task (browse, warmup_feed, engage_post, ...)")
  .option("--payload <json>", "task payload as JSON", "{}")
  .option("--priority <n>", "task priority", "0")
  .action(async (profileId, type, opts) => {
    const { client, workerKey } = convex();
    const taskId = await client.mutation(api.tasks.enqueue, {
      workerKey,
      profileId: profileId as Id<"profiles">,
      type,
      payload: JSON.parse(opts.payload),
      priority: Number(opts.priority),
    });
    console.log(`enqueued ${type} task: ${taskId}`);
  });

// ------------------------------------------------------------------- worker
program
  .command("worker")
  .description("start the worker loop (step 2 — claims tasks, spawns runners)")
  .action(async () => {
    await import("../worker/main.js");
  });

// ------------------------------------------------------------------ fleet
program
  .command("profiles")
  .alias("ps")
  .description("list profiles with status and risk score")
  .option("--status <status>", "filter by profile status")
  .action(async (opts) => {
    const { client } = convex();
    const profiles: Doc<"profiles">[] = await client.query(api.profiles.list, {
      status: opts.status,
    });
    table(
      profiles.map((p) => ({
        id: p._id,
        name: p.name,
        status: p.status,
        maint: p.maintained === false ? "no" : "yes",
        risk: p.riskScore.toFixed(1),
        ageDays: p.accountAgeDays,
        linkedin: p.linkedInProfileUrl ?? "-",
        unipile: p.unipileAccountId ?? "-",
      })),
    );
  });

program
  .command("events <profileId>")
  .description("show the event chain for a profile")
  .option("--limit <n>", "max events to show", "50")
  .option("--tail", "follow new events (poll every 3s)")
  .action(async (profileId, opts) => {
    const { client } = convex();
    const id = profileId as Id<"profiles">;
    const print = (events: Array<{ ts: number; type: string; data: unknown }>) => {
      for (const e of events) {
        console.log(`${fmtTs(e.ts)}  ${e.type.padEnd(20)} ${JSON.stringify(e.data).slice(0, 240)}`);
      }
    };
    const events = await client.query(api.events.forProfile, { profileId: id });
    print(events.slice(-Number(opts.limit)));
    if (!opts.tail) return;
    let sinceTs = events.length > 0 ? events[events.length - 1].ts + 1 : Date.now();
    console.log("--- tailing (ctrl-c to stop) ---");
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      const fresh = await client.query(api.events.forProfile, { profileId: id, sinceTs });
      if (fresh.length > 0) {
        print(fresh);
        sinceTs = fresh[fresh.length - 1].ts + 1;
      }
    }
  });

program
  .command("status")
  .description("fleet overview: workers, queue depth, profiles by status")
  .action(async () => {
    const { client } = convex();
    const [workers, profiles, taskStats, proxyCount] = (await Promise.all([
      client.query(api.workers.list, {}),
      client.query(api.profiles.list, {}),
      client.query(api.tasks.stats, {}),
      client.query(api.proxyPool.list, { status: "active" }),
    ])) as [
      Array<Doc<"workers"> & { stale: boolean }>,
      Doc<"profiles">[],
      Record<string, number>,
      ProxyPoolEntry[],
    ];

    console.log(`proxy pool: ${proxyCount.length} active`);
    console.log("workers:");
    table(
      workers.map((w) => ({
        id: w._id,
        name: w.name,
        status: w.stale ? "stale" : w.status,
        lastHeartbeat: fmtTs(w.lastHeartbeatAt),
        maxSessions: w.maxSessions,
      })),
    );

    console.log("\ntasks:");
    table([taskStats]);

    const byStatus = new Map<string, number>();
    for (const p of profiles) byStatus.set(p.status, (byStatus.get(p.status) ?? 0) + 1);
    console.log("\nprofiles:");
    table([...byStatus.entries()].map(([status, count]) => ({ status, count })));
    const busy = profiles.filter((p) => p.activeSessionId !== undefined);
    if (busy.length > 0) {
      console.log(`\nactive sessions: ${busy.map((p) => `${p.name} (${p._id})`).join(", ")}`);
    }
  });

// ----------------------------------------------------------------- strategy
const strategy = program.command("strategy").description("show or approve strategy versions");

strategy
  .command("list", { isDefault: true })
  .description("list strategy versions")
  .action(async () => {
    const { client } = convex();
    const versions: Doc<"strategyVersions">[] = await client.query(api.policies.list, {});
    table(
      versions.map((s) => ({
        id: s._id,
        version: s.version,
        cohort: s.cohortTag,
        status: s.status,
        approvedBy: s.approvedBy ?? "-",
        notes: (s.notes ?? "").slice(0, 40),
      })),
    );
  });

strategy
  .command("approve <strategyVersionId>")
  .description("approve a draft strategy version")
  .option("--by <name>", "approver name", process.env.USERNAME ?? "cli")
  .action(async (strategyVersionId, opts) => {
    const { client, workerKey } = convex();
    await client.mutation(api.policies.approve, {
      workerKey,
      strategyVersionId: strategyVersionId as Id<"strategyVersions">,
      approvedBy: opts.by,
    });
    console.log(`approved strategy ${strategyVersionId} (by ${opts.by})`);
  });

// ------------------------------------------------------------------ unipile
const unipile = program.command("unipile").description("Unipile account/webhook management");

unipile
  .command("setup")
  .description("list connected Unipile accounts + register the webhook endpoint")
  .action(async () => {
    process.exitCode = await runScript("scripts/setup-unipile-webhook.ts", []);
  });

unipile
  .command("link <profileId> <accountId>")
  .description("link a profile to a connected Unipile account")
  .action(async (profileId, accountId) => {
    process.exitCode = await runScript("scripts/setup-unipile-webhook.ts", [
      "--link",
      profileId,
      accountId,
    ]);
  });

const args = process.argv.slice(2);
if (args.length === 0) {
  await showMainMenu();
} else {
  await program.parseAsync(process.argv);
}

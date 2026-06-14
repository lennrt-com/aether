// bless — ops CLI for the LinkedIn multi-agent engine.
//   pnpm cli <command>   (or `bless <command>` when linked via package bin)
import "../shared/env.js";
import { Command } from "commander";
import { spawn } from "node:child_process";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import type { Doc, Id } from "../../convex/_generated/dataModel.js";

const program = new Command();
program.name("bless").description("Ops CLI for the blessGTM LinkedIn engine");

function convex(): { client: ConvexHttpClient; workerKey: string } {
  const url = process.env.CONVEX_URL;
  const workerKey = process.env.WORKER_KEY;
  if (!url || !workerKey) throw new Error("CONVEX_URL/WORKER_KEY not set");
  return { client: new ConvexHttpClient(url), workerKey };
}

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

function table(rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)),
  );
  console.log(cols.map((c, i) => c.padEnd(widths[i])).join("  "));
  for (const row of rows) {
    console.log(cols.map((c, i) => String(row[c] ?? "").padEnd(widths[i])).join("  "));
  }
}

function fmtTs(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

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
    if (opts.stayProvisioning) args.push("--stay-provisioning");
    process.exitCode = await runScript("scripts/provision-profile.ts", args);
  });

// ------------------------------------------------------------------- create
program
  .command("create")
  .description("one-shot: provision a new identity and enqueue its LinkedIn signup task")
  .option("--name <name>", "profile label (default: acct-<timestamp>)")
  .option("--geo <geo>", "proxy/persona geo", process.env.DEFAULT_GEO ?? "DE")
  .option("--tz <timezone>", "IANA timezone", process.env.DEFAULT_TZ ?? "Europe/Berlin")
  .option("--role <role>", "persona role archetype", "experienced professional")
  .option("--proxy-server <hostPort>", "defaults to PROXY_SERVER env")
  .option("--proxy-user <user>", "defaults to PROXY_USERNAME env")
  .option("--proxy-pass <pass>", "defaults to PROXY_PASSWORD env")
  .option("--max-steps <n>", "signup agent step budget")
  .option("--skip-preflight", "skip the proxy/fingerprint preflight checks before signup")
  .action(async (opts) => {
    const proxyServer = opts.proxyServer ?? process.env.PROXY_SERVER;
    if (!proxyServer) {
      throw new Error("no proxy: pass --proxy-server or set PROXY_SERVER in .env");
    }
    const now = new Date();
    const stamp =
      `${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}` +
      `-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
    const name = opts.name ?? `acct-${stamp}`;

    const { client, workerKey } = convex();
    const { provisionProfile } = await import("../identity/provision.js");
    const { profileId, persona } = await provisionProfile(client, workerKey, {
      name,
      geo: opts.geo,
      timezone: opts.tz,
      role: opts.role,
      proxy: {
        server: proxyServer,
        username: opts.proxyUser ?? process.env.PROXY_USERNAME,
        password: opts.proxyPass ?? process.env.PROXY_PASSWORD,
      },
      stayProvisioning: true,
    });

    const taskId = await client.mutation(api.tasks.enqueue, {
      workerKey,
      profileId,
      type: "signup",
      payload: {
        ...(opts.maxSteps ? { maxSteps: Number(opts.maxSteps) } : {}),
        ...(opts.skipPreflight ? { skipPreflight: true } : {}),
      },
    });
    console.log(`\nsignup task enqueued: ${taskId}`);
    console.log(`profile: ${profileId} (${name}, persona ${persona.fullName})`);

    const workers = (await client.query(api.workers.list, {})) as Array<
      Doc<"workers"> & { stale: boolean }
    >;
    const online = workers.filter((w) => w.status === "online" && !w.stale);
    if (online.length === 0) {
      console.log("\nWARNING: no worker online — start one with `pnpm cli worker` to run the signup");
    } else {
      console.log(`\nworker(s) online: ${online.map((w) => w.name).join(", ")} — signup starts within ~15s`);
    }
    console.log(`watch progress:  pnpm cli events ${profileId} --tail`);
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
      const now = new Date();
      const stamp =
        `${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}` +
        `-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
      const name = opts.name ?? `manual-${stamp}`;

      // commander sets opts.proxy=false for --no-proxy, true otherwise.
      const proxyServer = opts.proxyServer ?? process.env.PROXY_SERVER;
      const useProxy = opts.proxy !== false && Boolean(proxyServer);
      if (opts.proxy !== false && !proxyServer) {
        console.log("no proxy configured (pass --proxy-server / PROXY_SERVER, or --no-proxy) — launching direct");
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
  .description("launch a profile and turn a live Stagehand agent loose on the page (default: grab the fingerprint visitorId)")
  .option("--create", "provision a fresh profile first, then run the agent on it")
  .option("--name <name>", "profile label when creating (default: agent-<timestamp>)")
  .option("--geo <geo>", "geo when creating", process.env.DEFAULT_GEO ?? "DE")
  .option("--tz <timezone>", "timezone when creating", process.env.DEFAULT_TZ ?? "Europe/Berlin")
  .option("--role <role>", "persona role when creating", "experienced professional")
  .option("--proxy-server <hostPort>", "proxy (defaults to PROXY_SERVER env)")
  .option("--proxy-user <user>", "defaults to PROXY_USERNAME env")
  .option("--proxy-pass <pass>", "defaults to PROXY_PASSWORD env")
  .option("--no-proxy", "launch/create without a proxy (direct connection)")
  .option("--force", "release a stale active session on the profile before launching")
  .option("--url <url>", "start URL (default: the fingerprint scanner)")
  .option("--instruction <text>", "override the agent instruction")
  .option("--max-steps <n>", "agent step budget (default: 15)")
  .action(async (profileIdArg, opts) => {
    const { client, workerKey } = convex();
    let profileId = profileIdArg as Id<"profiles"> | undefined;
    let tz: string = process.env.TZ ?? "UTC";

    if (opts.create) {
      const now = new Date();
      const stamp =
        `${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}` +
        `-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
      const name = opts.name ?? `agent-${stamp}`;

      const proxyServer = opts.proxyServer ?? process.env.PROXY_SERVER;
      const useProxy = opts.proxy !== false && Boolean(proxyServer);
      if (opts.proxy !== false && !proxyServer) {
        console.log("no proxy configured (pass --proxy-server / PROXY_SERVER, or --no-proxy) — launching direct");
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

    const args = ["--import", "tsx", "src/runner/agentTest.ts", profileId as string];
    if (opts.url) args.push("--url", opts.url);
    if (opts.instruction) args.push("--instruction", opts.instruction);
    if (opts.maxSteps) args.push("--max-steps", String(opts.maxSteps));

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
  .description("enqueue a LinkedIn account-creation task for a provisioning profile")
  .option("--max-steps <n>", "agent step budget")
  .option("--skip-preflight", "skip the proxy/fingerprint preflight checks before signup")
  .action(async (profileId, opts) => {
    await enqueueTask(profileId, "signup", {
      ...(opts.maxSteps ? { maxSteps: Number(opts.maxSteps) } : {}),
      ...(opts.skipPreflight ? { skipPreflight: true } : {}),
    });
  });

program
  .command("login <profileId>")
  .description("enqueue a LinkedIn login task (uses stored credentials)")
  .option("--max-steps <n>", "agent step budget")
  .action(async (profileId, opts) => {
    await enqueueTask(profileId, "login", {
      ...(opts.maxSteps ? { maxSteps: Number(opts.maxSteps) } : {}),
    });
  });

program
  .command("enqueue <profileId> <type>")
  .description("enqueue an arbitrary task (browse, warmup_feed, engage_post, send_message, ...)")
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
  .description("start the worker loop (claims tasks, spawns runners)")
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
        risk: p.riskScore.toFixed(1),
        ageDays: p.accountAgeDays,
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
    const [workers, profiles, taskStats] = (await Promise.all([
      client.query(api.workers.list, {}),
      client.query(api.profiles.list, {}),
      client.query(api.tasks.stats, {}),
    ])) as [
      Array<Doc<"workers"> & { stale: boolean }>,
      Doc<"profiles">[],
      Record<string, number>,
    ];

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
    table(
      [...byStatus.entries()].map(([status, count]) => ({ status, count })),
    );
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
  .description("approve a draft strategy version (activates it, retires the previous)")
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

await program.parseAsync(process.argv);

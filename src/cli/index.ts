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
  .action(async (profileId, opts) => {
    await enqueueTask(profileId, "signup", {
      ...(opts.maxSteps ? { maxSteps: Number(opts.maxSteps) } : {}),
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

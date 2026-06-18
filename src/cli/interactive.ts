import fs from "node:fs";
import path from "node:path";
import { select, input, confirm, checkbox } from "@inquirer/prompts";
import { api } from "../../convex/_generated/api.js";
import type { Doc, Id } from "../../convex/_generated/dataModel.js";
import { isProfileRestricted } from "../shared/profile.js";
import { AGENT_MODEL_CHOICES } from "../shared/agentModels.js";
import { createConsoleReporter } from "../orchestrator/reporter.js";
import { provisionProfile } from "../identity/provision.js";
import {
  type CreateOptions,
  type CreateParallelOptions,
  promptCreateSharedSettings,
  promptParallelCount,
  planParallelJobs,
  promptParallelProxyRotation,
} from "./createShared.js";
import { convex, acctStamp, spawnBlessCli, spawnTsxScript, spawnTsxScriptTagged } from "./helpers.js";
import { runCampaign } from "../campaign/main.js";

export type { CreateOptions, CreateParallelOptions };

export async function runCreateInteractive(opts: CreateOptions): Promise<number> {
  const { client, workerKey } = convex();
  const reporter = createConsoleReporter();
  const shared = await promptCreateSharedSettings(client, opts);

  const name =
    opts.name ??
    (await input({
      message: "Profile name",
      default: `acct-${acctStamp()}`,
    }));

  reporter.phase("provisioning identity");
  const { profileId, persona, launchConfig } = await provisionProfile(client, workerKey, {
    name,
    geo: shared.geo,
    timezone: shared.timezone,
    role: shared.role,
    personaModel: shared.personaModel,
    personaPrompt: shared.personaPrompt,
    location: shared.location,
    proxy: shared.useProxy ? shared.resolved.proxy : undefined,
    stayProvisioning: true,
    log: reporter,
  });

  console.log(`\nprofile: ${profileId} (${name}, persona ${persona.fullName}, ${persona.location})`);
  if (shared.skipPreflight) {
    reporter.info("skipping proxy + fingerprint checks — LinkedIn signup directly");
  }
  reporter.phase("starting signup pipeline (foreground — no worker)");

  const orchArgs: string[] = [profileId];
  if (opts.maxSteps) orchArgs.push("--max-steps", opts.maxSteps);
  if (shared.skipPreflight) orchArgs.push("--skip-preflight");
  orchArgs.push("--model", shared.agentModel);

  return spawnTsxScript("src/orchestrator/signup.ts", orchArgs, {
    TZ: launchConfig.timezone,
  });
}

export async function runCreateParallelInteractive(opts: CreateParallelOptions): Promise<number> {
  const { client, workerKey } = convex();
  const reporter = createConsoleReporter();
  const count = await promptParallelCount(opts.count);
  const shared = await promptCreateSharedSettings(client, opts);
  const pool = (await client.query(api.proxyPool.list, { status: "active" })) as Doc<"proxyPool">[];
  const rotatePool = await promptParallelProxyRotation(count, shared, pool, opts);
  const jobs = planParallelJobs(count, shared, pool, rotatePool);

  if (rotatePool) {
    reporter.info(
      `assigning ${count} signups across ${pool.length} pool prox${pool.length === 1 ? "y" : "ies"} (round-robin)`,
    );
  } else if (shared.useProxy && shared.resolved.poolEntry) {
    reporter.info(
      `all ${count} signups use ${shared.resolved.poolEntry.label} (${shared.resolved.poolEntry.geo})`,
    );
  } else if (shared.useProxy && count > 1) {
    reporter.info(`all ${count} signups share the same proxy`);
  }

  reporter.phase(`provisioning ${count} identities`);
  const provisioned: Array<{
    name: string;
    profileId: Id<"profiles">;
    timezone: string;
  }> = [];

  for (const job of jobs) {
    reporter.info(`provisioning ${job.name} (${job.geo}${job.poolEntry ? ` via ${job.poolEntry.label}` : ""})`);
    const { profileId, persona } = await provisionProfile(client, workerKey, {
      name: job.name,
      geo: job.geo,
      timezone: job.timezone,
      role: shared.role,
      personaModel: shared.personaModel,
      personaPrompt: shared.personaPrompt,
      location: shared.location,
      proxy: job.proxy,
      stayProvisioning: true,
    });
    provisioned.push({ name: job.name, profileId, timezone: job.timezone });
    reporter.info(`  → ${profileId} (${persona.fullName})`);
  }

  if (shared.skipPreflight) {
    reporter.info("skipping proxy + fingerprint checks — LinkedIn signup directly");
  }
  reporter.phase(`starting ${count} signup pipelines in parallel`);

  const results = await Promise.all(
    provisioned.map(({ name, profileId, timezone }) => {
      const orchArgs: string[] = [profileId];
      if (opts.maxSteps) orchArgs.push("--max-steps", opts.maxSteps);
      if (shared.skipPreflight) orchArgs.push("--skip-preflight");
      orchArgs.push("--model", shared.agentModel);
      return spawnTsxScriptTagged(name, "src/orchestrator/signup.ts", orchArgs, { TZ: timezone });
    }),
  );

  const succeeded = results.filter((r) => r.code === 0);
  const failed = results.filter((r) => r.code !== 0);

  console.log(`\nparallel create finished: ${succeeded.length}/${count} succeeded`);
  if (failed.length > 0) {
    console.log(`failed: ${failed.map((r) => r.tag).join(", ")}`);
  }

  return failed.length === 0 ? 0 : 1;
}

export interface ExperimentOptions {
  prompt?: string;
  profileId?: string;
  startUrl?: string;
  maxSteps?: string;
  model?: string;
}

export async function runExperimentInteractive(opts: ExperimentOptions): Promise<number> {
  const { client, workerKey } = convex();
  const reporter = createConsoleReporter();

  let profileId = opts.profileId as Id<"profiles"> | undefined;
  if (!profileId) {
    const profiles = (await client.query(api.profiles.list, {})) as Doc<"profiles">[];
    if (profiles.length === 0) {
      console.log("no profiles yet — create one first with `bless create`");
      return 1;
    }
    profileId = await select<Id<"profiles">>({
      message: "Profile to act through",
      choices: profiles.map((p) => ({
        name: `${p.name} — ${p.status}${isProfileRestricted(p) ? ` [RESTRICTED@${p.restrictedAtPhase ?? "?"}]` : ""}${p.linkedInProfileUrl ? ` (${p.linkedInProfileUrl})` : ""}`,
        value: p._id as Id<"profiles">,
      })),
    });
  }

  const profile = (await client.query(api.profiles.get, { profileId })) as Doc<"profiles"> | null;
  if (!profile) {
    console.log(`profile not found: ${profileId}`);
    return 1;
  }

  let tz = process.env.TZ ?? "UTC";
  if (profile.launchConfigId) {
    const lc = (await client.query(api.launchConfigs.get, {
      launchConfigId: profile.launchConfigId,
    })) as Doc<"launchConfigs"> | null;
    if (lc?.timezone) tz = lc.timezone;
  }

  let prompt = opts.prompt;
  if (!prompt || !prompt.trim()) {
    prompt = await input({ message: "What should the agent do? (prompt)" });
  }
  if (!prompt.trim()) {
    console.log("empty prompt — nothing to do");
    return 1;
  }

  const agentModel =
    opts.model ??
    (await select({
      message: "Agent model (browser automation)",
      choices: AGENT_MODEL_CHOICES.map((m) => ({ name: m, value: m })),
      default: "claude-sonnet-4-6",
    }));

  const maxSteps =
    opts.maxSteps ??
    (await input({
      message: "Agent step budget (max steps)",
      default: "50",
      validate: (val) => {
        const n = Number(val);
        return Number.isInteger(n) && n > 0 ? true : "enter a positive integer";
      },
    }));

  console.log(`\nprofile: ${profileId} (${profile.name})`);
  reporter.phase("starting experiment (foreground — no worker)");

  const orchArgs: string[] = [profileId, "--prompt", prompt];
  if (opts.startUrl) orchArgs.push("--start-url", opts.startUrl);
  if (maxSteps) orchArgs.push("--max-steps", maxSteps);
  orchArgs.push("--model", agentModel ?? "claude-sonnet-4-6");

  return spawnTsxScript("src/orchestrator/experiment.ts", orchArgs, { TZ: tz });
}

export interface ExperimentAllOptions {
  prompt?: string;
  startUrl?: string;
  maxSteps?: string;
  model?: string;
  status?: string;
  concurrency?: string;
}

const DEFAULT_RESNAPSHOT_PROMPT =
  "Open the current page, wait a moment, then finish the task without taking any further action.";

// Re-run every profile through a minimal foreground experiment. The session
// cycle (hydrate -> launch -> snapshot) re-archives each profile under the
// current prune/whitelist rules, shrinking stored blobs. Agent activity is
// intentionally trivial (default max-steps 1) — the point is the re-snapshot.
export async function runExperimentAll(opts: ExperimentAllOptions): Promise<number> {
  const { client } = convex();
  const reporter = createConsoleReporter();

  const listArgs = opts.status
    ? { status: opts.status as Doc<"profiles">["status"] }
    : {};
  const all = (await client.query(api.profiles.list, listArgs)) as Doc<"profiles">[];
  if (all.length === 0) {
    console.log("no profiles to run");
    return 1;
  }

  const runnable = all.filter((p) => p.activeSessionId === undefined);
  const busy = all.filter((p) => p.activeSessionId !== undefined);

  if (runnable.length === 0) {
    console.log("no runnable profiles — all currently have an active session");
    return 1;
  }

  const prompt = opts.prompt?.trim() || DEFAULT_RESNAPSHOT_PROMPT;
  const maxSteps = opts.maxSteps ?? "1";
  const model = opts.model ?? "claude-sonnet-4-6";
  const startUrl = opts.startUrl ?? "https://example.com";
  const concurrency = Math.max(1, Math.trunc(Number(opts.concurrency ?? "1")) || 1);

  reporter.phase(
    `re-snapshotting ${runnable.length} profile(s) via experiment (concurrency ${concurrency}, max-steps ${maxSteps})`,
  );
  if (busy.length > 0) {
    reporter.info(
      `skipping ${busy.length} with an active session: ${busy.map((p) => p.name).join(", ")}`,
    );
  }

  async function timezoneFor(profile: Doc<"profiles">): Promise<string> {
    if (profile.launchConfigId) {
      const lc = (await client.query(api.launchConfigs.get, {
        launchConfigId: profile.launchConfigId,
      })) as Doc<"launchConfigs"> | null;
      if (lc?.timezone) return lc.timezone;
    }
    return process.env.TZ ?? "UTC";
  }

  const results: Array<{ tag: string; code: number }> = [];
  let cursor = 0;
  async function lane(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= runnable.length) return;
      const profile = runnable[i];
      const tz = await timezoneFor(profile);
      const orchArgs = [
        profile._id,
        "--prompt",
        prompt,
        "--max-steps",
        maxSteps,
        "--model",
        model,
        "--start-url",
        startUrl,
      ];
      reporter.info(`[${i + 1}/${runnable.length}] ${profile.name} (${profile._id})`);
      const r = await spawnTsxScriptTagged(profile.name, "src/orchestrator/experiment.ts", orchArgs, {
        TZ: tz,
      });
      results.push(r);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, runnable.length) }, () => lane()),
  );

  const succeeded = results.filter((r) => r.code === 0);
  const failed = results.filter((r) => r.code !== 0);
  console.log(`\nexperiment-all finished: ${succeeded.length}/${results.length} succeeded`);
  if (failed.length > 0) {
    console.log(`failed: ${failed.map((r) => r.tag).join(", ")}`);
  }
  return failed.length === 0 ? 0 : 1;
}

export interface RemoveProfilesOptions {
  profileIds?: string[];
  yes?: boolean;
  force?: boolean;
}

function removeLocalProfileDirs(profileIds: string[]): void {
  const profilesDir = process.env.PROFILES_DIR ?? "./.profiles";
  for (const id of profileIds) {
    const dir = path.resolve(profilesDir, id);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`removed local profile dir: ${dir}`);
    } catch {
      console.log(`could not remove local dir: ${dir}`);
    }
  }
}

/** Delete profile(s) from Convex (all linked data) and local .profiles dirs. */
export async function runRemoveProfiles(opts: RemoveProfilesOptions): Promise<number> {
  const { client, workerKey } = convex();

  let profileIds = opts.profileIds?.filter(Boolean) as Id<"profiles">[] | undefined;
  if (!profileIds || profileIds.length === 0) {
    const profiles = (await client.query(api.profiles.list, {})) as Doc<"profiles">[];
    if (profiles.length === 0) {
      console.log("no profiles to remove");
      return 1;
    }
    profileIds = await checkbox({
      message: "Profiles to delete (all linked Convex data + local profile dir)",
      choices: profiles.map((p) => ({
        name: `${p.name} — ${p.status}${isProfileRestricted(p) ? ` [RESTRICTED@${p.restrictedAtPhase ?? "?"}]` : ""}${p.activeSessionId ? " [active session]" : ""}${p.linkedInProfileUrl ? ` (${p.linkedInProfileUrl})` : ""}`,
        value: p._id as Id<"profiles">,
      })),
      required: true,
    });
  }

  const profiles = await Promise.all(
    profileIds.map((id) => client.query(api.profiles.get, { profileId: id })),
  );
  const names = profiles
    .map((p, i) => (p ? `${p.name} (${profileIds![i]})` : profileIds![i]))
    .join("\n  ");

  if (!opts.yes) {
    const ok = await confirm({
      message:
        `Permanently delete ${profileIds.length} profile(s) and ALL linked data?\n  ${names}\n\nThis cannot be undone.`,
      default: false,
    });
    if (!ok) {
      console.log("cancelled");
      return 0;
    }
  }

  const force = opts.force !== false;
  const result = (await client.mutation(api.maintenance.removeProfiles, {
    workerKey,
    profileIds,
    force,
  })) as { deletedProfileIds: Id<"profiles">[]; deletedCount: number };

  removeLocalProfileDirs(result.deletedProfileIds);
  console.log(`\nremoved ${result.deletedCount} profile(s) from Convex`);
  return 0;
}

export async function runReset(assumeYes = false): Promise<void> {
  const { client, workerKey } = convex();
  if (!assumeYes) {
    const ok = await confirm({
      message:
        "Wipe all moving DB state + local profile files? (keeps proxy pool, strategies, accounts with credentials — flagged unmaintained)",
      default: false,
    });
    if (!ok) {
      console.log("cancelled");
      return;
    }
  }

  const result = (await client.mutation(api.maintenance.reset, { workerKey })) as {
    deletedProfileIds: Id<"profiles">[];
    preservedProfileIds: Id<"profiles">[];
    workersRemoved: number;
  };

  const profilesDir = process.env.PROFILES_DIR ?? "./.profiles";
  for (const id of result.deletedProfileIds) {
    const dir = path.resolve(profilesDir, id);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`removed local profile dir: ${dir}`);
    } catch {
      console.log(`could not remove local dir: ${dir}`);
    }
  }

  console.log(
    `\nreset complete: ${result.deletedProfileIds.length} profiles deleted, ` +
      `${result.preservedProfileIds.length} accounts preserved (maintained=false), ` +
      `${result.workersRemoved} workers removed`,
  );
}

function runBlessSubcommand(args: string[]): Promise<number> {
  return spawnBlessCli(args);
}

export async function showMainMenu(): Promise<void> {
  const action = await select({
    message: "bless — what do you want to do?",
    choices: [
      { name: "Create account (interactive signup)", value: "create" },
      { name: "Create accounts in parallel", value: "create-parallel" },
      { name: "Run account campaign (sequential, rate-limited)", value: "campaign" },
      { name: "Run experiment (agent prompt)", value: "experiment" },
      { name: "List profiles", value: "profiles" },
      { name: "Fleet status", value: "status" },
      { name: "Manage proxies", value: "proxy" },
      { name: "Reset DB (dev wipe)", value: "reset" },
      { name: "Start worker", value: "worker" },
      { name: "Quit", value: "quit" },
    ],
  });

  switch (action) {
    case "create":
      process.exitCode = await runCreateInteractive({});
      break;
    case "create-parallel":
      process.exitCode = await runCreateParallelInteractive({});
      break;
    case "campaign":
      process.exitCode = await runCampaign({});
      break;
    case "experiment":
      process.exitCode = await runExperimentInteractive({});
      break;
    case "profiles":
      process.exitCode = await runBlessSubcommand(["profiles"]);
      break;
    case "status":
      process.exitCode = await runBlessSubcommand(["status"]);
      break;
    case "proxy": {
      const sub = await select({
        message: "Proxies",
        choices: [
          { name: "List", value: "list" },
          { name: "Add", value: "add" },
          { name: "Remove", value: "remove" },
        ],
      });
      process.exitCode = await runBlessSubcommand(["proxy", sub]);
      break;
    }
    case "reset":
      await runReset(false);
      break;
    case "worker":
      process.exitCode = await runBlessSubcommand(["worker"]);
      break;
    case "quit":
      break;
  }
}

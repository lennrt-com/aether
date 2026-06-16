import fs from "node:fs";
import path from "node:path";
import { select, input, confirm } from "@inquirer/prompts";
import { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel.js";
import { AGENT_MODEL_CHOICES } from "../shared/agentModels.js";
import { PERSONA_MODEL_CHOICES } from "../shared/personaModels.js";
import { timezoneForGeo } from "../shared/geo.js";
import { createConsoleReporter } from "../orchestrator/reporter.js";
import { provisionProfile } from "../identity/provision.js";
import { convex, acctStamp, spawnBlessCli, spawnTsxScript, resolveProxyForCli } from "./helpers.js";

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
  maxSteps?: string;
  skipPreflight?: boolean | undefined;
  model?: string;
  personaModel?: string;
}

export async function runCreateInteractive(opts: CreateOptions): Promise<number> {
  const { client, workerKey } = convex();
  const reporter = createConsoleReporter();

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

  const name =
    opts.name ??
    (await input({
      message: "Profile name",
      default: `acct-${acctStamp()}`,
    }));

  const agentModel =
    opts.model ??
    (await select({
      message: "Agent model (browser automation)",
      choices: AGENT_MODEL_CHOICES.map((m) => ({ name: m, value: m })),
      default: "gemini-3-flash-preview",
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

  let proxy: { server: string; username?: string; password?: string } | undefined;
  if (useProxy) {
    proxy = resolved.proxy;
    if (!proxy) throw new Error("no proxy configured");
  }

  reporter.phase("provisioning identity");
  const { profileId, persona, launchConfig } = await provisionProfile(client, workerKey, {
    name,
    geo,
    timezone,
    role,
    personaModel,
    personaPrompt,
    proxy,
    stayProvisioning: true,
    log: reporter,
  });

  console.log(`\nprofile: ${profileId} (${name}, persona ${persona.fullName})`);
  if (skipPreflight) {
    reporter.info("skipping proxy + fingerprint checks — LinkedIn signup directly");
  }
  reporter.phase("starting signup pipeline (foreground — no worker)");

  const orchArgs: string[] = [profileId];
  if (opts.maxSteps) orchArgs.push("--max-steps", opts.maxSteps);
  if (skipPreflight) orchArgs.push("--skip-preflight");
  orchArgs.push("--model", agentModel ?? "gemini-3-flash-preview");

  return spawnTsxScript("src/orchestrator/signup.ts", orchArgs, {
    TZ: launchConfig.timezone,
  });
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

// Shared browser signup sequence: hydrate → launch → preflight → fingerprint → signup → snapshot.
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import type { Doc, Id } from "../../convex/_generated/dataModel.js";
import type { Emit } from "./emit.js";
import { launchSession } from "./session.js";
import { runPreflight } from "./preflight.js";
import { runFingerprintCheck } from "./fingerprintCheck.js";
import { runSignup } from "./signup.js";
import { runExperiment } from "./experiment.js";
import { runAgent } from "./agent.js";
import { createConvexBlobStore } from "../profile-store/convexBlobStore.js";
import { hydrateProfile } from "../profile-store/hydrate.js";
import { snapshotProfile } from "../profile-store/snapshot.js";
import { resolveAgentModel } from "../shared/agentModels.js";
import { parseAgentJobPayload, type AgentJobPayload } from "../shared/agentPayload.js";
import { redactAgentResult } from "../shared/redactSecrets.js";
import { deliverAgentWebhookFromWorker } from "./deliverWebhook.js";

export interface SessionBundle {
  task: Doc<"tasks"> | null;
  profile: Doc<"profiles">;
  persona: Doc<"personas"> | null;
  launchConfig: Doc<"launchConfigs"> | null;
  proxyBinding: Doc<"proxyBindings"> | null;
  currentSnapshot: Doc<"profileSnapshots"> | null;
  sessionId: Id<"sessions">;
  strategyVersionId: string | null;
}

export interface SignupSessionOptions {
  convex: ConvexHttpClient;
  workerKey: string;
  emit: Emit;
  bundle: SessionBundle;
  maxSteps?: number;
  skipPreflight?: boolean;
  /** Skip only the proxy detector battery; fingerprint checks still run. */
  skipProxyCheck?: boolean;
  model?: string;
  onLog?: (line: string) => void;
}

export interface SignupSessionResult {
  exitCode: number;
  egressIp?: string;
}

function readStagehandVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require("@browserbasehq/stagehand/package.json") as { version: string };
  return pkg.version;
}

function localeToLanguages(locale: string): string[] {
  const base = locale.split("-")[0];
  return base && base !== locale ? [locale, base] : [locale];
}

export async function runSignupSession(opts: SignupSessionOptions): Promise<SignupSessionResult> {
  const { convex, workerKey, emit, bundle } = opts;
  const agentModel = resolveAgentModel(opts.model);
  const stagehandVersion = readStagehandVersion();

  const profilesDir = process.env.PROFILES_DIR ?? "./.profiles";
  const userDataDir = path.resolve(profilesDir, bundle.profile._id);
  fs.mkdirSync(userDataDir, { recursive: true });

  const blobStore = createConvexBlobStore(convex, workerKey);
  const hydrateOutcome = await hydrateProfile({
    profileDir: userDataDir,
    blobStore,
    latest: bundle.currentSnapshot
      ? {
          storageId: bundle.currentSnapshot.storageId,
          contentHash: bundle.currentSnapshot.contentHash,
        }
      : null,
  });
  await emit("FingerprintLoaded", {
    hydrate: hydrateOutcome,
    launchConfigHash: bundle.launchConfig?.hash ?? null,
    snapshotHash: bundle.currentSnapshot?.contentHash ?? null,
  });

  const session = await launchSession({
    userDataDir,
    headless: process.env.HEADLESS === "true",
    model: agentModel,
    locale: bundle.launchConfig?.locale,
    viewport: bundle.launchConfig
      ? { width: bundle.launchConfig.windowWidth, height: bundle.launchConfig.windowHeight }
      : undefined,
    proxy: bundle.proxyBinding
      ? {
          server: bundle.proxyBinding.server,
          username: bundle.proxyBinding.username,
          password: bundle.proxyBinding.password,
        }
      : undefined,
    fingerprint:
      process.env.FINGERPRINT_SPOOF !== "false" && bundle.launchConfig?.fingerprintSeed
        ? {
            seed: bundle.launchConfig.fingerprintSeed,
            hardwareConcurrency: bundle.launchConfig.hardwareConcurrency ?? undefined,
            deviceMemory: bundle.launchConfig.deviceMemory ?? undefined,
            languages: localeToLanguages(bundle.launchConfig.locale),
          }
        : undefined,
    args: ["--password-store=basic"],
    onLog: opts.onLog,
  });

  await convex.mutation(api.tasks.setSessionEgress, {
    workerKey,
    sessionId: bundle.sessionId,
    egressIp: session.egressIp,
    launchConfigHash: bundle.launchConfig?.hash,
  });

  let exitCode = 0;
  try {
    const preflightOn =
      opts.skipPreflight !== true &&
      opts.skipProxyCheck !== true &&
      process.env.PREFLIGHT !== "false";
    const fingerprintCheckOn =
      opts.skipPreflight !== true &&
      process.env.PREFLIGHT_FINGERPRINT !== "false" &&
      process.env.FINGERPRINT_SPOOF !== "false";

    if (preflightOn) {
      const preflight = await runPreflight({
        stagehand: session.stagehand,
        emit,
        egressIp: session.egressIp,
        expectedGeo: bundle.proxyBinding?.geo,
      });
      if (!preflight.ok) {
        await emit("ActionFailed", { phase: "preflight", error: preflight.summary }, randomUUID());
        exitCode = 1;
      }
    }

    if (exitCode === 0 && fingerprintCheckOn) {
      const fpCheck = await runFingerprintCheck({
        stagehand: session.stagehand,
        convex,
        workerKey,
        profileId: bundle.profile._id,
        emit,
      });
      if (!fpCheck.ok) {
        await emit(
          "ActionFailed",
          { phase: "fingerprint_check", error: fpCheck.reasons.join("; ") },
          randomUUID(),
        );
        exitCode = 1;
      }
    }

    if (exitCode === 0) {
      const flowDeps = {
        stagehand: session.stagehand,
        convex,
        workerKey,
        emit,
        profile: bundle.profile,
        persona: bundle.persona,
        maxSteps: opts.maxSteps,
        proxy: bundle.proxyBinding
          ? {
              server: bundle.proxyBinding.server,
              username: bundle.proxyBinding.username,
              password: bundle.proxyBinding.password,
            }
          : undefined,
      };
      try {
        const ok = await runSignup(flowDeps);
        if (!ok) exitCode = 1;
      } catch (err) {
        await emit("ActionFailed", { error: String(err) }, randomUUID());
        exitCode = 1;
      }
    }
  } finally {
    await session.close();
  }

  const snapshot = await snapshotProfile({
    profileDir: userDataDir,
    blobStore,
    convex,
    workerKey,
    profileId: bundle.profile._id,
    sessionId: bundle.sessionId,
    chromeVersion: bundle.profile.chromeVersion,
  });
  await emit("SnapshotCommitted", {
    snapshotId: snapshot.snapshotId,
    contentHash: snapshot.contentHash,
    sizeBytes: snapshot.sizeBytes,
  });

  return { exitCode, egressIp: session.egressIp };
}

export interface ExperimentSessionOptions {
  convex: ConvexHttpClient;
  workerKey: string;
  emit: Emit;
  bundle: SessionBundle;
  prompt: string;
  maxSteps?: number;
  startUrl?: string;
  model?: string;
  onLog?: (line: string) => void;
}

// Same launch design as runSignupSession (hydrate → launch → ... → snapshot),
// but instead of the LinkedIn signup flow it turns a generic agent loose on the
// page to act on a free-form prompt. No preflight/fingerprint gate — this is a
// general-purpose "do X through this profile" runner.
export async function runExperimentSession(
  opts: ExperimentSessionOptions,
): Promise<SignupSessionResult> {
  const { convex, workerKey, emit, bundle } = opts;
  const agentModel = resolveAgentModel(opts.model);

  const profilesDir = process.env.PROFILES_DIR ?? "./.profiles";
  const userDataDir = path.resolve(profilesDir, bundle.profile._id);
  fs.mkdirSync(userDataDir, { recursive: true });

  const blobStore = createConvexBlobStore(convex, workerKey);
  const hydrateOutcome = await hydrateProfile({
    profileDir: userDataDir,
    blobStore,
    latest: bundle.currentSnapshot
      ? {
          storageId: bundle.currentSnapshot.storageId,
          contentHash: bundle.currentSnapshot.contentHash,
        }
      : null,
  });
  await emit("FingerprintLoaded", {
    hydrate: hydrateOutcome,
    launchConfigHash: bundle.launchConfig?.hash ?? null,
    snapshotHash: bundle.currentSnapshot?.contentHash ?? null,
  });

  const session = await launchSession({
    userDataDir,
    headless: process.env.HEADLESS === "true",
    model: agentModel,
    locale: bundle.launchConfig?.locale,
    viewport: bundle.launchConfig
      ? { width: bundle.launchConfig.windowWidth, height: bundle.launchConfig.windowHeight }
      : undefined,
    proxy: bundle.proxyBinding
      ? {
          server: bundle.proxyBinding.server,
          username: bundle.proxyBinding.username,
          password: bundle.proxyBinding.password,
        }
      : undefined,
    fingerprint:
      process.env.FINGERPRINT_SPOOF !== "false" && bundle.launchConfig?.fingerprintSeed
        ? {
            seed: bundle.launchConfig.fingerprintSeed,
            hardwareConcurrency: bundle.launchConfig.hardwareConcurrency ?? undefined,
            deviceMemory: bundle.launchConfig.deviceMemory ?? undefined,
            languages: localeToLanguages(bundle.launchConfig.locale),
          }
        : undefined,
    args: ["--password-store=basic"],
    onLog: opts.onLog,
  });

  await convex.mutation(api.tasks.setSessionEgress, {
    workerKey,
    sessionId: bundle.sessionId,
    egressIp: session.egressIp,
    launchConfigHash: bundle.launchConfig?.hash,
  });

  let exitCode = 0;
  try {
    await runExperiment({
      stagehand: session.stagehand,
      emit,
      prompt: opts.prompt,
      maxSteps: opts.maxSteps,
      startUrl: opts.startUrl,
      proxy: bundle.proxyBinding
        ? {
            server: bundle.proxyBinding.server,
            username: bundle.proxyBinding.username,
            password: bundle.proxyBinding.password,
          }
        : undefined,
    });
  } catch (err) {
    await emit("ActionFailed", { taskType: "experiment", error: String(err) }, randomUUID());
    exitCode = 1;
  } finally {
    await session.close();
  }

  const snapshot = await snapshotProfile({
    profileDir: userDataDir,
    blobStore,
    convex,
    workerKey,
    profileId: bundle.profile._id,
    sessionId: bundle.sessionId,
    chromeVersion: bundle.profile.chromeVersion,
  });
  await emit("SnapshotCommitted", {
    snapshotId: snapshot.snapshotId,
    contentHash: snapshot.contentHash,
    sizeBytes: snapshot.sizeBytes,
  });

  return { exitCode, egressIp: session.egressIp };
}

export interface AgentSessionOptions {
  convex: ConvexHttpClient;
  workerKey: string;
  emit: Emit;
  bundle: SessionBundle;
  payload: AgentJobPayload;
  onLog?: (line: string) => void;
}

function resolveProxy(
  payload: AgentJobPayload,
  binding: SessionBundle["proxyBinding"],
): { server: string; username?: string; password?: string } | undefined {
  if (payload.proxy) return payload.proxy;
  if (!binding) return undefined;
  return {
    server: binding.server,
    username: binding.username,
    password: binding.password,
  };
}

export async function runAgentSession(opts: AgentSessionOptions): Promise<SignupSessionResult> {
  const { convex, workerKey, emit, bundle, payload } = opts;
  const agentModel = resolveAgentModel(payload.model);
  const proxy = resolveProxy(payload, bundle.proxyBinding);

  // Resolve Vaultwarden refs before launching Chrome — fail fast with a clear error.
  if (payload.secretRefs) {
    try {
      const { resolveSecretRefs } = await import("./secrets/bitwarden.js");
      await resolveSecretRefs(payload.secretRefs);
    } catch (err) {
      const message = String(err);
      console.error(`[agent] secret resolution failed: ${message}`);
      await emit("ActionFailed", { taskType: "agent", error: message }, randomUUID());
      if (bundle.task) {
        await convex.mutation(api.tasks.setResult, {
          workerKey,
          taskId: bundle.task._id,
          result: {
            success: false,
            summary: message,
            steps: 0,
            finalUrl: null,
            error: message,
          },
        });
        await deliverAgentWebhookFromWorker({
          convex,
          workerKey,
          taskId: bundle.task._id,
          payload,
          status: "failed",
          result: {
            success: false,
            summary: message,
            steps: 0,
            finalUrl: null,
            error: message,
          },
          lastError: message,
        });
      }
      return { exitCode: 1 };
    }
  }

  const profilesDir = process.env.PROFILES_DIR ?? "./.profiles";
  const userDataDir = path.resolve(profilesDir, bundle.profile._id);
  fs.mkdirSync(userDataDir, { recursive: true });

  const blobStore = createConvexBlobStore(convex, workerKey);
  const hydrateOutcome = await hydrateProfile({
    profileDir: userDataDir,
    blobStore,
    latest: bundle.currentSnapshot
      ? {
          storageId: bundle.currentSnapshot.storageId,
          contentHash: bundle.currentSnapshot.contentHash,
        }
      : null,
  });
  await emit("FingerprintLoaded", {
    hydrate: hydrateOutcome,
    launchConfigHash: bundle.launchConfig?.hash ?? null,
    snapshotHash: bundle.currentSnapshot?.contentHash ?? null,
  });

  const session = await launchSession({
    userDataDir,
    headless: process.env.HEADLESS === "true",
    model: agentModel,
    locale: bundle.launchConfig?.locale,
    viewport: bundle.launchConfig
      ? { width: bundle.launchConfig.windowWidth, height: bundle.launchConfig.windowHeight }
      : undefined,
    proxy,
    fingerprint:
      process.env.FINGERPRINT_SPOOF !== "false" && bundle.launchConfig?.fingerprintSeed
        ? {
            seed: bundle.launchConfig.fingerprintSeed,
            hardwareConcurrency: bundle.launchConfig.hardwareConcurrency ?? undefined,
            deviceMemory: bundle.launchConfig.deviceMemory ?? undefined,
            languages: localeToLanguages(bundle.launchConfig.locale),
          }
        : undefined,
    args: ["--password-store=basic"],
    onLog: opts.onLog,
  });

  await convex.mutation(api.tasks.setSessionEgress, {
    workerKey,
    sessionId: bundle.sessionId,
    egressIp: session.egressIp,
    launchConfigHash: bundle.launchConfig?.hash,
  });

  let exitCode = 0;
  let agentResult;
  try {
    agentResult = await runAgent({
      stagehand: session.stagehand,
      emit,
      payload,
      convex,
      workerKey,
      downloadDir: path.join(userDataDir, "job-downloads"),
    });
    if (!agentResult.success) exitCode = 1;
  } catch (err) {
    const message = String(err);
    console.error(`[agent] run failed: ${message}`);
    await emit("ActionFailed", { taskType: "agent", error: message }, randomUUID());
    exitCode = 1;
    agentResult = {
      success: false,
      summary: message,
      steps: 0,
      finalUrl: null,
      error: message,
    };
  } finally {
    await session.close();
  }

  if (agentResult && bundle.task) {
    await convex.mutation(api.tasks.setResult, {
      workerKey,
      taskId: bundle.task._id,
      result: redactAgentResult(agentResult as unknown as Record<string, unknown>),
    });
    await deliverAgentWebhookFromWorker({
      convex,
      workerKey,
      taskId: bundle.task._id,
      payload,
      status: agentResult.success ? "done" : "failed",
      result: agentResult,
      lastError: agentResult.error,
    });
  }

  const snapshot = await snapshotProfile({
    profileDir: userDataDir,
    blobStore,
    convex,
    workerKey,
    profileId: bundle.profile._id,
    sessionId: bundle.sessionId,
    chromeVersion: bundle.profile.chromeVersion,
  });
  await emit("SnapshotCommitted", {
    snapshotId: snapshot.snapshotId,
    contentHash: snapshot.contentHash,
    sizeBytes: snapshot.sizeBytes,
  });

  return { exitCode, egressIp: session.egressIp };
}

export function parseAgentPayloadFromTask(taskPayload: unknown): AgentJobPayload {
  return parseAgentJobPayload(taskPayload);
}

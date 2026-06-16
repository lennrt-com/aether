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
import { createConvexBlobStore } from "../profile-store/convexBlobStore.js";
import { hydrateProfile } from "../profile-store/hydrate.js";
import { snapshotProfile } from "../profile-store/snapshot.js";
import { resolveAgentModel } from "../shared/agentModels.js";

export interface SessionBundle {
  task: Doc<"tasks"> | null;
  profile: Doc<"profiles">;
  persona: Doc<"personas"> | null;
  launchConfig: Doc<"launchConfigs"> | null;
  proxyBinding: Doc<"proxyBindings"> | null;
  currentSnapshot: Doc<"profileSnapshots"> | null;
  sessionId: Id<"sessions">;
  strategyVersionId: Id<"strategyVersions"> | null;
}

export interface SignupSessionOptions {
  convex: ConvexHttpClient;
  workerKey: string;
  emit: Emit;
  bundle: SessionBundle;
  maxSteps?: number;
  skipPreflight?: boolean;
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
      opts.skipPreflight !== true && process.env.PREFLIGHT !== "false";
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

// Pre-signup Fingerprint visitorId gate: drive the live session through the
// anti-detect scanner, verify tampering stays false, and ensure the visitorId
// is unique to this profile (no cross-profile collisions in Convex).
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { fetch as undiciFetch } from "undici";
import type { ConvexHttpClient } from "convex/browser";
import type { Stagehand } from "@browserbasehq/stagehand";
import { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel.js";
import type { Emit } from "./emit.js";

const DEFAULT_SCANNER_URL = "https://anti-detect-scanner-production.up.railway.app/";

const scanSchema = z.object({
  visitorId: z.string().nullable(),
  eventId: z.string().nullable(),
  tamperingDetected: z.boolean().nullable(),
  summary: z.string(),
});

export interface FingerprintCheckOutcome {
  ok: boolean;
  reasons: string[];
  visitorId?: string;
  eventId?: string;
}

export interface FingerprintCheckDeps {
  stagehand: Stagehand;
  convex: ConvexHttpClient;
  workerKey: string;
  profileId: Id<"profiles">;
  emit: Emit;
}

interface FingerprintEventSignals {
  tampering?: boolean;
  vpn?: boolean;
  proxy?: boolean;
}

async function fetchFingerprintEvent(eventId: string): Promise<FingerprintEventSignals | null> {
  const apiKey = process.env.FINGERPRINT_API_KEY;
  if (!apiKey) return null;

  const base = (process.env.FINGERPRINT_API_BASE ?? "https://api.fpjs.io").replace(/\/$/, "");
  const res = await undiciFetch(`${base}/events/${encodeURIComponent(eventId)}`, {
    headers: { "Auth-API-Key": apiKey },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;

  const body = (await res.json()) as {
    products?: {
      tampering?: { data?: { result?: boolean } };
      vpn?: { data?: { result?: boolean; methods?: { osMismatch?: boolean } } };
      proxy?: { data?: { result?: boolean } };
    };
    tampering?: { result?: boolean };
    vpn?: { result?: boolean; methods?: { os_mismatch?: boolean; osMismatch?: boolean } };
    proxy?: { result?: boolean };
  };

  // v3 nests under products; v4 flattens smart signals.
  const tampering =
    body.products?.tampering?.data?.result ?? body.tampering?.result;
  const vpn =
    body.products?.vpn?.data?.result ??
    body.vpn?.result ??
    body.products?.vpn?.data?.methods?.osMismatch ??
    body.vpn?.methods?.os_mismatch ??
    body.vpn?.methods?.osMismatch;
  const proxy = body.products?.proxy?.data?.result ?? body.proxy?.result;

  return {
    tampering: tampering ?? undefined,
    vpn: vpn ?? undefined,
    proxy: proxy ?? undefined,
  };
}

export async function runFingerprintCheck(deps: FingerprintCheckDeps): Promise<FingerprintCheckOutcome> {
  const { stagehand, convex, workerKey, profileId, emit } = deps;
  const actionId = randomUUID();
  const scannerUrl = process.env.FINGERPRINT_SCANNER_URL ?? DEFAULT_SCANNER_URL;
  const reasons: string[] = [];

  await emit(
    "ActionStarted",
    { phase: "fingerprint_check", url: scannerUrl },
    actionId,
  );

  let scan: z.infer<typeof scanSchema>;
  try {
    const page = stagehand.context.activePage();
    if (!page) throw new Error("no active page");

    try {
      await page.goto(scannerUrl, { waitUntil: "load", timeoutMs: 45_000 });
    } catch {
      // Scanner pages may not reach a quiet load state; extract from whatever rendered.
    }
    await page.waitForTimeout(Number(process.env.FINGERPRINT_SCANNER_SETTLE_MS ?? 8000));

    scan = await stagehand.extract(
      [
        "This page is a Fingerprint anti-detect scanner.",
        "Read the displayed Visitor ID and Event ID (request ID) exactly as shown.",
        "Set tamperingDetected true only if the page explicitly reports tampering detected or anti-detect browser.",
        "Put a one-sentence summary of the verdict.",
      ].join("\n"),
      scanSchema,
    );
  } catch (err) {
    const msg = `fingerprint scanner extract failed: ${String(err)}`;
    await emit(
      "PageObserved",
      { phase: "fingerprint_check", status: "error", error: msg },
      `${actionId}:scan`,
    );
    await emit(
      "AnomalyObserved",
      { phase: "fingerprint_check", reason: "fingerprint_check_failed", summary: msg },
      actionId,
    );
    return { ok: false, reasons: [msg] };
  }

  await emit(
    "PageObserved",
    {
      phase: "fingerprint_check",
      status: scan.visitorId ? "pass" : "suspicious",
      scan,
    },
    `${actionId}:scan`,
  );

  const visitorId = scan.visitorId?.trim();
  const eventId = scan.eventId?.trim();

  if (!visitorId) {
    reasons.push("visitorId could not be read from scanner");
  }

  let tampering = scan.tamperingDetected ?? undefined;
  let vpn: boolean | undefined;
  let proxy: boolean | undefined;

  if (eventId) {
    const apiSignals = await fetchFingerprintEvent(eventId);
    if (apiSignals) {
      if (apiSignals.tampering != null) tampering = apiSignals.tampering;
      vpn = apiSignals.vpn;
      proxy = apiSignals.proxy;
    }
  }

  if (tampering === true) {
    reasons.push("Fingerprint tampering detected");
  }
  if (vpn === true) {
    reasons.push("Fingerprint VPN/os mismatch flagged");
  }

  let collisionProfileIds: Id<"profiles">[] = [];
  if (visitorId) {
    const collisions = (await convex.query(api.fingerprints.collisions, {
      workerKey,
      visitorId,
      profileId,
    })) as Array<{ profileId: Id<"profiles"> }>;
    collisionProfileIds = collisions.map((c) => c.profileId);
    if (collisions.length > 0) {
      reasons.push(
        `visitorId collision with ${collisions.length} other profile(s): ${collisions.map((c) => c.profileId).join(", ")}`,
      );
    }

    await convex.mutation(api.fingerprints.record, {
      workerKey,
      profileId,
      visitorId,
      eventId: eventId ?? "",
      tampering,
      vpn,
      proxy,
    });
  }

  const ok = reasons.length === 0;

  if (!ok) {
    await emit(
      "AnomalyObserved",
      {
        phase: "fingerprint_check",
        reason: "fingerprint_check_failed",
        visitorId: visitorId ?? null,
        eventId: eventId ?? null,
        tampering: tampering ?? null,
        vpn: vpn ?? null,
        proxy: proxy ?? null,
        collisionProfileIds,
        reasons,
        summary: scan.summary,
      },
      actionId,
    );
  } else {
    await emit(
      "ActionSucceeded",
      {
        phase: "fingerprint_check",
        visitorId,
        eventId,
        tampering: tampering ?? null,
        summary: scan.summary,
      },
      actionId,
    );
  }

  return {
    ok,
    reasons,
    visitorId: visitorId ?? undefined,
    eventId: eventId ?? undefined,
  };
}

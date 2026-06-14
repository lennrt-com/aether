// Pre-signup sanity gate: before touching LinkedIn we drive the live browser
// session through a battery of proxy + fingerprint detectors. If the setup
// looks leaky or automated, the runner aborts BEFORE any account is created.
//
// Each check navigates the already-launched (proxied) session to a detector
// page, lets it settle, and uses a single Stagehand extract pass to read the
// verdict into a fixed schema. Classification is deterministic in code so the
// abort decision never depends on free-form model prose.
import { z } from "zod";
import type { Stagehand } from "@browserbasehq/stagehand";
import { randomUUID } from "node:crypto";
import type { Emit } from "./emit.js";

const verdictSchema = z.object({
  proxyOrVpnDetected: z.boolean(),
  botOrHeadlessDetected: z.boolean(),
  riskScore: z.number().nullable(),
  publicIps: z.array(z.string()),
  reportedLocation: z.string().nullable(),
  explicitLeak: z.boolean(),
  summary: z.string(),
});
type Verdict = z.infer<typeof verdictSchema>;

type Category = "proxy" | "fingerprint";

interface CheckSpec {
  id: string;
  category: Category;
  url: string;
  instruction: string;
  settleMs?: number;
  gotoTimeoutMs?: number;
  // dnsleaktest only renders resolver servers after the test is triggered.
  runStandardTest?: boolean;
}

const PROXY_RISK_THRESHOLD = Number(process.env.PREFLIGHT_PROXY_RISK_THRESHOLD ?? 75);

const PROXY_CHECKS: CheckSpec[] = [
  {
    id: "ipqualityscore",
    category: "proxy",
    url: "https://www.ipqualityscore.com/free-ip-lookup-proxy-vpn-test",
    settleMs: 5000,
    instruction:
      "This is an IPQualityScore IP reputation report. Set proxyOrVpnDetected true if it flags the IP as Proxy, VPN, Tor, or active VPN/bot. Read the Fraud Score into riskScore (0-100). Put the looked-up IP into publicIps and the country/region into reportedLocation.",
  },
  {
    id: "proxydetect",
    category: "proxy",
    url: "https://proxydetect.live/",
    settleMs: 7000,
    instruction:
      "This page tests whether the current connection is a proxy/VPN. Set proxyOrVpnDetected true if it reports a proxy, VPN, or hosting/datacenter connection. Put the detected IP into publicIps and the location into reportedLocation.",
  },
  {
    id: "ip2proxy",
    category: "proxy",
    url: "https://www.ip2proxy.com/demo",
    settleMs: 4000,
    instruction:
      "This is an IP2Proxy lookup demo. Set proxyOrVpnDetected true if 'Is Proxy' is YES or any proxy type is reported (e.g. VPN, TOR, DCH/datacenter, PUB, WEB, SES). Put the IP into publicIps and the country into reportedLocation.",
  },
  {
    id: "browserleaks-ip",
    category: "proxy",
    url: "https://browserleaks.com/ip",
    settleMs: 4000,
    instruction:
      "This BrowserLeaks page shows the public IP address the browser connects from. Put every public IP it reports into publicIps and the detected country/city into reportedLocation. Set proxyOrVpnDetected true if it flags Tor/proxy.",
  },
  {
    id: "browserleaks-webrtc",
    category: "proxy",
    url: "https://browserleaks.com/webrtc",
    settleMs: 7000,
    instruction:
      "This is a WebRTC leak test. Put into publicIps ONLY public IP addresses exposed through WebRTC candidates; exclude local/private addresses (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x, fc00::/7, fe80::, and *.local mDNS hostnames). Set explicitLeak true if a public IP leaks via WebRTC.",
  },
  {
    id: "dnsleaktest",
    category: "proxy",
    url: "https://dnsleaktest.com/",
    settleMs: 2000,
    runStandardTest: true,
    instruction:
      "This is a DNS leak test result page. Put the DNS resolver server IPs into publicIps and their country/ISP into reportedLocation. Set explicitLeak true if the DNS resolvers are in a different country or belong to a different ISP than the browsing IP shown at the top.",
  },
];

const FINGERPRINT_CHECKS: CheckSpec[] = [
  {
    id: "sannysoft",
    category: "fingerprint",
    url: "https://bot.sannysoft.com/",
    settleMs: 4000,
    instruction:
      "This is a headless/bot detection test table. Set botOrHeadlessDetected true if WebDriver is present/true, or if multiple rows are red/failed (missing plugins, headless user-agent, broken WebGL/permissions). In summary list which rows failed.",
  },
  {
    id: "areyouheadless",
    category: "fingerprint",
    url: "https://arh.antoinevastel.com/bots/areyouheadless",
    settleMs: 2500,
    instruction:
      "Set botOrHeadlessDetected true if the page concludes you ARE Chrome headless or a bot; false if it says you are NOT headless. Put the verdict text into summary.",
  },
  {
    id: "deviceandbrowserinfo",
    category: "fingerprint",
    url: "https://deviceandbrowserinfo.com/are_you_a_bot",
    settleMs: 4000,
    instruction:
      "Set botOrHeadlessDetected true if this page concludes the visitor is a bot or automated. Put its reasoning into summary.",
  },
  {
    id: "fpscanner",
    category: "fingerprint",
    url: "https://fpscanner.com/demo/",
    settleMs: 5000,
    instruction:
      "This is a browser fingerprint scanner. Set botOrHeadlessDetected true if it detects inconsistencies, automation, headless, or bot indicators (failed/red checks). In summary list the failed checks.",
  },
];

const ALL_CHECKS = [...PROXY_CHECKS, ...FINGERPRINT_CHECKS];

export type CheckStatus = "pass" | "suspicious" | "error";

export interface CheckResult {
  id: string;
  category: Category;
  url: string;
  status: CheckStatus;
  reasons: string[];
  verdict: Verdict | null;
  error?: string;
}

export interface PreflightOutcome {
  ok: boolean;
  summary: string;
  results: CheckResult[];
}

export interface PreflightDeps {
  stagehand: Stagehand;
  emit: Emit;
  egressIp: string;
  expectedGeo?: string;
  // When true (default), unverifiable runs (majority of checks errored) abort too.
  strict?: boolean;
  /** Called after each check finishes — useful for live CLI progress output. */
  onCheckComplete?: (result: CheckResult, index: number, total: number) => void;
}

function isPublicIp(raw: string): boolean {
  const ip = raw.trim();
  if (!ip || ip.toLowerCase().endsWith(".local")) return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    return true;
  }
  if (ip.includes(":")) {
    const low = ip.toLowerCase();
    if (low === "::1" || low.startsWith("fe80") || low.startsWith("fc") || low.startsWith("fd")) {
      return false;
    }
    return true;
  }
  return false;
}

function buildInstruction(spec: CheckSpec): string {
  return [
    spec.instruction,
    "",
    "Fill the schema based ONLY on what this page actually shows:",
    "- proxyOrVpnDetected: true only if a proxy/VPN/Tor/hosting/datacenter connection is indicated.",
    "- botOrHeadlessDetected: true only if automation/headless/bot is indicated.",
    "- riskScore: numeric fraud/abuse/risk score 0-100 if shown, otherwise null.",
    "- publicIps: PUBLIC IP addresses shown (exclude private/local ranges and *.local); empty array if none.",
    "- reportedLocation: country/city attributed to the connection, otherwise null.",
    "- explicitLeak: true only if the page explicitly reports a WebRTC or DNS leak.",
    "- summary: one short sentence describing the verdict.",
  ].join("\n");
}

function classify(spec: CheckSpec, v: Verdict, egressIp: string): string[] {
  const reasons: string[] = [];
  if (spec.category === "fingerprint") {
    if (v.botOrHeadlessDetected) {
      reasons.push(`${spec.id}: bot/headless detected — ${v.summary}`);
    }
    return reasons;
  }

  if (v.proxyOrVpnDetected) reasons.push(`${spec.id}: connection flagged as proxy/VPN/datacenter`);
  if (v.riskScore != null && v.riskScore >= PROXY_RISK_THRESHOLD) {
    reasons.push(`${spec.id}: risk score ${v.riskScore} ≥ ${PROXY_RISK_THRESHOLD}`);
  }
  if (v.explicitLeak) reasons.push(`${spec.id}: explicit leak reported — ${v.summary}`);

  // The page should report exactly the proxy egress IP. A different public IP
  // means the real IP is leaking (WebRTC) or the proxy isn't being applied.
  const foreign = v.publicIps.filter((ip) => isPublicIp(ip) && ip.trim() !== egressIp);
  if (foreign.length > 0 && (spec.id === "browserleaks-webrtc" || spec.id === "browserleaks-ip")) {
    reasons.push(
      `${spec.id}: public IP(s) not matching proxy egress ${egressIp}: ${foreign.join(", ")}`,
    );
  }
  return reasons;
}

async function runCheck(deps: PreflightDeps, spec: CheckSpec): Promise<CheckResult> {
  const { stagehand, egressIp } = deps;
  const base: Omit<CheckResult, "status" | "reasons" | "verdict"> = {
    id: spec.id,
    category: spec.category,
    url: spec.url,
  };
  try {
    const page = stagehand.context.activePage();
    if (!page) throw new Error("no active page");

    try {
      await page.goto(spec.url, {
        waitUntil: "domcontentloaded",
        timeoutMs: spec.gotoTimeoutMs ?? 20_000,
      });
    } catch {
      // Detector pages often never reach a quiet load state; extract from whatever rendered.
    }
    await page.waitForTimeout(spec.settleMs ?? 3000);

    if (spec.runStandardTest) {
      try {
        await stagehand.act("Click the button that starts the standard DNS leak test");
        await page.waitForTimeout(8000);
      } catch {
        // best effort — fall back to whatever the landing page shows
      }
    }

    const verdict = await stagehand.extract(buildInstruction(spec), verdictSchema);
    const reasons = classify(spec, verdict, egressIp);
    return {
      ...base,
      status: reasons.length > 0 ? "suspicious" : "pass",
      reasons,
      verdict,
    };
  } catch (err) {
    return { ...base, status: "error", reasons: [], verdict: null, error: String(err) };
  }
}

export async function runPreflight(deps: PreflightDeps): Promise<PreflightOutcome> {
  const { emit, egressIp, expectedGeo } = deps;
  const strict = deps.strict ?? process.env.PREFLIGHT_STRICT !== "false";
  const actionId = randomUUID();

  await emit(
    "ActionStarted",
    {
      phase: "preflight",
      egressIp,
      expectedGeo: expectedGeo ?? null,
      strict,
      checks: ALL_CHECKS.map((c) => c.id),
    },
    actionId,
  );

  const results: CheckResult[] = [];
  for (let i = 0; i < ALL_CHECKS.length; i++) {
    const spec = ALL_CHECKS[i];
    const result = await runCheck(deps, spec);
    results.push(result);
    deps.onCheckComplete?.(result, i + 1, ALL_CHECKS.length);
    await emit(
      "PageObserved",
      {
        phase: "preflight",
        check: result.id,
        category: result.category,
        url: result.url,
        status: result.status,
        reasons: result.reasons,
        verdict: result.verdict,
        error: result.error,
      },
      `${actionId}:${result.id}`,
    );
  }

  const suspicious = results.filter((r) => r.status === "suspicious");
  const errored = results.filter((r) => r.status === "error");
  const passed = results.filter((r) => r.status === "pass");

  // Abort on any suspicious signal. In strict mode also abort when we couldn't
  // verify enough of the setup (more than half the checks errored out).
  const tooManyErrors = strict && errored.length > Math.floor(results.length / 2);
  const ok = suspicious.length === 0 && !tooManyErrors;

  const summary =
    `preflight ${ok ? "clean" : "FAILED"}: ${passed.length} pass, ` +
    `${suspicious.length} suspicious, ${errored.length} error` +
    (suspicious.length > 0 ? ` | ${suspicious.flatMap((s) => s.reasons).join("; ")}` : "") +
    (tooManyErrors ? ` | too many checks unverifiable (${errored.map((e) => e.id).join(", ")})` : "");

  if (!ok) {
    await emit(
      "AnomalyObserved",
      {
        phase: "preflight",
        reason: "preflight_failed",
        summary,
        suspicious: suspicious.map((s) => ({ id: s.id, reasons: s.reasons })),
        errored: errored.map((e) => ({ id: e.id, error: e.error })),
      },
      actionId,
    );
  } else {
    await emit("ActionSucceeded", { phase: "preflight", summary }, actionId);
  }

  return { ok, summary, results };
}

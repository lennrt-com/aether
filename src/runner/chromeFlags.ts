// Chrome launch hardening for the LOCAL Stagehand runner.
//
// Stagehand LOCAL mode launches real Chrome through `chrome-launcher` and only
// forwards `localBrowserLaunchOptions.args` verbatim onto the command line — it
// applies NO anti-detection of its own (its "stealth" paths are Browserbase-
// only). So everything that keeps WebRTC from leaking the real IP and keeps the
// fingerprint clean has to be passed here as flags (plus a Preferences seed).
//
// Two design rules drive the flag set below:
//   1. WebRTC must not be able to expose the real IP over UDP that bypasses the
//      session proxy — i.e. replicate the "WebRTC Network Limiter" extension's
//      `disable_non_proxied_udp` policy natively.
//   2. Be conservative on stealth. Many popular "stealth" flags (`--disable-gpu`,
//      `--no-sandbox`, `--disable-web-security`, forced `--user-agent`, GL/ANGLE
//      overrides) make the fingerprint MORE detectable or inconsistent. We only
//      add flags that are JS-observably indistinguishable from a real browser
//      and that the preflight detectors (bot.sannysoft, areyouheadless,
//      fpscanner, deviceandbrowserinfo) reward. See OMITTED_STEALTH_FLAGS.
import fs from "node:fs";
import path from "node:path";

// Valid values for Chrome's `webrtc.ip_handling_policy` preference. Mirrors
// blink's webrtc_ip_handling_policy.cc. `disable_non_proxied_udp` is "Mode 4":
// WebRTC may only use UDP via a SOCKS proxy, otherwise it falls back to TCP
// through the proxy — so it can never send UDP straight out and reveal the host
// IP. That is exactly what the WebRTC Network Limiter extension sets.
export const WEBRTC_IP_POLICIES = [
  "default",
  "default_public_and_private_interfaces",
  "default_public_interface_only",
  "disable_non_proxied_udp",
] as const;

export type WebrtcIpPolicy = (typeof WEBRTC_IP_POLICIES)[number];

export const DEFAULT_WEBRTC_IP_POLICY: WebrtcIpPolicy = "disable_non_proxied_udp";

// Stealth flags we deliberately DO NOT set, with the reason each would hurt.
// Documented (not just omitted) so a future reader doesn't "helpfully" add them.
export const OMITTED_STEALTH_FLAGS = {
  "--disable-gpu": "forces SwiftShader → fake WebGL vendor/renderer, a classic bot tell",
  "--no-sandbox": "datacenter/automation signal and a needless security downgrade",
  "--disable-setuid-sandbox": "same as --no-sandbox; also Linux-only noise",
  "--disable-web-security": "no real browser runs with this; screams automation",
  "--user-agent=<spoofed>": "UA vs. Client-Hints/navigator mismatch is highly detectable",
  "--use-gl / --use-angle": "overriding the GL backend changes WebGL strings → inconsistent",
  "--disable-features=IsolateOrigins,site-per-process":
    "Stagehand relies on --site-per-process; disabling site isolation is abnormal",
  "--disable-infobars / exclude enable-automation":
    "chrome-launcher never passes --enable-automation, so there is no automation infobar to suppress",
} as const;

// Read and validate the WebRTC IP handling policy from the environment.
// Defaults to disable_non_proxied_udp; an unknown value falls back to the
// default rather than handing Chrome an invalid policy string.
export function resolveWebrtcIpPolicy(
  env: NodeJS.ProcessEnv = process.env,
): WebrtcIpPolicy {
  const raw = env.WEBRTC_IP_POLICY?.trim();
  if (!raw) return DEFAULT_WEBRTC_IP_POLICY;
  if ((WEBRTC_IP_POLICIES as readonly string[]).includes(raw)) {
    return raw as WebrtcIpPolicy;
  }
  return DEFAULT_WEBRTC_IP_POLICY;
}

// Extract the switch key (text before the first '=') so we can dedupe by switch
// rather than by exact string, e.g. "--lang=en" → "--lang".
function switchKey(flag: string): string {
  const eq = flag.indexOf("=");
  return eq === -1 ? flag : flag.slice(0, eq);
}

// Append `additions` to `base`, skipping any whose switch key is already present
// in `base`. Caller-supplied args therefore win and are never dropped.
function mergeArgs(base: string[], additions: string[]): string[] {
  const seen = new Set(base.map(switchKey));
  const out = [...base];
  for (const flag of additions) {
    const key = switchKey(flag);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(flag);
  }
  return out;
}

// The WebRTC leak-prevention flags for a given policy.
//
// We pass BOTH switches because, in release-channel Chrome, neither alone is
// reliable (confirmed against browserleaks.com/webrtc — the same detector the
// preflight uses):
//   --webrtc-ip-handling-policy=<p>        (chrome/common/chrome_switches.cc)
//       sets the profile's webrtc.ip_handling_policy preference; this is what
//       actually drives the network service at runtime.
//   --force-webrtc-ip-handling-policy=<p>  (content/public/common/content_switches.cc)
//       propagates the override into every renderer/utility process so the
//       policy is honored regardless of per-profile prefs.
// `default` means "no restriction", so for that value we add no flags at all.
export function webrtcFlags(policy: WebrtcIpPolicy): string[] {
  if (policy === "default") return [];
  return [
    `--webrtc-ip-handling-policy=${policy}`,
    `--force-webrtc-ip-handling-policy=${policy}`,
  ];
}

// When we strip chrome-launcher's + Stagehand's default flags (see
// session.ts: ignoreDefaultArgs:true), we must re-add the handful we actually
// rely on. EVERY flag here is provably NOT observable by in-page JS / UA-CH —
// it is launch hygiene, profile storage, CDP transport, or process stability —
// so it cannot reintroduce the `nodriver` / "Chromium-Based Browser" tell that
// the stripped defaults caused (confirmed via Fingerprint A/B).
//
// Deliberately NOT included: `--site-per-process`. It is NOT a UA-CH signal, but
// it WAS absent from the proven-clean run (Test 1), so we keep the default
// guaranteed-clean and only re-add it (vetted) if a flow needs cross-origin
// iframe automation. See OMITTED_STEALTH_FLAGS for flags that actively hurt.
const CURATED_BASE_FLAGS = [
  "--no-first-run", // skip the first-run UI; not page-visible
  "--no-default-browser-check", // suppress the "set as default" prompt
  "--password-store=basic", // portable credential storage; not page-visible
  "--disable-dev-shm-usage", // Linux/Docker stability (small /dev/shm); memory-only
  "--remote-allow-origins=*", // allow the CDP websocket; debug-port only, not page-visible
];

// Conservative, JS-indistinguishable stealth flags. Kept intentionally small.
function stealthFlags(): string[] {
  // EXP (diagnostic): drop the AutomationControlled flag to test whether it is
  // what trips the `nodriver` / UA-CH ("Chromium-Based Browser") signal under
  // Stagehand. Set EXP_NO_AUTOMATION_CONTROLLED=1 to omit it for a test run.
  if (process.env.EXP_NO_AUTOMATION_CONTROLLED === "1") return [];
  return [
    // Stops Chrome from exposing `navigator.webdriver` and the rest of the
    // AutomationControlled blink feature. Without it, `navigator.webdriver` is
    // `true` whenever Chrome runs headless (and the AutomationControlled signals
    // can surface under CDP) — bot.sannysoft, areyouheadless and fpscanner all
    // test for this. The flag makes `navigator.webdriver` read like a real
    // browser without introducing any inconsistency, in both headful and
    // headless. This is the single highest-value, lowest-risk stealth flag.
    "--disable-blink-features=AutomationControlled",
  ];
}

// Build the full hardened Chrome arg list: caller args first (preserved &
// take precedence), then stealth + WebRTC flags merged in by switch key.
export function buildHardenedChromeArgs(
  baseArgs: string[] = [],
  policy: WebrtcIpPolicy = resolveWebrtcIpPolicy(),
): string[] {
  return mergeArgs(baseArgs, [
    ...CURATED_BASE_FLAGS,
    ...stealthFlags(),
    ...webrtcFlags(policy),
  ]);
}

// Belt-and-suspenders for the WebRTC policy: seed `webrtc.ip_handling_policy`
// straight into the profile's Default/Preferences before launch. This is the
// exact preference the WebRTC Network Limiter extension writes via the
// chrome.privacy API, so a hydrated/snapshotted profile carries the policy on
// disk even before the command line is parsed. It is NOT a tracked/protected
// (MAC-validated) preference, so merging it does not trigger Chrome's "settings
// were reset" recovery. Best-effort: never throws — the flags above are the
// primary mechanism, this only reinforces them.
export function seedWebrtcPreference(
  userDataDir: string,
  policy: WebrtcIpPolicy,
): boolean {
  if (policy === "default") return false;
  try {
    const defaultDir = path.join(userDataDir, "Default");
    fs.mkdirSync(defaultDir, { recursive: true });
    const prefsPath = path.join(defaultDir, "Preferences");

    let prefs: Record<string, unknown> = {};
    if (fs.existsSync(prefsPath)) {
      try {
        prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8")) as Record<string, unknown>;
      } catch {
        // Corrupt/locked Preferences: leave it alone (Chrome would reset it) and
        // rely on the command-line flags instead of risking profile corruption.
        return false;
      }
    }

    const webrtc =
      typeof prefs.webrtc === "object" && prefs.webrtc !== null
        ? (prefs.webrtc as Record<string, unknown>)
        : {};
    webrtc.ip_handling_policy = policy;
    prefs.webrtc = webrtc;

    fs.writeFileSync(prefsPath, JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}

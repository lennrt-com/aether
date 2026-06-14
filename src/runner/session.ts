import { Stagehand } from "@browserbasehq/stagehand";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import fs from "node:fs";
import path from "node:path";
import { startProxyRelay, type ProxyRelay } from "./proxy.js";
import {
  buildHardenedChromeArgs,
  resolveWebrtcIpPolicy,
  seedWebrtcPreference,
} from "./chromeFlags.js";
import { applyFingerprint, type FingerprintConfig } from "./fingerprint/patch.js";

export const DEFAULT_MODEL = "google/gemini-3-flash-preview";

export interface SessionConfig {
  userDataDir: string;
  executablePath?: string;
  headless?: boolean;
  locale?: string;
  viewport?: { width: number; height: number };
  proxy?: { server: string; username?: string; password?: string };
  args?: string[];
  model?: string;
  fingerprint?: FingerprintConfig;
}

export interface RunningSession {
  stagehand: Stagehand;
  relay: ProxyRelay | null;
  egressIp: string;
  close: () => Promise<void>;
}

export async function resolveEgressIp(relayUrl?: string): Promise<string> {
  const res = await undiciFetch("https://api.ipify.org?format=json", {
    ...(relayUrl ? { dispatcher: new ProxyAgent(relayUrl) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`egress IP check failed: HTTP ${res.status}`);
  const body = (await res.json()) as { ip?: string };
  if (!body.ip) throw new Error("egress IP check returned no ip");
  return body.ip;
}

export async function launchSession(cfg: SessionConfig): Promise<RunningSession> {
  const relay = cfg.proxy ? await startProxyRelay(cfg.proxy) : null;

  // Before any navigation: resolve the actual egress IP through the session proxy.
  const egressIp = await resolveEgressIp(relay?.server);

  // Harden the launch: WebRTC must not leak the real IP past the proxy and the
  // fingerprint must not scream automation. The WebRTC policy is applied two
  // ways — seeded into the profile's Preferences (mirrors the WebRTC Network
  // Limiter extension) and via command-line flags (what actually enforces it at
  // runtime). See chromeFlags.ts for the rationale behind each flag.
  const webrtcPolicy = resolveWebrtcIpPolicy();
  seedWebrtcPreference(cfg.userDataDir, webrtcPolicy);
  const hardenedArgs = buildHardenedChromeArgs(cfg.args ?? [], webrtcPolicy);

  // Strip chrome-launcher's + Stagehand's testing-oriented default flags. Those
  // defaults (background-networking / variations / feature disables) suppress
  // Chrome's variations seed, which is what populates the native User-Agent
  // Client Hints. With them, Fingerprint reads "Chromium-Based Browser" /
  // "Not Available" and flips bot -> nodriver; without them Chrome reports its
  // real "Chrome 148.0.0" identity and the bot flag clears — while CDP
  // automation keeps working (confirmed via Fingerprint A/B testing).
  //
  // We re-add only vetted, page-invisible flags in buildHardenedChromeArgs()
  // (CURATED_BASE_FLAGS). Escape hatch: LAUNCH_INHERIT_DEFAULTS=1 restores the
  // old (flagged) behavior for debugging.
  const ignoreDefaultArgs: boolean | undefined =
    process.env.LAUNCH_INHERIT_DEFAULTS === "1" ? undefined : true;

  const stagehand = new Stagehand({
    env: "LOCAL",
    model: cfg.model ?? DEFAULT_MODEL,
    // Required for agent custom tools + output schema (signup email tools).
    experimental: true,
    disableAPI: true,
    localBrowserLaunchOptions: {
      userDataDir: cfg.userDataDir,
      ...(cfg.executablePath ? { executablePath: cfg.executablePath } : {}),
      headless: cfg.headless ?? false,
      ...(cfg.locale ? { locale: cfg.locale } : {}),
      ...(cfg.viewport ? { viewport: cfg.viewport } : {}),
      ...(relay ? { proxy: { server: relay.server } } : {}),
      ...(hardenedArgs.length > 0 ? { args: hardenedArgs } : {}),
      ...(ignoreDefaultArgs !== undefined ? { ignoreDefaultArgs } : {}),
    },
  });

  try {
    await stagehand.init();
    if (cfg.fingerprint) {
      await applyFingerprint(stagehand.context, cfg.fingerprint);
    }
  } catch (err) {
    if (relay) await relay.close();
    throw err;
  }

  return {
    stagehand,
    relay,
    egressIp,
    close: async () => {
      // Graceful CDP Browser.close first: Stagehand's own cleanup force-kills
      // Chrome, which loses unflushed cookies/localStorage. Failure here is
      // fine — stagehand.close() below force-kills as fallback.
      try {
        await stagehand.context.conn.send("Browser.close");
      } catch {
        // connection may already be gone; fall through to force cleanup
      }
      await waitForChromeExit(cfg.userDataDir, 15_000);
      await stagehand.close();
      if (relay) await relay.close();
    },
  };
}

// chrome-launcher writes chrome.pid into the userDataDir.
async function waitForChromeExit(userDataDir: string, timeoutMs: number): Promise<void> {
  const pidFile = path.join(userDataDir, "chrome.pid");
  let pid: number | null = null;
  try {
    pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  } catch {
    return;
  }
  if (!pid || Number.isNaN(pid)) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // process is gone
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

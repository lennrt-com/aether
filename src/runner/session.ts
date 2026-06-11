import { Stagehand } from "@browserbasehq/stagehand";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { startProxyRelay, type ProxyRelay } from "./proxy.js";

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

  const stagehand = new Stagehand({
    env: "LOCAL",
    model: cfg.model ?? DEFAULT_MODEL,
    localBrowserLaunchOptions: {
      userDataDir: cfg.userDataDir,
      ...(cfg.executablePath ? { executablePath: cfg.executablePath } : {}),
      headless: cfg.headless ?? false,
      ...(cfg.locale ? { locale: cfg.locale } : {}),
      ...(cfg.viewport ? { viewport: cfg.viewport } : {}),
      ...(relay ? { proxy: { server: relay.server } } : {}),
      ...(cfg.args && cfg.args.length > 0 ? { args: cfg.args } : {}),
    },
  });

  try {
    await stagehand.init();
  } catch (err) {
    if (relay) await relay.close();
    throw err;
  }

  return {
    stagehand,
    relay,
    egressIp,
    close: async () => {
      // Close Stagehand fully first — profile files are locked while Chrome runs.
      await stagehand.close();
      if (relay) await relay.close();
    },
  };
}

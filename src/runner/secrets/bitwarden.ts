import { spawn } from "node:child_process";
import { parseBitwardenSecretRef } from "../../shared/agentPayload.js";
import type { AgentSecretRefs } from "../../shared/agentPayload.js";

const BW_TIMEOUT_MS = 30_000;

let cachedSession: string | null = null;

function runBw(args: string[], session?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (session) env.BW_SESSION = session;

    const child = spawn("bw", args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("bw command timed out"));
    }, BW_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `bw exited ${code}`));
        return;
      }
      resolve(stdout.trim());
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`bw not available: ${err.message}`));
    });
  });
}

async function configureServer(): Promise<void> {
  const serverUrl = process.env.BW_SERVER_URL?.trim();
  if (!serverUrl) return;

  const current = (await runBw(["config", "server"]).catch(() => "")).trim();
  if (current === serverUrl) return;

  const statusRaw = await runBw(["status"]).catch(() => "");
  if (statusRaw) {
    try {
      const status = JSON.parse(statusRaw) as { serverUrl?: string; status?: string };
      if (status.serverUrl === serverUrl) return;
      if (status.status === "locked" || status.status === "unlocked") {
        throw new Error(
          `BW_SERVER_URL (${serverUrl}) differs from bw config (${status.serverUrl}). ` +
            "Run `bw logout` or match BW_SERVER_URL to your configured server.",
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("BW_SERVER_URL")) throw err;
    }
  }

  await runBw(["config", "server", serverUrl]);
}

async function ensureLoggedIn(): Promise<void> {
  const statusRaw = await runBw(["status"]).catch(() => "");
  if (statusRaw.includes('"status":"unlocked"') || statusRaw.includes('"status":"locked"')) {
    return;
  }

  const clientId = process.env.BW_CLIENTID ?? process.env.BW_CLIENT_ID;
  const clientSecret = process.env.BW_CLIENTSECRET ?? process.env.BW_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Bitwarden vault not logged in — set BW_CLIENTID/BW_CLIENTSECRET or BW_SESSION");
  }

  await runBw(["login", "--apikey"]);
}

export async function ensureBitwardenSession(): Promise<string> {
  if (process.env.BW_SESSION?.trim()) {
    cachedSession = process.env.BW_SESSION.trim();
    return cachedSession;
  }
  if (cachedSession) return cachedSession;

  await configureServer();
  await ensureLoggedIn();

  const statusRaw = await runBw(["status"]);
  if (statusRaw.includes('"status":"unlocked"')) {
    const match = statusRaw.match(/"sessionKey"\s*:\s*"([^"]+)"/);
    if (match?.[1]) {
      cachedSession = match[1];
      return cachedSession;
    }
  }

  const masterPassword = process.env.BW_PASSWORD?.trim();
  if (!masterPassword) {
    throw new Error("Bitwarden vault locked — set BW_PASSWORD or BW_SESSION");
  }

  const session = await runBw(["unlock", "--passwordenv", "BW_PASSWORD", "--raw"]);
  if (!session) throw new Error("bw unlock returned empty session");
  cachedSession = session;
  process.env.BW_SESSION = session;
  return session;
}

const FIELD_ALIASES: Record<string, string> = {
  username: "username",
  email: "username",
  password: "password",
  totp: "totp",
};

export async function resolveSecretRefs(refs: AgentSecretRefs): Promise<Record<string, string>> {
  const session = await ensureBitwardenSession();
  const resolved: Record<string, string> = {};

  for (const [varName, ref] of Object.entries(refs)) {
    const { item, field } = parseBitwardenSecretRef(ref);
    const bwField = FIELD_ALIASES[field] ?? field;
    const value = await runBw(["get", bwField, item, "--session", session]);
    if (!value) throw new Error(`empty value for secret ref ${ref}`);
    resolved[varName] = value;
  }

  if (resolved.username && !resolved.email) {
    resolved.email = resolved.username;
  }
  if (resolved.email && !resolved.username) {
    resolved.username = resolved.email;
  }

  return resolved;
}

export function lockBitwardenSession(): void {
  cachedSession = null;
}

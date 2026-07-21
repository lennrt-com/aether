// Agent job payload — shared between runner and Convex HTTP API validation.

export const AGENT_TOOL_NAMES = ["captcha", "email", "phone"] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export interface AgentProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

export interface AgentLoginConfig {
  username: string;
  password: string;
}

/** Vaultwarden / Bitwarden CLI refs, e.g. "bw:Cursor Plan/password". */
export type AgentSecretRefs = Record<string, string>;

export interface AgentArtifact {
  name: string;
  contentType: string;
  sizeBytes: number;
  storageId: string;
  url: string;
}

export interface AgentJobPayload {
  startUrl: string;
  instructions: string;
  model?: string;
  proxy?: AgentProxyConfig;
  login?: AgentLoginConfig;
  secretRefs?: AgentSecretRefs;
  mcpServers?: string[];
  maxSteps?: number;
  tools?: AgentToolName[];
  webhookUrl: string;
  webhookSecret?: string;
  /** If set, only the worker registered with this name may claim the job (e.g. "local-1"). */
  preferredWorkerName?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentJobResult {
  success: boolean;
  summary: string;
  steps: number;
  finalUrl?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
  artifacts?: AgentArtifact[];
}

export const DEFAULT_AGENT_TOOLS: AgentToolName[] = ["captcha"];

const BW_REF_PREFIX = "bw:";

export function isBitwardenSecretRef(ref: string): boolean {
  return ref.startsWith(BW_REF_PREFIX);
}

export function parseBitwardenSecretRef(ref: string): { item: string; field: string } {
  if (!isBitwardenSecretRef(ref)) {
    throw new Error(`invalid secret ref (expected bw:Item/field): ${ref}`);
  }
  const body = ref.slice(BW_REF_PREFIX.length);
  const slash = body.lastIndexOf("/");
  if (slash <= 0 || slash === body.length - 1) {
    throw new Error(`invalid bw secret ref format: ${ref}`);
  }
  return { item: body.slice(0, slash), field: body.slice(slash + 1) };
}

function parseSecretRefs(raw: unknown): AgentSecretRefs | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("secretRefs must be an object");
  }
  const out: AgentSecretRefs = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val !== "string" || !val.trim()) {
      throw new Error(`secretRefs.${key} must be a non-empty string`);
    }
    if (!isBitwardenSecretRef(val.trim())) {
      throw new Error(`secretRefs.${key} must start with bw: (got ${val})`);
    }
    out[key] = val.trim();
  }
  if (Object.keys(out).length === 0) throw new Error("secretRefs must not be empty");
  return out;
}

export function parseAgentJobPayload(raw: unknown): AgentJobPayload {
  if (!raw || typeof raw !== "object") {
    throw new Error("agent payload must be an object");
  }
  const p = raw as Record<string, unknown>;
  const startUrl = typeof p.startUrl === "string" ? p.startUrl.trim() : "";
  const instructions = typeof p.instructions === "string" ? p.instructions.trim() : "";
  const webhookUrl = typeof p.webhookUrl === "string" ? p.webhookUrl.trim() : "";

  if (!startUrl) throw new Error("startUrl is required");
  if (!instructions) throw new Error("instructions is required");
  if (!webhookUrl) throw new Error("webhookUrl is required");
  try {
    new URL(webhookUrl);
  } catch {
    throw new Error("webhookUrl must be a valid URL");
  }

  let proxy: AgentProxyConfig | undefined;
  if (p.proxy !== undefined) {
    if (!p.proxy || typeof p.proxy !== "object") throw new Error("proxy must be an object");
    const px = p.proxy as Record<string, unknown>;
    const server = typeof px.server === "string" ? px.server.trim() : "";
    if (!server) throw new Error("proxy.server is required when proxy is set");
    proxy = {
      server,
      username: typeof px.username === "string" ? px.username : undefined,
      password: typeof px.password === "string" ? px.password : undefined,
    };
  }

  let login: AgentLoginConfig | undefined;
  if (p.login !== undefined) {
    if (!p.login || typeof p.login !== "object") throw new Error("login must be an object");
    const lg = p.login as Record<string, unknown>;
    const username = typeof lg.username === "string" ? lg.username.trim() : "";
    const password = typeof lg.password === "string" ? lg.password : "";
    if (!username || !password) throw new Error("login.username and login.password are required");
    login = { username, password };
  }

  const secretRefs = parseSecretRefs(p.secretRefs);

  let mcpServers: string[] | undefined;
  if (p.mcpServers !== undefined) {
    if (!Array.isArray(p.mcpServers)) throw new Error("mcpServers must be an array");
    mcpServers = p.mcpServers.map((name) => {
      if (typeof name !== "string" || !name.trim()) {
        throw new Error("mcpServers entries must be non-empty strings");
      }
      return name.trim();
    });
    if (mcpServers.length === 0) throw new Error("mcpServers must not be empty");
  }

  let tools: AgentToolName[] | undefined;
  if (p.tools !== undefined) {
    if (!Array.isArray(p.tools)) throw new Error("tools must be an array");
    tools = p.tools.map((t) => {
      if (typeof t !== "string" || !AGENT_TOOL_NAMES.includes(t as AgentToolName)) {
        throw new Error(`invalid tool: ${String(t)}`);
      }
      return t as AgentToolName;
    });
  }

  if (secretRefs && login) {
    throw new Error("provide either secretRefs or login, not both");
  }

  let preferredWorkerName: string | undefined;
  if (p.preferredWorkerName !== undefined) {
    if (typeof p.preferredWorkerName !== "string" || !p.preferredWorkerName.trim()) {
      throw new Error("preferredWorkerName must be a non-empty string");
    }
    preferredWorkerName = p.preferredWorkerName.trim();
  }

  return {
    startUrl,
    instructions,
    webhookUrl,
    model: typeof p.model === "string" ? p.model : undefined,
    proxy,
    login,
    secretRefs,
    mcpServers,
    maxSteps: typeof p.maxSteps === "number" ? p.maxSteps : undefined,
    tools: tools ?? DEFAULT_AGENT_TOOLS,
    webhookSecret: typeof p.webhookSecret === "string" ? p.webhookSecret : undefined,
    preferredWorkerName,
    metadata:
      p.metadata && typeof p.metadata === "object" && !Array.isArray(p.metadata)
        ? (p.metadata as Record<string, unknown>)
        : undefined,
  };
}

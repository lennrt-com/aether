import { input, select, confirm } from "@inquirer/prompts";
import { api } from "../../convex/_generated/api.js";
import { convex } from "./helpers.js";

function siteUrl(): string {
  const url = process.env.CONVEX_SITE_URL ?? process.env.VITE_CONVEX_SITE_URL;
  if (!url) throw new Error("CONVEX_SITE_URL not set");
  return url.replace(/\/$/, "");
}

function apiKey(): string {
  const key = process.env.AETHER_API_KEY;
  if (!key) throw new Error("AETHER_API_KEY not set");
  return key;
}

async function apiFetch(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${siteUrl()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey(),
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${response.status}`);
  }
  return body;
}

export async function runMcpList(): Promise<number> {
  if (process.env.AETHER_API_KEY && process.env.CONVEX_SITE_URL) {
    const body = (await apiFetch("/v1/mcp-connections")) as {
      connections: Array<{ name: string; transport: string; enabled: boolean }>;
    };
    if (body.connections.length === 0) {
      console.log("No MCP connections registered.");
      return 0;
    }
    for (const row of body.connections) {
      console.log(`- ${row.name} (${row.transport})${row.enabled ? "" : " [disabled]"}`);
    }
    return 0;
  }

  const { client } = convex();
  const rows = (await client.query(api.mcpConnections.list, {})) as Array<{
    name: string;
    transport: string;
    enabled: boolean;
  }>;
  if (rows.length === 0) {
    console.log("No MCP connections registered.");
    return 0;
  }
  for (const row of rows) {
    console.log(`- ${row.name} (${row.transport})${row.enabled ? "" : " [disabled]"}`);
  }
  return 0;
}

async function promptConnectionFields(): Promise<Record<string, unknown>> {
  const name = (
    await input({ message: "Connection name", validate: (v) => (v.trim() ? true : "required") })
  ).trim();
  const transport = await select({
    message: "Transport",
    choices: [
      { name: "stdio (spawn local process)", value: "stdio" as const },
      { name: "http (remote MCP server)", value: "http" as const },
    ],
  });

  const payload: Record<string, unknown> = { name, transport, enabled: true };

  if (transport === "stdio") {
    payload.command = (await input({ message: "Command", default: "npx" })).trim();
    const argsRaw = await input({
      message: "Args (space-separated)",
      default: "-y @bitwarden/mcp-server",
    });
    payload.args = argsRaw.split(/\s+/).filter(Boolean);
    const envRaw = await input({
      message: "Env vars to pass from worker (comma-separated)",
      default: "BW_SESSION,BW_SERVER_URL",
    });
    payload.envFromWorker = envRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    payload.url = (
      await input({ message: "MCP server URL", validate: (v) => (v.trim() ? true : "required") })
    ).trim();
    const headersRaw = await input({
      message: "Header→env mappings (header:ENV, comma-separated, optional)",
      default: "",
    });
    if (headersRaw.trim()) {
      payload.headersFromWorker = headersRaw.split(",").map((pair) => {
        const [header, envVar] = pair.split(":").map((s) => s.trim());
        if (!header || !envVar) throw new Error(`invalid header mapping: ${pair}`);
        return { header, envVar };
      });
    }
  }

  payload.notes = await input({ message: "Notes (optional)", default: "" });
  return payload;
}

export async function runMcpAddInteractive(): Promise<number> {
  const payload = await promptConnectionFields();

  if (process.env.AETHER_API_KEY && process.env.CONVEX_SITE_URL) {
    const result = await apiFetch("/v1/mcp-connections", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  const { client } = convex();
  const result = await client.mutation(api.mcpConnections.upsert, payload as never);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

export async function runMcpRemoveInteractive(): Promise<number> {
  let names: string[] = [];

  if (process.env.AETHER_API_KEY && process.env.CONVEX_SITE_URL) {
    const body = (await apiFetch("/v1/mcp-connections")) as {
      connections: Array<{ name: string }>;
    };
    names = body.connections.map((c) => c.name);
  } else {
    const { client } = convex();
    const rows = (await client.query(api.mcpConnections.list, {})) as Array<{ name: string }>;
    names = rows.map((r) => r.name);
  }

  if (names.length === 0) {
    console.log("No MCP connections to remove.");
    return 0;
  }

  const name = await select({
    message: "Remove connection",
    choices: names.map((n) => ({ name: n, value: n })),
  });
  const ok = await confirm({ message: `Delete ${name}?`, default: false });
  if (!ok) return 0;

  if (process.env.AETHER_API_KEY && process.env.CONVEX_SITE_URL) {
    const result = await apiFetch(`/v1/mcp-connections/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  const { client } = convex();
  const result = await client.mutation(api.mcpConnections.remove, { name });
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

export async function runMcpInteractive(): Promise<number> {
  const action = await select({
    message: "MCP connections",
    choices: [
      { name: "List", value: "list" },
      { name: "Add / update", value: "add" },
      { name: "Remove", value: "remove" },
      { name: "Back", value: "back" },
    ],
  });
  switch (action) {
    case "list":
      return runMcpList();
    case "add":
      return runMcpAddInteractive();
    case "remove":
      return runMcpRemoveInteractive();
    default:
      return 0;
  }
}

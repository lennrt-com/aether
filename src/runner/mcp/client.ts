import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { tool, type AgentConfig } from "@browserbasehq/stagehand";
import { z } from "zod";
import { redactSecrets } from "../../shared/redactSecrets.js";

export type StagehandToolSet = NonNullable<AgentConfig["tools"]>;

export interface McpConnectionConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string | null;
  args?: string[];
  envFromWorker?: string[];
  url?: string | null;
  headersFromWorker?: Array<{ header: string; envVar: string }>;
}

export type McpToolAudit = (
  toolName: string,
  data: Record<string, unknown>,
  ok: boolean,
) => Promise<void>;

interface ManagedMcpClient {
  name: string;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
}

function sanitizeToolName(connection: string, toolName: string): string {
  const base = `mcp_${connection}_${toolName}`.replace(/[^a-zA-Z0-9_]/g, "_");
  return base.slice(0, 64);
}

function jsonSchemaToZod(schema: Record<string, unknown> | undefined): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.object({}).passthrough();
  const props = schema.properties as Record<string, unknown> | undefined;
  if (!props || typeof props !== "object") return z.object({}).passthrough();

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(props)) {
    const p = prop as Record<string, unknown>;
    const desc = typeof p.description === "string" ? p.description : undefined;
    let field: z.ZodTypeAny;
    switch (p.type) {
      case "string":
        field = z.string();
        break;
      case "number":
      case "integer":
        field = z.number();
        break;
      case "boolean":
        field = z.boolean();
        break;
      case "array":
        field = z.array(z.unknown());
        break;
      case "object":
        field = z.record(z.unknown());
        break;
      default:
        field = z.unknown();
    }
    if (desc) field = field.describe(desc);
    if (!Array.isArray(schema.required) || !schema.required.includes(key)) {
      field = field.optional();
    }
    shape[key] = field;
  }
  return z.object(shape).passthrough();
}

function buildWorkerEnv(names: string[] | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of names ?? []) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function buildHttpHeaders(
  mappings: Array<{ header: string; envVar: string }> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const { header, envVar } of mappings ?? []) {
    const value = process.env[envVar];
    if (value !== undefined) headers[header] = value;
  }
  return headers;
}

function formatToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const r = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  if (Array.isArray(r.content)) {
    const text = r.content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    if (text) return { text, isError: r.isError ?? false };
  }
  return result;
}

async function connectOne(config: McpConnectionConfig): Promise<ManagedMcpClient> {
  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  if (config.transport === "stdio") {
    if (!config.command) throw new Error(`MCP ${config.name}: command required for stdio`);
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: Object.fromEntries(
        Object.entries({
          ...process.env,
          ...buildWorkerEnv(config.envFromWorker),
        }).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      stderr: "pipe",
    });
  } else {
    if (!config.url) throw new Error(`MCP ${config.name}: url required for http`);
    transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: {
        headers: buildHttpHeaders(config.headersFromWorker),
      },
    });
  }

  const client = new Client({ name: "aether-worker", version: "1.0.0" });
  await client.connect(transport);
  return { name: config.name, client, transport };
}

export class McpToolBridge {
  private clients: ManagedMcpClient[] = [];

  async connect(configs: McpConnectionConfig[]): Promise<void> {
    for (const config of configs) {
      this.clients.push(await connectOne(config));
    }
  }

  async buildToolsAsync(audit?: McpToolAudit): Promise<StagehandToolSet> {
    const tools: StagehandToolSet = {};

    for (const managed of this.clients) {
      const { tools: remoteTools } = await managed.client.listTools();
      for (const remote of remoteTools) {
        const localName = sanitizeToolName(managed.name, remote.name);
        const inputSchema = jsonSchemaToZod(
          remote.inputSchema as Record<string, unknown> | undefined,
        );
        tools[localName] = tool({
          description: `[MCP:${managed.name}] ${remote.description ?? remote.name}`,
          inputSchema,
          execute: async (args: Record<string, unknown>) => {
            try {
              const result = await managed.client.callTool({
                name: remote.name,
                arguments: args,
              });
              const formatted = formatToolResult(result);
              await audit?.(
                localName,
                redactSecrets({ args, result: formatted }) as Record<string, unknown>,
                true,
              );
              return formatted;
            } catch (err) {
              await audit?.(localName, { args: redactSecrets(args), error: String(err) }, false);
              throw err;
            }
          },
        });
      }
    }

    return tools;
  }

  async close(): Promise<void> {
    for (const managed of this.clients) {
      try {
        await managed.client.close();
      } catch {
        // ignore shutdown errors
      }
      try {
        await managed.transport.close();
      } catch {
        // ignore shutdown errors
      }
    }
    this.clients = [];
  }
}

export async function loadMcpTools(opts: {
  connections: McpConnectionConfig[];
  audit?: McpToolAudit;
}): Promise<{ tools: StagehandToolSet; bridge: McpToolBridge }> {
  const bridge = new McpToolBridge();
  await bridge.connect(opts.connections);
  const tools = await bridge.buildToolsAsync(opts.audit);
  return { tools, bridge };
}

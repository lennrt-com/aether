import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { select } from "@inquirer/prompts";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import type { Doc, Id } from "../../convex/_generated/dataModel.js";

/** Repo root (blessGTM), from any file under src/cli/. */
export function projectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export function convex(): { client: ConvexHttpClient; workerKey: string } {
  const url = process.env.CONVEX_URL;
  const workerKey = process.env.WORKER_KEY;
  if (!url || !workerKey) throw new Error("CONVEX_URL/WORKER_KEY not set");
  return { client: new ConvexHttpClient(url), workerKey };
}

export function table(rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)),
  );
  console.log(cols.map((c, i) => c.padEnd(widths[i])).join("  "));
  for (const row of rows) {
    console.log(cols.map((c, i) => String(row[c] ?? "").padEnd(widths[i])).join("  "));
  }
}

export function fmtTs(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

export function acctStamp(): string {
  const now = new Date();
  return (
    `${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}` +
    `-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`
  );
}

/** Spawn a repo script via local tsx (cwd = repo root). */
export function spawnTsxScript(
  scriptRel: string,
  args: string[] = [],
  extraEnv?: Record<string, string>,
): Promise<number> {
  return spawnTsxScriptTagged(undefined, scriptRel, args, extraEnv).then((r) => r.code);
}

/** Like spawnTsxScript but prefixes stdout/stderr lines with [tag] for parallel runs. */
export function spawnTsxScriptTagged(
  tag: string | undefined,
  scriptRel: string,
  args: string[] = [],
  extraEnv?: Record<string, string>,
): Promise<{ tag: string; code: number }> {
  const label = tag ?? scriptRel;
  const root = projectRoot();
  const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
  const script = path.join(root, scriptRel);
  return new Promise((resolve) => {
    const child = spawn("node", [tsx, script, ...args], {
      stdio: tag ? ["ignore", "pipe", "pipe"] : "inherit",
      env: { ...process.env, ...extraEnv },
      cwd: root,
    });

    if (tag) {
      const emit = (stream: NodeJS.ReadableStream | null, useStderr: boolean) => {
        stream?.on("data", (buf: Buffer) => {
          for (const line of buf.toString().split(/\r?\n/)) {
            if (!line.trim()) continue;
            if (useStderr) console.error(`[${label}] ${line}`);
            else console.log(`[${label}] ${line}`);
          }
        });
      };
      emit(child.stdout, false);
      emit(child.stderr, true);
    }

    child.on("exit", (code) => resolve({ tag: label, code: code ?? 1 }));
    child.on("error", (err) => {
      console.error(`[${label}] ${String(err)}`);
      resolve({ tag: label, code: 1 });
    });
  });
}

/** Spawn the CLI entry with local tsx (cwd = repo root). */
export function spawnBlessCli(args: string[]): Promise<number> {
  return spawnTsxScript("src/cli/index.ts", args);
}

export type ProxyPoolEntry = Doc<"proxyPool">;

export interface ProxyCliOptions {
  noProxy?: boolean;
  proxyPoolId?: string;
  proxyServer?: string;
  proxyUser?: string;
  proxyPass?: string;
}

export interface ResolvedProxy {
  useProxy: boolean;
  proxy?: { server: string; username?: string; password?: string };
  poolEntry?: ProxyPoolEntry;
}

/** Resolve proxy from flags, pool id, or an interactive picker (pool + env + direct). */
export async function resolveProxyForCli(
  client: ConvexHttpClient,
  opts: ProxyCliOptions,
  promptMessage = "Proxy",
): Promise<ResolvedProxy> {
  const pool = (await client.query(api.proxyPool.list, { status: "active" })) as ProxyPoolEntry[];
  const envProxyServer = opts.proxyServer ?? process.env.PROXY_SERVER;

  let poolEntry: ProxyPoolEntry | undefined;
  let useProxy = true;

  if (opts.noProxy) {
    useProxy = false;
  } else if (opts.proxyPoolId) {
    const entry = (await client.query(api.proxyPool.get, {
      proxyPoolId: opts.proxyPoolId as Id<"proxyPool">,
    })) as ProxyPoolEntry | null;
    if (!entry) throw new Error(`proxy pool entry not found: ${opts.proxyPoolId}`);
    poolEntry = entry;
  } else if (opts.proxyServer) {
    // explicit --proxy-server wins without prompting
  } else if (pool.length > 0 || envProxyServer) {
    type ProxyChoice = Id<"proxyPool"> | "__env__" | "__none__";
    const choices: Array<{ name: string; value: ProxyChoice }> = pool.map((p) => ({
      name: `${p.label} — ${p.server} (${p.geo})`,
      value: p._id as Id<"proxyPool">,
    }));
    if (envProxyServer) {
      choices.push({ name: `Env proxy (PROXY_SERVER → ${envProxyServer})`, value: "__env__" });
    }
    choices.push({ name: "No proxy (direct connection)", value: "__none__" });

    const choice = await select<ProxyChoice>({ message: promptMessage, choices });
    if (choice === "__none__") {
      useProxy = false;
    } else if (choice !== "__env__") {
      poolEntry = pool.find((p) => p._id === choice);
    }
  } else {
    console.log("no proxies in pool — add one with `bless proxy add` or pass --proxy-server");
    useProxy = false;
  }

  if (!useProxy) return { useProxy: false };

  if (poolEntry) {
    return {
      useProxy: true,
      poolEntry,
      proxy: {
        server: poolEntry.server,
        username: poolEntry.username,
        password: poolEntry.password,
      },
    };
  }

  const server = opts.proxyServer ?? process.env.PROXY_SERVER;
  if (!server) throw new Error("no proxy configured");
  return {
    useProxy: true,
    proxy: {
      server,
      username: opts.proxyUser ?? process.env.PROXY_USERNAME,
      password: opts.proxyPass ?? process.env.PROXY_PASSWORD,
    },
  };
}

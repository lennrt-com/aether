import "../src/shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const url = process.env.CONVEX_URL;
const workerKey = process.env.WORKER_KEY;
const proxyServer = process.env.PROXY_SERVER;
const proxyUser = process.env.PROXY_USERNAME;
const proxyPass = process.env.PROXY_PASSWORD;
if (!url || !workerKey) throw new Error("CONVEX_URL/WORKER_KEY not set");
if (!proxyServer) throw new Error("PROXY_SERVER not set (needed for phase 5 DoD)");
const client = new ConvexHttpClient(url);

const geo = "DE";
const tz = "Europe/Berlin";

const directIp = ((await (await fetch("https://api.ipify.org?format=json")).json()) as { ip: string }).ip;
console.log(`direct IP (no proxy): ${directIp}`);

const cliArgs = [
  "tsx", "scripts/provision-profile.ts",
  "--name", `verify-p5-${Date.now()}`,
  "--geo", geo,
  "--tz", tz,
  "--proxy-server", proxyServer,
  ...(proxyUser ? ["--proxy-user", proxyUser] : []),
  ...(proxyPass ? ["--proxy-pass", proxyPass] : []),
];
const out = execSync(`pnpm ${cliArgs.join(" ")}`, { encoding: "utf8" });
console.log(out);
const profileId = out.match(/profile created: (\S+)/)?.[1] as Id<"profiles"> | undefined;
if (!profileId) throw new Error("could not parse profileId from provision output");

const configs = await client.query(api.launchConfigs.listFor, { profileId });
const launchConfig = configs[0];
if (!launchConfig) throw new Error("no launch config attached");

const taskId = await client.mutation(api.tasks.enqueue, {
  workerKey,
  profileId,
  type: "browse",
  payload: {
    url: "https://example.com",
    evaluate:
      "Intl.DateTimeFormat().resolvedOptions().timeZone + '|' + navigator.language + '|' + innerWidth + 'x' + innerHeight",
  },
});

let worker: ChildProcess | null = null;
try {
  worker = spawn("pnpm", ["worker"], { stdio: "inherit", shell: true });

  const deadline = Date.now() + 4 * 60 * 1000;
  for (;;) {
    const task = await client.query(api.tasks.get, { taskId });
    if (task?.status === "done") break;
    if (task?.status === "failed") throw new Error(`task failed: ${task.lastError}`);
    if (Date.now() > deadline) throw new Error(`task timed out (${task?.status})`);
    await sleep(5000);
  }

  const session = await client.query(api.tasks.sessionForTask, { taskId });
  if (!session?.egressIp) throw new Error("session has no egressIp");
  console.log(`egress IP through proxy: ${session.egressIp}`);
  if (session.egressIp === directIp) {
    throw new Error("egress IP equals direct IP — proxy was not used");
  }
  if (session.launchConfigHash !== launchConfig.hash) {
    throw new Error("session launchConfigHash does not match launch config");
  }

  const events = await client.query(api.events.forSession, { sessionId: session._id });
  const evalEvent = events.find((e) => e.type === "ActionSucceeded" && e.actionId?.endsWith(":eval"));
  if (!evalEvent) throw new Error("missing eval event");
  const result = String((evalEvent.data as { evalResult?: unknown }).evalResult);
  console.log(`browser-reported: ${result}`);
  const [tzReported, lang, size] = result.split("|");

  if (tzReported !== launchConfig.timezone)
    throw new Error(`timezone mismatch: ${tzReported} != ${launchConfig.timezone}`);
  if (lang !== launchConfig.locale)
    throw new Error(`locale mismatch: ${lang} != ${launchConfig.locale}`);
  if (size !== `${launchConfig.windowWidth}x${launchConfig.windowHeight}`)
    throw new Error(
      `viewport mismatch: ${size} != ${launchConfig.windowWidth}x${launchConfig.windowHeight}`,
    );

  console.log("phase 5 OK — proxy egress, TZ, locale and viewport all match the identity bundle");
} finally {
  if (worker) {
    worker.kill();
    if (process.platform === "win32" && worker.pid) {
      spawn("taskkill", ["/pid", String(worker.pid), "/T", "/F"], { stdio: "ignore", shell: true });
    }
  }
}

import { input, confirm, select, password, checkbox, editor } from "@inquirer/prompts";
import { AGENT_MODEL_CHOICES, type AgentModelAlias } from "../shared/agentModels.js";
import { promptAgentModel } from "./agentModel.js";

function siteUrl(): string {
  const url = process.env.CONVEX_SITE_URL ?? process.env.VITE_CONVEX_SITE_URL;
  if (!url) throw new Error("CONVEX_SITE_URL not set (Convex deployment site URL for HTTP routes)");
  return url.replace(/\/$/, "");
}

function apiKey(): string {
  const key = process.env.AETHER_API_KEY;
  if (!key) throw new Error("AETHER_API_KEY not set");
  return key;
}

export interface RunJobCliOptions {
  startUrl: string;
  instructions: string;
  webhookUrl: string;
  model?: string;
  maxSteps?: number;
  proxyServer?: string;
  proxyUser?: string;
  proxyPass?: string;
  loginUser?: string;
  loginPass?: string;
  secretRefs?: string;
  mcpServers?: string;
  webhookSecret?: string;
  tools?: string;
  metadata?: string;
  poll?: boolean;
}

export async function submitAgentJob(opts: RunJobCliOptions): Promise<{ id: string; status: string }> {
  const payload: Record<string, unknown> = {
    startUrl: opts.startUrl,
    instructions: opts.instructions,
    webhookUrl: opts.webhookUrl,
    model: opts.model,
    maxSteps: opts.maxSteps,
    webhookSecret: opts.webhookSecret,
  };

  if (opts.proxyServer) {
    payload.proxy = {
      server: opts.proxyServer,
      username: opts.proxyUser,
      password: opts.proxyPass,
    };
  }

  if (opts.loginUser && opts.loginPass) {
    payload.login = { username: opts.loginUser, password: opts.loginPass };
  }

  if (opts.secretRefs) {
    payload.secretRefs = JSON.parse(opts.secretRefs) as Record<string, string>;
  }

  if (opts.mcpServers) {
    payload.mcpServers = opts.mcpServers.split(",").map((s) => s.trim()).filter(Boolean);
  }

  if (opts.tools) {
    payload.tools = opts.tools.split(",").map((t) => t.trim()).filter(Boolean);
  }

  if (opts.metadata) {
    payload.metadata = JSON.parse(opts.metadata) as Record<string, unknown>;
  }

  const response = await fetch(`${siteUrl()}/v1/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey(),
    },
    body: JSON.stringify(payload),
  });

  const body = (await response.json()) as { id?: string; status?: string; error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  if (!body.id) throw new Error("API returned no job id");
  return { id: body.id, status: body.status ?? "pending" };
}

export async function pollAgentJob(jobId: string): Promise<unknown> {
  const response = await fetch(`${siteUrl()}/v1/jobs/${jobId}`, {
    headers: { "X-API-Key": apiKey() },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${response.status}`);
  }
  return body;
}

export async function runJobCli(opts: RunJobCliOptions): Promise<number> {
  const created = await submitAgentJob(opts);
  console.log(`\njob created: ${created.id} (${created.status})`);

  if (!opts.poll) {
    console.log(`poll:  pnpm aether jobs`);
    console.log(`curl:  GET ${siteUrl()}/v1/jobs/${created.id}`);
    return 0;
  }

  console.log("polling until done (ctrl-c to stop)…\n");
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const job = (await pollAgentJob(created.id)) as {
      status: string;
      result?: unknown;
      error?: string | null;
    };
    console.log(`[${created.id}] ${job.status}`);
    if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
      console.log(JSON.stringify(job, null, 2));
      return job.status === "done" ? 0 : 1;
    }
  }
}

async function promptInstructions(): Promise<string> {
  const mode = await select({
    message: "How do you want to enter instructions?",
    choices: [
      { name: "Short line (type here)", value: "line" },
      { name: "Long text (open editor)", value: "editor" },
    ],
    default: "line",
  });

  if (mode === "editor") {
    const text = await editor({
      message: "Instructions / goal",
      waitForUserInput: false,
    });
    const trimmed = text.trim();
    if (!trimmed) throw new Error("instructions cannot be empty");
    return trimmed;
  }

  const line = await input({
    message: "Instructions / goal",
    validate: (v) => (v.trim() ? true : "required"),
  });
  return line.trim();
}

/**
 * Guided job wizard — used by `pnpm aether` menu and bare `pnpm aether run`.
 * Optional steps are skipped unless you opt in.
 */
export async function runJobInteractive(
  partial: Partial<RunJobCliOptions> = {},
): Promise<number> {
  console.log("\nSubmit an agent job\n");

  const startUrl =
    partial.startUrl ??
    (await input({
      message: "Start URL",
      default: process.env.START_URL ?? "https://example.com",
    })).trim();

  const instructions = partial.instructions ?? (await promptInstructions());

  const webhookUrl =
    partial.webhookUrl ??
    (await input({
      message: "Webhook URL (required — e.g. https://webhook.site/…)",
      default: process.env.AETHER_DEFAULT_WEBHOOK_URL ?? "",
      validate: (v) => {
        const t = v.trim();
        if (!t) return "required";
        try {
          new URL(t);
          return true;
        } catch {
          return "must be a valid URL";
        }
      },
    })).trim();

  let modelAlias: AgentModelAlias;
  if (partial.model && AGENT_MODEL_CHOICES.includes(partial.model as AgentModelAlias)) {
    modelAlias = partial.model as AgentModelAlias;
  } else {
    modelAlias = await promptAgentModel(partial.model ?? process.env.AGENT_MODEL);
  }

  const opts: RunJobCliOptions = {
    startUrl,
    instructions,
    webhookUrl,
    model: modelAlias,
    poll: partial.poll,
  };

  const advanced = await confirm({
    message: "Configure optional settings? (proxy, login, tools, max steps)",
    default: false,
  });

  if (advanced) {
    const maxStepsRaw = await input({
      message: "Max steps",
      default: partial.maxSteps ? String(partial.maxSteps) : "50",
    });
    const n = Number(maxStepsRaw);
    if (Number.isFinite(n) && n > 0) opts.maxSteps = n;

    const tools = await checkbox({
      message: "Tools",
      choices: [
        { name: "captcha", value: "captcha", checked: true },
        { name: "email", value: "email", checked: false },
        { name: "phone", value: "phone", checked: false },
      ],
    });
    if (tools.length > 0) opts.tools = tools.join(",");

    const useProxy = await confirm({ message: "Use a proxy?", default: false });
    if (useProxy) {
      opts.proxyServer = (
        await input({
          message: "Proxy server (host:port)",
          default: process.env.PROXY_SERVER ?? "",
          validate: (v) => (v.trim() ? true : "required"),
        })
      ).trim();
      opts.proxyUser = (
        await input({
          message: "Proxy username (blank = none)",
          default: process.env.PROXY_USERNAME ?? "",
        })
      ).trim() || undefined;
      const pass = await password({ message: "Proxy password", mask: "*" });
      opts.proxyPass = pass || undefined;
    }

    const useLogin = await confirm({
      message: "Provide login credentials for the agent?",
      default: false,
    });
    if (useLogin) {
      opts.loginUser = (
        await input({
          message: "Username / email",
          validate: (v) => (v.trim() ? true : "required"),
        })
      ).trim();
      opts.loginPass = await password({ message: "Password", mask: "*" });
    } else {
      const useVault = await confirm({
        message: "Use Vaultwarden secret refs (bw:Item/field)?",
        default: false,
      });
      if (useVault) {
        const usernameRef = (
          await input({
            message: "Username ref (e.g. bw:Cursor Plan/username)",
            validate: (v) => (v.startsWith("bw:") ? true : "must start with bw:"),
          })
        ).trim();
        const passwordRef = (
          await input({
            message: "Password ref (e.g. bw:Cursor Plan/password)",
            validate: (v) => (v.startsWith("bw:") ? true : "must start with bw:"),
          })
        ).trim();
        const refs: Record<string, string> = {
          username: usernameRef,
          password: passwordRef,
        };
        const totpRef = (
          await input({
            message: "TOTP ref (optional, blank to skip)",
            default: "",
          })
        ).trim();
        if (totpRef) refs.totp = totpRef;
        opts.secretRefs = JSON.stringify(refs);
      }
    }

    const useMcp = await confirm({
      message: "Attach MCP server connections?",
      default: false,
    });
    if (useMcp) {
      opts.mcpServers = (
        await input({
          message: "Connection names (comma-separated)",
          default: "bitwarden",
        })
      ).trim();
    }

    const secret = await input({
      message: "Webhook HMAC secret (blank = use deployment default)",
      default: "",
    });
    if (secret.trim()) opts.webhookSecret = secret.trim();
  }

  opts.poll =
    partial.poll ??
    (await confirm({
      message: "Poll until the job finishes?",
      default: true,
    }));

  console.log("\n--- job ---");
  console.log(`startUrl:      ${opts.startUrl}`);
  console.log(`model:         ${opts.model}`);
  console.log(`webhookUrl:    ${opts.webhookUrl}`);
  console.log(`instructions:  ${opts.instructions.slice(0, 120)}${opts.instructions.length > 120 ? "…" : ""}`);
  if (opts.maxSteps) console.log(`maxSteps:      ${opts.maxSteps}`);
  if (opts.tools) console.log(`tools:         ${opts.tools}`);
  if (opts.proxyServer) console.log(`proxy:         ${opts.proxyServer}`);
  if (opts.loginUser) console.log(`login:         ${opts.loginUser}`);
  if (opts.secretRefs) console.log(`secretRefs:    ${opts.secretRefs}`);
  if (opts.mcpServers) console.log(`mcpServers:    ${opts.mcpServers}`);
  console.log(`poll:          ${opts.poll ? "yes" : "no"}`);
  console.log("-----------\n");

  const ok = await confirm({ message: "Submit this job?", default: true });
  if (!ok) {
    console.log("cancelled");
    return 0;
  }

  return runJobCli(opts);
}

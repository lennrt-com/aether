// Thin wrapper over the CapSolver REST API (api.capsolver.com).
// Docs: https://docs.capsolver.com/en/guide/captcha/ReCaptchaV2/

const DEFAULT_BASE_URL = "https://api.capsolver.com";

export class CapSolverApiError extends Error {
  constructor(
    public readonly errorId: number,
    public readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = "CapSolverApiError";
  }
}

export interface CapSolverProxy {
  server: string;
  username?: string;
  password?: string;
}

export interface CapSolverStructuredProxy {
  proxyType: "http" | "https" | "socks4" | "socks5";
  proxyAddress: string;
  proxyPort: number;
  proxyLogin?: string;
  proxyPassword?: string;
}

export interface RecaptchaV2SolveOpts {
  websiteURL: string;
  websiteKey: string;
  isInvisible?: boolean;
  isEnterprise?: boolean;
  pageAction?: string;
  recaptchaDataSValue?: string;
  enterprisePayload?: { s?: string };
  apiDomain?: string;
  proxy?: CapSolverProxy | null;
}

export interface CapSolverRecaptchaSolution {
  gRecaptchaResponse: string;
  userAgent?: string;
  secChUa?: string;
  createTime?: number;
  "recaptcha-ca-t"?: string;
  "recaptcha-ca-e"?: string;
}

export interface CapSolverClient {
  createTask(task: Record<string, unknown>): Promise<string>;
  getTaskResult(taskId: string): Promise<{
    status: string;
    solution?: Partial<CapSolverRecaptchaSolution>;
    errorId?: number;
    errorCode?: string;
    errorDescription?: string;
  }>;
  solveRecaptchaV2(opts: RecaptchaV2SolveOpts): Promise<CapSolverRecaptchaSolution>;
}

/** Parse a proxy server string into CapSolver's structured proxy fields. */
export function toCapSolverProxy(proxy: CapSolverProxy): CapSolverStructuredProxy {
  let raw = proxy.server.trim();
  let proxyType: CapSolverStructuredProxy["proxyType"] = "http";

  const schemeMatch = raw.match(/^(https?|socks4|socks5):\/\//i);
  if (schemeMatch) {
    proxyType = schemeMatch[1].toLowerCase() as CapSolverStructuredProxy["proxyType"];
    raw = raw.slice(schemeMatch[0].length);
  }

  const [hostPart, portPart] = raw.split(":");
  const proxyPort = Number(portPart);
  if (!hostPart || !portPart || Number.isNaN(proxyPort)) {
    throw new Error(`invalid proxy server format: ${proxy.server}`);
  }

  return {
    proxyType,
    proxyAddress: hostPart,
    proxyPort,
    ...(proxy.username ? { proxyLogin: proxy.username } : {}),
    ...(proxy.password ? { proxyPassword: proxy.password } : {}),
  };
}

/** Whether CapSolver should route through the browser session proxy (off by default). */
export function capSolverUsesBrowserProxy(): boolean {
  return process.env.CAPSOLVER_USE_BROWSER_PROXY === "true";
}

const PROXY_CONNECT_ERROR_RE = /^ERROR_PROXY_/;

function isCapSolverProxyError(err: unknown): boolean {
  return err instanceof CapSolverApiError && PROXY_CONNECT_ERROR_RE.test(err.errorCode);
}

async function solveRecaptchaV2Once(
  createTaskFn: (task: Record<string, unknown>) => Promise<string>,
  getTaskResultFn: CapSolverClient["getTaskResult"],
  opts: RecaptchaV2SolveOpts,
): Promise<CapSolverRecaptchaSolution> {
  const hasProxy = opts.proxy != null;
  const taskType = opts.isEnterprise
    ? hasProxy
      ? "ReCaptchaV2EnterpriseTask"
      : "ReCaptchaV2EnterpriseTaskProxyLess"
    : hasProxy
      ? "ReCaptchaV2Task"
      : "ReCaptchaV2TaskProxyLess";

  const task: Record<string, unknown> = {
    type: taskType,
    websiteURL: opts.websiteURL,
    websiteKey: opts.websiteKey,
  };
  if (opts.isInvisible) task.isInvisible = true;
  if (opts.pageAction) task.pageAction = opts.pageAction;
  if (opts.recaptchaDataSValue) task.recaptchaDataSValue = opts.recaptchaDataSValue;
  if (opts.enterprisePayload?.s) {
    task.enterprisePayload = { s: opts.enterprisePayload.s };
  }
  if (opts.apiDomain) task.apiDomain = opts.apiDomain;
  if (hasProxy) {
    const structured = toCapSolverProxy(opts.proxy!);
    Object.assign(task, structured);
    const proxyTypeOverride = process.env.CAPSOLVER_PROXY_TYPE?.trim();
    if (proxyTypeOverride) task.proxyType = proxyTypeOverride;
  }

  const taskId = await createTaskFn(task);
  const timeoutMs = 120_000;
  const pollMs = 2_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const resp = await getTaskResultFn(taskId);
    if (resp.status === "ready") {
      const solution = resp.solution;
      if (!solution?.gRecaptchaResponse) {
        throw new Error("CapSolver returned ready but no gRecaptchaResponse");
      }
      return solution as CapSolverRecaptchaSolution;
    }
    if (resp.status === "failed" || (resp.errorId != null && resp.errorId !== 0)) {
      throw new CapSolverApiError(
        resp.errorId ?? -1,
        resp.errorCode ?? "SOLVE_FAILED",
        resp.errorDescription ?? "getTaskResult failed",
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error("CapSolver solve timed out after 120s");
}

export function createCapSolverClient(
  apiKey = process.env.CAPSOLVER_API_KEY,
  baseUrl = process.env.CAPSOLVER_BASE_URL ?? DEFAULT_BASE_URL,
): CapSolverClient {
  if (!apiKey) throw new Error("CAPSOLVER_API_KEY not set");

  async function request<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      try {
        const parsed = JSON.parse(text) as {
          errorId?: number;
          errorCode?: string;
          errorDescription?: string;
        };
        if (parsed.errorCode) {
          throw new CapSolverApiError(
            parsed.errorId ?? -1,
            parsed.errorCode,
            parsed.errorDescription ?? `POST ${path} failed`,
          );
        }
      } catch (err) {
        if (err instanceof CapSolverApiError) throw err;
      }
      throw new CapSolverApiError(-1, "HTTP_ERROR", `POST ${path} -> HTTP ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }

  async function createTask(task: Record<string, unknown>): Promise<string> {
    const resp = await request<{
      errorId: number;
      errorCode?: string;
      errorDescription?: string;
      taskId?: string;
    }>("/createTask", { clientKey: apiKey, task });

    if (resp.errorId !== 0) {
      throw new CapSolverApiError(
        resp.errorId,
        resp.errorCode ?? "UNKNOWN",
        resp.errorDescription ?? "createTask failed",
      );
    }
    if (!resp.taskId) throw new Error("createTask returned no taskId");
    return resp.taskId;
  }

  async function getTaskResult(taskId: string) {
    return request<{
      status: string;
      solution?: Partial<CapSolverRecaptchaSolution>;
      errorId?: number;
      errorCode?: string;
      errorDescription?: string;
    }>("/getTaskResult", { clientKey: apiKey, taskId });
  }

  async function solveRecaptchaV2(opts: RecaptchaV2SolveOpts): Promise<CapSolverRecaptchaSolution> {
    const browserProxy =
      capSolverUsesBrowserProxy() && opts.proxy != null ? opts.proxy : null;

    if (browserProxy) {
      try {
        return await solveRecaptchaV2Once(createTask, getTaskResult, {
          ...opts,
          proxy: browserProxy,
        });
      } catch (err) {
        if (!isCapSolverProxyError(err)) throw err;
        // Coronium/residential proxies usually only accept connections from the
        // user's machine (via our local proxy-chain relay), not CapSolver's cloud.
        return await solveRecaptchaV2Once(createTask, getTaskResult, { ...opts, proxy: null });
      }
    }

    return await solveRecaptchaV2Once(createTask, getTaskResult, { ...opts, proxy: null });
  }

  return {
    createTask,
    getTaskResult,
    solveRecaptchaV2,
  };
}

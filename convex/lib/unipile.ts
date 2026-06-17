// Minimal Unipile v2 client for Convex actions (restriction monitoring).
// Mirrors src/channels/unipile.ts — Convex cannot import from src/.

const DEFAULT_BASE_URL = "https://api.unipile.com";

export interface UnipileErrorBody {
  object?: string;
  status?: number;
  type?: string;
  title?: string;
  req_id?: string;
}

export class UnipileApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: UnipileErrorBody,
  ) {
    super(message);
    this.name = "UnipileApiError";
  }
}

export interface UnipileUserProfile {
  id: string;
  object: string;
  display_name: string;
  public_identifier?: string;
  profile_url?: string;
  [key: string]: unknown;
}

function parseErrorBody(text: string): UnipileErrorBody | undefined {
  try {
    return JSON.parse(text) as UnipileErrorBody;
  } catch {
    return undefined;
  }
}

export function isInsufficientPermissions(err: unknown): err is UnipileApiError {
  return (
    err instanceof UnipileApiError &&
    err.status === 403 &&
    err.body?.type === "provider/insufficient_permissions"
  );
}

export async function getUserProfile(
  apiKey: string,
  accountId: string,
  userId: string,
  baseUrl = process.env.UNIPILE_BASE_URL ?? DEFAULT_BASE_URL,
): Promise<UnipileUserProfile> {
  const path = `/v2/${accountId}/users/${encodeURIComponent(userId)}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: {
      "X-API-KEY": apiKey,
      accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    const body = parseErrorBody(text);
    throw new UnipileApiError(
      res.status,
      `GET ${path} -> HTTP ${res.status}: ${text}`,
      body,
    );
  }
  return (await res.json()) as UnipileUserProfile;
}

export interface UnipileProbeRaw {
  ok: boolean;
  httpStatus: number;
  /** Parsed JSON when available, otherwise a truncated raw text snippet. */
  body: unknown;
  errorType?: string;
  reqId?: string;
}

// Low-level probe that never throws — captures the full HTTP outcome so callers
// can inspect exactly what LinkedIn/Unipile returned (diagnostics, no events).
export async function probeUserProfileRaw(
  apiKey: string,
  accountId: string,
  userId: string,
  baseUrl = process.env.UNIPILE_BASE_URL ?? DEFAULT_BASE_URL,
): Promise<UnipileProbeRaw> {
  const path = `/v2/${accountId}/users/${encodeURIComponent(userId)}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: {
      "X-API-KEY": apiKey,
      accept: "application/json",
    },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 1000);
  }
  if (res.ok) {
    return { ok: true, httpStatus: res.status, body };
  }
  const errBody = parseErrorBody(text) ?? {};
  return {
    ok: false,
    httpStatus: res.status,
    body,
    errorType: errBody.type,
    reqId: errBody.req_id,
  };
}

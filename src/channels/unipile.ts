// Thin wrapper over the Unipile v2 REST API (api.unipile.com, X-API-KEY auth).
// v2 has no DSN — one global base URL.

const DEFAULT_BASE_URL = "https://api.unipile.com";

export class UnipileApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "UnipileApiError";
  }
}

export interface ChatStarted {
  object: "ChatStarted";
  chat_id: string;
  message_id: string | string[] | null;
}

export interface RelationRequest {
  object: "RelationRequest";
  id: string;
  type: "sent" | "received";
}

export interface UnipileAccount {
  id: string;
  provider?: string;
  name?: string;
  [key: string]: unknown;
}

export interface UnipileUser {
  id: string;
  object: "User";
  display_name: string;
  public_identifier?: string;
  profile_url?: string;
  description?: string;
  specifics?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface UnipileClient {
  listAccounts(): Promise<{ items: UnipileAccount[] }>;
  getProfile(accountId: string, userId: string): Promise<UnipileUser>;
  listRelations(accountId: string, userId?: string): Promise<{ items: unknown[] }>;
  sendMessage(accountId: string, userId: string, text: string): Promise<ChatStarted>;
  sendInvitation(
    accountId: string,
    userId: string,
    message?: string,
  ): Promise<RelationRequest>;
}

export function createUnipileClient(
  apiKey = process.env.UNIPILE_API_KEY,
  baseUrl = process.env.UNIPILE_BASE_URL ?? DEFAULT_BASE_URL,
): UnipileClient {
  if (!apiKey) throw new Error("UNIPILE_API_KEY not set");

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "X-API-KEY": apiKey!,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      throw new UnipileApiError(res.status, `${method} ${path} -> HTTP ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }

  return {
    listAccounts: () => request("GET", "/v2/accounts/"),
    getProfile: (accountId, userId) =>
      request("GET", `/v2/${accountId}/users/${encodeURIComponent(userId)}`),
    listRelations: (accountId, userId = "me") =>
      request("GET", `/v2/${accountId}/users/${encodeURIComponent(userId)}/relations`),
    sendMessage: (accountId, userId, text) =>
      request("POST", `/v2/${accountId}/chats/send`, { users_ids: userId, text }),
    sendInvitation: (accountId, userId, message) =>
      request("POST", `/v2/${accountId}/users/me/relation-requests`, {
        user_id: userId,
        ...(message ? { message } : {}),
      }),
  };
}

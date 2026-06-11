// Thin wrapper over the smtp.dev REST API (api.smtp.dev, X-API-KEY auth).
// Docs: https://smtp.dev/docs/api/ — accounts own mailboxes (INBOX, Sent, ...),
// mailboxes own messages (newest first).

const DEFAULT_BASE_URL = "https://api.smtp.dev";

export class SmtpDevApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SmtpDevApiError";
  }
}

export interface SmtpDevMailbox {
  id: string;
  path: string;
  totalMessages: number;
}

export interface SmtpDevAccount {
  id: string;
  address: string;
  mailboxes?: SmtpDevMailbox[];
}

export interface SmtpDevMessage {
  id: string;
  from?: { address?: string; name?: string };
  subject?: string;
  intro?: string;
  text?: string;
  createdAt?: string;
}

export interface SmtpDevClient {
  /** POST /accounts — returns the account incl. its default mailboxes. */
  createAccount(address: string, password: string): Promise<SmtpDevAccount>;
  /** GET /accounts/{id}/mailboxes — find INBOX (case-insensitive path match). */
  findInbox(accountId: string): Promise<SmtpDevMailbox>;
  /** GET /accounts/{id}/mailboxes/{id}/messages — newest first. */
  listMessages(accountId: string, mailboxId: string): Promise<SmtpDevMessage[]>;
  /**
   * Poll the inbox until a message from LinkedIn with a 6-digit code arrives.
   * Returns null on timeout.
   */
  waitForVerificationCode(
    accountId: string,
    mailboxId: string,
    opts?: { timeoutMs?: number; pollMs?: number; senderPattern?: RegExp },
  ): Promise<{ code: string; messageId: string; subject: string } | null>;
}

const CODE_RE = /\b(\d{6})\b/;
const DEFAULT_SENDER_RE = /linkedin/i;

export function extractVerificationCode(msg: SmtpDevMessage): string | null {
  for (const field of [msg.subject, msg.intro, msg.text]) {
    const match = field?.match(CODE_RE);
    if (match) return match[1];
  }
  return null;
}

export function createSmtpDevClient(
  apiKey = process.env.SMTP_DEV_API_KEY,
  baseUrl = process.env.SMTP_DEV_BASE_URL ?? DEFAULT_BASE_URL,
): SmtpDevClient {
  if (!apiKey) throw new Error("SMTP_DEV_API_KEY not set");

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
      throw new SmtpDevApiError(res.status, `${method} ${path} -> HTTP ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }

  async function findInbox(accountId: string): Promise<SmtpDevMailbox> {
    const res = await request<{ member?: SmtpDevMailbox[] }>(
      "GET",
      `/accounts/${accountId}/mailboxes`,
    );
    const inbox = res.member?.find((m) => m.path.toUpperCase() === "INBOX");
    if (!inbox) throw new Error(`no INBOX mailbox for smtp.dev account ${accountId}`);
    return inbox;
  }

  async function listMessages(accountId: string, mailboxId: string): Promise<SmtpDevMessage[]> {
    const res = await request<{ member?: SmtpDevMessage[] }>(
      "GET",
      `/accounts/${accountId}/mailboxes/${mailboxId}/messages`,
    );
    return res.member ?? [];
  }

  return {
    createAccount: (address, password) =>
      request("POST", "/accounts", { address, password }),
    findInbox,
    listMessages,
    waitForVerificationCode: async (accountId, mailboxId, opts) => {
      const timeoutMs = opts?.timeoutMs ?? 120_000;
      const pollMs = opts?.pollMs ?? 5_000;
      const senderRe = opts?.senderPattern ?? DEFAULT_SENDER_RE;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const messages = await listMessages(accountId, mailboxId);
        for (const msg of messages) {
          const sender = `${msg.from?.address ?? ""} ${msg.from?.name ?? ""}`;
          if (!senderRe.test(sender)) continue;
          const code = extractVerificationCode(msg);
          if (code) return { code, messageId: msg.id, subject: msg.subject ?? "" };
        }
        if (Date.now() + pollMs > deadline) return null;
        await new Promise((r) => setTimeout(r, pollMs));
      }
    },
  };
}

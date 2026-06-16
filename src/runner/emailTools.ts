// AI SDK tools wrapping the smtp.dev REST API, passed to the Stagehand agent
// via agent({ tools }). smtp.dev is REST-only (no MCP), so the agent gets
// email access through these two function tools.
// NOTE: `tool` comes from Stagehand's re-export (its bundled ai@5) — the app's
// own ai@6 ToolSet type is not assignable to Stagehand's agent({ tools }).
import { tool, type AgentConfig } from "@browserbasehq/stagehand";
import { z } from "zod";

export type StagehandToolSet = NonNullable<AgentConfig["tools"]>;
import { randomBytes } from "node:crypto";
import { createSmtpDevClient, type SmtpDevClient } from "../channels/smtpDev.js";

export interface EmailToolsState {
  address: string | null;
  smtpDevAccountId: string | null;
  inboxId: string | null;
  verificationCode: string | null;
}

export type EmailToolAudit = (
  toolName: string,
  data: Record<string, unknown>,
  ok: boolean,
) => Promise<void>;

function slugify(input: string): string {
  const slug = input.toLowerCase().replace(/[^a-z0-9]/g, "");
  return slug.slice(0, 20) || "user";
}

export function buildEmailTools(opts: {
  localPartBase: string;
  accountPassword: string;
  /** Reuse an already-created mailbox (login flows) instead of creating one. */
  existing?: { address: string; smtpDevAccountId: string };
  client?: SmtpDevClient;
  audit?: EmailToolAudit;
}): { tools: StagehandToolSet; state: EmailToolsState } {
  const domain = process.env.SMTP_DEV_DOMAIN;
  if (!domain) throw new Error("SMTP_DEV_DOMAIN not set");
  const client = opts.client ?? createSmtpDevClient();
  const audit = opts.audit ?? (async () => {});

  const state: EmailToolsState = {
    address: opts.existing?.address ?? null,
    smtpDevAccountId: opts.existing?.smtpDevAccountId ?? null,
    inboxId: null,
    verificationCode: null,
  };

  const tools: StagehandToolSet = {
    create_email_address: tool({
      description:
        "Create a fresh email address (with a working inbox) to use for account signups. " +
        "Returns the full email address. Call this once, before filling any signup form.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          if (state.address) {
            return { success: true, address: state.address, note: "already created" };
          }
          const suffix = randomBytes(2).toString("hex");
          const address = `${slugify(opts.localPartBase)}${suffix}@${domain}`;
          const account = await client.createAccount(address, opts.accountPassword);
          const inbox =
            account.mailboxes?.find((m) => m.path.toUpperCase() === "INBOX") ??
            (await client.findInbox(account.id));
          state.address = account.address;
          state.smtpDevAccountId = account.id;
          state.inboxId = inbox.id;
          await audit("create_email_address", { address: account.address }, true);
          return { success: true, address: account.address };
        } catch (err) {
          await audit("create_email_address", { error: String(err) }, false);
          return { success: false, error: String(err) };
        }
      },
    }),

    read_verification_code: tool({
      description:
        "Read the latest verification code (6-digit) from the inbox of the email address " +
        "created with create_email_address. Polls until the email arrives (up to the timeout). " +
        "ONLY call this when the browser shows the email verification screen (6-digit code sent to your email). " +
        "Do NOT call after phone/SMS verification — wait until you see the email code prompt first.",
      inputSchema: z.object({
        timeoutSeconds: z
          .number()
          .min(10)
          .max(180)
          .optional()
          .describe("How long to wait for the email (default 120s)"),
      }),
      execute: async ({ timeoutSeconds }) => {
        try {
          if (!state.smtpDevAccountId) {
            return { success: false, error: "no email address created yet — call create_email_address first" };
          }
          // Lazily resolve INBOX for pre-existing mailboxes (login flows).
          if (!state.inboxId) {
            state.inboxId = (await client.findInbox(state.smtpDevAccountId)).id;
          }
          const result = await client.waitForVerificationCode(
            state.smtpDevAccountId,
            state.inboxId,
            { timeoutMs: (timeoutSeconds ?? 120) * 1000 },
          );
          if (!result) {
            const messages = await client.listMessages(state.smtpDevAccountId, state.inboxId);
            const preview = messages.slice(0, 3).map((m) => ({
              from: m.from?.address,
              subject: m.subject,
            }));
            await audit(
              "read_verification_code",
              { error: "timeout", inboxCount: messages.length, recent: preview },
              false,
            );
            return {
              success: false,
              error:
                messages.length === 0
                  ? "no verification email arrived before the timeout — only call this when the email verification screen is visible"
                  : `no verification code found in ${messages.length} inbox message(s) before the timeout`,
            };
          }
          state.verificationCode = result.code;
          await audit("read_verification_code", { subject: result.subject, code: result.code }, true);
          return { success: true, code: result.code, subject: result.subject };
        } catch (err) {
          await audit("read_verification_code", { error: String(err) }, false);
          return { success: false, error: String(err) };
        }
      },
    }),
  };

  return { tools, state };
}

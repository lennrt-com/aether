// AI SDK tools wrapping the 5sim REST API, passed to the Stagehand agent
// via agent({ tools }). 5sim is REST-only (no MCP), so the agent gets
// phone/SMS access through these two function tools.
import { tool, type AgentConfig } from "@browserbasehq/stagehand";
import { z } from "zod";
import {
  createFiveSimClient,
  fiveSimCountryForGeo,
  phoneDigitsOnly,
  type FiveSimClient,
} from "../channels/fiveSim.js";

export type StagehandToolSet = NonNullable<AgentConfig["tools"]>;

export interface PhoneToolsState {
  orderId: number | null;
  phone: string | null;
  verificationCode: string | null;
}

export type PhoneToolAudit = (
  toolName: string,
  data: Record<string, unknown>,
  ok: boolean,
) => Promise<void>;

export function buildPhoneTools(opts: {
  /** Profile geo (e.g. DE, US) — maps to a 5sim country slug unless FIVE_SIM_COUNTRY is set. */
  geo?: string;
  client?: FiveSimClient;
  audit?: PhoneToolAudit;
}): { tools: StagehandToolSet; state: PhoneToolsState } {
  const audit = opts.audit ?? (async () => {});
  const geo = opts.geo ?? process.env.DEFAULT_GEO ?? "DE";
  const operator = process.env.FIVE_SIM_OPERATOR ?? "any";
  const product = process.env.FIVE_SIM_PRODUCT ?? "linkedin";

  const state: PhoneToolsState = {
    orderId: null,
    phone: null,
    verificationCode: null,
  };

  const tools: StagehandToolSet = {
    get_phone_number: tool({
      description:
        "Buy a fresh virtual phone number from 5sim to use when LinkedIn asks for phone verification. " +
        "Returns the full international number (with +) and a digits-only version for form fields. " +
        "ONLY call when the phone number input field is visible — not during email verification.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!process.env.FIVE_SIM_API_KEY) {
          return { success: false, error: "FIVE_SIM_API_KEY not set — cannot buy a phone number" };
        }
        try {
          if (state.phone && state.orderId) {
            return {
              success: true,
              phone: state.phone,
              digitsOnly: phoneDigitsOnly(state.phone),
              orderId: state.orderId,
              note: "already purchased",
            };
          }
          const client = opts.client ?? createFiveSimClient();
          const country = fiveSimCountryForGeo(geo);
          const order = await client.buyActivation(country, operator, product);
          state.orderId = order.id;
          state.phone = order.phone;
          await audit(
            "get_phone_number",
            { phone: order.phone, orderId: order.id, country, operator, product },
            true,
          );
          return {
            success: true,
            phone: order.phone,
            digitsOnly: phoneDigitsOnly(order.phone),
            orderId: order.id,
            country,
            operator,
          };
        } catch (err) {
          await audit("get_phone_number", { error: String(err) }, false);
          return { success: false, error: String(err) };
        }
      },
    }),

    read_phone_verification_code: tool({
      description:
        "Read the SMS verification code sent to the phone number from get_phone_number. " +
        "Polls 5sim until the SMS arrives (up to the timeout). " +
        "Call this after submitting a form that triggers a phone verification SMS.",
      inputSchema: z.object({
        timeoutSeconds: z
          .number()
          .min(10)
          .max(300)
          .optional()
          .describe("How long to wait for the SMS (default 120s)"),
      }),
      execute: async ({ timeoutSeconds }) => {
        if (!process.env.FIVE_SIM_API_KEY) {
          return { success: false, error: "FIVE_SIM_API_KEY not set — cannot read SMS codes" };
        }
        try {
          if (!state.orderId) {
            return {
              success: false,
              error: "no phone number purchased yet — call get_phone_number first",
            };
          }
          const client = opts.client ?? createFiveSimClient();
          const result = await client.waitForVerificationCode(state.orderId, {
            timeoutMs: (timeoutSeconds ?? 120) * 1000,
          });
          if (!result) {
            await audit("read_phone_verification_code", { error: "timeout" }, false);
            return { success: false, error: "no SMS arrived before the timeout" };
          }
          state.verificationCode = result.code;
          // Mark the order finished so 5sim knows the number was used successfully.
          client.finishOrder(state.orderId).catch(() => {});
          await audit(
            "read_phone_verification_code",
            { code: result.code, smsPreview: result.text.slice(0, 120) },
            true,
          );
          return { success: true, code: result.code, smsText: result.text };
        } catch (err) {
          await audit("read_phone_verification_code", { error: String(err) }, false);
          return { success: false, error: String(err) };
        }
      },
    }),
  };

  return { tools, state };
}

// AI SDK tools wrapping the 5sim REST API, passed to the Stagehand agent
// via agent({ tools }). 5sim is REST-only (no MCP), so the agent gets
// phone/SMS access through these function tools.
import { tool, type AgentConfig } from "@browserbasehq/stagehand";
import { z } from "zod";
import {
  createFiveSimClient,
  fiveSimCountryForGeo,
  phoneDigitsOnly,
  type FiveSimClient,
} from "../channels/fiveSim.js";

export type StagehandToolSet = NonNullable<AgentConfig["tools"]>;

const PHONE_CANCEL_MIN_WAIT_MS = Number(process.env.FIVE_SIM_CANCEL_MIN_WAIT_MS ?? 120_000);
const PHONE_MAX_NUMBER_ATTEMPTS = Number(process.env.FIVE_SIM_MAX_ATTEMPTS ?? 5);
const PHONE_READ_TIMEOUT_SECONDS = Number(process.env.FIVE_SIM_READ_TIMEOUT_SECONDS ?? 120);

export interface PhoneToolsState {
  orderId: number | null;
  phone: string | null;
  verificationCode: string | null;
  /** When the current 5sim order was purchased (ms since epoch). */
  orderPurchasedAt: number | null;
  /** How many numbers have been bought this session (max PHONE_MAX_NUMBER_ATTEMPTS). */
  numberAttempts: number;
}

export type PhoneToolAudit = (
  toolName: string,
  data: Record<string, unknown>,
  ok: boolean,
) => Promise<void>;

function cancelWaitSeconds(purchasedAt: number | null): number {
  if (!purchasedAt) return 0;
  return Math.max(0, Math.ceil((PHONE_CANCEL_MIN_WAIT_MS - (Date.now() - purchasedAt)) / 1000));
}

function canCancelOrder(purchasedAt: number | null): boolean {
  return cancelWaitSeconds(purchasedAt) === 0;
}

function clearActiveOrder(state: PhoneToolsState): void {
  state.orderId = null;
  state.phone = null;
  state.verificationCode = null;
  state.orderPurchasedAt = null;
}

const LINKEDIN_PHONE_RETRY_UI =
  "On LinkedIn, go back to the phone number entry screen before buying a new number: click Back, " +
  "'Edit phone number', 'Use a different number', 'Add another phone number', 'Change', or the equivalent " +
  "in the page language — whatever clears the old number and shows an empty phone input again.";

export function buildPhoneTools(opts: {
  /** Profile geo (e.g. DE, US) — maps to a 5sim country slug unless FIVE_SIM_COUNTRY is set. */
  geo?: string;
  client?: FiveSimClient;
  audit?: PhoneToolAudit;
}): { tools: StagehandToolSet; state: PhoneToolsState } {
  const audit = opts.audit ?? (async () => {});
  const geo = opts.geo ?? process.env.DEFAULT_GEO ?? "DE";
  const operator = process.env.FIVE_SIM_OPERATOR ?? "any";
  const product = process.env.FIVE_SIM_PRODUCT ?? "any";

  const state: PhoneToolsState = {
    orderId: null,
    phone: null,
    verificationCode: null,
    orderPurchasedAt: null,
    numberAttempts: 0,
  };

  const tools: StagehandToolSet = {
    get_phone_number: tool({
      description:
        "Buy a fresh virtual phone number from 5sim to use when LinkedIn asks for phone verification. " +
        "Returns the full international number (with +) and a digits-only version for form fields. " +
        "ONLY call when the phone number input field is visible and empty (or after cancel_phone_number). " +
        `At most ${PHONE_MAX_NUMBER_ATTEMPTS} numbers per session.`,
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
              numberAttempt: state.numberAttempts,
              note: "already purchased — call cancel_phone_number first if you need a different number",
            };
          }
          if (state.numberAttempts >= PHONE_MAX_NUMBER_ATTEMPTS) {
            return {
              success: false,
              error: `maximum phone number attempts (${PHONE_MAX_NUMBER_ATTEMPTS}) reached for this signup`,
              numberAttempts: state.numberAttempts,
            };
          }

          const client = opts.client ?? createFiveSimClient();
          const country = fiveSimCountryForGeo(geo);
          const order = await client.buyActivation(country, operator, product);
          state.orderId = order.id;
          state.phone = order.phone;
          state.orderPurchasedAt = Date.now();
          state.numberAttempts += 1;
          state.verificationCode = null;

          await audit(
            "get_phone_number",
            {
              phone: order.phone,
              orderId: order.id,
              country,
              operator,
              product,
              numberAttempt: state.numberAttempts,
            },
            true,
          );
          return {
            success: true,
            phone: order.phone,
            digitsOnly: phoneDigitsOnly(order.phone),
            orderId: order.id,
            country,
            operator,
            numberAttempt: state.numberAttempts,
            attemptsRemaining: PHONE_MAX_NUMBER_ATTEMPTS - state.numberAttempts,
            cancelAllowedAfterSeconds: Math.ceil(PHONE_CANCEL_MIN_WAIT_MS / 1000),
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
        "Polls 5sim until the SMS arrives (default 120s). " +
        "Call after submitting the phone number and the SMS code field is visible. " +
        "If no code arrives, wait until cancelAllowed (2 min after purchase), then call cancel_phone_number.",
      inputSchema: z.object({
        timeoutSeconds: z
          .number()
          .min(10)
          .max(300)
          .optional()
          .describe(`How long to wait for the SMS (default ${PHONE_READ_TIMEOUT_SECONDS}s)`),
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
          const waitMs = (timeoutSeconds ?? PHONE_READ_TIMEOUT_SECONDS) * 1000;
          const result = await client.waitForVerificationCode(state.orderId, { timeoutMs: waitMs });
          if (!result) {
            const cancelWait = cancelWaitSeconds(state.orderPurchasedAt);
            const canCancel = cancelWait === 0;
            const attemptsRemaining = PHONE_MAX_NUMBER_ATTEMPTS - state.numberAttempts;
            await audit(
              "read_phone_verification_code",
              {
                error: "timeout",
                orderId: state.orderId,
                cancelWaitSeconds: cancelWait,
                canCancel,
              },
              false,
            );
            return {
              success: false,
              error: "no SMS arrived before the timeout — the number may be bad or the code is delayed",
              orderId: state.orderId,
              phone: state.phone,
              cancelWaitSeconds: cancelWait,
              canCancelNow: canCancel,
              numberAttempt: state.numberAttempts,
              attemptsRemaining,
              nextSteps: canCancel
                ? [
                    "1. Call cancel_phone_number to release this 5sim order.",
                    "2. On LinkedIn, navigate back to the empty phone number field.",
                    "3. Call get_phone_number for a new number (if attemptsRemaining > 0).",
                  ].join(" ")
                : `Wait ${cancelWait}s more (2 minutes minimum after purchase), then call cancel_phone_number.`,
              linkedInUi: LINKEDIN_PHONE_RETRY_UI,
            };
          }
          state.verificationCode = result.code;
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

    cancel_phone_number: tool({
      description:
        "Cancel the current 5sim phone order when no SMS verification code arrived. " +
        "ONLY call at least 2 minutes after get_phone_number for this number. " +
        "After cancel succeeds, fix the LinkedIn UI (Back / add another number) then call get_phone_number again. " +
        `Up to ${PHONE_MAX_NUMBER_ATTEMPTS} numbers total per signup.`,
      inputSchema: z.object({}),
      execute: async () => {
        if (!process.env.FIVE_SIM_API_KEY) {
          return { success: false, error: "FIVE_SIM_API_KEY not set" };
        }
        try {
          if (!state.orderId) {
            return {
              success: false,
              error: "no active phone order — call get_phone_number first",
            };
          }
          const cancelWait = cancelWaitSeconds(state.orderPurchasedAt);
          if (cancelWait > 0) {
            return {
              success: false,
              error: `must wait ${cancelWait}s before canceling (2 minute minimum after purchasing the number)`,
              cancelWaitSeconds: cancelWait,
              orderId: state.orderId,
              phone: state.phone,
            };
          }
          const client = opts.client ?? createFiveSimClient();
          const canceledOrderId = state.orderId;
          const canceledPhone = state.phone;
          await client.cancelOrder(canceledOrderId);
          clearActiveOrder(state);

          const attemptsRemaining = PHONE_MAX_NUMBER_ATTEMPTS - state.numberAttempts;
          await audit(
            "cancel_phone_number",
            { orderId: canceledOrderId, phone: canceledPhone, attemptsRemaining },
            true,
          );
          return {
            success: true,
            canceledOrderId,
            canceledPhone,
            numberAttemptsUsed: state.numberAttempts,
            attemptsRemaining,
            linkedInUi: LINKEDIN_PHONE_RETRY_UI,
            nextSteps:
              attemptsRemaining > 0
                ? [
                    "1. On LinkedIn: click Back, Edit phone number, Use a different number, or Add another phone number.",
                    "2. Confirm the phone input is empty and ready for a new number.",
                    "3. Call get_phone_number to buy a new number.",
                    "4. Enter the new number, submit, then call read_phone_verification_code.",
                  ].join(" ")
                : "No number attempts remaining — phone verification cannot be retried automatically.",
          };
        } catch (err) {
          await audit("cancel_phone_number", { error: String(err) }, false);
          return { success: false, error: String(err) };
        }
      },
    }),
  };

  return { tools, state };
}

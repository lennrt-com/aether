// Thin wrapper over the 5sim REST API (5sim.net, Bearer JWT auth).
// Docs: https://5sim.net/docs — buy virtual numbers, poll for SMS codes.

const DEFAULT_BASE_URL = "https://5sim.net";

/** ISO-ish geo codes (profile geo) → 5sim country slug. */
const GEO_TO_FIVE_SIM_COUNTRY: Record<string, string> = {
  US: "usa",
  GB: "england",
  UK: "england",
  IE: "ireland",
  CA: "canada",
  AU: "australia",
  DE: "germany",
  AT: "austria",
  CH: "switzerland",
  FR: "france",
  ES: "spain",
  IT: "italy",
  NL: "netherlands",
  BE: "belgium",
  SE: "sweden",
  DK: "denmark",
  NO: "norway",
  PL: "poland",
  PT: "portugal",
  BR: "brazil",
  IN: "india",
  MX: "mexico",
  RU: "russia",
};

export class FiveSimApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "FiveSimApiError";
  }
}

export interface FiveSimSms {
  created_at?: string;
  text?: string;
  code?: string;
}

export interface FiveSimOrder {
  id: number;
  phone: string;
  operator?: string;
  product?: string;
  price?: number;
  status?: string;
  expires?: string;
  sms?: FiveSimSms[] | null;
  created_at?: string;
}

export interface FiveSimClient {
  /** GET /v1/user/buy/activation/{country}/{operator}/{product} */
  buyActivation(country: string, operator: string, product: string): Promise<FiveSimOrder>;
  /** GET /v1/user/check/{id} */
  checkOrder(orderId: number): Promise<FiveSimOrder>;
  /** GET /v1/user/finish/{id} — mark order complete after SMS received. */
  finishOrder(orderId: number): Promise<FiveSimOrder>;
  /** GET /v1/user/cancel/{id} */
  cancelOrder(orderId: number): Promise<FiveSimOrder>;
  /**
   * Poll until an SMS verification code arrives. Returns null on timeout.
   */
  waitForVerificationCode(
    orderId: number,
    opts?: { timeoutMs?: number; pollMs?: number },
  ): Promise<{ code: string; text: string } | null>;
}

const CODE_RE = /\b(\d{4,8})\b/;

export function fiveSimCountryForGeo(geo: string): string {
  const fromEnv = process.env.FIVE_SIM_COUNTRY?.trim();
  if (fromEnv) return fromEnv.toLowerCase();
  return GEO_TO_FIVE_SIM_COUNTRY[geo.toUpperCase()] ?? "england";
}

export function extractSmsVerificationCode(order: FiveSimOrder): string | null {
  const messages = order.sms ?? [];
  for (const msg of messages) {
    if (msg.code?.trim()) return msg.code.trim();
    const match = msg.text?.match(CODE_RE);
    if (match) return match[1];
  }
  return null;
}

/** Strip non-digits; useful when a form wants digits without '+'. */
export function phoneDigitsOnly(phone: string): string {
  return phone.replace(/\D/g, "");
}

export function createFiveSimClient(
  apiKey = process.env.FIVE_SIM_API_KEY,
  baseUrl = process.env.FIVE_SIM_BASE_URL ?? DEFAULT_BASE_URL,
): FiveSimClient {
  if (!apiKey) throw new Error("FIVE_SIM_API_KEY not set");

  async function request<T>(method: string, path: string): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      throw new FiveSimApiError(res.status, `${method} ${path} -> HTTP ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }

  return {
    buyActivation: (country, operator, product) =>
      request("GET", `/v1/user/buy/activation/${country}/${operator}/${product}`),
    checkOrder: (orderId) => request("GET", `/v1/user/check/${orderId}`),
    finishOrder: (orderId) => request("GET", `/v1/user/finish/${orderId}`),
    cancelOrder: (orderId) => request("GET", `/v1/user/cancel/${orderId}`),
    waitForVerificationCode: async (orderId, opts) => {
      const timeoutMs = opts?.timeoutMs ?? 120_000;
      const pollMs = opts?.pollMs ?? 3_000;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const order = await request<FiveSimOrder>("GET", `/v1/user/check/${orderId}`);
        const code = extractSmsVerificationCode(order);
        if (code) {
          const text = order.sms?.[0]?.text ?? "";
          return { code, text };
        }
        if (order.status === "TIMEOUT" || order.status === "CANCELED") return null;
        if (Date.now() + pollMs > deadline) return null;
        await new Promise((r) => setTimeout(r, pollMs));
      }
    },
  };
}

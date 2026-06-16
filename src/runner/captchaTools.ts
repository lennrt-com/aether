// Stagehand agent tools for captcha handling: CapSolver-backed reCAPTCHA
// (checkbox, image grid, AND invisible/Enterprise) plus viewport helpers for
// LinkedIn's FunCaptcha (Arkose Labs). The solved token is applied in EVERY
// frame (including the LinkedIn checkpoint/challenge iframe) via the main-world
// bridge (recaptchaBridge.ts): textarea write + grecaptcha.getResponse()/
// execute() patch + widget callback invocation, none of which require enabling
// the CDP Runtime domain.
import { tool, type AgentConfig } from "@browserbasehq/stagehand";
import type { Page } from "@browserbasehq/stagehand";
import { z } from "zod";
import {
  createCapSolverClient,
  capSolverUsesBrowserProxy,
  type CapSolverClient,
  type CapSolverProxy,
  type CapSolverRecaptchaSolution,
} from "../channels/capSolver.js";
import { evalInAllFrames, evalInPage, setCookieViaCdp } from "./cdpEval.js";
import { buildApplyTokenExpression, type FrameApplyResult } from "./recaptchaBridge.js";

export type StagehandToolSet = NonNullable<AgentConfig["tools"]>;

export type CaptchaToolAudit = (
  toolName: string,
  data: Record<string, unknown>,
  ok: boolean,
) => Promise<void>;

type PanDirection = "left" | "right" | "up" | "down";

interface CaptchaViewPayload {
  found: boolean;
  message: string;
  tagName?: string;
  iframeSrc?: string;
  rect?: { x: number; y: number; width: number; height: number };
  viewport?: { width: number; height: number };
  scrollableContainer?: boolean;
}

interface PanPayload {
  found: boolean;
  message: string;
  direction?: PanDirection;
  scrollLeft?: number;
  scrollTop?: number;
}

interface RecaptchaExtractPayload {
  found: boolean;
  websiteKey?: string;
  frameUrl?: string;
  isInvisible?: boolean;
  isEnterprise?: boolean;
  challengeOpen?: boolean;
  checkboxVisible?: boolean;
  /** This frame is LinkedIn's checkpoint challenge page. */
  onLinkedInCheckpoint?: boolean;
  /** Parent frame embeds LinkedIn checkpoint/challengeIframe. */
  linkedInChallengeIframeUrl?: string;
  hasResponseTextarea?: boolean;
  enterpriseS?: string;
  pageAction?: string;
  apiDomain?: string;
  message?: string;
}

interface RecaptchaState extends RecaptchaExtractPayload {
  websiteURL: string;
  linkedInChallengeOpen: boolean;
  frameCount: number;
}

interface RecaptchaInjectPayload {
  injected: boolean;
  callbacksInvoked: number;
  getResponsePatched: boolean;
  executePatched: boolean;
  framesInjected: number;
  message: string;
}

/** Runs in the page — locates the captcha host and centers it in scrollable ancestors. */
function prepareCaptchaViewScript(): CaptchaViewPayload {
  const selectors = [
    'iframe[src*="arkoselabs"]',
    'iframe[src*="funcaptcha"]',
    'iframe[title*="captcha" i]',
    'iframe[id*="captcha" i]',
    "#captcha-internal",
    '[data-test-id*="captcha" i]',
    '[class*="captcha" i]',
    '[id*="Captcha"]',
  ];

  function findCaptchaElement(): Element | null {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.getBoundingClientRect().width > 0) return el;
    }
    for (const iframe of document.querySelectorAll("iframe")) {
      const src = iframe.src || iframe.getAttribute("src") || "";
      const title = iframe.title || "";
      if (/arkoselabs|funcaptcha|captcha/i.test(src) || /captcha/i.test(title)) {
        if (iframe.getBoundingClientRect().width > 0) return iframe;
      }
    }
    return null;
  }

  function centerInScrollableAncestors(el: Element): boolean {
    let sawScrollable = false;
    let node = el.parentElement;
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node);
      const overflowX = style.overflowX;
      const overflowY = style.overflowY;
      const scrollableX =
        (overflowX === "auto" || overflowX === "scroll") && node.scrollWidth > node.clientWidth + 2;
      const scrollableY =
        (overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight + 2;
      if (scrollableX || scrollableY) {
        sawScrollable = true;
        const rect = el.getBoundingClientRect();
        const parentRect = node.getBoundingClientRect();
        if (scrollableX) {
          const elCenterX = rect.left + rect.width / 2 - parentRect.left + node.scrollLeft;
          node.scrollLeft = Math.max(0, Math.min(node.scrollWidth, elCenterX - node.clientWidth / 2));
        }
        if (scrollableY) {
          const elCenterY = rect.top + rect.height / 2 - parentRect.top + node.scrollTop;
          node.scrollTop = Math.max(0, Math.min(node.scrollHeight, elCenterY - node.clientHeight / 2));
        }
      }
      node = node.parentElement;
    }
    return sawScrollable;
  }

  const el = findCaptchaElement();
  if (!el) {
    return { found: false, message: "No captcha iframe or container found yet — wait for it to appear." };
  }

  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const scrollableContainer = centerInScrollableAncestors(el);

  const rect = el.getBoundingClientRect();
  const clipped =
    rect.left < 0 ||
    rect.top < 0 ||
    rect.right > window.innerWidth ||
    rect.bottom > window.innerHeight ||
    rect.width < 120 ||
    rect.height < 120;

  return {
    found: true,
    tagName: el.tagName,
    iframeSrc: el instanceof HTMLIFrameElement ? el.src : undefined,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scrollableContainer,
    message: clipped
      ? "Captcha is still partially clipped — call pan_captcha_view to scroll inside its container, then solve visually."
      : "Captcha centered in view — solve it with clicks and drags. Re-call if the puzzle refreshes.",
  };
}

function panCaptchaViewScript(opts: { direction: PanDirection; amount: number }): PanPayload {
  const { direction, amount } = opts;
  const selectors = [
    'iframe[src*="arkoselabs"]',
    'iframe[src*="funcaptcha"]',
    'iframe[title*="captcha" i]',
    'iframe[id*="captcha" i]',
    "#captcha-internal",
    '[data-test-id*="captcha" i]',
    '[class*="captcha" i]',
    '[id*="Captcha"]',
  ];

  function findCaptchaElement(): Element | null {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.getBoundingClientRect().width > 0) return el;
    }
    for (const iframe of document.querySelectorAll("iframe")) {
      const src = iframe.src || iframe.getAttribute("src") || "";
      if (/arkoselabs|funcaptcha|captcha/i.test(src)) return iframe;
    }
    return null;
  }

  function findScrollTarget(el: Element): HTMLElement | null {
    let best: HTMLElement | null = null;
    let bestArea = Infinity;
    let node: Element | null = el;
    while (node && node !== document.documentElement) {
      if (node instanceof HTMLElement) {
        const style = getComputedStyle(node);
        const overflowX = style.overflowX;
        const overflowY = style.overflowY;
        const scrollableX =
          (overflowX === "auto" || overflowX === "scroll") && node.scrollWidth > node.clientWidth + 2;
        const scrollableY =
          (overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight + 2;
        if (scrollableX || scrollableY) {
          const area = node.clientWidth * node.clientHeight;
          if (area < bestArea) {
            best = node;
            bestArea = area;
          }
        }
      }
      node = node.parentElement;
    }
    return best;
  }

  const el = findCaptchaElement();
  if (!el) {
    return { found: false, message: "No captcha element found — call prepare_captcha_view first." };
  }

  const target = findScrollTarget(el) ?? document.documentElement;
  const delta =
    direction === "left"
      ? { x: -amount, y: 0 }
      : direction === "right"
        ? { x: amount, y: 0 }
        : direction === "up"
          ? { x: 0, y: -amount }
          : { x: 0, y: amount };

  if (target === document.documentElement) {
    window.scrollBy({ left: delta.x, top: delta.y, behavior: "instant" });
  } else {
    target.scrollBy({ left: delta.x, top: delta.y, behavior: "instant" });
  }

  return {
    found: true,
    direction,
    scrollLeft: target === document.documentElement ? window.scrollX : target.scrollLeft,
    scrollTop: target === document.documentElement ? window.scrollY : target.scrollTop,
    message: `Panned captcha view ${direction} by ${amount}px.`,
  };
}

/** Runs in each frame — locates reCAPTCHA sitekey, phase, and LinkedIn checkpoint context. */
function extractRecaptchaScript(): RecaptchaExtractPayload {
  function findSitekeyInObject(obj: unknown, depth = 0): string | null {
    if (depth > 6 || obj == null) return null;
    if (typeof obj === "string" && /^6L[a-zA-Z0-9_-]{38}$/.test(obj)) return obj;
    if (typeof obj !== "object") return null;
    for (const value of Object.values(obj as Record<string, unknown>)) {
      const found = findSitekeyInObject(value, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const frameUrl = location.href;
  const onLinkedInCheckpoint = /checkpoint\/challenge/i.test(frameUrl);

  let linkedInChallengeIframeUrl: string | undefined;
  if (!onLinkedInCheckpoint) {
    for (const iframe of document.querySelectorAll("iframe")) {
      const src = iframe.src || iframe.getAttribute("src") || "";
      if (/checkpoint\/challenge/i.test(src)) {
        linkedInChallengeIframeUrl = src;
        break;
      }
    }
  }

  const isEnterprise =
    document.querySelector('script[src*="recaptcha/enterprise"]') != null ||
    typeof (window as unknown as { grecaptcha?: { enterprise?: unknown } }).grecaptcha?.enterprise !==
      "undefined";

  function isVisible(el: Element | null): boolean {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0;
  }

  let challengeOpen = false;
  for (const iframe of document.querySelectorAll('iframe[src*="recaptcha"]')) {
    const src = iframe.src || iframe.getAttribute("src") || "";
    if (!/bframe/i.test(src)) continue;
    const rect = iframe.getBoundingClientRect();
    if (isVisible(iframe) && rect.height > 130) challengeOpen = true;
  }

  let checkboxVisible = false;
  for (const iframe of document.querySelectorAll('iframe[src*="recaptcha"]')) {
    const src = iframe.src || iframe.getAttribute("src") || "";
    if (!/anchor/i.test(src)) continue;
    let invisible = false;
    try {
      invisible = new URL(src, window.location.href).searchParams.get("size") === "invisible";
    } catch {
      // ignore
    }
    if (!invisible && isVisible(iframe) && iframe.getBoundingClientRect().height > 40) {
      checkboxVisible = true;
    }
  }

  const hasResponseTextarea =
    document.querySelector(
      'textarea[name="g-recaptcha-response"], #g-recaptcha-response, textarea[name^="g-recaptcha-response"], textarea[id^="g-recaptcha-response"]',
    ) != null;

  const base = {
    frameUrl,
    onLinkedInCheckpoint,
    linkedInChallengeIframeUrl,
    isEnterprise,
    challengeOpen,
    checkboxVisible,
    hasResponseTextarea,
  };

  const sitekeyEl = document.querySelector("[data-sitekey]");
  if (sitekeyEl) {
    const key = sitekeyEl.getAttribute("data-sitekey");
    if (key) {
      return {
        found: true,
        websiteKey: key,
        isInvisible: sitekeyEl.getAttribute("data-size") === "invisible",
        ...base,
      };
    }
  }

  for (const iframe of document.querySelectorAll("iframe")) {
    const src = iframe.src || iframe.getAttribute("src") || "";
    if (!/recaptcha/i.test(src)) continue;
    try {
      const url = new URL(src, window.location.href);
      const key = url.searchParams.get("k");
      if (key) {
        const s = url.searchParams.get("s") ?? undefined;
        const pageAction = url.searchParams.get("sa") ?? undefined;
        return {
          found: true,
          websiteKey: key,
          isInvisible: url.searchParams.get("size") === "invisible",
          enterpriseS: s,
          pageAction,
          apiDomain: url.origin,
          ...base,
        };
      }
    } catch {
      // ignore
    }
  }

  const cfg = (window as unknown as { ___grecaptcha_cfg?: { clients?: Record<string, unknown> } })
    .___grecaptcha_cfg;
  if (cfg?.clients) {
    for (const client of Object.values(cfg.clients)) {
      const sitekey = findSitekeyInObject(client);
      if (sitekey) {
        return {
          found: true,
          websiteKey: sitekey,
          isInvisible: onLinkedInCheckpoint ? false : challengeOpen ? false : true,
          ...base,
        };
      }
    }
  }

  if (linkedInChallengeIframeUrl || onLinkedInCheckpoint) {
    return {
      found: false,
      message: "LinkedIn security challenge frame detected but reCAPTCHA not loaded yet.",
      ...base,
    };
  }

  return { found: false, message: "No reCAPTCHA v2 sitekey found on the page yet.", ...base };
}

/** Top-frame only — pull Enterprise `s` payload for CapSolver when present. */
function extractEnterpriseSScript(): { s: string | null } {
  function findS(obj: unknown, depth = 0): string | null {
    if (depth > 10 || obj == null) return null;
    if (typeof obj === "object") {
      for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
        if (key === "s" && typeof val === "string" && val.length > 20) return val;
        const nested = findS(val, depth + 1);
        if (nested) return nested;
      }
    }
    return null;
  }
  const cfg = (window as unknown as { ___grecaptcha_cfg?: unknown }).___grecaptcha_cfg;
  return { s: cfg ? findS(cfg) : null };
}

function scoreRecaptchaFrame(hit: RecaptchaExtractPayload): number {
  if (!hit.found || !hit.websiteKey) return -1;
  let score = 0;
  if (hit.onLinkedInCheckpoint) score += 100;
  if (hit.hasResponseTextarea) score += 40;
  if (hit.challengeOpen) score += 30;
  if (hit.checkboxVisible) score += 20;
  if (hit.linkedInChallengeIframeUrl) score += 10;
  if (hit.isInvisible) score -= 5;
  return score;
}

async function collectRecaptchaState(page: Page, fallbackUrl: string): Promise<RecaptchaState> {
  const frameHits = await evalInAllFrames<RecaptchaExtractPayload>(page, extractRecaptchaScript);
  const enterprise = await evalInPage<{ s: string | null }>(page, extractEnterpriseSScript).catch(
    () => ({ s: null }),
  );

  let best: RecaptchaExtractPayload | null = null;
  let bestScore = -1;
  let linkedInChallengeIframeUrl: string | undefined;
  let linkedInChallengeOpen = false;

  for (const hit of frameHits) {
    const r = hit.result;
    if (r.linkedInChallengeIframeUrl) {
      linkedInChallengeOpen = true;
      linkedInChallengeIframeUrl = r.linkedInChallengeIframeUrl;
    }
    if (r.onLinkedInCheckpoint) {
      linkedInChallengeOpen = true;
      linkedInChallengeIframeUrl = r.frameUrl ?? linkedInChallengeIframeUrl;
    }
    const score = scoreRecaptchaFrame(r);
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }

  if (!best?.found || !best.websiteKey) {
    return {
      found: false,
      message: best?.message ?? "No reCAPTCHA v2 sitekey found on the page yet.",
      websiteURL: fallbackUrl,
      linkedInChallengeOpen,
      enterpriseS: enterprise.s ?? undefined,
      frameCount: frameHits.length,
      linkedInChallengeIframeUrl,
    };
  }

  const websiteURL =
    linkedInChallengeIframeUrl ??
    (best.onLinkedInCheckpoint ? best.frameUrl : undefined) ??
    fallbackUrl;

  return {
    ...best,
    websiteURL,
    linkedInChallengeOpen,
    enterpriseS: best.enterpriseS ?? enterprise.s ?? undefined,
    frameCount: frameHits.length,
  };
}

async function applyCapSolverRecaptchaCookies(
  page: Page,
  solution: CapSolverRecaptchaSolution,
): Promise<{ applied: string[]; failed: string[] }> {
  const cookieValues = [
    ["recaptcha-ca-e", solution["recaptcha-ca-e"]],
    ["recaptcha-ca-t", solution["recaptcha-ca-t"]],
  ] as const;
  const urls = ["https://www.google.com/", "https://www.recaptcha.net/"];
  const applied: string[] = [];
  const failed: string[] = [];

  for (const [name, value] of cookieValues) {
    if (!value) continue;
    for (const url of urls) {
      try {
        const ok = await setCookieViaCdp(page, {
          name,
          value,
          url,
          secure: true,
          httpOnly: false,
          sameSite: "None",
        });
        (ok ? applied : failed).push(`${name}@${new URL(url).hostname}`);
      } catch {
        failed.push(`${name}@${new URL(url).hostname}`);
      }
    }
  }

  return { applied, failed };
}

export function buildCaptchaTools(opts: {
  getPage: () => Page | null | undefined;
  getProxy?: () => CapSolverProxy | null;
  capSolverClient?: CapSolverClient;
  audit?: CaptchaToolAudit;
}): StagehandToolSet {
  const audit = opts.audit ?? (async () => {});
  let capSolver: CapSolverClient | null = opts.capSolverClient ?? null;

  return {
    prepare_captcha_view: tool({
      description:
        "FunCaptcha / Arkose Labs puzzles ONLY (rotate-the-image, pick-matching-object tiles). " +
        "Scrolls the Arkose challenge into the center of the viewport. " +
        "Do NOT use this for Google reCAPTCHA (checkbox / image grid / invisible) — use solve_recaptcha for that. " +
        "Call again if the Arkose puzzle is clipped or hard to see.",
      inputSchema: z.object({}),
      execute: async () => {
        const page = opts.getPage();
        if (!page) {
          await audit("prepare_captcha_view", { error: "no active page" }, false);
          return { success: false, error: "no active browser page" };
        }
        try {
          await page.waitForTimeout(500);
          const result = await evalInPage<CaptchaViewPayload>(page, prepareCaptchaViewScript);
          await audit("prepare_captcha_view", result, result.found);
          return { success: result.found, ...result };
        } catch (err) {
          await audit("prepare_captcha_view", { error: String(err) }, false);
          return { success: false, error: String(err) };
        }
      },
    }),

    pan_captcha_view: tool({
      description:
        "FunCaptcha / Arkose Labs puzzles ONLY. Pan/scroll inside the small Arkose container " +
        "when puzzle pieces are cut off. Use after prepare_captcha_view if part of the Arkose " +
        "challenge is still hidden. Do NOT use this for Google reCAPTCHA — use solve_recaptcha.",
      inputSchema: z.object({
        direction: z
          .enum(["left", "right", "up", "down"])
          .describe("Which way to scroll inside the captcha container"),
        amount: z
          .number()
          .min(40)
          .max(400)
          .optional()
          .describe("Pixels to scroll (default 120)"),
      }),
      execute: async ({ direction, amount }) => {
        const page = opts.getPage();
        if (!page) {
          await audit("pan_captcha_view", { error: "no active page" }, false);
          return { success: false, error: "no active browser page" };
        }
        try {
          const pixels = amount ?? 120;
          const result = await evalInPage<PanPayload>(page, panCaptchaViewScript, {
            direction,
            amount: pixels,
          });
          await audit("pan_captcha_view", result, result.found);
          return { success: result.found, ...result };
        } catch (err) {
          await audit("pan_captcha_view", { error: String(err) }, false);
          return { success: false, error: String(err) };
        }
      },
    }),

    solve_recaptcha: tool({
      description:
        "Solve ANY Google reCAPTCHA via CapSolver — checkbox, image grid, or invisible Enterprise. " +
        "ONLY tool for reCAPTCHA. After success: if a LinkedIn security modal is open, click Verify/Weiter " +
        "INSIDE the modal once; otherwise click Submit/Continue on the signup form once. Wait 3–5s before " +
        "calling again (max 3 times). Do NOT call repeatedly without clicking submit/verify between calls.",
      inputSchema: z.object({}),
      execute: async () => {
        const page = opts.getPage();
        if (!page) {
          await audit("solve_recaptcha", { error: "no active page" }, false);
          return { success: false, error: "no active browser page" };
        }

        if (!process.env.CAPSOLVER_API_KEY) {
          await audit("solve_recaptcha", { error: "CAPSOLVER_API_KEY not set" }, false);
          return { success: false, error: "CAPSOLVER_API_KEY not set — cannot solve reCAPTCHA" };
        }

        try {
          const topUrl = page.url();
          const extracted = await collectRecaptchaState(page, topUrl);
          if (!extracted.found || !extracted.websiteKey) {
            await audit("solve_recaptcha", extracted, false);
            return {
              success: false,
              error: extracted.message ?? "no reCAPTCHA detected yet — wait for it to appear",
            };
          }

          if (!capSolver) capSolver = createCapSolverClient();
          const sessionProxy = opts.getProxy?.() ?? null;

          const preSolve = await collectRecaptchaState(page, topUrl);
          const visibleChallenge =
            preSolve.challengeOpen === true ||
            preSolve.checkboxVisible === true ||
            preSolve.linkedInChallengeOpen === true;
          const effectiveInvisible =
            preSolve.isInvisible === true && !visibleChallenge;

          const solution = await capSolver.solveRecaptchaV2({
            websiteURL: preSolve.websiteURL,
            websiteKey: preSolve.websiteKey,
            isInvisible: effectiveInvisible,
            isEnterprise: preSolve.isEnterprise,
            pageAction: preSolve.pageAction,
            recaptchaDataSValue:
              !preSolve.isEnterprise && preSolve.enterpriseS ? preSolve.enterpriseS : undefined,
            enterprisePayload:
              preSolve.isEnterprise && preSolve.enterpriseS ? { s: preSolve.enterpriseS } : undefined,
            apiDomain: preSolve.apiDomain,
            proxy: sessionProxy,
          });
          const token = solution.gRecaptchaResponse;
          const captchaCookies = await applyCapSolverRecaptchaCookies(page, solution);

          const postSolve = await collectRecaptchaState(page, topUrl);

          // Apply the token in EVERY frame's main world via the bridge: textarea
          // write + grecaptcha.getResponse()/execute() patch + widget callback
          // invocation. The isolated-world dispatcher also writes the textarea
          // directly as a fallback if the bridge is not present in that frame.
          const frameApplies = await evalInAllFrames<FrameApplyResult>(
            page,
            buildApplyTokenExpression(token),
          );

          let framesInjected = 0;
          let textareaTotal = 0;
          let callbacksInvoked = 0;
          let getResponsePatched = false;
          let executePatched = false;
          let bridgePresent = false;
          for (const hit of frameApplies) {
            const r = hit.result;
            if (!r) continue;
            const b = r.bridge;
            const did =
              (r.ta ?? 0) > 0 || (b ? b.ta > 0 || b.gr || b.ex || b.cb > 0 : false);
            if (did) framesInjected += 1;
            textareaTotal += Math.max(r.ta ?? 0, b?.ta ?? 0);
            if (b) {
              bridgePresent = true;
              callbacksInvoked += b.cb;
              if (b.gr) getResponsePatched = true;
              if (b.ex) executePatched = true;
            }
          }

          const injected = framesInjected > 0;
          const paths = [
            framesInjected > 0 ? `response fields (${framesInjected} frame(s))` : null,
            callbacksInvoked > 0 ? `${callbacksInvoked} callback(s) fired` : null,
            getResponsePatched ? "getResponse() patched" : null,
            executePatched ? "execute() patched" : null,
          ].filter(Boolean);

          let message = injected
            ? `Token applied (${paths.join(", ")}) — `
            : "Could not apply token to any frame.";

          if (postSolve.linkedInChallengeOpen || postSolve.challengeOpen) {
            message +=
              "click Verify/Weiter INSIDE the LinkedIn security modal once (do NOT call solve_recaptcha again first).";
          } else {
            message += "click Submit/Continue on the signup form once, then wait.";
          }

          const result: RecaptchaInjectPayload = {
            injected,
            callbacksInvoked,
            getResponsePatched,
            executePatched,
            framesInjected,
            message,
          };

          await audit(
            "solve_recaptcha",
            {
              websiteURL: preSolve.websiteURL,
              websiteKey: preSolve.websiteKey,
              isInvisible: preSolve.isInvisible,
              effectiveInvisible,
              isEnterprise: preSolve.isEnterprise,
              linkedInChallengeOpen: postSolve.linkedInChallengeOpen,
              challengeOpen: postSolve.challengeOpen,
              checkboxVisible: postSolve.checkboxVisible,
              bridgePresent,
              framesScanned: postSolve.frameCount,
              framesInjected,
              textareaTotal,
              enterpriseS: preSolve.enterpriseS ? "present" : "absent",
              pageAction: preSolve.pageAction ?? null,
              apiDomain: preSolve.apiDomain ?? null,
              capSolverCookieFields: {
                caE: solution["recaptcha-ca-e"] ? "present" : "absent",
                caT: solution["recaptcha-ca-t"] ? "present" : "absent",
              },
              capSolverCookiesApplied: captchaCookies.applied,
              capSolverCookiesFailed: captchaCookies.failed,
              capSolverMode: capSolverUsesBrowserProxy() ? "browser-proxy" : "proxyless",
              sessionProxyAvailable: sessionProxy != null,
              callbacksInvoked,
              getResponsePatched,
              executePatched,
              tokenApplied: injected,
            },
            injected,
          );

          if (!injected) {
            return {
              success: false,
              error:
                "CapSolver returned a token but it could not be written into any frame. " +
                "Wait for the security modal to finish loading and retry once.",
            };
          }
          return { success: true, ...result };
        } catch (err) {
          await audit("solve_recaptcha", { error: String(err) }, false);
          return { success: false, error: String(err) };
        }
      },
    }),
  };
}

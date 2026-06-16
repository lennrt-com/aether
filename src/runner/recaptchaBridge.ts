// Main-world reCAPTCHA token bridge.
//
// Why this exists: our stealth layer strips CDP `Runtime.enable`
// (session.ts/suppressRuntimeEnable), so the only page eval we can do is either
//   1. an isolated world (Page.createIsolatedWorld) — shares the DOM but NOT
//      `window.grecaptcha` / `___grecaptcha_cfg`, or
//   2. a context-less Runtime.evaluate — main world of the TOP frame only.
// A solved reCAPTCHA token, however, only takes effect when the site reads it
// via `grecaptcha.getResponse()` or its widget success `callback` fires — both
// of which live in the MAIN world of whatever frame hosts the widget. On a
// LinkedIn checkpoint that frame is the `checkpoint/challenge` iframe, which
// neither eval path can reach. Writing the textarea alone (all we could do
// before) is ignored, so the token never "lands".
//
// Fix: at launch we pre-inject a tiny main-world script via CDP
// `Page.addScriptToEvaluateOnNewDocument` (a Page-domain call, NOT blocked by
// the Runtime.enable suppression). It runs in the main world of EVERY frame
// (including cross-origin / checkpoint iframes) and bypasses CSP, without ever
// enabling the Runtime domain. The bridge listens for a DOM event; the solver
// fires that event into each frame's isolated world (DOM events dispatched on
// the shared `window`/`document` are delivered to main-world listeners), and
// the bridge applies the token properly inside that frame.
import type { Page } from "@browserbasehq/stagehand";

// Kept deliberately terse / generic-looking to minimize footprint. The same
// literals are baked into BOTH the bridge source and the dispatcher expression
// (evalInAllFrames stringifies functions, so module constants would not survive
// — we interpolate them into the source strings instead).
const EVENT = "blessrc:apply";
const TOKEN_ATTR = "data-bxrt";
const RESULT_ATTR = "data-bxrr";
const GUARD = "__bxRcBridge";
const STORE = "__bxRcToken";

export interface BridgeApplyResult {
  /** g-recaptcha-response textareas written (main world). */
  ta: number;
  /** grecaptcha.getResponse patched to return the token. */
  gr: boolean;
  /** grecaptcha.execute patched to resolve the token. */
  ex: boolean;
  /** widget callbacks invoked from ___grecaptcha_cfg.clients. */
  cb: number;
  error?: string;
}

export interface FrameApplyResult {
  /** Textareas written directly from the isolated world (DOM is shared). */
  ta: number;
  /** Result reported by the main-world bridge, or null if not installed here. */
  bridge: BridgeApplyResult | null;
}

/**
 * Source of the main-world bridge. Self-contained ES5-ish IIFE so it runs in
 * any frame. Skips Google/reCAPTCHA frames — the token only ever needs to land
 * in the site's own frame (textarea + grecaptcha client live there).
 */
function buildBridgeSource(): string {
  return `(function(){
  try {
    var h = (location && location.hostname) || "";
    if (/(^|\\.)(google|gstatic)\\./i.test(h) || h.indexOf("recaptcha") !== -1) return;
  } catch (e) {}
  if (window["${GUARD}"]) return;
  window["${GUARD}"] = true;
  document.addEventListener("${EVENT}", function () {
    var docEl = document.documentElement;
    try {
      var token = docEl.getAttribute("${TOKEN_ATTR}") || "";
      var res = { ta: 0, gr: false, ex: false, cb: 0 };
      if (!token) { docEl.setAttribute("${RESULT_ATTR}", JSON.stringify(res)); return; }
      var w = window;
      if (!w["${STORE}"]) w["${STORE}"] = {};
      w["${STORE}"].t = token;

      try {
        var tas = document.querySelectorAll('textarea[name^="g-recaptcha-response"],textarea[id^="g-recaptcha-response"],#g-recaptcha-response');
        for (var i = 0; i < tas.length; i++) {
          try {
            tas[i].value = token;
            tas[i].dispatchEvent(new Event("input", { bubbles: true }));
            tas[i].dispatchEvent(new Event("change", { bubbles: true }));
            res.ta++;
          } catch (e) {}
        }
      } catch (e) {}

      var targets = [];
      try { if (w.grecaptcha) targets.push(w.grecaptcha); } catch (e) {}
      try { if (w.grecaptcha && w.grecaptcha.enterprise) targets.push(w.grecaptcha.enterprise); } catch (e) {}
      for (var j = 0; j < targets.length; j++) {
        var t = targets[j];
        try {
          if (typeof t.getResponse === "function" && !t.__bxGr) {
            t.getResponse = function () { return w["${STORE}"].t; };
            t.__bxGr = true;
          }
          if (t.__bxGr) res.gr = true;
          if (typeof t.execute === "function" && !t.__bxEx) {
            t.execute = function () { return Promise.resolve(w["${STORE}"].t); };
            t.__bxEx = true;
          }
          if (t.__bxEx) res.ex = true;
        } catch (e) {}
      }

      try {
        var cfg = w.___grecaptcha_cfg;
        if (cfg && cfg.clients) {
          var seen = [];
          var walk = function (o, d) {
            if (d > 6 || !o || typeof o !== "object") return;
            if (seen.indexOf(o) !== -1) return;
            seen.push(o);
            if (typeof o.callback === "function") {
              try { o.callback(token); res.cb++; } catch (e) {}
            }
            for (var k in o) { try { walk(o[k], d + 1); } catch (e) {} }
          };
          for (var c in cfg.clients) walk(cfg.clients[c], 0);
        }
      } catch (e) {}

      docEl.setAttribute("${RESULT_ATTR}", JSON.stringify(res));
    } catch (e) {
      try { docEl.setAttribute("${RESULT_ATTR}", JSON.stringify({ ta: 0, gr: false, ex: false, cb: 0, error: String(e) })); } catch (e2) {}
    }
  });
})();`;
}

/**
 * Expression run in each frame's ISOLATED world by the solver. Fills the
 * textarea directly (shared DOM — works even if the bridge is absent), then
 * hands the token to the main-world bridge via a shared DOM attribute + a
 * synchronous DOM event, and reads back the bridge's result.
 */
export function buildApplyTokenExpression(token: string): string {
  const t = JSON.stringify(token);
  return `(function () {
  var docEl = document.documentElement;
  var out = { ta: 0, bridge: null };
  try {
    var tas = document.querySelectorAll('textarea[name^="g-recaptcha-response"],textarea[id^="g-recaptcha-response"],#g-recaptcha-response');
    for (var i = 0; i < tas.length; i++) {
      try {
        tas[i].value = ${t};
        tas[i].dispatchEvent(new Event("input", { bubbles: true }));
        tas[i].dispatchEvent(new Event("change", { bubbles: true }));
        out.ta++;
      } catch (e) {}
    }
  } catch (e) {}
  try {
    docEl.setAttribute("${TOKEN_ATTR}", ${t});
    docEl.removeAttribute("${RESULT_ATTR}");
    document.dispatchEvent(new Event("${EVENT}"));
    var raw = docEl.getAttribute("${RESULT_ATTR}");
    out.bridge = raw ? JSON.parse(raw) : null;
    docEl.removeAttribute("${TOKEN_ATTR}");
    docEl.removeAttribute("${RESULT_ATTR}");
  } catch (e) {}
  return out;
})()`;
}

type CdpCapablePage = {
  sendCDP: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
};

/**
 * Register the main-world bridge so it loads into every document/frame. Safe to
 * call once per page right after `stagehand.init()` (before navigation).
 * Disable via RECAPTCHA_BRIDGE_DISABLE=1.
 */
export async function installRecaptchaBridge(page: Page): Promise<boolean> {
  if (process.env.RECAPTCHA_BRIDGE_DISABLE === "1") return false;
  const cdp = page as unknown as CdpCapablePage;
  try {
    await cdp.sendCDP("Page.addScriptToEvaluateOnNewDocument", {
      source: buildBridgeSource(),
      runImmediately: true,
    });
    return true;
  } catch {
    return false;
  }
}

// Page-settle helper. LinkedIn's feed is heavily lazy-loaded, so launching the
// agent immediately after `goto(..., { waitUntil: "load" })` means its first
// screenshots are skeleton placeholders — nothing the model can ground a click
// on. We wait for the document to finish, give the SPA time to hydrate, and
// (for feed tasks) nudge a scroll to trigger lazy-loaded posts before handing
// control to the agent.

import type { Page } from "@browserbasehq/stagehand";
import { evalInPage } from "./cdpEval.js";

// Structural subset of Stagehand's understudy Page — avoids a deep type import.
export interface SettlePageLike {
  url(): string;
  waitForLoadState(
    state: "load" | "domcontentloaded" | "networkidle",
    timeoutMs?: number,
  ): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<unknown>;
}

export interface SettleOptions {
  /** Fixed wait (ms) after load so SPA/lazy content can hydrate. */
  settleMs?: number;
  /** Run a small scroll cycle to trigger lazy-loaded feed items, then return to top. */
  scroll?: boolean;
  onLog?: (msg: string) => void;
}

export async function settlePage(
  page: Page & SettlePageLike,
  opts: SettleOptions = {},
): Promise<void> {
  const settleMs = opts.settleMs ?? Number(process.env.FEED_SETTLE_MS ?? 3000);
  const log = opts.onLog ?? (() => {});

  // 1) Best-effort wait for the load event (already mostly done after goto).
  await page.waitForLoadState("load", 15000).catch(() => {});

  // 2) Poll document.readyState until complete (cap ~5s).
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const ready = await evalInPage(page, () => document.readyState).catch(() => "complete");
    if (ready === "complete") break;
    await page.waitForTimeout(250);
  }

  // 3) Fixed settle for client-side hydration / first paint of feed cards.
  if (settleMs > 0) await page.waitForTimeout(settleMs);

  // 4) Feed lazy-loads on scroll — nudge it, then scroll back to the top so the
  //    agent starts from a clean viewport.
  if (opts.scroll) {
    const dims = (await evalInPage(page, () => ({
      w: window.innerWidth,
      h: window.innerHeight,
    })).catch(() => null)) as { w: number; h: number } | null;
    const h = dims?.h ?? 800;
    const cx = Math.floor((dims?.w ?? 1280) / 2);
    const cy = Math.floor(h / 2);
    for (let i = 0; i < 2; i++) {
      await page.scroll(cx, cy, 0, Math.round(h * 0.9)).catch(() => {});
      await page.waitForTimeout(1000);
    }
    await evalInPage(page, () => window.scrollTo({ top: 0 })).catch(() => {});
    await page.waitForTimeout(500);
  }

  log(`page settled (waited ${settleMs}ms${opts.scroll ? " + scroll" : ""})`);
}

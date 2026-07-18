// Context-less page evaluation for our stealth config.
//
// session.ts + the Stagehand patch strip CDP `Runtime.enable` (it has
// page-observable side effects that CDP detectors probe). Without it, Chrome
// never emits `Runtime.executionContextCreated`, so Stagehand's execution-context
// registry stays empty and the stock `page.evaluate()` always throws
// "main world not ready for frame <id>" — even for the top frame.
//
// A context-less `Runtime.evaluate` (no `contextId`) runs in the session's
// default context (the top frame) and works fine WITHOUT `Runtime.enable`, so we
// use it for every in-page script. This is the fallback the session.ts comment
// promised but that the patched Stagehand no longer performs internally.
import type { Page } from "@browserbasehq/stagehand";

type CdpEvalResponse = {
  result?: { value?: unknown };
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string };
  };
};

type CdpCapablePage = {
  sendCDP: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
};

type FrameTreeNode = {
  frame: { id: string; url: string };
  childFrames?: FrameTreeNode[];
};

export interface FrameEvalHit<T> {
  frameId: string;
  url: string;
  result: T;
}

function buildEvalExpression(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fnOrExpression: string | ((...args: any[]) => unknown),
  arg?: unknown,
): string {
  if (typeof fnOrExpression === "string") return fnOrExpression;
  return `(() => {
    const __name = (target) => target;
    const __fn = ${fnOrExpression.toString()};
    const __arg = ${arg === undefined ? "undefined" : JSON.stringify(arg)};
    return Promise.resolve(__fn(__arg)).then((v) => {
      try { return JSON.parse(JSON.stringify(v)); } catch { return v; }
    });
  })()`;
}

async function runtimeEvaluate<T>(
  cdp: CdpCapablePage,
  expression: string,
  contextId?: number,
): Promise<T> {
  const res = await cdp.sendCDP<CdpEvalResponse>("Runtime.evaluate", {
    expression,
    ...(contextId != null ? { contextId } : {}),
    returnByValue: true,
    awaitPromise: true,
  });

  if (res.exceptionDetails) {
    throw new Error(
      res.exceptionDetails.exception?.description ||
        res.exceptionDetails.text ||
        "page evaluation failed",
    );
  }
  return res.result?.value as T;
}

async function getAllFrames(page: Page): Promise<Array<{ id: string; url: string }>> {
  const cdp = page as unknown as CdpCapablePage;
  const { frameTree } = await cdp.sendCDP<{ frameTree: FrameTreeNode }>("Page.getFrameTree");
  const frames: Array<{ id: string; url: string }> = [];
  const walk = (node: FrameTreeNode) => {
    frames.push({ id: node.frame.id, url: node.frame.url });
    for (const child of node.childFrames ?? []) walk(child);
  };
  walk(frameTree);
  return frames;
}

/** Evaluate in a specific frame's isolated world (DOM is shared with main world). */
export async function evalInFrame<T = unknown>(
  page: Page,
  frameId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fnOrExpression: string | ((...args: any[]) => unknown),
  arg?: unknown,
): Promise<T> {
  const cdp = page as unknown as CdpCapablePage;
  const { executionContextId } = await cdp.sendCDP<{ executionContextId: number }>(
    "Page.createIsolatedWorld",
    {
      frameId,
      worldName: `aether_${frameId.slice(0, 12)}`,
      grantUniversalAccess: true,
    },
  );
  return runtimeEvaluate<T>(cdp, buildEvalExpression(fnOrExpression, arg), executionContextId);
}

/** Run the same script in every frame (including LinkedIn checkpoint iframes). */
export async function evalInAllFrames<T = unknown>(
  page: Page,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fnOrExpression: string | ((...args: any[]) => unknown),
  arg?: unknown,
): Promise<FrameEvalHit<T>[]> {
  const frames = await getAllFrames(page);
  const hits: FrameEvalHit<T>[] = [];
  for (const frame of frames) {
    try {
      const result = await evalInFrame<T>(page, frame.id, fnOrExpression, arg);
      hits.push({ frameId: frame.id, url: frame.url, result });
    } catch {
      // Frame may be cross-origin or not yet ready — skip quietly.
    }
  }
  return hits;
}

export async function setCookieViaCdp(
  page: Page,
  params: {
    name: string;
    value: string;
    url: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
  },
): Promise<boolean> {
  const cdp = page as unknown as CdpCapablePage;
  const res = await cdp.sendCDP<{ success?: boolean }>("Network.setCookie", {
    path: "/",
    secure: true,
    sameSite: "None",
    ...params,
  });
  return res.success !== false;
}

/**
 * Evaluate a function (or raw JS expression string) in the page's top-frame main
 * world without requiring CDP `Runtime.enable`.
 *
 * Mirrors Stagehand's own `page.evaluate` serialization (stringify fn, JSON arg,
 * JSON round-trip the result) but issues a context-less `Runtime.evaluate` so it
 * survives the stealth patch.
 */
export async function evalInPage<T = unknown>(
  page: Page,
  // Page-context script: stringified and run in the browser, so its declared
  // arg type doesn't have to line up with `arg` here — keep it permissive.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fnOrExpression: string | ((...args: any[]) => unknown),
  arg?: unknown,
): Promise<T> {
  const cdp = page as unknown as CdpCapablePage;
  return runtimeEvaluate<T>(cdp, buildEvalExpression(fnOrExpression, arg));
}

import type { Emit } from "../runner/emit.js";
import type { EventType } from "../shared/types.js";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

function ts(): string {
  // Local wall-clock time (HH:MM:SS) so console timestamps match the operator's
  // clock. (toTimeString() is local; toISOString() would print UTC.)
  return new Date().toTimeString().slice(0, 8);
}

function line(color: string, label: string, detail: string): void {
  console.log(`${DIM}${ts()}${RESET} ${color}${label}${RESET} ${detail}`);
}

function hostFromUrl(url: unknown): string | undefined {
  if (typeof url !== "string" || !url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 60);
  }
}

function summarizeEvent(type: EventType, data: unknown): string | null {
  const d = (data ?? {}) as Record<string, unknown>;

  if (type === "ActionStarted") {
    if (d.phase === "signup_profile_url") return "capturing LinkedIn profile URL";
    if (d.phase === "signup_feed_warmup") return "warming up feed";
    if (d.taskType === "signup") return `signup started (${d.persona ?? "persona"})`;
    if (d.taskType === "login") return `login started (${d.email ?? "account"})`;
    if (d.url) return `navigating ${hostFromUrl(d.url) ?? d.url}`;
    return "action started";
  }

  if (type === "ActionSucceeded") {
    if (d.tool) {
      const tool = String(d.tool);
      if (tool.includes("email") || tool.includes("smtp")) return `tool → smtp.dev (${tool})`;
      if (tool.includes("phone") || tool.includes("5sim") || tool.includes("cancel_phone")) {
        return `tool → 5sim (${tool})`;
      }
      if (tool.includes("captcha") || tool.includes("recaptcha")) return `tool → captcha (${tool})`;
      return `tool → ${tool}`;
    }
    if (d.phase === "signup_profile_url") {
      const url = d.linkedInProfileUrl ?? d.url;
      return url ? `profile URL → ${url}` : "profile URL captured";
    }
    if (d.phase === "signup_feed_warmup") return "feed warmup done";
    if (d.step && d.pageUrl) {
      const host = hostFromUrl(d.pageUrl);
      const action = d.actionType ? String(d.actionType) : "step";
      return `agent ${action} ${host ?? d.pageUrl}`;
    }
    if (d.message && typeof d.message === "string" && d.message.length < 80) {
      return String(d.message);
    }
    return null;
  }

  if (type === "ActionFailed") {
    const err = d.error ?? d.message ?? "failed";
    const errStr = String(err).slice(0, 120);
    if (d.tool) {
      const tool = String(d.tool);
      if (tool.includes("email") || tool.includes("verification_code")) {
        return `tool → smtp.dev (${tool}): ${errStr}`;
      }
      if (tool.includes("phone") || tool.includes("5sim") || tool.includes("cancel_phone")) {
        return `tool → 5sim (${tool}): ${errStr}`;
      }
      if (tool.includes("captcha") || tool.includes("recaptcha")) {
        return `tool → captcha (${tool}): ${errStr}`;
      }
      return `tool → ${tool}: ${errStr}`;
    }
    return errStr;
  }

  if (type === "PageObserved") {
    const state = d.pageState ?? d.state;
    if (state && state !== "normal") return `page: ${state}`;
    return null;
  }

  if (type === "ChallengeDetected") return `challenge: ${d.pageState ?? "detected"}`;
  if (type === "RestrictionDetected") return "restriction detected";
  if (type === "AccountCreated") return `account created ${d.email ?? ""}`.trim();
  if (type === "LoginSucceeded") return `login ok ${d.email ?? ""}`.trim();
  if (type === "FingerprintLoaded") return "browser profile loaded";
  if (type === "SnapshotCommitted") return "snapshot saved";
  if (type === "SessionStarted") return "session started";
  if (type === "SessionEnded") return `session ended (${d.outcome ?? d.status ?? "done"})`;
  if (type === "AnomalyObserved") return `anomaly: ${d.reason ?? "observed"}`;

  return null;
}

export interface ConsoleReporter {
  phase: (name: string) => void;
  info: (message: string) => void;
  wrapEmit: (emit: Emit) => Emit;
}

export function createConsoleReporter(): ConsoleReporter {
  return {
    phase(name) {
      line(CYAN, "▸", name);
    },
    info(message) {
      line(GREEN, "·", message);
    },
    wrapEmit(emit: Emit): Emit {
      return async (type, data, actionId) => {
        const id = await emit(type, data, actionId);
        const summary = summarizeEvent(type, data);
        if (!summary) return id;
        if (type === "ActionFailed" || type === "ChallengeDetected" || type === "RestrictionDetected") {
          line(RED, "!", summary);
        } else if (type === "AnomalyObserved") {
          line(YELLOW, "~", summary);
        } else {
          line(GREEN, "·", summary);
        }
        return id;
      };
    },
  };
}

/** Filter Stagehand logger output to one-line agent hints. */
export function formatStagehandLog(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  if (!trimmed) return null;
  // Skip noisy debug lines
  if (/^(debug|trace|verbose)/i.test(trimmed)) return null;
  if (trimmed.length > 140) return trimmed.slice(0, 137) + "...";
  return trimmed;
}

// Captures what the agent actually saw during a hybrid run: per-step screenshots
// plus a JSONL trace of every tool call (action, args, reasoning, outcome).
// Wired via agent.execute({ callbacks: { onEvidence } }). Best-effort and fully
// isolated — a capture failure must never break the task. Disable with
// AGENT_DEBUG=false; relocate with AGENT_DEBUG_DIR (default ./.debug).

import fs from "node:fs";
import path from "node:path";

// Structural mirror of Stagehand's AgentEvidenceEvent union (the SDK does not
// re-export it from the package root). The runtime event is assignable to this.
type ScreenshotEvent = {
  type: "screenshot";
  screenshot: Buffer;
  url: string;
  evidenceRole: string;
};
type StepFinishedEvent = {
  type: "step_finished";
  actionName: string;
  actionArgs: Record<string, unknown>;
  reasoning: string;
  toolOutput: { ok: boolean; result: unknown; error?: string };
};
type StepObservedEvent = { type: "step_observed"; url: string; ariaTree?: string };
type FinalAnswerEvent = {
  type: "final_answer";
  message: string;
  output?: Record<string, unknown>;
  observation?: { url: string; screenshot?: Buffer; ariaTree?: string };
};
export type AgentEvidenceLike =
  | ScreenshotEvent
  | StepFinishedEvent
  | StepObservedEvent
  | FinalAnswerEvent;

export interface AgentDebugOptions {
  taskId: string;
  taskType: string;
  model: string;
  baseDir?: string;
}

export interface AgentDebugRecorder {
  dir: string;
  handle: (event: AgentEvidenceLike) => void;
  finish: () => { dir: string; screenshots: number; steps: number };
}

const NOOP: AgentDebugRecorder = {
  dir: "",
  handle: () => {},
  finish: () => ({ dir: "", screenshots: 0, steps: 0 }),
};

function tsStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function createAgentDebugRecorder(opts: AgentDebugOptions): AgentDebugRecorder {
  if (process.env.AGENT_DEBUG === "false" || process.env.AGENT_DEBUG === "0") {
    return NOOP;
  }

  const base = opts.baseDir ?? process.env.AGENT_DEBUG_DIR ?? "./.debug";
  const dir = path.resolve(base, `${opts.taskType}-${opts.taskId}-${tsStamp()}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify(
        {
          taskId: opts.taskId,
          taskType: opts.taskType,
          model: opts.model,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } catch {
    return NOOP;
  }

  const stepsLog = path.join(dir, "steps.jsonl");
  const pad = (n: number) => String(n).padStart(3, "0");
  let seq = 0;
  let screenshots = 0;
  let steps = 0;

  const appendStep = (record: Record<string, unknown>) => {
    fs.appendFileSync(stepsLog, `${JSON.stringify({ seq, ts: Date.now(), ...record })}\n`);
  };

  const handle = (event: AgentEvidenceLike) => {
    try {
      switch (event.type) {
        case "screenshot": {
          seq += 1;
          screenshots += 1;
          const file = path.join(dir, `${pad(seq)}-${event.evidenceRole}.png`);
          fs.writeFileSync(file, event.screenshot);
          appendStep({
            kind: "screenshot",
            role: event.evidenceRole,
            url: event.url,
            file: path.basename(file),
          });
          break;
        }
        case "step_finished": {
          seq += 1;
          steps += 1;
          appendStep({
            kind: "step",
            actionName: event.actionName,
            actionArgs: event.actionArgs,
            reasoning:
              typeof event.reasoning === "string" ? event.reasoning.slice(0, 1000) : undefined,
            ok: event.toolOutput?.ok,
            error: event.toolOutput?.error,
          });
          break;
        }
        case "step_observed": {
          seq += 1;
          appendStep({
            kind: "observed",
            url: event.url,
            hasAriaTree: Boolean(event.ariaTree),
          });
          break;
        }
        case "final_answer": {
          seq += 1;
          const obs = event.observation;
          if (obs?.screenshot) {
            fs.writeFileSync(path.join(dir, `${pad(seq)}-final.png`), obs.screenshot);
            screenshots += 1;
          }
          fs.writeFileSync(
            path.join(dir, "final.json"),
            JSON.stringify(
              { message: event.message, output: event.output ?? null, url: obs?.url ?? null },
              null,
              2,
            ),
          );
          appendStep({
            kind: "final",
            message: typeof event.message === "string" ? event.message.slice(0, 1000) : undefined,
          });
          break;
        }
      }
    } catch {
      // best-effort capture; never break the run
    }
  };

  return {
    dir,
    handle,
    finish: () => ({ dir, screenshots, steps }),
  };
}

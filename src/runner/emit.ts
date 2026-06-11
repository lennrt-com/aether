import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel.js";
import type { Channel, EventCtx, EventType } from "../shared/types.js";

export interface EmitterConfig {
  convex: ConvexHttpClient;
  workerKey: string;
  profileId: Id<"profiles">;
  sessionId?: Id<"sessions">;
  taskId?: Id<"tasks">;
  channel: Channel;
  ctx: EventCtx;
}

export type Emit = (
  type: EventType,
  data: unknown,
  actionId?: string,
) => Promise<Id<"events">>;

// The ONLY path from the runner to the events table.
export function createEmitter(cfg: EmitterConfig): Emit {
  return async (type, data, actionId) =>
    await cfg.convex.mutation(api.events.append, {
      workerKey: cfg.workerKey,
      profileId: cfg.profileId,
      sessionId: cfg.sessionId,
      taskId: cfg.taskId,
      actionId,
      type,
      ts: Date.now(),
      channel: cfg.channel,
      data,
      ctx: {
        ...cfg.ctx,
        strategyVersionId: cfg.ctx.strategyVersionId as
          | Id<"strategyVersions">
          | undefined,
      },
    });
}

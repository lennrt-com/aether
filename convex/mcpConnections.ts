import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertWorkerKey } from "./lib/guards";
import { requireUser } from "./lib/auth";

const headerMapping = v.object({
  header: v.string(),
  envVar: v.string(),
});

const connectionFields = {
  name: v.string(),
  transport: v.union(v.literal("stdio"), v.literal("http")),
  command: v.optional(v.string()),
  args: v.optional(v.array(v.string())),
  envFromWorker: v.optional(v.array(v.string())),
  url: v.optional(v.string()),
  headersFromWorker: v.optional(v.array(headerMapping)),
  enabled: v.optional(v.boolean()),
  notes: v.optional(v.string()),
};

function validateConnection(args: {
  transport: "stdio" | "http";
  command?: string;
  url?: string;
}): void {
  if (args.transport === "stdio") {
    if (!args.command?.trim()) throw new Error("command is required for stdio transport");
  } else if (!args.url?.trim()) {
    throw new Error("url is required for http transport");
  } else {
    try {
      new URL(args.url);
    } catch {
      throw new Error("url must be a valid URL");
    }
  }
}

function toPublicRow(row: {
  _id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  envFromWorker?: string[];
  url?: string;
  headersFromWorker?: Array<{ header: string; envVar: string }>;
  enabled: boolean;
  notes?: string;
  updatedAt: number;
}) {
  return {
    id: row._id,
    name: row.name,
    transport: row.transport,
    command: row.command ?? null,
    args: row.args ?? [],
    envFromWorker: row.envFromWorker ?? [],
    url: row.url ?? null,
    headersFromWorker: row.headersFromWorker ?? [],
    enabled: row.enabled,
    notes: row.notes ?? null,
    updatedAt: row.updatedAt,
  };
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const rows = await ctx.db.query("mcpConnections").collect();
    return rows.sort((a, b) => a.name.localeCompare(b.name)).map(toPublicRow);
  },
});

export const listWorker = query({
  args: { workerKey: v.string(), names: v.optional(v.array(v.string())) },
  handler: async (ctx, { workerKey, names }) => {
    assertWorkerKey(workerKey);
    const rows = await ctx.db.query("mcpConnections").collect();
    const enabled = rows.filter((r) => r.enabled);
    const filtered =
      names && names.length > 0 ? enabled.filter((r) => names.includes(r.name)) : enabled;
    return filtered.map(toPublicRow);
  },
});

export const getByName = query({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    await requireUser(ctx);
    const row = await ctx.db
      .query("mcpConnections")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique();
    return row ? toPublicRow(row) : null;
  },
});

export const upsert = mutation({
  args: connectionFields,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const name = args.name.trim();
    if (!name) throw new Error("name is required");
    validateConnection(args);

    const now = Date.now();
    const existing = await ctx.db
      .query("mcpConnections")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique();

    const doc = {
      name,
      transport: args.transport,
      command: args.command,
      args: args.args,
      envFromWorker: args.envFromWorker,
      url: args.url,
      headersFromWorker: args.headersFromWorker,
      enabled: args.enabled ?? true,
      notes: args.notes,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, doc);
      return { id: existing._id, name, created: false };
    }

    const id = await ctx.db.insert("mcpConnections", doc);
    return { id, name, created: true };
  },
});

export const upsertApi = mutation({
  args: { workerKey: v.string(), ...connectionFields },
  handler: async (ctx, { workerKey, ...args }) => {
    assertWorkerKey(workerKey);
    const name = args.name.trim();
    if (!name) throw new Error("name is required");
    validateConnection(args);

    const now = Date.now();
    const existing = await ctx.db
      .query("mcpConnections")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique();

    const doc = {
      name,
      transport: args.transport,
      command: args.command,
      args: args.args,
      envFromWorker: args.envFromWorker,
      url: args.url,
      headersFromWorker: args.headersFromWorker,
      enabled: args.enabled ?? true,
      notes: args.notes,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, doc);
      return { id: existing._id, name, created: false };
    }

    const id = await ctx.db.insert("mcpConnections", doc);
    return { id, name, created: true };
  },
});

export const remove = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    await requireUser(ctx);
    const existing = await ctx.db
      .query("mcpConnections")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique();
    if (!existing) throw new Error(`connection not found: ${name}`);
    await ctx.db.delete(existing._id);
    return { name, deleted: true };
  },
});

export const removeApi = mutation({
  args: { workerKey: v.string(), name: v.string() },
  handler: async (ctx, { workerKey, name }) => {
    assertWorkerKey(workerKey);
    const existing = await ctx.db
      .query("mcpConnections")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique();
    if (!existing) throw new Error(`connection not found: ${name}`);
    await ctx.db.delete(existing._id);
    return { name, deleted: true };
  },
});

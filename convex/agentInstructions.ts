import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertWorkerKey } from "./lib/guards";
import { requireUser } from "./lib/auth";

const instructionKey = v.union(
  v.literal("direct_act_preamble"),
  v.literal("general_form_guidance"),
  v.literal("phone_verification"),
  v.literal("agent"),
);

/** Generic Aether agent instruction templates (no site-specific defaults). */
const DEFAULT_TEMPLATES: Record<string, string> = {
  direct_act_preamble:
    "Step 1 (required): immediately perform a visible browser action on the page — scroll down at least one viewport, or click/focus an interactive element. Do NOT spend your first step only observing, screenshotting, or reading the accessibility tree. After that first action, continue with the task below.",

  general_form_guidance:
    "Text fields (CRITICAL — apply on every form): Before typing into ANY text input, clear existing content first. Click/focus the field, select all (Ctrl+A or Cmd+A), delete or Backspace until the field is completely empty, then type the new value. NEVER type on top of pre-filled, placeholder, or leftover text. For autocomplete fields: clear, type slowly, wait for suggestions, then select a matching suggestion before continuing.",

  phone_verification:
    "Phone verification: call get_phone_number when the phone number field is visible, enter the number (use digitsOnly if '+' is rejected), submit, then call read_phone_verification_code when the SMS code field appears. If no SMS arrives, cancel only after the tool allows it, return the UI to an empty phone field, then request a new number. Cap retries at 5 numbers per session.",

  agent:
    "Follow the user instructions precisely. Prefer visible, deliberate browser actions. For Google reCAPTCHA use solve_recaptcha; for FunCaptcha/Arkose use prepare_captcha_view / pan_captcha_view and solve visually. If login credentials are provided as variables, use them only when the site requires login. When finished, report a short success/failure summary.",
};

const ALL_KEYS = Object.keys(DEFAULT_TEMPLATES);

function mergeWithDefaults(
  rows: Array<{ key: string; template: string }>,
): Record<string, string> {
  const merged = { ...DEFAULT_TEMPLATES };
  for (const row of rows) {
    merged[row.key] = row.template;
  }
  return merged;
}

/** Runner/worker: live templates merged over code defaults. */
export const getForRunner = query({
  args: { workerKey: v.string() },
  handler: async (ctx, { workerKey }) => {
    assertWorkerKey(workerKey);
    const rows = await ctx.db.query("agentInstructions").collect();
    return mergeWithDefaults(rows);
  },
});

/** Dashboard: list stored rows plus effective templates. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const rows = await ctx.db.query("agentInstructions").collect();
    const merged = mergeWithDefaults(rows);
    return {
      keys: ALL_KEYS,
      templates: merged,
      overrides: rows.map((row) => ({
        key: row.key,
        template: row.template,
        updatedAt: row.updatedAt,
        notes: row.notes,
      })),
    };
  },
});

export const upsert = mutation({
  args: {
    key: instructionKey,
    template: v.string(),
    notes: v.optional(v.string()),
    workerKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.workerKey) {
      assertWorkerKey(args.workerKey);
    } else {
      await requireUser(ctx);
    }
    const existing = await ctx.db
      .query("agentInstructions")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        template: args.template,
        updatedAt: now,
        notes: args.notes,
      });
      return existing._id;
    }
    return await ctx.db.insert("agentInstructions", {
      key: args.key,
      template: args.template,
      updatedAt: now,
      notes: args.notes,
    });
  },
});

export const seedDefaults = mutation({
  args: { workerKey: v.string() },
  handler: async (ctx, { workerKey }) => {
    assertWorkerKey(workerKey);
    const now = Date.now();
    let upserted = 0;
    for (const [key, template] of Object.entries(DEFAULT_TEMPLATES)) {
      const existing = await ctx.db
        .query("agentInstructions")
        .withIndex("by_key", (q) => q.eq("key", key))
        .first();
      if (existing) continue;
      await ctx.db.insert("agentInstructions", { key, template, updatedAt: now });
      upserted += 1;
    }
    return { upserted };
  },
});

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertWorkerKey } from "./lib/guards";
import { requireUser } from "./lib/auth";

const instructionKey = v.union(
  v.literal("direct_act_preamble"),
  v.literal("general_form_guidance"),
  v.literal("phone_verification"),
  v.literal("signup"),
  v.literal("login"),
  v.literal("complete_onboarding"),
  v.literal("warmup_feed"),
  v.literal("engage_post"),
);

// Mirrors src/shared/agentInstructionDefaults.ts — kept here for Convex seed/deploy.
const DEFAULT_TEMPLATES: Record<string, string> = {
  direct_act_preamble:
    "Step 1 (required): immediately perform a visible browser action on the page — scroll down at least one viewport, or click/focus an interactive element. Do NOT spend your first step only observing, screenshotting, or reading the accessibility tree. After that first action, continue with the task below.",

  general_form_guidance:
    "Text fields (CRITICAL — apply on every form): Before typing into ANY text input, clear existing content first. Click/focus the field, select all (Ctrl+A or Cmd+A), delete or Backspace until the field is completely empty, then type the new value. NEVER type on top of pre-filled, placeholder, or leftover text — that creates garbled values and breaks LinkedIn forms. If a field already shows wrong or duplicated text, clear it entirely before retrying. LinkedIn location during onboarding: this is an autocomplete field, NOT free text. Click the location field, clear it completely, type the persona Location (city and region) slowly, wait for LinkedIn's dropdown suggestions to appear, then CLICK the matching suggestion from the list. Do not press Enter or Continue until a suggestion is selected and the field shows the chosen location (not raw typed text). Same rule for job title, company, industry, and school when LinkedIn shows suggestions: clear the field, type to filter, wait for the dropdown, then select from the list — never submit unselected typed text.",

  phone_verification:
    "Phone verification: call get_phone_number when the phone number field is visible, enter the number (use digitsOnly if '+' is rejected), submit, then call read_phone_verification_code when the SMS code field appears. If read_phone_verification_code fails with no SMS (timeout), you MUST NOT give up immediately — retry with a new number when allowed. Cancellation rule: call cancel_phone_number ONLY at least 2 minutes after get_phone_number for that same number (the tool enforces this). After cancel_phone_number succeeds, fix the LinkedIn UI before buying again: click Back, Edit phone number, Use a different number, Add another phone number, Change, or the localized equivalent until the phone input is empty again. Then call get_phone_number for a fresh number. You may buy at most 5 numbers total per signup. Repeat: get_phone_number → enter on LinkedIn → read_phone_verification_code → (if no code after wait) cancel_phone_number → LinkedIn UI back to empty phone field → get_phone_number again.",

  login:
    "Sign in to LinkedIn with the email %email% and the password %password%. If the page already shows a logged-in LinkedIn feed, you are done immediately. If LinkedIn asks for a verification code sent by email, call read_verification_code ONLY when the email verification screen is visible, then enter the code it returns. {{phoneVerification}} For ANY Google reCAPTCHA (invisible, checkbox, or image grid), call solve_recaptcha once. If a LinkedIn security modal (Sicherheitsprüfung) is open, click Verify/Weiter INSIDE the modal after solve_recaptcha — do NOT call solve_recaptcha again without clicking verify first. Otherwise click Submit/Continue on the signup form once and wait 3–5 seconds. Max 3 solve_recaptcha calls total. Do not use prepare_captcha_view/pan_captcha_view for reCAPTCHA. ONLY for a FunCaptcha / Arkose puzzle, call prepare_captcha_view, then solve it visually with clicks and drags. If Arkose puzzle pieces are clipped in a small box, call pan_captcha_view (left/right/up/down) until the full challenge is visible. You are done when you reach the logged-in LinkedIn feed.",

  complete_onboarding:
    "You are finishing onboarding for a LinkedIn account that already exists. Do NOT create a new account, do NOT fill signup forms, and do NOT call create_email_address. If you are already on the logged-in LinkedIn feed (post stream, logged-in nav bar) with NO email verification banner at the top, you are done — set success=true immediately. If an email verification banner is visible at the top (prompting you to verify your email), click the action link in the banner (e.g. Resend email, Verify email, or the localized equivalent) to trigger LinkedIn to send a verification email. Then call read_verification_link and navigate the browser directly to the URL it returns. Wait for the page to load and confirm the verification banner is gone. If LinkedIn asks for a 6-digit email code instead, call read_verification_code ONLY when that screen is visible. {{phoneVerification}} For ANY Google reCAPTCHA (invisible, checkbox, or image grid), call solve_recaptcha once. If a LinkedIn security modal is open, click Verify/Weiter inside the modal after solve_recaptcha. Max 3 solve_recaptcha calls total. ONLY for a FunCaptcha / Arkose puzzle, call prepare_captcha_view and solve it visually. Set success=true when logged in on the feed with no email verification banner blocking use. Set success=false if you hit a login wall, account restriction or suspension notice, or cannot verify email.",

  signup:
    "You are {{fullName}}, creating a brand-new LinkedIn account for yourself. {{personaBlock}} Step 1: call the create_email_address tool to get a fresh email address with a working inbox. Step 2: on the LinkedIn signup page, fill the form using that email address and the password %password%. Use first name \"{{firstName}}\" and last name \"{{lastName}}\" when asked — clear each name field completely before typing. Step 3: after first and last name, LinkedIn may show a Google reCAPTCHA or a FunCaptcha (Arkose Labs) puzzle. Google reCAPTCHA — invisible, checkbox, OR image grid — is ALWAYS handled by solve_recaptcha (never prepare_captcha_view/pan_captcha_view). Call solve_recaptcha once. If the LinkedIn security modal (Sicherheitsprüfung) is visible, click Verify/Weiter inside the modal after the tool returns — do NOT call solve_recaptcha again before clicking verify. If no modal, click Submit/Continue on the signup form once and wait 3–5 seconds. Max 3 solve_recaptcha calls total. ONLY if you see a FunCaptcha / Arkose puzzle (rotate the image, pick the matching object), call prepare_captcha_view, then solve it visually: click verify, drag tiles, rotate images, or pick matching objects. For an Arkose puzzle in a small scrollable box, call pan_captcha_view (try left and right) until the full puzzle is visible. If it refreshes, call prepare_captcha_view again and retry calmly. Step 4: once past the captcha, submit or continue. When the browser shows the email verification screen (6-digit code sent to your email), call read_verification_code and type the code it returns. Do NOT call read_verification_code before that screen appears. {{phoneVerification}} Step 5: if LinkedIn shows guided onboarding screens (location, job title, industry, experience, etc.) BEFORE you reach the feed, complete mandatory fields using the persona details above. For location: clear the field, type the Location value above (city and region, not just country code), wait for suggestions, and SELECT the matching LinkedIn dropdown option before continuing. Job title must match role (select from suggestions when offered); industry must match industry; experience level must be plausible. Skip optional steps — profile photo, contact import, people to follow, premium upsell, app download, newsletter opt-ins — using Skip, Not now, or Continue. SUCCESS — WHEN YOU ARE DONE (this overrides any remaining onboarding): Stop immediately once you are logged in and the normal LinkedIn home feed is visible (post stream, logged-in nav bar — no signup/login wall). LinkedIn often skips or short-circuits the wizard; that is fine. You do NOT need to finish every guided onboarding screen if you already see the feed or can open it. If a modal blocks the feed, dismiss or skip it, or navigate directly to https://www.linkedin.com/feed/ — if the feed loads and you are logged in, you are done. Do NOT keep clicking through leftover wizard steps after the feed is usable. Opening your own profile is NOT required; the system captures your profile URL automatically after you finish. Set success=true only when logged in on the feed (or equivalent logged-in home). Set success=false if you are still on signup, login, email/phone verification, captcha, or a security checkpoint.",

  warmup_feed:
    "You are casually browsing your LinkedIn feed like a normal professional on a short break. {{interestsClause}} Scroll the feed slowly and naturally. Pause to read 2-3 posts that catch your attention. If exactly one post genuinely matches your interests, react to it with a Like — otherwise like nothing. Do NOT comment, share, follow, or connect with anyone. Do NOT open notifications or messages. After reading a few posts, you are done.",

  engage_post:
    "You are browsing your LinkedIn feed and want to engage with one relevant post. {{interestsClause}} {{toneClause}} Scroll the feed and find ONE post that is clearly relevant to your interests. Like that post. If (and only if) you have something brief and genuine to add, write a short comment of 1-2 sentences in your tone — no hashtags, no emojis, no self-promotion. Engage with exactly one post, then you are done. Do NOT follow, connect, share, or open messages.",
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
    const updatedAt = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        template: args.template,
        updatedAt,
        notes: args.notes,
      });
      return existing._id;
    }
    return await ctx.db.insert("agentInstructions", {
      key: args.key,
      template: args.template,
      updatedAt,
      notes: args.notes,
    });
  },
});

/** Seed Convex rows from built-in defaults (safe to re-run — replaces matching keys). */
export const seedDefaults = mutation({
  args: { workerKey: v.string() },
  handler: async (ctx, { workerKey }) => {
    assertWorkerKey(workerKey);
    const updatedAt = Date.now();
    for (const [key, template] of Object.entries(DEFAULT_TEMPLATES)) {
      const existing = await ctx.db
        .query("agentInstructions")
        .withIndex("by_key", (q) => q.eq("key", key))
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, {
          template,
          updatedAt,
          notes: "seeded from defaults",
        });
      } else {
        await ctx.db.insert("agentInstructions", {
          key,
          template,
          updatedAt,
          notes: "seeded from defaults",
        });
      }
    }
    return { keys: ALL_KEYS.length };
  },
});

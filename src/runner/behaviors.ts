// Persona-driven LinkedIn instruction builders. Used by the runner when a
// scheduled browser task has no explicit payload.instruction.

export interface PersonaLike {
  fullName?: string;
  role?: string;
  industry?: string;
  geo?: string;
  backstory?: string;
  tone?: string;
  interests?: string[];
}

export interface Behavior {
  url: string;
  instruction: string;
  maxSteps: number;
}

export const FEED_URL = "https://www.linkedin.com/feed/";
export const LOGIN_URL = "https://www.linkedin.com/login";
/** Resolves to the logged-in member's canonical /in/{slug} profile. */
export const LINKEDIN_PROFILE_ENTRY = "https://www.linkedin.com/in/";

const DIRECT_ACT_PREAMBLE = [
  "Step 1 (required): immediately perform a visible browser action on the page — scroll down at least one viewport, or click/focus an interactive element.",
  "Do NOT spend your first step only observing, screenshotting, or reading the accessibility tree.",
  "After that first action, continue with the task below.",
].join(" ");

/** Prepends a mandatory first-action step so hybrid runs act instead of observe-looping. */
export function withDirectActInstruction(instruction: string): string {
  if (process.env.FORCE_AGENT_ACT === "false") return instruction;
  return `${DIRECT_ACT_PREAMBLE}\n\n${instruction}`;
}

export function needsFeedSettle(taskType: string, url: string): boolean {
  if (taskType === "warmup_feed" || taskType === "engage_post") return true;
  try {
    const u = new URL(url);
    return u.hostname.endsWith("linkedin.com") && u.pathname.startsWith("/feed");
  } catch {
    return false;
  }
}

function interestsClause(persona: PersonaLike | null): string {
  const interests = persona?.interests?.slice(0, 5);
  return interests?.length
    ? `Topics you genuinely care about: ${interests.join(", ")}.`
    : "";
}

function toneClause(persona: PersonaLike | null): string {
  return persona?.tone ? `Your writing tone is: ${persona.tone}.` : "";
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  return {
    firstName: parts[0] || "Alex",
    lastName: parts.length > 1 ? parts[parts.length - 1] : "Carter",
  };
}

/** Onboarding-relevant persona fields for LinkedIn signup wizard steps. */
function personaSignupContext(persona: PersonaLike | null): string {
  if (!persona) return "";
  const lines: string[] = [];
  if (persona.role) lines.push(`Job title / role: ${persona.role}`);
  if (persona.industry) lines.push(`Industry: ${persona.industry}`);
  if (persona.geo) lines.push(`Location (city/region/country): ${persona.geo}`);
  if (persona.interests?.length) {
    lines.push(`Professional interests: ${persona.interests.slice(0, 6).join(", ")}`);
  }
  if (persona.backstory) {
    const brief = persona.backstory.trim().slice(0, 500);
    lines.push(`Background: ${brief}${persona.backstory.length > 500 ? "…" : ""}`);
  }
  if (persona.tone) lines.push(`Tone: ${persona.tone}`);
  if (!lines.length) return "";
  return [
    "Persona details — use these consistently when LinkedIn asks for location, job title, industry, experience level, company, or similar onboarding fields:",
    ...lines.map((l) => `- ${l}`),
  ].join("\n");
}

export function buildBehavior(taskType: string, persona: PersonaLike | null): Behavior | null {
  switch (taskType) {
    case "warmup_feed":
      return {
        url: FEED_URL,
        maxSteps: 1000,
        instruction: [
          "You are casually browsing your LinkedIn feed like a normal professional on a short break.",
          interestsClause(persona),
          "Scroll the feed slowly and naturally. Pause to read 2-3 posts that catch your attention.",
          "If exactly one post genuinely matches your interests, react to it with a Like — otherwise like nothing.",
          "Do NOT comment, share, follow, or connect with anyone. Do NOT open notifications or messages.",
          "After reading a few posts, you are done.",
        ]
          .filter(Boolean)
          .join(" "),
      };
    case "engage_post":
      return {
        url: FEED_URL,
        maxSteps: 1000,
        instruction: [
          "You are browsing your LinkedIn feed and want to engage with one relevant post.",
          interestsClause(persona),
          toneClause(persona),
          "Scroll the feed and find ONE post that is clearly relevant to your interests.",
          "Like that post. If (and only if) you have something brief and genuine to add, write a short comment of 1-2 sentences in your tone — no hashtags, no emojis, no self-promotion.",
          "Engage with exactly one post, then you are done. Do NOT follow, connect, share, or open messages.",
        ]
          .filter(Boolean)
          .join(" "),
      };
    default:
      return null;
  }
}

// Login is orchestrated separately (needs credentials as variables + email
// tools for verification codes) — only the instruction text lives here.
export function buildLoginInstruction(): string {
  return [
    "Sign in to LinkedIn with the email %email% and the password %password%.",
    "If the page already shows a logged-in LinkedIn feed, you are done immediately.",
    "If LinkedIn asks for a verification code sent by email, call read_verification_code ONLY when the email verification screen is visible, then enter the code it returns.",
    "If LinkedIn asks for phone verification, call get_phone_number ONLY when the phone number field is visible, enter the number, then call read_phone_verification_code when the SMS code field appears.",
    "For ANY Google reCAPTCHA (invisible, checkbox, or image grid), call solve_recaptcha once. If a LinkedIn security modal (Sicherheitsprüfung) is open, click Verify/Weiter INSIDE the modal after solve_recaptcha — do NOT call solve_recaptcha again without clicking verify first. Otherwise click Submit/Continue on the signup form once and wait 3–5 seconds. Max 3 solve_recaptcha calls total. Do not use prepare_captcha_view/pan_captcha_view for reCAPTCHA.",
    "ONLY for a FunCaptcha / Arkose puzzle, call prepare_captcha_view, then solve it visually with clicks and drags.",
    "If Arkose puzzle pieces are clipped in a small box, call pan_captcha_view (left/right/up/down) until the full challenge is visible.",
    "You are done when you reach the logged-in LinkedIn feed.",
  ].join(" ");
}

export function buildSignupInstruction(persona: PersonaLike | null): string {
  const fullName = persona?.fullName?.trim() || "Alex Carter";
  const { firstName, lastName } = splitName(fullName);
  const personaBlock = personaSignupContext(persona);

  return [
    `You are ${fullName}, creating a brand-new LinkedIn account for yourself.`,
    personaBlock,
    "Step 1: call the create_email_address tool to get a fresh email address with a working inbox.",
    "Step 2: on the LinkedIn signup page, fill the form using that email address and the password %password%.",
    `Use first name "${firstName}" and last name "${lastName}" when asked.`,
    "Step 3: after first and last name, LinkedIn may show a Google reCAPTCHA or a FunCaptcha (Arkose Labs) puzzle.",
    "Google reCAPTCHA — invisible, checkbox, OR image grid — is ALWAYS handled by solve_recaptcha (never prepare_captcha_view/pan_captcha_view). Call solve_recaptcha once. If the LinkedIn security modal (Sicherheitsprüfung) is visible, click Verify/Weiter inside the modal after the tool returns — do NOT call solve_recaptcha again before clicking verify. If no modal, click Submit/Continue on the signup form once and wait 3–5 seconds. Max 3 solve_recaptcha calls total.",
    "ONLY if you see a FunCaptcha / Arkose puzzle (rotate the image, pick the matching object), call prepare_captcha_view, then solve it visually: click verify, drag tiles, rotate images, or pick matching objects.",
    "For an Arkose puzzle in a small scrollable box, call pan_captcha_view (try left and right) until the full puzzle is visible. If it refreshes, call prepare_captcha_view again and retry calmly.",
    "Step 4: once past the captcha, submit or continue.",
    "When the browser shows the email verification screen (6-digit code sent to your email), call read_verification_code and type the code it returns. Do NOT call read_verification_code before that screen appears.",
    "If the browser shows phone verification instead, call get_phone_number, enter the number (use digitsOnly if '+' is rejected), then call read_phone_verification_code when the SMS code field appears.",
    "Step 5: complete every mandatory onboarding screen after verification using the persona details above — location must match geo, job title must match role, industry must match industry, and experience level must be plausible for the role and backstory.",
    "Step 6: skip every optional step — profile photo upload, contact import, people to follow, premium upsell, app download prompts, newsletter opt-ins. Use Skip, Not now, or Continue as appropriate.",
    "Step 7: keep going through onboarding until you land on the main LinkedIn home feed with the post stream visible and no wizard blocking the page.",
    "You are done only when onboarding is fully finished and the normal feed UI is showing.",
  ]
    .filter(Boolean)
    .join(" ");
}

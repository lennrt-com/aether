// Persona-driven LinkedIn instruction builders. Used by the runner when a
// scheduled browser task has no explicit payload.instruction.

export interface PersonaLike {
  fullName?: string;
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

function interestsClause(persona: PersonaLike | null): string {
  const interests = persona?.interests?.slice(0, 5);
  return interests?.length
    ? `Topics you genuinely care about: ${interests.join(", ")}.`
    : "";
}

function toneClause(persona: PersonaLike | null): string {
  return persona?.tone ? `Your writing tone is: ${persona.tone}.` : "";
}

export function buildBehavior(taskType: string, persona: PersonaLike | null): Behavior | null {
  switch (taskType) {
    case "warmup_feed":
      return {
        url: FEED_URL,
        maxSteps: 12,
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
        maxSteps: 15,
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
    "If LinkedIn asks for a verification code sent by email, call the read_verification_code tool and enter the code it returns.",
    "If you encounter a CAPTCHA or security puzzle you cannot solve, stop and report it honestly.",
    "You are done when you reach the logged-in LinkedIn feed.",
  ].join(" ");
}

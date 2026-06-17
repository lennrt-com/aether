import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";

function allowedAdminEmails(): Set<string> {
  return new Set(
    (process.env.ALLOWED_ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password({
      profile(params) {
        const flow = String(params.flow ?? "");
        if (flow === "signUp") {
          throw new ConvexError("Sign up is disabled");
        }

        const email = String(params.email ?? "")
          .trim()
          .toLowerCase();
        if (!email) {
          throw new ConvexError("Email is required");
        }

        const allowed = allowedAdminEmails();
        if (allowed.size > 0 && !allowed.has(email)) {
          throw new ConvexError("Email not authorized for admin access");
        }

        return { email };
      },
    }),
  ],
});

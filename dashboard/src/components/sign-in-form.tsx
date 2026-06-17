"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SignInForm() {
  const { signIn } = useAuthActions();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  return (
    <div className="relative z-10 w-full max-w-md rounded-2xl border border-hairline bg-surface-card p-8 shadow-soft">
      <div className="mb-8 space-y-2 text-center">
        <h1 className="font-display text-3xl font-medium tracking-tight text-ink">
          Admin sign in
        </h1>
        <p className="text-sm tracking-wide text-muted">
          Access is limited to allowlisted admin emails.
        </p>
      </div>

      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          setLoading(true);
          const formData = new FormData(event.currentTarget);
          void signIn("password", formData)
            .catch((signInError: unknown) => {
              setError(
                signInError instanceof Error
                  ? signInError.message
                  : "Sign in failed",
              );
            })
            .finally(() => setLoading(false));
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            className="h-11 rounded-lg border-hairline-strong"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="h-11 rounded-lg border-hairline-strong"
          />
        </div>

        <input name="flow" type="hidden" value="signIn" />

        {error ? (
          <p className="text-sm text-semantic-error">{error}</p>
        ) : null}

        <Button
          type="submit"
          disabled={loading}
          className="h-10 w-full rounded-full bg-primary text-on-primary hover:bg-primary-active"
        >
          {loading ? "Please wait…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}

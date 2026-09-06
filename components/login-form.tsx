"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { signIn } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const expired = params.get("expired") === "1";
  // Where the operator was heading before the gate stopped them. Only ever a
  // path on this site: an absolute URL here would be an open redirect.
  const rawNext = params.get("next") ?? "/dashboard";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="mt-6 flex flex-col gap-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        const { error: signInError } = await signIn.email({ email, password });
        if (signInError) {
          // Our failure and theirs are different things, and saying "wrong
          // password" for a server misconfiguration sends the operator to fix a
          // side that is not broken. An INVALID_ORIGIN 403 said exactly that
          // during development, and cost an hour.
          //
          // Within a genuine credential rejection it still declines to say which
          // of the two was wrong: that distinction tells an attacker which
          // addresses exist here.
          const status = signInError.status ?? 0;
          const configProblem =
            signInError.code === "INVALID_ORIGIN" || status === 403 || status >= 500;
          setError(
            configProblem
              ? `The server refused the sign-in request itself${
                  signInError.code ? ` (${signInError.code})` : ""
                }. This is a configuration problem on this deployment, not your password — check BETTER_AUTH_URL and BETTER_AUTH_TRUSTED_ORIGINS.`
              : "That email and password combination was not accepted.",
          );
          setBusy(false);
          return;
        }
        router.push(next);
        router.refresh();
      }}
    >
      {expired ? (
        <p className="rounded-sm border border-warning/40 bg-warning/10 px-3 py-2 font-mono text-[11.5px] text-warning">
          That session is no longer valid. Sign in again.
        </p>
      ) : null}

      <label className="flex flex-col gap-1.5">
        <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
          Email
        </span>
        <Input
          type="email"
          name="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
          Password
        </span>
        <Input
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>

      {error ? (
        <p className="font-mono text-[11.5px] text-destructive">{error}</p>
      ) : null}

      <Button type="submit" disabled={busy} className="mt-1">
        {busy ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            Signing in…
          </>
        ) : (
          "Sign in"
        )}
      </Button>
    </form>
  );
}

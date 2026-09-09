import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/db/client";
import { account, session, user, verification } from "@/db/schema";

/**
 * Single-operator auth. There is no public signup, no roles and no tenancy —
 * this exists so a hosted instance cannot have its billed Veo endpoints driven
 * by anyone who finds the URL, not to build an account system nobody asked for
 * (see CLAUDE.md: "Do not add multi-tenant auth without being asked").
 *
 * `disableSignUp` is the whole access-control model. Accounts are created
 * deliberately with `pnpm auth:create-operator`, which is the only path that can
 * make one. An open /sign-up route on a deployment that spends real money would
 * be worse than no auth at all, because it would look protected.
 */
export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { user, session, account, verification },
  }),
  emailAndPassword: {
    enabled: true,
    // The operator is created out of band. Nothing in the product should offer
    // to make an account.
    disableSignUp: true,
  },
  user: {
    additionalFields: {
      // Surfaced on the session so a guard is a field read, not a second query
      // on every write.
      role: { type: "string", input: false, defaultValue: "operator" },
    },
  },
  session: {
    // A dailies session is a working day, not a month. Short enough that a
    // forgotten laptop stops mattering, long enough not to interrupt a run.
    expiresIn: 60 * 60 * 12,
    updateAge: 60 * 60,
  },
  // BETTER_AUTH_SECRET signs the session cookie. Deliberately not defaulted:
  // a fallback secret would silently make every deployment forgeable, and the
  // failure would be invisible rather than loud.
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3210",
  // Origins allowed to post to the auth endpoints. Better Auth trusts only
  // baseURL by default, which rejects the Playwright server on 3211 with
  // INVALID_ORIGIN - a 403 that reads, from the form, exactly like a wrong
  // password. Listed explicitly rather than relaxed globally: the check is what
  // stops another site posting a sign-in on the operator's behalf.
  //
  // BETTER_AUTH_TRUSTED_ORIGINS is comma-separated, for a deployment served on a
  // different hostname than baseURL (a preview URL, or behind a proxy).
  trustedOrigins: [
    ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean) ??
      []),
    ...(process.env.NODE_ENV === "production"
      ? []
      : [
          "http://localhost:3210",
          "http://127.0.0.1:3210",
          // The reserved Playwright port. The suite signs in for real, so it
          // needs to be trusted for real.
          "http://localhost:3211",
          "http://127.0.0.1:3211",
        ]),
  ],
  // Must be last: lets server actions set cookies on sign-in and sign-out.
  plugins: [nextCookies()],
});

export type Session = typeof auth.$Infer.Session;

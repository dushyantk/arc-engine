import "./env";

import { test as setup, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { createLocalAccountIssuer } from "@better-auth/core/db";
import { user } from "@/db/schema";
import { auth } from "@/lib/auth";
import { E2E_OPERATOR_EMAIL, E2E_OPERATOR_PASSWORD, STORAGE_STATE, testDb } from "./fixtures";

// The dashboard is behind sign-in, so every other spec needs a session. This
// project runs first, makes a dedicated operator if one is missing, signs in
// through the real form, and saves the cookie for the rest of the suite.
//
// A dedicated account, never the real operator's: a password in a test file is a
// password on disk. This one is only ever valid against the local stack and is
// deleted in global teardown, the same way fixture shows are.
setup("sign in as the e2e operator", async ({ page }) => {
  const existing = await testDb
    .select()
    .from(user)
    .where(eq(user.email, E2E_OPERATOR_EMAIL))
    .limit(1);

  if (existing.length === 0) {
    // Same path as scripts/create-operator.ts, for the same reason: Better
    // Auth's own hashing and its own issuer, so what is written is what sign-in
    // verifies. signUpEmail is not available - the server disables sign-up.
    const ctx = await auth.$context;
    const created = await ctx.internalAdapter.createUser(
      { email: E2E_OPERATOR_EMAIL, name: "e2e", emailVerified: true },
      { method: "email-password" },
    );
    await ctx.internalAdapter.createAccount({
      userId: created.id,
      providerId: "credential",
      issuer: createLocalAccountIssuer("credential"),
      accountId: created.id,
      password: await ctx.password.hash(E2E_OPERATOR_PASSWORD),
    });
  }

  await page.goto("/login");
  await page.getByLabel(/email/i).fill(E2E_OPERATOR_EMAIL);
  await page.getByLabel(/password/i).fill(E2E_OPERATOR_PASSWORD);
  await page.getByRole("button", { name: /^Sign in$/ }).click();

  // Proves the session is real rather than that a redirect happened: the layout
  // only renders the operator's email once getSession() has returned a session.
  await expect(page.getByText(E2E_OPERATOR_EMAIL)).toBeVisible();

  await page.context().storageState({ path: STORAGE_STATE });
});

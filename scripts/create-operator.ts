/**
 * Creates the single operator account. The only path that can make one, because
 * lib/auth.ts sets `disableSignUp` — an open sign-up route on a deployment that
 * spends real money would look protected while being worse than nothing.
 *
 *   pnpm auth:create-operator you@example.com
 *
 * The password is read from stdin, never from argv: arguments land in shell
 * history and in the process list, where any other user on the machine can read
 * them.
 *
 * At a terminal it prompts twice and confirms. Piped, it takes the first line
 * and does not confirm — there is no second human to catch a typo, and asking a
 * pipe to repeat itself just hangs forever at EOF, which is exactly how this
 * was found:
 *
 *   printf '%s\n' "$PASSWORD" | pnpm auth:create-operator you@example.com
 */
import { createInterface } from "node:readline/promises";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { user } from "@/db/schema";
import { createLocalAccountIssuer } from "@better-auth/core/db";
import { auth } from "@/lib/auth";

/** Interactive when there is a human, single-shot when there is a pipe. */
async function readPassword(email: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const first = Buffer.concat(chunks).toString("utf8").split("\n")[0]?.trim() ?? "";
    if (!first) {
      console.error("No password on stdin.");
      process.exit(1);
    }
    return first;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const password = await rl.question(`Password for ${email}: `);
    const again = await rl.question("Again: ");
    if (password !== again) {
      console.error("Those did not match.");
      process.exit(1);
    }
    return password;
  } finally {
    rl.close();
  }
}

async function main() {
  const email = process.argv[2];
  if (!email || !email.includes("@")) {
    console.error("Usage: pnpm auth:create-operator <email>");
    process.exit(1);
  }

  if (!process.env.BETTER_AUTH_SECRET) {
    console.error(
      "BETTER_AUTH_SECRET is not set. Sessions signed without it would not\n" +
        "survive a restart and would be forgeable. Generate one with:\n" +
        "  openssl rand -base64 32",
    );
    process.exit(1);
  }

  const [existing] = await db.select().from(user).where(eq(user.email, email)).limit(1);
  if (existing) {
    console.error(`${email} already has an account. Nothing to do.`);
    process.exit(1);
  }

  const password = await readPassword(email);
  if (password.length < 12) {
    // Better Auth's own floor is lower. This one guards a button that spends
    // real money, so it is raised deliberately.
    console.error("Use at least 12 characters — this account can spend money.");
    process.exit(1);
  }

  // Not auth.api.signUpEmail: `disableSignUp` blocks that on the server too,
  // not only over HTTP — verified, having assumed otherwise first. This goes
  // through Better Auth's own internal adapter and its own password hashing, so
  // the credential is stored exactly the way sign-in will verify it. Hand-rolled
  // rows with a hand-rolled hash would be the thing that silently stops matching.
  const ctx = await auth.$context;
  const created = await ctx.internalAdapter.createUser(
    { email, name: email.split("@")[0], emailVerified: true },
    // How this account came to exist, recorded by Better Auth. It really is an
    // email-password account; it just was not created over HTTP.
    { method: "email-password" },
  );
  await ctx.internalAdapter.createAccount({
    userId: created.id,
    providerId: "credential",
    // Better Auth's own issuer for a local credential ("local:credential").
    // Imported rather than written out: sign-in looks the account up by this
    // exact value, so guessing it produces an account that exists and can never
    // be used — which is precisely what happened before this was checked.
    issuer: createLocalAccountIssuer("credential"),
    accountId: created.id,
    password: await ctx.password.hash(password),
  });

  console.log(`Created ${email}. There is no sign-up route; this is the only way in.`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);

import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

/**
 * The demo account can read everything and change nothing.
 *
 * RULE: every server action that writes, and every API route that spends money,
 * calls one of these first. Not "every action that looks dangerous" — every
 * action that writes. A gate with judgement in it gets judged around, and the
 * sign-in page publishes a working credential, so anything left unguarded is
 * reachable by anyone who reads it.
 *
 * The guard is a role check, not a list of blocked actions: a new action is
 * unguarded by default and `test_demo_guard` fails until it is wired, rather
 * than shipping a hole nobody notices.
 */

export class DemoAccountError extends Error {
  constructor(what: string) {
    super(
      `The demo account can read everything here but cannot ${what}. ` +
        "This instance makes real, billed generation calls and holds a real " +
        "approval record, so the published credential is read-only.",
    );
    this.name = "DemoAccountError";
  }
}

/** For server actions. Throws, which Next surfaces on the form that called it. */
export async function requireOperator(what: string): Promise<void> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    throw new Error("Not signed in.");
  }
  if (session.user.role !== "operator") {
    throw new DemoAccountError(what);
  }
}

/** For API routes. Returns the response to send, or null when allowed. */
export async function requireOperatorApi(what: string): Promise<NextResponse | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ detail: "Not signed in." }, { status: 401 });
  }
  if (session.user.role !== "operator") {
    return NextResponse.json({ detail: new DemoAccountError(what).message }, { status: 403 });
  }
  return null;
}

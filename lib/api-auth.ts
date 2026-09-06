import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

/**
 * Guard for every API route that proxies to the agent runtime or reads show data.
 *
 * RULE: every route handler under app/api/ except the auth handlers and
 * /api/media calls this first, and returns its value when it is not null. A
 * route without it is reachable by anyone who knows the path.
 *
 * This is not covered by the dashboard's sign-in. The middleware matcher and the
 * layout gate protect pages; these handlers are separate URLs the browser can
 * call directly. Found exactly that way: /api/runs/generate answered 200 to a
 * signed-out request and would have proxied a billed Veo call, while the
 * dashboard looked locked. The runtime's own token does not help — the proxy
 * holds it and would have attached it for anyone.
 *
 * Returns null when the caller is allowed, or the response to send when not.
 * A 401 with JSON, never a redirect: these are called by fetch(), and a 302 to
 * an HTML login page produces a parse error rather than a usable failure.
 *
 * Enforced by `e2e/api-auth.spec.ts`, which hits every one of these paths
 * signed out and requires a 401.
 */
export async function requireApiSession(): Promise<NextResponse | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (session) return null;
  return NextResponse.json(
    { detail: "Not signed in." },
    { status: 401 },
  );
}

import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Fast gate: cookie presence only, no database call. Deliberately not a real
 * session check — that would put a query in front of every asset request.
 *
 * The important rule here is what it does NOT do: it never redirects away from
 * /login on the strength of a cookie. That is the exact behaviour that caused a
 * redirect loop in an earlier project — the fast gate assumed a cookie meant
 * signed-in and bounced /login back to the app, while the real check in the
 * layout bounced the app back to /login, forever. The two checks are allowed to
 * disagree; only one of them is allowed to redirect toward the app, and it is
 * the one that actually reads the database.
 *
 * See app/dashboard/layout.tsx, which is the real gatekeeper.
 */
export function middleware(request: NextRequest) {
  if (getSessionCookie(request)) return NextResponse.next();

  // An API route is called by fetch(), so it gets a status it can read. A 302 to
  // an HTML login page would surface as a JSON parse error somewhere unrelated.
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ detail: "Not signed in." }, { status: 401 });
  }

  const login = new URL("/login", request.url);
  // So a signed-out deep link lands where it was going after sign-in.
  login.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(login);
}

export const config = {
  // The landing page stays public: it is the pitch, and it reads only the
  // aggregate decision log. Everything that can see or spend is matched here.
  //
  // The API entries are not redundant with the pages: these are separate URLs a
  // browser can call directly, and /api/runs/generate answered 200 signed-out
  // before they were added. This is the fast first line; lib/api-auth.ts does
  // the real check inside each handler, which is what catches a stale cookie.
  matcher: [
    "/dashboard/:path*",
    "/api/runs/:path*",
    "/api/export/:path*",
    // Streams a run's decisions and costs. Missed on the first pass because the
    // path contains "session" and a filter skipped it as auth machinery.
    "/api/sessions/:path*",
  ],
};

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";

/**
 * Clears a cookie whose session no longer exists, then sends the operator to
 * sign in.
 *
 * This is a route handler rather than logic in the layout because a server
 * component cannot set cookies — so a layout that merely redirects to /login
 * leaves the dead cookie in place, and the fast middleware check keeps seeing a
 * "signed in" browser on every subsequent request. Better Auth's own sign-out
 * clears the cookie unconditionally, including when the session row is already
 * gone, which is the property that makes this safe to reach in exactly the state
 * where the database disagrees with the browser.
 */
export async function GET() {
  try {
    await auth.api.signOut({ headers: await headers() });
  } catch {
    // Already impossible to sign out (no session to revoke) is the normal case
    // here, not an error. The cookie clearing is what matters and Better Auth
    // does it regardless; anything else must not stop the redirect.
  }
  redirect("/login?expired=1");
}

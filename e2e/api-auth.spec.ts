import { test, expect } from "@playwright/test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Every API route that proxies to the agent runtime or reads show data must
// refuse a signed-out caller.
//
// This is not covered by the dashboard's sign-in: these are separate URLs a
// browser can call directly. Found exactly that way — /api/runs/generate
// answered 200 to a signed-out request and would have proxied a billed Veo
// call, while the dashboard looked locked. The runtime's own shared token does
// not help, because the proxy holds it and attaches it for whoever asks.
//
// Runs with no storage state on purpose: `test.use({ storageState: undefined })`
// discards the suite's signed-in cookie, so these requests are genuinely
// anonymous.
test.use({ storageState: { cookies: [], origins: [] } });

/** Every route.ts under app/api, as a URL path. Discovered rather than listed,
 *  so a new route is covered the day it is added instead of the day someone
 *  remembers to add it here. */
function apiRoutes(dir = "app/api", prefix = "/api"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Dynamic segments get a throwaway value: the guard must fire before the
      // handler ever looks at the parameter.
      const segment = entry.startsWith("[") ? "e2e-nonexistent" : entry;
      out.push(...apiRoutes(full, `${prefix}/${segment}`));
    } else if (entry === "route.ts") {
      out.push(prefix);
    }
  }
  return out;
}

// Auth's own handlers must stay reachable — that is how anyone signs in.
// /api/media serves bytes for keys you already have to know. /api/expire-session
// exists precisely to be reached without a valid session: it clears a dead
// cookie. Anything else must refuse.
const PUBLIC = [/^\/api\/auth\b/, /^\/api\/media\b/, /^\/api\/expire-session$/];

const guarded = apiRoutes().filter((p) => !PUBLIC.some((re) => re.test(p)));

test("the scan finds the routes that spend money", () => {
  // Guards the guard: a traversal that found nothing would make every
  // assertion below pass while testing nothing at all.
  expect(guarded).toContain("/api/runs/generate");
  expect(guarded).toContain("/api/runs/budget");
  // Streams a run's decisions and costs. Named explicitly because it was the
  // one this spec caught that a hand-written list had missed.
  expect(guarded).toContain("/api/sessions/e2e-nonexistent/stream");
  expect(guarded.length).toBeGreaterThanOrEqual(10);
});

for (const path of guarded) {
  test(`${path} refuses a signed-out caller`, async ({ request }) => {
    const get = await request.get(path);
    expect(get.status(), `GET ${path} should be 401`).toBe(401);

    const post = await request.post(path, { data: {} });
    expect(post.status(), `POST ${path} should be 401`).toBe(401);
  });
}

test("the landing page stays public", async ({ request }) => {
  expect((await request.get("/")).status()).toBe(200);
});

test("the sign-in page stays reachable", async ({ request }) => {
  expect((await request.get("/login")).status()).toBe(200);
});

test("the dashboard redirects a signed-out browser to sign in", async ({ page }) => {
  await page.goto("/dashboard");
  expect(page.url()).toContain("/login");
});

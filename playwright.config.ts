import "./e2e/env";
import { defineConfig, devices } from "@playwright/test";
import { STORAGE_STATE } from "./e2e/fixtures";

// Port 3211 is reserved for exactly this in ~/dev/ports.md and
// docs/BUILD_PLAN.md. It is deliberately not 3210 — that is the dev server,
// and the suite must never be pointed at a server someone is working in.
const PORT = 3211;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  globalTeardown: "./e2e/global-teardown.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    // Signs in once and saves the cookie; everything else reuses it. Without
    // this every spec would have to sign in for itself, and the dashboard is
    // now behind auth.
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE },
      dependencies: ["setup"],
    },
  ],

  webServer: {
    // Production build, not `next dev`: the suite should exercise what ships,
    // and `next start` is also what makes the 3211/3210 split clean.
    command: `pnpm build && pnpm start:e2e`,
    url: BASE_URL,
    // `next start` runs as NODE_ENV=production, so lib/auth.ts's development
    // origin defaults do not apply and Better Auth trusts only BETTER_AUTH_URL -
    // which points at 3210, not this server. Passed explicitly rather than by
    // loosening the check: the origin test is what stops another site posting a
    // sign-in on the operator's behalf, and it should stay strict.
    env: {
      BETTER_AUTH_URL: BASE_URL,
      BETTER_AUTH_TRUSTED_ORIGINS: `${BASE_URL},http://localhost:${PORT}`,
    },
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});

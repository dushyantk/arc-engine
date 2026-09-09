import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The sign-in page publishes a working credential so a reviewer can look
// around. That makes every unguarded write reachable by anyone who reads it —
// including four that spend real money.
//
// These are static checks rather than browser ones on purpose: the guarantee is
// "no writing action exists without a guard", and only reading the source can
// say that. A behavioural test proves the actions it happens to click.

const ACTIONS = "lib/actions.ts";

/** Exported server actions, with the body of each. */
function serverActions(): { name: string; body: string }[] {
  const src = readFileSync(ACTIONS, "utf8");
  const out: { name: string; body: string }[] = [];
  const re = /export async function (\w+)\([^)]*\)[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // Body = from the opening brace to the next top-level export, which is
    // enough to see whether the guard is the first thing it does.
    const start = m.index + m[0].length;
    const next = src.indexOf("\nexport ", start);
    out.push({ name: m[1], body: src.slice(start, next === -1 ? src.length : next) });
  }
  return out;
}

test("the scan finds the actions that write", () => {
  // Guards the guard: a regex that matched nothing would make every assertion
  // below pass while checking nothing.
  const names = serverActions().map((a) => a.name);
  expect(names).toContain("submitHumanApproval");
  expect(names).toContain("generateAssetSheets");
  expect(names.length).toBeGreaterThanOrEqual(12);
});

for (const action of serverActions()) {
  test(`${action.name} refuses the demo account`, () => {
    expect(
      action.body.includes("requireOperator("),
      `${action.name} in ${ACTIONS} writes without calling requireOperator(). ` +
        "The sign-in page publishes a working credential, so this is reachable " +
        "by anyone who reads it.",
    ).toBeTruthy();
  });
}

test("every billed API route refuses the demo account", () => {
  const billed = ["generate", "reuse-prompt", "recritique", "extract-fingerprint", "sequence-continuity"];
  for (const name of billed) {
    const src = readFileSync(join("app/api/runs", name, "route.ts"), "utf8");
    expect(src.includes("requireOperatorApi("), `app/api/runs/${name} is not role-guarded`).toBeTruthy();
  }
});

test("read-only routes are deliberately not role-guarded", () => {
  // Stated so that "why is /budget different?" has an answer in the suite
  // rather than looking like an omission.
  for (const name of ["budget", "models", "pricing", "status"]) {
    const src = readFileSync(join("app/api/runs", name, "route.ts"), "utf8");
    expect(src.includes("requireApiSession("), `${name} must still require a session`).toBeTruthy();
    expect(src.includes("requireOperatorApi("), `${name} reads only; it should not need operator`).toBeFalsy();
  }
});

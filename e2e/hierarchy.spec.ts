import {
  enforceReadOnly,
  expect,
  findNavigableProductionShot,
  test,
} from "./fixtures";

// Shows list → show → sequence → shot detail, walked over the real production
// data already in the local stack.
//
// This is the one spec that touches rows it did not create, so it runs under
// enforceReadOnly(): every non-GET request is aborted at the browser, which
// makes a server-action submit impossible rather than merely unlikely. Nothing
// here clicks a control that writes.
//
// The target show/sequence/shot is resolved from the database instead of being
// hard-coded, so each assertion compares the rendered page against the actual
// row it is rendering — a stronger check than matching a string literal, and it
// does not rot when the local data changes.

type Navigable = NonNullable<Awaited<ReturnType<typeof findNavigableProductionShot>>>;

let target: Navigable;

test.beforeAll(async () => {
  const found = await findNavigableProductionShot();
  expect(
    found,
    "No non-fixture show with a sequence, a shot and at least one version was found in " +
      "the local Postgres. This spec navigates existing production data; seed the stack first.",
  ).not.toBeNull();
  target = found!;
});

test.beforeEach(async ({ page }) => {
  await enforceReadOnly(page);
});

test("shows list renders every show with its real sequence and shot counts", async ({
  page,
}) => {
  await page.goto("/dashboard");

  await expect(page.getByRole("heading", { name: "Shows", level: 1 })).toBeVisible();

  const showLink = page.locator(`a[href="/dashboard/${target.show.id}"]`);
  await expect(showLink).toHaveCount(1);
  await expect(showLink).toContainText(target.show.name);

  const shotCount = target.shots.length;
  await expect(showLink).toContainText(
    `${target.sequenceCount} sequence${target.sequenceCount === 1 ? "" : "s"}`,
  );
  await expect(showLink).toContainText(`${shotCount} shot${shotCount === 1 ? "" : "s"}`);
});

test("show page lists its sequences and its reference assets", async ({ page }) => {
  await page.goto("/dashboard");
  await page.locator(`a[href="/dashboard/${target.show.id}"]`).click();

  await expect(page).toHaveURL(`/dashboard/${target.show.id}`);
  await expect(
    page.getByRole("heading", { name: target.show.name, level: 1 }),
  ).toBeVisible();

  const sequenceLink = page.locator(
    `a[href="/dashboard/${target.show.id}/${target.sequence.code}"]`,
  );
  await expect(sequenceLink).toHaveCount(1);
  await expect(sequenceLink).toContainText(target.sequence.code);

  // References are show-scoped; the page must render exactly the rows this show
  // owns, with each one's lock state legible.
  const cards = page.getByTestId("reference-card");
  await expect(cards).toHaveCount(target.references.length);
  for (const reference of target.references) {
    const card = page.locator(
      `[data-testid="reference-card"][data-reference-name="${reference.name}"]`,
    );
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(reference.lockedAt ? "Locked" : "Unlocked");
    if (!reference.lockedAt) {
      await expect(card).toContainText("NOT IN CANON");
    }
  }
});

test("sequence page renders a card per shot with its status badge", async ({ page }) => {
  const sequencePath = `/dashboard/${target.show.id}/${target.sequence.code}`;
  await page.goto(sequencePath);

  await expect(
    page.getByRole("heading", { name: target.sequence.code, level: 1 }),
  ).toBeVisible();

  const approvedCount = target.shots.filter((s) => s.status === "approved").length;
  await expect(
    page.getByText(`${approvedCount} / ${target.shots.length} approved`, { exact: true }),
  ).toBeVisible();

  const statusLabels: Record<string, string> = {
    pending: "Pending",
    generating: "Generating",
    reviewing: "Reviewing",
    revise: "Revise",
    approved: "Approved",
    needs_human: "Needs human",
  };

  for (const shot of target.shots) {
    // Scoped by href: shot cards repeat the same structure, and matching on
    // text alone is how a selector ends up on the wrong card.
    const card = page.locator(`a[href="${sequencePath}/${shot.code}"]`);
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(shot.code);
    await expect(card).toContainText(statusLabels[shot.status]);
  }
});

test("shot detail renders the full version history for the shot", async ({ page }) => {
  const sequencePath = `/dashboard/${target.show.id}/${target.sequence.code}`;
  await page.goto(sequencePath);
  await page.locator(`a[href="${sequencePath}/${target.shot.code}"]`).click();

  await expect(page).toHaveURL(`${sequencePath}/${target.shot.code}`);
  await expect(
    page.getByRole("heading", { name: target.shot.code, level: 1 }),
  ).toBeVisible();

  const versionCards = page.getByTestId("version-card");
  await expect(versionCards).toHaveCount(target.versions.length);

  for (const version of target.versions) {
    const card = page.locator(
      `[data-testid="version-card"][data-version-number="${version.versionNumber}"]`,
    );
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(`v${String(version.versionNumber).padStart(3, "0")}`);
    await expect(card).toContainText("Generation prompt");
    await expect(card).toContainText(version.generationPrompt.slice(0, 40));
  }

  // The export surface is reachable from here — asserted as a link only; the
  // export flow itself is driven against a fixture shot, not this one.
  await expect(
    page.getByRole("link", { name: /^Export/ }),
  ).toHaveAttribute("href", `${sequencePath}/${target.shot.code}/export`);
});

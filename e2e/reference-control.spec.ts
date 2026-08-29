import path from "node:path";
import {
  expect,
  minioObjectExists,
  readShowReferences,
  test,
} from "./fixtures";

// Reference control is a real operator verb with a real consequence: locked
// references are the canon a run is conditioned on, and unlocking takes an image
// out of that set. This drives upload → locked → unlocked → re-locked on a
// fixture show of this test's own making.
//
// Every selector is scoped to the one card this test created. The card's own
// Lock/Unlock control is identical on every card on the page, which is precisely
// the ambiguity that makes an unscoped selector dangerous here.

const UPLOAD_FIXTURE = path.join(process.cwd(), "public", "proof", "hero.jpg");

test("uploads a reference locked as canon, unlocks it, and re-locks it", async ({
  page,
  seededShow,
}) => {
  const referenceName = `E2E platform plate ${seededShow.showId.slice(0, 8)}`;
  const expectedSlug = referenceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const expectedKey = `refs/${seededShow.showId}/${expectedSlug}.jpg`;

  await page.goto(`/dashboard/${seededShow.showId}`);
  await expect(
    page.getByRole("heading", { name: seededShow.showName, level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("No reference images yet.")).toBeVisible();

  // --- upload ---------------------------------------------------------------
  await page.getByRole("button", { name: "Add reference" }).click();

  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(referenceName);
  await dialog.getByLabel("Type").selectOption("environment");
  await dialog.getByLabel("Image").setInputFiles(UPLOAD_FIXTURE);
  await dialog.getByRole("button", { name: "Upload and lock" }).click();

  const card = page.locator(
    `[data-testid="reference-card"][data-reference-name="${referenceName}"]`,
  );
  await expect(card).toHaveCount(1);
  // Nothing but this test's own reference can be on this show's page.
  await expect(page.getByTestId("reference-card")).toHaveCount(1);

  // --- locked as canon on upload -------------------------------------------
  await expect(card).toContainText(referenceName);
  await expect(card).toContainText("environment");
  await expect(card).toContainText("Locked");
  await expect(card).toContainText("operator");
  await expect(card).not.toContainText("NOT IN CANON");
  await expect(card.getByRole("button", { name: "Unlock" })).toBeVisible();

  const uploaded = await readShowReferences(seededShow.showId);
  expect(uploaded).toHaveLength(1);
  expect(uploaded[0].name).toBe(referenceName);
  expect(uploaded[0].type).toBe("environment");
  expect(uploaded[0].imageUrl).toBe(expectedKey);
  expect(uploaded[0].lockedAt).not.toBeNull();
  expect(uploaded[0].approvedBy).toBe("operator");
  expect(await minioObjectExists(expectedKey)).toBe(true);

  // --- unlock: out of canon, and the UI has to say so ----------------------
  await card.getByRole("button", { name: "Unlock" }).click();

  await expect(card).toContainText("NOT IN CANON");
  await expect(card).toContainText("Unlocked");
  await expect(card).toContainText("Not used by any run while unlocked");
  await expect(card.getByRole("button", { name: "Lock as canon" })).toBeVisible();

  const unlocked = await readShowReferences(seededShow.showId);
  expect(unlocked).toHaveLength(1);
  expect(unlocked[0].lockedAt).toBeNull();
  expect(unlocked[0].approvedBy).toBeNull();
  // Unlocking takes an image out of canon without deleting its lineage.
  expect(await minioObjectExists(expectedKey)).toBe(true);

  // --- re-lock --------------------------------------------------------------
  await card.getByRole("button", { name: "Lock as canon" }).click();

  await expect(card).toContainText("Locked");
  await expect(card).not.toContainText("NOT IN CANON");
  await expect(card.getByRole("button", { name: "Unlock" })).toBeVisible();

  const relocked = await readShowReferences(seededShow.showId);
  expect(relocked).toHaveLength(1);
  expect(relocked[0].lockedAt).not.toBeNull();
  expect(relocked[0].approvedBy).toBe("operator");
});

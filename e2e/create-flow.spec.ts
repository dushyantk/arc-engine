import {
  expect,
  findSequence,
  findShot,
  test,
  testDb,
} from "./fixtures";
import { shows } from "@/db/schema";
import { eq } from "drizzle-orm";

// Show → sequence → shot, created through the actual UI forms rather than
// seeded. This is the spec that proves the create path works end to end, and it
// is also the shape every other fixture leans on.
//
// The show name comes from the `showName` fixture, so whatever this test
// creates through the browser is still torn down by name afterwards.

test("creates a show, a sequence and a shot through the dashboard forms", async ({
  page,
  showName,
}) => {
  // --- show -----------------------------------------------------------------
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "New show" }).click();

  const showDialog = page.getByRole("dialog");
  await expect(showDialog.getByText("New show")).toBeVisible();
  await showDialog.getByLabel("Name").fill(showName);
  await showDialog.getByRole("button", { name: "Create show" }).click();

  await expect(page).toHaveURL(
    /\/dashboard\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  await expect(page.getByRole("heading", { name: showName, level: 1 })).toBeVisible();
  await expect(page.getByText("No sequences yet.")).toBeVisible();

  const showId = new URL(page.url()).pathname.split("/").pop()!;
  const [showRow] = await testDb.select().from(shows).where(eq(shows.id, showId));
  expect(showRow?.name).toBe(showName);

  // --- sequence -------------------------------------------------------------
  await page.getByRole("button", { name: "New sequence" }).click();

  const sequenceDialog = page.getByRole("dialog");
  await sequenceDialog.getByLabel("Code").fill("SQ010");
  await sequenceDialog
    .getByLabel("Description")
    .fill("Hero crosses the concourse and drops onto the platform.");
  await sequenceDialog.getByRole("button", { name: "Create sequence" }).click();

  await expect(page).toHaveURL(`/dashboard/${showId}/SQ010`);
  await expect(page.getByRole("heading", { name: "SQ010", level: 1 })).toBeVisible();
  await expect(
    page.getByText("Hero crosses the concourse and drops onto the platform."),
  ).toBeVisible();
  await expect(page.getByText("0 / 0 approved", { exact: true })).toBeVisible();
  await expect(page.getByText("No shots yet.")).toBeVisible();

  const sequenceRow = await findSequence(showId, "SQ010");
  expect(sequenceRow).not.toBeNull();
  expect(sequenceRow!.status).toBe("pending");

  // --- shot -----------------------------------------------------------------
  await page.getByRole("button", { name: "New shot" }).click();

  const shotDialog = page.getByRole("dialog");
  await shotDialog.getByLabel("Code").fill("SH010");
  await shotDialog.getByLabel("Order index").fill("1");
  await shotDialog
    .getByLabel("Screen direction")
    .selectOption("L_TO_R");
  await shotDialog.getByRole("button", { name: "Create shot" }).click();

  await expect(page).toHaveURL(`/dashboard/${showId}/SQ010`);

  const shotCard = page.locator(`a[href="/dashboard/${showId}/SQ010/SH010"]`);
  await expect(shotCard).toHaveCount(1);
  await expect(shotCard).toContainText("SH010");
  await expect(shotCard).toContainText("Pending");
  await expect(shotCard).toContainText("0 versions");
  await expect(shotCard).toContainText("No footage generated yet");
  await expect(page.getByText("0 / 1 approved", { exact: true })).toBeVisible();

  const shotRow = await findShot(sequenceRow!.id, "SH010");
  expect(shotRow).not.toBeNull();
  expect(shotRow!.status).toBe("pending");
  expect(shotRow!.orderIndex).toBe(1);
  expect(shotRow!.screenDirection).toBe("L_TO_R");

  // --- the new shot's detail page ------------------------------------------
  await shotCard.click();
  await expect(page).toHaveURL(`/dashboard/${showId}/SQ010/SH010`);
  await expect(page.getByRole("heading", { name: "SH010", level: 1 })).toBeVisible();
  await expect(page.getByText("Screen direction: L_TO_R")).toBeVisible();
  await expect(page.getByTestId("shot-status")).toHaveText(/Pending/);
  // A shot only gets a version from a run, so a freshly created one has none.
  await expect(page.getByTestId("version-card")).toHaveCount(0);
});

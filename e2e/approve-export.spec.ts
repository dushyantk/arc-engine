import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import {
  expect,
  readApprovalEvents,
  readShot,
  readVersion,
  seedVersion,
  test,
} from "./fixtures";

// The happy path docs/BUILD_PLAN.md Phase 5 names: shot detail → human approve
// → export. A version can only be produced by a run and runs cost money, so the
// fixture version is inserted directly (see seedVersion's contract) and
// everything after that is driven through the UI.

const APPROVAL_REASON =
  "Platform geometry and sodium key match the locked plate; screen direction holds.";

async function runtimeIsReachable(): Promise<boolean> {
  const base = process.env.AGENT_RUNTIME_URL ?? "http://localhost:8091";
  try {
    await fetch(base, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

test("human-approves a version, then exports a package containing the real tree", async ({
  page,
  seededShot,
}, testInfo) => {
  const version = await seedVersion(seededShot.shotId, {
    versionNumber: 1,
    briefUsed: seededShot.brief,
  });

  // submitHumanApproval best-effort calls the FastAPI runtime for fingerprint
  // extraction and swallows failures, so the approval has to land with the
  // runtime down. Recorded either way, and asserted below by the approval
  // actually landing.
  const runtimeUp = await runtimeIsReachable();
  testInfo.annotations.push({
    type: "agent-runtime",
    description: runtimeUp
      ? "reachable — approval still asserted, fingerprint extraction rejected 400 (no generation_settings)"
      : "unreachable — proves submitHumanApproval swallows the failure and the approval still lands",
  });

  // --- shot detail before the decision --------------------------------------
  await page.goto(seededShot.shotPath);
  await expect(
    page.getByRole("heading", { name: seededShot.shotCode, level: 1 }),
  ).toBeVisible();
  await expect(page.getByTestId("shot-status")).toHaveText(/Needs human/);

  const versionCard = page.locator(
    `[data-testid="version-card"][data-version-number="${version.versionNumber}"]`,
  );
  await expect(versionCard).toHaveCount(1);
  await expect(versionCard).toContainText("v001");
  await expect(versionCard).toContainText("Candidate");

  // --- human approval -------------------------------------------------------
  // Scoped to the one version card under test. An unscoped `.first()` here is
  // exactly how a control gets clicked on a card nobody meant to touch.
  await versionCard.getByRole("button", { name: "Human review" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Human review — v001")).toBeVisible();
  await dialog.getByText("Approve", { exact: true }).click();
  await dialog.getByRole("textbox").fill(APPROVAL_REASON);
  await dialog.getByRole("button", { name: "Submit decision" }).click();

  // --- the shot now reads approved, in the UI and in Postgres ---------------
  await expect(page.getByTestId("shot-status")).toHaveText(/Approved/);
  await expect(versionCard).toContainText("Approved");
  await expect(versionCard).toContainText(APPROVAL_REASON);
  await expect(versionCard).toContainText("human");

  const shotRow = await readShot(seededShot.shotId);
  expect(shotRow?.status).toBe("approved");
  const versionRow = await readVersion(version.versionId);
  expect(versionRow?.status).toBe("approved");

  const events = await readApprovalEvents(seededShot.shotId);
  expect(events).toHaveLength(1);
  expect(events[0].actor).toBe("human");
  expect(events[0].decision).toBe("approved");
  expect(events[0].reason).toBe(APPROVAL_REASON);
  expect(events[0].shotVersionId).toBe(version.versionId);

  // --- export page ----------------------------------------------------------
  await page.getByRole("link", { name: /^Export/ }).click();
  await expect(page).toHaveURL(`${seededShot.shotPath}/export`);
  await expect(
    page.getByRole("heading", { name: "VFX handoff package", level: 1 }),
  ).toBeVisible();

  // lib/export.ts reports hasVideoBytes:false for a version with no stored
  // footage rather than failing — confirmed here rather than assumed.
  await expect(
    page.getByText(/is approved, but no video bytes are stored for it/),
  ).toBeVisible();

  const tree = page.getByText("Package tree").locator("xpath=following-sibling::div[1]");
  for (const row of [
    `${seededShot.shotCode}/`,
    "gen/",
    "refs/",
    "metadata/",
    "manifest.json",
    "generation.json",
    "provenance.json",
    "qc.json",
    "notes.json",
    `${seededShot.shotCode}_comp.nk`,
  ]) {
    await expect(tree).toContainText(row);
  }

  // --- download the package and read what is actually inside it -------------
  // The control is an <a href> rendered through Base UI's Button with
  // nativeButton={false}, so it exposes role=button while still navigating.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /Download \.zip/ }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(`${seededShot.shotCode}_export.zip`);

  const downloadPath = await download.path();
  const zip = await JSZip.loadAsync(await readFile(downloadPath));
  const entries = Object.keys(zip.files).sort();

  const root = seededShot.shotCode;
  expect(entries).toEqual(
    expect.arrayContaining([
      `${root}/plate/`,
      `${root}/gen/`,
      `${root}/refs/`,
      `${root}/metadata/`,
      `${root}/metadata/manifest.json`,
      `${root}/metadata/generation.json`,
      `${root}/metadata/provenance.json`,
      `${root}/metadata/qc.json`,
      `${root}/metadata/notes.json`,
      `${root}/${root}_comp.nk`,
    ]),
  );

  const manifest = JSON.parse(
    await zip.file(`${root}/metadata/manifest.json`)!.async("string"),
  );
  expect(manifest.shot).toBe(seededShot.shotCode);
  expect(manifest.sequence).toBe(seededShot.sequenceCode);
  expect(manifest.show).toBe(seededShot.showName);
  expect(manifest.contents.gen).toEqual([]);
  expect(manifest.contents.refs).toEqual([]);
  expect(manifest.contents.nukeScript).toBe(`${root}_comp.nk`);
  expect(manifest.contents.metadata).toEqual([
    "manifest.json",
    "generation.json",
    "provenance.json",
    "qc.json",
    "notes.json",
  ]);

  const generation = JSON.parse(
    await zip.file(`${root}/metadata/generation.json`)!.async("string"),
  );
  expect(generation.version).toBe(version.versionNumber);
  expect(generation.hasStoredVideo).toBe(false);
  expect(generation.prompt).toEqual(expect.any(String));

  // The approval this test just made is what ends up in the handoff — that is
  // the whole point of the package carrying notes.json.
  const notes = JSON.parse(await zip.file(`${root}/metadata/notes.json`)!.async("string"));
  expect(notes.approvalEvents).toHaveLength(1);
  expect(notes.approvalEvents[0]).toMatchObject({
    actor: "human",
    decision: "approved",
    reason: APPROVAL_REASON,
  });

  const nukeScript = await zip.file(`${root}/${root}_comp.nk`)!.async("string");
  expect(nukeScript).toContain(seededShot.shotCode);
});

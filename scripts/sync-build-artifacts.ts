/**
 * Publishes the build record — generations/LEDGER.md and the preserved
 * generations and diagnostic frames — into MinIO under `build-artifacts/`,
 * mirroring the on-disk layout.
 *
 * `generations/` is gitignored on purpose: real generated video does not belong
 * in git history. That leaves the ledger page with nothing to read on any
 * checkout but the machine that produced the footage, so the artefacts get an
 * object-store home and the page reads from there. The page therefore shows the
 * last sync, not the working directory — re-run this after adding to the ledger.
 *
 *   pnpm ledger:sync              upload anything new or changed
 *   pnpm ledger:sync --dry-run    list what would be uploaded
 *   pnpm ledger:sync --force      re-upload everything
 */
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { getMinioClient, MINIO_BUCKET } from "../lib/minio";

const SOURCE_DIR = join(process.cwd(), "generations");
const PREFIX = "build-artifacts";

const CONTENT_TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function contentTypeFor(path: string) {
  const dot = path.lastIndexOf(".");
  return CONTENT_TYPES[path.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");

  try {
    await stat(SOURCE_DIR);
  } catch {
    console.error(
      `No generations/ directory here. This syncs the build record from the machine\n` +
        `that produced the footage; there is nothing to publish from a fresh checkout.`,
    );
    process.exit(1);
  }

  const client = getMinioClient();
  if (!(await client.bucketExists(MINIO_BUCKET))) {
    await client.makeBucket(MINIO_BUCKET);
  }

  let uploaded = 0;
  let skipped = 0;
  let bytes = 0;

  for await (const path of walk(SOURCE_DIR)) {
    const key = `${PREFIX}/${relative(SOURCE_DIR, path).split(sep).join("/")}`;
    const body = await readFile(path);
    const etag = createHash("md5").update(body).digest("hex");

    if (!force) {
      // MinIO's ETag is the MD5 for a single-part upload, so an unchanged file
      // is recognisable without re-sending 9MB of video every run.
      try {
        const existing = await client.statObject(MINIO_BUCKET, key);
        if (existing.etag?.replace(/"/g, "") === etag) {
          skipped++;
          continue;
        }
      } catch {
        // Not there yet - fall through and upload.
      }
    }

    if (dryRun) {
      console.log(`  would upload  ${key}  (${body.length.toLocaleString()} bytes)`);
    } else {
      await client.putObject(MINIO_BUCKET, key, body, body.length, {
        "Content-Type": contentTypeFor(path),
      });
      console.log(`  uploaded      ${key}  (${body.length.toLocaleString()} bytes)`);
    }
    uploaded++;
    bytes += body.length;
  }

  const verb = dryRun ? "would upload" : "uploaded";
  console.log(
    `\n${verb} ${uploaded} file(s), ${(bytes / 1024 / 1024).toFixed(1)}MB; ` +
      `${skipped} already current.`,
  );
  process.exit(0);
}

main();

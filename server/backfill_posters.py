"""Extracts a poster still for every shot version that already has footage but
no poster, and writes it back to MinIO and Postgres.

Every version generated before posters existed has real video in object storage
and nothing to show for it in a grid. Costs nothing - it reads footage that is
already paid for and runs ffmpeg locally. No model calls, no Veo.

    uv run --directory server python backfill_posters.py [--dry-run]
"""

import argparse
import asyncio
import os

from db.postgres import Database
from storage.minio_client import get_bytes, get_client, put_bytes
from video_frames import extract_poster_frame


def poster_key_for(video_key: str) -> str:
    """gen/SH020/v005.mp4 -> gen/SH020/v005.jpg"""
    return video_key.rsplit(".", 1)[0] + ".jpg"


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="list what would be backfilled without writing anything",
    )
    args = parser.parse_args()

    db = Database()
    await db.connect()
    minio_client = get_client()
    bucket = os.environ.get("MINIO_BUCKET", "dailies")

    rows = await db.pool.fetch(
        """
        SELECT v.id, v.version_number, v.video_asset_url, s.code AS shot_code
        FROM shot_versions v
        JOIN shots s ON s.id = v.shot_id
        WHERE v.video_asset_url IS NOT NULL
          AND v.video_asset_url <> ''
          AND v.poster_asset_url IS NULL
        ORDER BY s.code, v.version_number
        """
    )

    if not rows:
        print("nothing to backfill: every version with footage already has a poster.")
        await db.close()
        return 0

    print(f"{len(rows)} version(s) with footage and no poster:")
    done = 0
    missing = 0
    failed = 0

    for row in rows:
        label = f"{row['shot_code']} v{row['version_number']}"
        video_key = row["video_asset_url"]

        try:
            video_bytes = get_bytes(minio_client, bucket, video_key)
        except Exception as exc:  # noqa: BLE001 - report and continue over the batch
            # A row pointing at bytes that were never uploaded is real, known
            # state in this database, not a crash: say so and move on.
            print(f"  {label:<12} SKIP  no bytes behind {video_key} ({type(exc).__name__})")
            missing += 1
            continue

        if args.dry_run:
            print(f"  {label:<12} would extract from {video_key} ({len(video_bytes):,} bytes)")
            done += 1
            continue

        try:
            poster_bytes = await extract_poster_frame(video_bytes)
        except RuntimeError as exc:
            print(f"  {label:<12} FAIL  {exc}")
            failed += 1
            continue

        key = poster_key_for(video_key)
        put_bytes(minio_client, bucket, key, poster_bytes, content_type="image/jpeg")
        await db.set_shot_version_poster(row["id"], key)
        print(f"  {label:<12} ok    {key} ({len(poster_bytes):,} bytes)")
        done += 1

    verb = "would backfill" if args.dry_run else "backfilled"
    print(f"\n{verb} {done}; skipped {missing} with no bytes; {failed} failed.")
    await db.close()
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

"""CLI entry point: run one plan -> generate -> critique -> approve cycle for
a shot, against the real local stack. This is Phase 2's exit criteria —
"run the seeded sequence through the full loop from the command line" needs
no UI to be real.

Runs exactly one generation attempt per invocation — Veo calls cost real
money, so this does not silently loop on a revise/needs_human outcome.
Re-run for another attempt.

--recritique-version N re-evaluates an EXISTING shot version instead of
generating a new one: no Veo call, no new shot_versions row, no duplicate
MinIO object. Use it to iterate on the critic/approval logic without
polluting the real version history with fake generations that are actually
just the same footage re-copied under a new version number — that
happened once (see git history on this file) and had to be cleaned up by
hand. Defaults to reading the version's video from MinIO; --video-override
points it at a local file instead (e.g. while iterating before deciding
whether a fix is worth re-running the critic against real storage).

Usage: uv run --directory server python run_session.py --shot SH020 --goal "..."
       uv run --directory server python run_session.py --shot SH020 --recritique-version 3
"""

import argparse
import asyncio
import os
import sys
from pathlib import Path
from uuid import UUID

from agents.approval import evaluate
from agents.critic import critique_shot_version
from agents.decision_log import new_run_id
from agents.generation import generate_shot_version
from agents.planner import plan_shot
from agents.revision import revise_shot
from db.models import ReferenceAsset, Shot
from db.postgres import Database
from models.contracts import QCFinding, ShotStatus
from storage.minio_client import get_bytes, get_client, put_bytes


async def _load_show_shot(db: Database, shot_code: str) -> tuple[Shot, str, str, list[ReferenceAsset]]:
    show_row = await db.pool.fetchrow("SELECT * FROM shows WHERE name = 'Platform Chase'")
    if show_row is None:
        raise SystemExit("Seed data not found — run `pnpm db:seed` first.")
    show = await db.get_show(show_row["id"])

    seq_row = await db.pool.fetchrow("SELECT id FROM sequences WHERE show_id = $1", show.id)
    sequence = await db.get_sequence(seq_row["id"])

    shots = await db.get_shots_for_sequence(sequence.id)
    shot = next((s for s in shots if s.code == shot_code), None)
    if shot is None:
        raise SystemExit(f"Shot {shot_code} not found in {sequence.code}")

    reference_assets = await db.get_reference_assets(show.id)
    return shot, show.name, sequence.code, reference_assets


async def _apply_result(
    db: Database,
    shot: Shot,
    shot_version_id: UUID,
    version_number: int,
    findings: list[QCFinding],
    run_id: str,
) -> ShotStatus:
    for f in findings:
        print(f"  [{f.severity}/{f.verdict}] {f.category}: {f.description}")

    status = evaluate(findings, version_number, run_id=run_id, shot_code=shot.code)
    print(f"result: {status}")

    version_status = "approved" if status == "approved" else "failed"
    await db.update_shot_version_status(shot_version_id, version_status)
    await db.update_shot_status(shot.id, status)
    await db.insert_approval_event(
        shot_id=shot.id,
        shot_version_id=shot_version_id,
        actor="agent",
        decision=status,
        reason="; ".join(f.description for f in findings if f.verdict == "fail") or None,
    )

    return status


async def recritique(shot_code: str, version_number: int, video_override: Path | None) -> None:
    """Re-evaluates an existing shot version. No Veo call, no new version."""
    db = Database()
    await db.connect()

    shot, _, _, reference_assets = await _load_show_shot(db, shot_code)
    versions = await db.get_shot_versions(shot.id)
    target = next((v for v in versions if v.version_number == version_number), None)
    if target is None:
        raise SystemExit(f"{shot_code} has no v{version_number}")

    if video_override is not None:
        video_bytes = video_override.read_bytes()
    else:
        minio_client = get_client()
        bucket = os.environ.get("MINIO_BUCKET", "dailies")
        assert target.video_asset_url is not None
        video_bytes = get_bytes(minio_client, bucket, target.video_asset_url)
    print(f"re-critiquing {shot_code} v{version_number} ({len(video_bytes)} bytes)...")

    run_id = new_run_id()
    print(f"run_id={run_id}")

    continuity_context = (
        "Original generation prompt for this version (encodes what it needed to preserve):\n"
        f"{target.generation_prompt}"
    )
    findings = await critique_shot_version(
        video_bytes=video_bytes,
        video_mime_type="video/mp4",
        reference_assets=reference_assets,
        reference_images={},
        continuity_context=continuity_context,
        run_id=run_id,
        shot_version_ref=f"{shot_code}:v{version_number}:recritique",
    )
    status = await _apply_result(db, shot, target.id, version_number, findings, run_id)

    if status in ("revise", "needs_human"):
        print("revising (instruction only, not re-generating)...")
        instruction = await revise_shot(
            shot_code=shot_code,
            prior_version=version_number,
            prior_prompt=target.generation_prompt,
            findings=findings,
            reference_assets=reference_assets,
            run_id=run_id,
        )
        print(f"next attempt should target v{instruction.target_version}:")
        print(f"  {instruction.revised_prompt[:200]}...")

    await db.close()


async def run(shot_code: str, scene_goal: str) -> None:
    """Plans, generates (real Veo call), stores, and critiques a brand new version."""
    db = Database()
    await db.connect()

    shot, show_name, sequence_code, reference_assets = await _load_show_shot(db, shot_code)
    existing_versions = await db.get_shot_versions(shot.id)
    next_version = max((v.version_number for v in existing_versions), default=0) + 1

    run_id = new_run_id()
    print(f"run_id={run_id}")
    print(f"planning {shot_code} v{next_version}...")

    brief = await plan_shot(
        show_name=show_name,
        sequence_code=sequence_code,
        shot=shot,
        scene_goal=scene_goal,
        reference_assets=reference_assets,
        run_id=run_id,
    )
    print(f"brief ready. prompt: {brief.prompt[:120]}...")

    # No real reference photography available yet (seeded refs are rows only,
    # no uploaded bytes) — this falls back to text-only generation. See
    # BUILD_PLAN.md Phase 2 for the follow-up (extract stills from an
    # approved shot as real image references).
    print(f"generating with {brief.generation_settings.model} (this takes a few minutes)...")
    video_bytes = await generate_shot_version(brief=brief, reference_images={}, run_id=run_id)
    print(f"video ready: {len(video_bytes)} bytes.")

    minio_client = get_client()
    bucket = os.environ.get("MINIO_BUCKET", "dailies")
    video_key = f"gen/{shot_code}/v{next_version:03d}.mp4"
    put_bytes(minio_client, bucket, video_key, video_bytes, content_type="video/mp4")
    print(f"stored at {bucket}/{video_key}")

    shot_version = await db.insert_shot_version(
        shot_id=shot.id,
        version_number=next_version,
        generation_prompt=brief.prompt,
        generation_settings=brief.generation_settings.model_dump(),
        video_asset_url=video_key,
        status="candidate",
    )

    print("critiquing...")
    continuity_context = "Invariants this shot must preserve:\n" + "\n".join(
        f"- {i}" for i in brief.invariants
    )
    findings = await critique_shot_version(
        video_bytes=video_bytes,
        video_mime_type="video/mp4",
        reference_assets=reference_assets,
        reference_images={},
        continuity_context=continuity_context,
        run_id=run_id,
        shot_version_ref=f"{shot_code}:v{next_version}",
    )
    status = await _apply_result(db, shot, shot_version.id, next_version, findings, run_id)

    if status in ("revise", "needs_human"):
        print("revising (instruction only, not re-generating)...")
        instruction = await revise_shot(
            shot_code=shot_code,
            prior_version=next_version,
            prior_prompt=brief.prompt,
            findings=findings,
            reference_assets=reference_assets,
            run_id=run_id,
        )
        print(f"next attempt should target v{instruction.target_version}:")
        print(f"  {instruction.revised_prompt[:200]}...")

    await db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--shot", required=True)
    parser.add_argument("--goal", help="Required unless --recritique-version is given.")
    parser.add_argument("--recritique-version", type=int, default=None)
    parser.add_argument("--video-override", type=Path, default=None)
    args = parser.parse_args()

    if args.recritique_version is not None:
        asyncio.run(recritique(args.shot, args.recritique_version, args.video_override))
    else:
        if not args.goal:
            raise SystemExit("--goal is required unless --recritique-version is given")
        asyncio.run(run(args.shot, args.goal))
    sys.exit(0)

"""CLI entry point: run one plan -> generate -> critique -> approve cycle for
a shot, against the real local stack. This is Phase 2's exit criteria —
"run the seeded sequence through the full loop from the command line" needs
no UI to be real.

Runs exactly one generation attempt per invocation — Veo calls cost real
money, so this does not silently loop on a revise/needs_human outcome.
Re-run for another attempt.

--reuse-video <path> skips the Veo call and critiques/evaluates an existing
local video file instead. Use it to iterate on the critic or approval logic
without paying for a fresh generation each time.

Usage: uv run --directory server python run_session.py --shot SH020 --goal "..."
       uv run --directory server python run_session.py --shot SH020 --goal "..." --reuse-video clip.mp4
"""

import argparse
import asyncio
import os
import sys
from pathlib import Path

from agents.approval import evaluate
from agents.critic import critique_shot_version
from agents.decision_log import new_run_id
from agents.generation import generate_shot_version
from agents.planner import plan_shot
from agents.revision import revise_shot
from db.postgres import Database
from storage.minio_client import get_client, put_bytes


async def run(shot_code: str, scene_goal: str, reuse_video: Path | None = None) -> None:
    db = Database()
    await db.connect()

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
    existing_versions = await db.get_shot_versions(shot.id)
    next_version = max((v.version_number for v in existing_versions), default=0) + 1

    run_id = new_run_id()
    print(f"run_id={run_id}")
    print(f"planning {shot_code} v{next_version}...")

    brief = await plan_shot(
        show_name=show.name,
        sequence_code=sequence.code,
        shot=shot,
        scene_goal=scene_goal,
        reference_assets=reference_assets,
        run_id=run_id,
    )
    print(f"brief ready. prompt: {brief.prompt[:120]}...")

    if reuse_video is not None:
        print(f"reusing existing video at {reuse_video} (no Veo call, no charge)...")
        video_bytes = reuse_video.read_bytes()
    else:
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
    for f in findings:
        print(f"  [{f.severity}/{f.verdict}] {f.category}: {f.description}")

    status = evaluate(findings, next_version, run_id=run_id, shot_code=shot_code)
    print(f"result: {status}")

    version_status = "approved" if status == "approved" else "failed"
    await db.update_shot_version_status(shot_version.id, version_status)
    await db.update_shot_status(shot.id, status)
    await db.insert_approval_event(
        shot_id=shot.id,
        shot_version_id=shot_version.id,
        actor="agent",
        decision=status,
        reason="; ".join(f.description for f in findings if f.verdict == "fail") or None,
    )

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
    parser.add_argument("--goal", required=True)
    parser.add_argument("--reuse-video", type=Path, default=None)
    args = parser.parse_args()
    asyncio.run(run(args.shot, args.goal, reuse_video=args.reuse_video))
    sys.exit(0)

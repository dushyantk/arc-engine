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

--reuse-prompt-from-version N generates a genuinely NEW version, but with
the exact prompt/settings text from an existing version instead of a fresh
planning call — isolates whether a defect is systematic (same prompt,
same result) or just Veo's inherent run-to-run stochasticity (same prompt,
different result). Still a real, billed Veo call.

--goal is optional, not required: if given, it becomes the shot's
persisted brief (shots.brief — the same field the dashboard's shot page
authors/edits) and this run uses it; if omitted, the shot's already-
authored brief is used, and this errors clearly if there isn't one yet.
Either way, whatever scene goal actually drove a version is stamped onto
that version's row (shot_versions.brief_used) for real lineage, since the
brief can be edited later.

--show disambiguates which show's shot to use, needed only when --shot's
code exists in more than one show (shot codes are unique within a
sequence, not globally, now that multiple real shows exist).

Usage: uv run --directory server python run_session.py --shot SH020 --goal "..."
       uv run --directory server python run_session.py --shot SH020
       uv run --directory server python run_session.py --shot SH010 --show "Signal Loss" --goal "..."
       uv run --directory server python run_session.py --shot SH020 --recritique-version 3
       uv run --directory server python run_session.py --shot SH020 --reuse-prompt-from-version 5
"""

import argparse
import asyncio
import os
import sys
from pathlib import Path
from uuid import UUID

from minio.error import S3Error

from agents.approval import evaluate
from agents.critic import critique_shot_version
from agents.decision_log import new_run_id
from agents.generation import generate_shot_version
from agents.planner import plan_shot
from agents.revision import revise_shot
from db.models import ReferenceAsset, Shot
from db.postgres import Database
from models.contracts import GenerationSettings, QCFinding, ShotBrief, ShotStatus
from storage.minio_client import get_bytes, get_client, put_bytes


async def _load_show_shot(
    db: Database, shot_code: str, show_name: str | None = None
) -> tuple[Shot, str, str, list[ReferenceAsset]]:
    """Real cross-show lookup - shot codes are only unique within a
    sequence now that multiple real shows exist (the entity hierarchy
    build made a second show real). Pass show_name (--show) to disambiguate
    when a code exists in more than one show; find_shot_by_code raises a
    clear error otherwise rather than silently picking one."""
    try:
        shot, show, sequence = await db.find_shot_by_code(shot_code, show_name)
    except LookupError as e:
        raise SystemExit(str(e)) from e

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


async def _load_reference_images(reference_assets: list[ReferenceAsset]) -> dict[str, bytes]:
    """Real reference bytes, keyed by reference_asset id (str) to match
    ShotBrief.generation_settings.image_refs. Skips any asset whose
    image_url doesn't actually resolve in MinIO instead of failing the
    whole generation — a still-unfilled reference shouldn't block a shot
    that doesn't need it."""
    minio_client = get_client()
    bucket = os.environ.get("MINIO_BUCKET", "dailies")
    images: dict[str, bytes] = {}
    for ref in reference_assets:
        try:
            images[str(ref.id)] = get_bytes(minio_client, bucket, ref.image_url)
        except S3Error:
            print(f"  no image bytes stored for reference asset {ref.name!r} ({ref.image_url}), skipping")
    return images


async def _generate_store_and_critique(
    db: Database,
    shot: Shot,
    shot_code: str,
    reference_assets: list[ReferenceAsset],
    brief: ShotBrief,
    run_id: str,
    brief_used: str | None = None,
) -> None:
    """Shared tail end of both `run` and `reuse_prompt`: real Veo call,
    real storage, real critique, real approval evaluation."""
    existing_versions = await db.get_shot_versions(shot.id)
    next_version = max((v.version_number for v in existing_versions), default=0) + 1

    reference_images = await _load_reference_images(reference_assets)
    if brief.generation_settings.image_refs:
        matched = [r for r in brief.generation_settings.image_refs if r in reference_images]
        print(f"image-conditioning on {len(matched)}/{len(brief.generation_settings.image_refs)} requested reference(s)")

    print(f"generating v{next_version} with {brief.generation_settings.model} (this takes a few minutes)...")
    video_bytes = await generate_shot_version(brief=brief, reference_images=reference_images, run_id=run_id)
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
        brief_used=brief_used,
    )

    print("critiquing...")
    continuity_context = (
        "Invariants this shot must preserve:\n" + "\n".join(f"- {i}" for i in brief.invariants)
        if brief.invariants
        else f"Generation prompt for this version (encodes what it needed to preserve):\n{brief.prompt}"
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


async def recritique(
    shot_code: str,
    version_number: int,
    video_override: Path | None,
    show_name: str | None = None,
    run_id: str | None = None,
) -> str:
    """Re-evaluates an existing shot version. No Veo call, no new version.
    Returns the run_id (generated if not given - the FastAPI runs endpoint
    passes one in so it can hand it back to the caller immediately, before
    this coroutine finishes)."""
    db = Database()
    await db.connect()

    shot, _, _, reference_assets = await _load_show_shot(db, shot_code, show_name)
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

    run_id = run_id or new_run_id()
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
    return run_id


async def reuse_prompt(
    shot_code: str,
    source_version: int,
    show_name: str | None = None,
    run_id: str | None = None,
) -> str:
    """Generates a genuinely new version with the exact prompt/settings text
    from an existing version — no new planning call. Isolates whether a
    defect is systematic or just run-to-run stochasticity. Still a real,
    billed Veo call and a real new shot_versions row. Returns the run_id."""
    db = Database()
    await db.connect()

    shot, _, _, reference_assets = await _load_show_shot(db, shot_code, show_name)
    versions = await db.get_shot_versions(shot.id)
    source = next((v for v in versions if v.version_number == source_version), None)
    if source is None:
        raise SystemExit(f"{shot_code} has no v{source_version}")
    if source.generation_settings is None:
        raise SystemExit(f"{shot_code} v{source_version} has no stored generation_settings")

    brief = ShotBrief(
        shot_code=shot_code,
        invariants=[],
        reference_asset_ids=[],
        prompt=source.generation_prompt,
        generation_settings=GenerationSettings.model_validate(source.generation_settings),
    )
    run_id = run_id or new_run_id()
    print(f"run_id={run_id}")
    print(f"reusing v{source_version}'s exact prompt verbatim, no new planning call")
    print(f"prompt: {brief.prompt[:150]}...")

    # The prompt is unchanged, so whatever brief drove it originally still
    # applies - carry it forward rather than leaving this version's
    # brief_used blank, which would misrepresent it as brief-less.
    await _generate_store_and_critique(
        db, shot, shot_code, reference_assets, brief, run_id, brief_used=source.brief_used
    )
    await db.close()
    return run_id


async def run(
    shot_code: str,
    scene_goal: str | None,
    show_name: str | None = None,
    run_id: str | None = None,
    model_tier: str | None = None,
) -> str:
    """Plans, generates (real Veo call), stores, and critiques a brand new
    version. scene_goal is optional: if given, it becomes the shot's
    persisted brief (CLI authoring, same field the dashboard edits); if
    omitted, the shot's existing brief is used and this errors if there
    isn't one yet. model_tier, if given, deterministically overrides
    whatever Veo model the planner chose (it's LLM-picked structured
    output, not otherwise steerable) - real operator tier choice, not a
    UI control that doesn't actually do anything. Returns the run_id."""
    db = Database()
    await db.connect()

    shot, show_name_resolved, sequence_code, reference_assets = await _load_show_shot(
        db, shot_code, show_name
    )

    if scene_goal:
        await db.update_shot_brief(shot.id, scene_goal)
    else:
        scene_goal = shot.brief
        if not scene_goal:
            raise SystemExit(
                f"{shot_code} has no brief authored yet — pass --goal, or author one in the dashboard first."
            )

    run_id = run_id or new_run_id()
    print(f"run_id={run_id}")
    print("planning...")

    brief = await plan_shot(
        show_name=show_name_resolved,
        sequence_code=sequence_code,
        shot=shot,
        scene_goal=scene_goal,
        reference_assets=reference_assets,
        run_id=run_id,
    )
    if model_tier:
        brief.generation_settings.model = model_tier
    print(f"brief ready. prompt: {brief.prompt[:120]}...")

    await _generate_store_and_critique(
        db, shot, shot_code, reference_assets, brief, run_id, brief_used=scene_goal
    )
    await db.close()
    return run_id


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--shot", required=True)
    parser.add_argument(
        "--show",
        default=None,
        help="Disambiguates which show's shot to use, when --shot's code exists in more than one.",
    )
    parser.add_argument(
        "--goal",
        default=None,
        help="Scene goal. If omitted, uses the shot's already-authored brief (dashboard or a prior --goal); errors if neither exists. If given, persists as the shot's brief.",
    )
    parser.add_argument("--recritique-version", type=int, default=None)
    parser.add_argument("--reuse-prompt-from-version", type=int, default=None)
    parser.add_argument("--video-override", type=Path, default=None)
    args = parser.parse_args()

    if args.recritique_version is not None:
        asyncio.run(
            recritique(args.shot, args.recritique_version, args.video_override, args.show)
        )
    elif args.reuse_prompt_from_version is not None:
        asyncio.run(reuse_prompt(args.shot, args.reuse_prompt_from_version, args.show))
    else:
        asyncio.run(run(args.shot, args.goal, args.show))
    sys.exit(0)

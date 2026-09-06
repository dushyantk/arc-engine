"""Run control: the missing initiating half of the live session view. Every
real state change this product has ever made went through CLI commands
typed by hand - these are the first real write endpoints the dashboard can
actually call.

Single-flight only: one real-money run in flight at a time, tracked with a
plain module-level variable. That's an honest limit for this product's
explicit scope decision (single operator, local/demo deployment, one
uvicorn process, no worker pool) - not a shortcut that needs a real lock
service to become correct later.

Real-money safety: /generate and /reuse-prompt both require confirm_cost=true
in the request body. That flag is the server-side gate - the dashboard's own
confirmation dialog is the human-facing half of the same discipline this
whole project has followed by hand all session (ask before spending, verify
after). /recritique never touches Veo, so it has no such gate.
"""

import asyncio
import sys
from collections.abc import Awaitable
from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import run_lock
from agents.budget import evaluate_budget, read_ceiling, total_spent_usd
from agents.decision_log import get_veo_pricing, new_run_id
from agents.generation import TIERS_WITHOUT_REFERENCE_IMAGES, reference_support_error
from agents.model_catalog import get_model_catalog
from agents.production_memory import (
    extract_and_store_fingerprint,
    get_latest_fingerprint,
    get_qc_findings,
)
from agents.sequence_continuity import evaluate_sequence_continuity
from db.postgres import Database
from models.contracts import GenerationSettings
from routes.gates import require_budget
from run_session import recritique as run_recritique
from run_session import reuse_prompt as run_reuse_prompt
from run_session import run as run_generate

router = APIRouter(prefix="/runs", tags=["runs"])

# Assumed shot length for the pre-flight estimate, matching the dashboard's own
# figure. The real charge is whatever Veo bills; this is the number the ceiling
# is checked against before spending, not a quote.
_ESTIMATE_SECONDS = 8


def _require_budget(model_tier: str | None) -> None:
    """The shared ceiling gate, priced in Veo's unit.

    An unknown tier prices at the dearest one. /reuse-prompt inherits its model
    from the source version's stored settings and cannot know it here without a
    database round-trip, and /generate lets the planner choose when the operator
    does not. A ceiling should err toward refusing a run that would have been
    cheap rather than admitting one that breaks it.
    """
    pricing = get_veo_pricing()
    per_second = pricing.get(model_tier or "", max(pricing.values(), default=0.0))
    require_budget(per_second * _ESTIMATE_SECONDS)


async def _require_tier_supports_references(
    shot_code: str, show_name: str | None, model_tier: str | None
) -> None:
    """Refuse a tier that cannot use this show's locked references.

    Checked here as well as in run_session because both are entrypoints to the
    same spend, and the failure it prevents is a provider 400 raised only after
    the planner has been billed - see agents/generation.reference_support_error.
    """
    if not model_tier or model_tier not in TIERS_WITHOUT_REFERENCE_IMAGES:
        return
    db = Database()
    await db.connect()
    try:
        _, show, _ = await db.find_shot_by_code(shot_code, show_name)
        locked = await db.get_reference_assets(show.id)
    except LookupError:
        # Not this gate's job to report a missing shot; the run path below does
        # that with the context to say it properly.
        return
    finally:
        await db.close()

    problem = reference_support_error(model_tier, len(locked))
    if problem:
        raise HTTPException(status_code=409, detail=problem)


async def _claim_run(shot_code: str, mode: str, run_id: str) -> None:
    """Takes the single-run lock, or refuses with who holds it.

    Replaces a module global, which was correct on one machine and silently
    wrong on two - each instance thought it was idle, so two operators could
    start two billed runs at once and neither would be refused. See run_lock.py.

    Claim and check are one statement there, so this cannot lose a race between
    deciding and claiming.
    """
    db = Database()
    await db.connect()
    try:
        held = await run_lock.try_acquire(
            db.pool, run_id=run_id, shot_code=shot_code, mode=mode
        )
    finally:
        await db.close()

    if held is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"A run is already in progress ({held.mode} on {held.shot_code}). "
                "Wait for it to finish."
            ),
        )


async def _run_with_lock(run_id: str, work: Awaitable[object]) -> None:
    """Runs the work while keeping the lock alive, and releases it either way.

    The heartbeat is its own task on purpose: the work blocks for minutes at a
    time - a 390s critique is normal - and a claim refreshed only between steps
    would look abandoned right in the middle of a healthy run.
    """
    stop = asyncio.Event()

    async def _beat() -> None:
        db = Database()
        await db.connect()
        try:
            while not stop.is_set():
                try:
                    await asyncio.wait_for(
                        stop.wait(), timeout=run_lock.HEARTBEAT_SECONDS
                    )
                except TimeoutError:
                    pass
                if stop.is_set():
                    return
                if not await run_lock.heartbeat(db.pool, run_id=run_id):
                    # The lock is no longer ours. Nothing to do about the work
                    # already in flight, but say so rather than pretend.
                    print(
                        f"WARNING: run {run_id} no longer holds the run lock; "
                        "another instance took it over.",
                        file=sys.stderr,
                    )
                    return
        finally:
            await db.close()

    beat = asyncio.create_task(_beat())
    try:
        await work
    finally:
        stop.set()
        beat.cancel()
        db = Database()
        await db.connect()
        try:
            await run_lock.release(db.pool, run_id=run_id)
        finally:
            await db.close()


@router.get("/status")
async def get_status() -> dict[str, dict[str, str] | None]:
    """What is running right now, across every instance.

    Read from the lock table rather than from this process's memory: with more
    than one instance, a run started on another one is still a run, and the
    session list has to show it.
    """
    db = Database()
    await db.connect()
    try:
        active = await run_lock.current(db.pool)
    finally:
        await db.close()
    return {"active": active.as_dict() if active else None}


@router.get("/models")
async def get_models(refresh: bool = False) -> dict[str, object]:
    """What this key can actually reach, with our prices merged on.

    Replaces reading the model list off the pricing table, which could only ever
    offer what someone had remembered to add there. Entries carry `priced`; the
    caller must not start a billed run on a model where that is false.
    """
    return await get_model_catalog(force_refresh=refresh)


@router.get("/budget")
def get_budget() -> dict[str, float | bool | str | None]:
    """What is left under the ceiling, so a refusal is predictable rather than a
    surprise at the moment of consent."""
    decision = evaluate_budget(
        spent_usd=total_spent_usd(), estimate_usd=0.0, ceiling_usd=read_ceiling()
    )
    return {
        "ceiling_usd": decision.ceiling_usd,
        "spent_usd": round(decision.spent_usd, 4),
        "remaining_usd": None if decision.remaining_usd is None else round(decision.remaining_usd, 4),
        "enforced": decision.ceiling_usd is not None,
    }


@router.get("/pricing")
def get_pricing() -> dict[str, float]:
    """Real per-second Veo pricing, so the dashboard's cost estimate is
    read from the same numbers agent_decision_log actually bills against,
    not a hand-copied second version of them."""
    return get_veo_pricing()


class GenerateRequest(BaseModel):
    shot_code: str
    show_name: str | None = None
    scene_goal: str | None = None
    model_tier: str | None = None
    confirm_cost: bool = False


class RunStartedResponse(BaseModel):
    run_id: str
    detail: str


@router.post("/generate", response_model=RunStartedResponse)
async def start_generate(req: GenerateRequest) -> RunStartedResponse:
    if not req.confirm_cost:
        raise HTTPException(
            status_code=400,
            detail="confirm_cost must be true - this triggers a real, billed Veo call.",
        )
    _require_budget(req.model_tier)
    await _require_tier_supports_references(req.shot_code, req.show_name, req.model_tier)
    run_id = new_run_id()
    await _claim_run(req.shot_code, "generate", run_id)

    asyncio.create_task(
        _run_with_lock(
            run_id,
            run_generate(
                req.shot_code, req.scene_goal, req.show_name, run_id, req.model_tier
            ),
        )
    )
    return RunStartedResponse(
        run_id=run_id, detail=f"Real Veo generation started for {req.shot_code}."
    )


class RecritiqueRequest(BaseModel):
    shot_code: str
    version_number: int
    show_name: str | None = None


@router.post("/recritique", response_model=RunStartedResponse)
async def start_recritique(req: RecritiqueRequest) -> RunStartedResponse:
    run_id = new_run_id()
    await _claim_run(req.shot_code, "recritique", run_id)

    asyncio.create_task(
        _run_with_lock(
            run_id,
            run_recritique(req.shot_code, req.version_number, None, req.show_name, run_id),
        )
    )
    return RunStartedResponse(
        run_id=run_id,
        detail=f"Recritique started for {req.shot_code} v{req.version_number} (no Veo cost).",
    )


class ReusePromptRequest(BaseModel):
    shot_code: str
    source_version: int
    show_name: str | None = None
    confirm_cost: bool = False


@router.post("/reuse-prompt", response_model=RunStartedResponse)
async def start_reuse_prompt(req: ReusePromptRequest) -> RunStartedResponse:
    if not req.confirm_cost:
        raise HTTPException(
            status_code=400,
            detail="confirm_cost must be true - this triggers a real, billed Veo call.",
        )
    _require_budget(None)

    run_id = new_run_id()
    await _claim_run(req.shot_code, "reuse_prompt", run_id)

    asyncio.create_task(
        _run_with_lock(
            run_id,
            run_reuse_prompt(req.shot_code, req.source_version, req.show_name, run_id),
        )
    )
    return RunStartedResponse(
        run_id=run_id,
        detail=f"Reuse-prompt run started for {req.shot_code} from v{req.source_version}.",
    )


class ExtractFingerprintRequest(BaseModel):
    shot_code: str
    version_number: int
    show_name: str | None = None


@router.post("/extract-fingerprint", response_model=RunStartedResponse)
async def extract_fingerprint(req: ExtractFingerprintRequest) -> RunStartedResponse:
    """Backfills continuity_fingerprints for a version approved outside the
    normal agent loop - specifically, a human approval (lib/actions.ts's
    submitHumanApproval), which is a pure Postgres write and has no
    Gemini call of its own to piggyback the extraction onto. Not
    single-flighted: it's a fast, cheap text-extraction call, not a real
    generation, and gating it on an unrelated in-flight Veo run would just
    make human review feel broken for no real reason."""
    db = Database()
    await db.connect()
    try:
        try:
            shot, show, sequence = await db.find_shot_by_code(req.shot_code, req.show_name)
        except LookupError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e

        versions = await db.get_shot_versions(shot.id)
        target = next((v for v in versions if v.version_number == req.version_number), None)
        if target is None:
            raise HTTPException(
                status_code=404, detail=f"{req.shot_code} has no v{req.version_number}"
            )
        if target.generation_settings is None:
            raise HTTPException(
                status_code=400,
                detail=f"{req.shot_code} v{req.version_number} has no stored generation_settings.",
            )

        reference_assets = await db.get_reference_assets(show.id)
        real_findings = get_qc_findings(shot_id=str(shot.id), version=req.version_number)

        run_id = new_run_id()
        await extract_and_store_fingerprint(
            show_name=show.name,
            sequence_code=sequence.code,
            shot_code=req.shot_code,
            version_number=req.version_number,
            prompt=target.generation_prompt,
            generation_settings=GenerationSettings.model_validate(target.generation_settings),
            screen_direction=shot.screen_direction,
            reference_frame_urls=[r.image_url for r in reference_assets],
            qc_findings=real_findings,
            approval_status="approved",
            run_id=run_id,
        )
    finally:
        await db.close()

    return RunStartedResponse(
        run_id=run_id,
        detail=f"Continuity fingerprint extracted for {req.shot_code} v{req.version_number}.",
    )


class SequenceContinuityRequest(BaseModel):
    sequence_id: UUID


class SequenceContinuityResponse(BaseModel):
    run_id: str
    status: str
    notes: str


@router.post("/sequence-continuity", response_model=SequenceContinuityResponse)
async def start_sequence_continuity(req: SequenceContinuityRequest) -> SequenceContinuityResponse:
    """ARCHITECTURE.md's closing argument: a sequence is approved only when
    every shot is approved AND a final cross-shot continuity pass agrees
    they belong together. Not single-flighted, same reasoning as
    extract-fingerprint: a fast text call, not a real generation."""
    db = Database()
    await db.connect()
    try:
        sequence = await db.get_sequence(req.sequence_id)
        show = await db.get_show(sequence.show_id)
        shots = await db.get_shots_for_sequence(req.sequence_id)

        if not shots:
            raise HTTPException(status_code=400, detail="Sequence has no shots.")
        not_approved = [s.code for s in shots if s.status != "approved"]
        if not_approved:
            raise HTTPException(
                status_code=400,
                detail=f"Not every shot is approved yet: {', '.join(not_approved)}.",
            )

        fingerprints = []
        for shot in shots:
            versions = await db.get_shot_versions(shot.id)
            approved_versions = [v for v in versions if v.status == "approved"]
            if not approved_versions:
                raise HTTPException(
                    status_code=400,
                    detail=f"{shot.code} is approved but has no approved version on record.",
                )
            latest = max(approved_versions, key=lambda v: v.version_number)
            fingerprint = get_latest_fingerprint(shot_code=shot.code, version=latest.version_number)
            if fingerprint is None:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"{shot.code} v{latest.version_number} has no continuity fingerprint - "
                        "re-approve it to backfill one, then retry the continuity pass."
                    ),
                )
            fingerprints.append(fingerprint)

        run_id = new_run_id()
        status, notes = await evaluate_sequence_continuity(
            fingerprints=fingerprints,
            run_id=run_id,
            sequence_ref=f"{show.name}/{sequence.code}",
        )
        await db.update_sequence_continuity(req.sequence_id, status=status, notes=notes)
    finally:
        await db.close()

    return SequenceContinuityResponse(run_id=run_id, status=status, notes=notes)

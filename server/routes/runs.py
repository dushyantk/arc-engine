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
from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from agents.decision_log import get_veo_pricing, new_run_id
from agents.production_memory import (
    extract_and_store_fingerprint,
    get_latest_fingerprint,
    get_qc_findings,
)
from agents.sequence_continuity import evaluate_sequence_continuity
from db.postgres import Database
from models.contracts import GenerationSettings
from run_session import recritique as run_recritique
from run_session import reuse_prompt as run_reuse_prompt
from run_session import run as run_generate

router = APIRouter(prefix="/runs", tags=["runs"])

_active: dict[str, str] | None = None


def _require_idle() -> None:
    if _active is not None:
        raise HTTPException(
            status_code=409,
            detail=f"A run is already in progress ({_active['mode']} on {_active['shot_code']}). Wait for it to finish.",
        )


def _set_active(shot_code: str, mode: str) -> None:
    global _active
    _active = {"shot_code": shot_code, "mode": mode}


def _clear_active() -> None:
    global _active
    _active = None


@router.get("/status")
def get_status() -> dict[str, dict[str, str] | None]:
    return {"active": _active}


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
    _require_idle()

    run_id = new_run_id()
    _set_active(req.shot_code, "generate")

    async def _task() -> None:
        try:
            await run_generate(
                req.shot_code, req.scene_goal, req.show_name, run_id, req.model_tier
            )
        finally:
            _clear_active()

    asyncio.create_task(_task())
    return RunStartedResponse(
        run_id=run_id, detail=f"Real Veo generation started for {req.shot_code}."
    )


class RecritiqueRequest(BaseModel):
    shot_code: str
    version_number: int
    show_name: str | None = None


@router.post("/recritique", response_model=RunStartedResponse)
async def start_recritique(req: RecritiqueRequest) -> RunStartedResponse:
    _require_idle()

    run_id = new_run_id()
    _set_active(req.shot_code, "recritique")

    async def _task() -> None:
        try:
            await run_recritique(
                req.shot_code, req.version_number, None, req.show_name, run_id
            )
        finally:
            _clear_active()

    asyncio.create_task(_task())
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
    _require_idle()

    run_id = new_run_id()
    _set_active(req.shot_code, "reuse_prompt")

    async def _task() -> None:
        try:
            await run_reuse_prompt(req.shot_code, req.source_version, req.show_name, run_id)
        finally:
            _clear_active()

    asyncio.create_task(_task())
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

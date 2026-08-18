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

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from agents.decision_log import get_veo_pricing, new_run_id
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

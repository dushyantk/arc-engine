"""Breakdown control: an approved script becomes a proposed shot list, and then
- only on a human's word - real rows.

Two endpoints on purpose. `/propose` is cheap text and writes only the proposal;
`/materialise` is what creates sequences and shots. Splitting them is the gate:
nobody can materialise a shot list they have not been shown.
"""

from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ValidationError

from agents.breakdown import break_down
from agents.decision_log import new_run_id
from agents.materialise import DuplicateShotCode, MaterialisationPlan, plan_materialisation
from db.postgres import Database
from models.contracts import SceneBreakdown, ScriptDraft, ScriptScene

router = APIRouter(prefix="/breakdowns", tags=["breakdowns"])


class ProposeRequest(BaseModel):
    show_id: UUID


class ProposeResponse(BaseModel):
    run_id: str
    breakdown_id: UUID
    version_number: int
    breakdown: SceneBreakdown
    plan: MaterialisationPlan


class MaterialiseRequest(BaseModel):
    show_id: UUID
    breakdown_id: UUID


class MaterialiseResponse(BaseModel):
    created: int
    updated: int
    protected: int


def _script_for_breakdown(logline: str, synopsis: str, body: str) -> ScriptDraft:
    """The stored script back in the shape the agent reads.

    `scripts.body` is the rendered screenplay - what a human approved - so that
    is what the breakdown is made from. Reconstructing the original scene split
    would mean guessing; feeding the approved text whole means the breakdown is
    made from exactly what was signed off.
    """
    return ScriptDraft(
        logline=logline,
        synopsis=synopsis,
        scenes=[ScriptScene(heading="APPROVED SCRIPT", action=body, beats=[])],
    )


@router.post("/propose", response_model=ProposeResponse)
async def propose(req: ProposeRequest) -> ProposeResponse:
    db = Database()
    await db.connect()
    try:
        try:
            show = await db.get_show(req.show_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        script = await db.get_approved_script(req.show_id)
        if script is None:
            raise HTTPException(
                status_code=409,
                detail=(
                    "This show has no approved script. Write one and approve it "
                    "before breaking it down."
                ),
            )

        run_id = new_run_id()
        breakdown = await break_down(
            script=_script_for_breakdown(script.logline, script.synopsis, script.body),
            show_name=show.name,
            run_id=run_id,
        )

        # Planned before it is stored: a breakdown that cannot be materialised
        # should not sit in the review UI looking approvable.
        try:
            plan = plan_materialisation(
                breakdown, existing=await db.get_existing_shape(req.show_id)
            )
        except DuplicateShotCode as exc:
            raise HTTPException(
                status_code=422,
                detail=f"The breakdown agent produced an unusable shot list: {exc}",
            ) from exc

        row = await db.insert_breakdown(
            script_id=script.id, payload=breakdown.model_dump(mode="json")
        )
    finally:
        await db.close()

    return ProposeResponse(
        run_id=run_id,
        breakdown_id=row.id,
        version_number=row.version_number,
        breakdown=breakdown,
        plan=plan,
    )


@router.post("/materialise", response_model=MaterialiseResponse)
async def materialise(req: MaterialiseRequest) -> MaterialiseResponse:
    db = Database()
    await db.connect()
    try:
        try:
            row = await db.get_breakdown(req.breakdown_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        if row.status == "materialised":
            raise HTTPException(
                status_code=409,
                detail="This breakdown has already been materialised.",
            )

        breakdown = SceneBreakdown.model_validate(row.payload)
        # Re-planned against live state rather than trusting the plan shown at
        # propose time. Between the two calls a shot may have been generated, and
        # a stale plan would overwrite a brief that has since been paid for.
        try:
            plan = plan_materialisation(
                breakdown, existing=await db.get_existing_shape(req.show_id)
            )
        except DuplicateShotCode as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        await db.apply_materialisation(
            show_id=req.show_id, breakdown_id=req.breakdown_id, plan=plan
        )
    finally:
        await db.close()

    return MaterialiseResponse(
        created=plan.creates, updated=plan.updates, protected=plan.protected
    )


class PlanResponse(BaseModel):
    breakdown_id: UUID
    version_number: int
    status: str
    breakdown: SceneBreakdown
    plan: MaterialisationPlan


class BreakdownSummary(BaseModel):
    """One past proposal, enough to read it without re-planning it."""

    breakdown_id: UUID
    version_number: int
    status: str
    created_at: datetime
    materialised_at: datetime | None
    sequence_count: int
    shot_count: int
    asset_count: int
    breakdown: SceneBreakdown


@router.get("/{show_id}/history", response_model=list[BreakdownSummary])
async def history(show_id: UUID) -> list[BreakdownSummary]:
    """Every breakdown ever proposed for this show's approved script.

    The table exists so a proposal that was superseded stays readable next to
    the one that was taken, and so a shot's `created_from_breakdown_id` points
    at something a person can actually open. Returning only the latest made both
    of those true in the database and false in the product.

    Not re-planned against live state - these are historical proposals, and a
    plan computed now would describe what re-applying an old breakdown would do
    today, which is a different and misleading question.
    """
    db = Database()
    await db.connect()
    try:
        script = await db.get_approved_script(show_id)
        if script is None:
            return []
        rows = await db.get_breakdowns(script.id)
    finally:
        await db.close()

    out: list[BreakdownSummary] = []
    for row in rows:
        try:
            breakdown = SceneBreakdown.model_validate(row.payload)
        except ValidationError:
            # A payload written under an older shape. Skipped rather than
            # failing the whole history - one unreadable proposal must not hide
            # the readable ones.
            continue
        out.append(
            BreakdownSummary(
                breakdown_id=row.id,
                version_number=row.version_number,
                status=row.status,
                created_at=row.created_at,
                materialised_at=row.materialised_at,
                sequence_count=len(breakdown.sequences),
                shot_count=sum(len(sq.shots) for sq in breakdown.sequences),
                asset_count=len(breakdown.assets),
                breakdown=breakdown,
            )
        )
    return out


@router.get("/{show_id}/latest", response_model=PlanResponse | None)
async def latest(show_id: UUID) -> PlanResponse | None:
    """The most recent breakdown for the show's approved script, re-planned
    against live state. Returns null when there is nothing to review."""
    db = Database()
    await db.connect()
    try:
        script = await db.get_approved_script(show_id)
        if script is None:
            return None
        rows = await db.get_breakdowns(script.id)
        if not rows:
            return None
        row = rows[0]
        breakdown = SceneBreakdown.model_validate(row.payload)
        try:
            plan = plan_materialisation(breakdown, existing=await db.get_existing_shape(show_id))
        except DuplicateShotCode:
            # A stored breakdown from before the guard. Better to show nothing
            # than a plan whose button would fail.
            return None
    finally:
        await db.close()

    return PlanResponse(
        breakdown_id=row.id,
        version_number=row.version_number,
        status=row.status,
        breakdown=breakdown,
        plan=plan,
    )


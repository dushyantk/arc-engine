"""Asset sheets: the breakdown's proposed assets become real reference images.

Billed, so it goes through the same two gates a Veo run does - explicit consent
in the request, and the spending ceiling checked before the call. The only thing
different about images is the pricing unit.

Sheets land unlocked. There is no approval endpoint here on purpose: the lock
verb an operator already has is the canon gate, and an unlocked reference is
already invisible to every agent. See agents/asset_sheet.py.
"""

from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from agents.asset_sheet import MODEL, AssetSheetFailed, generate_sheet
from agents.decision_log import get_image_pricing, new_run_id
from db.postgres import Database
from models.contracts import AssetSheetSpec, SceneBreakdown
from routes.gates import require_budget, require_consent

router = APIRouter(prefix="/sheets", tags=["sheets"])

# Default views by asset type. A character has to be seen from more than one
# side to be worth checking identity against; an environment or a palette does
# not have sides in the same sense, and asking for them produces a collage of
# invented angles rather than a reference.
_DEFAULT_VIEWS: dict[str, list[str]] = {
    "character": ["front view, full body", "three-quarter view", "side profile"],
    "prop": ["front view", "three-quarter view"],
    "environment": ["establishing wide"],
    "palette": ["flat swatch grid"],
}


class SheetSpecOut(BaseModel):
    """One proposed sheet, with what it would cost to make."""

    asset_type: str
    name: str
    prompt: str
    views: list[str]
    already_exists: bool
    estimated_usd: float


class ProposedSheetsResponse(BaseModel):
    model: str
    breakdown_id: UUID | None
    specs: list[SheetSpecOut]
    total_estimated_usd: float


class GenerateSheetsRequest(BaseModel):
    show_id: UUID
    # Named for the thing being consented to, matching the Veo run request.
    confirm_cost: bool = False
    # Which assets to make, by name. Empty means every one not already present -
    # never "every one", so a second pass cannot silently pay twice.
    names: list[str] = []


class GeneratedSheet(BaseModel):
    name: str
    asset_id: UUID | None
    cost_usd: float
    error: str | None = None


class GenerateSheetsResponse(BaseModel):
    run_id: str
    generated: list[GeneratedSheet]
    total_cost_usd: float


def _estimate_per_sheet() -> float:
    """What one sheet costs on the model this agent uses. Falls back to the
    dearest image model rather than zero: an unknown price must never let a
    call through a ceiling by looking free."""
    pricing = get_image_pricing()
    return pricing.get(MODEL, max(pricing.values(), default=0.0))


def _specs_from_breakdown(breakdown: SceneBreakdown) -> list[AssetSheetSpec]:
    return [
        AssetSheetSpec(
            asset_type=asset.type,
            name=asset.name,
            # The breakdown's own description, not a re-imagining of it. The
            # whole point is that the sheet matches what the script asked for.
            prompt=asset.description,
            views=_DEFAULT_VIEWS.get(asset.type, ["front view"]),
        )
        for asset in breakdown.assets
    ]


async def _load_specs(db: Database, show_id: UUID) -> tuple[list[AssetSheetSpec], UUID | None]:
    script = await db.get_approved_script(show_id)
    if script is None:
        raise HTTPException(
            status_code=409,
            detail="This show has no approved script, so there is no breakdown to take assets from.",
        )
    rows = await db.get_breakdowns(script.id)
    if not rows:
        raise HTTPException(
            status_code=409,
            detail="This show has no breakdown yet. Break the script down first.",
        )
    row = rows[0]
    return _specs_from_breakdown(SceneBreakdown.model_validate(row.payload)), row.id


@router.get("/{show_id}/proposed", response_model=ProposedSheetsResponse)
async def proposed(show_id: UUID) -> ProposedSheetsResponse:
    """What sheets the current breakdown implies, and what they would cost.

    Costed before anything is spent, per sheet and in total, so consent is
    informed rather than a bare confirmation.
    """
    db = Database()
    await db.connect()
    try:
        specs, breakdown_id = await _load_specs(db, show_id)
        existing = {a.name.lower() for a in await db.get_all_reference_assets(show_id)}
    finally:
        await db.close()

    per_sheet = _estimate_per_sheet()
    out = [
        SheetSpecOut(
            asset_type=s.asset_type,
            name=s.name,
            prompt=s.prompt,
            views=s.views,
            already_exists=s.name.lower() in existing,
            estimated_usd=per_sheet,
        )
        for s in specs
    ]
    return ProposedSheetsResponse(
        model=MODEL,
        breakdown_id=breakdown_id,
        specs=out,
        # Only what would actually be generated. Quoting a total that includes
        # sheets this would skip would overstate the bill being consented to.
        total_estimated_usd=sum(s.estimated_usd for s in out if not s.already_exists),
    )


@router.post("/generate", response_model=GenerateSheetsResponse)
async def generate(req: GenerateSheetsRequest) -> GenerateSheetsResponse:
    require_consent(req.confirm_cost, "image generation call for each sheet")

    db = Database()
    await db.connect()
    try:
        specs, breakdown_id = await _load_specs(db, req.show_id)
        existing = {a.name.lower() for a in await db.get_all_reference_assets(req.show_id)}

        wanted = {n.lower() for n in req.names}
        todo = [
            s
            for s in specs
            if (s.name.lower() in wanted if wanted else s.name.lower() not in existing)
        ]
        if not todo:
            raise HTTPException(
                status_code=409,
                detail="Every asset in this breakdown already has a reference. Nothing to generate.",
            )

        # The whole batch is checked against the ceiling up front. Checking one
        # sheet at a time would let a batch walk past the cap by paying for the
        # first few before the check that stops it.
        require_budget(_estimate_per_sheet() * len(todo))

        run_id = new_run_id()
        results: list[GeneratedSheet] = []
        for spec in todo:
            try:
                asset_id, cost = await generate_sheet(
                    spec=spec,
                    show_id=req.show_id,
                    breakdown_id=breakdown_id,
                    db=db,
                    run_id=run_id,
                )
                results.append(GeneratedSheet(name=spec.name, asset_id=asset_id, cost_usd=cost))
            except AssetSheetFailed as exc:
                # One sheet failing does not abandon the rest, but it is reported
                # rather than dropped - the call was billed and the operator has
                # to be able to see that it produced nothing.
                results.append(
                    GeneratedSheet(name=spec.name, asset_id=None, cost_usd=0.0, error=str(exc))
                )
    finally:
        await db.close()

    return GenerateSheetsResponse(
        run_id=run_id,
        generated=results,
        total_cost_usd=sum(r.cost_usd for r in results),
    )

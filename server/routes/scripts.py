"""Script control: the first stage of top-down planning.

Cheap by design - text only, no Veo, no images - so a director can iterate on a
premise for cents before anything expensive is planned from it. There is no
confirm_cost gate here for that reason; the gate that matters upstream of a
billed run is approving the script, not writing one.
"""

from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from agents.decision_log import new_run_id
from agents.story import render_body, write_script
from db.postgres import Database
from models.contracts import ScriptDraft

router = APIRouter(prefix="/scripts", tags=["scripts"])


class DraftScriptRequest(BaseModel):
    show_id: UUID
    idea: str


class DraftScriptResponse(BaseModel):
    run_id: str
    script_id: UUID
    version_number: int
    draft: ScriptDraft


@router.post("/draft", response_model=DraftScriptResponse)
async def draft_script(req: DraftScriptRequest) -> DraftScriptResponse:
    if not req.idea.strip():
        raise HTTPException(status_code=400, detail="An idea is required to write from.")

    db = Database()
    await db.connect()
    try:
        try:
            show = await db.get_show(req.show_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        run_id = new_run_id()
        draft = await write_script(idea=req.idea, show_name=show.name, run_id=run_id)

        # Stored as a new draft version, never overwriting a previous one.
        script = await db.insert_script(
            show_id=req.show_id,
            source_prompt=req.idea,
            logline=draft.logline,
            synopsis=draft.synopsis,
            body=render_body(draft),
        )
    finally:
        await db.close()

    return DraftScriptResponse(
        run_id=run_id,
        script_id=script.id,
        version_number=script.version_number,
        draft=draft,
    )

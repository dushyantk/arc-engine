"""Supervisor/Critic agent: watches a candidate shot version, compares it
against approved references and continuity context, and produces
structured QC findings — with an explicit instruction to tell creative
variation apart from generative defect, not just flag any change as fail.
"""

import time

from google.genai import types
from pydantic import BaseModel

from agents.decision_log import estimate_token_cost, log_decision
from db.models import ReferenceAsset
from genai_client import get_client
from models.contracts import QCFinding
from retry import call_with_retry
from video_frames import extract_frames

CRITIC_MODEL = "gemini-3.1-pro-preview"
FRAME_COUNT = 12

CRITIC_PROMPT_TEMPLATE = """You are the supervisor/critic agent for Dailies, a GenFX dailies
review system. You are given two things for the same shot: the full video, and {frame_count}
still frames sampled at even intervals through it, each labeled with its timestamp. You are
looking for objective continuity breaks, not giving a general creative review.

Continuity context this shot must preserve:
{continuity_context}

Reference images are attached and labeled by type and name.

For each of these categories, produce a QCFinding: character_identity, costume_continuity,
hero_prop, environment_continuity, screen_direction, lighting_continuity, temporal_stability
(flickering, geometry crawl, deforming text/numerals, mutating faces, objects teleporting or
changing hands/position mid-shot). Skip a category only if it genuinely does not apply to this
shot (e.g. no on-screen text to evaluate for temporal_stability).

For hero_prop specifically, do not judge it from the video alone — continuous video playback has
been found, by direct verification against ground truth, to miss a prop that duplicates across
both hands for roughly a second and then settles into the wrong one. Instead: go through the
{frame_count} labeled still frames IN ORDER and explicitly state, for every single one, which side
of the SCREEN the prop is on: **screen-left** or **screen-right** — the frame position exactly as
you see it, not an inference about the character's own anatomical hand or which way she's facing.
Screen-left/screen-right is what you can directly verify by looking; "her left hand" requires you
to first work out her orientation, which is exactly the kind of inference that produces
inconsistent reports between runs. Report position as "screen-left"/"screen-right" (or "both" if
the prop is visible on both sides at once — itself a defect, not a resolved state), and only note
the anatomical hand as secondary context if it's unambiguous. Then report the exact pair of
consecutive labeled frames between which anything changes. If the prop is on the same screen side
in every one of the {frame_count} frames, say so explicitly and mark it pass. This check is most
likely to fail at the exact moment the character does something else with their other hand or
body — reaching into a pocket, touching their hair, gesturing — so pay particular attention to the
frames right around any such action.

For screen_direction specifically, also report in screen-left/screen-right terms: does the
character's overall movement or facing go from screen-left to screen-right (or vice versa) as
specified in the continuity context, not "her left to her right" or similar anatomical framing.

For every other category, watch the full video continuously — never judge a category from only
its first or last frame; a defect that only exists in the middle of the shot is still a defect.

Critical instruction: distinguish creative variation from generative defect. A creature's
silhouette changing between takes, weather intensifying, or a camera move being more dynamic than
planned can be acceptable creative variation — say so and mark it pass, with a note. An extra
finger for a few frames, a prop changing color, teleporting, duplicating, swapping hands, or
vanishing, a face mutating, or geometry crawling is a generative defect — mark it fail. When
genuinely uncertain, mark it warning and say what you are uncertain about. Cite the approximate
timestamp (from the labeled frames) where anything localized in time actually happens, not just
where you first or last notice it.
"""


class _QCFindingsResult(BaseModel):
    findings: list[QCFinding]


async def critique_shot_version(
    *,
    video_bytes: bytes,
    video_mime_type: str,
    reference_assets: list[ReferenceAsset],
    reference_images: dict[str, bytes],  # reference_assets[i].id (str) -> image bytes
    continuity_context: str,
    run_id: str,
    shot_version_ref: str,
) -> list[QCFinding]:
    client = get_client()

    frames = await extract_frames(video_bytes, count=FRAME_COUNT)

    parts: list[types.Part] = [types.Part.from_bytes(data=video_bytes, mime_type=video_mime_type)]
    for i, (timestamp, frame_bytes) in enumerate(frames, start=1):
        parts.append(types.Part.from_text(text=f"Labeled frame {i}/{len(frames)}, t={timestamp:.2f}s"))
        parts.append(types.Part.from_bytes(data=frame_bytes, mime_type="image/png"))

    for ref in reference_assets:
        image_bytes = reference_images.get(str(ref.id))
        if image_bytes is None:
            continue
        parts.append(types.Part.from_text(text=f"Reference — {ref.type}: {ref.name}"))
        parts.append(types.Part.from_bytes(data=image_bytes, mime_type="image/png"))

    parts.append(
        types.Part.from_text(
            text=CRITIC_PROMPT_TEMPLATE.format(
                continuity_context=continuity_context, frame_count=len(frames)
            )
        )
    )

    start = time.monotonic()
    response = await call_with_retry(
        client.aio.models.generate_content,
        model=CRITIC_MODEL,
        contents=types.Content(role="user", parts=parts),
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=_QCFindingsResult,
            # High, not the default: catching a fast mid-clip swap (a few frames out of
            # ~192) needs more per-frame detail than the default token budget gives it —
            # found by missing exactly this on the first real critique.
            media_resolution=types.MediaResolution.MEDIA_RESOLUTION_HIGH,
        ),
    )
    latency_ms = int((time.monotonic() - start) * 1000)
    usage = response.usage_metadata
    tokens_in = usage.prompt_token_count if usage else 0
    tokens_out = usage.candidates_token_count if usage else 0

    if response.parsed is None:
        raise ValueError(f"Critic produced malformed QC findings JSON: {response.text!r}")
    result = _QCFindingsResult.model_validate(response.parsed)

    log_decision(
        run_id=run_id,
        agent_name="critic",
        step="qc_review",
        input_ref=shot_version_ref,
        output_ref=f"{len(result.findings)} findings",
        model=CRITIC_MODEL,
        tokens_in=tokens_in or 0,
        tokens_out=tokens_out or 0,
        cost_usd=estimate_token_cost(CRITIC_MODEL, tokens_in or 0, tokens_out or 0),
        latency_ms=latency_ms,
    )

    return result.findings

"""Identity scoring against a locked character reference - ADVISORY, wired to
nothing, and kept mainly for what building it wrong taught.

The design was lifted from a sibling project (Rexgent) after seeing its
MCP-exposed `ConsistencyGuard`. Reading how that project actually *applies* it
afterwards showed the port was wrong in ways worth writing down, because the
mistakes are the useful part.

What that project really runs in its generation loop is `ContinuityAgent`, not
the MCP tool, and it is a hybrid that splits axes by what kind of question each
one is:

  face       -> ArcFace embedding, a measurement. Never a language model.
  outfit     -> vision model, a judgement.
  background -> vision model, a judgement.

combined 0.5 / 0.25 / 0.25, re-normalised when an axis is unavailable, against a
threshold of 55/100 - and an axis is *suppressed* when the framing makes it
meaningless (no outfit score on CU/ECU/OTS, because an over-the-shoulder shows a
back; their comment records one dragging a good shot down to 40). Raw cosine is
also run through a calibration curve first, since a genuine same-person ArcFace
pair only clears ~0.35 and reading that raw as "35/100" would fail every real
match.

This module asked a language model for the identity number - the one thing that
design deliberately never does. So the earlier note here, that a flash model
"scored 0.98 on a photograph of an empty platform", measured nothing about
whether a VLM can substitute for an embedding: in that project a non-face
reference never reaches the scorer, because ArcFace returns no vector and the
character is flagged unverifiable instead. The test exercised a path that cannot
occur there. It was a bad test of a design I had already mis-copied.

Ways the port was wrong, for the next person: ported the MCP tool rather than the
pipeline's real agent; no input validation, so a non-face reference was scored at
all; one axis instead of a weighted composite; a flat 0.6 cutoff instead of a
calibration curve; a hard gate instead of advisory NEEDS_REVIEW feeding a
budget-gated repair ladder; and no scoping to who is actually in frame, which
that project passes as characters_in_frame / foreground_characters / shot_type.

What stands regardless: identity wants a measurement, not a judgement. The
compliant one here is Vertex AI multimodal embeddings, which needs the Vertex
credential path this project skipped (ARCHITECTURE.md section 6). Until that
exists this stays advisory and calls nothing.
"""

import time

from google.genai import types

from agents.decision_log import estimate_token_cost, log_decision, token_usage
from genai_client import get_client
from models.contracts import IdentityReport
from retry import call_with_retry
from video_frames import extract_frames

# Cheap tier does the scoring; the reasoning tier is only paid for on failure.
# Both must be present in decision_log's pricing table - an unpriced model would
# log $0.00 against a real charge.
SCORING_MODEL = "gemini-3.6-flash"
DIAGNOSIS_MODEL = "gemini-3.1-pro-preview"

DEFAULT_FRAME_COUNT = 3
# Advisory only. This does NOT gate approval - see the module docstring for the
# measurement showing the score does not discriminate.
PASS_THRESHOLD = 0.6

_SCORING_SYSTEM = """You are verifying whether two sets of images show the same
person. Treat this as a check that can fail, not a description exercise.

Work in this order, and do not skip step 1:

1. Say what each image actually contains. If the reference image does not depict
   a human face at all - it is a location, a prop, an empty plate - then identity
   CANNOT be verified: return similarity 0.0, verdict "fail", and say so in the
   note. Do not describe features that are not there.
2. Only if both sets show a face, compare identity: face structure, hair,
   distinguishing marks AND WHICH SIDE they are on, apparent age and build.
3. Score each frame independently. Frames may differ from each other; identical
   scores across every frame usually means they were not really compared.

Ignore anything that is not identity - lighting, camera angle, expression,
motion blur, framing, and any wardrobe change the brief called for. A correct
person badly lit still scores high.

You are not being asked to agree. A confident low score on a genuine mismatch is
worth more here than a high score that turns out to be wrong."""


async def check_identity(
    *,
    video_bytes: bytes,
    reference_images: dict[str, bytes],
    shot_code: str,
    version_number: int,
    run_id: str,
    frame_count: int = DEFAULT_FRAME_COUNT,
) -> IdentityReport:
    """Scores each locked character reference against sampled frames.

    Returns a report with no characters when there is nothing to check against -
    "cannot verify" is reported as such rather than passed off as agreement.
    """
    if not reference_images:
        return IdentityReport(
            overall_pass=True,
            overall_similarity=1.0,
            characters=[],
            diagnosis=None,
            suggested_change=(
                "No locked character reference to compare against, so identity was not "
                "verified. Lock a character reference for this show to enable the check."
            ),
        )

    client = get_client()
    frames = await extract_frames(video_bytes, count=frame_count)

    parts: list[types.Part] = []
    for name, image_bytes in reference_images.items():
        parts.append(types.Part.from_text(text=f"Reference image, labelled {name!r}:"))
        parts.append(types.Part.from_bytes(data=image_bytes, mime_type="image/png"))

    parts.append(
        types.Part.from_text(
            text=(
                f"Generated frames from {shot_code} v{version_number}, in order. "
                f"Score each of these characters: {', '.join(reference_images)}."
            )
        )
    )
    for index, (timestamp, frame_bytes) in enumerate(frames, start=1):
        parts.append(types.Part.from_text(text=f"Frame {index} (t={timestamp:.1f}s):"))
        parts.append(types.Part.from_bytes(data=frame_bytes, mime_type="image/png"))

    start = time.monotonic()
    response = await call_with_retry(
        client.aio.models.generate_content,
        model=SCORING_MODEL,
        contents=[types.Content(role="user", parts=parts)],
        config=types.GenerateContentConfig(
            system_instruction=_SCORING_SYSTEM,
            response_mime_type="application/json",
            response_schema=IdentityReport,
        ),
    )
    latency_ms = int((time.monotonic() - start) * 1000)
    _log(
        run_id=run_id,
        step="score_identity",
        model=SCORING_MODEL,
        response=response,
        latency_ms=latency_ms,
        shot_code=shot_code,
        version_number=version_number,
    )

    if response.parsed is None:
        raise ValueError(f"Identity check produced malformed JSON: {response.text!r}")
    report = IdentityReport.model_validate(response.parsed)

    # Recompute the gate here rather than trusting the model's own boolean: the
    # threshold is this system's policy, not the model's to decide.
    report.overall_pass = report.overall_similarity >= PASS_THRESHOLD

    if report.overall_pass:
        return report

    # Only failures are worth the reasoning model. This is the whole point of
    # the two tiers: diagnosis is expensive and almost always unnecessary.
    diagnosis, change = await _diagnose(
        client=client,
        frames=frames,
        reference_images=reference_images,
        report=report,
        shot_code=shot_code,
        version_number=version_number,
        run_id=run_id,
    )
    report.diagnosis = diagnosis
    report.suggested_change = change
    return report


async def _diagnose(
    *,
    client: object,
    frames: list[tuple[float, bytes]],
    reference_images: dict[str, bytes],
    report: IdentityReport,
    shot_code: str,
    version_number: int,
    run_id: str,
) -> tuple[str, str]:
    """Asks the reasoning model why identity broke and what single change fixes it.

    Returns prose rather than a structured contract on purpose: this feeds the
    revision agent, which already turns findings into a regeneration
    instruction, and a second competing schema there would just be another thing
    to keep in sync.
    """
    worst = min(report.characters, key=lambda c: c.similarity, default=None)
    worst_name = worst.character_name if worst else "the character"

    parts: list[types.Part] = []
    for name, image_bytes in reference_images.items():
        parts.append(types.Part.from_text(text=f"Locked reference for {name}:"))
        parts.append(types.Part.from_bytes(data=image_bytes, mime_type="image/png"))

    # The midpoint frame, matching where the scorer saw the shot settle.
    _, mid_frame = frames[len(frames) // 2]
    parts.append(types.Part.from_text(text="The generated frame that does not match:"))
    parts.append(types.Part.from_bytes(data=mid_frame, mime_type="image/png"))
    parts.append(
        types.Part.from_text(
            text=(
                f"{worst_name} in {shot_code} v{version_number} scored "
                f"{worst.similarity if worst else 0:.2f} against the reference. "
                "Name the single most likely visual cause (face structure, hair, a "
                "distinguishing mark on the wrong side, age or build drift, occlusion, "
                "extreme angle) and give ONE specific, concrete change to the generation "
                "prompt that would fix it. Two short sentences: the cause, then the change."
            )
        )
    )

    aio = client.aio  # type: ignore[attr-defined]
    start = time.monotonic()
    response = await call_with_retry(
        aio.models.generate_content,
        model=DIAGNOSIS_MODEL,
        contents=[types.Content(role="user", parts=parts)],
    )
    latency_ms = int((time.monotonic() - start) * 1000)
    _log(
        run_id=run_id,
        step="diagnose_identity",
        model=DIAGNOSIS_MODEL,
        response=response,
        latency_ms=latency_ms,
        shot_code=shot_code,
        version_number=version_number,
    )

    text = (response.text or "").strip()
    if not text:
        return ("Identity break not diagnosable from the sampled frames.", "Re-generate with the character reference image-conditioned.")
    # First sentence is the cause, the remainder the change - the prompt asks
    # for exactly that shape.
    cause, _, change = text.partition(".")
    return (cause.strip() + ".", change.strip() or text)


def _log(
    *,
    run_id: str,
    step: str,
    model: str,
    response: object,
    latency_ms: int,
    shot_code: str,
    version_number: int,
) -> None:
    tokens_in, tokens_out = token_usage(response)
    log_decision(
        run_id=run_id,
        agent_name="identity_check",
        step=step,
        input_ref=f"shot:{shot_code}:v{version_number}",
        output_ref=step,
        model=model,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        cost_usd=estimate_token_cost(model, tokens_in, tokens_out),
        latency_ms=latency_ms,
    )

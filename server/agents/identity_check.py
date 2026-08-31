"""Identity scoring against a locked character reference - NOT WIRED INTO THE
APPROVAL PATH, and the reason is the point of this file.

The design is borrowed from a sibling project (Rexgent's ConsistencyGuard): score
cheaply first, and spend the expensive reasoning model only on failures, where it
diagnoses *why* and names one concrete prompt change. That two-tier shape is
sound and worth having.

What could not be borrowed is the scorer. That project locks identity with a
local ArcFace embedding and a cosine distance. This project may only use Google
AI tools, so the substitution attempted here was a flash model asked to judge
similarity against the reference image and return a number.

That substitution does not work, and was measured rather than assumed. Handed a
photograph of an empty railway platform as the "Maya" reference, against real
SH030 v5 footage:

  - first prompt:  0.98 PASS, and it confabulated "dark wet hair" and a "right
    cheek facial mark" in a picture of a station platform
  - de-primed prompt (neutral labels, an explicit "if the reference is not a
    face, fail" instruction): 0.73 PASS, frame scores finally varying, and the
    same confabulation with the mark now on the *left* cheek

It is scoring whether the generated frames are consistent with each other, not
whether they match the reference, and it will rationalise agreement with
whatever it is told the reference is. A gate that passes an empty plate is worse
than no gate: it launders an unverified shot as verified.

So nothing here calls this. It stays because everything except the scorer is
right - frame sampling, the contract, the two-tier structure, the diagnosis call
that produces a targeted prompt change - and because the finding is worth
keeping.

The real fix is a genuine measurement, and there is a compliant one: Vertex AI
multimodal embeddings give an actual image vector and a cosine distance, which
cannot be talked into agreeing. That needs the Vertex credential path this
project deliberately skipped (ARCHITECTURE.md section 6), so it is filed as a
build-plan task rather than done here.
"""

import time

from google.genai import types

from agents.decision_log import estimate_token_cost, log_decision
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
    usage = getattr(response, "usage_metadata", None)
    tokens_in = getattr(usage, "prompt_token_count", 0) or 0
    tokens_out = getattr(usage, "candidates_token_count", 0) or 0
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

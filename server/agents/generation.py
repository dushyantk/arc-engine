"""Veo 3.1 generation adapter: image-conditioned + first/last-frame calls,
produces a candidate shot version.

This makes REAL, BILLED calls to Veo 3.1 — real per-second cost, see
agents/decision_log.py's pricing table. Nothing in this module runs as
part of any test or startup path; generate_shot_version() only executes
when a caller explicitly invokes it, on purpose, knowing it costs money.
"""


# Tiers that reject `referenceImages` outright. Established by a real 400 from
# the API on 2026-09-05, generating SH010 of Lantern Signal against one locked
# reference:
#
#   400 INVALID_ARGUMENT - `referenceImages` isn't supported by this model.
#
# Only Lite is listed because only Lite has been observed to refuse. Do not add a
# tier here on the assumption it behaves the same; add it when the API says so.
TIERS_WITHOUT_REFERENCE_IMAGES = frozenset({"veo-3.1-lite-generate-preview"})


def reference_support_error(model_tier: str | None, locked_reference_count: int) -> str | None:
    """Why this tier cannot generate this shot, or None if it can.

    RULE: every path that starts a generation calls this before planning. The
    combination is not merely unsupported downstream - it fails as an opaque
    provider error *after* the planner has already been billed, which is the
    worst place to discover it. Refusing up front costs nothing.

    Says what is true on both sides and what the operator can actually do about
    it, rather than repeating the provider's message, which names a field no one
    using this product has heard of.
    """
    if not model_tier or model_tier not in TIERS_WITHOUT_REFERENCE_IMAGES:
        return None
    if locked_reference_count == 0:
        return None
    return (
        f"{model_tier} cannot use locked references, and this show has "
        f"{locked_reference_count} of them. A run on this tier would ignore the canon "
        f"the shot is meant to match, so it is refused rather than generating something "
        f"unbound. Use a tier that supports references, or unlock them first."
    )

import asyncio
import time

from google import genai
from google.genai import errors, types

from agents.decision_log import estimate_veo_cost, log_decision
from genai_client import get_client
from models.contracts import ShotBrief
from retry import call_with_retry

POLL_INTERVAL_SECONDS = 10
DEFAULT_DURATION_SECONDS = 8

# Retries here are bounded and deliberately narrow, because this is the one call
# in the system that costs real money. See _submit_and_await() for exactly which
# outcomes are safe to repeat.
MAX_GENERATION_ATTEMPTS = 3
RETRY_BASE_DELAY_SECONDS = 15


class VeoNotBilled(RuntimeError):
    """A Veo failure that produced no output and therefore no charge.

    The only class of failure this module retries. Raised for a submission that
    never created an operation, and for an operation that completed with an
    error - both of which bill nothing, so running them again costs one more
    attempt rather than one more generation. Every other failure either was
    billed or has ambiguous billing, and is re-raised untouched.
    """


async def generate_shot_version(
    *,
    brief: ShotBrief,
    reference_images: dict[str, bytes],  # reference_asset_id (str) -> image bytes
    run_id: str,
    duration_seconds: int = DEFAULT_DURATION_SECONDS,
) -> bytes:
    """Runs a real Veo 3.1 generation and returns the generated video bytes."""
    client = get_client()
    model = brief.generation_settings.model

    reference_images_list = [
        types.VideoGenerationReferenceImage(
            image=types.Image(image_bytes=reference_images[ref_id], mime_type="image/png")
        )
        for ref_id in brief.generation_settings.image_refs
        if ref_id in reference_images
    ]

    video, latency_ms = await _generate_with_retry(
        client=client,
        model=model,
        brief=brief,
        reference_images_list=reference_images_list,
        duration_seconds=duration_seconds,
    )

    # Log the spend as soon as the operation itself succeeds — that's the real billing
    # event — rather than after the download below. A download failure (as happened on
    # the first live run: see git history on this file) must not leave an already-billed
    # generation with zero record of it.
    cost = estimate_veo_cost(model, duration_seconds)
    log_decision(
        run_id=run_id,
        agent_name="generation_adapter",
        step="generate_video",
        input_ref=brief.shot_code,
        output_ref=f"{duration_seconds}s requested",
        model=model,
        tokens_in=0,
        tokens_out=0,
        cost_usd=cost,
        latency_ms=latency_ms,
    )

    if video.video_bytes:
        return video.video_bytes
    if video.uri:
        # client.aio.files.download(), not a raw httpx GET on video.uri: the download
        # endpoint 302-redirects to a signed URL, and the request needs the SDK's own
        # auth — a bare unauthenticated GET fails on both counts (found by hitting an
        # unfollowed-redirect error on a real, already-billed generation call).
        #
        # Retried as a download, never by generating again: by this point the
        # charge above has already landed, so a second generation would be a
        # second bill for footage we already own.
        video_bytes: bytes = await call_with_retry(client.aio.files.download, file=video.uri)
        return video_bytes
    raise RuntimeError(f"Veo generation result has neither bytes nor uri: {video}")


async def _generate_with_retry(
    *,
    client: genai.Client,
    model: str,
    brief: ShotBrief,
    reference_images_list: list[types.VideoGenerationReferenceImage],
    duration_seconds: int,
) -> tuple[types.Video, int]:
    """Submits and awaits a generation, repeating only unbilled failures.

    Hit for real on SH010: a code-13 internal error came back after the planner
    calls had already been paid for, and the whole run had to be started again by
    hand. Anything that got as far as producing output is not retried here - see
    VeoNotBilled.
    """
    last_error: Exception | None = None
    for attempt in range(1, MAX_GENERATION_ATTEMPTS + 1):
        try:
            return await _submit_and_await(
                client=client,
                model=model,
                brief=brief,
                reference_images_list=reference_images_list,
                duration_seconds=duration_seconds,
            )
        except VeoNotBilled as exc:
            last_error = exc
            if attempt == MAX_GENERATION_ATTEMPTS:
                break
            delay = RETRY_BASE_DELAY_SECONDS * attempt
            # Printed, not swallowed: a generation that needed three goes is a
            # fact about the run, and the operator watching it should see that.
            print(
                f"veo attempt {attempt}/{MAX_GENERATION_ATTEMPTS} for {brief.shot_code} "
                f"failed without billing ({exc}); retrying in {delay}s"
            )
            await asyncio.sleep(delay)

    raise RuntimeError(
        f"Veo generation failed for {brief.shot_code} after {MAX_GENERATION_ATTEMPTS} "
        f"unbilled attempts: {last_error}"
    )


async def _submit_and_await(
    *,
    client: genai.Client,
    model: str,
    brief: ShotBrief,
    reference_images_list: list[types.VideoGenerationReferenceImage],
    duration_seconds: int,
) -> tuple[types.Video, int]:
    """One submission, polled to completion. Raises VeoNotBilled for outcomes
    that produced nothing and cost nothing."""
    aio = client.aio

    start = time.monotonic()
    try:
        operation = await aio.models.generate_videos(
            model=model,
            source=types.GenerateVideosSource(prompt=brief.prompt),
            # No `seed`: the Gemini Developer API (not Vertex) rejects it for video
            # generation outright. GenerationSettings.seed stays in the contract for
            # a future Vertex path but isn't sent here.
            config=types.GenerateVideosConfig(
                reference_images=reference_images_list or None,
                duration_seconds=duration_seconds,
            ),
        )
    except errors.ServerError as exc:
        # The request never created an operation, so nothing is running and
        # nothing will be charged.
        raise VeoNotBilled(f"submission rejected: {exc}") from exc

    while not operation.done:
        await asyncio.sleep(POLL_INTERVAL_SECONDS)
        # Retry the poll itself rather than the generation: the operation is
        # already running and will bill on success, so re-submitting because a
        # status check blipped would buy the same footage twice.
        operation = await call_with_retry(aio.operations.get, operation)

    latency_ms = int((time.monotonic() - start) * 1000)

    if operation.error:
        raise VeoNotBilled(f"operation failed: {operation.error}")

    # Deliberately not retried below this line: the operation reported success,
    # so billing has to be assumed even though no video came back.
    if not operation.result or not operation.result.generated_videos:
        raise RuntimeError(f"Veo generation returned no video for {brief.shot_code}: {operation}")

    video = operation.result.generated_videos[0].video
    if video is None:
        raise RuntimeError(f"Veo generation returned an empty video entry for {brief.shot_code}")

    return video, latency_ms

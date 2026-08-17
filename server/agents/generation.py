"""Veo 3.1 generation adapter: image-conditioned + first/last-frame calls,
produces a candidate shot version.

This makes REAL, BILLED calls to Veo 3.1 — real per-second cost, see
agents/decision_log.py's pricing table. Nothing in this module runs as
part of any test or startup path; generate_shot_version() only executes
when a caller explicitly invokes it, on purpose, knowing it costs money.
"""

import asyncio
import time

from google.genai import types

from agents.decision_log import estimate_veo_cost, log_decision
from genai_client import get_client
from models.contracts import ShotBrief

POLL_INTERVAL_SECONDS = 10
DEFAULT_DURATION_SECONDS = 8


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

    start = time.monotonic()
    operation = await client.aio.models.generate_videos(
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

    while not operation.done:
        await asyncio.sleep(POLL_INTERVAL_SECONDS)
        operation = await client.aio.operations.get(operation)

    latency_ms = int((time.monotonic() - start) * 1000)

    if operation.error:
        # The operation itself failed — nothing was actually billed for output, so no
        # log_decision call here. (If Veo's own error-billing policy differs, revisit.)
        raise RuntimeError(f"Veo generation failed for {brief.shot_code}: {operation.error}")
    if not operation.result or not operation.result.generated_videos:
        raise RuntimeError(f"Veo generation returned no video for {brief.shot_code}: {operation}")

    video = operation.result.generated_videos[0].video
    if video is None:
        raise RuntimeError(f"Veo generation returned an empty video entry for {brief.shot_code}")

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
        video_bytes: bytes = await client.aio.files.download(file=video.uri)
        return video_bytes
    raise RuntimeError(f"Veo generation result has neither bytes nor uri: {video}")

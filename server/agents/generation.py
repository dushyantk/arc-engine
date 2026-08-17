"""Veo 3.1 generation adapter: image-conditioned + first/last-frame calls,
produces a candidate shot version.

This makes REAL, BILLED calls to Veo 3.1 — real per-second cost, see
agents/decision_log.py's pricing table. Nothing in this module runs as
part of any test or startup path; generate_shot_version() only executes
when a caller explicitly invokes it, on purpose, knowing it costs money.
"""

import asyncio
import time

import httpx
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
        config=types.GenerateVideosConfig(
            reference_images=reference_images_list or None,
            seed=brief.generation_settings.seed,
            duration_seconds=duration_seconds,
        ),
    )

    while not operation.done:
        await asyncio.sleep(POLL_INTERVAL_SECONDS)
        operation = await client.aio.operations.get(operation)

    latency_ms = int((time.monotonic() - start) * 1000)

    if operation.error:
        raise RuntimeError(f"Veo generation failed for {brief.shot_code}: {operation.error}")
    if not operation.result or not operation.result.generated_videos:
        raise RuntimeError(f"Veo generation returned no video for {brief.shot_code}: {operation}")

    video = operation.result.generated_videos[0].video
    if video is None:
        raise RuntimeError(f"Veo generation returned an empty video entry for {brief.shot_code}")

    if video.video_bytes:
        video_bytes = video.video_bytes
    elif video.uri:
        async with httpx.AsyncClient() as http:
            resp = await http.get(video.uri)
            resp.raise_for_status()
            video_bytes = resp.content
    else:
        raise RuntimeError(f"Veo generation result has neither bytes nor uri: {video}")

    cost = estimate_veo_cost(model, duration_seconds)

    log_decision(
        run_id=run_id,
        agent_name="generation_adapter",
        step="generate_video",
        input_ref=brief.shot_code,
        output_ref=f"{len(video_bytes)} bytes, {duration_seconds}s",
        model=model,
        tokens_in=0,
        tokens_out=0,
        cost_usd=cost,
        latency_ms=latency_ms,
    )

    return video_bytes

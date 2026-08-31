"""What models this key can actually reach, asked of the API rather than hardcoded.

The pricing table in decision_log.py was doing double duty as the model list, so
the dashboard could only ever offer what someone had remembered to add to it. A
tier the key gained was invisible; a tier it lost still showed up. This asks the
API and merges our prices onto the answer.

The important half is what happens to a model we have no price for. It is listed
but marked unpriced, and the UI must refuse to start a billed run on it - an
unpriced model would log $0.00 against a real charge, which is exactly the
under-reporting the cost page exists to prevent. Better to say "no price on
record for this" than to spend quietly.
"""

import asyncio
import time
from typing import Any, Literal

from google import genai

from agents.decision_log import get_veo_pricing
from genai_client import get_client

ModelKind = Literal["video", "image"]

# Defaults the UI selects when nothing is chosen. Quality tier for footage,
# since a shot is the thing being judged; flash for asset sheets, which are
# reference material rather than the deliverable.
RECOMMENDED: dict[ModelKind, str] = {
    "video": "veo-3.1-generate-preview",
    "image": "gemini-3.1-flash-image",
}

# The live listing is stable minute to minute and the call costs about a second,
# so a page load should not pay for it every time.
_CACHE_TTL_SECONDS = 600
_cache: dict[str, Any] | None = None
_cached_at: float = 0.0


def _classify(name: str, actions: list[str]) -> ModelKind | None:
    # Veo is the only long-running predict on this API; image models are Gemini
    # ones that generate pictures through ordinary generateContent.
    if "predictLongRunning" in actions:
        return "video"
    if "-image" in name and "generateContent" in actions:
        return "image"
    return None


def _entry(name: str, kind: ModelKind, veo_pricing: dict[str, float]) -> dict[str, Any]:
    per_second = veo_pricing.get(name) if kind == "video" else None
    return {
        "name": name,
        "kind": kind,
        # Image models carry no rate yet - see the Phase 6.0 pricing task. Listed
        # so they are visible, flagged so they cannot be spent against blind.
        "priced": per_second is not None,
        "usd_per_second": per_second,
        "recommended": RECOMMENDED.get(kind) == name,
        # Previews are real and usable; the caller may want to prefer stable.
        "preview": name.endswith("-preview"),
    }


def _fallback() -> dict[str, Any]:
    """Everything we have a price for. Used when the listing call fails, so a
    blip in the API cannot leave an operator unable to start a run."""
    veo_pricing = get_veo_pricing()
    return {
        "source": "fallback",
        "note": "Live model listing unavailable; showing only models with a price on record.",
        "video": [_entry(name, "video", veo_pricing) for name in sorted(veo_pricing)],
        "image": [],
    }


async def get_model_catalog(*, force_refresh: bool = False) -> dict[str, Any]:
    global _cache, _cached_at

    fresh_enough = _cache is not None and (time.monotonic() - _cached_at) < _CACHE_TTL_SECONDS
    if fresh_enough and not force_refresh:
        return _cache  # type: ignore[return-value]

    veo_pricing = get_veo_pricing()

    def _list() -> list[tuple[str, list[str]]]:
        client: genai.Client = get_client()
        return [
            (m.name.replace("models/", ""), sorted(m.supported_actions or []))
            for m in client.models.list()
            if m.name
        ]

    try:
        # models.list() is synchronous in the SDK; off the event loop so a slow
        # listing does not stall the runtime's other requests.
        listed = await asyncio.to_thread(_list)
    except Exception as exc:  # noqa: BLE001 - any failure means "ask again later"
        catalog = _fallback()
        catalog["note"] += f" ({type(exc).__name__})"
        return catalog

    video: list[dict[str, Any]] = []
    image: list[dict[str, Any]] = []
    for name, actions in listed:
        kind = _classify(name, actions)
        if kind == "video":
            video.append(_entry(name, kind, veo_pricing))
        elif kind == "image":
            image.append(_entry(name, kind, veo_pricing))

    # Cheapest first for video, so the price ladder reads in order; name order
    # for image until there are rates to sort by.
    video.sort(key=lambda e: (e["usd_per_second"] is None, e["usd_per_second"] or 0, e["name"]))
    image.sort(key=lambda e: e["name"])

    catalog = {"source": "live", "note": None, "video": video, "image": image}
    _cache, _cached_at = catalog, time.monotonic()
    return catalog

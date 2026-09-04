"""Writes every agent step to ClickHouse's agent_decision_log — model,
tokens, cost, latency. No silent steps (ARCHITECTURE.md section 6 / global
AI-agent defaults: expose logs, decisions, cost, latency, retries).

Pricing is a best-effort estimate from third-party aggregators as of
2026-08, not Google's own pricing API — there isn't one. Reverify before
treating these numbers as a real budget signal.
"""

import os
import time
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

import clickhouse_connect

# Must match the Enum8 in clickhouse/schema.sql exactly: an unlisted value is
# silently coerced to NULL on insert rather than rejected, which has already
# cost one debugging session (see the continuity agent, BUILD_PLAN Audit).
AgentName = str  # planner | generation_adapter | critic | revision_agent | approval_gate | continuity_agent | story_agent | identity_check

# USD per 1M tokens: (input, output). Approximate, standard (non-batch) tier.
#
# Image models are here rather than in a separate per-image table on purpose:
# they bill through generateContent like the text models, and an image arrives
# as output tokens. Pricing them the same way means the logged cost comes from
# the usage the API actually reported for that call, not from a per-image
# constant that silently goes wrong when an image is a different size.
_TOKEN_PRICING: dict[str, tuple[float, float]] = {
    "gemini-3.6-flash": (0.75, 3.75),
    "gemini-3.1-pro-preview": (2.00, 12.00),
    "gemini-3.1-flash-image": (0.30, 30.00),
    "gemini-3.1-flash-image-preview": (0.30, 30.00),
    "gemini-3.1-flash-lite-image": (0.20, 20.00),
    "gemini-3-pro-image": (2.00, 120.00),
    "gemini-3-pro-image-preview": (2.00, 120.00),
    "gemini-2.5-flash-image": (0.30, 30.00),
}

# Output tokens one generated image actually costs, measured against this key on
# 2026-09-03 rather than assumed - see BUILD_PLAN 6.0. Used only to show an
# operator a per-image estimate before they consent; the figure logged after a
# call is always the usage the API reported, never this.
_MEASURED_IMAGE_OUTPUT_TOKENS: dict[str, int] = {
    "gemini-3.1-flash-image": 1512,
    "gemini-3.1-flash-image-preview": 1512,
    "gemini-3.1-flash-lite-image": 1512,
    "gemini-3-pro-image": 1430,
    "gemini-3-pro-image-preview": 1430,
    "gemini-2.5-flash-image": 1512,
}


def get_image_pricing() -> dict[str, float]:
    """Estimated USD per generated image, by model.

    Derived from the per-token rate and a measured output-token count, so it
    moves with the pricing table rather than being a second copy of it. An
    estimate for consent only: the cost written to the decision log always comes
    from the usage the API reported for the call that actually happened.
    """
    return {
        name: estimate_token_cost(name, 0, tokens)
        for name, tokens in _MEASURED_IMAGE_OUTPUT_TOKENS.items()
        if name in _TOKEN_PRICING
    }

# USD per second of generated video, by model tier.
_VEO_PRICING_PER_SECOND: dict[str, float] = {
    "veo-3.1-generate-preview": 0.40,
    "veo-3.1-fast-generate-preview": 0.12,
    "veo-3.1-lite-generate-preview": 0.05,
}


def token_usage(response: Any) -> tuple[int, int]:
    """Billed (input, output) tokens for a Gemini response.

    RULE: every path that logs a model call reads its token counts through this
    function. Do not read `usage_metadata` fields directly - that is the defect
    this exists to close, and it was present at all eight call sites.

    Output is `total - prompt`, not `candidates_token_count`. Thinking tokens
    are billed at the output rate and are not counted in candidates. Measured on
    gemini-3.1-pro-preview: a call reporting 205 candidate tokens had 974
    thinking tokens, so 83% of the billed output was invisible to the ledger.
    Under-reporting is worse here than elsewhere because the budget ceiling
    refuses runs against this number - a ledger that undercounts spends past a
    cap the operator set and believes is holding.

    Falls back to candidates + thoughts, then candidates alone, if a response
    omits a total. Never negative: a malformed total cannot credit spend back.
    """
    usage = getattr(response, "usage_metadata", None)
    if usage is None:
        return 0, 0

    tokens_in = getattr(usage, "prompt_token_count", 0) or 0
    total = getattr(usage, "total_token_count", 0) or 0
    candidates = getattr(usage, "candidates_token_count", 0) or 0
    thoughts = getattr(usage, "thoughts_token_count", 0) or 0

    tokens_out = total - tokens_in if total else candidates + thoughts
    return tokens_in, max(tokens_out, candidates)


def estimate_token_cost(model: str, tokens_in: int, tokens_out: int) -> float:
    rate_in, rate_out = _TOKEN_PRICING.get(model, (0.0, 0.0))
    return (tokens_in / 1_000_000) * rate_in + (tokens_out / 1_000_000) * rate_out


def estimate_veo_cost(model: str, seconds: float) -> float:
    return _VEO_PRICING_PER_SECOND.get(model, 0.0) * seconds


def get_veo_pricing() -> dict[str, float]:
    """Real per-second Veo pricing by model tier - the single source of
    truth an operator's cost-consent UI reads from, rather than a second,
    driftable copy of the same numbers."""
    return dict(_VEO_PRICING_PER_SECOND)


def _client() -> clickhouse_connect.driver.Client:
    return clickhouse_connect.get_client(
        host=os.environ.get("CLICKHOUSE_HOST", "localhost"),
        port=int(os.environ.get("CLICKHOUSE_PORT", "8124")),
        username=os.environ.get("CLICKHOUSE_USER", "default"),
        password=os.environ.get("CLICKHOUSE_PASSWORD", ""),
        secure=os.environ.get("CLICKHOUSE_SECURE", "false").lower() == "true",
        database=os.environ.get("CLICKHOUSE_DATABASE", "dailies"),
    )


def log_decision(
    *,
    run_id: str,
    agent_name: AgentName,
    step: str,
    input_ref: str,
    output_ref: str,
    model: str,
    tokens_in: int,
    tokens_out: int,
    cost_usd: float,
    latency_ms: int,
) -> None:
    client = _client()
    client.insert(
        "agent_decision_log",
        [
            [
                run_id,
                agent_name,
                step,
                input_ref,
                output_ref,
                model,
                tokens_in,
                tokens_out,
                cost_usd,
                latency_ms,
            ]
        ],
        column_names=[
            "run_id",
            "agent_name",
            "step",
            "input_ref",
            "output_ref",
            "model",
            "tokens_in",
            "tokens_out",
            "cost_usd",
            "latency_ms",
        ],
    )


@dataclass
class DecisionTimer:
    run_id: str
    agent_name: AgentName
    step: str
    input_ref: str
    _start: float

    def finish(
        self, *, output_ref: str, model: str, tokens_in: int, tokens_out: int, cost_usd: float
    ) -> None:
        latency_ms = int((time.monotonic() - self._start) * 1000)
        log_decision(
            run_id=self.run_id,
            agent_name=self.agent_name,
            step=self.step,
            input_ref=self.input_ref,
            output_ref=output_ref,
            model=model,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            cost_usd=cost_usd,
            latency_ms=latency_ms,
        )


def new_run_id() -> str:
    return str(uuid4())


def start_timer(*, run_id: str, agent_name: AgentName, step: str, input_ref: str) -> DecisionTimer:
    return DecisionTimer(
        run_id=run_id, agent_name=agent_name, step=step, input_ref=input_ref, _start=time.monotonic()
    )

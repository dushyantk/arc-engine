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
from uuid import uuid4

import clickhouse_connect

AgentName = str  # "planner" | "generation_adapter" | "critic" | "revision_agent" | "approval_gate" | "continuity_agent"

# USD per 1M tokens: (input, output). Approximate, standard (non-batch) tier.
_TOKEN_PRICING: dict[str, tuple[float, float]] = {
    "gemini-3.6-flash": (0.75, 3.75),
    "gemini-3.1-pro-preview": (2.00, 12.00),
}

# USD per second of generated video, by model tier.
_VEO_PRICING_PER_SECOND: dict[str, float] = {
    "veo-3.1-generate-preview": 0.40,
    "veo-3.1-fast-generate-preview": 0.12,
    "veo-3.1-lite-generate-preview": 0.05,
}


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

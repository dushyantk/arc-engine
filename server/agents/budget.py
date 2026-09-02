"""A spending ceiling across runs, enforced before a billed call is made.

Adapted from Rexgent's cost_ledger.aggregate(), which returns `within_budget`
and `remaining` against a per-project budget and is checked before generating.
This project had the opposite shape: it measured spend precisely and enforced
nothing, so the only thing standing between a typo and an unbounded bill was the
operator reading the confirm dialog.

Scoped as a single global ceiling rather than per show, deliberately. Spend is
attributed in agent_decision_log by the shot code in input_ref, which carries no
show - and shot codes are only unique within a sequence, so a per-show budget
would silently mix two shows' spend. A ceiling across everything is the honest
unit for a product whose stated scope is one operator on one machine.

Unset means unlimited, and says so. A budget that quietly defaults to some number
nobody chose is worse than none: the first time it refuses a run, the operator
learns about a limit they never set.
"""

import os
from dataclasses import dataclass

BUDGET_ENV_VAR = "DAILIES_BUDGET_USD"


@dataclass(frozen=True)
class BudgetDecision:
    allowed: bool
    ceiling_usd: float | None
    spent_usd: float
    estimate_usd: float
    remaining_usd: float | None
    reason: str


def read_ceiling(env: dict[str, str] | None = None) -> float | None:
    """The configured ceiling, or None for unlimited.

    A malformed value is treated as unset rather than as zero - refusing every
    run because someone typo'd a number would be a worse failure than not
    enforcing at all, and the reason string says the value was ignored.
    """
    raw = (env if env is not None else os.environ).get(BUDGET_ENV_VAR, "").strip()
    if not raw:
        return None
    try:
        ceiling = float(raw)
    except ValueError:
        return None
    return ceiling if ceiling > 0 else None


def evaluate_budget(
    *, spent_usd: float, estimate_usd: float, ceiling_usd: float | None
) -> BudgetDecision:
    """Whether one more billed call fits under the ceiling.

    Checks spent + estimate, not spent alone: a cap that only notices after the
    money is gone is a report, not a limit.
    """
    if ceiling_usd is None:
        return BudgetDecision(
            allowed=True,
            ceiling_usd=None,
            spent_usd=spent_usd,
            estimate_usd=estimate_usd,
            remaining_usd=None,
            reason=(
                f"No ceiling set ({BUDGET_ENV_VAR} unset), so nothing is enforced. "
                f"${spent_usd:.2f} spent so far."
            ),
        )

    remaining = ceiling_usd - spent_usd
    projected = spent_usd + estimate_usd

    if projected > ceiling_usd:
        return BudgetDecision(
            allowed=False,
            ceiling_usd=ceiling_usd,
            spent_usd=spent_usd,
            estimate_usd=estimate_usd,
            remaining_usd=remaining,
            reason=(
                f"This run is estimated at ${estimate_usd:.2f} and ${spent_usd:.2f} of the "
                f"${ceiling_usd:.2f} ceiling is already spent, leaving ${remaining:.2f}. "
                f"Raise {BUDGET_ENV_VAR} or wait."
            ),
        )

    return BudgetDecision(
        allowed=True,
        ceiling_usd=ceiling_usd,
        spent_usd=spent_usd,
        estimate_usd=estimate_usd,
        remaining_usd=remaining,
        reason=(
            f"${projected:.2f} projected against a ${ceiling_usd:.2f} ceiling; "
            f"${remaining - estimate_usd:.2f} would remain."
        ),
    )


def total_spent_usd() -> float:
    """Every dollar this system has logged, from the one place that records them.

    Reads agent_decision_log rather than keeping a running total: the log is
    already the source of truth the cost page and the landing page both read, and
    a second tally would be a second thing to drift.
    """
    from agents.decision_log import _client

    result = _client().query("SELECT sum(cost_usd) FROM agent_decision_log")
    rows = result.result_rows
    if not rows or rows[0][0] is None:
        return 0.0
    return float(rows[0][0])

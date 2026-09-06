"""Cheapest-first repair planning for a failed shot. Pure - no I/O, no model calls.

Adapted from Rexgent's `continuity_repair.repair_steps()`: given a failure, plan
an ordered ladder of retries, cheapest first, bounded by how many renders remain,
and stop as soon as one works. What changes here is what "cheaper" means. That
project varies the *strategy* (reseed, reanchor, videoedit); this one has three
Veo tiers with an 8x price spread, so the first lever is the tier.

The ladder is grounded in something this project already did by hand and wrote
down. SH020 v006 re-ran v005's prompt verbatim to test reproducibility, and three
of v005's four findings did not recur - they were run-to-run variance, not
defects - while the clock reproduced and was therefore real. That experiment cost
a full-price generation. Doing it on the lite tier costs an eighth of that, and
it is the single most informative thing you can do with a failed shot.

So: reroll before revising, unless the failure has already reproduced. There is
no point re-rolling a defect that has shown up twice, and no point rewriting a
prompt to chase what was noise.

Deliberately advisory. Like the project this is taken from, where repair is off
by default, nothing here executes a retry - it recommends one, and an operator
still authorises the spend.
"""

from dataclasses import dataclass
from typing import Literal

from agents.generation import TIERS_WITHOUT_REFERENCE_IMAGES
from models.contracts import QCFinding

RepairStrategy = Literal["reroll", "revise"]

# Cheapest first. The ladder walks this in order rather than hardcoding names, so
# a tier the API gains slots in by price without touching this logic.
TIER_ORDER = (
    "veo-3.1-lite-generate-preview",
    "veo-3.1-fast-generate-preview",
    "veo-3.1-generate-preview",
)

# Severity ranking for picking what to target first. A critical fail is worth
# rewriting the prompt around; a warning-severity one may just be a bad roll.
_SEVERITY_RANK = {"critical": 0, "warning": 1, "info": 2}


@dataclass(frozen=True)
class RepairStep:
    strategy: RepairStrategy
    model_tier: str
    reason: str


def worst_failure(findings: list[QCFinding]) -> QCFinding | None:
    """The failing finding worth targeting first: highest severity, then the
    order the critic reported them. None when nothing failed."""
    fails = [f for f in findings if f.verdict == "fail"]
    if not fails:
        return None
    return min(fails, key=lambda f: _SEVERITY_RANK.get(f.severity, 99))


def repair_steps(
    findings: list[QCFinding],
    *,
    renders_left: int,
    prior_failed_categories: frozenset[str] = frozenset(),
    tier_order: tuple[str, ...] = TIER_ORDER,
    locked_reference_count: int = 0,
) -> list[RepairStep]:
    """An ordered, bounded ladder of retries for a failed shot.

    `prior_failed_categories` is what already failed on earlier versions of this
    shot. A category in there has reproduced, so re-rolling it is wasted money.

    `locked_reference_count` drops tiers that cannot accept this show's canon.
    Filtered here rather than by each caller: the ladder's first real outing
    recommended "reroll on Lite (~$0.40)" for a shot whose show had a locked
    reference, which the runtime then refuses - advice that cannot be taken is
    worse than no advice, because it reads as a supported path.
    """
    if renders_left <= 0:
        return []

    if locked_reference_count > 0:
        tier_order = tuple(t for t in tier_order if t not in TIERS_WITHOUT_REFERENCE_IMAGES)
        if not tier_order:
            return []

    target = worst_failure(findings)
    if target is None:
        return []

    failed_now = {f.category for f in findings if f.verdict == "fail"}
    reproduced = failed_now & prior_failed_categories
    cheapest = tier_order[0]

    steps: list[RepairStep] = []

    if not reproduced:
        # Never seen before, so it may be nothing but a bad roll. Find out on the
        # cheapest tier before paying anyone to rewrite the prompt.
        steps.append(
            RepairStep(
                strategy="reroll",
                model_tier=cheapest,
                reason=(
                    f"{target.category} has not failed before on this shot - re-run the same "
                    f"prompt on the cheapest tier to see whether it reproduces at all."
                ),
            )
        )
    else:
        steps.append(
            RepairStep(
                strategy="revise",
                model_tier=cheapest,
                reason=(
                    f"{', '.join(sorted(reproduced))} already failed on an earlier version, so "
                    f"it is systematic - re-rolling it again would buy the same defect twice."
                ),
            )
        )

    # Escalate only once the prompt is believed right: a more expensive tier
    # renders a bad prompt more expensively, it does not fix it.
    for tier in tier_order[1:]:
        steps.append(
            RepairStep(
                strategy="revise",
                model_tier=tier,
                reason=f"Cheaper tiers did not clear {target.category}; escalate the tier.",
            )
        )

    return steps[:renders_left]

"""The repair ladder: what a failed shot should cost to retry, and in what order.

Pure logic, no I/O. It decides how real money gets spent on a retry, which is
exactly the kind of rule that should be pinned by tests rather than discovered
on a bill.
"""

from agents.repair import TIER_ORDER, repair_steps, worst_failure
from models.contracts import QCFinding

CHEAPEST, MID, DEAREST = TIER_ORDER


def finding(verdict: str, category: str, severity: str = "warning") -> QCFinding:
    return QCFinding(
        category=category,
        verdict=verdict,  # type: ignore[arg-type]
        description="fixture",
        severity=severity,  # type: ignore[arg-type]
    )


class TestNothingToRepair:
    def test_no_fails_means_no_ladder(self) -> None:
        assert repair_steps([finding("pass", "hero_prop")], renders_left=3) == []

    def test_a_declined_axis_is_not_a_failure(self) -> None:
        """not_applicable must not trigger spend: nothing was observed, so
        nothing is known to be broken."""
        assert repair_steps([finding("not_applicable", "hero_prop")], renders_left=3) == []

    def test_no_renders_left_means_no_ladder(self) -> None:
        assert repair_steps([finding("fail", "hero_prop")], renders_left=0) == []


class TestFirstStepChoice:
    def test_a_first_time_failure_rerolls_on_the_cheapest_tier(self) -> None:
        """The v006 experiment, made cheap: re-run the same prompt to find out
        whether the defect is real before paying to rewrite anything."""
        steps = repair_steps([finding("fail", "temporal_stability")], renders_left=3)
        assert steps[0].strategy == "reroll"
        assert steps[0].model_tier == CHEAPEST

    def test_a_reproduced_failure_skips_the_reroll(self) -> None:
        """It has already shown up twice, so it is systematic - re-rolling would
        buy the same defect again."""
        steps = repair_steps(
            [finding("fail", "hero_prop")],
            renders_left=3,
            prior_failed_categories=frozenset({"hero_prop"}),
        )
        assert steps[0].strategy == "revise"
        assert steps[0].model_tier == CHEAPEST


class TestLadderShape:
    def test_it_escalates_tier_only_after_the_cheapest(self) -> None:
        steps = repair_steps([finding("fail", "hero_prop")], renders_left=3)
        assert [s.model_tier for s in steps] == [CHEAPEST, MID, DEAREST]

    def test_it_is_bounded_by_renders_left(self) -> None:
        steps = repair_steps([finding("fail", "hero_prop")], renders_left=2)
        assert len(steps) == 2
        assert steps[-1].model_tier == MID

    def test_it_never_opens_on_the_dearest_tier(self) -> None:
        """A more expensive tier renders a bad prompt more expensively; it does
        not fix it. The first retry is always the cheapest."""
        for prior in (frozenset(), frozenset({"hero_prop"})):
            steps = repair_steps(
                [finding("fail", "hero_prop")], renders_left=3, prior_failed_categories=prior
            )
            assert steps[0].model_tier == CHEAPEST


class TestTargeting:
    def test_the_worst_failure_is_the_most_severe_one(self) -> None:
        target = worst_failure(
            [
                finding("fail", "screen_direction", "warning"),
                finding("fail", "hero_prop", "critical"),
            ]
        )
        assert target is not None
        assert target.category == "hero_prop"

    def test_the_reason_names_what_it_is_targeting(self) -> None:
        steps = repair_steps([finding("fail", "hero_prop", "critical")], renders_left=1)
        assert "hero_prop" in steps[0].reason

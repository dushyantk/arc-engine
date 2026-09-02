"""The spending ceiling. Pure logic, no I/O.

This decides whether real money is allowed to be spent, so its edges are pinned
here rather than discovered on a bill.
"""

from agents.budget import BUDGET_ENV_VAR, evaluate_budget, read_ceiling


class TestReadCeiling:
    def test_unset_is_unlimited(self) -> None:
        assert read_ceiling({}) is None

    def test_blank_is_unlimited(self) -> None:
        assert read_ceiling({BUDGET_ENV_VAR: "   "}) is None

    def test_a_real_number_is_the_ceiling(self) -> None:
        assert read_ceiling({BUDGET_ENV_VAR: "40"}) == 40.0

    def test_a_typo_is_treated_as_unset_not_as_zero(self) -> None:
        """Refusing every run because someone mistyped a number would be a worse
        failure than not enforcing at all."""
        assert read_ceiling({BUDGET_ENV_VAR: "forty dollars"}) is None

    def test_zero_and_negative_are_unset_rather_than_a_total_freeze(self) -> None:
        assert read_ceiling({BUDGET_ENV_VAR: "0"}) is None
        assert read_ceiling({BUDGET_ENV_VAR: "-5"}) is None


class TestEvaluateBudget:
    def test_no_ceiling_allows_and_says_nothing_is_enforced(self) -> None:
        d = evaluate_budget(spent_usd=100.0, estimate_usd=50.0, ceiling_usd=None)
        assert d.allowed
        assert d.remaining_usd is None
        assert "nothing is enforced" in d.reason

    def test_it_checks_spend_plus_estimate_not_spend_alone(self) -> None:
        """A cap that only notices after the money is gone is a report, not a
        limit. $29.78 spent is under $30, but a $3.20 run is not."""
        d = evaluate_budget(spent_usd=29.78, estimate_usd=3.20, ceiling_usd=30.0)
        assert not d.allowed

    def test_a_run_that_fits_is_allowed(self) -> None:
        d = evaluate_budget(spent_usd=29.78, estimate_usd=3.20, ceiling_usd=40.0)
        assert d.allowed
        assert d.remaining_usd is not None

    def test_landing_exactly_on_the_ceiling_is_allowed(self) -> None:
        d = evaluate_budget(spent_usd=36.80, estimate_usd=3.20, ceiling_usd=40.0)
        assert d.allowed

    def test_the_refusal_says_what_would_fix_it(self) -> None:
        d = evaluate_budget(spent_usd=39.0, estimate_usd=3.20, ceiling_usd=40.0)
        assert not d.allowed
        assert BUDGET_ENV_VAR in d.reason
        assert "$1.00" in d.reason

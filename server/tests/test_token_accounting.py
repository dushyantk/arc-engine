"""What a model call is billed for, versus what it says in the obvious field.

Regression: every agent read `candidates_token_count` as its output count.
Thinking tokens are billed at the output rate and are not in that field, so a
real gemini-3.1-pro-preview call reporting 205 candidate tokens had 974 thinking
tokens - 83% of the billed output missing from the ledger. That ledger now has
the authority to refuse runs against a budget ceiling, so undercounting means
spending past a cap the operator set and believes is holding.
"""

from types import SimpleNamespace

from agents.decision_log import estimate_token_cost, get_image_pricing, token_usage


def response(**usage: int | None) -> SimpleNamespace:
    return SimpleNamespace(usage_metadata=SimpleNamespace(**usage))


class TestThinkingTokens:
    def test_thinking_tokens_are_billed_as_output(self) -> None:
        """The exact figures measured against the real API."""
        r = response(
            prompt_token_count=14,
            candidates_token_count=205,
            thoughts_token_count=974,
            total_token_count=1193,
        )
        assert token_usage(r) == (14, 1179)

    def test_the_naive_read_would_have_undercounted(self) -> None:
        """Guards the regression directly: whatever this returns, it must not be
        the candidates count on a response that also did thinking."""
        r = response(
            prompt_token_count=14,
            candidates_token_count=205,
            thoughts_token_count=974,
            total_token_count=1193,
        )
        _, tokens_out = token_usage(r)
        assert tokens_out != 205
        assert tokens_out > 205

    def test_a_call_that_did_not_think_is_unaffected(self) -> None:
        """Measured on gemini-3.1-flash-image: total is exactly prompt +
        candidates, so the fix must not inflate a non-thinking call."""
        r = response(
            prompt_token_count=33,
            candidates_token_count=1512,
            thoughts_token_count=0,
            total_token_count=1545,
        )
        assert token_usage(r) == (33, 1512)


class TestDegradedResponses:
    """A response missing fields must not silently zero out real spend, and must
    never credit spend back."""

    def test_no_usage_metadata_at_all(self) -> None:
        assert token_usage(SimpleNamespace()) == (0, 0)

    def test_missing_total_falls_back_to_candidates_plus_thoughts(self) -> None:
        r = response(
            prompt_token_count=10,
            candidates_token_count=100,
            thoughts_token_count=50,
            total_token_count=0,
        )
        assert token_usage(r) == (10, 150)

    def test_missing_total_and_thoughts_falls_back_to_candidates(self) -> None:
        r = response(prompt_token_count=10, candidates_token_count=100, total_token_count=0)
        assert token_usage(r) == (10, 100)

    def test_a_nonsense_total_never_reports_less_than_candidates(self) -> None:
        """A total smaller than the prompt would compute a negative output and
        credit spend back. Floored at the candidates count instead."""
        r = response(prompt_token_count=900, candidates_token_count=100, total_token_count=5)
        _, tokens_out = token_usage(r)
        assert tokens_out >= 100

    def test_none_valued_fields_are_treated_as_zero(self) -> None:
        r = response(
            prompt_token_count=None, candidates_token_count=None,
            thoughts_token_count=None, total_token_count=None,
        )
        assert token_usage(r) == (0, 0)


class TestImagePricing:
    """Image models bill through generateContent like the text models, so they
    are priced per token and the per-image figure is derived, not stored twice."""

    def test_every_reachable_image_model_has_a_price(self) -> None:
        pricing = get_image_pricing()
        for name in (
            "gemini-3.1-flash-image",
            "gemini-3.1-flash-lite-image",
            "gemini-3-pro-image",
            "gemini-2.5-flash-image",
        ):
            assert pricing.get(name, 0) > 0, f"{name} would log $0.00 against a real charge"

    def test_the_recommended_model_is_not_the_dearest(self) -> None:
        pricing = get_image_pricing()
        assert pricing["gemini-3.1-flash-image"] < pricing["gemini-3-pro-image"]

    def test_a_real_measured_call_costs_what_the_estimate_says(self) -> None:
        """The estimate shown before consent and the cost logged after a call
        must agree for the call that was actually measured."""
        measured = estimate_token_cost("gemini-3.1-flash-image", 33, 1512)
        assert abs(measured - get_image_pricing()["gemini-3.1-flash-image"]) < 0.001

    def test_an_unpriced_model_costs_zero_and_is_therefore_never_spendable(self) -> None:
        """Documents why `priced` exists: the cost function cannot distinguish
        free from unknown, so the catalogue has to."""
        assert estimate_token_cost("some-model-we-have-no-rate-for", 1000, 1000) == 0.0

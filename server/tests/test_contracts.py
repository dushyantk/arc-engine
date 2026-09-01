"""The deterministic half of the system: contracts and the approval gate.

These need nothing running and cost nothing. They cover the rules that decide
whether real money gets spent and whether a shot is allowed to ship, which is
exactly the logic that should not be verified by running it against Veo.
"""

from collections.abc import Iterator
from typing import Any

import pytest
from pydantic import ValidationError

from agents import approval
from agents.approval import evaluate, resolve_shot_status
from models.contracts import QCFinding


@pytest.fixture(autouse=True)
def no_decision_log(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """evaluate() logs its decision to ClickHouse as a side effect, so calling it
    from a test writes rows into the real agent_decision_log - which the landing
    page counts. Caught the hard way: an early run of this file put 8 rows into
    the live log and moved the number the product reports. Autouse so a new test
    in this module cannot reintroduce it by forgetting.
    """

    def _noop(*args: Any, **kwargs: Any) -> None:
        return None

    monkeypatch.setattr(approval, "log_decision", _noop)
    yield


def finding(verdict: str, category: str = "hero_prop", severity: str = "warning") -> QCFinding:
    return QCFinding(
        category=category,
        verdict=verdict,  # type: ignore[arg-type]
        description="fixture",
        severity=severity,  # type: ignore[arg-type]
    )


class TestQCFindingContract:
    """Malformed critic output is a hard stop, never a silent pass - the
    architecture's "bad handoffs fail loudly" rule, at the boundary where a
    swallowed error would let a defective shot through the gate."""

    def test_rejects_unknown_verdict(self) -> None:
        with pytest.raises(ValidationError):
            QCFinding(
                category="hero_prop",
                verdict="probably_fine",  # type: ignore[arg-type]
                description="x",
                severity="warning",
            )

    def test_rejects_missing_description(self) -> None:
        with pytest.raises(ValidationError):
            QCFinding(  # type: ignore[call-arg]
                category="hero_prop",
                verdict="fail",
                severity="warning",
            )

    def test_accepts_a_well_formed_finding(self) -> None:
        assert finding("pass").verdict == "pass"


class TestApprovalGate:
    """Deterministic, not agentic: a shot is approved only when every hard-fail
    category passes, and a cap-out escalates rather than looping or
    rubber-stamping."""

    def test_all_pass_approves(self) -> None:
        result = evaluate(
            [finding("pass"), finding("pass", "screen_direction")],
            1,
            run_id="test",
            shot_code="SH999",
        )
        assert result == "approved"

    def test_warnings_alone_still_approve(self) -> None:
        result = evaluate([finding("pass"), finding("warning")], 1, run_id="test", shot_code="SH999")
        assert result == "approved"

    def test_a_single_fail_blocks(self) -> None:
        result = evaluate([finding("pass"), finding("fail")], 1, run_id="test", shot_code="SH999")
        assert result == "revise"

    def test_failing_at_the_round_cap_escalates_to_a_human(self) -> None:
        result = evaluate([finding("fail")], 4, run_id="test", shot_code="SH999")
        assert result == "needs_human"


class TestNotApplicableAxes:
    """An axis the critic could not observe must block nothing, and must not be
    laundered into a pass. Scoring a category on a shot that cannot show it is
    how a framing choice becomes a phantom defect."""

    def test_a_declined_axis_does_not_block(self) -> None:
        result = evaluate(
            [finding("pass"), finding("not_applicable", "hero_prop")],
            1,
            run_id="test",
            shot_code="SH999",
        )
        assert result == "approved"

    def test_a_declined_axis_is_not_counted_as_a_pass(self) -> None:
        """The reason line has to distinguish "checked and fine" from "not
        checked", or an approval quietly means nothing was looked at."""
        findings = [finding("pass"), finding("not_applicable", "hero_prop")]
        checked = [f for f in findings if f.verdict in ("pass", "fail", "warning")]
        declined = [f for f in findings if f.verdict == "not_applicable"]
        assert len(checked) == 1
        assert len(declined) == 1

    def test_a_real_fail_still_blocks_alongside_declined_axes(self) -> None:
        result = evaluate(
            [finding("not_applicable", "hero_prop"), finding("fail", "temporal_stability")],
            1,
            run_id="test",
            shot_code="SH999",
        )
        assert result == "revise"

    def test_every_axis_declined_still_approves_but_checked_nothing(self) -> None:
        """Honest edge: nothing observable means nothing failed. It approves,
        and the recorded reason has to say zero axes were checked."""
        result = evaluate(
            [finding("not_applicable"), finding("not_applicable", "screen_direction")],
            1,
            run_id="test",
            shot_code="SH999",
        )
        assert result == "approved"


class TestResolveShotStatus:
    """Latest and approved are independent axes. A later version - unevaluated,
    or deliberately fired after an approval landed - must not revoke it."""

    def test_a_later_failure_leaves_an_earlier_approval_standing(self) -> None:
        assert resolve_shot_status("revise", shot_has_approved_version=True) == "approved"

    def test_a_recritique_of_an_old_version_does_not_move_the_shot(self) -> None:
        assert resolve_shot_status("needs_human", shot_has_approved_version=True) == "approved"

    def test_with_nothing_approved_the_verdict_carries(self) -> None:
        assert resolve_shot_status("revise", shot_has_approved_version=False) == "revise"
        assert resolve_shot_status("needs_human", shot_has_approved_version=False) == "needs_human"

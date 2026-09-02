"""Materialisation rules: the point where a cheap text re-plan meets rows that
cost real money to generate.

The rule under test is that a shot with versions is untouchable. Everything else
here exists to prove that rule holds under the cases a re-breakdown actually
produces - a renamed shot, a revised brief, a shot that quietly vanished from
the new script.
"""

import pytest

from agents.materialise import DuplicateShotCode, ExistingShot, plan_materialisation
from models.contracts import BreakdownSequence, BreakdownShot, SceneBreakdown


def shot(code: str, brief: str = "a brief", order: int = 0) -> BreakdownShot:
    return BreakdownShot(
        code=code, order_index=order, screen_direction="static, faces camera", brief=brief
    )


def breakdown(*shots: BreakdownShot, seq: str = "SQ010") -> SceneBreakdown:
    return SceneBreakdown(
        sequences=[BreakdownSequence(code=seq, description="a sequence", shots=list(shots))],
        assets=[],
    )


def existing_shot(code: str, brief: str | None = "a brief", *, versions: bool = False) -> ExistingShot:
    return ExistingShot(code=code, brief=brief, has_versions=versions)


class TestNothingExistsYet:
    def test_every_shot_is_a_create_on_a_fresh_show(self) -> None:
        plan = plan_materialisation(breakdown(shot("SH010"), shot("SH020")), existing={})
        assert [s.action for s in plan.sequences[0].shots] == ["create", "create"]
        assert plan.sequences[0].action == "create"
        assert plan.creates == 2

    def test_an_existing_sequence_is_reused_not_recreated(self) -> None:
        plan = plan_materialisation(
            breakdown(shot("SH010")), existing={"SQ010": {}}
        )
        assert plan.sequences[0].action == "reuse"


class TestSpentWorkIsUntouchable:
    """The rule the whole module exists for. A shot with versions has had real
    money spent on it; a text re-plan must not be able to rewrite it."""

    def test_a_shot_with_versions_is_skipped_even_when_the_brief_changed(self) -> None:
        plan = plan_materialisation(
            breakdown(shot("SH010", brief="a completely different brief")),
            existing={"SQ010": {"SH010": existing_shot("SH010", "the paid-for brief", versions=True)}},
        )
        only = plan.sequences[0].shots[0]
        assert only.action == "skip_protected"
        assert plan.updates == 0
        assert plan.protected == 1

    def test_the_protected_shot_keeps_its_own_brief_not_the_proposed_one(self) -> None:
        """The plan carries the proposed brief for display, but the action is
        what decides whether it is ever written. Asserting both so a future
        change cannot make 'skip' quietly mean 'write'."""
        plan = plan_materialisation(
            breakdown(shot("SH010", brief="proposed")),
            existing={"SQ010": {"SH010": existing_shot("SH010", "paid for", versions=True)}},
        )
        assert plan.sequences[0].shots[0].brief == "proposed"
        assert plan.sequences[0].shots[0].action == "skip_protected"

    def test_an_unversioned_shot_beside_a_versioned_one_still_updates(self) -> None:
        """Protection is per shot, not per sequence - one paid shot must not
        freeze the rest of the sequence."""
        plan = plan_materialisation(
            breakdown(shot("SH010", brief="new"), shot("SH020", brief="new")),
            existing={
                "SQ010": {
                    "SH010": existing_shot("SH010", "old", versions=True),
                    "SH020": existing_shot("SH020", "old", versions=False),
                }
            },
        )
        assert [s.action for s in plan.sequences[0].shots] == ["skip_protected", "update_brief"]


class TestUnspentShots:
    def test_a_changed_brief_on_an_unversioned_shot_updates(self) -> None:
        plan = plan_materialisation(
            breakdown(shot("SH010", brief="revised")),
            existing={"SQ010": {"SH010": existing_shot("SH010", "original")}},
        )
        assert plan.sequences[0].shots[0].action == "update_brief"

    def test_an_identical_brief_is_not_rewritten(self) -> None:
        plan = plan_materialisation(
            breakdown(shot("SH010", brief="same")),
            existing={"SQ010": {"SH010": existing_shot("SH010", "same")}},
        )
        assert plan.sequences[0].shots[0].action == "skip_unchanged"
        assert plan.updates == 0

    def test_a_shot_that_never_had_a_brief_gets_one(self) -> None:
        plan = plan_materialisation(
            breakdown(shot("SH010", brief="finally")),
            existing={"SQ010": {"SH010": existing_shot("SH010", None)}},
        )
        assert plan.sequences[0].shots[0].action == "update_brief"


class TestOrphans:
    """A shot the new breakdown dropped is reported, never deleted. The plan
    itemises it so a human decides - that is what the non-destructive rule
    means in practice."""

    def test_a_dropped_shot_is_reported(self) -> None:
        plan = plan_materialisation(
            breakdown(shot("SH010")),
            existing={
                "SQ010": {"SH010": existing_shot("SH010"), "SH020": existing_shot("SH020")}
            },
        )
        assert plan.orphaned == ["SQ010/SH020"]

    def test_no_plan_action_ever_removes_anything(self) -> None:
        plan = plan_materialisation(
            breakdown(shot("SH010")),
            existing={"SQ010": {"SH020": existing_shot("SH020", versions=True)}},
        )
        actions = {s.action for seq in plan.sequences for s in seq.shots}
        assert actions <= {"create", "update_brief", "skip_protected", "skip_unchanged"}
        assert plan.orphaned == ["SQ010/SH020"]

    def test_a_whole_dropped_sequence_is_reported_shot_by_shot(self) -> None:
        plan = plan_materialisation(
            breakdown(shot("SH010"), seq="SQ020"),
            existing={"SQ010": {"SH010": existing_shot("SH010"), "SH020": existing_shot("SH020")}},
        )
        assert plan.orphaned == ["SQ010/SH010", "SQ010/SH020"]


class TestNoOpPlans:
    def test_a_re_run_that_changes_nothing_says_so(self) -> None:
        """Re-breaking an unchanged script must not offer a button that quietly
        writes nothing."""
        plan = plan_materialisation(
            breakdown(shot("SH010", brief="same")),
            existing={"SQ010": {"SH010": existing_shot("SH010", "same")}},
        )
        assert plan.writes_nothing

    def test_a_plan_that_only_protects_still_writes_nothing(self) -> None:
        plan = plan_materialisation(
            breakdown(shot("SH010", brief="new")),
            existing={"SQ010": {"SH010": existing_shot("SH010", "old", versions=True)}},
        )
        assert plan.writes_nothing

    def test_a_new_sequence_with_no_new_shots_is_not_a_no_op(self) -> None:
        plan = plan_materialisation(breakdown(shot("SH010")), existing={})
        assert not plan.writes_nothing


class TestDuplicateShotCodes:
    """Shot codes are how the rest of the system names a shot - runs resolve by
    code, cost is attributed by code. Two shots sharing one is unresolvable
    downstream, so it is refused here rather than written and discovered later.

    Regression: the first real breakdown restarted numbering per sequence,
    producing three SH010s in one show. The shots materialised fine and then
    could not be run at all.
    """

    def test_the_same_code_twice_in_one_sequence_is_refused(self) -> None:
        with pytest.raises(DuplicateShotCode):
            plan_materialisation(breakdown(shot("SH010"), shot("SH010")), existing={})

    def test_the_same_code_across_sequences_is_refused(self) -> None:
        colliding = SceneBreakdown(
            sequences=[
                BreakdownSequence(code="SQ010", description="one", shots=[shot("SH010")]),
                BreakdownSequence(code="SQ020", description="two", shots=[shot("SH010")]),
            ],
            assets=[],
        )
        with pytest.raises(DuplicateShotCode) as exc:
            plan_materialisation(colliding, existing={})
        # The message has to name both sequences, or the operator cannot find
        # which two shots collided.
        assert "SQ010" in str(exc.value) and "SQ020" in str(exc.value)

    def test_codes_unique_across_sequences_are_fine(self) -> None:
        fine = SceneBreakdown(
            sequences=[
                BreakdownSequence(code="SQ010", description="one", shots=[shot("SH010")]),
                BreakdownSequence(code="SQ020", description="two", shots=[shot("SH020")]),
            ],
            assets=[],
        )
        assert plan_materialisation(fine, existing={}).creates == 2

    def test_nothing_is_planned_when_the_breakdown_is_refused(self) -> None:
        """The guard runs before any planning, so a refused breakdown cannot
        half-produce a plan somebody then applies."""
        with pytest.raises(DuplicateShotCode):
            plan_materialisation(
                breakdown(shot("SH010"), shot("SH020"), shot("SH010")), existing={}
            )

"""Turning an approved breakdown into real rows - decided here, applied elsewhere.

This module computes a plan and writes nothing. That split is deliberate: these
are the rules where being wrong destroys work that cost real money, so they are
pure, unit-tested, and reviewable as a list before a single row is written.

The governing rule is that **a shot with versions is untouchable**. Versions are
the record of real Veo spend. A re-breakdown after a script revision is a cheap
text operation; letting it rewrite the brief under a shot somebody already paid
to generate would make that spend collateral damage of a re-plan. So such shots
are reported and skipped, never updated.

Nothing here deletes anything, ever. A shot that exists but the new breakdown no
longer proposes is reported as orphaned so a human can see it and decide - which
is what "destructive changes only on an explicit, itemised confirmation" means
in practice. The itemisation is the plan; the confirmation is a human reading it.
"""

from typing import Literal

from pydantic import BaseModel, Field

from models.contracts import SceneBreakdown


class DuplicateShotCode(Exception):
    """A breakdown proposed the same shot code twice within one show.

    A hard stop, not a warning. Shot codes are how the rest of the system names
    a shot - `find_shot_by_code` resolves runs by code, and the decision log
    attributes cost by code - so two shots sharing one is an ambiguity nothing
    downstream can resolve, and materialising it writes rows that can never be
    run. Caught the hard way: the first real breakdown restarted numbering per
    sequence, which produced three SH010s in one show and made the run trigger
    fail with an error that blamed the operator.

    The agent is told not to do this, but a prompt is guidance and this is a
    guarantee. Enforced here so no caller has to remember.
    """


ShotAction = Literal["create", "update_brief", "skip_protected", "skip_unchanged"]
SequenceAction = Literal["create", "reuse"]


class ExistingShot(BaseModel):
    """What materialisation needs to know about a shot that already exists."""

    code: str
    brief: str | None
    # The single fact that decides whether this shot may be touched. True means
    # real money has been spent generating it.
    has_versions: bool


class ShotPlan(BaseModel):
    code: str
    order_index: int
    screen_direction: str
    brief: str
    action: ShotAction
    # Written for a human reading the plan before approving it, not for a log.
    reason: str


class SequencePlan(BaseModel):
    code: str
    description: str
    action: SequenceAction
    shots: list[ShotPlan]


class MaterialisationPlan(BaseModel):
    sequences: list[SequencePlan]
    # Shots that exist but this breakdown no longer proposes. Reported, never
    # acted on - the plan itemises them so a human can decide, which is the only
    # way anything destructive is allowed to happen.
    orphaned: list[str] = Field(default_factory=list)

    @property
    def creates(self) -> int:
        return sum(1 for s in self.sequences for shot in s.shots if shot.action == "create")

    @property
    def updates(self) -> int:
        return sum(1 for s in self.sequences for shot in s.shots if shot.action == "update_brief")

    @property
    def protected(self) -> int:
        return sum(1 for s in self.sequences for shot in s.shots if shot.action == "skip_protected")

    @property
    def writes_nothing(self) -> bool:
        """True when applying this plan would change no row. The UI says so
        rather than offering a button that quietly does nothing."""
        return self.creates == 0 and self.updates == 0 and not any(
            s.action == "create" for s in self.sequences
        )


def plan_materialisation(
    breakdown: SceneBreakdown,
    *,
    existing: dict[str, dict[str, ExistingShot]],
) -> MaterialisationPlan:
    """Diffs a proposed breakdown against what is already in Postgres.

    `existing` is sequence code -> shot code -> shot, for the show being planned.
    Codes are the join key because they are what a breakdown proposes and what an
    operator reads; ids do not exist yet for anything being created.

    Raises DuplicateShotCode if the breakdown names one shot code twice.
    """
    _reject_duplicate_shot_codes(breakdown)

    sequences: list[SequencePlan] = []
    proposed_codes: set[tuple[str, str]] = set()

    for seq in breakdown.sequences:
        seq_exists = seq.code in existing
        known = existing.get(seq.code, {})

        shots: list[ShotPlan] = []
        for shot in seq.shots:
            proposed_codes.add((seq.code, shot.code))
            prior = known.get(shot.code)

            if prior is None:
                action: ShotAction = "create"
                reason = "New shot; nothing exists under this code."
            elif prior.has_versions:
                action = "skip_protected"
                reason = (
                    "Already has generated versions, so its brief is left alone - "
                    "re-planning must not rewrite a shot that has been paid for."
                )
            elif prior.brief == shot.brief:
                action = "skip_unchanged"
                reason = "Exists with an identical brief; nothing to write."
            else:
                action = "update_brief"
                reason = "Exists with no versions yet, so its brief can be safely replaced."

            shots.append(
                ShotPlan(
                    code=shot.code,
                    order_index=shot.order_index,
                    screen_direction=shot.screen_direction,
                    brief=shot.brief,
                    action=action,
                    reason=reason,
                )
            )

        sequences.append(
            SequencePlan(
                code=seq.code,
                description=seq.description,
                action="reuse" if seq_exists else "create",
                shots=shots,
            )
        )

    orphaned = sorted(
        f"{seq_code}/{shot_code}"
        for seq_code, shots in existing.items()
        for shot_code in shots
        if (seq_code, shot_code) not in proposed_codes
    )

    return MaterialisationPlan(sequences=sequences, orphaned=orphaned)


def _reject_duplicate_shot_codes(breakdown: SceneBreakdown) -> None:
    seen: dict[str, str] = {}
    for seq in breakdown.sequences:
        for shot in seq.shots:
            if shot.code in seen:
                raise DuplicateShotCode(
                    f"shot code {shot.code!r} is proposed twice - in {seen[shot.code]} and "
                    f"{seq.code}. Shot codes must be unique across the whole show."
                )
            seen[shot.code] = seq.code

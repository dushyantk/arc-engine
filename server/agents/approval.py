"""Approval gate: deterministic, not agentic. A shot is approved only when
every hard-fail category passes. Warnings are tolerated but never silently
dropped — they're still on the record. Revision rounds are capped; on
cap-out the shot escalates to needs_human instead of looping forever or
auto-approving (ARCHITECTURE.md section 6).
"""

from agents.decision_log import log_decision
from models.contracts import QCFinding, ShotStatus

MAX_REVISION_ROUNDS = 4


def resolve_shot_status(
    version_verdict: ShotStatus, *, shot_has_approved_version: bool
) -> ShotStatus:
    """The shot's status, given the verdict just reached on one of its versions.

    RULE: every path that records a verdict resolves shots.status through this
    function. Do not write the version's own verdict straight onto the shot.

    Latest and approved are independent axes. An approval is a durable fact
    about one version, not a claim about whichever version happens to be newest.
    A later version may exist because it has not been evaluated yet, or because
    someone deliberately fired another take after the approval landed - neither
    revokes the approval, and being approved never locks the shot against
    generating more. Writing the latest verdict straight onto the shot is what
    made a re-critique of an old version silently move a shot's status.

    An explicit human veto is the one thing that does revoke an approval, and it
    does so by clearing that version's own status first, so the answer here
    follows from the record rather than from a special case.
    """
    if shot_has_approved_version:
        return "approved"
    return version_verdict


def evaluate(findings: list[QCFinding], version_number: int, *, run_id: str, shot_code: str) -> ShotStatus:
    fails = [f for f in findings if f.verdict == "fail"]
    warnings = [f for f in findings if f.verdict == "warning"]

    if not fails:
        status: ShotStatus = "approved"
        reason = f"0 fails, {len(warnings)} tolerated warning(s)."
    elif version_number >= MAX_REVISION_ROUNDS:
        status = "needs_human"
        reason = f"{len(fails)} fail(s) after {version_number} rounds, cap reached."
    else:
        status = "revise"
        reason = f"{len(fails)} fail(s): " + ", ".join(f.category for f in fails)

    log_decision(
        run_id=run_id,
        agent_name="approval_gate",
        step="evaluate",
        input_ref=f"shot:{shot_code}:v{version_number}",
        output_ref=f"{status}: {reason}",
        model="deterministic",
        tokens_in=0,
        tokens_out=0,
        cost_usd=0.0,
        latency_ms=0,
    )

    return status

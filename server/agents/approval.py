"""Approval gate: deterministic, not agentic. A shot is approved only when
every hard-fail category passes. Warnings are tolerated but never silently
dropped — they're still on the record. Revision rounds are capped; on
cap-out the shot escalates to needs_human instead of looping forever or
auto-approving (ARCHITECTURE.md section 6).
"""

from agents.decision_log import log_decision
from models.contracts import QCFinding, ShotStatus

MAX_REVISION_ROUNDS = 4


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

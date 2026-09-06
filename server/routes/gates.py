"""HTTP-level gates every billed endpoint goes through.

RULE: any route that triggers a real, billed model call calls `require_budget()`
before making it, and `require_consent()` if the caller is a human choosing to
spend. Do not re-derive either check inline - the Veo path and the image path
had different pricing units and would otherwise have grown two copies of the
same ceiling logic, which is how one of them ends up not enforcing it.

The gates raise HTTP errors because refusing to spend is an answer to a request,
not an internal failure: 402 for a ceiling breach, 400 for missing consent.
"""

from fastapi import HTTPException

from agents.budget import evaluate_budget, read_ceiling, total_spent_usd


def require_budget(estimate_usd: float) -> None:
    """Refuse a billed call that would breach the configured ceiling.

    Checked before the call, not after: a cap that only notices once the money
    is gone is a report. Unset means unlimited and enforces nothing - see
    agents/budget.py for why it does not default to a number nobody chose.

    Takes an estimate in dollars rather than a model name, because video bills
    per second and images bill per token; the caller knows its own unit and this
    does not need to.
    """
    decision = evaluate_budget(
        spent_usd=total_spent_usd(),
        estimate_usd=estimate_usd,
        ceiling_usd=read_ceiling(),
    )
    if not decision.allowed:
        raise HTTPException(status_code=402, detail=decision.reason)


def require_consent(confirmed: bool, what: str) -> None:
    """A real charge needs a human saying yes to it, in the same request.

    `what` completes "this triggers a real, billed ..." so the refusal names the
    thing being paid for rather than making the caller guess which gate fired.
    """
    if not confirmed:
        raise HTTPException(
            status_code=400,
            detail=f"confirm_cost must be true - this triggers a real, billed {what}.",
        )

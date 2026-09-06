"""Shared-secret guard for the agent runtime.

The web app has its own sign-in, but that protects the browser, not this
process. Every endpoint that spends money lives here, so a runtime reachable on
a public address is spendable by anyone who finds it - authenticating the
dashboard alone would produce exactly the false sense of safety this is meant to
remove.

Next.js is the only client: `lib/runtime.ts` proxies every call server-side and
attaches the token, so the browser never sees it.

Unset means open, and says so loudly at startup and in /health - the same shape
as the budget ceiling, which does not invent a default nobody chose. That is
right for a laptop and wrong for a deployment, which is why it is stated rather
than assumed. `require_runtime_token()` is what makes the difference visible.
"""

import hmac
import os
import sys

from fastapi import Header, HTTPException

TOKEN_ENV_VAR = "AGENT_RUNTIME_TOKEN"


def configured_token() -> str | None:
    token = os.environ.get(TOKEN_ENV_VAR, "").strip()
    return token or None


def is_open() -> bool:
    return configured_token() is None


def announce() -> None:
    """Printed once at startup. An open runtime should never be a surprise."""
    if is_open():
        print(
            f"WARNING: {TOKEN_ENV_VAR} is not set - every endpoint on this runtime is "
            "open, including the ones that spend money. Fine on a laptop; set it "
            "before this is reachable from anywhere else.",
            file=sys.stderr,
        )
    else:
        print(f"{TOKEN_ENV_VAR} set - runtime requires a token.", file=sys.stderr)


async def require_runtime_token(
    x_dailies_token: str | None = Header(default=None),
) -> None:
    """FastAPI dependency. Applied to the routers, not to /health.

    RULE: every router mounted on this app carries this dependency. A new router
    added without it is reachable by anyone, and nothing else in the system will
    notice - `test_runtime_auth.py` enumerates the app's routes so that omission
    fails a test rather than shipping.
    """
    expected = configured_token()
    if expected is None:
        return
    # compare_digest, not ==: a plain comparison returns early on the first
    # differing byte and leaks the token's prefix to a patient caller.
    if x_dailies_token is None or not hmac.compare_digest(x_dailies_token, expected):
        raise HTTPException(status_code=401, detail="Invalid or missing runtime token.")

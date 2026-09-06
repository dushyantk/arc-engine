"""The runtime's shared-secret gate.

The web app's sign-in protects a browser, not this process. Every endpoint that
spends money lives here, so an ungated runtime on a public address is spendable
by whoever finds it — and the dashboard's login would make that look safe.
"""

import pytest
from fastapi.testclient import TestClient

import runtime_auth
from main import app

client = TestClient(app)


@pytest.fixture
def gated(monkeypatch: pytest.MonkeyPatch) -> str:
    token = "test-token-value"
    monkeypatch.setenv(runtime_auth.TOKEN_ENV_VAR, token)
    return token


_ALWAYS_OPEN = {"/health", "/openapi.json", "/docs", "/redoc", "/docs/oauth2-redirect"}


def _gated_paths() -> tuple[set[str], set[str]]:
    """Every route the app serves, split into (gated, ungated).

    Handles both shapes FastAPI uses: routers included as `_IncludedRouter`,
    where the dependency sits on the include context, and routes flattened onto
    the app, where it sits on the route's own dependant. Reading only one shape
    is how this check silently stops checking after a version bump.
    """
    gated: set[str] = set()
    ungated: set[str] = set()

    for route in app.routes:
        included = getattr(route, "original_router", None)
        if included is not None:
            context = getattr(route, "include_context", None)
            names = [
                d.dependency.__name__
                for d in (getattr(context, "dependencies", None) or [])
                if d.dependency
            ]
            target = gated if "require_runtime_token" in names else ungated
            for inner in included.routes:
                target.add(getattr(inner, "path", ""))
            continue

        path = getattr(route, "path", "")
        if path in _ALWAYS_OPEN:
            continue
        dependant = getattr(route, "dependant", None)
        names = (
            [d.call.__name__ for d in dependant.dependencies if d.call] if dependant else []
        )
        (gated if "require_runtime_token" in names else ungated).add(path)

    return gated, ungated


class TestEveryRouterIsGated:
    """The rule that cannot rely on memory: a router added without the
    dependency is reachable by anyone, and nothing else would notice."""

    def test_no_route_is_reachable_without_a_token(self) -> None:
        _, ungated = _gated_paths()
        assert not ungated, (
            f"these routes are reachable without a token: {sorted(ungated)}. "
            "Mount their router with dependencies=[Depends(require_runtime_token)]."
        )

    def test_the_scan_actually_sees_the_routes_that_spend_money(self) -> None:
        """Guards the guard: if the traversal stops matching FastAPI's internals
        it would find nothing and pass, so name the endpoints that must appear."""
        gated, ungated = _gated_paths()
        for path in ("/runs/generate", "/sheets/generate", "/breakdowns/propose"):
            assert path in gated | ungated, f"{path} was not found by the scan at all"

    def test_health_is_deliberately_not_gated(self) -> None:
        """A load balancer has to reach it, and it exposes only liveness."""
        gated, ungated = _gated_paths()
        assert "/health" not in gated and "/health" not in ungated


class TestWithATokenConfigured:
    def test_a_missing_token_is_refused(self, gated: str) -> None:
        assert client.get("/runs/budget").status_code == 401

    def test_a_wrong_token_is_refused(self, gated: str) -> None:
        response = client.get("/runs/budget", headers={"X-Dailies-Token": "nope"})
        assert response.status_code == 401

    def test_the_right_token_is_let_through(self, gated: str) -> None:
        response = client.get("/runs/budget", headers={"X-Dailies-Token": gated})
        assert response.status_code == 200

    def test_health_stays_reachable_for_a_load_balancer(self, gated: str) -> None:
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json()["auth"] == "token"

    def test_the_refusal_does_not_echo_the_expected_token(self, gated: str) -> None:
        """An error must never hand back the secret it was checking against."""
        response = client.get("/runs/budget", headers={"X-Dailies-Token": "nope"})
        assert gated not in response.text


class TestWithNoTokenConfigured:
    """Unset means open, deliberately - a laptop should not need one. The point
    is that it is stated rather than assumed, so it cannot be a surprise."""

    def test_requests_are_allowed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(runtime_auth.TOKEN_ENV_VAR, raising=False)
        assert client.get("/runs/budget").status_code == 200

    def test_health_says_the_runtime_is_open(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(runtime_auth.TOKEN_ENV_VAR, raising=False)
        assert client.get("/health").json()["auth"] == "open"

    def test_whitespace_only_is_treated_as_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A token set to spaces in a .env is a mistake, not a secret. It must
        not read as configured while accepting nothing."""
        monkeypatch.setenv(runtime_auth.TOKEN_ENV_VAR, "   ")
        assert runtime_auth.is_open()

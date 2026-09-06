"""Every entrypoint loads the repo .env before it reads any setting.

A missing `env.bootstrap()` does not fail loudly. It silently substitutes every
default, which is the worst possible failure for a settings loader: the program
runs, reports success, and acts on the wrong configuration.

`clickhouse/migrate.py` went without it and applied a fresh checkout's schema to
whatever ClickHouse happened to be listening on the default port, printing
"done." while the database the operator had configured stayed empty. The next
command inherited the confusion and got blamed for it.

env.py states the rule; this enforces it, because a rule that depends on the
next author remembering is not a rule.
"""

from pathlib import Path

import pytest

SERVER_ROOT = Path(__file__).resolve().parent.parent

# A module is an entrypoint if it can be run directly, plus the ASGI app, which
# is started by uvicorn rather than by a __main__ block.
ALWAYS_ENTRYPOINTS = {"main.py"}


def entrypoints() -> list[Path]:
    found: list[Path] = []
    for path in SERVER_ROOT.rglob("*.py"):
        if any(part in {".venv", "__pycache__", "tests"} for part in path.parts):
            continue
        text = path.read_text()
        if '__name__ == "__main__"' in text or path.name in ALWAYS_ENTRYPOINTS:
            found.append(path)
    return sorted(found)


def test_the_discovery_actually_finds_the_known_entrypoints() -> None:
    """Guards the guard: if the scan silently matched nothing, every assertion
    below would pass while checking nothing at all."""
    names = {p.name for p in entrypoints()}
    assert {"main.py", "run_session.py", "migrate.py", "backfill_posters.py"} <= names


@pytest.mark.parametrize("path", entrypoints(), ids=lambda p: p.name)
def test_entrypoint_bootstraps_the_environment(path: Path) -> None:
    text = path.read_text()
    assert "bootstrap()" in text, (
        f"{path.relative_to(SERVER_ROOT)} can be run directly but never calls "
        "env.bootstrap(), so it will read defaults instead of the repo .env and "
        "quietly act on the wrong configuration. See server/env.py."
    )

"""Repo `.env` loading and unbuffered output for the server entrypoints.

RULE: every entrypoint under server/ calls bootstrap() before importing anything
that reads os.environ at module scope. Both halves of it bit for real:

- A bare `uv run python run_session.py` died with `KeyError: DATABASE_URL`,
  because the settings live in the repo `.env` and nothing loaded it. The web
  side gets this for free (`next` reads .env itself, and `pnpm db:seed` passes
  `--env-file`), so the Python side silently required a shell that happened to
  have exported the right variables.
- stdout is block-buffered when it is not a terminal, so a run's `run_id` -
  printed first, and needed to open the live session view - stayed invisible
  until the process exited. Watching a run in progress meant remembering to set
  PYTHONUNBUFFERED=1.

A missing call does not fail loudly - it silently substitutes every default,
which is the worst possible failure for a settings loader. `clickhouse/migrate.py`
went months without it and applied a fresh checkout's schema to whatever
ClickHouse happened to be on the default port, reporting success. That is why
the rule above is absolute and why `tests/test_entrypoints.py` enforces it
rather than trusting the next author to remember.

No dependency for this: python-dotenv would be a package for twenty lines, and
the format here is only ever KEY=value.
"""

import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def load_repo_env(env_path: Path | None = None) -> int:
    """Loads the repo `.env` into os.environ. Returns how many keys it set.

    Never overwrites a variable that is already set, so an explicit
    `DATABASE_URL=... uv run ...` still wins over the file.
    """
    path = env_path or REPO_ROOT / ".env"
    if not path.exists():
        return 0

    applied = 0
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value
            applied += 1
    return applied


def unbuffer_stdout() -> None:
    """Line-buffers stdout so progress is visible while a run is still going."""
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)


def bootstrap() -> None:
    load_repo_env()
    unbuffer_stdout()

"""The single-run lock, held in Postgres.

It used to be a module global. That is correct on one machine and silently wrong
on two: each instance believed it was idle, so two operators could start two
billed runs at the same moment and neither would be refused. Nothing else in the
system would have noticed until the bill.

Two properties matter, and both are easy to get subtly wrong:

**Acquisition is atomic.** A read-then-write ("is anyone running? no, then claim
it") has a gap, and two instances can both pass the read. The whole claim is one
INSERT ... ON CONFLICT whose WHERE decides the winner, so the database picks.

**A dead holder must not block forever.** A process that is killed cannot release
its lock, and a lock nobody can release is worse than no lock at all - every
future run refused, with no way to fix it but a manual DELETE. So the holder
refreshes a heartbeat while it works, and a lock whose heartbeat has gone quiet
can be taken over.
"""

import os
import socket
from dataclasses import dataclass
from uuid import uuid4

import asyncpg

LOCK_KEY = "global"

# How often a live run refreshes its claim.
HEARTBEAT_SECONDS = 15

# How quiet a lock must go before another instance may take it. Six missed
# heartbeats. Deliberately not tied to how long a run takes - the longest single
# step observed here is a 390s critique, and that does not matter, because the
# heartbeat runs as its own task and keeps ticking through it. What this bounds
# is how long a *crash* blocks the next run.
STALE_AFTER_SECONDS = 90


@dataclass(frozen=True)
class ActiveRun:
    run_id: str
    shot_code: str
    mode: str
    owner_id: str

    def as_dict(self) -> dict[str, str]:
        return {
            "run_id": self.run_id,
            "shot_code": self.shot_code,
            "mode": self.mode,
            "owner_id": self.owner_id,
        }


def owner_id() -> str:
    """Identifies this process in the lock row. Only ever used for diagnosis:
    once there is more than one instance, "who is holding this?" has no answer
    otherwise. Fly sets FLY_ALLOC_ID; elsewhere the hostname and pid will do."""
    return os.environ.get("FLY_ALLOC_ID") or f"{socket.gethostname()}:{os.getpid()}"


async def try_acquire(
    pool: asyncpg.Pool, *, run_id: str, shot_code: str, mode: str
) -> ActiveRun | None:
    """Claims the lock, or returns whoever already holds it.

    One statement, so there is no window between deciding and claiming. The
    ON CONFLICT arm only fires when the existing row has gone stale, which is
    what lets a crashed holder be displaced without letting a live one be.
    """
    row = await pool.fetchrow(
        """
        INSERT INTO run_locks (lock_key, run_id, shot_code, mode, owner_id,
                               started_at, heartbeat_at)
        VALUES ($1, $2, $3, $4, $5, now(), now())
        ON CONFLICT (lock_key) DO UPDATE
          SET run_id = EXCLUDED.run_id,
              shot_code = EXCLUDED.shot_code,
              mode = EXCLUDED.mode,
              owner_id = EXCLUDED.owner_id,
              started_at = now(),
              heartbeat_at = now()
          WHERE run_locks.heartbeat_at < now() - ($6 || ' seconds')::interval
        RETURNING run_id, shot_code, mode, owner_id
        """,
        LOCK_KEY,
        run_id,
        shot_code,
        mode,
        owner_id(),
        str(STALE_AFTER_SECONDS),
    )
    if row is not None and row["run_id"] == run_id:
        return None  # Acquired.

    # The conflicting row was live, so the UPDATE's WHERE excluded it and
    # RETURNING gave nothing. Read who actually holds it, for the refusal
    # message - an operator told "a run is in progress" with no idea which one
    # cannot act on that.
    held = await current(pool)
    # Lost a race and it finished in between: the caller should try again rather
    # than be told a run is in progress that no longer is.
    return held


async def current(pool: asyncpg.Pool) -> ActiveRun | None:
    """Who holds the lock right now, ignoring a stale claim.

    A stale row is reported as nothing rather than as a live run: it describes a
    process that is gone, and showing it as "running now" in the session list
    would be a claim the system cannot support.
    """
    row = await pool.fetchrow(
        """
        SELECT run_id, shot_code, mode, owner_id FROM run_locks
        WHERE lock_key = $1 AND heartbeat_at >= now() - ($2 || ' seconds')::interval
        """,
        LOCK_KEY,
        str(STALE_AFTER_SECONDS),
    )
    return ActiveRun(**dict(row)) if row else None


async def heartbeat(pool: asyncpg.Pool, *, run_id: str) -> bool:
    """Refreshes this run's claim. False if the lock is no longer ours - which
    means it went stale and someone took it, and the caller should know rather
    than keep working under a lock it does not hold."""
    result: str = await pool.execute(
        "UPDATE run_locks SET heartbeat_at = now() WHERE lock_key = $1 AND run_id = $2",
        LOCK_KEY,
        run_id,
    )
    # asyncpg returns the command tag, e.g. "UPDATE 1" / "UPDATE 0".
    return result.endswith(" 1")


async def release(pool: asyncpg.Pool, *, run_id: str) -> None:
    """Releases only our own claim. Scoped by run_id so a run that overran and
    was taken over cannot delete the lock its successor now holds."""
    await pool.execute(
        "DELETE FROM run_locks WHERE lock_key = $1 AND run_id = $2", LOCK_KEY, run_id
    )


def new_lock_owner_id() -> str:
    """Exposed for tests that need a second, distinct owner."""
    return f"test:{uuid4()}"


__all__ = [
    "HEARTBEAT_SECONDS",
    "LOCK_KEY",
    "STALE_AFTER_SECONDS",
    "ActiveRun",
    "current",
    "heartbeat",
    "owner_id",
    "release",
    "try_acquire",
]

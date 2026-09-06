"""The single-run lock, against real Postgres.

This is the piece that replaced a module global, and the bug it fixes only
appears with two callers at once — so the tests have to actually run two at
once. A test that acquires, releases, and acquires again would pass against the
broken version too.

Marked `stack` because the guarantee being tested *is* the database's: a
uniqueness constraint decides the winner, and an in-memory fake would be testing
something else entirely.
"""

import asyncio
import os
from collections.abc import AsyncIterator

import asyncpg
import pytest

import run_lock

pytestmark = pytest.mark.stack


@pytest.fixture
async def pool() -> AsyncIterator[asyncpg.Pool]:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("DATABASE_URL not set")
    try:
        created = await asyncpg.create_pool(dsn, min_size=1, max_size=8)
    except Exception:  # noqa: BLE001 - stack down is a skip, not a failure
        pytest.skip("Postgres is not reachable")
    assert created is not None
    # Never leaves a claim behind: a stuck lock would refuse every real run.
    await created.execute("DELETE FROM run_locks")
    try:
        yield created
    finally:
        await created.execute("DELETE FROM run_locks")
        await created.close()


class TestOneRunAtATime:
    async def test_the_first_caller_gets_it(self, pool: asyncpg.Pool) -> None:
        assert await run_lock.try_acquire(pool, run_id="a", shot_code="SH010", mode="generate") is None

    async def test_a_second_caller_is_told_who_holds_it(self, pool: asyncpg.Pool) -> None:
        await run_lock.try_acquire(pool, run_id="a", shot_code="SH010", mode="generate")
        held = await run_lock.try_acquire(pool, run_id="b", shot_code="SH020", mode="recritique")
        assert held is not None
        # The refusal has to name the run in progress: "a run is in progress"
        # with no idea which one is not something an operator can act on.
        assert held.run_id == "a"
        assert held.shot_code == "SH010"
        assert held.mode == "generate"

    async def test_only_one_of_many_simultaneous_callers_wins(self, pool: asyncpg.Pool) -> None:
        """The actual bug. Ten callers race; exactly one may acquire.

        The old module global passed the equivalent of every other test here and
        failed this one across processes.
        """
        results = await asyncio.gather(
            *(
                run_lock.try_acquire(pool, run_id=f"r{i}", shot_code="SH010", mode="generate")
                for i in range(10)
            )
        )
        acquired = [r for r in results if r is None]
        assert len(acquired) == 1, f"{len(acquired)} callers acquired the same lock"

    async def test_releasing_lets_the_next_caller_in(self, pool: asyncpg.Pool) -> None:
        await run_lock.try_acquire(pool, run_id="a", shot_code="SH010", mode="generate")
        await run_lock.release(pool, run_id="a")
        assert await run_lock.try_acquire(pool, run_id="b", shot_code="SH020", mode="generate") is None


class TestADeadHolderDoesNotBlockForever:
    """A process that is killed cannot release its lock. A lock nobody can
    release is worse than no lock: every future run refused, with no fix but a
    manual DELETE."""

    async def test_a_stale_claim_can_be_taken_over(self, pool: asyncpg.Pool) -> None:
        await run_lock.try_acquire(pool, run_id="dead", shot_code="SH010", mode="generate")
        await _age_heartbeat(pool, run_lock.STALE_AFTER_SECONDS + 5)
        assert await run_lock.try_acquire(pool, run_id="new", shot_code="SH020", mode="generate") is None

    async def test_a_stale_claim_is_not_reported_as_running(self, pool: asyncpg.Pool) -> None:
        """It describes a process that is gone. Showing it as "running now"
        would be a claim the system cannot support."""
        await run_lock.try_acquire(pool, run_id="dead", shot_code="SH010", mode="generate")
        await _age_heartbeat(pool, run_lock.STALE_AFTER_SECONDS + 5)
        assert await run_lock.current(pool) is None

    async def test_a_live_claim_is_never_stolen(self, pool: asyncpg.Pool) -> None:
        """The other half: expiry must not be so eager that a healthy run loses
        its lock mid-flight."""
        await run_lock.try_acquire(pool, run_id="alive", shot_code="SH010", mode="generate")
        await _age_heartbeat(pool, run_lock.STALE_AFTER_SECONDS - 30)
        held = await run_lock.try_acquire(pool, run_id="thief", shot_code="SH020", mode="generate")
        assert held is not None and held.run_id == "alive"

    async def test_a_heartbeat_keeps_a_long_run_alive(self, pool: asyncpg.Pool) -> None:
        """A 390s critique is normal here, so the claim has to survive one."""
        await run_lock.try_acquire(pool, run_id="long", shot_code="SH010", mode="generate")
        await _age_heartbeat(pool, run_lock.STALE_AFTER_SECONDS + 5)
        assert await run_lock.heartbeat(pool, run_id="long") is True
        # Refreshed, so no longer stealable.
        held = await run_lock.try_acquire(pool, run_id="thief", shot_code="SH020", mode="generate")
        assert held is not None and held.run_id == "long"


class TestReleaseIsScopedToItsOwnRun:
    async def test_a_finished_run_cannot_release_its_successor(self, pool: asyncpg.Pool) -> None:
        """An overran run whose lock was taken over must not delete the claim
        the new holder now owns, or two runs proceed at once - exactly the
        failure this lock exists to stop."""
        await run_lock.try_acquire(pool, run_id="old", shot_code="SH010", mode="generate")
        await _age_heartbeat(pool, run_lock.STALE_AFTER_SECONDS + 5)
        await run_lock.try_acquire(pool, run_id="new", shot_code="SH020", mode="generate")

        await run_lock.release(pool, run_id="old")

        still_held = await run_lock.current(pool)
        assert still_held is not None and still_held.run_id == "new"

    async def test_heartbeat_from_a_displaced_run_reports_failure(self, pool: asyncpg.Pool) -> None:
        """So the displaced run can say so rather than work on believing it
        holds a lock it does not."""
        await run_lock.try_acquire(pool, run_id="old", shot_code="SH010", mode="generate")
        await _age_heartbeat(pool, run_lock.STALE_AFTER_SECONDS + 5)
        await run_lock.try_acquire(pool, run_id="new", shot_code="SH020", mode="generate")
        assert await run_lock.heartbeat(pool, run_id="old") is False


class TestVisibility:
    async def test_current_reports_the_holder_across_instances(self, pool: asyncpg.Pool) -> None:
        await run_lock.try_acquire(pool, run_id="a", shot_code="SH030", mode="reuse_prompt")
        active = await run_lock.current(pool)
        assert active is not None
        assert active.as_dict()["run_id"] == "a"
        assert active.as_dict()["shot_code"] == "SH030"

    async def test_nothing_running_reports_nothing(self, pool: asyncpg.Pool) -> None:
        assert await run_lock.current(pool) is None

    async def test_the_holder_is_identified(self, pool: asyncpg.Pool) -> None:
        """"Who is holding this?" has no answer once there is more than one
        instance, unless the row says."""
        await run_lock.try_acquire(pool, run_id="a", shot_code="SH010", mode="generate")
        active = await run_lock.current(pool)
        assert active is not None and active.owner_id


async def _age_heartbeat(pool: asyncpg.Pool, seconds: int) -> None:
    """Backdates the claim instead of sleeping. A test that waited 90 seconds
    for a timeout would not get run."""
    await pool.execute(
        "UPDATE run_locks SET heartbeat_at = now() - ($1 || ' seconds')::interval",
        str(seconds),
    )

"""The retry boundary around the only call in the system that costs money.

The whole question is which failures may be repeated. An unbilled failure should
be retried, because repeating it costs an attempt. Anything that got as far as
producing output must not be, because repeating it costs another generation.
These tests pin that boundary with a fake client, so they prove the rule without
calling Veo.
"""

from collections.abc import Iterator
from typing import Any

import pytest
from google.genai import errors

from agents import generation
from models.contracts import GenerationSettings, ShotBrief


class FakeVideo:
    """Mirrors the SDK's shape: bytes inline, or a uri to download from."""

    def __init__(self, *, video_bytes: bytes | None = None, uri: str | None = "veo://file") -> None:
        self.video_bytes = video_bytes
        self.uri = uri


class FakeOperation:
    def __init__(self, *, error: object = None, with_video: bool = True) -> None:
        self.done = True
        self.error = error
        if not with_video:
            self.result: object = None
            return
        entry = type("Entry", (), {"video": FakeVideo()})()
        self.result = type("Result", (), {"generated_videos": [entry]})()


class FakeClient:
    """Scripted client. `outcomes` is consumed one entry per submission: an
    exception to raise, or a FakeOperation to return."""

    def __init__(self, outcomes: list[Any]) -> None:
        self.outcomes = list(outcomes)
        self.submissions = 0
        self.downloads = 0
        client = self

        class Models:
            async def generate_videos(self, **_: Any) -> Any:
                client.submissions += 1
                outcome = client.outcomes.pop(0)
                if isinstance(outcome, Exception):
                    raise outcome
                return outcome

        class Files:
            async def download(self, **_: Any) -> bytes:
                client.downloads += 1
                return b"bytes"

        class Aio:
            models = Models()
            files = Files()
            operations = type("Ops", (), {"get": staticmethod(lambda op: op)})()

        self.aio = Aio()


def brief() -> ShotBrief:
    return ShotBrief(
        shot_code="SH999",
        prompt="fixture",
        invariants=[],
        reference_asset_ids=[],
        generation_settings=GenerationSettings(model="veo-3.1-generate-preview", image_refs=[]),
    )


@pytest.fixture(autouse=True)
def isolate(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[dict[str, Any]]]:
    """No real client, no ClickHouse write, no waiting."""
    logged: list[dict[str, Any]] = []
    monkeypatch.setattr(generation, "log_decision", lambda **kw: logged.append(kw))

    async def _no_sleep(_seconds: float) -> None:
        return None

    # String target: the backoff sleep is reached through the generation module,
    # and addressing it by name keeps the patch off the module's public surface.
    monkeypatch.setattr("agents.generation.asyncio.sleep", _no_sleep)
    yield logged


def server_error() -> errors.ServerError:
    return errors.ServerError(503, {"error": {"message": "unavailable"}})


class TestRetriesOnlyUnbilledFailures:
    async def test_a_rejected_submission_is_retried_then_succeeds(
        self, monkeypatch: pytest.MonkeyPatch, isolate: list[dict[str, Any]]
    ) -> None:
        client = FakeClient([server_error(), FakeOperation()])
        monkeypatch.setattr(generation, "get_client", lambda: client)

        result = await generation.generate_shot_version(
            brief=brief(), reference_images={}, run_id="test"
        )

        assert result == b"bytes"
        assert client.submissions == 2, "should have submitted again after an unbilled rejection"
        assert len(isolate) == 1, "the charge is logged exactly once, for the attempt that worked"

    async def test_a_failed_operation_is_retried(
        self, monkeypatch: pytest.MonkeyPatch, isolate: list[dict[str, Any]]
    ) -> None:
        """The real SH010 case: a code-13 internal error after the operation ran."""
        client = FakeClient([FakeOperation(error={"code": 13}), FakeOperation()])
        monkeypatch.setattr(generation, "get_client", lambda: client)

        await generation.generate_shot_version(brief=brief(), reference_images={}, run_id="test")

        assert client.submissions == 2
        assert len(isolate) == 1

    async def test_it_gives_up_after_the_cap_and_bills_nothing(
        self, monkeypatch: pytest.MonkeyPatch, isolate: list[dict[str, Any]]
    ) -> None:
        client = FakeClient([FakeOperation(error={"code": 13})] * generation.MAX_GENERATION_ATTEMPTS)
        monkeypatch.setattr(generation, "get_client", lambda: client)

        with pytest.raises(RuntimeError, match="unbilled attempts"):
            await generation.generate_shot_version(
                brief=brief(), reference_images={}, run_id="test"
            )

        assert client.submissions == generation.MAX_GENERATION_ATTEMPTS
        assert isolate == [], "nothing succeeded, so nothing should be logged as spend"

    async def test_a_successful_operation_with_no_video_is_never_retried(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Billing is ambiguous here - the operation reported success. Retrying
        would risk paying twice, so this must surface rather than repeat."""
        client = FakeClient([FakeOperation(with_video=False), FakeOperation()])
        monkeypatch.setattr(generation, "get_client", lambda: client)

        with pytest.raises(RuntimeError, match="returned no video"):
            await generation.generate_shot_version(
                brief=brief(), reference_images={}, run_id="test"
            )

        assert client.submissions == 1, "an ambiguous outcome must not generate again"

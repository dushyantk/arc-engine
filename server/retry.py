"""Retry wrapper for Gemini calls. The SDK's own internal retry already
covers plain generate_content calls, but AFC-with-live-MCP-tool calls have
been observed to surface transient 503s more often — worth a second,
outer layer of resilience rather than a hard failure on ordinary
congestion (global AI/agent default: deterministic fallback where
possible, don't let a transient blip fail the whole run).
"""

from collections.abc import Awaitable, Callable

from google.genai import errors
from tenacity import AsyncRetrying, retry_if_exception_type, stop_after_attempt, wait_exponential


async def call_with_retry[**P, T](
    fn: Callable[P, Awaitable[T]], *args: P.args, **kwargs: P.kwargs
) -> T:
    async for attempt in AsyncRetrying(
        retry=retry_if_exception_type(errors.ServerError),
        stop=stop_after_attempt(4),
        wait=wait_exponential(multiplier=1, min=2, max=20),
        reraise=True,
    ):
        with attempt:
            return await fn(*args, **kwargs)
    raise AssertionError("unreachable")  # AsyncRetrying always raises or returns

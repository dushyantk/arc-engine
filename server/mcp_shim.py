"""A narrow patch for one google-genai bug that stops the planner cold.

`google.genai._mcp_utils._filter_to_supported_schema` walks a tool's JSON Schema
and recurses into `items` / `additionalProperties` assuming each holds a schema
object. Those keywords may legally hold a bare boolean instead, and
`mcp-clickhouse` emits `"additionalProperties": false` on all three of its tools.
The recursion then calls `.items()` on a bool and the whole planning step dies
with `AttributeError: 'bool' object has no attribute 'items'`.

Patched here rather than worked around anywhere else, because the alternatives
are all worse:

- Wrapping the ClientSession to sanitise schemas fails: `_extra_utils` selects
  the no-deepcopy code path with `isinstance(tool, ClientSession)`, so a proxy
  object is not recognised and the SDK then tries to deepcopy a live session,
  which raises `TypeError: cannot pickle '_asyncio.Task'`. Measured, not assumed.
- Pinning google-genai or mcp backwards trades a working feature for an old bug.
- Dropping the MCP path contradicts the architecture: the planner querying the
  official ClickHouse MCP as a tool is the design, not an implementation detail.

The patch only widens what the function accepts - a boolean short form is passed
through untouched instead of being recursed into. Delete this module once the
upstream function handles it; `test_mcp_shim.py` fails loudly if the internals it
depends on move.
"""

from typing import Any

from google.genai import _mcp_utils

_original = _mcp_utils._filter_to_supported_schema


def _filter_to_supported_schema(schema: Any) -> Any:
    # The boolean short form of a schema keyword. Nothing to filter, and the
    # original would try to iterate it.
    if not isinstance(schema, dict):
        return schema
    return _original(schema)


def install() -> None:
    """Idempotent. Safe to call from every entrypoint that plans."""
    if getattr(_mcp_utils._filter_to_supported_schema, "__dailies_patched__", False):
        return
    _filter_to_supported_schema.__dailies_patched__ = True  # type: ignore[attr-defined]
    _mcp_utils._filter_to_supported_schema = _filter_to_supported_schema

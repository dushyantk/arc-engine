"""The google-genai patch, and the internals it depends on.

A monkeypatch against another library's private function is a liability: it goes
silently inert the moment upstream renames anything, and the symptom is the
original crash returning in production rather than a failing test. These assert
the internals are still where the patch expects them, so an upgrade that moves
them fails here instead.
"""

import pytest
from google.genai import _mcp_utils

import mcp_shim


def test_the_patched_function_still_exists_upstream() -> None:
    """If this fails, google-genai moved or renamed it and mcp_shim is inert."""
    assert hasattr(_mcp_utils, "_filter_to_supported_schema")


def test_the_keywords_that_break_it_are_still_recursed_into() -> None:
    """The bug is that these are followed unconditionally. If upstream stops
    treating them as schemas, the patch is no longer needed - notice that
    deliberately rather than carrying dead code forever.

    Inspects mcp_shim._original, not the module attribute: once install() has
    run, that attribute is the patch, whose source says nothing about upstream.
    Reading it made this test pass or fail depending on which tests ran first.
    """
    import inspect

    source = inspect.getsource(mcp_shim._original)
    assert "additionalProperties" in source


class TestTheBugItself:
    """Reproduces the exact crash, against the real function."""

    def test_a_boolean_additional_properties_is_survivable_once_patched(self) -> None:
        mcp_shim.install()
        # The literal schema mcp-clickhouse emits for list_databases.
        schema = {"properties": {}, "type": "object", "additionalProperties": False}
        result = _mcp_utils._filter_to_supported_schema(schema)
        assert isinstance(result, dict)

    def test_a_nested_boolean_is_survivable_too(self) -> None:
        """The original recurses, so a bool one level down has to be handled by
        the same patch rather than only the top level."""
        mcp_shim.install()
        schema = {
            "type": "object",
            "properties": {"inner": {"type": "object", "additionalProperties": False}},
        }
        assert isinstance(_mcp_utils._filter_to_supported_schema(schema), dict)

    def test_a_real_schema_object_is_still_filtered_not_passed_through(self) -> None:
        """The patch must only widen what is accepted. An object-valued keyword
        still has to be walked, or the model gets fields it cannot use."""
        mcp_shim.install()
        schema = {
            "type": "object",
            "properties": {"q": {"type": "string", "not_a_real_field": 1}},
        }
        result = _mcp_utils._filter_to_supported_schema(schema)
        assert "not_a_real_field" not in result["properties"]["q"]


def test_install_is_idempotent() -> None:
    """Called from module import, so it can run many times in one process."""
    mcp_shim.install()
    first = _mcp_utils._filter_to_supported_schema
    mcp_shim.install()
    assert _mcp_utils._filter_to_supported_schema is first


@pytest.mark.parametrize("value", [True, False])
def test_both_boolean_forms_pass_through(value: bool) -> None:
    """The ignores below are the bug written down: upstream annotates this as
    taking a dict, while the MCP schemas it is fed legally contain booleans. The
    annotation is what is wrong, not the call."""
    mcp_shim.install()
    result = _mcp_utils._filter_to_supported_schema(value)  # type: ignore[arg-type]
    assert result is value  # type: ignore[comparison-overlap]

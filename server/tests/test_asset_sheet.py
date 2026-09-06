"""Asset sheets: what a generated reference is allowed to do before a human
has looked at it.

The rule under test is that a generated sheet is a proposal, not canon. It is
enforced by a NULL `locked_at` rather than by a second approval concept, because
`get_reference_assets()` - the only thing every agent reads - already filters on
that column. These tests hold the seam that makes that true.
"""

from agents.asset_sheet import build_prompt
from models.contracts import (
    AssetSheetSpec,
    BreakdownAsset,
    BreakdownSequence,
    BreakdownShot,
    SceneBreakdown,
)
from routes.sheets import _DEFAULT_VIEWS, _specs_from_breakdown


def spec(**over: object) -> AssetSheetSpec:
    base: dict[str, object] = {
        "asset_type": "character",
        "name": "The Keeper",
        "prompt": "a weathered lighthouse keeper in a yellow wool coat",
        "views": ["front view, full body", "side profile"],
    }
    base.update(over)
    return AssetSheetSpec(**base)  # type: ignore[arg-type]


class TestSheetPrompt:
    """The prompt is assembled in one place so the text stored on the row is the
    text that ran, not a reconstruction of it."""

    def test_it_asks_for_a_reference_not_a_frame(self) -> None:
        p = build_prompt(spec())
        assert "neutral mid-grey seamless" in p.lower()
        assert "flat even lighting" in p.lower()

    def test_it_forbids_text_in_the_image(self) -> None:
        """A label baked into a reference plate becomes a continuity finding on
        every shot compared against it."""
        assert "no text" in build_prompt(spec()).lower()

    def test_every_requested_view_reaches_the_prompt(self) -> None:
        p = build_prompt(spec(views=["front view", "rear view", "worm's eye"]))
        for view in ("front view", "rear view", "worm's eye"):
            assert view in p

    def test_it_demands_the_subject_be_identical_across_views(self) -> None:
        """Without this a 'sheet' is several different characters side by side,
        which is worse than one photograph."""
        assert "identical in every view" in build_prompt(spec())

    def test_the_subject_description_survives_verbatim(self) -> None:
        assert "a weathered lighthouse keeper in a yellow wool coat" in build_prompt(spec())


class TestViewsByAssetType:
    """Views are per type because 'side profile' means something for a character
    and nothing for a palette."""

    def test_a_character_gets_more_than_one_angle(self) -> None:
        assert len(_DEFAULT_VIEWS["character"]) > 1

    def test_an_environment_is_not_asked_for_invented_angles(self) -> None:
        assert len(_DEFAULT_VIEWS["environment"]) == 1

    def test_every_asset_type_the_breakdown_can_emit_has_views(self) -> None:
        """A type with no entry would silently fall back to a single front view.
        Better to notice here than to pay for a useless sheet."""
        for asset_type in ("character", "prop", "environment", "palette"):
            assert _DEFAULT_VIEWS.get(asset_type)


class TestSpecsFromBreakdown:
    def test_the_breakdown_description_is_used_not_reimagined(self) -> None:
        """The sheet's whole job is to match what the script asked for, so the
        agent must not get a chance to invent a different subject."""
        bd = SceneBreakdown(
            sequences=[
                BreakdownSequence(
                    code="SQ010",
                    description="x",
                    shots=[
                        BreakdownShot(
                            code="SH010", order_index=0, screen_direction="static", brief="b"
                        )
                    ],
                )
            ],
            assets=[
                BreakdownAsset(
                    type="prop",
                    name="brass lantern",
                    description="a dented brass hurricane lantern with a cracked glass pane",
                    why_needed="appears in every shot",
                )
            ],
        )
        specs = _specs_from_breakdown(bd)
        assert len(specs) == 1
        assert specs[0].prompt == "a dented brass hurricane lantern with a cracked glass pane"
        assert specs[0].name == "brass lantern"
        assert specs[0].asset_type == "prop"

    def test_a_breakdown_with_no_assets_proposes_no_sheets(self) -> None:
        bd = SceneBreakdown(
            sequences=[
                BreakdownSequence(
                    code="SQ010",
                    description="x",
                    shots=[
                        BreakdownShot(
                            code="SH010", order_index=0, screen_direction="static", brief="b"
                        )
                    ],
                )
            ],
            assets=[],
        )
        assert _specs_from_breakdown(bd) == []

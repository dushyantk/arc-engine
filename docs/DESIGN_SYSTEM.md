# Dailies — Design System

**Locked: Lab Bench.** Cool slate, sharp corners, mono-forward headings and data. Landing page
and app share this token set; nothing gets a second visual language. See
[ARCHITECTURE.md](ARCHITECTURE.md) for where this plugs into the stack and
[BUILD_PLAN.md](BUILD_PLAN.md) for when it gets wired up (Phase 0).

Three directions were explored (Screening Room / warm cinematic, Lab Bench / cool technical,
Operator / neutral SaaS). Lab Bench won on two counts: zero hue collisions between the brand
accent and the semantic status colors, and it reads closest to how a pipeline TD already thinks
about a tool like this.

Dark-only. No light theme, no toggle. This mirrors every tool in the actual domain (Nuke, Resolve,
Flow) and simplifies the token set considerably — there is no `.dark` class or
`prefers-color-scheme` branching anywhere in this system. If a light mode is ever wanted, that's a
deliberate product decision to revisit, not a default to restore.

## Color

One brand accent, four semantic tokens, all on distinct hues. No token below is reused for two
different meanings — the brand accent never appears on a status badge, and no semantic color is
ever used for a button or a link.

| Token | Hex | Role |
| --- | ---: | --- |
| `background` | `#0a0d12` | page background |
| `card` / `popover` | `#10141b` | elevated surfaces: cards, panels, dropdowns |
| `secondary` / `accent`* | `#151a22` | subtle interactive backgrounds: hover states, active nav |
| `border` / `input` | `#232a35` | hairlines, dividers, input borders |
| `foreground` | `#e6eaf0` | primary text |
| `muted-foreground` | `#7c8797` | secondary text, timestamps, captions |
| `primary` | `#4fa3d9` | **the one brand accent** — buttons, links, focus rings, selected state |
| `primary-foreground` | `#0a0d12` | text on `primary` |
| `success` | `#45c98a` | shot/sequence approved |
| `warning` | `#e0a83d` | tolerated finding, needs attention |
| `destructive` | `#e0554f` | failed QC finding, revision required |
| `info` | `#8890a6` | `needs_human` escalation — deliberately desaturated, reads as "outside the automated system" |

\* shadcn's own `--accent` token name is a coincidence, not our brand accent — it's the subtle
hover/active background. Our brand accent is `--primary`. Don't conflate the two when wiring
components; the table above is the disambiguation.

**Rule:** status badges always use a semantic token at low-opacity fill + full-opacity text, and
are always paired with an icon, never color alone. Buttons, links, and focus rings always use
`primary`. If a component needs both (e.g. a "select this shot" action inside a failed shot's
card), the container's status uses semantic color, the actual button still uses `primary`.

## Type

Two faces, one pairing, mono doing structural work rather than decoration:

- **Body**: Geist Sans (`pnpm add geist`, via `next/font`). Paragraphs, descriptions, nav labels.
- **Headings, data, and functional labels**: Geist Mono. Section headings, shot codes
  (`SH020_v003`), timecodes (`00:03-00:11`), frame ranges, table headers, status pills, nav item
  labels. This is a real functional choice, not a stylistic one — the product is timecode- and
  version-number-heavy, and mono keeps those columns aligned and legible.

Real font, real package, no system-font fallback in production — the exploration artifact used
system stacks because artifacts can't load webfonts; the actual app uses Geist properly through
`next/font`.

## Shape

Sharp, deliberately smaller than shadcn's default radius scale:

| Token | Value | Used for |
| --- | ---: | --- |
| `radius-sm` | `0px` | badges, pills, tags |
| `radius-md` | `2px` | shot thumbnail cards, list rows |
| `radius-lg` | `4px` | panels, dialogs, larger containers |
| `radius-xl` | `8px` | rare — full-screen overlays only |

No shadows for elevation. Dark UIs don't read shadows well; elevation comes from the
`card`/`background` lightness step plus a 1px `border`, same as the exploration mockups.

## Setup notes (Phase 0)

1. `pnpm add geist` — Geist Sans + Geist Mono via `next/font/sans` / `next/font/mono`, exposed as
   `--font-sans` / `--font-mono` through the font object's `.variable`.
2. `npx shadcn@latest init` — when prompted, `cssVariables: true`, base color `neutral` (closest
   starting point before override).
3. Replace the generated `:root` token block in `app/globals.css` with
   [`design/globals.css`](../design/globals.css) in this repo — it's the real CSS for the table
   above, ready to paste in as-is.
4. Do not add a `.dark` class or a theme toggle without a product decision to add a light mode.

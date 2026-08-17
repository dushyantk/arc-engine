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

Real font, no system-font fallback in production — the exploration artifact used system stacks
because artifacts can't load webfonts. The actual app uses `create-next-app`'s built-in
`next/font/google` Geist Sans / Geist Mono (no separate `geist` package needed, it's wired in by
the scaffold), exposed as `--font-geist-sans` / `--font-geist-mono` and mapped to `--font-sans` /
`--font-mono` in `app/globals.css`. `--font-heading` is mapped to the mono variable, not sans —
that's what makes shadcn components default to mono headings automatically.

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

## Setup notes (Phase 0 — done)

1. `create-next-app` already wires Geist Sans / Geist Mono via `next/font/google`. No extra font
   package needed.
2. `shadcn init` picks its target CSS file by scanning for `@import "tailwindcss"` — with both
   `app/globals.css` and this repo's `design/globals.css` present, it grabbed the wrong one and
   overwrote it with generic oklch defaults. Fixed by pointing `components.json`'s
   `tailwind.css` at `app/globals.css` explicitly and hand-writing the real tokens into both
   files. If you ever re-run `shadcn init`, check `components.json` first.
3. `app/globals.css` and [`design/globals.css`](../design/globals.css) are kept identical by
   hand. `design/globals.css` is the reference copy with the fuller comment header; the live file
   `shadcn add` writes into is `app/globals.css`.
4. No `.dark` class, no theme toggle. Don't add one without a product decision to ship a light
   mode.

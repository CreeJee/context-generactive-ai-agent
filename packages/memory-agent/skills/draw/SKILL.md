---
name: "draw"
description: "Draw diagrams, charts, wireframes and icons as SVG written straight into the project. Use when the user asks for an architecture or sequence diagram, a flow chart, a bar/line chart, a UI wireframe, an icon or a logo mark, or any figure whose shapes and text are known. Do not use for photographs, illustrations, textures or sprites: those need a generative image model, which this app does not have."
---

# Drawing

You draw by writing SVG. SVG is text, so `write_file` puts it in the project directly — no
shell, no approval, and the user can edit it afterwards.

## What you can and cannot draw

- **Can:** architecture and sequence diagrams, flow charts, state machines, bar / line / pie
  charts from given numbers, UI wireframes, icons, logo marks, badges, simple illustrations
  built from shapes.
- **Cannot:** photographs, painted or rendered illustrations, textures, sprites, anything that
  needs a generative image model. Say so plainly and offer the nearest drawable thing. Never
  suggest the user set an API key: this app's shell removes credential-looking variables, so
  that road is closed.

## Rules

1. Write one `.svg` file per figure with `write_file`. Name it for what it shows
   (`docs/auth-sequence.svg`), not for how it was made.
2. **Fit the `viewBox` to the drawing — the most common defect is skipping this.** Lay
   everything out first, then set `viewBox` to the content's extent plus a 16px margin. Before
   writing the file, check the largest x and y any element reaches, text included. Content past
   the edge is cut off without any error: a whole participant, the last bar, half the title.
   Set `width`/`height` only when the user asked for a fixed size; `viewBox` alone scales to
   wherever the figure is placed.
3. Size text before placing it. A line of text is about `0.58 × font-size × characters` wide
   (`1.0 ×` for Korean and other CJK glyphs); with `text-anchor="middle"` half of that goes on
   each side. Size boxes from the widest label, not the other way round.
4. Compute coordinates, do not eyeball them. Pick a grid (for example 24px) and place
   everything on it.
5. Put a title inside the figure as a `<text>` at the top, unless the user asked for a bare
   graphic: figures get pasted into documents without their file name. Also give the `<svg>` a
   `<title>` as its first child for screen readers.
6. No external fonts, images or scripts; a figure must render offline in any viewer. Use
   `font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"`.
7. Use `currentColor` for strokes and text that should follow the page, and explicit colours
   only where the meaning is in the colour (a legend, a status). At most 5 colours.
8. Arrowheads go in one `<defs><marker>` referenced with `marker-end`; do not draw arrow tips as
   separate paths.
9. A label on top of a line it does not belong to — a message label over a lifeline, an edge
   label over a box — is hard to read even when nothing technically overlaps. Move it into the
   gap, or give it a halo: `paint-order="stroke" stroke="white" stroke-width="4"`.

## Layout that usually works

- **Boxes and arrows:** lay nodes out in columns by depth. Column width = widest label + 32px
  padding. Vertical gap 24px, horizontal gap 64px so arrows have room for labels.
- **Sequence diagram:** one vertical lifeline per participant, evenly spaced; messages are
  horizontal lines 40px apart down the page; label above the line, `text-anchor="middle"`.
- **Bar chart:** leave 48px on the left for the value axis and 32px at the bottom for labels.
  Bars get `rect` with a shared width; scale by `(value / max) * plotHeight`.
- **Wireframe:** greys only (`#f4f4f5` fills, `#d4d4d8` strokes), no real copy — `Lorem` blocks
  as plain rectangles. The point is layout, not content.

## After writing

Say what you drew and where you put it, in one line. Do not paste the whole SVG back into the
conversation; the user has the file. If the figure has numbers in it, state where they came
from.

## Raster, only when asked

If the user explicitly needs a PNG (an OG image, a favicon), draw the SVG first, then tell them
it needs converting. Do not shell out to Pillow or ImageMagick without checking they exist:
`run_shell` is approval-gated and those packages are usually missing. Python's standard library
can write a PNG (`zlib` + `struct`) when the shapes are simple enough to rasterise by hand, but
prefer handing over the SVG.

# ✏️ Landmarkle

A sketch-reveal geography guessing game. Somewhere in the world, a famous
landmark is being drawn — but the artist only draws as much as your best
guess deserves.

**Play it:** open `index.html` in any browser. No build step, no server, no
dependencies — the whole game (including the world map) is one file.

## How to play

1. A mystery landmark appears as a barely-started pencil sketch (~10% of its strokes).
2. Drop a pin anywhere on the world map and hit **Guess**.
3. The closer your pin is to the landmark, the more of the sketch draws itself.
   Each guess also tells you the distance and compass direction to the target.
4. Land within **250 km** in **6 guesses** to win. Win or lose, the sketch
   finishes drawing and you learn where — and what — it was.

There's one shared **daily landmark** (same for everyone, streaks tracked in
`localStorage`) plus a 🎲 **free play** mode with random landmarks.

Share results as spoiler-free emoji rows: 🟩 &lt;250 km · 🟨 &lt;1,500 km ·
🟧 &lt;4,000 km · 🟥 beyond.

## How it works

- **Sketches** are hand-crafted SVG line art (12 landmarks so far). Each is an
  ordered list of stroke paths; a `feTurbulence` + `feDisplacementMap` filter
  gives them a wobbly hand-drawn look.
- **Progressive reveal** uses the classic `stroke-dasharray` /
  `stroke-dashoffset` trick: total stroke length is budgeted across the paths
  in drawing order, so the sketch appears to be drawn live by an invisible
  pen. Reveal fraction = `0.10 + 0.90 · (1 − d/9000 km)^2.2`, floored by a
  small per-guess increment and capped at 93% until the game ends.
- **The map** is a simplified world coastline (Douglas-Peucker–reduced
  GeoJSON, equirectangular projection) embedded as a single SVG path, with
  wheel/pinch zoom and drag panning implemented on the SVG `viewBox`.
- **Distances** use the haversine formula; direction hints use initial
  great-circle bearing bucketed into eight compass arrows.
- The **daily puzzle** is picked by hashing the date, so everyone gets the
  same landmark without a backend.

## Adding a landmark

Append an entry to the `LANDMARKS` array in `index.html`:

```js
{ id: "myplace", name: "…", city: "…", country: "…", lat: 0, lon: 0,
  fact: "…",
  paths: [ /* SVG path strings in a 400×400 viewBox, drawing order = reveal order */ ] }
```

Order the paths from broad outline to fine detail — early strokes are what
players see at low reveal, so lead with the silhouette.

## Roadmap ideas

- More landmarks and difficulty tiers (world icons → deep cuts)
- Passport/stamp collection for solved landmarks
- Photo cross-fade after solving
- A GPS mode: the sketch fills in as you physically walk toward a landmark

---

## 🦋 `prototype/collage/` — Specimen collage studio (rough prototype)

A separate, unrelated prototype exploring the screenshot → artistic-collage
idea. Open `prototype/collage/index.html` — again one file, no build step.

**Layout:** collage stage on the left, control rail on the right.

**What makes the shapes read as real specimens** (rather than a symmetric
silhouette): every shape is a set of *anatomical parts* — forewing, hindwing,
thorax/abdomen, hairline antennae — authored as SVG paths in a 1000×1000 local
space with the body axis at `x=500`. Right-hand parts are authored once and
mirrored. Each part is masked over its **own** crop of the source image, so an
eye lands on one wing plate and a mouth on the next. Drawn veins, cross-veins,
hard scissor edges and a soft cast shadow finish the pinned-specimen look, and
the four specimens are arranged on a cream mount as a plate.

Shapes: nymphalid butterfly, swallowtail, luna moth, peony bloom (rings of
overlapping petals). 6 pastel palettes, mosaic tiling, PNG export at 2×.

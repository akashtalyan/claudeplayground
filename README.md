# 🎨 Emotion Sticker Playground

Type an emotion — get a hand-painted-looking mood sticker, in the style of
watercolor journal apps. **Try it:** open `stickers.html` in any browser.

- Everything is drawn procedurally on a `<canvas>` — no images, no AI, no
  server. Blob silhouette + layered watercolor pigment + paper grain + a
  minimal ink face, all from a seeded RNG so every sticker is reproducible.
- ~25 emotion families with synonym + fuzzy matching, and blends:
  `anxious but excited` gradients between both moods.
- 🎲 **Remix** re-rolls the same emotion with a new seed; unknown words get an
  improvised on-style sticker. Recent stickers collect on a shelf
  (`localStorage`), and PNG export is 512×512 with transparency —
  sticker-pack ready.

---

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

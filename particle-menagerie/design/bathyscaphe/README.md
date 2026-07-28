# Handoff: Particle Menagerie — "Bathyscaphe" UI direction (option 1d)

## Overview
UI chrome for **Particle Menagerie**, a full-viewport WebGL "abyssal particle aquarium": users type a creature name, it forms from glowing dots and drifts forever. This handoff covers the winning UI direction, **Bathyscaphe** — a warm analog dive-console metaphor: brass-phosphor amber instruments floating over cold near-black water. The canvas is the product; the UI is a guest in it.

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes showing intended look and behavior, not production code to ship. The task is to **recreate this design inside the real app's environment** (the existing WebGL app's JS/DOM layer, or whatever framework the app uses), following its established patterns. `Particle Menagerie Directions.dc.html` is a design-review document containing four directions; only the section marked `id="1d"` is in scope. `fake-scene.js` is a mock of the WebGL scene — do not port it; the real particle engine replaces it.

## Fidelity
**High-fidelity.** Colors, typography, opacities, spacing, and micro-interaction specs are final and should be matched exactly. Layout positions in the mock are for a 1440×840 art board; in production, panels anchor to the selected creature (see Layout).

> Note: in the latest design revision the standalone dial cluster (glow/tempo needle dials + large weather rotary + "log" latch, bottom-right) was **removed from the selected state**. The weather rotary still appears in the **at-rest** state (small, bottom-right). Implement per this revision; the earlier dial cluster is out of scope unless the designer reinstates it.

## Screens / Views
One screen, ever. No modals, no navigation, no pages. Full-viewport canvas behind everything; UI floats over it. Three chrome states:

### State A — At rest
Visible: summon input (with port light) bottom-center, and a small weather rotary bottom-right. Nothing else.
- **Summon input**: centered horizontally, 56px from bottom. Row: port light + field, gap 12px.
  - *Port light*: 6px circle, `#ffc37a`, `box-shadow: 0 0 8px rgba(255,195,122,.8)`; a ping ring (1px border `rgba(255,195,122,.5)`) expands from `scale(.4)` to `scale(2.8)` fading to 0 over 2.6s ease-out, infinite.
  - *Field*: 300px wide, centered text, IBM Plex Mono 11px, letter-spacing .2em, placeholder "name a creature" in `rgba(255,235,214,.3)`; no box — only a 1px bottom border `rgba(255,195,122,.28)`, padding-bottom 10px.
- **Weather rotary (rest)**: bottom-right (~20px inset). Circular tick ring: `repeating-conic-gradient(rgba(255,195,122,.3) 0deg 1.6deg, transparent 1.6deg 72deg)` (5 tick groups), inner disc `rgba(6,7,9,.92)` inset 3px; current preset word centered in Spectral italic, `#ffd9a8`. Rest size ~40px; may be rendered larger (92px) with ‹ › affordances at `rgba(255,235,214,.35)` (hover .8) when hovered.

### State B — Creature selected (click a creature)
Adds one **gauge plate** anchored near the selected creature (mock position: top-right area; production: beside the creature, avoiding canvas edges).
- **Gauge plate**: width 242px, padding 16px 20px; `background: rgba(10,8,4,.42)`; `backdrop-filter: blur(8px)`; `border: 1px solid rgba(255,195,122,.18)`; `border-radius: 4px`; base text color `rgba(255,235,214,.6)`.
  - *Header row*: space-between, baseline-aligned, margin-bottom 14px. Creature name ("jellyfish") in Spectral 500 12px, `font-variant: small-caps`, letter-spacing .14em, `#ffd9a8`. Index tag ("j·01") IBM Plex Mono 9px, `rgba(255,214,168,.35)`.
  - *Sliders* (glow 62, tempo 40, sway 25, size 3.1): IBM Plex Mono 10px, letter-spacing .1em; rows are flex, gap 10px, vertical margin 11px. Label 42px wide, `rgba(255,235,214,.5)`. Track: flex 1, 1px tall, `rgba(255,195,122,.2)` — **no fill**; the handle is a gauge needle: 2×10px bar, `#ffc37a`, `box-shadow: 0 0 7px rgba(255,195,122,.8)`, centered on the track (top −4.5px). Value right-aligned, 24px, `#ffc37a`.
  - *Divider*: 1px, `rgba(255,195,122,.14)`, margin 13px 0.
  - *Actions row*: flex gap 14px, IBM Plex Mono 9.5px, `rgba(255,235,214,.4)`; hover `rgba(255,235,214,.85)`, cursor pointer. Items: `re-form`, `release`, `more ›`.
  - *Behind `more ›`*: twinkle, iridescence, dot density, depth, and behavior mode as one 5-notch rotary (drift / patrol / follow / school / sleep). Never shown inline.
- Constraint honored: at most 3 things visible without an explicit "more" (input, rotary, plate).

### State C — Ambient (≈30s idle)
Needles keep drifting with the water for ~3s after last input, then **all chrome sinks out of frame** (downward drift + fade). Any input (keystroke, click, mouse move past threshold) brings State A back, input first.

### In-world creature labels (hover)
Not DOM-styled chrome: small type that feels like part of the water. If done in DOM: 10px mono, letter-spacing ~.35em, low-opacity warm white, soft glow text-shadow — but prefer rendering into the scene layer so it inherits fog/depth.

## Interactions & Behavior
- **Summon**: Enter → a single sonar ring expands from the port light; ripple radius scales with the new creature's size. Field clears; formation takes ~1.5s (owned by the engine).
- **Select**: click a creature → gauge plate surfaces near it. Click empty water or `esc` → deselect, plate sinks.
- **Panel entry**: "rising through water" — blur 8px→0 plus 6px upward drift over 400ms (ease-out). Exit reverses, slightly faster.
- **Sliders/dials**: inertia + soft felt detents; on release the needle overshoots ~1 degree/percent and settles. Value changes apply live to the creature.
- **Weather rotary**: ‹ › (or drag-rotate) steps through presets: moonlit, abyss, bioluminescent bay, ink, shallows. Each preset sets many scene values at once (light, fog, exposure, current…). Transition should feel like weather changing (~2s crossfade of scene params), not a config load.
- **`log ▸` latch** (if reinstated with console cluster): holds snapshot (PNG), record (WebM), share (board state in URL); creature count engraved inside it.
- **Hover states**: all text actions go from 40% → 85% opacity of warm white; 150–200ms ease.
- **No loading/error chrome**: unknown creature names still form *something*; the app never scolds.

## State Management
- `selectedCreatureId: string | null` — drives State B.
- `idleTimer` — 30s since last pointer/key event → ambient; any event resets.
- Per-creature: `color, glow, tempo, sway, size` + advanced (`twinkle, iridescence, density, depth, behaviorMode`).
- Scene: `preset` + underlying scene params (light dir/color, exposure, aperture, fog, current, trails, turbulence, camera).
- Whole board state serializes into the URL (share).

## Design Tokens
Background (scene, behind everything): `#04060a`, top glow `radial-gradient(120% 90% at 50% -10%, #0a1522 0%, #04060a 60%)`.

Color:
- `--amber` `#ffc37a` — oklch(.85 .09 75) — phosphor amber accent: needles, values, port light. Rationale: maximum hue distance from the cyan creatures, so chrome stays legible when a bright form passes behind it; warm-vs-cold reads "vessel vs water".
- `--amber-bright` `#ffd9a8` — headers, preset word.
- Warm white ramp: `rgba(255,235,214, .3 / .4 / .5 / .6 / .85)` — placeholder / actions / labels / body / hover.
- Brass hairlines: `rgba(255,195,122, .14 / .18 / .2 / .28)` — dividers / plate border / tracks / input underline.
- Panel glass: `rgba(10,8,4,.42)` + `backdrop-filter: blur(8px)`.

Typography:
- **Spectral** (Google Fonts) 500, small-caps, 10–12px, letter-spacing .14–.18em — labels, creature names, dial captions.
- **IBM Plex Mono** (Google Fonts) 400, 9–11px, letter-spacing .1–.2em — readouts, values, actions, input.

Spacing/shape: plate radius 4px; slider row rhythm 11px; divider margins 13px; input underline padding-bottom 10px; glow shadows `0 0 6–8px rgba(255,195,122,.8)`.

Motion: surface = 400ms blur+drift; hover = 150–200ms; ping = 2.6s ease-out infinite; detent settle = ~1 unit overshoot.

## Assets
None. No icons, no images — all chrome is type, hairlines, and CSS gradients (tick rings are `repeating-conic-gradient`). Fonts load from Google Fonts (Spectral, IBM Plex Mono).

## Files
- `Particle Menagerie Directions.dc.html` — design review doc; **section `id="1d"`** is this design (main 1440×840 selected-state mock + at-rest and ambient minis + spec cards). Other sections (1a–1c) are rejected directions; ignore.
- `fake-scene.js` — mock particle scene used behind the mock chrome. Reference only; replaced by the real engine.

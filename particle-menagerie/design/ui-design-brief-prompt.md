# Design brief: UI concepts for "Particle Menagerie" — an abyssal particle aquarium

*(This is a prompt to hand to a design-focused Claude session. It is self-contained — no repo access assumed.)*

I need 3–4 distinct UI design directions (with mockups) for a generative-art web app. Read the whole brief before designing; the last section lists hard constraints.

## The product

A full-viewport, near-black underwater scene rendered in WebGL. The user types the name of a sea creature or flower ("jellyfish", "red eel", "school of fish") and it forms out of thousands of glowing dots, then drifts, coils, and breathes forever alongside everything named before it. Reference aesthetic: @yuruyurau's "dotted particle creature drifting in the dark" — monochrome-by-default bioluminescent dots, math-driven organic motion, calm and elegant. The canvas IS the product; the UI is a guest in it.

## The core emotional target

This should feel like a *place* (a dark tide pool you lean over), not a *tool*. The magic beat is the 1.5-second formation moment after pressing Enter. Every UI decision is judged by one question: does it protect the calm?

## What the UI must expose

1. **Summon input** — one always-available text field, the primary interaction. Currently a thin underlined field bottom-center with placeholder "name a creature".
2. **Per-creature panel** (appears on click-select): color swatches, and sliders for glow, tempo, sway, size; plus rarely-used actions (re-form, release) and, behind an "advanced" affordance: twinkle, iridescence, dot density, depth, behavior mode (drift / patrol / follow cursor / school / sleep).
3. **Global scene panel:** light direction & color, exposure, focus/aperture (depth-of-field), fog, current, trails, turbulence, camera (parallax amount / auto-orbit) — most of these belong behind progressive disclosure.
4. **Presets** — named moods ("moonlit", "abyss", "bioluminescent bay") that set many scene values at once. Presets should feel like choosing weather, not loading a config.
5. **Ambient/zen mode** — after ~30s idle, all chrome fades out entirely; any input brings it back.
6. **Small utilities:** hover shows a creature's name in small type; PNG snapshot; WebM record; share (the board state lives in the URL); a subtle creature count.

## What I want from you

- 3–4 genuinely different directions (e.g. "instrument panel", "invisible-until-summoned", "physical dive-console metaphor", "single command-line-of-the-sea") — not one layout with four color schemes.
- For each: an HTML/CSS mockup over a fake dark-scene background, the interaction model (what's visible at rest / on select / in ambient mode), and 2–3 micro-interaction notes (how a panel enters, how a slider feels, how the summon input acknowledges Enter).
- A recommended type + color token set per direction (the scene is near-black `#04060a`; current UI uses thin monospace, letter-spaced lowercase, 10–11px, white at 20–60% opacity, accent `#8fd8ff` — evolve or replace it, but justify).
- A "what I would cut" note per direction — restraint is a feature.

## Hard constraints

- Desktop-first, full-viewport canvas behind everything; UI floats over it (blur/transparency is fine, heavy chrome is not).
- At rest, no more than the summon input and one small affordance may be visible. Never more than ~3 controls visible without an explicit "more" action — a wall of sliders is the failure mode we're designing against.
- No modals, no navigation, no pages. One screen, ever.
- Must remain legible over both near-black water and a bright glowing creature passing behind it.
- Text in the scene's world (creature name labels) should feel like part of the water, not like DOM.
- Plain HTML/CSS/JS mockups (no frameworks) so the winning direction can be ported into the real app directly.

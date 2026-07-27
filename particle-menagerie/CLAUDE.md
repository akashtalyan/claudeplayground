# Particle Menagerie — project context

This project was started in a Claude Cowork session and handed off here. Read this file fully before doing anything.

## What this is

An interactive browser "board": the user types the name of a sea creature or flower, and it forms out of glowing dots and drifts in a dark underwater scene — the aesthetic of @yuruyurau's "dotted particle creature drifting in the dark" (https://movin.design/video/dotted-particle-creature-drifting-in-the-dark/). Monochrome-by-default particles, math-driven organic motion, calm and elegant.

## Files

- `particle-menagerie-prd.md` — the PRD (v1, written when scope was all animals; scope has since narrowed, see decisions below).
- `particle-menagerie.html` — **v2, the current working prototype.** Canvas2D, single file, works offline. Ocean creatures + rooted flora, 9 archetypes, click-to-select control panel (color swatches, tempo/sway/size/glow sliders), global water panel (current, trails, cursor ripple/lure modes), name parsing ("red jellyfish", "school of fish", "giant whale"), URL-hash persistence, same-species schooling, ambient plankton. Tested at 54–60fps with 12 creatures.
- `threejs-approach.md` — the architecture for v3 (the three.js rebuild).
- `threejs-critical-breakdown.md` — **the most important doc.** Full control catalog, honest analysis of the realistic-lighting ceiling, risk register (10 risks incl. self-critique), alternatives considered, and the phased plan with gates.

## Decisions already made with the user (do not relitigate silently)

1. Scope: ocean creatures + flowers-as-sea-flora on ONE shared canvas (an abyssal aquarium). Land animals were cut because legs/gravity break the particle illusion.
2. Generation is procedural/deterministic (name → hash → archetype → params). No AI/image-gen in the generation path — the user asked, and it was ruled out because it kills interactivity.
3. v2 was judged "not impressive" by the user. Verdict accepted: flat 2D + square dots is the ceiling of Canvas2D. The agreed fix is the three.js rebuild (v3) per `threejs-approach.md`.
4. The user explicitly wants three.js, more controls (see catalog in the breakdown doc), and more realistic lighting. Expectation set: "physically plausible light in a stylized medium" (per-dot normal shading, tonemapping, DOF, fog, bloom) — NOT photoreal creatures.

## Current state / next step

**Next step is Phase 0 of the plan in `threejs-critical-breakdown.md` §5: the lighting spike.**
One hardcoded eel in three.js with the full lighting stack: 3D spine (two incommensurate traveling waves so the coil evolves), ~52 quantized rings × ~24 dots (quantized rings = crisp dotted ribs; do not scatter randomly), per-dot normals from ring offsets, directional Lambert + rim shading, additive-blend glow sprites, tonemapping (blowout is a known top risk), particle depth-of-field, exponential fog, trails via offscreen accumulation target (NOT a fade quad if tonemapping is in the chain — see Risk 3). Gate: it must clearly beat v2 on sight before porting the other archetypes.

Constraint carried from Cowork: three.js was pinned to the cdnjs r128 global build (only CDN allowed in claude.ai previews). In local Claude Code this constraint is GONE — prefer a modern three version via npm/vite, which also unlocks official EffectComposer/UnrealBloomPass instead of hand-rolled bloom. Re-check Risks 1 and 3 in the breakdown doc under the new setup.

Phase 0 gate → Phase 1 (port all 9 archetypes to 3D frames) → Phase 2 (controls, progressive disclosure + presets, not 20 raw sliders) → Phase 3 (atmosphere: caustics, sediment, bloom, feeding interaction, WebM record) → Phase 4 (hardening: adaptive density governor, fill-rate caps).

## Testing conventions used so far

Headless Playwright: load page, wait, screenshot at multiple timestamps, count rAF ticks over 2s for FPS, collect pageerror/console errors, and actually LOOK at the screenshots before declaring success. Keep doing this.

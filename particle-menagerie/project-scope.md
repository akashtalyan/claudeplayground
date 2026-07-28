# Project Scope — Particle Menagerie v3

**What I will build:** a three.js rebuild of the Particle Menagerie — an interactive browser aquarium where typing the name of a sea creature or flower summons it as a lit, glowing particle form drifting in a dark underwater scene. This document defines the scope of that work: deliverables, phase-by-phase execution, acceptance criteria, and what is explicitly out of scope.

This scope executes the phased plan from `threejs-critical-breakdown.md` §5 **as amended by** `risk-spike-report.md` §3 and governed by `technical-assessment.md`. Where those documents conflict with older docs, this scope and the assessment win.

| | |
|---|---|
| Branch | `claude/new-project-branch-6xtcng` on `akashtalyan/claudeplayground` |
| Working directory | `particle-menagerie/` |
| Stack | three.js (exact version pinned, lockfile committed) + vite; plain JS + GLSL; no other runtime dependencies |
| Delivery target | `vite build` + single-file plugin → one distributable HTML page; dev via vite server |
| Baseline | v2 prototype (`particle-menagerie.html`) stays untouched as the comparison artifact |

---

## 1. In scope — the work, phase by phase

### Phase A — Groundwork (docs + skeleton) *[before any rendering code]*
1. Reconcile the documentation set: stamp the stale sections of `threejs-approach.md` (fade quad §3, cdnjs/r128 §8) as SUPERSEDED; add the "superseded requirements" block to `CLAUDE.md` (monochrome→monochrome-by-default-with-color; scope→ocean+flora, 9 archetypes; delivery→vite build; Canvas2D fallback→dropped with a "WebGL required" message).
2. Write the one-paragraph **frame graph spec**: additive points (`toneMapped=false`) → HalfFloat linear accumulation targets (trails ping-pong, energy normalized by (1−fade), fade clamped < 1, accumulation clamped) → single OutputPass owning the one tonemap + one sRGB encode.
3. Write the **geometry spec**: rotation-minimizing frames (double-reflection), deterministically seeded; curvature-aware sway clamp (max κ·r ≤ ~0.7); arc-length ring placement; per-station frame computation with typed-array dot state; frozen RNG draw order.
4. Scaffold the vite project, pin three.js exactly, commit the lockfile, set up the build + `vite preview` test path.

### Phase B — The lighting spike (the go/no-go) *[maps to amended Phase 0]*
Build **two hardcoded creatures** — the eel (best case: true ring-tube) and one sheet archetype (ray or bloom, the adversarial case) — with the full lighting stack: 3D two-wave spine, quantized rings, per-dot normals (ring-offset for tubes, analytic surface normals for the sheet), directional Lambert + rim shading, additive glow sprites, tonemapping, particle DOF, exponential fog, trails via the specified accumulation target. Plus the decisions that must be made here: point-size policy (DPR-aware, queried caps, sub-pixel alpha fade, near-plane clamp, edge strategy), camera×trails coupling (fade-on-camera-delta), `preserveDrawingBuffer: false`, one shader program with uniform-driven variants, local-space geometry with fixed bounding spheres.

**Test artifacts I will produce:** screenshots at default and sway-2.4 (frame-flip check), a synthetic 10-eel pileup (blowout check), a 10-minute stationary soak (trails-reach-black check), contact-sheet motion strips via a fixed-step clock, isolated CPU-loop timing under 4× throttle, and a SwiftShader-flagged renderer assertion in the test script.

**Gate (user decision, not mine):** side-by-side of the v3 eel vs the v2 eel vs an annotated reference still. Pass = *closer to the reference than to v2*. I will prepare the comparison and a frame-time HUD build for the user's real hardware; the user judges. Failure branch is pre-agreed: one structured tuning session (F1), then re-scope discussion (F6) — not silent phase-continuation.

### Phase C — The menagerie port *[maps to Phase 1]*
All nine archetypes (eel, medusa, fish, ray, octo, star, amorph, bloom, kelp) rebuilt on 3D frames using the per-archetype normal-strategy table; lexicon, modifiers, colors-in-names, counts/schools wired; spawn/disperse with staggered formation; schooling; seabed flora rooted in 3D; deterministic name→creature preserved (same URL = same board).
**Exit:** screenshot sweep of 12 creatures at two camera angles **and two light azimuths** — every archetype passes the squint test *and* shows directional shading (or a documented deliberate alternative); school-pileup screenshot stays bounded; CPU budget holds.

### Phase D — Controls *[maps to Phase 2]*
Per-creature panel (color, glow, tempo, sway, size + advanced drawer) and global panel (light direction/color, exposure, focus/aperture, fog, current, trails, turbulence) with progressive disclosure and presets ("moonlit", "abyss", "bioluminescent bay") — restraint over knob-count, per Risk 8. Ripple/lure/parallax ported. A ship/advanced/cut triage of the §1 control catalog happens with the user at phase entry; the catalog is a menu, not a requirements list.
**Exit:** headless script drives every shipped control with before/after screenshots; no dead knobs; visible-control count stays within the agreed triage.

### Phase E — Atmosphere & behavior *[maps to Phase 3]*
Caustic light shafts, drifting sediment, AO blobs under flora, bloom via the official composer pass, feeding interaction, re-form button, ambient mode, PNG snapshot + WebM recording (same-rAF capture, no `preserveDrawingBuffer`). URL schema finalized and presets tuned **here** (after the systems they orchestrate exist).
**Exit:** 10-minute unattended soak — no fps decay on governor telemetry, no accumulation artifacts, trails reach black.

### Phase F — Hardening & delivery *[maps to Phase 4]*
Adaptive quality governor with the correct lever ordering (renderScale/DPR cap → sprite-size cap → dot render-fraction via cross-ring shuffle — never build-count); resize/devicePixelRatio correctness; Safari/Firefox sanity; final tuning of the default preset; production build; a short "what to try" note for the user.

### Continuous (all phases)
- Testing per the split-gate convention: headless = correctness, console errors, CPU frame-loop budget; GPU FPS = the user's hardware via the HUD build. I look at every screenshot before declaring success.
- Commit and push to `claude/new-project-branch-6xtcng` at every meaningful checkpoint with descriptive messages; docs updated whenever a decision changes them.

## 2. Deliverables

1. **The application:** dev-runnable vite project + built single-file distributable page.
2. **Test harness:** Playwright scripts producing the screenshot/soak/contact-sheet artifacts per phase, runnable on demand.
3. **HUD build:** a dev flag showing frame time, renderer string, canvas backing size — for the user's real-hardware gates.
4. **Living docs:** this scope, the reconciled planning docs, and a short CHANGELOG-style note per phase describing what landed and what the next gate is.

## 3. Out of scope (will not do without an explicit new decision)

- **Mesh/PBR photoreal rendering, AI image/video generation in the render path, staying on Canvas2D** — all examined and rejected (`technical-assessment.md` §4, rejected fallbacks).
- **Land animals / non-ocean archetypes** — cut by decision #1 in `CLAUDE.md`.
- **Accounts, cross-device persistence, multiplayer, analytics** — PRD non-goals; the "median session > 3 min" success metric is retired with them.
- **Canvas2D fallback for WebGL-less browsers** — replaced by a "WebGL required" message; v2 remains in-repo as the emergency demo.
- **Full GPGPU rewrite, sound-reactive mode, gallery view, mobile-first optimization** — deferred; hybrid GPGPU easing (F4) only if the CPU loop measures > ~6 ms on target hardware.
- **Hosting/deployment beyond the built file** — a static-host story exists as fallback F7 but is not scheduled work.

## 4. Decision points reserved for the user

I proceed autonomously within each phase but stop for these:
1. **The Phase B gate verdict** — "closer to the reference than to v2" is the user's call on their hardware.
2. **The Phase D control triage** — which catalog controls ship visible, hide in advanced, or get cut.
3. **Any fallback beyond F1–F3** — re-scoping the product bar (F6), hybrid GPGPU (F4), or switching to instanced quads project-wide (F5) are scope changes, not tuning.
4. **Anything that would touch v2, the PRD's historical record, or push to a different branch.**

## 5. Success criteria (replacing the PRD's retired metrics)

- Phase B gate passed by the user on real hardware.
- Every archetype in the Phase C sweep shows directional shading and passes the squint test against an *ocean-name* list.
- Deterministic reproduction: same URL renders the same board on different machines (density degradation is render-fraction only).
- CPU frame loop within budget under 4× throttle headlessly; user-reported smooth feel on their hardware at default preset.
- The built page loads from a double-click with no network access and no console errors.

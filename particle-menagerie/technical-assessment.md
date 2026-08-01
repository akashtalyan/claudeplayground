# Technical Assessment — Particle Menagerie v3 (three.js rebuild)

**Purpose:** one document that answers three questions before Phase 0 work begins: *where will this approach work*, *what are the risks that could sink it*, and *what do we fall back to if a risk fires*. It consolidates `threejs-approach.md`, `threejs-critical-breakdown.md`, and the adversarially-verified findings in `risk-spike-report.md`. Where those docs disagree, this document states the reconciled position.

| | |
|---|---|
| Project | Particle Menagerie — abyssal aquarium of procedural particle creatures |
| Decision under assessment | Rebuild v2 (Canvas2D) as v3 on three.js: CPU creature math + GPU point-sprite rendering, full lighting stack |
| Status | Pre–Phase 0 (lighting spike not yet started) |
| Inputs | 4 project docs + 33 deduplicated findings from a 21-agent adversarial risk review (47 of 48 raised findings survived verification) |

---

## 1. The approach in brief

- **CPU (JS):** name → hash → archetype → parameters (unchanged from v2); per-frame 3D skeleton math producing a target position per dot; easing toward targets for liquid formation/morphing.
- **GPU (GLSL):** perspective point sprites with additive blending, per-dot normals + Lambert/rim shading, tonemapping, particle depth-of-field, exponential fog, trails via offscreen accumulation.
- **Delivery:** modern three.js via npm/vite (the old cdnjs-r128 constraint is gone), built to a distributable page.
- **Process:** phased with gates — Phase 0 is a lighting spike (hardcoded creatures, full lighting stack) that must visibly justify the rebuild before anything is ported.

## 2. Where this works — viability assessment

The core bet is sound. The adversarial review attacked the plan for ~1.25M tokens of analysis and did **not** find a reason the architecture can't reach its goal — it found unspecified decisions, stale numbers, and gate blind spots. Areas of genuine strength:

**2.1 The medium fits the goal.** "Physically plausible light in a stylized medium" is achievable with particles: additive glow sprites, tonemapped HDR accumulation, depth fog, particle DOF, and directional shading are all standard, cheap GPU techniques. None of the verified findings challenge this ceiling — they challenge the *execution spec*, which is fixable on paper before code.

**2.2 The CPU/GPU split is right for this product.** Nine archetype families with branching creature logic iterate far faster in JS than as GPGPU shaders, and the expensive half (drawing tens of thousands of glowing sprites) is exactly what GPUs do well. The review confirmed the split; it corrected only the *budget arithmetic* (per-station frame computation is mandatory, not optional — see R6).

**2.3 Tube-like archetypes get lighting almost for free.** For the eel, octopus/starfish arms, kelp strands, and the medusa bell, ring-offset directions are valid surface normals — the "lit volume" effect that motivates the rebuild genuinely works there, covering the reference showpiece and most of the menagerie.

**2.4 ~60% of v2 carries over.** Lexicon, name parsing, modifiers, URL persistence, panel UI, schooling logic, and the deterministic parameter pipeline are rendering-independent and proven in the working prototype.

**2.5 The modern toolchain removes the worst 2021 constraints.** npm/vite unlocks official `EffectComposer`/`UnrealBloomPass`/`OutputPass` (correct tonemap+sRGB placement by default), TypeScript-grade tooling, and version pinning — retiring old Risk 1 (CDN dependency) entirely, at the cost of a delivery decision (see R9/F7).

**2.6 The phased-gate process is the right shape.** Front-loading the go/no-go on the lighting look is correct; the review's criticism is that the gate as *written* measures the wrong things (see R7, R8) — the amendment list in `risk-spike-report.md` §3 fixes the gate, it doesn't replace the process.

**Conditions for §2 to hold** (all cheap, all pre-code): the frame graph is written down (half-float linear targets, exactly one tonemap), rotation-minimizing frames + curvature clamping are specified, a per-archetype normal strategy table exists, three.js is pinned, and the perf gate is split between headless-CPU and real-hardware-GPU.

## 3. Risk register (consolidated and verified)

Severity reflects post-verification ratings. "Original register" = the 10 risks in `threejs-critical-breakdown.md` §4; findings below either extend or correct it. Full mechanisms in `risk-spike-report.md`.

| # | Risk | Sev. | Essence | Primary mitigation | Fallback |
|---|---|---|---|---|---|
| R1 | **No valid perf gate in the test harness** | High | Headless Chromium here runs SwiftShader (measured 2.9 fps on the planned workload); every absolute-FPS exit criterion is unmeasurable where tests run | Split gates: headless = CPU budget + correctness; GPU FPS = manual gate on user hardware with a frame-time HUD | F8 |
| R2 | **Trails buffer precision/energy unspecified** | High | 8-bit target → permanent non-fading smear; half-float without energy normalization → stationary flora blow out to white | Mandate `HalfFloatType`, normalize injected energy by (1−fade), clamp fade < 1, 10-min stationary soak test | F3 |
| R3 | **Perf budget describes a dead pipeline** | High | "60fps/16 creatures/iGPU" was budgeted for the r128 fade-quad path, not the mandated HDR+ping-pong+tonemap chain; DPR handling deferred to Phase 4 | Re-issue the budget for the real pipeline at DPR 1 and 2; pull `renderScale` + DPR cap into Phase 0 | F2, F4 |
| R4 | **Additive blowout** (original Risk 2, sharpened) | High | Dense overlap accumulates past the tonemap shoulder; per-creature alpha scaling never fires for *cross-creature* overlap (schools); untestable in a one-eel Phase 0 | HDR-linear pipeline with single final tonemap; synthetic 10-eel pileup screenshot in Phase 0 | F3 |
| R5 | **"Normals for free" is false for sheet archetypes** | Med | Ray (~90% of dots), bloom petals (~72%), fins: offset lies *in* the surface — Lambert lights the rim, faces stay flat; current gates can't catch it | Per-archetype normal-strategy table; add a sheet archetype to the Phase 0 spike | F5 |
| R6 | **Spine geometry gaps: frame flips, curvature, arc length** | Med | Cross-product frames flip at sway ≳1.5–2 and degenerate on vertical stems; κ·r ≈ 1.2 *at default sway* interpenetrates rings; uniform-x ribs visibly breathe | Rotation-minimizing frames (double-reflection, ~20 lines); curvature-aware sway clamp; arc-length ring placement | F5 |
| R7 | **Gate bar mismatch** | Med | "Clearly beats v2" passes almost automatically; the user's real anchor is the reference video; no comparison procedure or failure branch defined | Gate = eel vs v2 eel vs annotated reference still; pass = "closer to the reference than to v2"; pre-agree the failure branch | F1, F6 |
| R8 | **Stills can't gate a motion-defined aesthetic** | Med | Trails, coil evolution, formation, twinkle are temporal; screenshots at ~3 fps SwiftShader render trails ~20–30× too long | Frame-rate-independent decay + fixed-step time hook; contact-sheet strips; live viewing by the user as the actual gate | — |
| R9 | **Doc drift & unpinned toolchain** | Med | `threejs-approach.md` still specifies the forbidden fade quad and r128; no three version pinned while r152+ color management sits under the blowout risk; four PRD requirements silently dead | Pin exact three version + lockfile; SUPERSEDED stamps; "superseded requirements" block in CLAUDE.md | F7 |
| R10 | **CPU ceiling** (original Risk 4, corrected) | Med | The "1–2 ms" claim fails its own arithmetic (240k trig ≈ 2.5–6 ms); naive per-dot math burns the budget | Per-station frames + precomputed ring angles (~1 trig/dot); typed arrays; measure isolated loop under 4× CPU throttle | F2, F4 |
| R11 | **Platform point-sprite behavior** | Med | `gl_PointSize` caps vary (63–1024 device px); device-pixel semantics halve dot size on retina; center-clipping pops sprites at screen edges | Query caps at startup; DPR-aware sizing with alpha fade below ~1.5 px; edge strategy decided in Phase 0 | F5 (instanced quads) |
| R12 | **Camera motion × screen-space trails** | Med | Parallax/orbit ghost-streaks the screen-anchored accumulation buffer; discovered in Phase 2 as designed, after the architecture locks | Decide coupling in Phase 0: fade-on-camera-delta (cheap default) | F3 |
| R13 | Control clutter, expectation gap, determinism drift, delivery story, misc. | Low–Med | See original Risks 7–9 and report findings M10–M22, L1–L5 | Progressive disclosure; presets; frozen RNG draw order; vite build + singlefile plugin | F6, F7 |

**What was checked and dismissed:** the rAF-tick FPS methodology itself (discriminates correctly — the problem is only the SwiftShader substrate); coil self-intersection of distant body segments (x is strictly monotone — the real issue is local curvature, R6).

## 4. Fallback options

Ordered from "adjust course" to "different product." Each has an explicit **trigger** so the decision is made by evidence, not sunk cost.

### F1 — Argue about light, then re-tune (in-plan)
**Trigger:** Phase 0 gate verdict is "better than v2 but not the reference."
The plan's built-in first response: the lighting stack has ~10 orthogonal knobs (exposure, halo/core ratio, fog density, DOF aperture, rim strength, trail length, twinkle). One structured tuning session against annotated reference stills before touching architecture. Cheap; bounded to days.

### F2 — Density/quality governor ladder (in-plan)
**Trigger:** real-hardware FPS misses target (R3, R10).
Degrade in the order that preserves the look: renderScale ↓ → DPR cap 1.5 → sprite-size cap ↓ → dot fraction ↓ (via deterministic cross-ring shuffle so any prefix is a uniform subsample) → creature cap ↓. Never build-count changes (breaks determinism). All levers exist by Phase 0 under the amended plan.

### F3 — Simplify the composite chain
**Trigger:** trails plumbing (R2, R12) or blowout control (R4) resists tuning.
Retreat rungs, each losing one feature, not the product: (a) drop bloom, keep sprite-level glow (the breakdown's own assessment: sprite glow is 80% of the look); (b) drop trails entirely — the reference aesthetic survives without long-exposure trails; (c) drop HDR accumulation and clamp in-shader with per-dot alpha budgeting — crude but ships. Each rung removes a full-screen pass, which also helps R3.

### F4 — Hybrid GPGPU for hot paths only
**Trigger:** CPU loop measured > ~6 ms on target hardware after per-station optimization (R10), or density ambitions grow past ~50k dots.
Move only the *easing* (pos += (target−pos)·k) into a transform-feedback/GPGPU pass while keeping target computation on CPU — the halfway house the breakdown's Alternative A analysis allows. Full GPGPU (targets in shaders) remains the last resort; it was rejected for iteration-speed reasons that remain valid.

### F5 — Per-archetype rendering strategies instead of one universal recipe
**Trigger:** sheet-archetype shading fails in Phase 0 (R5), or point-size caps break DOF on target platforms (R11).
Abandon "one shader recipe for all nine archetypes": tubes keep ring normals; sheets get analytic surface normals (∂P/∂u × ∂P/∂v); volumes (amorph) get a deliberate radial pseudo-normal or stay unlit-glow. If sprite caps bite, switch the affected creatures (or all) to instanced quads — same visual result, ~2× vertex cost, no size cap. This is scope-bounded extra math per archetype, not a redesign.

### F6 — Re-scope the product bar
**Trigger:** Phase 0 fails even after F1, or the user's reaction to the amended gate is "still not it."
Options, in order of preference: (a) reframe v3 as "v2 with real glow and depth" — ship the tonemapped additive look without chasing the reference's full fidelity, cut DOF/bloom/caustics; (b) narrow to a "hero aquarium" — 3–4 archetypes tuned to excellence instead of 9 at parity; (c) pivot the deliverable from interactive board to a curated ambient screensaver (removes the control surface, keeps the aesthetic). All keep the particle identity and the procedural pipeline.

### F7 — Delivery fallbacks
**Trigger:** vite/npm build friction, or single-file distribution turns out to matter (R9).
(a) `vite build` + `vite-plugin-singlefile` → one distributable HTML file, restoring the old delivery story with modern three; (b) pin modern three as a static ESM vendored file, no bundler — worse DX, zero build; (c) last resort: r128 global build inline (~600 KB) — known-obsolete but proven. Canvas2D fallback for WebGL-less browsers is formally dropped (a "WebGL required" message replaces it); v2 remains in the repo as an emergency demo artifact.

### F8 — Testing fallbacks
**Trigger:** no access to real-GPU hardware for gates (R1).
(a) The user's own machine is the gate hardware — they judge the look anyway, so the FPS HUD rides along for free; (b) a cloud GPU runner (e.g. a GPU CI instance) for automated FPS regression, if the project outgrows manual gating; (c) if neither exists, gates become CPU-budget + correctness + user-reported feel, explicitly accepting that fill-rate regressions are caught late. SwiftShader numbers are never evidence of anything except correctness.

### Explicitly rejected fallbacks (do not revisit silently)
- **Mesh/PBR rendering** — different product; abandons the particle identity (breakdown Alternative B).
- **AI image/video generation in the render path** — kills interactivity; ruled out with the user (decision #2 in CLAUDE.md).
- **Staying on Canvas2D** — empirically capped; v2's "not impressive" verdict is the evidence (Alternative C).

## 5. Bottom line

**The approach is viable and the recommendation is to proceed** — but only with the amended Phase 0 from `risk-spike-report.md` §3: two creatures (eel + one sheet archetype), the synthetic pileup and sway sweep, the frame graph and geometry specs written before code, a pinned three.js, split perf gates, and the honest gate bar ("closer to the reference than to v2").

The failure modes that could genuinely kill the project (light quality below expectation, blowout, trails plumbing) all have both a mitigation and a fallback rung above "abandon"; the architecture-level alternatives were examined and remain correctly rejected. The single most important process change: every high-severity risk now has its checkpoint **inside Phase 0**, where the original plan let three of them (R1, R4-cross-creature, R5) slip past the gate unexercised.

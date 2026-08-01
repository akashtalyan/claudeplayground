# Particle Menagerie on three.js — Controls, Lighting, Risks, and a Critical Breakdown

This document answers four questions honestly: what controls the engine can support, how far "realistic lighting" can go in a particle medium, what the real risks are (including flaws in my own earlier plan), and the build breakdown with go/no-go gates.

---

## 1. The full control surface

Three.js makes most controls a uniform write or a parameter change — cheap to add. The danger is not feasibility; it is clutter (see §4, Risk 8). Grouped by layer:

### Per-creature (selected via click)

| Control | What it does | Cost to build |
|---|---|---|
| Color | Halo tint; two-tone gradient (core color + tip color along the body) | trivial / easy |
| Iridescence | Hue shifts subtly with viewing angle per dot | easy (shader) |
| Glow | Brightness multiplier | trivial |
| Dot size / density | Sprite scale; fraction of dots rendered | trivial / easy |
| Size | Overall scale — dots morph smoothly to the new form | trivial (exists) |
| Tempo | Animation + swim speed | trivial (exists) |
| Sway | Undulation amplitude | trivial (exists) |
| Twinkle | Shimmer rate/depth | trivial |
| Behavior | drift / patrol a path / follow cursor / school / sleep (settle near seabed) | moderate |
| Depth | Push creature nearer/farther (parallax layer) | easy |
| Re-form | Dissolve and re-coalesce on demand (the formation moment, replayable) | easy |
| Release | Disperse permanently | exists |

### Scene & lighting (global panel)

| Control | What it does | Cost |
|---|---|---|
| Light direction & color | Moves the "sun/moon" — creatures shade accordingly (see §2) | moderate |
| Exposure / tonemap | Master brightness curve; prevents additive blowout | easy |
| Bloom strength | Light spill between dots (post-process) | moderate–hard (see §2) |
| Fog density & color | How fast distance swallows light | easy |
| Focus depth + aperture | Particle depth-of-field: out-of-focus dots swell and soften | easy (cheap trick, big payoff) |
| Caustics / light rays | Animated surface-light shafts from above | easy–moderate (faked) |
| Current | Direction + strength; bends flora, pushes swimmers | exists |
| Turbulence | Noise field that ruffles all dots (storm ↔ calm) | easy |
| Trails | Exposure length | exists (needs rework, see Risk 5) |
| Camera | Parallax amount; slow auto-orbit; zoom | easy |
| Time of day | Preset curve tying light color, fog, caustics together | easy once the above exist |

### Interaction & output

Feeding (click drops a glowing mote; nearby creatures race to it), drag-to-toss with recovery, follow-cam on double-click, ripple radius/strength, ambient/zen mode (UI fades, camera drifts), PNG snapshot (trivial), WebM recording via `MediaRecorder` on the canvas (easy), and share-link state in the URL (exists; would grow to encode control values).

**Critical note:** more controls is not automatically better. The reference's power is restraint. My recommendation is two visible sliders per panel plus an "advanced" drawer, and presets ("moonlit", "abyss", "bioluminescent bay") instead of exposing every raw number by default.

---

## 2. Can the lighting be *realistic*? An honest answer

Short version: **lighting can get dramatically more physical; the creatures themselves can never be photoreal in this medium — and shouldn't be.**

A particle creature has no surface: nothing to receive a shadow, no skin to scatter light. "Realistic rendering" in the photoreal sense (PBR materials, soft shadows, subsurface scattering) belongs to *mesh* rendering, and going there would abandon the dotted-particle aesthetic you picked this project for — you would be building a different product (see §3, Alternative B).

What we *can* do is make the **light itself behave realistically**, which is what actually sells underwater scenes:

1. **Directional shading per dot (the big one).** Our skeletons are built from rings, so every dot's offset direction from the spine *is* its surface normal — we get normals for free, which is rare for particle systems. Pass the normal as an attribute; in the shader, compute Lambert + a small specular against the light direction. Dots on the lit side glow warm and bright; the far side falls into shadow; a rim-light term catches silhouettes. The creature stops being a uniform dot cloud and becomes a *lit volume*. This is the highest realism-per-millisecond upgrade available, and it is cheap.
2. **Tonemapping + exposure.** Additive blending without a tone curve blows out to flat white where dots pile up. An ACES-style curve in the final composite keeps hot cores luminous but bounded — this alone reads as "rendered" versus "drawn."
3. **Bloom (light spill).** True bloom is a post-process: render to a target, blur the bright pass, composite. Three.js's `UnrealBloomPass` lives in the examples modules, which are *not* on cdnjs for the r128 global build — so either hand-roll a two-pass blur bloom (~100 lines, well-trodden) or accept sprite-level glow only. Honest assessment: sprite glow gets 80% of the look; real bloom adds the last 20% (glow bleeding over neighbors). Phase it late.
4. **Particle depth-of-field.** Real DOF post-processing is expensive; the particle cheat is not: dots far from the focus plane render larger and fainter. It looks like a macro lens underwater and costs two lines in the vertex shader. An "aperture" slider falls out for free.
5. **Volumetric atmosphere.** Fog (exponential with distance), animated caustic light-shafts from the surface, drifting sediment motes near the seabed, and a soft AO blob under rooted flora. All faked, all cheap, and collectively they carry more "underwater realism" than any material upgrade would.
6. **What we cannot do (and the fix):** particles casting shadows on each other (skip it — additive light doesn't need it); reflections (irrelevant in dark water); photoreal anatomy (wrong medium — if you ever want that, it's a mesh/AI-video project, not this one).

**Bottom line:** aim for *physically plausible light in a stylized medium* — lit volumes, bounded exposure, depth, atmosphere. That is what the reference does, and it is achievable. Chasing photorealism in particles would burn the schedule and land in the uncanny middle: too literal to be elegant, too dotty to be real.

---

## 3. Why this approach — argued critically, alternatives included

**The claim:** CPU creature-math + GPU point-sprite rendering in a single three.js file is the right architecture. Here is the case against, taken seriously:

**Alternative A — full GPGPU (targets computed in shaders).** Strictly faster: millions of dots, zero CPU loop. Rejected because archetype variety is the product — nine creature families with branching logic each become a shader-management problem, iteration slows to a crawl, and per-creature controls (tempo, sway, morphing size) get harder to wire. We would be optimizing the part that isn't the bottleneck (24k dots is ~1–2 ms on CPU) at the cost of the part that is (design iteration speed). *The critical caveat that keeps this honest:* if we later want 10× density or 50 creatures, this decision must be revisited — the CPU loop is the ceiling, and hitting it means a meaningful rewrite, not a tweak.

**Alternative B — mesh-based "realistic" rendering.** Skinned meshes, PBR, real lights and shadows. Rejected as a *different product*: it abandons the aesthetic identity (the reference is dotted particles), triples the asset problem (meshes must be modeled or generated per creature; particles are pure math), and still wouldn't look *good* without artist-grade models. Photoreal is a treadmill; stylized-physical is a destination we can actually reach.

**Alternative C — stay on Canvas2D and polish.** Cheapest path, and v2 proved its ceiling: no glow without killing the frame budget, no real depth, square dots. The user verdict ("not impressive") is empirical evidence this ceiling is too low.

**Alternative D — AI image/video generation per creature.** Maximum per-frame beauty, zero interactivity — no live controls, no cursor response, no shared canvas, 5–30 s latency and per-generation cost. It is a gallery, not a board. Could complement later (mood frames, marketing shots); cannot be the core.

**Why A-lite (our approach) wins:** it keeps iteration fast where the product risk is (creature quality), spends GPU budget where the perception gap is (glow, depth, light), maps every control to a uniform or parameter, migrates ~60% of working v2 code, and stays a single testable HTML file. The honest weakness is the CPU ceiling and single-file sprawl (~1,500 lines) — both acceptable at prototype scale, both flagged for revisit.

---

## 4. Risk register — including flaws in my earlier plan

| # | Risk | Severity | Honest assessment & mitigation |
|---|---|---|---|
| 1 | **CDN dependency.** r128 from cdnjs is a 2021 build; the file breaks offline; claude.ai preview iframes only allow cdnjs, so newer ESM builds + addon modules (bloom, composer) may not load there. | High | Accept r128 global build; hand-roll bloom if wanted; test in the actual preview early (Phase 0). Escape hatch: inline three.js into the file (adds ~600 KB). |
| 2 | **Additive blowout.** Dense overlaps (schools, big creatures) accumulate to flat white — *worse* at the higher densities three.js enables. My earlier plan underplayed this. | High | Tonemap in the composite; cap per-dot alpha; auto-reduce alpha as creature dot-count rises. Must be in Phase 0, not polish. |
| 3 | **Trails × tonemapping conflict.** My fade-quad trick assumes drawing straight to screen. With a post-process chain (bloom/tonemap), trails must accumulate in an offscreen target instead — different plumbing. Deciding late = rework. | Medium | Decide in Phase 0: if bloom is in, trails move to a ping-pong render target (standard, but ~50 lines more). |
| 4 | **CPU easing ceiling.** 24k dots is fine on a laptop; a low-end machine with 16 creatures × higher density could spike past 8 ms. My "GPU makes density free" claim was half-true — rendering scales, the JS loop doesn't. | Medium | Adaptive density governor (measure frame delta, scale dot fraction); typed-array discipline; no allocation in the frame loop (v2 already does this). |
| 5 | **Fill-rate on integrated GPUs.** Large glowing sprites overlapping = heavy overdraw; this, not point count, is the real GPU cost. | Medium | Cap sprite pixel size; scale halo radius down when total dot count is high. |
| 6 | **Hit-testing lies at depth.** My 2D screen-projection hit-test mis-picks when creatures overlap at different depths. | Low | Prefer the nearer (larger projected radius) creature; good enough for a board; note as known-issue. |
| 7 | **Lighting expectation gap.** If "realistic" means photoreal to you, §2's ceiling disappoints regardless of execution quality. | High (product, not technical) | This document *is* the mitigation: agree on "physically plausible light, stylized medium" before Phase 0, or stop and re-scope the product. |
| 8 | **Control-surface clutter.** Twenty sliders would kill the calm that makes the reference beautiful; the product becomes a VJ rig. | Medium | Progressive disclosure: 2–3 controls visible, advanced drawer, and presets. Resist shipping every possible knob from §1. |
| 9 | **Single-file sprawl.** ~1,500 lines of shader strings + math + UI in one HTML file; iteration gets slower and riskier near the end. | Low–Medium | Strict section discipline; if it passes ~2k lines, split into files and deliver as a zip. |
| 10 | **Schedule risk: the eel checkpoint fails.** If the Phase 0 eel doesn't clearly beat v2, more phases won't save it. | Low but decisive | That's why it's a gate: one creature, full lighting stack, judged by you before anything else is ported. |

---

## 5. Build breakdown (phased, each with a gate)

**Phase 0 — the lighting spike (the go/no-go).**
Scene + camera + tonemapped additive pipeline + trails (offscreen target) + ONE eel with: 3D ribbed rings, per-dot normals, directional shading, rim light, particle DOF, fog. No lexicon, no controls, hardcoded. Headless screenshots at three angles + FPS.
*Exit criteria:* you look at the eel and say it clearly beats v2. If not, we argue about light, not code. **Everything else waits for this gate.**

**Phase 1 — the menagerie port.**
All nine archetypes rebuilt on 3D frames with normals; lexicon/modifiers/colors/counts wired; spawn/disperse with staggered vortex formation; schooling; seabed flora rooted in 3D.
*Exit:* screenshot sweep of 12 creatures; each passes the squint test at two camera angles; 60fps.

**Phase 2 — controls.**
Per-creature panel (color, glow, tempo, sway, size + advanced drawer), global panel (light direction/color, exposure, focus/aperture, fog, current, trails, turbulence), presets, ripple/lure/parallax ported, URL state extended to control values.
*Exit:* headless script drives every control and screenshots before/after each; no dead knobs.

**Phase 3 — atmosphere & behavior.**
Caustic shafts, sediment motes, AO blobs under flora, hand-rolled bloom (if Phase 0 chose it), feeding interaction, re-form button, ambient mode, WebM recording.
*Exit:* 3-minute unattended soak test — no fps decay, no visual accumulation artifacts (Risk 2/3 regression check).

**Phase 4 — hardening.**
Adaptive density governor, sprite-size caps, resize/devicePixelRatio correctness, Safari/Firefox sanity (headless where possible), final tuning pass on default preset. Deliver + a short "what to try" note.

Order rationale: risk retires strictly front-to-back — the two things that can kill the project (light quality, blowout/trails plumbing) are both settled in Phase 0 on one creature, before any porting effort is sunk.

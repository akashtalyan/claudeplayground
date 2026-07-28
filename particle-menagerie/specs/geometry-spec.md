# Geometry Spec — v3 skeleton contract

**Status: normative.** Rationale in `risk-spike-report.md` (M3, M5, M6, M12, M14) — this doc is the contract.

## Spine and frames

1. **Spine:** 3D curve `S(s,t)` per archetype (eel: two incommensurate traveling waves, e.g. w₂/w₁ = 1:√2·φ-ish, so the coil never repeats).
2. **Frames are rotation-minimizing (RMF)** via the double-reflection method, propagated from a deterministic seed frame at s=0 (seeded from the creature's RNG, not world-up). Never Frenet, never a fixed world-up cross product. Vertical archetypes (kelp, bloom) get a seed frame perpendicular to the stem axis.
3. **Frame computation is per-station, not per-dot:** ~52 stations/creature; dots are placed with precomputed static ring angles (cos/sin tables) — amortized ≈1 trig per dot per frame. Target: isolated skeleton loop ≤ 4 ms for 24k dots under 4× CPU throttle.
4. **No allocation in the frame loop.** All dot state in preallocated typed arrays (Float32Array), station frames in scratch arrays reused across creatures.

## Curvature and arc length

5. **Curvature clamp:** compute κ(s,t) from the same finite differences as the tangent; scale effective sway so `max(κ·ringRadius) ≤ 0.7`, and locally shrink ring radius toward `0.9/κ` where the clamp alone is insufficient. The sway slider maps through this normalization (slider 2.4 = max *safe* sway, never interpenetrating rings).
6. **Rings are placed at equal arc-length fractions**, not uniform parameter: sample ~200 points, prefix-sum lengths, invert. Body length is arc-length-true (an eel is inextensible — no visible rib breathing or length pulsing with wave phase).
7. **Rings are quantized** (crisp dotted ribs — never randomly scattered), with a slow per-ring twist offset for the spiral rib look.

## Normals (per-archetype strategy — "normals for free" is only true for tubes)

| Class | Archetypes | Normal source |
|---|---|---|
| Tube | eel, octo/star arms, kelp strands, medusa bell | ring offset direction (+ taper tilt correction) |
| Sheet | ray, bloom petals, fish/medusa fins | analytic `∂P/∂u × ∂P/∂v`, normalized |
| Volume | amorph | radial pseudo-normal from blob center (deliberate stylization) |

Spike scope: eel (tube) + ray (sheet) — both strategies proven before Phase C.

## Determinism

8. **RNG:** mulberry32 seeded from name hash; the *draw order is a frozen interface* — any new parameter draws append after existing ones, never insert.
9. **Density degradation is render-fraction only** (drawRange over a build-time deterministic cross-ring shuffle so any prefix is a uniform subsample). Build-time dot counts never vary by machine or governor state.
10. **Creature geometry lives in local space**; placement/heading via the object matrix; fixed local bounding sphere from the archetype's max radius (no stale-frustum-culling vanishing acts, no per-dot world transforms on CPU).

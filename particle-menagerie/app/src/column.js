// The water column and the bathymetric transect — v3.7.
//
// v3.4 made the world a TALL VERTICAL COLUMN of ocean: a rippling surface
// overhead, 1200 m of water, an abyssal seabed at the bottom, and a camera that
// travels it like a vessel. v3.5 bolted a shallow reef BENCH into that column
// as a second, disconnected substrate, because photosynthetic life cannot live
// on a 1200 m plain. Two floors floating at two depths with nothing between
// them was always a placeholder.
//
// v3.7 replaces both with the real thing: ONE SEABED, whose depth is a function
// of where you are along a CROSS-SHELF TRANSECT.
//
//     shore ──inner shelf── ──outer shelf── ▼BREAK
//     0 m         40 m            200 m     ╲
//                                            ╲ continental slope
//                                             ╲__________ abyssal plain 1200 m
//
// So the world gains a SECOND NAVIGATION AXIS. You travel offshore/inshore the
// same way you travel up and down, with the same easing, the same clamps and
// the same shape of API — setShore/shore/targetShore/nudgeShore/shoreRange/
// shoreZoneAt mirror setDepth/depth/targetDepth/nudge/range/zoneAt method for
// method, so the rest of the app learns the new axis in one look. Every
// creature can now sit at its TRUE position in both axes: its depth AND its
// distance from shore, which for most species is not a free parameter — a kelp
// holdfast is at 13 m because it is 2 km offshore on rock, and those are the
// same fact.
//
// This module is the SINGLE SOURCE OF TRUTH for the world's geometry:
//
//   * the two scales — METRES_PER_PX / PX_PER_METRE (vertical) and
//     TRANSECT_METRES_PER_PX / PX_PER_TRANSECT_M (horizontal) — and the
//     boundary planes (SURFACE_Y, SEABED_Y). Every other module imports its
//     numbers FROM HERE and never re-derives them.
//   * THE PROFILE: profileDepthAt(transectMetres) -> seabed depth in metres,
//     plus its inverse transectAtDepth(depth) -> the isobath. Exported pure, so
//     depthbands can give a species a horizontal home and the gauge can draw
//     the coastline it is flying over.
//   * the camera's position on BOTH axes and its navigation (wheel, shift-
//     wheel / horizontal wheel, horizontal drag, arrow keys, PageUp/PageDown,
//     Home/End), critically damped on both: a submarine has mass in every
//     direction, so the porthole eases, it never snaps.
//   * the two scene layers that make the world read as a bounded volume: ONE
//     dotted seabed that follows the profile (reef-lumpy and grey-green in the
//     shallows, silt-warm dune field on the plain, continuously) and a
//     shimmering surface ceiling, both drawn with the ONE dot shader program
//     (frame-graph rule 7) — no new GLSL, no terrain mesh.
//   * the SUBSTRATE QUERY — substrateAt() / seabedYAt() — the one function the
//     rest of the app asks "where is the ground here".
//   * culling info on BOTH axes, so the integrator can skip creatures outside
//     the porthole (now the real perf win: the world is 19 screens wide as well
//     as 11 screens tall).
//
// Contracts honoured:
//   * frame-graph rule 7  — layers reuse createDotMaterial; no new program.
//   * frame-graph rule 11 — no wall-clock reads anywhere; update(dt) takes the
//     injectable clock's delta and the layers' shimmer rides an accumulator.
//   * frame-graph rule 4  — deltaPx() reports the camera's per-frame travel in
//     world px, now the MAGNITUDE of a 2D translation, so horizontal travel
//     flushes the trails exactly the way a dive does.
//   * geometry-spec 8     — every RNG draw comes from one mulberry32 stream in
//     a frozen order (the per-dot block below is append-only and unchanged from
//     v3.5); resize() and every rebuild re-derive positions arithmetically and
//     draw NOTHING, so the world is byte-identical across viewports, reloads
//     and machines.
//   * no allocation in the frame loop — all layer state is preallocated typed
//     arrays; range()/shoreRange()/visibleBand()/visibleShoreBand()/info()
//     return shared objects (read, don't retain).

import * as THREE from 'three';
import { mulberry32 } from './geometry/rng.js';
import { createDotMaterial } from './shaders/dots.js';

// ---------------------------------------------------------------------------
// The vertical scale. ONE constant, defined here, imported everywhere.
// ---------------------------------------------------------------------------

/** Metres of ocean per world pixel, VERTICALLY. The z=0 plane is 1:1 with CSS
 *  px, so this is also metres per CSS pixel of vertical screen travel there. */
export const METRES_PER_PX = 0.2;
/** World px per metre of depth — 1 / METRES_PER_PX, precomputed (5 px = 1 m). */
export const PX_PER_METRE = 1 / METRES_PER_PX;

/** World Y of the water surface. Depth is measured DOWN from here. */
export const SURFACE_Y = 0;
/** Depth of the deepest seabed (the abyssal plain), in metres below surface. */
export const SEABED_DEPTH_M = 1200;
/** Height of the column in world px (1200 m x 5 px/m = 6000 px ≈ 7–11 screens). */
export const COLUMN_PX = SEABED_DEPTH_M * PX_PER_METRE;
/** World Y of the abyssal plain's mean plane (dunes undulate about it). */
export const SEABED_Y = SURFACE_Y - COLUMN_PX;

/** Where a fresh session surfaces: upper twilight, with the shimmering
 *  ceiling still overhead — you start near the light and dive. Advisory; the
 *  integrator may boot anywhere and setDepth() clamps into range(). */
export const DEFAULT_DEPTH_M = 120;

// Ocean zones, real boundaries compressed onto a 1200 m column. The gauge
// reads these next to the metre value; atmosphere can key its weather to them.
export const ZONES = [
  { id: 'sunlit', label: 'sunlit', from: 0, to: 200 },
  { id: 'twilight', label: 'twilight', from: 200, to: 600 },
  { id: 'midnight', label: 'midnight', from: 600, to: 1000 },
  { id: 'abyssal', label: 'abyssal', from: 1000, to: SEABED_DEPTH_M },
];

// ---------------------------------------------------------------------------
// Pure conversions — usable without an instance (species bands, atmosphere).
// ---------------------------------------------------------------------------

/** World Y -> metres below the surface (positive down). */
export function worldYToMetres(y) {
  return (SURFACE_Y - y) * METRES_PER_PX;
}

/** Metres below the surface -> world Y. */
export function metresToWorldY(m) {
  return SURFACE_Y - m * PX_PER_METRE;
}

/** Clamp a depth in metres into [0, SEABED_DEPTH_M] (the WATER, not the
 *  navigable camera range — see column.range() for that). */
export function clampDepth(m) {
  return m < 0 ? 0 : m > SEABED_DEPTH_M ? SEABED_DEPTH_M : m;
}

/** Clamp a world Y into the column [SEABED_Y, SURFACE_Y]. */
export function clampWorldY(y) {
  return y > SURFACE_Y ? SURFACE_Y : y < SEABED_Y ? SEABED_Y : y;
}

/** The zone entry containing a depth (never null; clamps at both ends). */
export function zoneAt(m) {
  const d = clampDepth(m);
  for (let i = 0; i < ZONES.length; i++) if (d < ZONES[i].to) return ZONES[i];
  return ZONES[ZONES.length - 1];
}

/** Surface light reaching a depth, normalised 0..1. Beer–Lambert with the
 *  column's own scale height; ~0.43 at 200 m, ~0.08 at 600 m, ~0.007 at the
 *  seabed. Atmosphere/background may scale intensities by this. */
export function lightAt(m) {
  return Math.exp(-Math.max(m, 0) / 240);
}

function smoothstep01(t) {
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// The horizontal scale, and the vertical exaggeration it implies
// ---------------------------------------------------------------------------
//
// Depth and distance-from-shore are both measured in metres, but they CANNOT
// share a pixel scale. A real cross-shelf transect is ~150 km long and 2 km
// deep: drawn 1:1 the shelf break — the most important landmark in the whole
// ocean floor — is a 0.1° kink invisible at any zoom, and travelling it at the
// column's 5 px/m would be 750,000,000 px of scroll.
//
// So the horizontal axis has its own scale, and the ratio between them is
// stated plainly rather than hidden: VERTICAL EXAGGERATION 10x, which is the
// low end of what every printed bathymetric profile uses (10x–100x). At 2 m of
// transect per world px the whole 36 km transect is 18,000 world px ≈ 19
// screens wide, against the column's 6,000 px ≈ 11 screens tall — the two axes
// are the same ORDER of journey, which is what makes one navigation idiom fit
// both.
/** Metres of transect per world pixel, HORIZONTALLY. */
export const TRANSECT_METRES_PER_PX = 2.0;
/** World px per metre of transect — 1 / TRANSECT_METRES_PER_PX (0.5 px = 1 m). */
export const PX_PER_TRANSECT_M = 1 / TRANSECT_METRES_PER_PX;
/** How much taller than wide the world is drawn, as a plain number. Label it
 *  on any UI that draws the profile — an unlabelled exaggerated profile is the
 *  oldest lie in earth science. */
export const VERTICAL_EXAGGERATION = TRANSECT_METRES_PER_PX / METRES_PER_PX;

/** Length of the transect: shoreline (0 m) to the far offshore end, in metres.
 *  36 km shore-to-plain is a narrow-to-average passive margin — the Californian
 *  margin is ~25 km, the Atlantic ~150 km. See PROFILE_KEYS for what the
 *  compression costs. */
export const TRANSECT_M = 36000;

/** World X of the shoreline. Offshore is +X, so the far offshore end of the
 *  transect sits at world X = 0 — which is exactly where v3.6's world lived.
 *  That is deliberate: a board that never touches the new axis renders the
 *  abyssal plain it always rendered, dot for dot. */
export const SHORE_X = -TRANSECT_M * PX_PER_TRANSECT_M;
/** World X of the far offshore end (0 — see SHORE_X). */
export const OFFSHORE_X = 0;

/** Transect metres offshore -> world X. */
export function transectToWorldX(m) {
  return SHORE_X + m * PX_PER_TRANSECT_M;
}

/** World X -> transect metres offshore (may go past either end; the profile
 *  clamps — land inshore of 0, plain beyond the far end). */
export function worldXToTransect(x) {
  return (x - SHORE_X) * TRANSECT_METRES_PER_PX;
}

/** Clamp a transect position into [0, TRANSECT_M]. */
export function clampTransect(m) {
  return m < 0 ? 0 : m > TRANSECT_M ? TRANSECT_M : m;
}

// ---------------------------------------------------------------------------
// THE BATHYMETRIC PROFILE
// ---------------------------------------------------------------------------
//
// Depth of the seabed as a function of distance offshore. This is the mean
// surface; the relief noise below rides ON it (same idiom as v3.5's dunes and
// reef, now one field whose character follows the profile).
//
// The keys are a real passive-margin cross-section, honestly compressed:
//
//   0 m offshore        0 m   shoreline / intertidal
//   500                 5     surf zone
//   2500               18     inner shelf
//   7000               40     inner-shelf floor      (the 30–50 m bench)
//   13000              85     mid shelf
//   18000             200     ▼ THE SHELF BREAK      (the classic 200 m rim)
//   20000             430     upper slope
//   23000             800     mid slope
//   26000            1120     lower slope
//   28000            1200     the foot
//   36000            1200     abyssal plain, flat
//
// WHERE THIS DEPARTS FROM THE REAL SEAFLOOR — two compressions, both stated,
// neither silent:
//
// 1. THE SLOPE'S FOOT IS THE ABYSSAL PLAIN AT 1200 m, NOT 3500–6000 m. A real
//    continental slope falls from the break to a rise and then to an abyssal
//    plain kilometres deeper than this column's floor. The floor could have
//    been deepened instead — and it was considered — but SEABED_DEPTH_M = 1200
//    is not a private number: the four ocean ZONES are cut against it, the
//    whole depth-optics keyframe table in depthprofile.js ends on it, every
//    researched species band in ocean-data.json is expressed inside it, and the
//    harness asserts it. Moving the floor would have relocated every creature
//    in the app to satisfy a landmark you cannot see from the slope anyway.
//    So the SLOPE is compressed instead: it falls 200 -> 1200 m rather than
//    200 -> 2000+. What is preserved is the thing that makes a slope a slope —
//    its GRADIENT, ~7° here against a real 3–6° — and the fact that it is an
//    order of magnitude steeper than the shelf it drops off.
//
// 2. THE WHOLE TRANSECT IS ~4x SHORT (36 km rather than ~150 km shore-to-rise),
//    which multiplies every gradient by 4: the shelf reads at ~1% where a real
//    one is ~0.1%. The RATIO of shelf gradient to slope gradient — about 1:9,
//    and that ratio IS what the shelf break is — survives the compression,
//    which is why the break still reads as a knee and not as a bend.
//
// Interpolation is monotone cubic Hermite (Fritsch–Carlson / PCHIP): it passes
// through every key exactly, it is C1 (no kinks except the one at the break,
// which is the point), and it CANNOT overshoot — a monotone key list gives a
// monotone seabed, so the profile is invertible and transectAtDepth() below is
// well defined. A plain smoothstep between keys would have flattened the
// gradient to zero at every key and terraced the slope.
export const PROFILE_KEYS = Object.freeze([
  Object.freeze({ m: 0, depthM: 0 }),
  Object.freeze({ m: 500, depthM: 5 }),
  Object.freeze({ m: 2500, depthM: 18 }),
  Object.freeze({ m: 7000, depthM: 40 }),
  Object.freeze({ m: 13000, depthM: 85 }),
  Object.freeze({ m: 18000, depthM: 200 }),
  Object.freeze({ m: 20000, depthM: 430 }),
  Object.freeze({ m: 23000, depthM: 800 }),
  Object.freeze({ m: 26000, depthM: 1120 }),
  Object.freeze({ m: 28000, depthM: SEABED_DEPTH_M }),
  Object.freeze({ m: TRANSECT_M, depthM: SEABED_DEPTH_M }),
]);

/** Transect metres of the shelf break — the profile's one landmark. */
export const BREAK_M = 18000;
/** Depth of the shelf break, metres. The classic 200 m rim. */
export const BREAK_DEPTH_M = 200;
/** Transect metres at which the slope has bottomed out onto the plain. */
export const PLAIN_START_M = 28000;

// PCHIP coefficients, built once at module load. Pure arithmetic, no RNG.
const PK_S = new Float64Array(PROFILE_KEYS.length);
const PK_D = new Float64Array(PROFILE_KEYS.length);
const PK_T = new Float64Array(PROFILE_KEYS.length); // tangent at each key
(function buildProfile() {
  const n = PROFILE_KEYS.length;
  for (let i = 0; i < n; i++) {
    PK_S[i] = PROFILE_KEYS[i].m;
    PK_D[i] = PROFILE_KEYS[i].depthM;
  }
  const h = new Float64Array(n - 1);
  const d = new Float64Array(n - 1); // secant slopes
  for (let i = 0; i < n - 1; i++) {
    h[i] = PK_S[i + 1] - PK_S[i];
    d[i] = (PK_D[i + 1] - PK_D[i]) / h[i];
  }
  PK_T[0] = d[0];
  PK_T[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) {
      PK_T[i] = 0; // a local extremum: flat tangent keeps it monotone
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      PK_T[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
})();

/**
 * Seabed depth (metres below the surface) at a transect position (metres
 * offshore). The MEAN surface — relief is added by the ground query below.
 *
 * Inshore of the shoreline it is 0 (the profile meets the surface and stops;
 * this world has no dry land above the waterline). Past the far end it stays on
 * the plain, so an old call site that asks about world x ≈ 0 still gets 1200 m.
 */
export function profileDepthAt(transectM) {
  const s = +transectM;
  if (!(s > 0)) return 0; // NaN-safe: the shoreline
  if (s >= PLAIN_START_M) return SEABED_DEPTH_M; // flat: the fast path
  let i = 0;
  while (i < PK_S.length - 2 && PK_S[i + 1] < s) i++;
  const h = PK_S[i + 1] - PK_S[i];
  const t = (s - PK_S[i]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  // Hermite basis
  return (
    (2 * t3 - 3 * t2 + 1) * PK_D[i] +
    (t3 - 2 * t2 + t) * h * PK_T[i] +
    (-2 * t3 + 3 * t2) * PK_D[i + 1] +
    (t3 - t2) * h * PK_T[i + 1]
  );
}

/** Seabed depth at a WORLD X — the same profile, in the app's own units. */
export function profileDepthAtX(x) {
  return profileDepthAt(worldXToTransect(x));
}

/**
 * The profile's gradient at a transect position: metres of depth per metre of
 * transect (dimensionless, positive = deepening seaward). ~0.01 on the shelf,
 * ~0.12 on the slope, 0 on the plain — a UI can label the terrain from this
 * alone, and it is the derivative of profileDepthAt, not a separate opinion.
 */
export function profileGradientAt(transectM) {
  const s = +transectM;
  if (!(s > 0) || s >= PLAIN_START_M) return 0;
  let i = 0;
  while (i < PK_S.length - 2 && PK_S[i + 1] < s) i++;
  const h = PK_S[i + 1] - PK_S[i];
  const t = (s - PK_S[i]) / h;
  const t2 = t * t;
  return (
    ((6 * t2 - 6 * t) * PK_D[i]) / h +
    (3 * t2 - 4 * t + 1) * PK_T[i] +
    ((-6 * t2 + 6 * t) * PK_D[i + 1]) / h +
    (3 * t2 - 2 * t) * PK_T[i + 1]
  );
}

// One-entry memo: the substrate query inverts the profile for every rooted
// plant every frame, and a plant does not move.
let invM = -1;
let invS = 0;

/**
 * THE ISOBATH: the transect position (metres offshore) at which the seabed
 * first reaches a given depth. The inverse of profileDepthAt, exact to a metre
 * of transect by bisection on a provably monotone curve.
 *
 * This is the function that lets a species have a HORIZONTAL home: a kelp is at
 * 13 m because it is transectAtDepth(13) ≈ 1.7 km offshore, and those are the
 * same fact. depthbands.js should place with it; the gauge can label with it.
 */
export function transectAtDepth(depthM) {
  const m = clampDepth(+depthM || 0);
  if (m <= 0) return 0;
  if (m >= SEABED_DEPTH_M) return PLAIN_START_M;
  if (m === invM) return invS;
  let lo = 0;
  let hi = PLAIN_START_M;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) * 0.5;
    if (profileDepthAt(mid) < m) lo = mid;
    else hi = mid;
  }
  invM = m;
  invS = (lo + hi) * 0.5;
  return invS;
}

/** World X of the isobath for a depth — transectToWorldX(transectAtDepth(m)). */
export function worldXAtDepth(depthM) {
  return transectToWorldX(transectAtDepth(depthM));
}

/**
 * The transect span over which the seabed lies between two depths, written
 * into a caller-owned record (or a shared one). Exactly what a species band
 * needs to be given a horizontal home: pass the band's minM/maxM and place the
 * creature anywhere inside [inshoreM, offshoreM].
 */
const spanOut = { inshoreM: 0, offshoreM: 0, spanM: 0 };
export function transectSpanForDepths(minDepthM, maxDepthM, out) {
  const rec = out || spanOut;
  const a = transectAtDepth(Math.min(minDepthM, maxDepthM));
  const b = transectAtDepth(Math.max(minDepthM, maxDepthM));
  rec.inshoreM = a;
  rec.offshoreM = b;
  rec.spanM = b - a;
  return rec;
}

// ---- the shore zones ------------------------------------------------------
// The horizontal mirror of ZONES: named stretches of the transect, in metres
// offshore, for the UI to label. Boundaries are placed either side of the break
// so that "shelf break" is a place you arrive at rather than an instant you
// cross.
export const SHORE_ZONES = [
  { id: 'shore', label: 'shore', from: 0, to: 600 },
  { id: 'inner', label: 'inner shelf', from: 600, to: 7500 },
  { id: 'outer', label: 'outer shelf', from: 7500, to: 16800 },
  { id: 'break', label: 'shelf break', from: 16800, to: 19400 },
  { id: 'slope', label: 'continental slope', from: 19400, to: 27500 },
  { id: 'abyss', label: 'abyssal plain', from: 27500, to: TRANSECT_M },
];

/** The shore-zone entry containing a transect position (never null; clamps at
 *  both ends) — the exact shape and behaviour of zoneAt(). */
export function shoreZoneAt(m) {
  const s = clampTransect(+m || 0);
  for (let i = 0; i < SHORE_ZONES.length; i++) if (s < SHORE_ZONES[i].to) return SHORE_ZONES[i];
  return SHORE_ZONES[SHORE_ZONES.length - 1];
}

// ---------------------------------------------------------------------------
// Relief — the noise that rides on the profile
// ---------------------------------------------------------------------------
//
// v3.5 had two relief fields for its two substrates: long, low dunes on the
// abyssal plain and short, lumpy reef on the bench. Both are kept verbatim,
// and the profile now chooses between them: a reef is lumpier than a sediment
// plain because it is built by animals rather than deposited by currents, and
// the depth at which that stops being true is roughly the depth at which the
// light does. So the blend weight is a function of the LOCAL SEABED DEPTH —
// full reef down to 60 m, pure dune below 260 m — which also means the outer
// shelf and the slope carry sand waves, which is what they really carry.
//
// Both fields are pure deterministic sums of incommensurate sines: no storage,
// no RNG, no per-frame state. Amplitudes are ±75 px (±15 m) of dune and ±39 px
// (±8 m) of reef.
const RIDGE = [
  { a: 42, kx: 0.0026, kz: 0.0017, ph: 0.7 },
  { a: 22, kx: 0.0068, kz: -0.0031, ph: 2.3 },
  { a: 11, kx: 0.0155, kz: 0.0, ph: 1.1 },
];
const REEF = [
  { a: 22, kx: 0.0031, kz: 0.0019, ph: 2.1 },
  { a: 11, kx: 0.0079, kz: -0.0043, ph: 0.4 },
  { a: 6, kx: 0.0182, kz: 0.0091, ph: 3.3 },
];

/** Max dune relief above/below the mean plain, world px (placement guards). */
export const RIDGE_AMP = RIDGE[0].a + RIDGE[1].a + RIDGE[2].a;
/** Max reef relief above/below the mean bench, world px. */
export const SHELF_AMP = REEF[0].a + REEF[1].a + REEF[2].a;
/** The larger of the two — the slack every layer visibility test carries. */
export const RELIEF_AMP = Math.max(RIDGE_AMP, SHELF_AMP);

const SHALLOW_FULL_M = 60; // at or above this depth the seabed is all reef...
const SHALLOW_NONE_M = 260; // ...and below this it is all sediment dune

/** How reef-like the seabed is at a given seabed depth, 1..0. Drives the
 *  relief blend, the seabed layer's colour, density, grain and alpha — one
 *  number, so what you see and what you stand on cannot disagree. */
export function shallowWeight(seabedDepthM) {
  return 1 - smoothstep01((seabedDepthM - SHALLOW_FULL_M) / (SHALLOW_NONE_M - SHALLOW_FULL_M));
}

// Relief has to FIT IN THE WATER. ±8 m of reef head is nothing on a 40 m
// bench and absurd in the 4 m of water at the shore stop — untapered, the dune
// field pokes dots up through the waterline. So the amplitude is scaled to the
// local water depth over the first 30 m (twice the field's own maximum in
// metres) and is exactly 1 everywhere below that, which means every metre of
// the world v3.6 could reach is untouched.
const RELIEF_FIT_M = RELIEF_AMP * METRES_PER_PX * 2;
function reliefScale(meanDepthM) {
  const k = meanDepthM / RELIEF_FIT_M;
  return k >= 1 ? 1 : k <= 0 ? 0 : k;
}

/** Relief (world px, signed) at a world (x, z) for a seabed of this character.
 *  w = 0 is EXACTLY v3.5's abyssal dune field, w = 1 EXACTLY its reef. This is
 *  the raw field; groundYAt/substrateAt additionally fit it to the water. */
export function reliefAt(x, z, w) {
  let y = 0;
  if (w < 1) {
    let dune = 0;
    for (let i = 0; i < RIDGE.length; i++) {
      const r = RIDGE[i];
      dune += r.a * Math.sin(x * r.kx + z * r.kz + r.ph);
    }
    y += dune * (1 - w);
  }
  if (w > 0) {
    let reef = 0;
    for (let i = 0; i < REEF.length; i++) {
      const r = REEF[i];
      reef += r.a * Math.sin(x * r.kx + z * r.kz + r.ph);
    }
    y += reef * w;
  }
  return y;
}

/**
 * THE GROUND. World Y of the seabed under a world (x, z) — the profile at that
 * x, plus the relief riding on it. This is the surface the dotted seabed layer
 * draws and the surface things stand on: literally the same function, so a
 * holdfast is never planted in mid-water and never buried in rock.
 */
export function groundYAt(x, z) {
  const d = profileDepthAt(worldXToTransect(x));
  return SURFACE_Y - d * PX_PER_METRE + reliefAt(x, z, shallowWeight(d)) * reliefScale(d);
}

// ---- legacy shelf/plain surfaces (v3.5 compatibility) ---------------------
// v3.5's two substrates were two functions. They survive as thin shims so no
// import breaks; both are now views of the one profile.

/** The ABYSSAL PLAIN's surface at (x, z) — v3.5's function, bit for bit. Still
 *  correct where the plain is (the far offshore end of the transect), and still
 *  the answer for anything that asks for the deep floor unconditionally. */
export function abyssalYAt(x, z) {
  let y = SEABED_Y;
  for (let i = 0; i < RIDGE.length; i++) {
    const r = RIDGE[i];
    y += r.a * Math.sin(x * r.kx + z * r.kz + r.ph);
  }
  return y;
}

/** Mean depth of the inner-shelf bench, metres. v3.5 exported this as THE
 *  shelf's depth; it is now simply a representative inner-shelf depth (the
 *  profile passes through it ~1.7 km offshore) kept for the gauge's scale. */
export const SHELF_DEPTH_M = 19;
/** World Y of that bench's mean plane. */
export const SHELF_Y = SURFACE_Y - SHELF_DEPTH_M * PX_PER_METRE;
/** Shallowest / deepest rock on the bench proper, in metres. */
export const SHELF_TOP_M = SHELF_DEPTH_M - SHELF_AMP * METRES_PER_PX;
export const SHELF_BASE_M = SHELF_DEPTH_M + SHELF_AMP * METRES_PER_PX;
/** Deepest depth at which a caller is still "on the shelf". v3.5 used this to
 *  decide which of two substrates answered; the profile needs no such switch,
 *  and it survives for hasShelfAt(). */
export const SHELF_REACH_M = 70;
/** LEGACY. v3.5's shelf ended at a scalloped lip in z; the transect's seabed
 *  has no z-edge at all (it is continuous from shore to plain), so this is kept
 *  only so an old import resolves. Nothing reads it. */
export const SHELF_TOE_Z = -800;

/** LEGACY: the reef bench's surface at (x, z), as if the bench were under you.
 *  Prefer groundYAt / seabedYAt, which answer from the profile. */
export function shelfYAt(x, z) {
  return SURFACE_Y - SHELF_DEPTH_M * PX_PER_METRE + reliefAt(x, z, 1);
}

/** LEGACY: v3.5's per-dot shelf coverage, which faded the bench out across its
 *  drop-off. The transect has one continuous seabed and therefore no holes:
 *  there is ground everywhere, so this is 1 everywhere. */
export function shelfCoverAt() {
  return 1;
}

// ---------------------------------------------------------------------------
// THE SUBSTRATE QUERY
// ---------------------------------------------------------------------------
//
// ONE question, asked everywhere: "what is the ground here?". v3.4 had one
// floor and so one answer. v3.5 had two disconnected floors and needed a depth
// argument to pick between them. v3.7 has ONE seabed again — but a seabed whose
// depth is a function of WHERE YOU ARE, so the honest answer comes from the
// caller's own x.
//
// The optional depth argument survives, and it now does something better than
// pick a substrate: it is a HINT that the caller lives at a depth. If the
// ground under the caller's x is far deeper than that (a kelp at 13 m standing
// over 1200 m of water — i.e. a creature that has a depth home but has not yet
// been given a horizontal one), the query answers with the ground AT THAT
// DEPTH'S ISOBATH, carrying the local relief, and reports where that ground
// actually is in `transectM` / `worldX`.
//
// That bridge is exactly what v3.5 did — it manufactured rock at 19 m under any
// (x, z) — only keyed on the caller's own depth instead of a constant, and it
// exists for the same reason: so nothing is planted in the dark while the rest
// of the app learns the second axis. THE FIX IS TO PLACE CREATURES AT THEIR
// TRUE TRANSECT POSITION (see transectAtDepth / worldXAtDepth); when that
// lands, the hint always agrees with the local floor and the bridge stops
// firing. `onProfile === false` on the returned record is how you find the
// call sites that still need it.

/** Substrate identifiers. 'shelf' and 'plain' are v3.5's strings and keep their
 *  meaning; 'shore' and 'slope' are the two stretches the transect adds. */
export const SUBSTRATE_SHORE = 'shore';
export const SUBSTRATE_SHELF = 'shelf';
export const SUBSTRATE_SLOPE = 'slope';
export const SUBSTRATE_PLAIN = 'plain';

const SHORE_KIND_M = 12; // shallower than this and you are in the surf

function kindForDepth(d) {
  if (d <= SHORE_KIND_M) return SUBSTRATE_SHORE;
  if (d <= BREAK_DEPTH_M) return SUBSTRATE_SHELF;
  if (d < SEABED_DEPTH_M - 1) return SUBSTRATE_SLOPE;
  return SUBSTRATE_PLAIN;
}

// The bridge fires only when the caller's depth is FAR above the local floor —
// "far" being generous enough that relief (±15 m) and a benthic hover never
// trip it, and relative enough that it means the same thing in 40 m of water as
// in 1200 m.
const BRIDGE_TOL_M = 25;
const BRIDGE_TOL_FRAC = 0.06;

const substrateOut = {
  kind: SUBSTRATE_PLAIN,
  y: SEABED_Y,
  depthM: SEABED_DEPTH_M,
  meanDepthM: SEABED_DEPTH_M,
  coverage: 1,
  shelf: false,
  onProfile: true,
  transectM: TRANSECT_M,
  worldX: 0,
  gradient: 0,
};

/**
 * The ground, as a record.
 *
 *   substrateAt(x, z)        // the seabed under (x, z) — the profile's answer
 *   substrateAt(x, z, 1195)  // ...same, the hint agrees with the floor
 *   substrateAt(x, z, 13)    // a 13 m dweller over deep water -> its isobath
 *
 * @param {number} x world x
 * @param {number} z world z
 * @param {number} [nearDepthM] the depth the caller lives at (see the bridge
 *        note above). Omit for the plain answer under (x, z).
 * @param {object} [out] a caller-owned record to fill (for anything that wants
 *        to keep more than one alive at a time).
 * @returns {{kind:string, y:number, depthM:number, meanDepthM:number,
 *            coverage:number, shelf:boolean, onProfile:boolean,
 *            transectM:number, worldX:number, gradient:number}}
 *        `y` is the world Y of the sediment/rock surface, `depthM` the same in
 *        metres, `meanDepthM` the profile's mean there (relief removed),
 *        `coverage` is always 1 (the seabed is continuous — kept for v3.5
 *        callers), `shelf` true at or above the break, `onProfile` false when
 *        the bridge fired, `transectM`/`worldX` WHERE that ground is. WITHOUT
 *        `out` this is a SHARED object — read it, don't retain it.
 */
export function substrateAt(x, z, nearDepthM, out) {
  const rec = out || substrateOut;
  const px = x || 0;
  const pz = z || 0;
  const s = worldXToTransect(px);
  const floorM = profileDepthAt(s);
  const m = nearDepthM == null ? null : +nearDepthM;
  let mean = floorM;
  let tm = s;
  let gx = px;
  let onProfile = true;
  if (
    m != null &&
    Number.isFinite(m) &&
    m < floorM - Math.max(BRIDGE_TOL_M, floorM * BRIDGE_TOL_FRAC)
  ) {
    onProfile = false;
    mean = clampDepth(m);
    tm = transectAtDepth(mean);
    gx = transectToWorldX(tm);
  }
  const y =
    SURFACE_Y - mean * PX_PER_METRE + reliefAt(px, pz, shallowWeight(mean)) * reliefScale(mean);
  rec.kind = kindForDepth(mean);
  rec.y = y;
  rec.depthM = worldYToMetres(y);
  rec.meanDepthM = mean;
  rec.coverage = 1;
  rec.shelf = mean <= BREAK_DEPTH_M;
  rec.onProfile = onProfile;
  rec.transectM = tm;
  rec.worldX = gx;
  rec.gradient = profileGradientAt(tm);
  return rec;
}

/** World Y of the ground — substrateAt(...).y, allocation-free. */
export function substrateYAt(x, z, nearDepthM) {
  return substrateAt(x, z, nearDepthM).y;
}

/**
 * World Y of the seabed under a world (x, z).
 *
 *   seabedYAt(x, z)      -> the profile's seabed there (the abyssal plain at
 *                           the far offshore end, which is where v3.6's whole
 *                           world lived — so old call sites are unchanged)
 *   seabedYAt(x, z, 13)  -> the ground a 13 m dweller stands on (its isobath,
 *                           if the floor under x is far deeper)
 *   seabedYAt(x, z, 900) -> the local floor; a 900 m dweller over the plain is
 *                           within tolerance of it
 */
export function seabedYAt(x, z, nearDepthM) {
  if (nearDepthM == null) return groundYAt(x || 0, z || 0);
  return substrateAt(x, z, nearDepthM).y;
}

/** Seabed depth in metres under a world (x, z), relief included. */
export function seabedDepthAt(x, z) {
  return worldYToMetres(groundYAt(x || 0, z || 0));
}

/** True if the ground for something living at this depth is shelf ground (at
 *  or above the break). v3.5's signature; `minCover` is accepted and ignored,
 *  since the transect's seabed has no gaps to fade across. */
export function hasShelfAt(x, z, nearDepthM) {
  if (nearDepthM != null && +nearDepthM > SHELF_REACH_M) return false;
  return substrateAt(x, z, nearDepthM).shelf;
}

// ---------------------------------------------------------------------------
// Camera motion + layer tuning
// ---------------------------------------------------------------------------

const FOV = 55; // must match FOV in main.js
const REF_DIST = 10; // must match REF_DIST in shaders/dots.js
const TAU = Math.PI * 2;

// Critically damped approach: x'' = -2w x' - w^2 (x - target), stepped with
// the exact analytic solution so it is stable and identical at any dt. Both
// axes use the same law and the same stiffness — the vessel has one mass.
const OMEGA = 3.4; // 1/s — settles to ~2% in ~1.8 s
const FLANK_MPS = 300; // dive-speed cap (m/s = 1500 world px/s) so a jump
// across the whole column reads as travel (~5.4 s surface->seabed, ~3 screens
// a second) rather than a teleport blur
const SETTLE_M = 0.02; // below this offset AND velocity the motion is parked
const SETTLE_V = 0.05;

// The horizontal flank speed is set so the two axes take the same order of
// time end to end: 36 km at 6000 m/s is 6 s, against the column's 5.4 s. In
// world px that is 3000 px/s against the dive's 1500 — twice as fast on screen,
// which is right, because the frame is wider than it is tall.
const FLANK_HMPS = 6000;
const SETTLE_HM = 2; // metres of transect — 1 world px
const SETTLE_HV = 5;

// Navigation gains.
/** World px of dive per wheel pixel (a dive, not a scrollbar). EXPORTED
 *  because the depth gauge scrolls the same water: wheel-over-instrument and
 *  wheel-over-porthole have to mean the same thing, and a mirrored copy of this
 *  number in ui/depthgauge.js was the one place the two could silently drift
 *  apart. One definition, here, with the rest of the world's units. */
export const WHEEL_GAIN = 2.6;
/** World px of transect per wheel pixel, for the horizontal axis — the same
 *  contract, exported for the same reason. Larger than WHEEL_GAIN because the
 *  transect is three times the column's length in world px; the two axes end
 *  up within a factor of ~1.3 of each other in TOTAL wheel travel, so crossing
 *  the ocean and crossing the column cost about the same wrist. */
export const SHORE_WHEEL_GAIN = 6.0;
const WHEEL_LINE_PX = 16; // deltaMode 1 (lines) -> px
const KEY_STEP_M = 26; // arrow key, vertical
const SHORE_KEY_STEP_M = 320; // arrow key, horizontal (~160 world px, the same
// screen distance as the vertical step)
const PAGE_FRAC = 0.8; // PageUp/Down = this fraction of the visible band
const DRAG_START_PX = 7; // px of horizontal travel before a drag is navigation
const DRAG_BIAS = 1.4; // ...and it must be this much more horizontal than
// vertical, so a vertical drag or a click is never stolen from the integrator

// Where the boundaries are allowed to sit at the ends of the travel, as a
// fraction of the half-band. The vessel is always submerged: it can never put
// the porthole above the waterline or below the floor, which is why the gauge
// bottoms out a little short of the seabed rather than at it. At min depth the
// surface hangs 20% down from the top edge — you are just under the waterline
// looking up through it; at max depth the vessel hovers 1.15 x the half-band
// above the floor, which puts the ridge line ~74% down the frame and runs the
// near floor off the bottom edge — the geometry of hovering over a plane, at
// any viewport size (both terms scale with CSS height).
const SURFACE_STOP = 0.6;
const SEABED_STOP = 1.15;

// ...and a hard metre cap on the shallow stop. The rule above is purely
// FRACTIONAL, so the shallowest reachable depth would scale with the viewport:
// 32 m on the 540 px test viewport, 72 m on a tall display. Fine over 1200 m of
// water, fatal in the shallows — on a tall window the vessel could never get
// above the inner shelf, and ground you can only ever look up at is not ground.
// It is a ceiling, never a floor: on a short viewport SURFACE_STOP still wins,
// so the porthole is never pushed up through the waterline.
const MIN_DEPTH_CAP_M = 9;

// THE COUPLING BETWEEN THE AXES. The standoffs above are absolute distances,
// and in 40 m of water on the inner shelf they do not fit — 1.15 half-bands is
// 62 m of clearance the shelf does not have. So both standoffs additionally
// shrink to a fraction of the LOCAL water depth, which is what makes travelling
// inshore feel like the seabed rising to meet you rather than a wall: the
// navigable band narrows continuously, the vessel is lifted by the terrain, and
// at every point it still has water above and below it.
const THIN_WATER_FRAC = 0.25;

// The vessel is a submersible, not a landing craft: it stops inshore where it
// would ground itself. 4 m of water is the shallowest it will hold station in —
// far enough in that the beach and the surf are in frame, not so far that the
// two sheets close on the lens.
const SHORE_STOP_DEPTH_M = 4;
/** Shallowest (most inshore) transect position the vessel may reach, metres. */
export const SHORE_STOP_M = transectAtDepth(SHORE_STOP_DEPTH_M);

/** Where a fresh session sits on the transect: the far offshore end, over the
 *  abyssal plain. This is v3.6's world exactly (world x = 0), so a board that
 *  never touches the horizontal axis is unchanged — and the journey the feature
 *  is for is a journey INSHORE, toward the light. */
export const DEFAULT_SHORE_M = TRANSECT_M;

// Layer extents, expressed as VIEW DISTANCE as a fraction of camDist — not as
// absolute z. A ground plane's near edge has to come close enough to the lens
// to run off the bottom of the frame; pinning it to an absolute z left the
// floor as a thin band floating at mid-screen. Fractions also make both sheets
// viewport-invariant for free: camDist scales with CSS height, so the floor
// covers the same screen area on any display.
const VD_NEAR_DEEP = 0.38; // z = +0.62 x camDist — in front of the creature plane
// The shallows pull the other way, and for the mirror-image reason: the plain
// is seen from 60–100 m up, where 0.38 already runs the near edge off the
// bottom of the frame; the inner shelf is seen from 3–19 m up, and at that
// grazing height a near edge at 0.38 projects only ~145 px below the axis — the
// ground stops in mid-frame with empty water under it. 0.19 puts the nearest
// rock ~100 px from the lens, which projects past the bottom edge at every
// height the vessel can hover at. Sprite size is unaffected: aSize is authored
// per dot in CSS px at its own view distance.
const VD_NEAR_SHALLOW = 0.19;
const VD_FAR = 2.4; // z = -1.4 x camDist — far enough to haze, near enough to
// survive the abyss preset's fog
// A CEILING does not want its near edge under the lens: at the shallow travel
// stop the surface is only ~160 px overhead, so sheet dots 0.38 x camDist in
// front of the lens sit almost against the porthole and the whole upper frame
// fills with point-blank glitter (and, at that projected speed, with its
// trails). 0.85 puts its nearest dots ~470 px away, where the ceiling reads as
// a rippling boundary above you instead of confetti in your face.
const SURFACE_VD_NEAR = 0.85;
const HORIZON_BIAS = 1.35; // >1 crowds samples toward the far end, which is
// what turns a scatter into a ridge line at the horizon
const LAYER_MARGIN_PX = 140; // relief/ripple slack on the visibility test

// The seabed layer's two ends. Every one of these pairs is v3.5's abyssal plain
// on the left and v3.5's reef bench on the right, and the sheet interpolates
// between them on shallowWeight(local seabed depth) — so at the far offshore
// end the seabed is byte-identical to the plain the app has always drawn, on
// the inner shelf it is the bench, and everywhere between it is honestly
// neither.
const DEEP_COUNT = 760; // sparse: read against 200 m of black water in every
// direction, a scatter is unambiguous
const SHALLOW_COUNT = 2400; // dense: read against LIT water full of plankton,
// sediment and caustics, only density makes a stipple a surface
const DEEP_ALPHA = 0.8;
const SHALLOW_ALPHA = 0.46; // ground seen through the brightest water in the
// column; a slab this bright at 20 m would flatten the one zone whose identity
// is "there is still daylight here"
const DEEP_COLOR = [0.7, 0.74, 0.78]; // warm-neutral silt against cool water
const SHALLOW_COLOR = [0.58, 0.62, 0.56]; // algal turf and wet limestone with
// the red already eaten by 20 m of water
const DEEP_TWK = [0.9, 0.3]; // barely-there — the floor is still, the water is not
const SHALLOW_TWK = [1.15, 0.34];
const SHALLOW_SIZE_MUL = 1.368; // 2.2–3.8 px of silt grain -> 3.0–5.2 of rubble
const SHALLOW_REL_MUL = 0.615; // 26 px of silt loft -> 16 px of turf mat
const DEEP_SIZE_FAR = 0.3;
const SHALLOW_SIZE_FAR = 0.5; // the far grain is half the near grain — the
// texture gradient that makes a stipple recede instead of hang
const SURFACE_ALPHA = 0.5; // sun-glitter ON a surface, not a second creature

// How the ground leaves you as you sink away from it. Descending off the shelf
// is the app's one moment of "leaving a lit reef behind", and the shape of that
// exit is the whole beat: NOT a linear dissolve (which reads as a fade-out
// effect) but the extinction of contrast through the water between the porthole
// and the rock — fast at first, then a long dim tail.
//
// This applies to SHALLOW ground only (it is scaled by shallowWeight), because
// it is a statement about lit water. The abyssal plain has no daylight to lose
// and keeps its full contrast, exactly as in v3.6.
const SINK_M = 26; // e-folding depth of the ground's contrast, metres
const CUT_FROM_M = 30; // metres below the ground where the tail is cut...
const CUT_SPAN_M = 25; // ...over this many more, to zero

/**
 * The seabed layer's own light, 0..1, for a vessel at camM metres over ground
 * whose mean depth is floorM and whose character is w (shallowWeight).
 *
 * Three terms, all physical rather than aesthetic: whether you are above the
 * ground at all, how much water is between the porthole and the rock, and how
 * much daylight is still reaching that depth (lightAt — the same Beer–Lambert
 * curve the depth profile keys its optics to). At w = 0 the whole thing
 * collapses to 1: the deep floor is unchanged.
 */
function groundExposure(camM, floorM, w) {
  if (w <= 0) return 1;
  const lit = 0.58 + 0.42 * lightAt(camM);
  const below = camM - floorM;
  let e;
  if (below <= 0) {
    e = lit; // hovering over it: full contrast
  } else {
    const cut = 1 - smoothstep01((below - CUT_FROM_M) / CUT_SPAN_M);
    e = cut <= 0 ? 0 : lit * Math.exp(-below / SINK_M) * cut;
  }
  return 1 + (e - 1) * w;
}

// ---------------------------------------------------------------------------
// A dotted sheet: one Points object lying on a horizontal surface, sampled so
// it fills the frustum at every depth and crowds toward the horizon (which is
// why it reads as a floor/ceiling and not a scatter). Shared by seabed +
// surface.
//
// THE ONE THING v3.7 CHANGES HERE: the dots are anchored in the WORLD along x,
// not to the camera. The sheet's parametrization is camera-relative by nature
// (it is a frustum fill), so a naive port would slide the whole floor along
// with the vessel and horizontal travel would show no parallax at all — the
// ocean floor would look painted on the porthole. Instead each dot keeps a
// fixed phase and lands on the lattice point of its own period nearest the
// camera: it holds still in the world while you fly over it, and recycles a
// full frame-width sideways when it passes the edge, off screen. At camX = 0
// every dot lands exactly where v3.6 put it.
// ---------------------------------------------------------------------------

function buildSheet(scene, globalUniforms, cfg) {
  const N = cfg.count;
  const rng = mulberry32(cfg.seed >>> 0);

  // ---- frozen draw order: per-dot block, append only (geometry-spec 8) ----
  const u = new Float32Array(N); // -1..1 across the frustum at that dot's z
  const sn = new Float32Array(N); // 0 = horizon, 1 = right under the lens
  const rel = new Float32Array(N); // per-dot offset off the surface (px)
  const sz0 = new Float32Array(N); // authored CSS px at its own depth
  const ph1 = new Float32Array(N);
  const ph2 = new Float32Array(N);
  const tw = new Float32Array(N);
  const rg = new Float32Array(N);
  const nx = new Float32Array(N);
  const ny = new Float32Array(N);
  const nz = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    u[i] = rng() * 2 - 1;
    // Uniform in 1/viewDist == uniform in SCREEN Y for a plane, so the sheet
    // covers the frame evenly instead of piling up somewhere; the pow bias
    // then crowds it toward the horizon, which is what closes the far edge
    // into a ridge line.
    sn[i] = Math.pow(rng(), HORIZON_BIAS);
    rel[i] = cfg.relLo + (cfg.relHi - cfg.relLo) * rng();
    // every ~10th dot is a bright fleck (surface glitter / a shell on the floor)
    sz0[i] = (cfg.sizeLo + (cfg.sizeHi - cfg.sizeLo) * rng()) * (i % 10 === 0 ? 2.05 : 1);
    ph1[i] = rng() * TAU;
    ph2[i] = rng() * TAU;
    tw[i] = rng();
    rg[i] = rng();
    // random unit normal: these are omnidirectional specks, lit by the dot
    // shader's wrap-Lambert ambient floor from any light azimuth
    let a = rng() * 2 - 1;
    let b = rng() * 2 - 1;
    let c = rng() * 2 - 1;
    const il = 1 / Math.max(Math.hypot(a, b, c), 1e-4);
    nx[i] = a * il;
    ny[i] = b * il;
    nz[i] = c * il;
  }
  // ---- end frozen draw order ----

  const pos = new Float32Array(N * 3);
  const nor = new Float32Array(N * 3);
  const aSize = new Float32Array(N);
  const aTw = new Float32Array(N);
  const aRing = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    nor[i * 3] = nx[i];
    nor[i * 3 + 1] = ny[i];
    nor[i * 3 + 2] = nz[i];
    aTw[i] = tw[i];
    aRing[i] = rg[i];
  }
  // resting Y of each dot (surface + relief + per-dot offset); the ripple rides
  // on top of this, so nothing recomputes the ground per frame
  const restY = new Float32Array(N);

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const sizeAttr = new THREE.BufferAttribute(aSize, 1);
  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geometry.setAttribute('aSize', sizeAttr);
  geometry.setAttribute('aTw', new THREE.BufferAttribute(aTw, 1));
  geometry.setAttribute('aRing', new THREE.BufferAttribute(aRing, 1));

  const material = createDotMaterial(globalUniforms);
  material.uniforms.uColor.value.setRGB(cfg.color[0], cfg.color[1], cfg.color[2]);
  material.uniforms.uAlpha.value = cfg.alpha;
  material.uniforms.uFormation.value = 1;
  material.uniforms.uTwk.value.set(cfg.twk[0], cfg.twk[1]);
  // uSmall stays 0 — the merge correction is for creatures, not scenery.

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false; // visibility is driven by the column's band test
  scene.add(points);

  let intensity = 1;
  let drawn = N;

  // Deterministic rebuild: a pure arithmetic function of (w, h, camDist, camX,
  // tune). No RNG, no reallocation — the sheet is never rebuilt from draws.
  //
  // `tune` carries the terrain-driven half of the look: how many dots are drawn,
  // how near the near edge comes, how big the grain is and how proud of the
  // surface it sits. See the DEEP_*/SHALLOW_* pairs above.
  function rebuild(w, h, camDist, camX, tune) {
    const hw = w / 2 + 140;
    const n = Math.max(1, Math.min(N, tune.count | 0));
    const invNear = 1 / (tune.vdNear * camDist);
    const invFar = 1 / (VD_FAR * camDist);
    const sizeFar = tune.sizeFar;
    const sizeMul = tune.sizeMul;
    const relMul = tune.relMul;
    const planeYAt = cfg.planeYAt;
    for (let i = 0; i < n; i++) {
      const vd = 1 / (invFar + (invNear - invFar) * sn[i]);
      const z = camDist - vd;
      // frustum half-width at this z, so the sheet fills the screen edge to
      // edge at every depth instead of tapering into a wedge
      const hwz = hw * (vd / camDist);
      const period = 2 * hwz;
      const phase = u[i] * hwz;
      // World-anchored x: the lattice point of this dot's own period nearest
      // the camera. |x - camX| <= hwz always, so coverage is exactly what the
      // camera-relative version had, and the recycle jump happens a full 140 px
      // (scaled by vd) outside the frame edge.
      const x = phase + period * Math.round((camX - phase) / period);
      const y = planeYAt(x, z) + rel[i] * relMul;
      restY[i] = y;
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      // px = aSize * REF_DIST / viewDist (shaders/dots.js): authored CSS px at
      // this dot's own depth, shrinking a little into the haze of the horizon.
      // The far end stays just above the shader's 1.5-raster-px fade, or the
      // ridge line the crowding builds would be alpha'd away to nothing.
      aSize[i] = sz0[i] * sizeMul * (1 - sizeFar * (1 - sn[i])) * (vd / REF_DIST);
    }
    if (n !== drawn) {
      drawn = n;
      geometry.setDrawRange(0, n);
    }
    posAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
  }

  // Ripple: two incommensurate traveling waves so the ceiling never repeats.
  // Only ever called while the layer is visible.
  function ripple(t) {
    const r = cfg.ripple;
    for (let i = 0; i < drawn; i++) {
      pos[i * 3 + 1] =
        restY[i] +
        r.amp * Math.sin(r.w1 * t + ph1[i]) +
        r.amp * 0.55 * Math.sin(r.w2 * t + ph2[i]);
    }
    posAttr.needsUpdate = true;
  }

  return {
    points,
    material,
    rebuild,
    ripple: cfg.ripple ? ripple : null,
    /** Colour/alpha/twinkle are terrain-driven for the seabed; this is how the
     *  driver writes them without touching the uniform on frames that do not
     *  move. */
    setLook(r, g, b, alpha, twk0, twk1) {
      material.uniforms.uColor.value.setRGB(r, g, b);
      material.uniforms.uTwk.value.set(twk0, twk1);
      cfg.alpha = alpha;
      material.uniforms.uAlpha.value = alpha * intensity;
    },
    setIntensity(v) {
      intensity = Math.min(Math.max(v, 0), 1);
      material.uniforms.uAlpha.value = cfg.alpha * intensity;
    },
    getIntensity: () => intensity,
    setTime(t) {
      material.uniforms.uTime.value = t;
    },
    dispose() {
      scene.remove(points);
      geometry.dispose();
      material.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// createColumn
// ---------------------------------------------------------------------------

/**
 * Build the world: the vertical column AND the cross-shelf transect, the
 * camera's place in both, the seabed + surface layers, and the navigation
 * bindings for both axes.
 *
 * @param {THREE.Scene} scene
 * @param {object} globalUniforms  from shaders/dots.js createGlobalUniforms
 * @param {object} [opts]
 *   canvas      HTMLCanvasElement — wheel + drag navigation bind here (optional;
 *               omit for a headless/model-only column)
 *   keyTarget   EventTarget for arrow/page keys (default: window). Keys are
 *               ignored while any input/textarea/contentEditable has focus,
 *               so the summon field always wins.
 *   width/height CSS viewport (default: window / 960x540)
 *   camDist     camera distance to the z=0 plane (default: derived from height)
 *   depth       initial depth in metres (default DEFAULT_DEPTH_M)
 *   shore       initial transect position in metres offshore (default
 *               DEFAULT_SHORE_M — the far offshore end, i.e. v3.6's world)
 *   seed        RNG seed for the two layers
 *   layers      false to skip the seabed/surface geometry entirely (spike
 *               scenes stay pixel-clean and emitter-free, like the plankton)
 *   nav         false to skip wheel/key/drag bindings (model-only)
 *   drag        false to skip ONLY the pointer-drag binding (if the integrator
 *               would rather own the pointer)
 *   onCamera    (worldY, worldX) => void, called whenever the camera moves on
 *               EITHER axis
 *   onDepth     (targetM, source) => void, called when the depth TARGET changes
 *   onShore     (targetM, source) => void, ditto for the transect
 * @returns the column API (see the bottom of this function)
 */
export function createColumn(scene, globalUniforms, opts = {}) {
  const canvas = opts.canvas ?? null;
  const keyTarget = opts.keyTarget ?? (typeof window !== 'undefined' ? window : null);

  let W = opts.width ?? (typeof window !== 'undefined' ? window.innerWidth || 960 : 960);
  let H = opts.height ?? (typeof window !== 'undefined' ? window.innerHeight || 540 : 540);
  let camDist = opts.camDist ?? H / 2 / Math.tan((FOV * Math.PI) / 360);

  // ---- vertical state ----------------------------------------------------
  let targetM = DEFAULT_DEPTH_M;
  let curM = DEFAULT_DEPTH_M;
  let velM = 0; // m/s, the vessel's vertical rate
  let camYCur = metresToWorldY(curM);
  let camYPrev = camYCur;
  let simT = 0; // accumulated from dt — never a wall-clock read

  // ---- horizontal state --------------------------------------------------
  let targetS = DEFAULT_SHORE_M;
  let curS = DEFAULT_SHORE_M;
  let velS = 0; // m/s of transect, signed (+ = heading offshore)
  let camXCur = transectToWorldX(curS);
  let camXPrev = camXCur;

  // ---- navigable ranges --------------------------------------------------
  // Half the visible band at the z=0 plane, in metres. The vessel cannot push
  // the porthole above the waterline or below the floor — and the floor now
  // depends on where it is along the transect, so this is recomputed every
  // frame, not just on resize.
  let halfBandM = 1;
  let halfSpanM = 1; // horizontal half-band, transect metres
  let minM = 0;
  let maxM = SEABED_DEPTH_M;
  let floorM = SEABED_DEPTH_M; // mean seabed depth under the vessel
  let groundW = 0; // shallowWeight(floorM)

  function recomputeBands() {
    halfBandM = (H / 2) * METRES_PER_PX;
    halfSpanM = (W / 2) * TRANSECT_METRES_PER_PX;
  }

  function recomputeRange() {
    floorM = profileDepthAt(curS);
    groundW = shallowWeight(floorM);
    // Both standoffs additionally shrink to a fraction of the local water, so
    // the band narrows smoothly as the seabed rises instead of inverting.
    const thin = floorM * THIN_WATER_FRAC;
    const lo = Math.min(SURFACE_STOP * halfBandM, MIN_DEPTH_CAP_M, thin);
    const hi = floorM - Math.min(SEABED_STOP * halfBandM, thin);
    if (hi < lo) {
      // pathological: a viewport taller than the water. Park mid-column.
      minM = maxM = floorM * 0.5;
    } else {
      minM = lo;
      maxM = hi;
    }
  }
  recomputeBands();
  recomputeRange();

  function clampNav(m) {
    return m < minM ? minM : m > maxM ? maxM : m;
  }

  const minS = SHORE_STOP_M;
  const maxS = TRANSECT_M;
  function clampShoreNav(m) {
    return m < minS ? minS : m > maxS ? maxS : m;
  }

  // ---- listeners ---------------------------------------------------------
  const depthListeners = [];
  const shoreListeners = [];
  function emitDepth(source) {
    if (opts.onDepth) opts.onDepth(targetM, source);
    for (let i = 0; i < depthListeners.length; i++) depthListeners[i](targetM, source);
  }
  function emitShore(source) {
    if (opts.onShore) opts.onShore(targetS, source);
    for (let i = 0; i < shoreListeners.length; i++) shoreListeners[i](targetS, source);
  }

  function setDepth(m, options) {
    const v = clampNav(Number(m) || 0);
    const instant = options ? options.instant === true : false;
    const changed = v !== targetM;
    targetM = v;
    if (instant) {
      curM = v;
      velM = 0;
      camYCur = metresToWorldY(curM);
      camYPrev = camYCur;
      if (opts.onCamera) opts.onCamera(camYCur, camXCur);
    }
    if (changed || instant) emitDepth(options && options.source ? options.source : 'set');
    return targetM;
  }

  function nudge(dm, options) {
    return setDepth(targetM + (Number(dm) || 0), options);
  }

  /**
   * Command a transect position, in metres offshore. The exact contract of
   * setDepth: clamped into shoreRange(), eased unless { instant: true }, and
   * it returns the clamped target.
   */
  function setShore(m, options) {
    const v = clampShoreNav(Number(m) || 0);
    const instant = options ? options.instant === true : false;
    const changed = v !== targetS;
    targetS = v;
    if (instant) {
      curS = v;
      velS = 0;
      camXCur = transectToWorldX(curS);
      camXPrev = camXCur;
      recomputeRange();
      // the water under us just changed depth — the vessel cannot stay below it
      targetM = clampNav(targetM);
      curM = clampNav(curM);
      camYCur = metresToWorldY(curM);
      camYPrev = camYCur;
      if (opts.onCamera) opts.onCamera(camYCur, camXCur);
    }
    if (changed || instant) emitShore(options && options.source ? options.source : 'set');
    return targetS;
  }

  function nudgeShore(dm, options) {
    return setShore(targetS + (Number(dm) || 0), options);
  }

  // ---- layers ------------------------------------------------------------
  const baseSeed = (opts.seed ?? 0x0c010b3d) >>> 0;
  const wantLayers = opts.layers !== false;

  // ONE seabed. Its dot budget is authored at the dense (shallow) end and
  // drawn down to the sparse (deep) one through drawRange — a prefix of an
  // iid-per-dot stream is a uniform subsample (geometry-spec 9), so the deep
  // floor is not a thinned reef, it is the same scatter the plain always had.
  // The seed is v3.5's ABYSSAL PLAIN seed on purpose: dots 0..759 are then
  // exactly the plain's, and a board over the abyss is unchanged dot for dot.
  const seabed = wantLayers
    ? buildSheet(scene, globalUniforms, {
        count: opts.seabedCount ?? SHALLOW_COUNT,
        seed: baseSeed ^ 0x5eab3d00,
        planeYAt: groundYAt,
        relLo: 0,
        relHi: 26, // a little loft: silt sitting proud of the floor
        sizeLo: 2.2,
        sizeHi: 3.8,
        color: DEEP_COLOR,
        alpha: DEEP_ALPHA,
        twk: DEEP_TWK,
        ripple: null, // rock and sediment are still; the dapple is the shader's
      })
    : null;

  const surface = wantLayers
    ? buildSheet(scene, globalUniforms, {
        count: opts.surfaceCount ?? 520,
        seed: baseSeed ^ 0x51f4ace0,
        planeYAt: () => SURFACE_Y,
        relLo: -22, // the boundary has thickness: dots hang just under it
        relHi: -3,
        sizeLo: 1.7,
        sizeHi: 2.9,
        // daylight coming through: the one warm-cool-white in the water
        color: [0.9, 0.96, 1.0],
        alpha: SURFACE_ALPHA,
        twk: [1.9, 0.5], // shimmer on the underside — fast, but no longer a strobe
        ripple: { amp: 11, w1: 0.9, w2: 1.41 }, // incommensurate: never repeats
      })
    : null;

  // Shared tuning records — filled per rebuild, never allocated on a frame path.
  const groundTune = {
    count: DEEP_COUNT,
    vdNear: VD_NEAR_DEEP,
    sizeFar: DEEP_SIZE_FAR,
    sizeMul: 1,
    relMul: 1,
  };
  const surfaceTune = {
    count: opts.surfaceCount ?? 520,
    vdNear: SURFACE_VD_NEAR,
    sizeFar: 0.3,
    sizeMul: 1,
    relMul: 1,
  };

  const mix = (a, b, t) => a + (b - a) * t;

  // What the seabed looks like where the vessel is. One number in
  // (shallowWeight of the local floor), the whole look out: how many dots, how
  // big, how near, what colour, how bright. At w = 0 every one of these is
  // v3.6's abyssal plain exactly.
  let lookW = -1;
  function applyGroundLook(w) {
    if (!seabed) return;
    groundTune.count = Math.round(mix(DEEP_COUNT, SHALLOW_COUNT, w));
    groundTune.vdNear = mix(VD_NEAR_DEEP, VD_NEAR_SHALLOW, w);
    groundTune.sizeFar = mix(DEEP_SIZE_FAR, SHALLOW_SIZE_FAR, w);
    groundTune.sizeMul = mix(1, SHALLOW_SIZE_MUL, w);
    groundTune.relMul = mix(1, SHALLOW_REL_MUL, w);
    if (Math.abs(w - lookW) > 1e-4) {
      lookW = w;
      seabed.setLook(
        mix(DEEP_COLOR[0], SHALLOW_COLOR[0], w),
        mix(DEEP_COLOR[1], SHALLOW_COLOR[1], w),
        mix(DEEP_COLOR[2], SHALLOW_COLOR[2], w),
        mix(DEEP_ALPHA, SHALLOW_ALPHA, w),
        mix(DEEP_TWK[0], SHALLOW_TWK[0], w),
        mix(DEEP_TWK[1], SHALLOW_TWK[1], w),
      );
    }
  }

  // The x the sheets were last built at. A rebuild is needed when the vessel
  // moves along the transect (the dots are world-anchored, so their y and their
  // recycling both follow the profile) — and NOT when it only dives, which is
  // why a v3.6-shaped session pays exactly v3.6's cost.
  let builtX = NaN;
  let layersDirty = true;

  function rebuildLayers() {
    applyGroundLook(groundW);
    if (seabed) seabed.rebuild(W, H, camDist, camXCur, groundTune);
    if (surface) surface.rebuild(W, H, camDist, camXCur, surfaceTune);
    builtX = camXCur;
    layersDirty = false;
  }
  if (wantLayers) rebuildLayers();

  // The seabed's intensity is DRIVEN (by depth and terrain, every frame), so a
  // caller's setIntensity() has to survive being driven: it sets the base the
  // driver multiplies. `groundApplied` is the last value actually written, so
  // the uniform is touched only when it moves.
  let groundBase = 1;
  let groundApplied = -1;

  // ---- geometry helpers --------------------------------------------------

  /** Frustum half-height in world px at a given z (the z=0 plane is 1:1 CSS). */
  function viewHalfPx(z) {
    return (H / 2) * (Math.max(camDist - (z || 0), 1) / camDist);
  }

  /** Frustum half-WIDTH in world px at a given z. */
  function viewHalfWidthPx(z) {
    return (W / 2) * (Math.max(camDist - (z || 0), 1) / camDist);
  }

  const bandOut = { topM: 0, bottomM: 0, spanM: 0, topY: 0, bottomY: 0, centreM: 0 };
  /**
   * The metre band currently framed by the porthole (at the z=0 plane).
   * Returns a SHARED object — read it, don't retain it.
   */
  function visibleBand(cssH) {
    const half = (cssH != null ? cssH / 2 : H / 2) * METRES_PER_PX;
    bandOut.centreM = curM;
    bandOut.topM = curM - half;
    bandOut.bottomM = curM + half;
    bandOut.spanM = half * 2;
    bandOut.topY = metresToWorldY(bandOut.topM);
    bandOut.bottomY = metresToWorldY(bandOut.bottomM);
    return bandOut;
  }

  const shoreBandOut = {
    centreM: 0,
    inshoreM: 0,
    offshoreM: 0,
    spanM: 0,
    centreX: 0,
    inshoreX: 0,
    offshoreX: 0,
  };
  /**
   * The stretch of transect currently framed by the porthole (at the z=0
   * plane) — the exact mirror of visibleBand, for horizontal culling and for a
   * UI that wants to draw where you are on the profile. SHARED object.
   */
  function visibleShoreBand(cssW) {
    const half = (cssW != null ? cssW / 2 : W / 2) * TRANSECT_METRES_PER_PX;
    shoreBandOut.centreM = curS;
    shoreBandOut.inshoreM = curS - half;
    shoreBandOut.offshoreM = curS + half;
    shoreBandOut.spanM = half * 2;
    shoreBandOut.centreX = camXCur;
    shoreBandOut.inshoreX = transectToWorldX(shoreBandOut.inshoreM);
    shoreBandOut.offshoreX = transectToWorldX(shoreBandOut.offshoreM);
    return shoreBandOut;
  }

  /**
   * How far (world px) a point is OUTSIDE the visible band VERTICALLY — 0 when
   * visible. Accounts for the frustum widening with depth, so a creature far
   * behind the z=0 plane is correctly still on screen.
   *
   * @param {number} y world Y
   * @param {number} [z] world Z (default 0)
   * @param {number} [radiusPx] the creature's own radius, kept on screen
   */
  function outOfBandPx(y, z, radiusPx) {
    const half = viewHalfPx(z) + (radiusPx || 0);
    const d = Math.abs(y - camYCur) - half;
    return d > 0 ? d : 0;
  }

  /** The same, HORIZONTALLY: world px outside the frame in x — 0 when visible. */
  function outOfBandPxX(x, z, radiusPx) {
    const half = viewHalfWidthPx(z) + (radiusPx || 0);
    const d = Math.abs(x - camXCur) - half;
    return d > 0 ? d : 0;
  }

  /**
   * The culling predicate v3.4 shipped — VERTICAL ONLY, and unchanged, so
   * every existing call site keeps its exact behaviour.
   *   if (!column.inView(c.py, c.pz, c.rad, SIM_MARGIN)) continue;
   */
  function inView(y, z, radiusPx, marginPx) {
    return outOfBandPx(y, z, radiusPx) <= (marginPx || 0);
  }

  /**
   * THE v3.7 CULLING PREDICATE: both axes at once. The world is now 19 screens
   * wide as well as 11 tall, so this is where the real saving is.
   *   if (!column.inViewXY(c.px, c.py, c.pz, c.rad, SIM_MARGIN)) continue;
   */
  function inViewXY(x, y, z, radiusPx, marginPx) {
    const m = marginPx || 0;
    return outOfBandPx(y, z, radiusPx) <= m && outOfBandPxX(x, z, radiusPx) <= m;
  }

  // ---- per-frame ---------------------------------------------------------

  // Exact analytic step of a critically damped spring; unconditionally stable.
  // Shared by both axes — same law, different flank cap and settle epsilons.
  // Returns the new offset in `spring.x` / velocity in `spring.v` (one record
  // per column, filled in place: no allocation, no closure per call).
  const spring = { x: 0, v: 0 };
  function stepSpring(x, v, dt, flank, settleX, settleV) {
    const e = Math.exp(-OMEGA * dt);
    const B = v + OMEGA * x;
    const lin = x + B * dt;
    let nx = lin * e;
    let nv = (B - OMEGA * lin) * e;
    // Flank speed: the vessel has a maximum rate, so a jump across the whole
    // world is a journey and not a smear. Velocity is handed to the spring at
    // exactly the cap, so the handover has no discontinuity.
    const move = nx - x;
    const maxMove = flank * dt;
    if (move > maxMove) {
      nx = x + maxMove;
      nv = flank;
    } else if (move < -maxMove) {
      nx = x - maxMove;
      nv = -flank;
    }
    if (Math.abs(nx) < settleX && Math.abs(nv) < settleV) {
      nx = 0;
      nv = 0;
    }
    spring.x = nx;
    spring.v = nv;
    return spring;
  }

  function stepDepth(dt) {
    const x = curM - targetM;
    if (x === 0 && velM === 0) return;
    stepSpring(x, velM, dt, FLANK_MPS, SETTLE_M, SETTLE_V);
    curM = targetM + spring.x;
    velM = spring.v;
  }

  function stepShore(dt) {
    const x = curS - targetS;
    if (x === 0 && velS === 0) return;
    stepSpring(x, velS, dt, FLANK_HMPS, SETTLE_HM, SETTLE_HV);
    curS = targetS + spring.x;
    velS = spring.v;
    camXCur = transectToWorldX(curS);
  }

  /**
   * One frame. dt is the injectable clock's delta in seconds; timeSec is the
   * optional sim time to hand the layers (defaults to an internal accumulator
   * so the module never reads a wall clock either way).
   */
  function update(dt, timeSec) {
    const d = dt > 0 ? dt : 0;
    simT = timeSec != null ? timeSec : simT + d;
    camYPrev = camYCur;
    camXPrev = camXCur;

    // The transect moves FIRST: the depth range it implies is what the dive is
    // then clamped into, so travelling inshore lifts the vessel with the
    // terrain in the same frame instead of one behind it.
    stepShore(d);
    recomputeRange();
    const clampedTarget = clampNav(targetM);
    if (clampedTarget !== targetM) {
      targetM = clampedTarget;
      emitDepth('floor'); // the terrain commanded a depth; the hash should know
    }
    stepDepth(d);
    if (curM > maxM) {
      curM = maxM;
      if (velM > 0) velM = 0;
    } else if (curM < minM) {
      curM = minM;
      if (velM < 0) velM = 0;
    }
    camYCur = metresToWorldY(curM);
    if ((camYCur !== camYPrev || camXCur !== camXPrev) && opts.onCamera) {
      opts.onCamera(camYCur, camXCur);
    }

    if (!wantLayers) return;
    if (camXCur !== builtX) layersDirty = true;

    // The sheet's tallest reach on screen is at its far edge, where the
    // frustum half-height is VD_FAR x the half-height at the z=0 plane.
    const layerReach = (H / 2) * VD_FAR + LAYER_MARGIN_PX;
    if (seabed) {
      // The seabed is no longer a plane, so "is it near the porthole" is a
      // question about a RANGE of depths: the profile is monotone, so the
      // shallowest ground in frame is at the inshore edge and the deepest at
      // the offshore edge, and two evaluations bound the whole sheet exactly.
      const ext = (W / 2 + 140) * VD_FAR;
      const dIn = profileDepthAt(worldXToTransect(camXCur - ext));
      const dOut = profileDepthAt(worldXToTransect(camXCur + ext));
      const yTop = metresToWorldY(dIn) + RELIEF_AMP;
      const yBot = metresToWorldY(dOut) - RELIEF_AMP;
      const expo = groundExposure(curM, floorM, groundW);
      const want = groundBase * expo;
      // Two gates, doing different jobs. The geometric one asks whether any of
      // the ground is within the porthole's vertical reach. The exposure one is
      // the honest one: below ~90 m there is simply too much water between you
      // and a lit reef to see it, so the layer is skipped WHOLE — no draw call,
      // no upload. Over the deep floor expo is exactly 1 and only geometry
      // decides, which is v3.6's behaviour to the frame.
      const vis = want > 0.004 && camYCur - layerReach <= yTop && camYCur + layerReach >= yBot;
      seabed.points.visible = vis;
      if (vis) {
        if (layersDirty) rebuildLayers();
        if (Math.abs(want - groundApplied) > 1e-4) {
          seabed.setIntensity(want);
          groundApplied = want;
        }
        seabed.setTime(simT);
      }
    }
    if (surface) {
      const vis = Math.abs(SURFACE_Y - camYCur) <= layerReach;
      surface.points.visible = vis;
      if (vis) {
        if (layersDirty) rebuildLayers();
        surface.ripple(simT);
        surface.setTime(simT);
      }
    }
  }

  // ---- camera ------------------------------------------------------------

  /**
   * Drop-in for the integrator's applyCamera(): place the camera on its yaw
   * arc at the column's current height AND its current place on the transect,
   * gazing horizontally. The yaw arc now orbits the vessel's own x, so the
   * z=0 plane keeps its 1:1 CSS-pixel mapping at every position.
   */
  function applyTo(camera, dist, yaw) {
    const d = dist != null ? dist : camDist;
    const a = yaw || 0;
    camera.position.set(camXCur + Math.sin(a) * d, camYCur, Math.cos(a) * d);
    camera.lookAt(camXCur, camYCur, 0);
  }

  // ---- navigation bindings ----------------------------------------------

  function typingInField() {
    if (typeof document === 'undefined') return false;
    const a = document.activeElement;
    if (!a) return false;
    return a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable === true;
  }

  const onWheel = (e) => {
    if (typingInField()) return;
    e.preventDefault(); // this is a dive control, not a scrollbar
    const scale = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? H : 1;
    // Shift-wheel is the horizontal axis (and browsers that already swap the
    // axes under shift are handled by taking whichever delta arrived); a
    // trackpad's native sideways swipe travels the transect without a modifier.
    const dx = e.deltaX;
    const dy = e.deltaY;
    if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
      const px = (e.shiftKey && dx === 0 ? dy : dx) * scale;
      if (px === 0) return;
      nudgeShore(px * SHORE_WHEEL_GAIN * TRANSECT_METRES_PER_PX, { source: 'wheel' });
      return;
    }
    // wheel px -> world px of dive -> metres. Positive deltaY descends.
    nudge(dy * scale * WHEEL_GAIN * METRES_PER_PX, { source: 'wheel' });
  };

  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (typingInField()) return;
    const band = halfBandM * 2;
    const span = halfSpanM * 2;
    switch (e.key) {
      case 'ArrowDown':
        nudge(KEY_STEP_M, { source: 'key' });
        break;
      case 'ArrowUp':
        nudge(-KEY_STEP_M, { source: 'key' });
        break;
      // Offshore is +x, so the shore is to your left: ArrowLeft heads for the
      // beach, ArrowRight for the abyss. Shift makes it a page of the frame,
      // exactly as PageUp/PageDown does on the vertical axis.
      case 'ArrowLeft':
        nudgeShore(e.shiftKey ? -span * PAGE_FRAC : -SHORE_KEY_STEP_M, { source: 'key' });
        break;
      case 'ArrowRight':
        nudgeShore(e.shiftKey ? span * PAGE_FRAC : SHORE_KEY_STEP_M, { source: 'key' });
        break;
      case 'PageDown':
        nudge(band * PAGE_FRAC, { source: 'key' });
        break;
      case 'PageUp':
        nudge(-band * PAGE_FRAC, { source: 'key' });
        break;
      case 'Home':
        if (e.shiftKey) setShore(minS, { source: 'key' });
        else setDepth(minM, { source: 'key' });
        break;
      case 'End':
        if (e.shiftKey) setShore(maxS, { source: 'key' });
        else setDepth(maxM, { source: 'key' });
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // Horizontal drag: grab the water and pull. 1 screen px = 1 world px at the
  // z=0 plane, so the water tracks the pointer exactly.
  //
  // The canvas already carries the integrator's own pointer handlers (select,
  // lure, ripple), so this one is deliberately timid: it never captures, never
  // preventDefaults, and only takes over once the pointer has moved clearly
  // sideways. `dragging()` stays true through the click that ends the drag, so
  // the integrator can skip a selection with one `if`.
  let dragId = -1;
  let dragX = 0;
  let dragY = 0;
  let dragActive = false;
  let dragRecent = false;

  const onPointerDown = (e) => {
    if (e.button !== 0 || typingInField()) return;
    dragId = e.pointerId;
    dragX = e.clientX;
    dragY = e.clientY;
    dragActive = false;
    dragRecent = false;
  };
  const onPointerMove = (e) => {
    if (dragId !== e.pointerId) return;
    const dx = e.clientX - dragX;
    const dy = e.clientY - dragY;
    if (!dragActive) {
      if (Math.abs(dx) < DRAG_START_PX || Math.abs(dx) < Math.abs(dy) * DRAG_BIAS) return;
      dragActive = true;
    }
    dragX = e.clientX;
    dragY = e.clientY;
    // Pull the water right -> the vessel travels left -> toward the shore.
    if (dx !== 0) nudgeShore(-dx * TRANSECT_METRES_PER_PX, { source: 'drag' });
  };
  const onPointerUp = (e) => {
    if (dragId !== e.pointerId) return;
    dragId = -1;
    if (dragActive) dragRecent = true;
    dragActive = false;
  };

  const navOn = opts.nav !== false;
  const dragOn = navOn && opts.drag !== false;
  if (navOn && canvas) canvas.addEventListener('wheel', onWheel, { passive: false });
  if (navOn && keyTarget) keyTarget.addEventListener('keydown', onKey);
  if (dragOn && canvas) {
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
  }

  // ---- resize ------------------------------------------------------------

  function resize(w, h, dist) {
    W = Math.max(1, w);
    H = Math.max(1, h);
    camDist = dist != null ? dist : H / 2 / Math.tan((FOV * Math.PI) / 360);
    recomputeBands();
    recomputeRange();
    // the navigable range moved under us — re-clamp both target and position
    targetM = clampNav(targetM);
    curM = clampNav(curM);
    camYCur = metresToWorldY(curM);
    camYPrev = camYCur;
    if (wantLayers) rebuildLayers();
    if (opts.onCamera) opts.onCamera(camYCur, camXCur);
  }

  // ---- boot --------------------------------------------------------------
  setShore(opts.shore != null ? opts.shore : DEFAULT_SHORE_M, { instant: true, source: 'boot' });
  setDepth(opts.depth != null ? opts.depth : DEFAULT_DEPTH_M, { instant: true, source: 'boot' });

  // ---- shared read-only outputs (no per-frame allocation) ----------------
  const rangeOut = {
    min: 0,
    max: 0,
    surface: 0,
    seabed: SEABED_DEPTH_M,
    span: SEABED_DEPTH_M,
    // v3.5, additive — the gauge may want to engrave the shelf on the scale.
    shelf: SHELF_DEPTH_M,
    shelfTop: SHELF_TOP_M,
    shelfBase: SHELF_BASE_M,
    // v3.7, additive — the LOCAL seabed, which is what actually stops the dive
    // here. `seabed` stays the column's deepest water (1200 m) so every
    // existing reader of the scale is untouched.
    floor: SEABED_DEPTH_M,
    breakDepth: BREAK_DEPTH_M,
  };
  function range() {
    rangeOut.min = minM;
    rangeOut.max = maxM;
    rangeOut.surface = 0;
    rangeOut.seabed = SEABED_DEPTH_M;
    rangeOut.span = SEABED_DEPTH_M;
    rangeOut.floor = floorM;
    return rangeOut; // shared object — read, don't retain
  }

  const shoreRangeOut = {
    min: 0,
    max: TRANSECT_M,
    shore: 0,
    offshore: TRANSECT_M,
    span: TRANSECT_M,
    break: BREAK_M,
    breakDepth: BREAK_DEPTH_M,
    plain: PLAIN_START_M,
  };
  /** The transect's navigable stops and its landmarks, in metres offshore —
   *  the exact shape of range(). SHARED object. */
  function shoreRange() {
    shoreRangeOut.min = minS;
    shoreRangeOut.max = maxS;
    return shoreRangeOut;
  }

  const infoOut = {
    depth: 0,
    target: 0,
    rate: 0,
    camY: 0,
    deltaPx: 0,
    zone: 'sunlit',
    light: 1,
    seabedVisible: false,
    surfaceVisible: false,
    shelfVisible: false,
    shelfExposure: 0,
    // v3.7 — the second axis
    shore: 0,
    shoreTarget: 0,
    shoreRate: 0,
    camX: 0,
    deltaXPx: 0,
    deltaYPx: 0,
    shoreZone: 'abyss',
    floorM: SEABED_DEPTH_M,
    floorGradient: 0,
    groundWeight: 0,
  };
  function info() {
    infoOut.depth = curM;
    infoOut.target = targetM;
    infoOut.rate = velM;
    infoOut.camY = camYCur;
    infoOut.deltaYPx = camYCur - camYPrev;
    infoOut.deltaXPx = camXCur - camXPrev;
    infoOut.deltaPx = Math.hypot(infoOut.deltaXPx, infoOut.deltaYPx);
    infoOut.zone = zoneAt(curM).id;
    infoOut.light = lightAt(curM);
    infoOut.seabedVisible = seabed ? seabed.points.visible : false;
    infoOut.surfaceVisible = surface ? surface.points.visible : false;
    // v3.5 keys, kept: "is there shelf-shallow ground in frame, and how much of
    // it can you see". They mean the same thing they always did.
    infoOut.shelfVisible = seabed ? seabed.points.visible && groundW > 0.05 : false;
    infoOut.shelfExposure = seabed ? groundExposure(curM, floorM, groundW) : 0;
    infoOut.shore = curS;
    infoOut.shoreTarget = targetS;
    infoOut.shoreRate = velS;
    infoOut.camX = camXCur;
    infoOut.shoreZone = shoreZoneAt(curS).id;
    infoOut.floorM = floorM;
    infoOut.floorGradient = profileGradientAt(curS);
    infoOut.groundWeight = groundW;
    return infoOut; // shared object — read, don't retain
  }

  const api = {
    // ---- navigation: the vertical axis -----------------------------------
    setDepth, // setDepth(metres, { instant?: bool, source?: string }) -> clamped m
    nudge, // nudge(deltaMetres, opts?) — relative to the TARGET, so wheel accumulates
    depth: () => curM, // eased, live position (what the gauge needle reads)
    targetDepth: () => targetM, // commanded depth (what the URL hash stores)
    rate: () => velM, // m/s, signed (+ = descending) — a rate-of-dive readout
    range, // shared { min, max, surface, seabed, floor, span } in metres
    onDepthChange(cb) {
      depthListeners.push(cb);
      return () => {
        const i = depthListeners.indexOf(cb);
        if (i >= 0) depthListeners.splice(i, 1);
      };
    },

    // ---- navigation: the horizontal axis (v3.7) --------------------------
    // Method for method the same shape as the four above. Metres offshore,
    // 0 at the shoreline, TRANSECT_M at the far end over the abyssal plain.
    setShore, // setShore(metresOffshore, { instant?, source? }) -> clamped m
    nudgeShore, // nudgeShore(deltaMetres, opts?)
    shore: () => curS, // eased, live position
    targetShore: () => targetS, // commanded position (the URL hash stores this)
    shoreRate: () => velS, // m/s of transect, signed (+ = heading offshore)
    shoreRange, // shared { min, max, shore, offshore, span, break, plain }
    shoreZoneAt, // (metresOffshore) -> a SHORE_ZONES entry
    onShoreChange(cb) {
      shoreListeners.push(cb);
      return () => {
        const i = shoreListeners.indexOf(cb);
        if (i >= 0) shoreListeners.splice(i, 1);
      };
    },
    /** True while a horizontal drag owns the pointer, and through the click
     *  that ends it — check this before selecting a creature on click. */
    dragging: () => dragActive || dragRecent,

    // ---- per-frame -------------------------------------------------------
    update, // update(dt, timeSec?) — injectable clock only
    resize, // resize(cssW, cssH, camDist?)

    // ---- the camera ------------------------------------------------------
    camY: () => camYCur, // world Y the camera should sit at THIS frame
    camX: () => camXCur, // world X ditto (v3.7 — anything pinned to the vessel
    // rather than to the world must add this)
    /** World px the camera travelled last update, as a MAGNITUDE over both
     *  axes — feed this to pipeline.render(dt, camDeltaPx) for frame-graph
     *  rule 4, so travelling the transect flushes the trails exactly the way a
     *  dive does. (v3.6 returned the signed vertical; every call site took its
     *  absolute value, so this is a strict improvement, not a break.) */
    deltaPx: () => Math.hypot(camXCur - camXPrev, camYCur - camYPrev),
    deltaYPx: () => camYCur - camYPrev, // signed vertical, if you want the sign
    deltaXPx: () => camXCur - camXPrev, // signed horizontal (+ = offshore)
    applyTo, // applyTo(camera, camDist?, yaw?) — drop-in applyCamera body

    // ---- the world model (instance mirrors of the module constants) ------
    worldYToMetres,
    metresToWorldY,
    clampDepth,
    clampWorldY,
    zoneAt,
    lightAt,
    METRES_PER_PX,
    PX_PER_METRE,
    SURFACE_Y,
    SEABED_Y,
    SEABED_DEPTH_M,
    COLUMN_PX,
    ZONES,

    // ---- the transect (v3.7) ---------------------------------------------
    transectToWorldX,
    worldXToTransect,
    clampTransect,
    profileDepthAt, // (metresOffshore) -> seabed depth in metres — THE PROFILE
    profileDepthAtX, // (worldX) -> the same
    profileGradientAt, // (metresOffshore) -> d(depth)/d(transect)
    transectAtDepth, // (depthM) -> metres offshore of that isobath
    worldXAtDepth, // (depthM) -> world X of that isobath
    transectSpanForDepths, // (minDepthM, maxDepthM, out?) -> {inshoreM, offshoreM}
    shallowWeight,
    TRANSECT_METRES_PER_PX,
    PX_PER_TRANSECT_M,
    VERTICAL_EXAGGERATION,
    TRANSECT_M,
    SHORE_X,
    OFFSHORE_X,
    BREAK_M,
    BREAK_DEPTH_M,
    PLAIN_START_M,
    SHORE_STOP_M,
    SHORE_ZONES,
    PROFILE_KEYS,
    /** The mean seabed depth under the vessel right now, metres. */
    floorDepth: () => floorM,

    // ---- the ground ------------------------------------------------------
    // seabedYAt(x, z) answers from the PROFILE: one seabed, whose depth depends
    // on where along the transect you ask. At the far offshore end — where the
    // whole v3.6 world sat — that is the abyssal plain it has always been.
    // The optional third argument (metres below the surface) is a hint that the
    // caller lives at a depth; see the substrate query above for what it does
    // and why it is a bridge to be retired.
    seabedYAt,
    seabedDepthAt, // (x, z) -> metres, relief included
    groundYAt, // (x, z) -> world Y of the seabed, the sheet's own function
    substrateAt, // (x, z, nearDepthM?, out?) -> the full record
    substrateYAt, // (x, z, nearDepthM?) -> world Y
    reliefAt, // (x, z, w) -> signed world px of relief
    abyssalYAt, // (x, z) -> the deep plain, unconditionally (legacy)
    shelfYAt, // (x, z) -> the inner-shelf bench (legacy)
    shelfCoverAt, // -> 1; the transect's seabed has no holes (legacy)
    hasShelfAt, // (x, z, nearDepthM?) -> bool
    SUBSTRATE_SHORE,
    SUBSTRATE_SHELF,
    SUBSTRATE_SLOPE,
    SUBSTRATE_PLAIN,
    SHELF_Y,
    SHELF_DEPTH_M,
    SHELF_TOP_M,
    SHELF_BASE_M,
    SHELF_REACH_M,
    SHELF_TOE_Z,
    RIDGE_AMP,
    SHELF_AMP,
    RELIEF_AMP,

    // ---- culling ---------------------------------------------------------
    visibleBand, // visibleBand(cssH?) -> shared vertical band object
    visibleShoreBand, // visibleShoreBand(cssW?) -> shared horizontal band object
    viewHalfPx, // viewHalfPx(z) -> frustum half-height in world px at that z
    viewHalfWidthPx, // viewHalfWidthPx(z) -> frustum half-width, ditto
    inView, // inView(y, z?, radiusPx?, marginPx?) -> bool (vertical only)
    inViewXY, // inViewXY(x, y, z?, radiusPx?, marginPx?) -> bool (BOTH axes)
    outOfBandPx, // outOfBandPx(y, z?, radiusPx?) -> px outside the band (0 = in)
    outOfBandPxX, // outOfBandPxX(x, z?, radiusPx?) -> ditto, horizontally

    // ---- the scene layers -------------------------------------------------
    seabed, // { points, setIntensity, getIntensity, ... } or null — ONE seabed
    // now; `shelf` is kept as an alias so a v3.5 caller that reached for the
    // bench gets the ground it meant.
    shelf: seabed,
    surface,
    setIntensity(v) {
      if (surface) surface.setIntensity(v);
      // The seabed's uniform is written every frame from depth and terrain, so
      // a caller sets the BASE it is multiplied by; passing 0 still switches it
      // off.
      if (seabed) {
        groundBase = Math.min(Math.max(v, 0), 1);
        groundApplied = -1;
      }
    },

    info, // shared telemetry object

    dispose() {
      if (navOn && canvas) canvas.removeEventListener('wheel', onWheel);
      if (navOn && keyTarget) keyTarget.removeEventListener('keydown', onKey);
      if (dragOn && canvas) {
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('pointercancel', onPointerUp);
      }
      depthListeners.length = 0;
      shoreListeners.length = 0;
      if (seabed) seabed.dispose();
      if (surface) surface.dispose();
    },
  };

  // Test/dev hook, registered exactly the way shaders/dots.js and ui/ambient.js
  // register theirs (main.js spreads pre-existing __menagerie keys, so nothing
  // is clobbered whichever order modules load in).
  if (typeof window !== 'undefined') {
    window.__menagerie = window.__menagerie || {};
    window.__menagerie.column = api;
  }

  return api;
}

export default createColumn;

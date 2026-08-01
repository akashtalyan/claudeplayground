// The water column — v3.5. The world stops being one flat screen-sized slice
// and becomes a TALL VERTICAL COLUMN of ocean: a bright rippling surface
// overhead, 1200 m of water, an abyssal seabed at the bottom. The camera is a
// vessel that travels vertically through it; creatures live at their species'
// natural depth and STAY there.
//
// v3.5 adds the CONTINENTAL SHELF. Until now the column had exactly one bottom
// — the abyssal plain at 1200 m — which meant every photosynthetic organism in
// the app was rooted in permanent darkness. Real kelp forests, coral heads,
// seagrass and anemones grow on a shallow rocky bench in the sunlit zone, so
// the column now has TWO substrates (see "the shelf" below) and one query that
// answers which one is under you.
//
// This module is the SINGLE SOURCE OF TRUTH for the vertical world:
//
//   * the metre <-> world-px scale (METRES_PER_PX / PX_PER_METRE) and the
//     boundary planes (SURFACE_Y, SHELF_Y, SEABED_Y). Every other module —
//     atmosphere, species depth bands, the console's depth gauge, background —
//     imports its numbers FROM HERE and never re-derives them.
//   * the camera's vertical position and its navigation (wheel, arrow keys,
//     PageUp/PageDown, Home/End), with critically-damped motion: a submarine
//     has mass, so the porthole eases to a new depth, it never snaps.
//   * the three scene layers that make the column read as a bounded volume: a
//     dotted seabed plane at the bottom, a reef bench in the sunlit zone and a
//     shimmering surface ceiling at the top, all drawn with the ONE dot shader
//     program (frame-graph rule 7) — no new GLSL, no terrain mesh.
//   * the SUBSTRATE QUERY — substrateAt() / seabedYAt() — the one function the
//     rest of the app asks "where is the ground near this depth".
//   * culling info, so the integrator can skip target math for creatures far
//     outside the visible band (the real perf win once the world is tall).
//
// Contracts honoured:
//   * frame-graph rule 7  — layers reuse createDotMaterial; no new program.
//   * frame-graph rule 11 — no wall-clock reads anywhere; update(dt) takes the
//     injectable clock's delta and the layers' shimmer rides an accumulator.
//   * frame-graph rule 4  — deltaPx() reports the camera's per-frame vertical
//     travel in world px so the integrator can feed the trails' camera×fade
//     coupling instead of the hardcoded 0.
//   * geometry-spec 8     — every RNG draw comes from one mulberry32 stream in
//     a frozen order; resize() re-derives positions arithmetically and draws
//     NOTHING, so the column is byte-identical across viewports and reloads.
//   * no allocation in the frame loop — all layer state is preallocated typed
//     arrays; range()/visibleBand()/info() return shared objects (read, don't
//     retain).

import * as THREE from 'three';
import { mulberry32 } from './geometry/rng.js';
import { createDotMaterial } from './shaders/dots.js';

// ---------------------------------------------------------------------------
// The scale. ONE constant, defined here, imported everywhere.
// ---------------------------------------------------------------------------

/** Metres of ocean per world pixel. The z=0 plane is 1:1 with CSS px, so this
 *  is also metres per CSS pixel of vertical screen travel at that plane. */
export const METRES_PER_PX = 0.2;
/** World px per metre — 1 / METRES_PER_PX, precomputed (5 px = 1 m). */
export const PX_PER_METRE = 1 / METRES_PER_PX;

/** World Y of the water surface. Depth is measured DOWN from here. */
export const SURFACE_Y = 0;
/** Depth of the seabed, in metres below the surface. */
export const SEABED_DEPTH_M = 1200;
/** Height of the column in world px (1200 m x 5 px/m = 6000 px ≈ 7–11 screens). */
export const COLUMN_PX = SEABED_DEPTH_M * PX_PER_METRE;
/** World Y of the abyssal seabed's mean plane (ridges undulate about it). */
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

// ---- the abyssal plain ----------------------------------------------------
// A pure, deterministic dune field: three incommensurate sines, no storage, no
// RNG. Deep-water flora and the benthos are planted ON it (see the substrate
// query below) so plants and the dot floor agree exactly. Amplitude ±75 px ≈
// ±15 m of gentle relief. Wavelengths (~2400 / 900 / 400 world px) are sized to
// the strip of floor the porthole actually frames — longer ones read as a flat
// plateau, not dunes.
const RIDGE = [
  { a: 42, kx: 0.0026, kz: 0.0017, ph: 0.7 },
  { a: 22, kx: 0.0068, kz: -0.0031, ph: 2.3 },
  { a: 11, kx: 0.0155, kz: 0.0, ph: 1.1 },
];

/** World Y of the ABYSSAL PLAIN under a world (x, z). Always the deep floor —
 *  this is the 1200 m plane and it has no opinion about the shelf. */
export function abyssalYAt(x, z) {
  let y = SEABED_Y;
  for (let i = 0; i < RIDGE.length; i++) {
    const r = RIDGE[i];
    y += r.a * Math.sin(x * r.kx + z * r.kz + r.ph);
  }
  return y;
}

/** Max relief above/below the mean plane — placement guards and layer culling. */
export const RIDGE_AMP = RIDGE[0].a + RIDGE[1].a + RIDGE[2].a;

// ---- the continental shelf ------------------------------------------------
// The second substrate: a rocky reef BENCH in the sunlit zone, the only ground
// in the column that light-dependent life can actually grow on. Same idiom as
// the abyssal plain — one pure function of (x, z), no mesh, no storage, no RNG
// — plus one thing the plain does not have: an EDGE.
//
// Depth. The bench sits at SHELF_DEPTH_M with ±SHELF_AMP of reef relief, i.e.
// its rock spans ~29-45 m. That is the honest window: it is deep enough that
// the vessel can hover ABOVE it at every viewport height (see MIN_DEPTH_CAP_M),
// and shallow enough to sit inside the 8-45 m band where kelp holdfasts, coral
// heads, seagrass and anemones really do grow. Nothing here shortens the water:
// the bench is ground, so the water above it is the water above it.
//
// Wavelengths are ~2000 / 800 / 350 world px — deliberately shorter than the
// abyssal dunes. A reef is lumpier than a sediment plain, and at the grazing
// angle you see the bench from (you can only get ~10-20 m above it) short
// wavelengths are what read as relief at all.
/** Mean depth of the shelf bench, metres below the surface. */
export const SHELF_DEPTH_M = 37;
const REEF = [
  { a: 22, kx: 0.0031, kz: 0.0019, ph: 2.1 },
  { a: 11, kx: 0.0079, kz: -0.0043, ph: 0.4 },
  { a: 6, kx: 0.0182, kz: 0.0091, ph: 3.3 },
];

/** World Y of the shelf bench's mean plane (reef relief undulates about it). */
export const SHELF_Y = SURFACE_Y - SHELF_DEPTH_M * PX_PER_METRE;
/** Max reef relief above/below that mean plane, in world px. */
export const SHELF_AMP = REEF[0].a + REEF[1].a + REEF[2].a;
/** Shallowest / deepest rock on the bench proper, in metres. */
export const SHELF_TOP_M = SHELF_DEPTH_M - SHELF_AMP * METRES_PER_PX;
export const SHELF_BASE_M = SHELF_DEPTH_M + SHELF_AMP * METRES_PER_PX;

// The shelf EDGE, and why it is where it is. The bench occupies the near and
// middle field and rolls over into the drop-off at SHELF_EDGE_Z, which is
// BEYOND the z band the app places creatures in (main.js: Z_MIN = -340) — so
// every creature the board can place has real rock under it, and the lip is a
// thing you look AT rather than a hole things fall through.
//
// The lip is scalloped by two long sines of x, because a ruler-straight rim
// reads as a drawn line and a wandering one reads as coast. Its extremes are
// [-574, -366] world px, still clear of the creature band.
//
// The drop-off itself is a SUGGESTION, not a continental slope, and it has to
// be: the dot pass has no depth test (frame-graph rule 1 — additive, depthTest
// off), so a tall slope face drawn past the lip would composite straight
// THROUGH the bench in front of it and read as ghosting, not as a cliff. So
// the substrate rolls over, accelerates downward, and its dots are gone within
// SHELF_COVER_END of the run — the ground curves away and dissolves into blue.
// That is the whole drop-off, and it costs one multiply per dot at rebuild.
const SHELF_EDGE_Z = -470;
const SHELF_RUN_PX = 330; // lip -> toe, along z
const SHELF_FALL_PX = 300; // total plunge across that run (60 m)
const SHELF_COVER_END = 0.55; // fraction of the run where the last dot dies
/** World z at which the shelf substrate has ended completely. */
export const SHELF_TOE_Z = SHELF_EDGE_Z - SHELF_RUN_PX;

/** World z of the shelf lip at a given x — the scalloped rim. */
function shelfEdgeZAt(x) {
  return SHELF_EDGE_Z + 74 * Math.sin(x * 0.0034 + 1.7) + 30 * Math.sin(x * 0.0091 - 0.6);
}

/** 0 on the bench, 1 at the toe of the drop-off. */
function shelfRollover(x, z) {
  const u = (shelfEdgeZAt(x) - z) / SHELF_RUN_PX;
  return u <= 0 ? 0 : u >= 1 ? 1 : u;
}

/** World Y of the shelf's rock surface under a world (x, z). Valid wherever
 *  shelfCoverAt(x, z) > 0; past the toe it keeps falling but nothing is drawn
 *  there and the substrate query stops answering "shelf". */
export function shelfYAt(x, z) {
  let y = SHELF_Y;
  for (let i = 0; i < REEF.length; i++) {
    const r = REEF[i];
    y += r.a * Math.sin(x * r.kx + z * r.kz + r.ph);
  }
  const u = shelfRollover(x, z);
  return u > 0 ? y - SHELF_FALL_PX * u * u : y;
}

/** How much shelf there is at (x, z): 1 on the bench, easing to 0 across the
 *  drop-off, 0 in the open water beyond it. Both the dot layer's per-dot fade
 *  and the substrate query read this, so what you can SEE and what a creature
 *  can STAND ON are the same surface by construction. */
export function shelfCoverAt(x, z) {
  const u = shelfRollover(x, z);
  return u <= 0 ? 1 : 1 - smoothstep01(u / SHELF_COVER_END);
}

/** Deepest depth (metres) at which the shelf is still the answer. Past this a
 *  creature is in open water over the drop-off and its ground is the abyssal
 *  plain — the query never invents rock at a depth that has none. Sits just
 *  below the visible toe of the roll-over (~45 m + 18 m of fall). */
export const SHELF_REACH_M = 70;

// ---- the substrate query --------------------------------------------------
// ONE question, asked everywhere: "what is the ground near THIS depth, under
// THIS (x, z)?". v3.4 had a single floor and so a single answer, seabedYAt(x,
// z). v3.5 has two substrates, so the question needs the depth to disambiguate
// — a holdfast at 20 m means the reef bench, a crab at 1195 m means the plain.
//
// Back-compatibility is exact and deliberate: with two arguments seabedYAt is
// the v3.4 function, bit for bit, and every existing call site (main.js's
// rooted re-planting, depthbands.js's floorYAt adapter, this module's own
// seabed sheet) keeps the abyssal plain it has always had. The shelf is only
// ever reachable by passing the third argument.

/** Substrate identifiers — 'shelf' (the sunlit reef bench) or 'plain' (the
 *  abyssal plain at 1200 m). Stable strings; safe to compare and to label. */
export const SUBSTRATE_SHELF = 'shelf';
export const SUBSTRATE_PLAIN = 'plain';

const substrateOut = {
  kind: SUBSTRATE_PLAIN,
  y: SEABED_Y,
  depthM: SEABED_DEPTH_M,
  coverage: 1,
  shelf: false,
};

/**
 * The ground near a depth, as a record.
 *
 *   const g = substrateAt(x, z, 22);   // { kind:'shelf', y, depthM, coverage }
 *   const g = substrateAt(x, z, 1195); // { kind:'plain', ... }
 *   const g = substrateAt(x, z);       // no depth given -> the plain
 *
 * @param {number} x world x
 * @param {number} z world z
 * @param {number} [nearDepthM] the depth (metres below the surface) the caller
 *        cares about — typically the creature's own home depth. Omit for the
 *        abyssal plain, which is what the v3.4 world always answered.
 * @param {object} [out] a caller-owned record to fill (for anything on a frame
 *        path that wants to keep more than one alive at a time).
 * @returns {{kind:string, y:number, depthM:number, coverage:number, shelf:boolean}}
 *        `y` is the world Y of the rock/sediment surface; `depthM` the same in
 *        metres; `coverage` is 1 on solid ground and eases to 0 across the
 *        shelf's drop-off (always 1 on the plain). WITHOUT `out` this is a
 *        SHARED object — read it, don't retain it (no frame-path allocation).
 */
export function substrateAt(x, z, nearDepthM, out) {
  const rec = out || substrateOut;
  const px = x || 0;
  const pz = z || 0;
  const m = nearDepthM == null ? null : +nearDepthM;
  if (m != null && Number.isFinite(m) && m <= SHELF_REACH_M) {
    const cover = shelfCoverAt(px, pz);
    if (cover > 0) {
      const y = shelfYAt(px, pz);
      rec.kind = SUBSTRATE_SHELF;
      rec.y = y;
      rec.depthM = worldYToMetres(y);
      rec.coverage = cover;
      rec.shelf = true;
      return rec;
    }
  }
  const y = abyssalYAt(px, pz);
  rec.kind = SUBSTRATE_PLAIN;
  rec.y = y;
  rec.depthM = worldYToMetres(y);
  rec.coverage = 1;
  rec.shelf = false;
  return rec;
}

/** World Y of the ground near a depth — substrateAt(...).y, allocation-free. */
export function substrateYAt(x, z, nearDepthM) {
  return substrateAt(x, z, nearDepthM).y;
}

/**
 * World Y of the ground under a world (x, z).
 *
 *   seabedYAt(x, z)      -> the abyssal plain (v3.4 behaviour, unchanged)
 *   seabedYAt(x, z, 20)  -> the shelf bench, if there is shelf at (x, z)
 *   seabedYAt(x, z, 900) -> the abyssal plain (nothing lives on rock at 900 m)
 *
 * The third argument is the ONLY way to reach the shelf, so no existing caller
 * can be surprised by it.
 */
export function seabedYAt(x, z, nearDepthM) {
  if (nearDepthM == null) return abyssalYAt(x, z);
  return substrateAt(x, z, nearDepthM).y;
}

/** True if there is standing ground at (x, z) for something living at this
 *  depth — i.e. the shelf query would answer 'shelf' and the rock is actually
 *  drawn there (coverage above the given threshold, default 0.35, so a plant
 *  is never rooted on a ghost at the fading lip of the drop-off). */
export function hasShelfAt(x, z, nearDepthM, minCover) {
  if (nearDepthM != null && +nearDepthM > SHELF_REACH_M) return false;
  return shelfCoverAt(x || 0, z || 0) >= (minCover == null ? 0.35 : minCover);
}

// ---------------------------------------------------------------------------
// Camera motion + layer tuning
// ---------------------------------------------------------------------------

const FOV = 55; // must match FOV in main.js
const REF_DIST = 10; // must match REF_DIST in shaders/dots.js
const TAU = Math.PI * 2;

// Critically damped approach: x'' = -2w x' - w^2 (x - target), stepped with
// the exact analytic solution so it is stable and identical at any dt.
const OMEGA = 3.4; // 1/s — settles to ~2% in ~1.8 s
const FLANK_MPS = 300; // dive-speed cap (m/s = 1500 world px/s) so a jump
// across the whole column reads as travel (~5.4 s surface->seabed, ~3 screens
// a second) rather than a teleport blur
const SETTLE_M = 0.02; // below this offset AND velocity the motion is parked
const SETTLE_V = 0.05;

// Navigation gains.
/** World px of dive per wheel pixel (a dive, not a scrollbar). EXPORTED
 *  because the depth gauge scrolls the same water: wheel-over-instrument and
 *  wheel-over-porthole have to mean the same thing, and a mirrored copy of this
 *  number in ui/depthgauge.js was the one place the two could silently drift
 *  apart. One definition, here, with the rest of the world's units. */
export const WHEEL_GAIN = 2.6;
const WHEEL_LINE_PX = 16; // deltaMode 1 (lines) -> px
const KEY_STEP_M = 26; // arrow key
const PAGE_FRAC = 0.8; // PageUp/Down = this fraction of the visible band

// Where the boundaries are allowed to sit at the ends of the travel, as a
// fraction of the half-band. The vessel is always submerged: it can never put
// the porthole above the waterline or below the floor, which is why the gauge
// bottoms out a little short of 0 m (range().min) rather than at 0. At min
// depth the surface hangs 20% down from the top edge — you are just under the
// waterline looking up through it; at max depth the vessel hovers 1.15 x the
// half-band above the floor, which puts the ridge line ~74% down the frame and
// runs the near floor off the bottom edge — the geometry of hovering over a
// plane, at any viewport size (both terms scale with CSS height).
const SURFACE_STOP = 0.6;
const SEABED_STOP = 1.15;

// ...and, v3.5, a hard metre cap on the shallow stop. The rule above is purely
// FRACTIONAL, so the shallowest reachable depth scales with the viewport: 32 m
// on the 540 px test viewport, 50 m on a laptop, 72 m on a tall display. That
// is fine for a column whose only floor is at 1200 m and fatal for one with a
// reef bench at 29-45 m — on any window taller than ~900 px the vessel could
// never get ABOVE the shelf, and ground you can only ever look up at is not
// ground. The cap makes the shallow stop viewport-INDEPENDENT once the
// viewport is big enough to matter, and 26 m clears the shallowest reef crest
// (SHELF_TOP_M = 29.2 m) by 5 m of water at every size.
//
// It is a ceiling, never a floor: on a short viewport SURFACE_STOP still wins,
// so the porthole is never pushed up through the waterline.
const MIN_DEPTH_CAP_M = 24;

// Layer extents, expressed as VIEW DISTANCE as a fraction of camDist — not as
// absolute z. A ground plane's near edge has to come close enough to the lens
// to run off the bottom of the frame (at 0.38x camDist the floor projects ~355
// px below the axis, comfortably past the edge); pinning it to an absolute z
// left the floor as a thin band floating at mid-screen. Fractions also make
// both sheets viewport-invariant for free: camDist scales with CSS height, so
// the floor covers the same screen area on any display.
const VD_NEAR = 0.38; // z = +0.62 x camDist — in front of the creature plane
const VD_FAR = 2.4; // z = -1.4 x camDist — far enough to haze, near enough to
// survive the abyss preset's fog
// INTEGRATION TUNING (v3.4 integrator): a FLOOR wants its near edge right under
// the lens — that is what runs it off the bottom of the frame. A CEILING does
// not: at the shallow travel stop the surface is only ~160 px overhead, so
// sheet dots 0.38 x camDist in front of the lens sit almost against the
// porthole and the whole upper frame filled with point-blank glitter (and, at
// that projected speed, with its trails). Holding the surface sheet's near edge
// back to 0.85 x camDist puts its nearest dots ~470 px away, where the ceiling
// reads as a rippling boundary above you instead of confetti in your face.
const SURFACE_VD_NEAR = 0.85;
// The shelf pulls the OTHER way, and for the mirror-image reason. The abyssal
// plain is seen from 60-100 m up, so 0.38 x camDist already runs its near edge
// off the bottom of the frame. The bench is seen from 3-19 m up (that is as
// high as the vessel gets over it), and at that grazing height a near edge held
// back to 0.38 x camDist projects only ~145 px below the axis — the ground
// stops in mid-frame with empty water under it, which is exactly the "thin band
// floating at mid-screen" failure VD_NEAR exists to prevent. 0.19 puts the
// nearest rock ~100 px from the lens, which projects past the bottom edge at
// every height the vessel can hover at. Sprite size is unaffected: aSize is
// authored per dot in CSS px at its own view distance.
const SHELF_VD_NEAR = 0.19;
const HORIZON_BIAS = 1.35; // >1 crowds samples toward the far end, which is
// what turns a scatter into a ridge line at the horizon
const LAYER_MARGIN_PX = 140; // relief/ripple slack on the visibility test

const SEABED_ALPHA = 0.8;
// INTEGRATION TUNING 0.85 -> 0.5 (v3.4 integrator): at the shallow travel stop
// the ceiling is only ~160 px overhead, so its glitter is seen at point-blank
// range and a near-opaque sheet read as confetti over the whole upper frame.
// Half the alpha (and a calmer twinkle below) keeps it as sun-glitter ON a
// surface rather than a second creature.
const SURFACE_ALPHA = 0.5;

// The shelf is GROUND SEEN THROUGH WATER, and the water it is seen through is
// the brightest in the column. That is the whole tuning problem: the abyssal
// plain can afford 0.8 alpha because it is the only thing emitting for 200 m
// in every direction, whereas a sheet that bright at 37 m would composite onto
// already-lit sunlit water as a slab and flatten the one zone whose identity is
// "there is still daylight here". So the bench is authored dim and then dimmed
// AGAIN by shelfExposure() below.
const SHELF_ALPHA = 0.46;
// How the reef leaves you as you sink past it. Descending off the shelf edge is
// the app's one moment of "leaving a lit reef behind", and the shape of that
// exit is the whole beat: NOT a linear dissolve (which reads as a fade-out
// effect) but the extinction of contrast through the water between the porthole
// and the rock — fast at first, then a long dim tail, exactly like watching a
// reef go as you drop off its edge.
//
// SHELF_SINK_M is that extinction length. The cutoff terms then take it to
// exactly zero at ~92 m, which is why the shelf contributes NOTHING at the
// app's neutral 120 m: every v3.4 frame at or below that depth is untouched,
// down to the draw call.
const SHELF_SINK_M = 26; // e-folding depth of the reef's contrast, metres
const SHELF_CUT_FROM_M = 30; // metres below the bench where the tail is cut...
const SHELF_CUT_SPAN_M = 25; // ...over this many more, to zero

/**
 * The shelf layer's own light, 0..1, for a vessel at camM metres.
 *
 * Three terms, all physical rather than aesthetic: whether you are above the
 * bench at all, how much water is between the porthole and the rock, and how
 * much daylight is still reaching that depth (lightAt — the same Beer-Lambert
 * curve the depth profile keys its optics to). None of them is a taste knob;
 * together they are the reason the bench never reads as a lit slab floating in
 * the sunlit zone.
 */
function shelfExposure(camM) {
  const lit = 0.58 + 0.42 * lightAt(camM);
  const below = camM - SHELF_DEPTH_M;
  if (below <= 0) return lit; // hovering over the reef: full contrast
  const cut = 1 - smoothstep01((below - SHELF_CUT_FROM_M) / SHELF_CUT_SPAN_M);
  if (cut <= 0) return 0;
  return lit * Math.exp(-below / SHELF_SINK_M) * cut;
}

// ---------------------------------------------------------------------------
// A dotted sheet: one Points object lying on a horizontal plane, sampled so it
// fills the frustum at every depth and crowds toward the horizon (which is why
// it reads as a floor/ceiling and not a scatter). Shared by seabed + shelf +
// surface.
// ---------------------------------------------------------------------------

function buildSheet(scene, globalUniforms, cfg) {
  const N = cfg.count;
  const sizeFar = cfg.sizeFar ?? 0.3;
  const rng = mulberry32(cfg.seed >>> 0);

  // ---- frozen draw order: per-dot block, append only ----
  const u = new Float32Array(N); // -1..1 across the frustum at that dot's z
  const sn = new Float32Array(N); // 0 = horizon, 1 = right under the lens
  const rel = new Float32Array(N); // per-dot offset off the plane (px)
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
  // resting Y of each dot (plane + relief + per-dot offset); the ripple rides
  // on top of this, so nothing recomputes the plane per frame
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

  // Deterministic rebuild: a pure arithmetic function of (w, h, camDist). No
  // RNG, no reallocation — the sheet is never rebuilt from draws.
  function rebuild(w, h, camDist) {
    const halfW = w / 2 + 140;
    const invNear = 1 / ((cfg.vdNear ?? VD_NEAR) * camDist);
    // cfg.farZ pins the far edge to an ABSOLUTE world z instead of a fraction
    // of camDist. A sheet with a real edge in the world (the shelf's drop-off)
    // has to end where the world says it ends, not where the viewport does, or
    // half its dots land past the toe and are drawn at zero alpha. Sheets
    // without it are untouched: the fraction path is the v3.4 arithmetic.
    const farVd =
      cfg.farZ != null
        ? Math.max(camDist - cfg.farZ, camDist * 1.05)
        : (cfg.vdFar ?? VD_FAR) * camDist;
    const invFar = 1 / farVd;
    const fadeAt = cfg.fadeAt || null;
    for (let i = 0; i < N; i++) {
      const vd = 1 / (invFar + (invNear - invFar) * sn[i]);
      const z = camDist - vd;
      // frustum half-width at this z, so the sheet fills the screen edge to
      // edge at every depth instead of tapering into a wedge
      const x = u[i] * halfW * (vd / camDist);
      const y = cfg.planeYAt(x, z) + rel[i];
      restY[i] = y;
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      // px = aSize * REF_DIST / viewDist (shaders/dots.js): authored CSS px at
      // this dot's own depth, shrinking a little into the haze of the horizon.
      // The far end stays just above the shader's 1.5-raster-px fade, or the
      // ridge line the crowding builds would be alpha'd away to nothing.
      let px = sz0[i] * (1 - sizeFar * (1 - sn[i])) * (vd / REF_DIST);
      // Optional per-dot coverage: where the substrate is only partly there
      // (the shelf's drop-off) the dot shrinks, and the shader's own
      // sub-1.5-raster-px fade (frame-graph rule 8) takes its alpha to zero on
      // the way. No second material, no per-dot alpha attribute, no blend
      // change — the ground simply dissolves.
      if (fadeAt) px *= fadeAt(x, z);
      aSize[i] = px;
    }
    posAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
  }

  // Ripple: two incommensurate traveling waves so the ceiling never repeats.
  // Only ever called while the layer is visible.
  function ripple(t) {
    const r = cfg.ripple;
    for (let i = 0; i < N; i++) {
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
 * Build the water column: the vertical world model, the camera's place in it,
 * the seabed + surface layers, and the navigation bindings.
 *
 * @param {THREE.Scene} scene
 * @param {object} globalUniforms  from shaders/dots.js createGlobalUniforms
 * @param {object} [opts]
 *   canvas      HTMLCanvasElement — wheel navigation binds here (optional;
 *               omit for a headless/model-only column)
 *   keyTarget   EventTarget for arrow/page keys (default: window). Keys are
 *               ignored while any input/textarea/contentEditable has focus,
 *               so the summon field always wins.
 *   width/height CSS viewport (default: window / 960x540)
 *   camDist     camera distance to the z=0 plane (default: derived from height)
 *   depth       initial depth in metres (default DEFAULT_DEPTH_M)
 *   seed        RNG seed for the two layers
 *   layers      false to skip the seabed/surface geometry entirely (spike
 *               scenes stay pixel-clean and emitter-free, like the plankton)
 *   nav         false to skip wheel/key bindings (model-only)
 *   onCamera    (worldY) => void, called whenever the camera's Y changes
 *   onDepth     (targetM, source) => void, called when the TARGET changes
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

  // ---- navigable range ---------------------------------------------------
  // Half the visible band at the z=0 plane, in metres. The vessel cannot push
  // the porthole above the waterline or below the floor.
  let halfBandM = 1; // recomputeRange() below is the real assignment
  let minM = 0;
  let maxM = SEABED_DEPTH_M;

  function recomputeRange() {
    halfBandM = (H / 2) * METRES_PER_PX;
    let lo = Math.min(SURFACE_STOP * halfBandM, MIN_DEPTH_CAP_M);
    let hi = SEABED_DEPTH_M - SEABED_STOP * halfBandM;
    if (hi < lo) {
      // pathological viewport taller than the whole column: park in the middle
      lo = hi = SEABED_DEPTH_M / 2;
    }
    minM = lo;
    maxM = hi;
  }
  recomputeRange();

  function clampNav(m) {
    return m < minM ? minM : m > maxM ? maxM : m;
  }

  // ---- listeners ---------------------------------------------------------
  const depthListeners = [];
  function emitDepth(source) {
    for (let i = 0; i < depthListeners.length; i++) depthListeners[i](targetM, source);
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
      if (opts.onCamera) opts.onCamera(camYCur);
    }
    if (changed || instant) emitDepth(options && options.source ? options.source : 'set');
    return targetM;
  }

  function nudge(dm, options) {
    return setDepth(targetM + (Number(dm) || 0), options);
  }

  // ---- layers ------------------------------------------------------------
  const baseSeed = (opts.seed ?? 0x0c010b3d) >>> 0;
  const wantLayers = opts.layers !== false;

  const seabed = wantLayers
    ? buildSheet(scene, globalUniforms, {
        count: opts.seabedCount ?? 760,
        seed: baseSeed ^ 0x5eab3d00,
        planeYAt: abyssalYAt, // v3.4's seabedYAt(x, z), now under its own name
        relLo: 0,
        relHi: 26, // a little loft: silt sitting proud of the floor
        sizeLo: 2.2,
        sizeHi: 3.8,
        // warm-neutral silt against the cool water, still near-monochrome
        color: [0.7, 0.74, 0.78],
        alpha: SEABED_ALPHA,
        twk: [0.9, 0.3], // barely-there — the floor is still, the water is not
        ripple: null,
      })
    : null;

  // The reef bench. Same builder, same one dot program; the differences are
  // all in the cfg and every one of them is doing a job:
  //   planeYAt/fadeAt  the shelf's own pure surface + its drop-off coverage, so
  //                    the dots and the substrate query are literally the same
  //                    function — a plant is never rooted in mid-water and
  //                    never buried in rock.
  //   farZ             the sheet ends where the SHELF ends (the toe of the
  //                    roll-over), not where the frustum ends.
  //   count 2400       three times the abyssal plain's, and it has to be. The
  //                    plain is read against 200 m of black water in every
  //                    direction, where a sparse scatter is unambiguous; the
  //                    bench is read against LIT water full of plankton,
  //                    sediment and caustics, and at that contrast a scatter is
  //                    just more snow. Only density makes it a surface.
  //   relHi 16          ~3 m of turf and rubble standing proud of the rock: the
  //                    bench has thickness, but a tight mat, not a cloud.
  //   sizeFar 0.5      the far grain is half the near grain — the texture
  //                    gradient that makes a stipple recede instead of hang.
  //   colour           unsaturated grey-green: algal turf and wet limestone
  //                    with the red already eaten by 37 m of water. Warmer than
  //                    the water, far duller than a creature.
  //   ripple null      rock is still. The abyssal plain is still for the same
  //                    reason; the shallows' dapple comes from the shader's own
  //                    twinkle, which costs nothing per frame.
  const shelf = wantLayers
    ? buildSheet(scene, globalUniforms, {
        count: opts.shelfCount ?? 2400,
        seed: baseSeed ^ 0x5e1f0b00,
        planeYAt: shelfYAt,
        fadeAt: shelfCoverAt,
        vdNear: SHELF_VD_NEAR,
        farZ: SHELF_TOE_Z,
        relLo: 0,
        relHi: 16,
        sizeLo: 3.0,
        sizeHi: 5.2,
        sizeFar: 0.5,
        color: [0.58, 0.62, 0.56],
        alpha: SHELF_ALPHA,
        twk: [1.15, 0.34],
        ripple: null, // rock is still; the dapple is the shader's twinkle
      })
    : null;

  const surface = wantLayers
    ? buildSheet(scene, globalUniforms, {
        count: opts.surfaceCount ?? 520,
        seed: baseSeed ^ 0x51f4ace0,
        planeYAt: () => SURFACE_Y,
        vdNear: SURFACE_VD_NEAR,
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

  if (seabed) seabed.rebuild(W, H, camDist);
  if (shelf) shelf.rebuild(W, H, camDist);
  if (surface) surface.rebuild(W, H, camDist);

  // The shelf's intensity is DRIVEN (by depth, every frame), so a caller's
  // setIntensity() has to survive being driven: it sets the base the driver
  // multiplies, not the uniform. `shelfApplied` is the last value actually
  // written, so the uniform is touched only when it moves.
  let shelfBase = 1;
  let shelfApplied = -1;

  // ---- geometry helpers --------------------------------------------------

  /** Frustum half-height in world px at a given z (the z=0 plane is 1:1 CSS). */
  function viewHalfPx(z) {
    return (H / 2) * (Math.max(camDist - (z || 0), 1) / camDist);
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

  /**
   * How far (world px) a point is OUTSIDE the visible band — 0 when visible.
   * Accounts for the frustum widening with depth, so a creature far behind the
   * z=0 plane is correctly still on screen.
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

  /**
   * The culling predicate the integrator wants:
   *   if (!column.inView(c.py, c.pz, c.rad, SIM_MARGIN)) continue;
   * Pass a margin (one screen height is a good default) so creatures just off
   * frame keep simulating and nothing pops when you arrive.
   */
  function inView(y, z, radiusPx, marginPx) {
    return outOfBandPx(y, z, radiusPx) <= (marginPx || 0);
  }

  // ---- per-frame ---------------------------------------------------------

  // Exact analytic step of a critically damped spring; unconditionally stable.
  function stepDepth(dt) {
    let x = curM - targetM;
    if (x === 0 && velM === 0) return;
    const e = Math.exp(-OMEGA * dt);
    const B = velM + OMEGA * x;
    const lin = x + B * dt;
    let nx = lin * e;
    let nv = (B - OMEGA * lin) * e;
    // Flank speed: the vessel has a maximum rate of ascent/descent, so a jump
    // across the whole column is a journey and not a smear. Velocity is handed
    // to the spring at exactly the cap, so the handover has no discontinuity.
    const move = nx - x;
    const maxMove = FLANK_MPS * dt;
    if (move > maxMove) {
      nx = x + maxMove;
      nv = FLANK_MPS;
    } else if (move < -maxMove) {
      nx = x - maxMove;
      nv = -FLANK_MPS;
    }
    if (Math.abs(nx) < SETTLE_M && Math.abs(nv) < SETTLE_V) {
      nx = 0;
      nv = 0;
    }
    curM = targetM + nx;
    velM = nv;
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
    stepDepth(d);
    camYCur = metresToWorldY(curM);
    if (camYCur !== camYPrev && opts.onCamera) opts.onCamera(camYCur);

    // The sheet's tallest reach on screen is at its far edge, where the
    // frustum half-height is VD_FAR x the half-height at the z=0 plane.
    const layerReach = (H / 2) * VD_FAR + LAYER_MARGIN_PX;
    if (seabed) {
      // Real perf win: the far layer is skipped whole when the porthole is
      // nowhere near it — no draw call, no buffer upload, no ripple loop.
      const vis = Math.abs(SEABED_Y - camYCur) <= layerReach + RIDGE_AMP;
      seabed.points.visible = vis;
      if (vis) seabed.setTime(simT);
    }
    if (shelf) {
      // Two gates, and they do different jobs. The geometric one is the same
      // band test the other sheets use (is the bench anywhere near the
      // porthole). The exposure one is the honest one: below ~92 m there is
      // simply too much water between you and a 37 m reef to see it, so the
      // layer is skipped WHOLE — no draw call, no ripple loop, no upload — and
      // every frame from the app's neutral depth downward costs exactly what it
      // cost in v3.4.
      const expo = shelfExposure(curM);
      const vis =
        expo > 0.004 &&
        Math.abs(SHELF_Y - camYCur) <= layerReach + SHELF_AMP + SHELF_FALL_PX;
      shelf.points.visible = vis;
      if (vis) {
        const want = shelfBase * expo;
        if (Math.abs(want - shelfApplied) > 1e-4) {
          shelf.setIntensity(want);
          shelfApplied = want;
        }
        shelf.setTime(simT);
      }
    }
    if (surface) {
      const vis = Math.abs(SURFACE_Y - camYCur) <= layerReach;
      surface.points.visible = vis;
      if (vis) {
        surface.ripple(simT);
        surface.setTime(simT);
      }
    }
  }

  // ---- camera ------------------------------------------------------------

  /**
   * Drop-in for the integrator's applyCamera(): place the camera on its yaw
   * arc at the column's current height, gazing horizontally.
   */
  function applyTo(camera, dist, yaw) {
    const d = dist != null ? dist : camDist;
    const a = yaw || 0;
    camera.position.set(Math.sin(a) * d, camYCur, Math.cos(a) * d);
    camera.lookAt(0, camYCur, 0);
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
    let px = e.deltaY;
    if (e.deltaMode === 1) px *= WHEEL_LINE_PX;
    else if (e.deltaMode === 2) px *= H;
    // wheel px -> world px of dive -> metres. Positive deltaY descends.
    nudge(px * WHEEL_GAIN * METRES_PER_PX, { source: 'wheel' });
  };

  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (typingInField()) return;
    const band = halfBandM * 2;
    switch (e.key) {
      case 'ArrowDown':
        nudge(KEY_STEP_M, { source: 'key' });
        break;
      case 'ArrowUp':
        nudge(-KEY_STEP_M, { source: 'key' });
        break;
      case 'PageDown':
        nudge(band * PAGE_FRAC, { source: 'key' });
        break;
      case 'PageUp':
        nudge(-band * PAGE_FRAC, { source: 'key' });
        break;
      case 'Home':
        setDepth(minM, { source: 'key' });
        break;
      case 'End':
        setDepth(maxM, { source: 'key' });
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const navOn = opts.nav !== false;
  if (navOn && canvas) canvas.addEventListener('wheel', onWheel, { passive: false });
  if (navOn && keyTarget) keyTarget.addEventListener('keydown', onKey);

  // ---- resize ------------------------------------------------------------

  function resize(w, h, dist) {
    W = Math.max(1, w);
    H = Math.max(1, h);
    camDist = dist != null ? dist : H / 2 / Math.tan((FOV * Math.PI) / 360);
    recomputeRange();
    // the navigable range moved under us — re-clamp both target and position
    targetM = clampNav(targetM);
    curM = clampNav(curM);
    camYCur = metresToWorldY(curM);
    camYPrev = camYCur;
    if (seabed) seabed.rebuild(W, H, camDist);
    if (shelf) shelf.rebuild(W, H, camDist);
    if (surface) surface.rebuild(W, H, camDist);
    if (opts.onCamera) opts.onCamera(camYCur);
  }

  // ---- boot depth --------------------------------------------------------
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
  };
  function range() {
    rangeOut.min = minM;
    rangeOut.max = maxM;
    rangeOut.surface = 0;
    rangeOut.seabed = SEABED_DEPTH_M;
    rangeOut.span = SEABED_DEPTH_M;
    return rangeOut; // shared object — read, don't retain
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
  };
  function info() {
    infoOut.depth = curM;
    infoOut.target = targetM;
    infoOut.rate = velM;
    infoOut.camY = camYCur;
    infoOut.deltaPx = camYCur - camYPrev;
    infoOut.zone = zoneAt(curM).id;
    infoOut.light = lightAt(curM);
    infoOut.seabedVisible = seabed ? seabed.points.visible : false;
    infoOut.surfaceVisible = surface ? surface.points.visible : false;
    infoOut.shelfVisible = shelf ? shelf.points.visible : false;
    infoOut.shelfExposure = shelf ? shelfExposure(curM) : 0;
    return infoOut; // shared object — read, don't retain
  }

  const api = {
    // ---- navigation ------------------------------------------------------
    setDepth, // setDepth(metres, { instant?: bool, source?: string }) -> clamped m
    nudge, // nudge(deltaMetres, opts?) — relative to the TARGET, so wheel accumulates
    depth: () => curM, // eased, live position (what the gauge needle reads)
    targetDepth: () => targetM, // commanded depth (what the URL hash stores)
    rate: () => velM, // m/s, signed (+ = descending) — a rate-of-dive readout
    range, // shared { min, max, surface, seabed, span } in metres
    onDepthChange(cb) {
      depthListeners.push(cb);
      return () => {
        const i = depthListeners.indexOf(cb);
        if (i >= 0) depthListeners.splice(i, 1);
      };
    },

    // ---- per-frame -------------------------------------------------------
    update, // update(dt, timeSec?) — injectable clock only
    resize, // resize(cssW, cssH, camDist?)

    // ---- the camera ------------------------------------------------------
    camY: () => camYCur, // world Y the camera should sit at THIS frame
    /** World px the camera travelled vertically last update — feed this to
     *  pipeline.render(dt, camDeltaPx) for frame-graph rule 4. */
    deltaPx: () => camYCur - camYPrev,
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

    // ---- the ground (v3.5) ----------------------------------------------
    // seabedYAt(x, z) is EXACTLY the v3.4 function — the abyssal plain. Pass a
    // third argument (metres below the surface) and it answers with whichever
    // substrate is actually there: the reef bench near the light, the plain
    // below it. depthbands.js adopts `seabedYAt` through setDepthUnits(), so
    // that adapter keeps working untouched and gains the shelf the moment it
    // starts forwarding a depth.
    seabedYAt,
    substrateAt, // (x, z, nearDepthM?, out?) -> { kind, y, depthM, coverage, shelf }
    substrateYAt, // (x, z, nearDepthM?) -> world Y
    abyssalYAt, // (x, z) -> the deep plain, unconditionally
    shelfYAt, // (x, z) -> the reef bench surface
    shelfCoverAt, // (x, z) -> 1 on the bench, 0 past the drop-off
    hasShelfAt, // (x, z, nearDepthM?, minCover?) -> bool
    SUBSTRATE_SHELF,
    SUBSTRATE_PLAIN,
    SHELF_Y,
    SHELF_DEPTH_M,
    SHELF_TOP_M,
    SHELF_BASE_M,
    SHELF_REACH_M,
    SHELF_TOE_Z,
    RIDGE_AMP,
    SHELF_AMP,

    // ---- culling ---------------------------------------------------------
    visibleBand, // visibleBand(cssH?) -> shared band object
    viewHalfPx, // viewHalfPx(z) -> frustum half-height in world px at that z
    inView, // inView(y, z?, radiusPx?, marginPx?) -> bool
    outOfBandPx, // outOfBandPx(y, z?, radiusPx?) -> px outside the band (0 = in)

    // ---- the scene layers -------------------------------------------------
    seabed, // { points, setIntensity, getIntensity, ... } or null
    shelf, // the reef bench — its intensity is depth-driven, see setIntensity
    surface,
    setIntensity(v) {
      if (seabed) seabed.setIntensity(v);
      if (surface) surface.setIntensity(v);
      // The shelf's uniform is written every frame from depth, so a caller sets
      // the BASE it is multiplied by; passing 0 still switches it off.
      if (shelf) {
        shelfBase = Math.min(Math.max(v, 0), 1);
        shelfApplied = -1;
      }
    },

    info, // shared telemetry object

    dispose() {
      if (navOn && canvas) canvas.removeEventListener('wheel', onWheel);
      if (navOn && keyTarget) keyTarget.removeEventListener('keydown', onKey);
      depthListeners.length = 0;
      if (seabed) seabed.dispose();
      if (shelf) shelf.dispose();
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

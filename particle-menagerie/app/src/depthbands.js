// Species depth bands — v3.7. The world is a CROSS-SHELF TRANSECT: 1200 m of
// water vertically, 36 km of seabed horizontally (shore -> inner shelf ->
// outer shelf -> shelf break at 200 m -> continental slope -> abyssal plain).
// Every creature has a natural home in BOTH axes, and this module is the
// ecology: where a species lives, how tightly it holds that station, and how it
// drifts and returns when something displaces it.
//
// v3.7 — THE SECOND AXIS, in one paragraph. A species' cross-shelf home comes
// from the researched `shoreZone` list on its band (intertidal / nearshore /
// shelf / shelfbreak / slope / oceanic / abyssal), mapped onto the transect by
// SHORE_ZONE_SPANS below. That span is then INTERSECTED with the hard physical
// constraint that nothing can be where the water is not deep enough for it:
// a lanternfish at 400 m cannot be over 40 m of shelf, and a barnacle at 1 m
// cannot be over the abyssal plain. For anything living ON the bottom the two
// axes are the SAME FACT — a mussel is intertidal because the seabed is 2 m
// deep there — so the profile's isobath decides its transect and its depth
// together. Determinism is unchanged: the transect is drawn from the same
// salted stream as the depth, at an APPENDED round index (geometry-spec 8).
//
// THE ONE THING TO UNDERSTAND: everything here is authored in METRES BELOW THE
// SURFACE, positive down (0 = surface, 1200 = seabed). Metres are the shared
// language of the column — the gauge reads metres, the user thinks in metres,
// and metres are invariant to whatever metres-per-world-px scale the column
// module settles on. This file therefore NEVER hardcodes a px scale: world-Y
// conversion goes through the units adapter below, which the integrator points
// at the column module once at boot (see setDepthUnits). Bands, preference
// curves and pickDepth are all pure metre math and need no units at all.
//
// WHAT THE INTEGRATOR CALLS
//   setDepthUnits(column)                  once at boot (or nothing — see below)
//   bandFor(nameOrArch)         -> band    the species' home band
//   pickDepth(band, seed, i)    -> metres  deterministic: same seed, same depth
//   placeDepth({...})           -> record  full placement (metres + world Y)
//   attachDepth(creature, ...)             stamps home/band/phases on a creature
//   steerDepth(creature, t, dt)            per-frame station keeping (mutates py)
//   targetDepthFor(creature, t) -> metres  if you'd rather steer it yourself
//
// CONTRACTS
//   * Determinism (geometry-spec 8). Depth is drawn from its OWN mulberry32
//     stream, salted off the creature's seed — it never touches the geometry
//     RNG and never perturbs the frozen draw order in geometry/ or in the
//     board's placement prng. Same URL hash -> same names -> same seeds -> same
//     depths, on every machine.
//   * No per-frame allocation. targetDepthFor / steerDepth / preferenceAt
//     return numbers and allocate nothing. Only the spawn-path helpers
//     (pickDepth, placeDepth) allocate, once per creature.
//   * Injectable clock only. Nothing here reads a wall clock; every time value
//     arrives as an argument.
//   * Rooted flora CANNOT float (hard rule). Every rooted archetype and every
//     rooted species resolves to the seabed band, and placeDepth plants it on
//     the actual local floor — no override, no exception.

// v3.5: researched bands. Plain JSON (vite inlines it, so the build stays a
// single offline file) and no three.js in the path, so this module is still
// node-importable for the harness and the geometry benches.
import OCEAN from './data/ocean-data.json' with { type: 'json' };

const DATA_BANDS = (OCEAN && OCEAN.bands) || {};

// ---------------------------------------------------------------------------
// Units adapter — the ONE place this module touches world px
// ---------------------------------------------------------------------------
//
// The column module owns the metres <-> world-px scale and the seabed relief.
// This module deliberately does not import it: bands are metre-space data and
// stay correct whatever that scale turns out to be, and staying import-free
// keeps lexicon.js / creatures.js node-importable with no three.js in the tree.
//
// Wiring, in order of preference:
//   1. main.js calls setDepthUnits(column) right after createColumn(...).
//   2. Otherwise the first call that needs units auto-adopts
//      globalThis.__menagerie.column (the column module registers itself
//      there), so the browser path works even if step 1 is forgotten.
//   3. Otherwise the provisional fallback below is used. It is NOT a second
//      source of truth — it exists so node tests and headless imports (this
//      module is imported by lexicon.js, which must stay three.js-free and
//      node-importable) don't explode, and it is overwritten the moment (1) or
//      (2) happens.

// Mirrors column.js's 1 / METRES_PER_PX (0.2 m/px -> 5 px/m) so an un-wired
// import still lands in the right place. The adapter overwrites it; if the
// column's scale ever changes, THIS number is stale but harmless — every band
// is metre-space and every conversion goes through the adapter.
const FALLBACK_PX_PER_METRE = 5; // provisional only — see above
/** Nominal depth of the seabed in metres. Both column modules agree on 1200;
 *  setDepthUnits adopts the real value so a change there follows through. */
export const SEABED_DEPTH_M = 1200;

// ---- v3.7: the horizontal mirror of the same fallback ---------------------
//
// column.js owns the bathymetric profile; setDepthUnits adopts it. These
// constants are a COARSE MIRROR of column.js's PROFILE_KEYS, monotone and
// piecewise-linear rather than PCHIP, and they exist for exactly the reason
// FALLBACK_PX_PER_METRE does: lexicon.js imports this module and must stay
// three.js-free and node-importable, so an unwired import has to answer
// *something* sane instead of throwing. In the app they are never used — the
// column overwrites all four functions at boot. column.js is the source of
// truth; if the profile there changes, THIS is stale but harmless.
const FALLBACK_TRANSECT_M = 36000;
const FALLBACK_PX_PER_TRANSECT_M = 0.5;
const FALLBACK_SHORE_X = -FALLBACK_TRANSECT_M * FALLBACK_PX_PER_TRANSECT_M;
const FALLBACK_PROFILE = [
  [0, 0], [500, 5], [2500, 18], [7000, 40], [13000, 85], [18000, 200],
  [20000, 430], [23000, 800], [26000, 1120], [28000, 1200], [36000, 1200],
];

function fbDepthAt(s) {
  if (!(s > 0)) return 0;
  const K = FALLBACK_PROFILE;
  if (s >= K[K.length - 1][0]) return K[K.length - 1][1];
  let i = 0;
  while (i < K.length - 2 && K[i + 1][0] < s) i++;
  const t = (s - K[i][0]) / (K[i + 1][0] - K[i][0]);
  return K[i][1] + (K[i + 1][1] - K[i][1]) * t;
}

function fbTransectAt(m) {
  const K = FALLBACK_PROFILE;
  if (!(m > 0)) return 0;
  if (m >= K[K.length - 1][1]) return 28000;
  let i = 0;
  while (i < K.length - 2 && K[i + 1][1] < m) i++;
  const dd = K[i + 1][1] - K[i][1];
  const t = dd <= 0 ? 0 : (m - K[i][1]) / dd;
  return K[i][0] + (K[i + 1][0] - K[i][0]) * t;
}

const units = {
  configured: false,
  pxPerMetre: FALLBACK_PX_PER_METRE,
  seabedDepthM: SEABED_DEPTH_M,
  // metres below surface (positive) -> world Y
  yOf: (m) => -m * FALLBACK_PX_PER_METRE,
  // world Y -> metres below surface (positive)
  depthOf: (y) => -y / FALLBACK_PX_PER_METRE,
  // local floor Y under a world (x, z) — flat until the column supplies relief
  floorYAt: null,
  // ---- v3.7, the transect ------------------------------------------------
  transectM: FALLBACK_TRANSECT_M,
  // seabed depth (m below the surface) at a transect position (m offshore)
  profileDepthAt: fbDepthAt,
  // the isobath: transect position at which the seabed first reaches a depth
  transectAtDepth: fbTransectAt,
  // transect metres offshore -> world X, and back
  xOf: (m) => FALLBACK_SHORE_X + m * FALLBACK_PX_PER_TRANSECT_M,
  transectOf: (x) => (x - FALLBACK_SHORE_X) / FALLBACK_PX_PER_TRANSECT_M,
};

/**
 * Point this module at the column module's units. Accepts, in this order:
 *   * a column.js-shaped source: { metresToWorldY, worldYToMetres, seabedYAt,
 *     SEABED_DEPTH_M | seabedDepthM, PX_PER_METRE } — depth POSITIVE down.
 *   * a depthprofile.js-shaped module namespace: { yOfDepth, depthOfY,
 *     SEABED_M, PX_PER_METRE } — depth NEGATIVE down; the sign is normalised
 *     here so callers of this module always speak positive metres.
 *   * an explicit override: { pxPerMetre, seabedDepthM, floorYAt? }.
 * Returns the live units record (read-only by convention).
 */
export function setDepthUnits(src) {
  if (!src) return units;
  if (typeof src.metresToWorldY === 'function') {
    // column.js: positive-down metres, same convention as this module
    const toY = src.metresToWorldY;
    const toM = src.worldYToMetres;
    units.yOf = (m) => toY(m);
    units.depthOf = typeof toM === 'function' ? (y) => toM(y) : (y) => -y / units.pxPerMetre;
    units.pxPerMetre = src.PX_PER_METRE ?? src.pxPerMetre ?? Math.abs(toY(1) - toY(0)) ?? FALLBACK_PX_PER_METRE;
    units.seabedDepthM = src.SEABED_DEPTH_M ?? src.seabedDepthM ?? SEABED_DEPTH_M;
    units.floorYAt = typeof src.seabedYAt === 'function' ? src.seabedYAt : null;
  } else if (typeof src.yOfDepth === 'function') {
    // depthprofile.js: negative-down metres — flip at the boundary
    const toY = src.yOfDepth;
    const toM = src.depthOfY;
    units.yOf = (m) => toY(-m);
    units.depthOf = typeof toM === 'function' ? (y) => -toM(y) : (y) => -y / units.pxPerMetre;
    units.pxPerMetre = src.PX_PER_METRE ?? Math.abs(toY(-1) - toY(0)) ?? FALLBACK_PX_PER_METRE;
    units.seabedDepthM = src.SEABED_M != null ? Math.abs(src.SEABED_M) : SEABED_DEPTH_M;
    units.floorYAt = typeof src.seabedYAt === 'function' ? src.seabedYAt : null;
  } else if (Number.isFinite(src.pxPerMetre)) {
    const k = src.pxPerMetre;
    units.pxPerMetre = k;
    units.yOf = (m) => -m * k;
    units.depthOf = (y) => -y / k;
    units.seabedDepthM = src.seabedDepthM ?? SEABED_DEPTH_M;
    units.floorYAt = typeof src.floorYAt === 'function' ? src.floorYAt : null;
  } else {
    return units;
  }
  if (typeof src.seabedYAt === 'function') units.floorYAt = src.seabedYAt;
  // v3.7 — the transect. All four are adopted together or not at all: half a
  // profile (a real depthAt with a fallback inverse, say) would put creatures
  // at isobaths that do not exist on the curve they are drawn against.
  if (
    typeof src.profileDepthAt === 'function' &&
    typeof src.transectAtDepth === 'function' &&
    typeof src.transectToWorldX === 'function' &&
    typeof src.worldXToTransect === 'function'
  ) {
    units.profileDepthAt = src.profileDepthAt;
    units.transectAtDepth = src.transectAtDepth;
    units.xOf = src.transectToWorldX;
    units.transectOf = src.worldXToTransect;
    units.transectM = src.TRANSECT_M ?? src.transectM ?? FALLBACK_TRANSECT_M;
  }
  units.configured = true;
  return units;
}

function ensureUnits() {
  if (units.configured) return units;
  // auto-adopt the column module if it has registered itself (browser path)
  const g = typeof globalThis !== 'undefined' ? globalThis : null;
  const col = g && g.__menagerie ? g.__menagerie.column : null;
  if (col) setDepthUnits(col);
  return units;
}

/** The live units record: { pxPerMetre, seabedDepthM, configured, ... }. */
export function depthUnits() {
  return ensureUnits();
}

/** Metres below the surface (positive) -> world Y. */
export function worldYForDepth(m) {
  return ensureUnits().yOf(m);
}

/** World Y -> metres below the surface (positive). */
export function depthForWorldY(y) {
  return ensureUnits().depthOf(y);
}

/** Nominal seabed depth in metres (the column's value once units are wired). */
export function floorDepthM() {
  return ensureUnits().seabedDepthM;
}

/** World Y of the floor under (x, z) — the column's relief if it supplied one,
 *  otherwise the flat nominal seabed plane. */
export function floorYAt(x, z, nearDepthM) {
  const u = ensureUnits();
  // v3.5: nearDepthM reaches the continental shelf (column.js seabedYAt's
  // optional third argument). Without it every rooted thing lands on the
  // abyssal plain — which is how kelp ended up in the dark.
  return u.floorYAt ? u.floorYAt(x || 0, z || 0, nearDepthM) : u.yOf(u.seabedDepthM);
}

/** World px per metre — for anything that needs to size a vertical motion. */
export function pxPerMetre() {
  return ensureUnits().pxPerMetre;
}

// ---------------------------------------------------------------------------
// The transect adapter (v3.7) — the same contract, sideways
// ---------------------------------------------------------------------------

/** Length of the transect, metres offshore, 0 at the shoreline. */
export function transectLengthM() {
  return ensureUnits().transectM;
}

/** Mean seabed depth (metres below the surface) at a transect position. */
export function floorDepthAt(transectM) {
  return ensureUnits().profileDepthAt(transectM);
}

/** THE ISOBATH: metres offshore at which the seabed first reaches a depth. */
export function transectAtDepthM(depthM) {
  return ensureUnits().transectAtDepth(depthM);
}

/** Transect metres offshore -> world X. */
export function worldXForTransect(m) {
  return ensureUnits().xOf(m);
}

/** World X -> transect metres offshore. */
export function transectForWorldX(x) {
  return ensureUnits().transectOf(x);
}

/** Mean seabed depth under a world X — floorDepthAt(transectForWorldX(x)). */
export function floorDepthAtX(x) {
  const u = ensureUnits();
  return u.profileDepthAt(u.transectOf(x || 0));
}

// ---------------------------------------------------------------------------
// The band record
// ---------------------------------------------------------------------------
//
//   kind      'pelagic'  depth measured from the surface
//             'benthic'  lives ON the floor but is not rooted (starfish, crab,
//                        flounder): depth follows the local seabed relief
//             'rooted'   planted in the seabed — flora, non-negotiable
//   minM/maxM hard range in metres below the surface (the creature is steered
//             back inside if displaced past it)
//   preferM   the mode of the preference curve — where the species actually
//             wants to be
//   tight     0..1, how tightly pickDepth concentrates about preferM
//             (1 = the whole band is fair game, 0.2 = it hugs preferM)
//   hold      1/s station-keeping rate: how hard it swims back to its band
//             after gather, a control, or its own wandering carries it off
//   wanderM   amplitude of the slow vertical wander, in metres
//   wanderHz  base rate of that wander (two incommensurate sines ride on it)
//   hoverM    benthic/rooted only: metres above the local floor
//   hoverVarM benthic only: +/- spread on hoverM
//   note      one line for the gauge / labels ("hunts the twilight")

const PELAGIC_DEFAULTS = {
  kind: 'pelagic',
  tight: 0.8,
  hold: 0.4,
  wanderM: 16,
  wanderHz: 0.03,
  hoverM: 0,
  hoverVarM: 0,
  note: '',
};

const BENTHIC_DEFAULTS = {
  kind: 'benthic',
  tight: 0.5,
  hold: 0.9,
  wanderM: 1.5,
  wanderHz: 0.02,
  hoverM: 2.2,
  hoverVarM: 1.6,
  note: 'rests on the abyssal plain',
};

const ROOTED_DEFAULTS = {
  kind: 'rooted',
  tight: 0.5,
  hold: 3.0, // it does not move; the rate exists only so steering is a no-op nudge
  wanderM: 0,
  wanderHz: 0,
  hoverM: 0,
  hoverVarM: 0,
  note: 'rooted in the seabed',
};

function pelagic(key, minM, maxM, preferM, over) {
  return Object.freeze({
    ...PELAGIC_DEFAULTS,
    key,
    minM,
    maxM,
    preferM: Math.min(Math.max(preferM, minM), maxM),
    ...over,
  });
}

function benthic(key, over) {
  const floor = SEABED_DEPTH_M;
  return Object.freeze({
    ...BENTHIC_DEFAULTS,
    key,
    minM: floor - 40,
    maxM: floor,
    preferM: floor - (over && over.hoverM != null ? over.hoverM : BENTHIC_DEFAULTS.hoverM),
    ...over,
  });
}

function rooted(key, over) {
  const floor = SEABED_DEPTH_M;
  return Object.freeze({
    ...ROOTED_DEFAULTS,
    key,
    minM: floor,
    maxM: floor,
    preferM: floor,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// THE HORIZONTAL BAND (v3.7)
// ---------------------------------------------------------------------------
//
// A researched species carries `shoreZones` on its band: the cross-shelf
// stretches the sources place it in. These are the transect spans those words
// mean, in METRES OFFSHORE — unit-free data, exactly like the depth bands, so
// the draw is pure metre math and needs no world px at all.
//
// The boundaries mirror column.js's SHORE_ZONES (0 / 600 / 7500 / 16800 /
// 19400 / 27500 / 36000) with two deliberate differences, because the research
// vocabulary is ecological and the column's is topographic:
//   * `nearshore` and `shelf` OVERLAP. "Nearshore" is a coastal band that runs
//     out onto the inner shelf; "shelf" as a habitat word starts well inside
//     the inner shelf. Species carry both when they span the two.
//   * `oceanic` is not a place on the seabed at all — it means "off the shelf,
//     in open water", so it starts at the break and runs to the far end.
// `preferM` is the mode of the draw when this is the species' FIRST-listed
// zone (the research lists the primary habitat first).
export const SHORE_ZONE_SPANS = Object.freeze({
  intertidal: Object.freeze({ fromM: 0, toM: 600, preferM: 200 }),
  nearshore: Object.freeze({ fromM: 150, toM: 4000, preferM: 1500 }),
  shelf: Object.freeze({ fromM: 2500, toM: 16800, preferM: 9000 }),
  shelfbreak: Object.freeze({ fromM: 15500, toM: 20500, preferM: 18000 }),
  slope: Object.freeze({ fromM: 19400, toM: 27500, preferM: 23000 }),
  oceanic: Object.freeze({ fromM: 18000, toM: 36000, preferM: 29000 }),
  abyssal: Object.freeze({ fromM: 27500, toM: 36000, preferM: 32000 }),
});

// A swimmer needs water UNDER it, not just water at its depth: it is placed no
// further inshore than the isobath of (its depth x this + this many metres), so
// nothing is ever drawn scraping the bottom it does not live on.
const SWIM_CLEARANCE = 1.15;
const SWIM_CLEARANCE_M = 4;

// The narrowest transect span a band may occupy. Over the abyssal plain the
// profile is FLAT, so a depth range maps to a single point and a batch of five
// would stack in one spot; over the intertidal a 4 m range is 400 m of beach.
// 1500 m of transect is 750 world px — a screen and a half — which is enough
// spread for a school and small enough that a species still reads as local.
const MIN_TRANSECT_SPREAD_M = 1500;

// Where a species with NO researched zones is placed. It is a heuristic and it
// is labelled one: BOTH ends are physical limits derived from the band's own
// depths, and the mode sits at this fraction of the way between them — biased
// inshore, because that is where the shelf, the light and the productivity are.
const NO_ZONE_MODE_FRAC = 0.35;

// ...and the offshore end of that heuristic (v3.7 fix). The inshore end has
// always been the isobath the individual's own depth needs; the offshore end
// used to be the far end of the transect, which is not a limit at all — so a
// clownfish whose whole sourced range is 3-15 m was drawn in open water 27 km
// out over 1200 m of abyssal plain, and 37-42% of every unzoned reef species
// sat past the shelf break. The offshore limit is the mirror of the inshore
// one: an animal is not placed over water more than this many times deeper
// than the deepest water it is known to use. A band that reaches the seabed
// has no offshore limit (an anglerfish belongs over the plain) and keeps the
// whole transect.
//
// This is a placement heuristic and stays one — it applies ONLY where the
// research recorded no shoreZone. A species with a zone list is placed by that
// list, unchanged, because the sources beat the arithmetic.
const NO_ZONE_DEEP_WATER_FACTOR = 3.0;

// The floor under that limit. A shallow unzoned species must still be allowed
// to reach the edge of the shelf — the shelf IS the default habitat and the
// break is its seaward end — so the offshore limit is never inshore of the
// break, whatever the band's own depths are. This is also what keeps the two
// obligate surface floaters (man o' war, sargassum: maxM exactly 0, so their
// isobath is the shoreline) in open water instead of pinned to the beach.
const SHELF_BREAK_DEPTH_M = 200;

// How far the members of one batch scatter either side of the batch's own
// place on the transect: 900 m = 450 world px, half a screen at 960 CSS px.
// Wide enough that five fish are five fish, tight enough that they are inside
// each other's schooling radius (560 px) and inside one gather beacon.
const GROUP_SPREAD_M = 900;

const TRANGE = { inshoreM: 0, offshoreM: 0, preferM: 0, spanM: 0, zoned: false };

/**
 * The transect span (metres offshore) this band may occupy, written into a
 * caller-owned record or a shared one.
 *
 * @param {object} band     a band record
 * @param {number} [depthM] the INDIVIDUAL's depth — a pelagic creature's
 *        inshore limit is its own isobath, not the band's. Defaults to
 *        band.preferM. Ignored for floor dwellers, whose depth IS their
 *        transect.
 * @param {object} [out]    a record to fill (shared one otherwise)
 * @returns {{inshoreM, offshoreM, preferM, spanM, zoned}} — SHARED unless
 *        `out` is given: read it, don't retain it.
 */
export function transectRangeFor(band, depthM, out) {
  const rec = out || TRANGE;
  const b = band || DEFAULT_BAND;
  const seabed = floorDepthM();
  const far = transectLengthM();

  // 1. the zone envelope, if the species has one
  let zLo = 0;
  let zHi = far;
  let zPrefer = -1;
  const zones = b.shoreZones;
  if (zones && zones.length) {
    zLo = Infinity;
    zHi = -Infinity;
    for (let i = 0; i < zones.length; i++) {
      const s = SHORE_ZONE_SPANS[zones[i]];
      if (!s) continue;
      if (s.fromM < zLo) zLo = s.fromM;
      if (s.toM > zHi) zHi = s.toM;
      if (zPrefer < 0) zPrefer = s.preferM; // the first zone listed is the home
    }
    if (!Number.isFinite(zLo) || !Number.isFinite(zHi) || zHi <= zLo) {
      zLo = 0;
      zHi = far;
      zPrefer = -1;
    }
  }
  const zoned = zPrefer >= 0;

  let lo;
  let hi;
  let prefer;
  if (b.kind === 'rooted' || b.kind === 'benthic') {
    // A floor dweller's depth and its transect are the SAME FACT. The band's
    // depth range is an isobath range; the zone list only narrows it.
    lo = transectAtDepthM(b.minM);
    hi = b.maxM >= seabed - 1 ? far : transectAtDepthM(b.maxM);
    if (zoned) {
      const iLo = Math.max(lo, zLo);
      const iHi = Math.min(hi, zHi);
      if (iHi > iLo) {
        lo = iLo;
        hi = iHi;
      }
      // an empty intersection means the sources' zone word and the sources'
      // depth range disagree. The profile is not arguable: depth wins, and
      // the zone is dropped rather than averaged into a compromise.
    }
    prefer = transectAtDepthM(b.preferM);
  } else {
    const m = depthM == null ? b.preferM : depthM;
    const need = m * SWIM_CLEARANCE + SWIM_CLEARANCE_M;
    const floorLimit = need >= seabed ? transectAtDepthM(seabed) : transectAtDepthM(need);
    lo = Math.max(zLo, floorLimit);
    if (zoned) {
      hi = Math.max(zHi, lo);
    } else {
      // the offshore mirror of floorLimit — see NO_ZONE_DEEP_WATER_FACTOR
      const deepest = Math.max(b.maxM, 0) * NO_ZONE_DEEP_WATER_FACTOR;
      const cap = deepest >= seabed
        ? far
        : Math.max(transectAtDepthM(deepest), transectAtDepthM(SHELF_BREAK_DEPTH_M));
      hi = Math.max(Math.min(cap, far), lo);
    }
    prefer = zoned ? zPrefer : lo + (hi - lo) * NO_ZONE_MODE_FRAC;
  }

  // 2. a minimum spread, so a batch never stacks on a flat floor
  if (hi - lo < MIN_TRANSECT_SPREAD_M) {
    const mid = (lo + hi) * 0.5;
    lo = mid - MIN_TRANSECT_SPREAD_M * 0.5;
    hi = mid + MIN_TRANSECT_SPREAD_M * 0.5;
    if (zoned) {
      // the widening may leave the zone; slide it back rather than clip it to
      // nothing, so the span keeps its width and its zone at the same time
      if (lo < zLo && zHi - zLo >= MIN_TRANSECT_SPREAD_M) {
        hi += zLo - lo;
        lo = zLo;
      }
      if (hi > zHi && zHi - zLo >= MIN_TRANSECT_SPREAD_M) {
        lo -= hi - zHi;
        hi = zHi;
      }
    }
  }
  if (lo < 0) {
    hi -= lo;
    lo = 0;
  }
  if (hi > far) {
    lo -= hi - far;
    hi = far;
  }
  if (lo < 0) lo = 0;
  if (hi < lo) hi = lo;

  rec.inshoreM = lo;
  rec.offshoreM = hi;
  rec.spanM = hi - lo;
  rec.preferM = Math.min(Math.max(prefer, lo), hi);
  rec.zoned = zoned;
  return rec;
}

/**
 * Where along the transect this individual lives, in metres offshore.
 * Deterministic in (band, seed, instance) from the SAME salted stream as the
 * depth, at round 3 — appended after depth (0) and the two wander phases
 * (1, 2), so geometry-spec 8's frozen draw order is untouched and a v3.6 URL
 * still reproduces every v3.6 depth exactly.
 */
export function pickTransect(band, seed, instance, depthM) {
  const b = typeof band === 'string' ? bandFor(band) : band || DEFAULT_BAND;
  // 1. THE SPECIES' PLACE. Drawn against the band's own range — the one at its
  //    preferred depth — so every member of a batch resolves the same stretch
  //    of ocean and the draw is batch-invariant.
  transectRangeFor(b, null, TRANGE);
  if (TRANGE.spanM <= 0) return TRANGE.inshoreM;
  const p = (TRANGE.preferM - TRANGE.inshoreM) / TRANGE.spanM;
  let m = TRANGE.inshoreM + TRANGE.spanM * triangular(depthRandom(seed, 0, 3), p);
  // 2. THE INDIVIDUAL'S PLACE IN THE GROUP. A batch is ONE group: siblings
  //    scatter within half a screen of it. Drawing each member independently —
  //    which is what the DEPTH axis does, and rightly, since a school is a
  //    vertical column of fish in one patch of ocean — would spread "a school
  //    of fish" over twenty kilometres of shelf, where they could neither
  //    school, hear one summons, nor be seen together.
  const i = instance | 0;
  if (i > 0) m += (depthRandom(seed, i, 4) * 2 - 1) * GROUP_SPREAD_M;
  // 3. ...and then the individual's own physical limit. A member that drew a
  //    deeper station than the species' mode cannot stand as far inshore: the
  //    water there is not deep enough for it. Depth narrows the range; it never
  //    relocates the group.
  if (depthM != null) transectRangeFor(b, depthM, TRANGE);
  if (m < TRANGE.inshoreM) m = TRANGE.inshoreM;
  else if (m > TRANGE.offshoreM) m = TRANGE.offshoreM;
  return m;
}

/** "12.4 km offshore · continental slope" for an instrument, or null when the
 *  band has no researched cross-shelf home. */
export function describeTransect(band) {
  const b = band || DEFAULT_BAND;
  if (!b.shoreZones || !b.shoreZones.length) return null;
  return b.shoreZones.join(' / ');
}

// ---------------------------------------------------------------------------
// Archetype bands — the default home for anything the species table misses
// ---------------------------------------------------------------------------

export const ARCH_BANDS = Object.freeze({
  // quick, muscular bodies working the lit water and the top of the twilight
  fish: pelagic('fish', 4, 320, 70, { hold: 0.5, wanderM: 14, note: 'works the lit water' }),
  // long bodies coil through the whole mid-column
  eel: pelagic('eel', 25, 520, 160, { hold: 0.3, wanderM: 24, wanderHz: 0.024, note: 'coils through the mid-water' }),
  // planing bodies glide the shelf water
  ray: pelagic('ray', 15, 420, 110, { hold: 0.35, wanderM: 20, note: 'planes the shelf water' }),
  // bells have almost no station-keeping: they go where the water goes
  medusa: pelagic('medusa', 50, 560, 220, {
    tight: 0.9, hold: 0.12, wanderM: 42, wanderHz: 0.018, note: 'pulses in the twilight',
  }),
  // cephalopods hold the deep twilight, hunting up and down at dusk
  octo: pelagic('octo', 180, 820, 430, { hold: 0.25, wanderM: 30, wanderHz: 0.022, note: 'hunts the deep twilight' }),
  // v3.7 — marine tetrapods: air-breathers, so the band is pinned at the
  // ceiling and the hold is hard, exactly like the cetaceans. This is only the
  // FALLBACK: every word in LEX.tetrapod has a researched species band, and
  // those carry the cross-shelf zones this one deliberately does not (an
  // authored band may not invent a habitat statement — it is not a citation).
  tetrapod: pelagic('tetrapod', 0, 130, 22, {
    tight: 0.6, hold: 0.85, wanderM: 14, wanderHz: 0.045, note: 'must reach air',
  }),
  // echinoderms are floor animals, full stop
  star: benthic('star'),
  // formless things hang in the mid-water like smoke
  amorph: pelagic('amorph', 80, 720, 300, {
    tight: 0.95, hold: 0.1, wanderM: 48, wanderHz: 0.014, note: 'hangs in the mid-water',
  }),
  // flora: planted, always
  bloom: rooted('bloom'),
  kelp: rooted('kelp'),
});

/** Anything unrecognised: a mid-water drifter, comfortably inside the column. */
export const DEFAULT_BAND = pelagic('default', 40, 460, 170, { note: 'drifts the mid-water' });

// ---------------------------------------------------------------------------
// Species bands — the ecology proper
// ---------------------------------------------------------------------------
// Keys are lexicon words and morph keys (lexicon.js LEX + FISH_MORPHS /
// KELP_MORPHS / BLOOM_MORPHS), singular; bandFor() also tries the singular of
// a plural and each word of a multi-word name, so "three red jellyfish"
// resolves through "jellyfish".

export const SPECIES_BANDS = Object.freeze({
  // ---- the surface: air-breathers and the sunlit shoals -------------------
  // Cetaceans must reach air, so their bands are pinned near the ceiling and
  // they hold station hard — a dolphin that wanders to 400 m has drowned.
  dolphin: pelagic('dolphin', 1, 110, 22, { tight: 0.55, hold: 0.85, wanderM: 12, wanderHz: 0.05, note: 'must reach air' }),
  porpoise: pelagic('porpoise', 1, 80, 16, { tight: 0.5, hold: 0.9, wanderM: 10, wanderHz: 0.06, note: 'must reach air' }),
  orca: pelagic('orca', 1, 160, 30, { tight: 0.6, hold: 0.8, wanderM: 16, wanderHz: 0.04, note: 'must reach air' }),
  beluga: pelagic('beluga', 2, 220, 45, { tight: 0.6, hold: 0.75, wanderM: 18, note: 'must reach air' }),
  humpback: pelagic('humpback', 3, 260, 50, { tight: 0.6, hold: 0.7, wanderM: 22, wanderHz: 0.022, note: 'must reach air' }),
  narwhal: pelagic('narwhal', 5, 420, 95, { tight: 0.7, hold: 0.6, wanderM: 28, wanderHz: 0.02, note: 'dives the twilight, breathes above' }),
  // the great whale lives upper-mid and dives — a wide band, a soft hold
  whale: pelagic('whale', 8, 540, 130, { tight: 0.85, hold: 0.5, wanderM: 46, wanderHz: 0.016, note: 'upper water, deep dives' }),

  // Fast epipelagic hunters.
  tuna: pelagic('tuna', 3, 190, 45, { hold: 0.6, wanderM: 18, wanderHz: 0.045, note: 'runs the sunlit water' }),
  marlin: pelagic('marlin', 2, 240, 55, { hold: 0.6, wanderM: 20, wanderHz: 0.04 }),
  swordfish: pelagic('swordfish', 5, 520, 120, { tight: 0.9, hold: 0.5, wanderM: 34, note: 'sunlit by night, twilight by day' }),
  shark: pelagic('shark', 3, 280, 60, { hold: 0.55, wanderM: 22 }),
  barracuda: pelagic('barracuda', 2, 110, 25, { hold: 0.6 }),
  mackerel: pelagic('mackerel', 3, 130, 30, { hold: 0.55 }),
  herring: pelagic('herring', 4, 160, 40, { hold: 0.5 }),
  sardine: pelagic('sardine', 3, 120, 30, { hold: 0.55 }),
  salmon: pelagic('salmon', 1, 140, 30, { hold: 0.6 }),
  trout: pelagic('trout', 0.5, 60, 12, { hold: 0.6 }),
  perch: pelagic('perch', 1, 45, 10),
  pike: pelagic('pike', 0.5, 30, 8),
  bass: pelagic('bass', 2, 90, 20),
  carp: pelagic('carp', 0.5, 25, 6),
  koi: pelagic('koi', 0.3, 14, 3, { tight: 0.5, note: 'a pond fish, near the light' }),
  goldfish: pelagic('goldfish', 0.3, 16, 4, { tight: 0.5, note: 'a pond fish, near the light' }),
  guppy: pelagic('guppy', 0.3, 12, 3, { tight: 0.5 }),
  betta: pelagic('betta', 0.3, 12, 3, { tight: 0.5 }),
  tetra: pelagic('tetra', 0.5, 20, 5, { tight: 0.6 }),
  piranha: pelagic('piranha', 0.5, 22, 6, { tight: 0.6 }),
  // the little flying-fish-alikes: right under the shimmer, quick and skittish
  minnow: pelagic('minnow', 0.5, 40, 8, { tight: 0.5, hold: 0.7, wanderM: 6, wanderHz: 0.08, note: 'skitters under the shimmer' }),
  clownfish: pelagic('clownfish', 1, 32, 10, { tight: 0.5, hold: 0.7, note: 'reef water' }),
  angelfish: pelagic('angelfish', 2, 55, 16, { tight: 0.6, hold: 0.6, note: 'reef water' }),
  lionfish: pelagic('lionfish', 2, 70, 20, { tight: 0.6, hold: 0.6, note: 'reef water' }),
  wrasse: pelagic('wrasse', 1, 60, 15, { tight: 0.6, hold: 0.6, note: 'reef water' }),
  pufferfish: pelagic('pufferfish', 1, 65, 16, { tight: 0.6 }),
  puffer: pelagic('puffer', 1, 65, 16, { tight: 0.6 }),
  snapper: pelagic('snapper', 5, 160, 45),
  grouper: pelagic('grouper', 8, 200, 60, { hold: 0.5 }),
  // mola: the sunbather that commutes to the twilight
  sunfish: pelagic('sunfish', 2, 480, 160, { tight: 0.95, hold: 0.35, wanderM: 52, wanderHz: 0.014, note: 'sunbather, twilight forager' }),
  cod: pelagic('cod', 40, 340, 140, { hold: 0.45 }),
  catfish: pelagic('catfish', 60, 380, 200, { hold: 0.5, wanderM: 12, note: 'bottom-leaning' }),
  sturgeon: pelagic('sturgeon', 40, 300, 170, { hold: 0.5, wanderM: 12, note: 'bottom-leaning' }),

  // ---- the mid-water: jellies, cephalopods, planers ----------------------
  jellyfish: pelagic('jellyfish', 40, 520, 190, { tight: 0.95, hold: 0.12, wanderM: 44, wanderHz: 0.017, note: 'pulses in the twilight' }),
  jelly: pelagic('jelly', 40, 520, 190, { tight: 0.95, hold: 0.12, wanderM: 44, wanderHz: 0.017 }),
  medusa: pelagic('medusa', 60, 560, 230, { tight: 0.95, hold: 0.12, wanderM: 44, wanderHz: 0.017 }),
  // the Portuguese man o' war is a FLOAT: it hangs from the surface film
  manowar: pelagic('manowar', 0, 24, 2, { tight: 0.35, hold: 1.1, wanderM: 3, wanderHz: 0.05, note: 'hangs from the surface film' }),
  comb: pelagic('comb', 30, 620, 200, { tight: 0.95, hold: 0.12, wanderM: 46, wanderHz: 0.015, note: 'ctenophore, rainbow in the dark' }),
  seaangel: pelagic('seaangel', 80, 520, 240, { tight: 0.9, hold: 0.15, wanderM: 36 }),
  // the spectral names live where the light gives out — that is the point
  ghost: pelagic('ghost', 300, 900, 560, { tight: 0.95, hold: 0.14, wanderM: 44, wanderHz: 0.013, note: 'where the light gives out' }),
  phantom: pelagic('phantom', 300, 900, 560, { tight: 0.95, hold: 0.14, wanderM: 44, wanderHz: 0.013 }),
  wraith: pelagic('wraith', 350, 980, 620, { tight: 0.95, hold: 0.14, wanderM: 44, wanderHz: 0.013 }),
  spirit: pelagic('spirit', 300, 900, 560, { tight: 0.95, hold: 0.14, wanderM: 44, wanderHz: 0.013 }),

  squid: pelagic('squid', 120, 760, 380, { tight: 0.9, hold: 0.3, wanderM: 34, wanderHz: 0.024, note: 'the twilight jet' }),
  cuttlefish: pelagic('cuttlefish', 8, 220, 60, { hold: 0.45, wanderM: 18, note: 'shelf water' }),
  nautilus: pelagic('nautilus', 120, 620, 340, { tight: 0.85, hold: 0.3, wanderM: 30, note: 'rises at night, sinks by day' }),
  argonaut: pelagic('argonaut', 2, 140, 30, { tight: 0.6, hold: 0.5, note: 'a paper shell near the surface' }),
  octopus: pelagic('octopus', 180, 900, 480, { tight: 0.85, hold: 0.3, wanderM: 26 }),
  octo: pelagic('octo', 180, 900, 480, { tight: 0.85, hold: 0.3, wanderM: 26 }),
  // the deep-sea vampire squid: the real animal's band, almost unchanged
  vampyroteuthis: pelagic('vampyroteuthis', 600, 1180, 900, { tight: 0.8, hold: 0.25, wanderM: 34, note: 'oxygen-minimum zone' }),
  kraken: pelagic('kraken', 700, 1190, 1010, { tight: 0.85, hold: 0.25, wanderM: 40, wanderHz: 0.012, note: 'the abyss keeps it' }),

  manta: pelagic('manta', 2, 200, 40, { hold: 0.45, wanderM: 22, note: 'planes the sunlit water' }),
  mobula: pelagic('mobula', 2, 220, 45, { hold: 0.45, wanderM: 22 }),
  stingray: pelagic('stingray', 3, 160, 55, { hold: 0.5, wanderM: 16 }),
  ray: pelagic('ray', 5, 300, 90, { hold: 0.4, wanderM: 20 }),
  skate: pelagic('skate', 150, 800, 460, { tight: 0.85, hold: 0.35, wanderM: 24, note: 'deep-shelf glider' }),
  turtle: pelagic('turtle', 1, 130, 24, { tight: 0.6, hold: 0.75, wanderM: 14, note: 'must reach air' }),
  // flatfish are floor animals wearing a swimmer's class
  flounder: benthic('flounder', { hoverM: 1.4, hoverVarM: 1.0, note: 'lies flat on the sediment' }),
  halibut: benthic('halibut', { hoverM: 1.8, hoverVarM: 1.2, note: 'lies flat on the sediment' }),
  sole: benthic('sole', { hoverM: 1.2, hoverVarM: 0.8, note: 'lies flat on the sediment' }),

  // ---- long bodies -------------------------------------------------------
  eel: pelagic('eel', 20, 460, 130, { hold: 0.35, wanderM: 22, note: 'coils through the mid-water' }),
  moray: pelagic('moray', 3, 160, 45, { tight: 0.6, hold: 0.6, wanderM: 10, note: 'reef crevices' }),
  seasnake: pelagic('seasnake', 0.5, 60, 12, { tight: 0.5, hold: 0.8, wanderM: 8, note: 'must reach air' }),
  seahorse: pelagic('seahorse', 0.5, 40, 10, { tight: 0.45, hold: 0.9, wanderM: 5, wanderHz: 0.05, note: 'clings to the shallows' }),
  pipefish: pelagic('pipefish', 0.5, 45, 12, { tight: 0.5, hold: 0.85, wanderM: 6, wanderHz: 0.05 }),
  lamprey: pelagic('lamprey', 5, 300, 80, { hold: 0.5, wanderM: 16 }),
  // the oarfish: a 10 m ribbon nobody sees except when it is dying
  oarfish: pelagic('oarfish', 200, 900, 480, { tight: 0.85, hold: 0.25, wanderM: 40, wanderHz: 0.013, note: 'the ribbon of the deep' }),
  ribbonfish: pelagic('ribbonfish', 180, 800, 420, { tight: 0.85, hold: 0.25, wanderM: 38, wanderHz: 0.014 }),
  // myth belongs to the dark half of the column
  serpent: pelagic('serpent', 300, 1120, 720, { tight: 0.9, hold: 0.22, wanderM: 46, wanderHz: 0.012, note: 'the dark half of the column' }),
  snake: pelagic('snake', 250, 1000, 620, { tight: 0.9, hold: 0.24, wanderM: 44, wanderHz: 0.012 }),
  dragon: pelagic('dragon', 400, 1160, 800, { tight: 0.9, hold: 0.22, wanderM: 48, wanderHz: 0.011, note: 'the dark half of the column' }),
  seadragon: pelagic('seadragon', 2, 80, 18, { tight: 0.5, hold: 0.8, wanderM: 8, note: 'weedy shallows' }),
  leviathan: pelagic('leviathan', 500, 1190, 900, { tight: 0.9, hold: 0.2, wanderM: 52, wanderHz: 0.01, note: 'the abyss keeps it' }),
  wyrm: pelagic('wyrm', 500, 1190, 900, { tight: 0.9, hold: 0.2, wanderM: 52, wanderHz: 0.01 }),
  noodle: pelagic('noodle', 20, 400, 120, { hold: 0.35, wanderM: 24 }),
  // a worm is sediment infauna: it belongs to the floor
  worm: benthic('worm', { hoverM: 0.8, hoverVarM: 0.6, note: 'sediment dweller' }),

  // ---- the deep: the anglerfish and the blobs ----------------------------
  anglerfish: pelagic('anglerfish', 500, 1190, 880, {
    tight: 0.8, hold: 0.35, wanderM: 30, wanderHz: 0.012, note: 'carries its own lure into the dark',
  }),
  angler: pelagic('angler', 500, 1190, 880, { tight: 0.8, hold: 0.35, wanderM: 30, wanderHz: 0.012 }),

  blob: pelagic('blob', 700, 1195, 1050, { tight: 0.8, hold: 0.15, wanderM: 30, wanderHz: 0.01, note: 'the pressure suits it' }),
  ooze: pelagic('ooze', 750, 1198, 1090, { tight: 0.75, hold: 0.15, wanderM: 26, wanderHz: 0.01 }),
  slime: pelagic('slime', 700, 1195, 1040, { tight: 0.8, hold: 0.15, wanderM: 28, wanderHz: 0.01 }),
  goo: pelagic('goo', 700, 1195, 1040, { tight: 0.8, hold: 0.15, wanderM: 28, wanderHz: 0.01 }),
  amoeba: pelagic('amoeba', 300, 900, 560, { tight: 0.9, hold: 0.12, wanderM: 40, wanderHz: 0.012 }),
  nebula: pelagic('nebula', 400, 1100, 700, { tight: 0.95, hold: 0.1, wanderM: 56, wanderHz: 0.009, note: 'a cloud with nowhere to be' }),
  mist: pelagic('mist', 120, 700, 340, { tight: 0.95, hold: 0.1, wanderM: 52, wanderHz: 0.011 }),
  cloud: pelagic('cloud', 120, 700, 340, { tight: 0.95, hold: 0.1, wanderM: 52, wanderHz: 0.011 }),
  spore: pelagic('spore', 150, 800, 400, { tight: 0.95, hold: 0.1, wanderM: 50, wanderHz: 0.011 }),
  salp: pelagic('salp', 60, 620, 260, { tight: 0.95, hold: 0.12, wanderM: 46, wanderHz: 0.013, note: 'a chain in the twilight' }),
  // the diel migrants: the largest animal migration on earth, nightly
  plankton: pelagic('plankton', 5, 320, 70, { tight: 0.95, hold: 0.08, wanderM: 40, wanderHz: 0.02, note: 'rises at night, sinks by day' }),
  krill: pelagic('krill', 10, 400, 100, { tight: 0.95, hold: 0.1, wanderM: 44, wanderHz: 0.02, note: 'rises at night, sinks by day' }),
  algae: pelagic('algae', 0, 70, 12, { tight: 0.6, hold: 0.4, wanderM: 10, note: 'needs the light' }),
  // deep-sea shrimp: the vent and plain scavengers
  shrimp: pelagic('shrimp', 400, 1180, 860, { tight: 0.85, hold: 0.3, wanderM: 30, wanderHz: 0.014, note: 'scours the deep water' }),

  // ---- the floor: echinoderms and crustaceans (benthic, not rooted) ------
  starfish: benthic('starfish', { hoverM: 1.0, hoverVarM: 0.7 }),
  seastar: benthic('seastar', { hoverM: 1.0, hoverVarM: 0.7 }),
  star: benthic('star', { hoverM: 1.2, hoverVarM: 0.9 }),
  brittlestar: benthic('brittlestar', { hoverM: 1.0, hoverVarM: 0.8 }),
  basketstar: benthic('basketstar', { hoverM: 3.5, hoverVarM: 2.0, note: 'perches to filter the current' }),
  sunstar: benthic('sunstar', { hoverM: 1.2, hoverVarM: 0.9 }),
  urchin: benthic('urchin', { hoverM: 0.8, hoverVarM: 0.5 }),
  sanddollar: benthic('sanddollar', { hoverM: 0.5, hoverVarM: 0.4, note: 'half-buried in the sediment' }),
  crab: benthic('crab', { hoverM: 1.4, hoverVarM: 1.0, hold: 1.0, note: 'walks the abyssal plain' }),

  // ---- the flora: ROOTED, always, no exceptions --------------------------
  // Every one of these is planted on the seabed by placeDepth. The shallows
  // they'd occupy in a real ocean have no floor in this column — the column
  // has exactly one, at ~1200 m — so the seabed is where they live. This is
  // the hard rule: rooted flora cannot float.
  kelp: rooted('kelp', { note: 'a holdfast on the abyssal plain' }),
  seaweed: rooted('seaweed'),
  seagrass: rooted('seagrass', { note: 'a meadow on the plain' }),
  eelgrass: rooted('eelgrass', { note: 'a meadow on the plain' }),
  grass: rooted('grass'),
  reed: rooted('reed'),
  vine: rooted('vine'),
  fern: rooted('fern'),
  willow: rooted('willow'),
  wakame: rooted('wakame'),
  sargassum: rooted('sargassum'),
  coral: rooted('coral', { note: 'a reef head on the plain' }),
  seafan: rooted('seafan', { note: 'set broadside to the current' }),
  fan: rooted('fan', { note: 'set broadside to the current' }),
  anemone: rooted('anemone', { note: 'anchored, tentacles in the current' }),
  lotus: rooted('lotus'),
  lily: rooted('lily'),
  rose: rooted('rose'),
  tulip: rooted('tulip'),
  flower: rooted('flower'),
  blossom: rooted('blossom'),
});

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

// v3.7 re-routings ride in from the data file (OCEAN.aliasesV37): they are the
// words the new research RE-HOMES, so they are applied before anything else.
// 'turtle' is the one to look at — v3.6 answered it from the ray archetype
// because the lexicon filed turtles with the flatfish; it is a marine tetrapod
// on the inner shelf now, and this is the line that makes that true everywhere.
const ALIASES = Object.freeze({
  jellies: 'jellyfish',
  medusae: 'medusa',
  octopus: 'octopus',
  seastars: 'seastar',
  ...((OCEAN && OCEAN.aliasesV37) || {}),
});

/** The band key a name resolves to, or null. Tries: exact, alias, singular,
 *  then each word of a multi-word name (right to left, so the head noun of
 *  "red jellyfish" wins), then the archetype table. */
export function bandKeyFor(nameOrArch) {
  if (!nameOrArch) return null;
  const raw = String(nameOrArch).toLowerCase().trim();
  if (!raw) return null;
  const direct = lookupWord(raw);
  if (direct) return direct;
  if (raw.indexOf(' ') >= 0) {
    const words = raw.split(/\s+/);
    for (let i = words.length - 1; i >= 0; i--) {
      const k = lookupWord(words[i]);
      if (k) return k;
    }
  }
  return null;
}

// Own-property only: a typed word like "constructor" or "toString" must NOT
// find Object.prototype and be handed back as a "band".
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function lookupWord(w) {
  if (has(ALIASES, w)) w = ALIASES[w];
  // v3.7: the researched band table is consulted FIRST. Every v3.5 word is in
  // it already (bandFor preferred it over the authored table from the start),
  // and the 69 species v3.7 adds exist ONLY there — without this line a
  // barnacle would resolve to nothing and drift the mid-water as 'default'.
  if (has(DATA_BANDS, w)) return w;
  if (has(SPECIES_BANDS, w)) return w;
  if (has(ARCH_BANDS, w)) return w;
  const s = w.replace(/s$/, '');
  if (s !== w) {
    if (has(ALIASES, s)) return ALIASES[s];
    if (has(DATA_BANDS, s)) return s;
    if (has(SPECIES_BANDS, s)) return s;
    if (has(ARCH_BANDS, s)) return s;
  }
  return null;
}

/**
 * The home band of a species name or an archetype key.
 *   bandFor('anglerfish')      -> the deep band
 *   bandFor('red jellyfish')   -> the jellyfish band
 *   bandFor('kelp')            -> the rooted band
 *   bandFor('fish')            -> the fish archetype band
 * Always returns a frozen band record — never null, never a fresh object, so
 * this is safe to call from anywhere including a frame path.
 */
export function bandFor(nameOrArch) {
  const key = bandKeyFor(nameOrArch);
  if (!key) return DEFAULT_BAND;
  // v3.5: bands derived from researched depth ranges (src/data/ocean-data.json)
  // WIN over the hand-authored table. This is the ecology fix — the authored
  // bands put every rooted plant and floor animal on the 1200 m abyssal plain,
  // including kelp, coral and seagrass, which are photosynthetic and cannot
  // live below the light. Where the data has no entry the authored band still
  // applies, so nothing loses its home.
  const d = has(DATA_BANDS, key) ? DATA_BANDS[key] : null;
  if (d && d.kind) return d;
  const b = has(SPECIES_BANDS, key) ? SPECIES_BANDS[key] : has(ARCH_BANDS, key) ? ARCH_BANDS[key] : null;
  return b && b.kind ? b : DEFAULT_BAND;
}

/**
 * The band for a resolved lexicon spec, preferring the species over the
 * archetype: resolveName('red jellyfish') has arch 'medusa' and name
 * 'red jellyfish' — the jellyfish band is the more specific answer.
 */
export function bandForSpec(res) {
  if (!res) return DEFAULT_BAND;
  if (res.band && res.band.kind) return res.band;
  const byName = res.name ? bandFor(res.name) : null;
  if (byName && byName !== DEFAULT_BAND) return byName;
  return bandFor(res.arch);
}

/** True if this band is planted in the seabed (flora). */
export function isRootedBand(band) {
  return !!band && band.kind === 'rooted';
}

/** True if the band lives ON the floor (rooted flora or benthic animals). */
export function isFloorBand(band) {
  return !!band && (band.kind === 'rooted' || band.kind === 'benthic');
}

/** "190 m · pulses in the twilight" — a line for the gauge or a label. */
export function describeBand(band) {
  const b = band || DEFAULT_BAND;
  if (b.kind === 'rooted') return `seabed · ${b.note || 'rooted'}`;
  if (b.kind === 'benthic') return `seabed · ${b.note || 'floor dweller'}`;
  const head = `${Math.round(b.minM)}–${Math.round(b.maxM)} m`;
  return b.note ? `${head} · ${b.note}` : head;
}

// ---------------------------------------------------------------------------
// The preference curve
// ---------------------------------------------------------------------------
//
// A triangular distribution on the band with its mode at preferM, narrowed
// toward the mode by `tight`. Triangular is deliberate: it has hard edges (a
// dolphin is NEVER at 400 m, not "rarely"), an exact closed-form inverse CDF
// (one draw, no rejection loop, no allocation) and an obvious peak.

/** The effective (tightened) range of a band, written into lo/hi of `out`. */
function effRange(band, out) {
  const lo = band.minM;
  const hi = band.maxM;
  const span = hi - lo;
  if (span <= 0) {
    out.lo = lo;
    out.hi = hi;
    out.p = 0.5;
    return out;
  }
  const p = (band.preferM - lo) / span;
  const t = Math.min(Math.max(band.tight, 0.02), 1);
  out.lo = band.preferM + (lo - band.preferM) * t;
  out.hi = band.preferM + (hi - band.preferM) * t;
  out.p = p;
  return out;
}

// module-scope scratch — effRange/preferenceAt/pickDepth allocate nothing
const RANGE = { lo: 0, hi: 0, p: 0.5 };

/**
 * How much this species wants to be at depth `m`: 1 at preferM, falling
 * linearly to 0 at the edges of its effective band, 0 outside. Pure; no
 * allocation. Use it to weight anything depth-aware (a lure's appeal, a
 * label's confidence, a debug plot of the column).
 */
export function preferenceAt(band, m) {
  const b = band || DEFAULT_BAND;
  effRange(b, RANGE);
  const { lo, hi } = RANGE;
  const mode = b.preferM;
  if (m <= lo || m >= hi) return 0;
  if (m === mode) return 1;
  return m < mode ? (m - lo) / Math.max(mode - lo, 1e-6) : (hi - m) / Math.max(hi - mode, 1e-6);
}

// Inverse CDF of the triangular distribution on [0,1] with mode p.
function triangular(u, p) {
  if (p <= 0) return 1 - Math.sqrt(1 - u);
  if (p >= 1) return Math.sqrt(u);
  return u < p ? Math.sqrt(u * p) : 1 - Math.sqrt((1 - u) * (1 - p));
}

// ---------------------------------------------------------------------------
// Deterministic depth draw
// ---------------------------------------------------------------------------
//
// Depth has its OWN stream. It is salted off the creature's seed (and its
// instance index, so the five fish of a school spread through their band
// instead of stacking) and it never touches the geometry RNG or the board's
// placement prng — geometry-spec 8's frozen draw order is untouched by
// construction, not by convention. Same seed in, same metre out, forever.

const DEPTH_SALT = 0x0d3e740b;

function depthRandom(seed, instance, round) {
  // one mulberry32 step, inlined and stateless: no closure, no allocation
  let a = (((seed >>> 0) ^ Math.imul((instance | 0) + 1, 0x9e3779b9) ^ DEPTH_SALT) + Math.imul(round | 0, 0x85ebca6b)) | 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Where in its band this individual lives, in metres below the surface.
 * Deterministic in (band, seed, instance) — the same URL hash therefore
 * reproduces the same column, depths included.
 *
 * @param {object|string} band     a band record, or a name/archetype to look up
 * @param {number} seed            the creature's seed (lexicon resolveName)
 * @param {number} [instance]      index within a school/batch (default 0)
 * @returns {number} metres below the surface, positive down
 */
export function pickDepth(band, seed, instance, transectM) {
  const b = typeof band === 'string' ? bandFor(band) : band || DEFAULT_BAND;
  const i = instance || 0;
  // v3.7 — a floor dweller's depth is the depth of the floor it is standing on.
  // With a transect position it is a fact about the profile; without one the
  // v3.6 answer (the column's single deepest floor) is kept, so an unwired
  // caller still gets something on the seabed rather than a NaN.
  const floor = transectM == null ? floorDepthM() : floorDepthAt(transectM);
  if (b.kind === 'rooted') return floor;
  if (b.kind === 'benthic') {
    const u = depthRandom(seed, i, 0);
    const hover = Math.max(b.hoverM + (u * 2 - 1) * b.hoverVarM, 0.2);
    return Math.max(floor - hover, 0);
  }
  effRange(b, RANGE);
  const u = depthRandom(seed, i, 0);
  const x = triangular(u, RANGE.p);
  return RANGE.lo + (RANGE.hi - RANGE.lo) * x;
}

/** Metres above the local floor for a benthic/rooted individual (0 for rooted,
 *  a deterministic hover for benthic, 0 for anything pelagic). */
export function pickHover(band, seed, instance) {
  const b = typeof band === 'string' ? bandFor(band) : band || DEFAULT_BAND;
  if (b.kind === 'rooted') return 0;
  if (b.kind !== 'benthic') return 0;
  const u = depthRandom(seed, instance || 0, 0);
  return Math.max(b.hoverM + (u * 2 - 1) * b.hoverVarM, 0.2);
}

// ---------------------------------------------------------------------------
// Placement — the API the board calls when it spawns a creature
// ---------------------------------------------------------------------------

/**
 * Full vertical placement for one creature. This is the call the integrator
 * makes inside boardSpec(): it decides the metre depth AND the world Y,
 * planting floor dwellers on the actual relief under them.
 *
 * @param {object} o
 *   name      display name ("red jellyfish") — preferred, most specific
 *   arch      archetype key, the fallback when the name is unknown
 *   band      an explicit band record (skips lookup)
 *   seed      the creature's seed
 *   instance  index within a batch (default 0)
 *   x, z      world position, so floor dwellers follow the seabed relief
 *   liftPx    extra world px above the floor for rooted flora, so a plant
 *             sits on the sediment rather than half-buried in it (default 0)
 * @returns {{band, kind, depthM, worldY, hoverM, rooted}} — a fresh record.
 *   This is a spawn-path call (<= 14 per board); frame-path helpers below
 *   allocate nothing.
 */
export function placeDepth(o) {
  const band = o.band || (o.name ? bandFor(o.name) : bandFor(o.arch));
  const seed = o.seed >>> 0;
  const instance = o.instance || 0;
  const x = o.x || 0;
  const z = o.z || 0;
  if (band.kind === 'rooted') {
    // The band's preferred depth chooses WHICH substrate this thing stands on:
    // the shelf bench for a shallow, light-dependent plant, the abyssal plain
    // for anything that genuinely lives down there.
    const y = floorYAt(x, z, band.preferM) + (o.liftPx || 0);
    return {
      band,
      kind: 'rooted',
      depthM: depthForWorldY(y),
      worldY: y,
      hoverM: 0,
      rooted: true,
    };
  }
  if (band.kind === 'benthic') {
    const hoverM = pickHover(band, seed, instance);
    const y = floorYAt(x, z, band.preferM) + hoverM * pxPerMetre() + (o.liftPx || 0);
    return {
      band,
      kind: 'benthic',
      depthM: depthForWorldY(y),
      worldY: y,
      hoverM,
      rooted: false,
    };
  }
  const depthM = pickDepth(band, seed, instance);
  return {
    band,
    kind: 'pelagic',
    depthM,
    worldY: worldYForDepth(depthM),
    hoverM: 0,
    rooted: false,
  };
}

/**
 * THE v3.7 PLACEMENT CALL — both axes at once, which is the only way they can
 * be made to agree. This is what boardSpec() should use; placeDepth() above is
 * kept for callers that already own an x.
 *
 * The two branches differ in WHICH axis is drawn first, and that asymmetry is
 * the ecology:
 *   * a floor dweller's transect is drawn first and its depth FOLLOWS from the
 *     seabed there. A mussel is at 2 m because it is 300 m offshore — those are
 *     one fact, and drawing them separately is how you get a mussel hanging in
 *     open water over the slope.
 *   * a swimmer's depth is drawn first (from its band, exactly as in v3.6, from
 *     the same RNG round — a v3.6 URL still reproduces every v3.6 depth) and
 *     its transect is then drawn from its shore zones, clipped so there is
 *     always water under it.
 *
 * @param {object} o { band?, name?, arch?, seed, instance?, z?, jitterPx?,
 *                     liftPx? }
 * @returns {{band, kind, transectM, worldX, depthM, worldY, hoverM, rooted,
 *            floorDepthM}} — a fresh record, spawn path only.
 */
export function placeSpot(o) {
  const band = o.band || (o.name ? bandFor(o.name) : bandFor(o.arch));
  const seed = o.seed >>> 0;
  const instance = o.instance || 0;
  const z = o.z || 0;
  const jitter = o.jitterPx || 0;
  const lift = o.liftPx || 0;
  if (band.kind === 'rooted' || band.kind === 'benthic') {
    const transectM = pickTransect(band, seed, instance, null);
    const meanM = floorDepthAt(transectM);
    const worldX = worldXForTransect(transectM) + jitter;
    const hoverM = band.kind === 'benthic' ? pickHover(band, seed, instance) : 0;
    // the hint AGREES with the local floor by construction, so the substrate
    // bridge in column.js never fires here — the ground answered is the real
    // ground under this x, relief and all
    const y = floorYAt(worldX, z, meanM) + hoverM * pxPerMetre() + lift;
    return {
      band,
      kind: band.kind,
      transectM,
      worldX,
      depthM: depthForWorldY(y),
      worldY: y,
      hoverM,
      rooted: band.kind === 'rooted',
      floorDepthM: meanM,
    };
  }
  const depthM = pickDepth(band, seed, instance);
  const transectM = pickTransect(band, seed, instance, depthM);
  return {
    band,
    kind: 'pelagic',
    transectM,
    worldX: worldXForTransect(transectM) + jitter,
    depthM,
    worldY: worldYForDepth(depthM),
    hoverM: 0,
    rooted: false,
    floorDepthM: floorDepthAt(transectM),
  };
}

// ---------------------------------------------------------------------------
// Vertical behaviour — wander inside the band, ease back when displaced
// ---------------------------------------------------------------------------
//
// Two incommensurate sines (house style — see the eel spine and the surface
// ripple) so a creature's vertical wander never visibly repeats. The wander is
// a TARGET, not a position: the creature eases toward it at the band's `hold`
// rate, which is also exactly what pulls it home after the gather beacon, a
// depth control, or a school shove has carried it out of its band.

const W1 = 1.0;
const W2 = 0.618; // golden-ish ratio: the pair never comes back into phase

/**
 * Stamp a creature with its vertical home. Call once, at construction, after
 * placement. Adds only new fields (`band`, `homeM`, `hoverM`, `dPh1`, `dPh2`)
 * — nothing existing is touched.
 *
 * @param {object} creature   the board's Creature (needs .px/.py/.pz)
 * @param {object} o          { band?, name?, arch?, seed, instance?, homeM?,
 *                              liftPx? } — pass the SAME liftPx you gave
 *                              placeDepth, or a plant that was lifted clear of
 *                              the sediment gets pulled back down into it
 */
export function attachDepth(creature, o) {
  const opts = o || {};
  const band = opts.band || (opts.name ? bandFor(opts.name) : bandFor(opts.arch));
  const seed = (opts.seed ?? 0) >>> 0;
  const instance = opts.instance || 0;
  creature.band = band;
  creature.homeM = opts.homeM != null ? opts.homeM : pickDepth(band, seed, instance);
  creature.hoverM = pickHover(band, seed, instance);
  creature.liftPx = opts.liftPx || 0;
  // v3.7 — the horizontal home. `homeX` is world px (what the roam bounds and
  // the culling read); `homeS` is the same place in transect metres (what an
  // instrument would print). Both come from placement so steering and spawn
  // agree to the last decimal, exactly as homeM does.
  creature.homeS = opts.homeS != null ? opts.homeS : pickTransect(band, seed, instance, creature.homeM);
  creature.homeX = opts.homeX != null ? opts.homeX : worldXForTransect(creature.homeS);
  // The species' stretch of transect, resolved ONCE and cached in world px.
  // transectRangeFor inverts the profile by bisection, which is 24 profile
  // evaluations — cheap, but not something a per-creature per-frame backstop
  // should pay for, and the range does not change while the creature lives.
  transectRangeFor(band, creature.homeM, TRANGE);
  creature.rangeXLo = worldXForTransect(TRANGE.inshoreM);
  creature.rangeXHi = worldXForTransect(TRANGE.offshoreM);
  // phases come from the same salted stream, appended after the depth draw
  creature.dPh1 = depthRandom(seed, instance, 1) * Math.PI * 2;
  creature.dPh2 = depthRandom(seed, instance, 2) * Math.PI * 2;
  return creature;
}

function bandOf(c) {
  if (c.band) return c.band;
  const spec = c.spec;
  const b = spec ? bandFor(spec.name || spec.arch) : DEFAULT_BAND;
  c.band = b; // memoise so the frame path never re-parses a name
  return b;
}

/**
 * The depth (metres below the surface) this creature wants to be at right now:
 * its home, plus the slow vertical wander, clamped into its band. Pure and
 * allocation-free — safe to call every frame, for every creature.
 *
 * For floor dwellers this returns the nominal depth of their hover; use
 * targetWorldY() instead if you want them to follow the seabed relief.
 *
 * @param {object} creature  needs .band/.homeM (attachDepth) or .spec
 * @param {number} t         sim seconds (injectable clock — never a wall clock)
 */
export function targetDepthFor(creature, t) {
  const b = bandOf(creature);
  // v3.7: the floor a creature stands on is the floor under ITS OWN x, not the
  // column's deepest one. Without this every benthic animal on the shelf would
  // be steered down to 1200 m every frame while its body stayed on the rock.
  if (b.kind === 'rooted') return floorDepthAtX(creature.px || 0);
  const home = creature.homeM != null ? creature.homeM : b.preferM;
  if (b.kind === 'benthic') {
    return Math.max(floorDepthAtX(creature.px || 0) - (creature.hoverM != null ? creature.hoverM : b.hoverM), 0);
  }
  const w = b.wanderM;
  if (w <= 0) return home;
  const p1 = creature.dPh1 || 0;
  const p2 = creature.dPh2 || 0;
  const hz = b.wanderHz;
  const d =
    home +
    w * 0.62 * Math.sin(hz * W1 * 6.283185307 * t + p1) +
    w * 0.38 * Math.sin(hz * W2 * 6.283185307 * t + p2);
  return d < b.minM ? b.minM : d > b.maxM ? b.maxM : d;
}

/**
 * The world Y this creature wants to be at right now. Floor dwellers follow
 * the seabed relief under their own (x, z), so a starfish sits ON the dune it
 * is standing on rather than at a nominal plane.
 */
export function targetWorldY(creature, t) {
  const b = bandOf(creature);
  const lift = creature.liftPx || 0; // survives placement (see attachDepth)
  if (b.kind === 'rooted') return floorYAt(creature.px || 0, creature.pz || 0, creature.homeM) + lift;
  if (b.kind === 'benthic') {
    const hover = creature.hoverM != null ? creature.hoverM : b.hoverM;
    return floorYAt(creature.px || 0, creature.pz || 0) + hover * pxPerMetre() + lift;
  }
  return worldYForDepth(targetDepthFor(creature, t));
}

/**
 * THE STEERING HOOK. Call once per creature per frame, BEFORE the creature's
 * own motion is applied (main.js: immediately before c.update(...), since
 * applyMotion reads c.py and writes it into the object's position).
 *
 * It eases c.py toward the creature's band at the band's `hold` rate, which
 * makes three things true at once: creatures wander gently inside their band,
 * they STAY there while the camera travels past them, and anything that
 * displaces them (the gather beacon, a depth control, a school shove) decays
 * away over a few seconds instead of permanently relocating the species.
 *
 * Allocation-free. Injectable clock only. Mutates exactly one field: c.py.
 *
 * @param {object} creature
 * @param {number} t      sim seconds
 * @param {number} dt     seconds since the last frame
 * @param {object} [opts]
 *   scale  multiplier on the hold rate (0 disables — pass 0 while the gather
 *          beacon owns this creature if you want the beacon to win outright;
 *          leaving it at 1 lets the two negotiate, which looks better)
 *   rate   absolute override of the hold rate, 1/s
 * @returns {boolean} true if it steered
 */
export function steerDepth(creature, t, dt, opts) {
  const b = bandOf(creature);
  if (dt <= 0) return false;
  let rate = opts && opts.rate != null ? opts.rate : b.hold;
  if (opts && opts.scale != null) rate *= opts.scale;
  if (rate <= 0) return false;
  const ty = targetWorldY(creature, t);
  creature.py += (ty - creature.py) * (1 - Math.exp(-rate * dt));
  return true;
}

/**
 * Hard clamp: keep a creature inside its band no matter what moved it. Cheaper
 * and blunter than steerDepth — use it as a backstop after other systems have
 * written c.py (schooling, follow-the-cursor), so nothing can strand a dolphin
 * in the abyss even for a frame. Allocation-free; mutates c.py only.
 *
 * @param {number} [slackM] metres of tolerance outside the band (default 0)
 */
export function clampToBand(creature, slackM) {
  const b = bandOf(creature);
  const s = slackM || 0;
  if (b.kind === 'rooted') {
    // v3.5: query the substrate at the plant's OWN depth. Without the third
    // argument this re-plants every frame onto the abyssal plain — which
    // silently undid the correct shelf placement made at spawn, so kelp kept
    // its shallow homeM while its body sat at 1200 m in the dark.
    const nearM = creature.homeM ?? b.preferM;
    creature.py = floorYAt(creature.px || 0, creature.pz || 0, nearM) + (creature.liftPx || 0);
    return true;
  }
  const m = depthForWorldY(creature.py);
  // floor bands are expressed relative to the LIVE seabed depth under the
  // creature's own x (v3.7), so a change to the column's height — or a walk
  // along the transect — carries them with it instead of stranding them
  // ...and against the ACTUAL ground under it, relief included — not the
  // profile's mean. v3.6 clamped benthos to the nominal seabed depth, so an
  // animal standing in a dune trough was held up to 15 m above the sand it was
  // supposed to be sitting on. Same call the placement made, so the clamp and
  // the spawn cannot disagree.
  const localFloor = b.kind === 'benthic'
    ? depthForWorldY(floorYAt(creature.px || 0, creature.pz || 0))
    : 0;
  const lo = b.kind === 'benthic' ? Math.max(localFloor - 40, 0) : b.minM - s;
  const hi = b.kind === 'benthic' ? localFloor : b.maxM + s;
  if (m < lo) {
    creature.py = worldYForDepth(lo);
    return true;
  }
  if (m > hi) {
    creature.py = worldYForDepth(hi);
    return true;
  }
  return false;
}

/**
 * The horizontal backstop, and the exact mirror of clampToBand: keep a creature
 * inside the stretch of transect its species occupies, no matter what moved it.
 * Roaming, schooling and the gather beacon all write c.px directly.
 *
 * The band's own span is used, widened by `slackPx` world px, so a creature can
 * wander out of frame but never off its shore zone — a reef fish cannot swim
 * out over the abyssal plain because nothing was watching.
 * Allocation-free; mutates c.px only.
 */
export function clampToTransect(creature, slackPx) {
  let xLo = creature.rangeXLo;
  let xHi = creature.rangeXHi;
  if (xLo == null || xHi == null) {
    // not stamped by attachDepth (a legacy creature, or a caller that built its
    // own): resolve once and cache, so this stays O(1) from the second frame
    transectRangeFor(bandOf(creature), creature.homeM, TRANGE);
    xLo = creature.rangeXLo = worldXForTransect(TRANGE.inshoreM);
    xHi = creature.rangeXHi = worldXForTransect(TRANGE.offshoreM);
  }
  const s = slackPx || 0;
  const lo = xLo - s;
  const hi = xHi + s;
  if (creature.px < lo) {
    creature.px = lo;
    return true;
  }
  if (creature.px > hi) {
    creature.px = hi;
    return true;
  }
  return false;
}

export default {
  bandFor,
  bandForSpec,
  bandKeyFor,
  pickDepth,
  pickHover,
  pickTransect,
  placeDepth,
  placeSpot,
  transectRangeFor,
  describeTransect,
  clampToTransect,
  floorDepthAt,
  floorDepthAtX,
  transectAtDepthM,
  worldXForTransect,
  transectForWorldX,
  transectLengthM,
  SHORE_ZONE_SPANS,
  attachDepth,
  targetDepthFor,
  targetWorldY,
  steerDepth,
  clampToBand,
  preferenceAt,
  describeBand,
  isRootedBand,
  isFloorBand,
  setDepthUnits,
  depthUnits,
  worldYForDepth,
  depthForWorldY,
  floorDepthM,
  floorYAt,
  pxPerMetre,
  ARCH_BANDS,
  SPECIES_BANDS,
  DEFAULT_BAND,
  SEABED_DEPTH_M,
};

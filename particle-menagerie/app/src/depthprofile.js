// The depth profile — how the water LOOKS at a given depth.
//
// Division of labour with column.js: column.js owns the WORLD (the metre <->
// world-px scale, the two boundary planes, the camera's vertical position and
// the dotted surface/seabed sheets) and is the single source of truth for all
// of it. This module owns the OPTICS AND THE DRAMATURGY layered on top of that
// world: what colour the water is at 300 m, how much of the moon's shafts are
// left, how thick the marine snow is, how hard the fog bites and how red it
// eats. background.js and atmosphere/* read nothing else.
//
// Units and sign convention are column.js's and are re-exported here so the
// atmosphere layers have one import: DEPTH IS POSITIVE METRES BELOW THE
// SURFACE (0 at the surface, 1200 at the seabed), and world y = -depth *
// PX_PER_METRE.
//
// Determinism: pure functions of depth — no RNG, no clock, no DOM. Allocation:
// every sampling entry point writes into a caller-owned scratch record
// (createDepthSample()), so nothing here allocates on a frame path.

import {
  METRES_PER_PX,
  PX_PER_METRE,
  SURFACE_Y,
  SEABED_Y,
  SEABED_DEPTH_M,
  COLUMN_PX,
  DEFAULT_DEPTH_M,
  ZONES,
  WHEEL_GAIN,
  clampDepth,
  metresToWorldY,
  worldYToMetres,
  zoneAt,
} from './column.js';

// Re-exported verbatim — column.js DEFINES these; this is a convenience so a
// consumer of the profile never has to import both files.
export {
  METRES_PER_PX,
  PX_PER_METRE,
  SURFACE_Y,
  SEABED_Y,
  SEABED_DEPTH_M,
  COLUMN_PX,
  DEFAULT_DEPTH_M,
  ZONES,
  WHEEL_GAIN,
  clampDepth,
  metresToWorldY,
  worldYToMetres,
  zoneAt,
};

// The depth at which every multiplier in the profile is exactly 1, i.e. the
// depth whose look IS v3.3's: a fresh board renders the v3.3 scene, and
// everything above and below it is a departure you can see. It is deliberately
// equal to column.js's DEFAULT_DEPTH_M — the KEYS table below has a key sitting
// exactly on it. If column.js's default moves, move this AND that key together,
// or a plain load stops looking like v3.3.
export const NEUTRAL_DEPTH_M = 120;

/** World px that `toDepthM` sits ABOVE `fromDepthM` (negative = below). Layers
 *  use this to place the surface / seabed relative to the camera without
 *  needing the camera object. */
export function pxAbove(fromDepthM, toDepthM) {
  return (fromDepthM - toDepthM) * PX_PER_METRE;
}

/** "643 m" — the gauge's own formatting lives with the units it formats. */
export function formatDepthM(m) {
  return Math.round(clampDepth(m)) + ' m';
}

// ---- water optics (the physical part) -------------------------------------
// Beer–Lambert extinction per metre, per channel. The ORDER is the physics
// that matters: sea water eats red first, then green, and blue travels
// furthest — which is why a deep sea goes blue-black and never brown. The
// magnitudes are compressed from real clear-ocean coefficients (real red is
// ~0.35/m and would be gone inside 15 m) so that all 1200 m of the column
// stay legible; the ratios keep the real order kR >> kG > kB.
//
//   depth      red     green    blue
//      30 m   0.105    0.371    0.533
//     120 m   0.00012  0.019    0.081
//     400 m   ~0       ~0       0.00022
//    1200 m   ~0       ~0       ~0
//
// INTEGRATION TUNING (v3.4 integrator, measured against the shipped v3.3
// build): the first draft of these coefficients was ~2.5x shallower, which put
// the water at the app's neutral 120 m at mean luma 27/255 with 60% of the
// frame "lit" — a bright teal pool. v3.3, whose look is the contract, measures
// 7.8 mean luma and 10% lit on the same board. The fix belongs HERE and not in
// a global dimmer: steepening extinction keeps the top 60 m genuinely sunlit
// (which is the whole point of a column) while restoring the near-black
// mid-water the creatures are meant to be the only light in.
export const EXTINCTION = Object.freeze([0.075, 0.033, 0.021]);

// Downwelling light AT the surface, in linear light, pre-exposure — this is a
// night ocean, so "brightest" is still dim. The final ACES+sRGB pass is the
// only tonemap (frame-graph rule 2); nothing here encodes.
//
// Calibration note (why these numbers and not "whatever looks bright"): the
// trails pass subtracts a 1.5/255 epsilon per frame below 8/255, so a STEADY
// emitter only survives above eps/(1 − fadeK) — 0.0235 linear under the
// moonlit preset, 0.0062 under ink, 0.098 under abyss. That is a hard black
// floor the background sits against. These values put the sunlit zone above it
// (the upper ~130 m visibly glows and the surface ceiling is bright) and put
// mid-water below it, so the default board keeps the near-black v3.3 water and
// the abyss is genuinely lightless. Physics and the frame graph agree here.
export const SURFACE_LIGHT = Object.freeze([0.02, 0.036, 0.05]);

// The lobe of moon/sky light that reads as "the surface, above you" — the
// light column.js's dotted surface sheet is glittering IN. Peaks around
// 165-205/255 after ACES at the app's 3.4 exposure: a bright silver ceiling,
// deliberately short of blowout since bloom smears it further.
export const SURFACE_GLOW = Object.freeze([0.02, 0.026, 0.032]);

// Abyssal sediment floor — warm-neutral silt haze under column.js's dotted
// seabed sheet. Above the moonlit epsilon floor (see above) by design, or the
// seabed would render as the same black as the water and the column would end
// in nothing.
//
// INTEGRATION TUNING: every channel is now above 8/255 = 0.0314, not merely
// above the 0.0235 steady-state floor. The trails pass only applies its
// subtractive epsilon BELOW 8/255, so a colour that straddles that line splits:
// the first draft's blue (0.030) was eroded to ~0.0065 while red and green
// (0.038 / 0.035) were untouched, and — worse — every neutral marine-snow trail
// laid over the haze had its own blue eaten while it was dim, so the abyssal
// plain grew a field of saturated ORANGE comet tails. Keeping all three
// channels clear of the threshold makes the haze and anything additive on top
// of it colour-stable. The warmth is in the ratios, not in a crushed channel.
export const FLOOR_COLOUR = Object.freeze([0.042, 0.04, 0.036]);

// ---- the two lights that are left below the photic zone -------------------
// Beer–Lambert above accounts for the DIRECT beam only, and the direct beam is
// gone by ~300 m: SURFACE_LIGHT[2] * exp(-0.021 * 420) is 7.5e-6, i.e. black.
// Left to itself that makes every frame from 350 m to the seabed the same
// black field with the same marine snow on it — the twilight and midnight
// zones become one zone, which is the thing v3.4 exists to avoid. Two terms
// fix it, and between them they ARE the depth read below the photic zone:
//
//   SCATTER — "the last of the daylight". Multiply-scattered skylight has a
//     far longer effective path than the direct beam (its photons are not
//     going straight down any more), so it outlives it by hundreds of metres.
//     It is blue with what little green is left, it is DIRECTIONAL — brighter
//     above you than below, which is the only "up is that way" cue the water
//     has left to give — and it is gone by ~550 m. This is what makes a
//     twilight frame a lit gradient instead of a black field.
//
//   BIO — bioluminescence, the `bio` keyframe column below. Everything that
//     lives in the midnight zone makes its own light; seen from inside the
//     water it is a field of faint cold clouds, brightest near the plain where
//     life concentrates. It is NOT directional and it GROWS with depth, so it
//     is the exact complement of SCATTER: a midnight frame is patchy cold
//     glow in black water with no up.
//
// Magnitudes are set by the trails pass, not by taste. The pass subtracts
// 1.5/255 per frame from any channel below 8/255, so a STEADY emitter settles
// at max(emitted − (1.5/255)/k_effective, 0) while anything at or above 8/255 =
// 0.0314 is never touched at all. That leaves exactly one usable window for a
// dim water body: above the fade floor, below 0.0314 — and the two edges are a
// 4x brightness step apart, so a field that straddles the ceiling posterizes
// into hard plateaus. Neither colour reaches it at its strongest (BIO peaks at
// 0.030 over the plain, SCATTER at 0.0176 at 330 m). The `trails` column below
// widens the window from underneath by fading faster with depth — see its note.
//
// Why a camera-depth GATE on SCATTER (the one artifice here): with no gate the
// term would still be emitted at 120 m, and the spike scenes (?scene=, fixed
// at DEFAULT_DEPTH_M) would inherit it. Gated, both terms are exactly zero at
// and above 180 m, so every ?scene= frame is byte-identical to v3.3's. The
// cost is that the water fades IN between 180 and 330 m as you enter the
// twilight layer; the alternative (gating per screen ROW) makes the water
// brighter BELOW you in that band, which reads as light from the wrong
// direction and is far worse.
// In-scattered light (airlight). Absorption alone drives the red channel to
// exactly zero within tens of metres, which is what made the sunlit water read
// as saturated poster-cyan rather than as ocean. Light scattered back INTO the
// view path saturates with distance instead of decaying, so it refills the
// emptied channels and desaturates the result — the same term that makes
// distant hills pale rather than merely dark. Slightly blue-weighted because
// that is what water scatters, but with real red and green in it, which is the
// entire point.
export const AIRLIGHT = Object.freeze([0.0125, 0.0165, 0.0205]);
// Rate per metre: reaches ~63% of full at 60 m, so the shallow zone gets most
// of the desaturation and the abyss is untouched (it has no light to scatter).
export const AIRLIGHT_K = 0.0165;

export const SCATTER_COLOUR = Object.freeze([0.0027, 0.0105, 0.0176]);
export const SCATTER_K = 0.0028; // 1/m — the scattered component's own falloff
const SCATTER_IN_M = 180; // fades in from here...
const SCATTER_FULL_M = 330; // ...to here, then decays at SCATTER_K
export const BIO_COLOUR = Object.freeze([0.0042, 0.03, 0.026]);
const BIO_GATE = 0.1; // `bio` at NEUTRAL_DEPTH_M is 0.08, so this zeroes it there
const BIO_SHAPE = 0.85;

/** Strength of the scattered-daylight field for a camera at depthM, 0..1. The
 *  WITHIN-frame gradient is the same exponential continued per screen row —
 *  background.js multiplies by exp(-(rowDepth - depthM) * SCATTER_K), so the
 *  field is one exponential in absolute depth, merely switched on by the gate. */
export function scatterGlow(depthM) {
  const m = clampDepth(depthM);
  const fade = smoothstep01((m - SCATTER_IN_M) / (SCATTER_FULL_M - SCATTER_IN_M));
  if (fade <= 0) return 0;
  return fade * Math.exp(-Math.max(m - SCATTER_FULL_M, 0) * SCATTER_K);
}

/** Strength of the bioluminescent field, 0..1 — the consumer of `bio`. Takes a
 *  filled sample (or a raw bio weight). Zero at and above NEUTRAL_DEPTH_M. */
export function bioGlow(sample) {
  const b = typeof sample === 'number' ? sample : sample.bio;
  const t = Math.max(0, (b - BIO_GATE) / (1 - BIO_GATE));
  // Slight compression: the field has to clear the trails fade floor by 700 m
  // (or the twilight and the midnight zones are separated by a dead band) while
  // still arriving at the plain measurably brighter than the open water above.
  return Math.pow(t, BIO_SHAPE);
}

/** Per-channel transmittance from the surface down to depthM. */
export function transmittanceInto(depthM, out) {
  const d = clampDepth(depthM);
  out[0] = Math.exp(-EXTINCTION[0] * d);
  out[1] = Math.exp(-EXTINCTION[1] * d);
  out[2] = Math.exp(-EXTINCTION[2] * d);
  return out;
}

// ---- the art-directed profile (keyframed) ---------------------------------
// Physics gives the colour; these give the scene its dramaturgy. Each key is a
// full record and sampleDepth() smoothsteps between the two that bracket the
// requested depth, so the profile is continuous and reads as C1 in motion.
//
// Every multiplier is exactly 1 at NEUTRAL_DEPTH_M, so "depth modulates the
// weather preset" is a literal multiply-by-one on the default board.
//
//   caustics  x preset caustics intensity   (0 below 400 m: no shafts reach)
//   sedAlpha  x preset sediment intensity
//   sedFrac   fraction of the mote pool drawn (the world-space snow density)
//   fogScale  x uFogScale (the spare multiplier on the preset's uFogDensity)
//   tint      x preset uFogTint, per channel — red-first absorption again
//   shimmer   surface wave shimmer on the background's ceiling
//   glow      surface glow lobe strength
//   bio       bioluminescence weight — read through bioGlow() by background.js,
//             where it is the whole of the midnight zone's light (see above)
//   floor     how present the seabed haze is. NOTE (v3.7): this column is the
//             haze over the ABYSSAL PLAIN specifically — it is keyed to
//             absolute depth because in v3.4 the only seabed in the world was
//             the plain at 1200 m, so "deep" and "near the bottom" were the
//             same fact. They are not the same fact on a cross-shelf transect.
//             floorHaze() below is the real signal (height above the LOCAL
//             seabed) and sampleDepth takes the larger of the two, so the
//             plain is bit-identical and the shelf break and the slope stop
//             rendering as black.
//   trails    FADE-RATE multiplier on the preset's trailsK (see composeTrailsK)
//
// Why `trails` has to be depth-aware at all (integrator finding, and the most
// interesting interaction in v3.4): the trails pass subtracts its 1.5/255
// epsilon only BELOW 8/255, which is what makes a trail provably reach black.
// In v3.3 the water was always below that line, so every mote's tail hit the
// epsilon within a few frames and moving specks read as crisp dots. Sunlit
// water is ABOVE the line — so the epsilon never fires there and the same
// specks grow 40 px comet tails. The water being bright is exactly the point of
// the sunlit zone, so the trails have to get shorter to compensate: a fade-rate
// multiplier of ~3 in the top 40 m restores the crisp v3.3 read without
// touching any preset, and relaxes to 1.0 at the neutral depth where the water
// is dark again and the preset's own trail length is the whole look. The
// abyssal plain has the same problem for the same reason — the silt haze is
// bright enough to disable the epsilon — so the multiplier climbs again below
// 800 m, which is why marine snow over the seabed reads as snow and not as a
// field of comet tails.
//
// The mid-column values (300-1000 m) are set by the SAME interaction read from
// the other end. A steady emitter below 8/255 survives at emitted −
// (1.5/255)/k_effective, so the fade rate is what decides how dim the water is
// allowed to be before the pass crushes it to black: at the preset's own k the
// floor is 0.0235 linear (moonlit), which is most of the way to the 0.0314
// ceiling and leaves the SCATTER and BIO fields above no room to exist in. A
// multiplier of ~2-3 through the twilight and midnight zones drops that floor
// to ~0.010 and opens a usable 3x window, which is the whole dynamic range of
// the deep water. It costs trail LENGTH in water that has nothing bright
// moving through it anyway — marine snow reads as snow, not as comet tails,
// which is what it was already doing at both ends of the column.
//
// INTEGRATION TUNING — the `caustics` column. It used to hold 1.0 from the
// surface to 200 m, on the reasoning that "1.0 at 120 m == v3.3". That is true
// of the MULTIPLIER and false of the picture: v3.3's shafts were ~150 px of
// blob near the top of the frame, and v3.4's are authored in metres and are
// several screens long, so a flat 1.0 buried the mid-water in wedges. The curve
// now peaks at 60-90 m — where a shaft actually reads AS a shaft, with its
// mouth above you and its tip below — and falls off both ways: at the surface
// you are inside the light, not under a beam, and by 350 m there is nothing
// left to shaft. See also the shortened SHAFT_LEN_M in atmosphere/caustics.js.
const KEYS = [
  { m: 0, caustics: 0.22, sedAlpha: 0.45, sedFrac: 0.13, fogScale: 0.55, tint: [1.15, 1.0, 0.9], shimmer: 1.0, glow: 1.0, bio: 0.0, floor: 0, trails: 3.4 },
  { m: 40, caustics: 0.72, sedAlpha: 0.58, sedFrac: 0.2, fogScale: 0.66, tint: [1.16, 1.0, 0.9], shimmer: 0.8, glow: 0.88, bio: 0.02, floor: 0, trails: 3.0 },
  { m: 80, caustics: 1.0, sedAlpha: 0.74, sedFrac: 0.3, fogScale: 0.8, tint: [1.14, 1.01, 0.92], shimmer: 0.45, glow: 0.66, bio: 0.05, floor: 0, trails: 1.9 },
  { m: 120, caustics: 0.8, sedAlpha: 1.0, sedFrac: 0.52, fogScale: 1.0, tint: [1.0, 1.0, 1.0], shimmer: 0.22, glow: 0.42, bio: 0.08, floor: 0 , trails: 1.0 },
  { m: 200, caustics: 0.42, sedAlpha: 1.02, sedFrac: 0.57, fogScale: 1.1, tint: [1.1, 1.02, 0.96], shimmer: 0.04, glow: 0.18, bio: 0.13, floor: 0 , trails: 1.2 },
  { m: 300, caustics: 0.14, sedAlpha: 1.04, sedFrac: 0.6, fogScale: 1.18, tint: [1.14, 1.03, 0.94], shimmer: 0, glow: 0.08, bio: 0.18, floor: 0 , trails: 1.9 },
  { m: 400, caustics: 0.0, sedAlpha: 1.06, sedFrac: 0.64, fogScale: 1.3, tint: [1.24, 1.07, 0.92], shimmer: 0, glow: 0.03, bio: 0.23, floor: 0 , trails: 2.5 },
  { m: 500, caustics: 0.0, sedAlpha: 1.08, sedFrac: 0.68, fogScale: 1.45, tint: [1.36, 1.13, 0.9], shimmer: 0, glow: 0.012, bio: 0.34, floor: 0 , trails: 2.9 },
  { m: 800, caustics: 0.0, sedAlpha: 1.1, sedFrac: 0.72, fogScale: 1.85, tint: [1.7, 1.26, 0.86], shimmer: 0, glow: 0, bio: 0.6, floor: 0.04 , trails: 3.1 },
  { m: 1000, caustics: 0.0, sedAlpha: 1.12, sedFrac: 0.76, fogScale: 2.1, tint: [1.9, 1.33, 0.84], shimmer: 0, glow: 0, bio: 0.75, floor: 0.3 , trails: 3.0 },
  { m: 1120, caustics: 0.0, sedAlpha: 1.14, sedFrac: 0.8, fogScale: 2.35, tint: [2.0, 1.38, 0.83], shimmer: 0, glow: 0, bio: 0.95, floor: 0.8 , trails: 2.9 },
  { m: 1200, caustics: 0.0, sedAlpha: 1.15, sedFrac: 0.82, fogScale: 2.5, tint: [2.05, 1.4, 0.83], shimmer: 0, glow: 0, bio: 1.0, floor: 1.0 , trails: 2.9 },
];

function smoothstep01(t) {
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

// ---- the seabed haze, keyed to the LOCAL floor (v3.7) ----------------------
//
// THE BUG THIS FIXES. The `floor` column above is a function of absolute camera
// depth, which was correct for exactly as long as the world had one seabed and
// it sat at 1200 m. The transect gave the world a floor whose depth depends on
// where you are, and the two mechanisms that paint the seabed both kept keying
// off depth: crossing the shelf break at 150 m over 200 m of water produced
// floor = 0 (no haze) while the sun had been gone for 100 m, so the break and
// the whole continental slope — 13 km of the crossing, the part that is
// supposed to BE the crossing — rendered as an unbroken black field with no
// ground edge in it at all.
//
// The honest signal is HEIGHT ABOVE THE SEABED UNDER YOU, and the curve below
// is the old one re-read in those terms: over the 1200 m plain, h = 1200 - m,
// and this reproduces the KEYS column EXACTLY (0.04 at 400 m up, 0.30 at 200,
// 0.80 at 80, 1.00 on the bottom — and, because smoothstep(1-t) = 1-smoothstep(t),
// exactly at every point between them too). Nothing about the abyss moves.
//
// Two deliberate limits keep this a fix and not a new look:
//   * PROX_GAIN < 1 — the nepheloid layer over the flat plain, where the fines
//     settle, is thicker than the water over a slope they are still falling
//     down. sampleDepth takes max(depth-keyed, proximity), so the plain keeps
//     its own (larger) value and only the shelf/slope gain anything.
//   * the SUN GATE — above ~60 m the seabed is lit by daylight and needs no
//     haze to be visible (it is the one stretch of the transect that already
//     read correctly). Gating there means the shore and inner-shelf frames are
//     untouched, which is also what keeps the harness's brightest frames from
//     moving.
const FLOOR_PROX_KEYS = [
  [0, 1.0], [80, 0.8], [200, 0.3], [400, 0.04], [500, 0],
];
const FLOOR_PROX_GAIN = 0.55;
const FLOOR_SUN_M = 60; // above this the sun lights the ground; no haze term
const FLOOR_DARK_M = 140; // below this the haze term is at full weight
// ...and the trails-pass coupling that makes the haze SURVIVE, which is the
// second half of this fix and the reason the first draft measured almost
// nothing. The trails pass subtracts 1.5/255 per frame from any channel below
// 8/255, so a steady field settles at emitted − (1.5/255)/k_effective: the
// FADE RATE decides how dim a field is allowed to be before it is crushed to
// black. Over the abyssal plain the KEYS table already pays for this (trails
// 2.9-3.1 below 800 m, and the note above the table says so in as many words).
// At the shelf break the table is at ~1.15 — tuned for water whose brightness
// comes from the sun — so the erosion is (1.5/255)/0.10 ≈ 0.059 linear, which
// is larger than the entire haze: the term was being computed, written to the
// uniform, drawn, and then subtracted away frame by frame. Where the seabed
// haze is the ONLY light in the frame it gets the plain's fade rate and a
// little more, and only there: on the plain the depth-keyed floor is already
// the larger term, so `trails` is untouched and the abyss is unchanged.
const FLOOR_PROX_TRAILS = 4.2;
// ...and only in the SHALLOW regime. Below ~330 m the KEYS table has already
// climbed to 1.9-3.1 for exactly this reason and the deep water is calibrated
// against those numbers, so raising it there would shorten the marine-snow
// trails the twilight and the plain are tuned around. Above it the table is at
// its sunlit-water values (1.0-1.9), which is what erases a seabed haze that
// has no sun in it — the outer shelf and the top of the break.
const FLOOR_PROX_TRAILS_MAX_M = 330;

/**
 * How present the seabed haze is from PROXIMITY: 1 sitting on the bottom, 0
 * with half a kilometre of water under you. Pure, allocation-free.
 * @param {number} depthM        camera depth, metres below the surface
 * @param {number} seabedDepthM  depth of the seabed UNDER THE CAMERA, metres
 */
export function floorHaze(depthM, seabedDepthM) {
  const m = clampDepth(depthM);
  const sun = smoothstep01((m - FLOOR_SUN_M) / (FLOOR_DARK_M - FLOOR_SUN_M));
  return floorProximity(depthM, seabedDepthM) * sun * FLOOR_PROX_GAIN;
}

/**
 * HOW CLOSE the seabed is, 1 sitting on it and 0 with half a kilometre of
 * water under you — the same curve floorHaze() uses, WITHOUT the sun gate and
 * WITHOUT PROX_GAIN.
 *
 * The two are separate because they answer different questions and v3.7's
 * first draft asked only one of them. `floorHaze` says how much silt there is
 * to light up; this says WHERE THE GROUND IS ON SCREEN, which is pure geometry
 * — a horizontal plane h metres under the camera projects between the near
 * edge of the frame and the horizon, and how high it climbs depends on h and
 * on nothing else. Multiplying the height by the strength (which is what
 * background.js did, because it had only the one number) made the ground at
 * the shelf break sit at 23% of frame while the identical geometry over the
 * plain put it at 46% — the break's silt is thinner, not lower.
 *
 * @param {number} depthM        camera depth, metres below the surface
 * @param {number} seabedDepthM  depth of the seabed UNDER THE CAMERA, metres
 */
export function floorProximity(depthM, seabedDepthM) {
  const m = clampDepth(depthM);
  const bed = Number.isFinite(+seabedDepthM) ? +seabedDepthM : SEABED_DEPTH_M;
  const h = Math.max(bed - m, 0);
  const K = FLOOR_PROX_KEYS;
  if (h >= K[K.length - 1][0]) return 0;
  let i = 0;
  while (i < K.length - 2 && K[i + 1][0] < h) i++;
  const span = K[i + 1][0] - K[i][0];
  const e = smoothstep01(span > 0 ? (h - K[i][0]) / span : 0);
  return K[i][1] + (K[i + 1][1] - K[i][1]) * e;
}

// The seabed depth under the camera. The column module owns the profile; this
// module deliberately does not import an instance of it, so the source is
// injected the same way depthbands.js takes its units — setSeabedSource() from
// the integrator, or the column's own self-registration as a fallback so a
// browser path that forgets step 1 still works. Node/headless imports fall
// back to the nominal 1200 m plain, which is what every v3.6 caller assumed.
const bedSrc = { fn: null };

/**
 * Point this module at the seabed under the vessel. Optional — the column
 * registers itself and is auto-adopted below; this is the explicit wiring.
 * @param {function|object} src  column.floorDepth, or the column api itself
 */
export function setSeabedSource(src) {
  if (typeof src === 'function') bedSrc.fn = src;
  else if (src && typeof src.floorDepth === 'function') bedSrc.fn = () => src.floorDepth();
  else bedSrc.fn = null;
  return bedSrc.fn;
}

function localSeabedM() {
  let fn = bedSrc.fn;
  if (!fn) {
    // Re-checked (not memoised on a miss) because a background layer can be
    // built before the column registers itself; two property reads, no
    // allocation, and it stops the moment the column is there.
    const g = typeof globalThis !== 'undefined' ? globalThis : null;
    const col = g && g.__menagerie ? g.__menagerie.column : null;
    if (col && typeof col.floorDepth === 'function') {
      fn = () => col.floorDepth();
      bedSrc.fn = fn;
    }
  }
  if (!fn) return SEABED_DEPTH_M;
  const v = +fn();
  return Number.isFinite(v) && v > 0 ? v : SEABED_DEPTH_M;
}

/** A caller-owned record. Each layer keeps exactly one for its lifetime and
 *  re-fills it; sampleDepth() never allocates. */
export function createDepthSample() {
  return {
    depthM: DEFAULT_DEPTH_M,
    zone: zoneAt(DEFAULT_DEPTH_M),
    // physics
    transmit: new Float32Array(3), // surface -> here, per channel
    water: new Float32Array(3), // linear ambient water colour here
    daylight: 0, // luminance of transmit, 0..1
    // art-directed
    caustics: 1,
    sedAlpha: 1,
    sedFrac: 1,
    fogScale: 1,
    fogTint: new Float32Array(3),
    shimmer: 0,
    glow: 0,
    bio: 0,
    floor: 0,
    // ...and how high up the frame that haze reaches, 0..1, which is GEOMETRY
    // and not strength (see floorProximity). Always >= floor.
    floorTop: 0,
    // the seabed the `floor` term was resolved against, metres below the
    // surface — 1200 on the plain, 200 at the shelf break, 4 at the shore
    seabedM: SEABED_DEPTH_M,
    trails: 1,
  };
}

/**
 * @param {number} depthM        camera depth, metres below the surface
 * @param {object} out           a createDepthSample() record
 * @param {number} [seabedDepthM] the seabed under the camera. Omit and the
 *        injected/auto-adopted column answers; omit both and it is the nominal
 *        1200 m plain, which is exactly what every v3.6 caller assumed.
 */
export function sampleDepth(depthM, out, seabedDepthM) {
  const m = clampDepth(Number.isFinite(+depthM) ? +depthM : DEFAULT_DEPTH_M);
  out.depthM = m;
  out.zone = zoneAt(m);

  // bracket the keys (12 entries; a linear scan beats any cleverness)
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].m < m) i++;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const span = b.m - a.m;
  const e = smoothstep01(span > 0 ? (m - a.m) / span : 0);

  out.caustics = a.caustics + (b.caustics - a.caustics) * e;
  out.sedAlpha = a.sedAlpha + (b.sedAlpha - a.sedAlpha) * e;
  out.sedFrac = a.sedFrac + (b.sedFrac - a.sedFrac) * e;
  out.fogScale = a.fogScale + (b.fogScale - a.fogScale) * e;
  out.fogTint[0] = a.tint[0] + (b.tint[0] - a.tint[0]) * e;
  out.fogTint[1] = a.tint[1] + (b.tint[1] - a.tint[1]) * e;
  out.fogTint[2] = a.tint[2] + (b.tint[2] - a.tint[2]) * e;
  out.shimmer = a.shimmer + (b.shimmer - a.shimmer) * e;
  out.glow = a.glow + (b.glow - a.glow) * e;
  out.bio = a.bio + (b.bio - a.bio) * e;
  out.trails = a.trails + (b.trails - a.trails) * e;
  // The seabed haze is the LARGER of the abyssal-plain column (keyed to
  // absolute depth, and the plain's own value) and the local-floor proximity
  // term. Over the plain the two are equal by construction and the frame is
  // unchanged; over the shelf break and the slope only the second one exists,
  // which is the whole of the v3.7 fix. See floorHaze().
  const bed = Number.isFinite(+seabedDepthM) ? +seabedDepthM : localSeabedM();
  out.seabedM = bed;
  const keyed = a.floor + (b.floor - a.floor) * e;
  const prox = floorHaze(m, bed);
  // The haze's HEIGHT on screen: the ungained proximity, floored by the
  // depth-keyed column so the abyssal plain keeps exactly the height it had.
  // Over the plain `keyed` (0.93 at 1138 m) wins and nothing moves; over the
  // break and the slope the proximity term (0.86 hovering 50 m off the bed)
  // is what puts the ground where the ground actually is.
  const proxRaw = floorProximity(m, bed);
  out.floorTop = proxRaw > keyed ? proxRaw : keyed;
  if (prox > keyed) {
    out.floor = prox;
    // see FLOOR_PROX_TRAILS — the haze only survives the trails pass if the
    // fade is fast enough, and this branch is exactly "the floor is under me
    // but the depth column does not know about it", i.e. the shelf break and
    // the slope. On the plain the keyed term wins and nothing here runs.
    if (m < FLOOR_PROX_TRAILS_MAX_M && out.trails < FLOOR_PROX_TRAILS) {
      out.trails = FLOOR_PROX_TRAILS;
    }
  } else {
    out.floor = keyed;
  }

  transmittanceInto(m, out.transmit);
  out.water[0] = SURFACE_LIGHT[0] * out.transmit[0];
  out.water[1] = SURFACE_LIGHT[1] * out.transmit[1];
  out.water[2] = SURFACE_LIGHT[2] * out.transmit[2];
  out.daylight =
    0.2126 * out.transmit[0] + 0.7152 * out.transmit[1] + 0.0722 * out.transmit[2];
  return out;
}

// ---- composing depth with the weather presets -----------------------------
// The rule everywhere in v3.4: depth MULTIPLIES the preset, it never replaces
// it. A preset switch still crossfades exactly as it did (controls.js owns the
// fade); depth is applied on top of the already-faded value, after
// controls.tick(). Both operands are continuous, so a preset change mid-dive
// crossfades and the dive still reads through it.
//
// Fog: the preset owns uFogDensity and uFogTint; depth rides the spare
// uFogScale multiplier and multiplies the tint per channel.
export function composeFogScale(sample) {
  return sample.fogScale;
}

/**
 * Trails: the preset owns the LOOK (how streaky this weather is); depth owns
 * how fast that streak has to die so it stays a streak and not a smear. The
 * composition is in the right space — trailsK is a per-60th-of-a-second fade
 * FRACTION, so the frame-rate-independent way to "decay N times faster" is to
 * raise the retained fraction to the Nth power, not to scale k. At sample.trails
 * = 1 this is the identity, exactly.
 */
export function composeTrailsK(presetK, sample) {
  const k = Math.min(Math.max(+presetK || 0, 0), 0.995);
  const mul = sample && sample.trails > 0 ? sample.trails : 1;
  if (mul === 1) return k;
  return Math.min(1 - Math.pow(1 - k, mul), 0.995);
}

export function composeFogTintInto(presetTint, sample, out) {
  // out may be a THREE.Vector3 (has .set) or any 3-slot array.
  const r = presetTint[0] * sample.fogTint[0];
  const g = presetTint[1] * sample.fogTint[1];
  const b = presetTint[2] * sample.fogTint[2];
  if (typeof out.set === 'function') out.set(r, g, b);
  else {
    out[0] = r;
    out[1] = g;
    out[2] = b;
  }
  return out;
}

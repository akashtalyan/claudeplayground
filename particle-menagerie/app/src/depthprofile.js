// The vertical water column — v3.4's ONE shared place for
//   (a) the metres <-> world-px unit conversion,
//   (b) the extent of the column (surface plane .. abyssal seabed), and
//   (c) the depth -> scene-values map that the background and the atmosphere
//       layers read every frame.
//
// Why one file: the board, the camera, the depth gauge and every atmosphere
// layer must agree on what "-640 m" means in world px or the column silently
// shears apart. Nothing here imports three or touches the DOM, so column.js /
// main.js / the gauge UI can all import it without a cycle.
//
// UNITS. main.js maps the z = 0 plane 1:1 to CSS pixels, so "world px" is the
// scene's native length. One world px = METRES_PER_PX metres of sea water.
// 0.12 m/px puts the 1200 m column at 10 000 world px — a little under twelve
// 840-px screens, so a full descent is a journey, not a scroll.
//
// SIGN CONVENTION. Depth is metres relative to the surface and is NEGATIVE
// below it: 0 at the surface, -1200 at the seabed. World y follows the same
// sign (y = depth * PX_PER_METRE), so the surface plane sits at y = 0 and the
// seabed at y = -10000. `depthM` in every API below is that negative number.
//
// Determinism: pure functions of depth, no RNG, no clock. Allocation: every
// sampling entry point writes into a caller-owned scratch record
// (createDepthSample()) — nothing here allocates on a frame path.

// ---- units + extent -------------------------------------------------------

export const METRES_PER_PX = 0.12;
export const PX_PER_METRE = 1 / METRES_PER_PX; // 8.333…

export const SURFACE_M = 0;
export const SEABED_M = -1200;

export const SURFACE_Y = SURFACE_M * PX_PER_METRE; // 0
export const SEABED_Y = SEABED_M * PX_PER_METRE; // -10000
export const COLUMN_PX = SURFACE_Y - SEABED_Y; // 10000

// Where a fresh board sits: mid-water, deep enough that the surface is well
// overhead and shallow enough that the moon shafts still reach. Chosen so the
// whole depth-driven stack is IDENTITY here — at -160 m the fog scale is 1,
// the fog tint is [1,1,1], the caustics multiplier is 1 and the sediment alpha
// multiplier is 1, i.e. the v3.3 look is exactly reproduced. Move this and the
// default board changes appearance.
export const DEFAULT_DEPTH_M = -160;
export const NEUTRAL_DEPTH_M = -160; // the identity point of the profile

// Camera travel limits. The camera may not rise through the surface (the
// scene has no above-water render) nor sink through the floor.
export const MIN_DEPTH_M = -6; // just under the surface film
export const MAX_DEPTH_M = -1196; // just off the seabed

export function clampDepthM(m) {
  const v = +m;
  if (!Number.isFinite(v)) return DEFAULT_DEPTH_M;
  return v > MIN_DEPTH_M ? MIN_DEPTH_M : v < MAX_DEPTH_M ? MAX_DEPTH_M : v;
}

// world y of a depth, and back
export function yOfDepth(m) {
  return m * PX_PER_METRE;
}
export function depthOfY(y) {
  return y * METRES_PER_PX;
}
// Signed world-px offset from one depth to another (positive = the target is
// above). Layers use this to place the surface / seabed relative to the
// camera without needing the camera object.
export function offsetPxTo(fromDepthM, toDepthM) {
  return (toDepthM - fromDepthM) * PX_PER_METRE;
}

// ---- zones ----------------------------------------------------------------
// Oceanography, compressed to a 1200 m column. Exported for the depth gauge:
// the readout wants a word as well as a number.
export const DEPTH_ZONES = [
  { id: 'sunlit', label: 'sunlit', topM: 0, bottomM: -80 },
  { id: 'twilight', label: 'twilight', topM: -80, bottomM: -500 },
  { id: 'midnight', label: 'midnight', topM: -500, bottomM: -1000 },
  { id: 'seabed', label: 'abyssal plain', topM: -1000, bottomM: -1200 },
];

export function zoneAt(m) {
  for (let i = 0; i < DEPTH_ZONES.length; i++) {
    if (m > DEPTH_ZONES[i].bottomM) return DEPTH_ZONES[i];
  }
  return DEPTH_ZONES[DEPTH_ZONES.length - 1];
}

// "160 m" — the gauge's own formatting lives with the units it formats.
export function formatDepthM(m) {
  return Math.round(-clampDepthM(m)) + ' m';
}

// ---- water optics (physical part) -----------------------------------------
// Beer–Lambert extinction per metre, per channel. The ORDER is the physics
// that matters: sea water eats red first, then green, and blue travels
// furthest — which is why a deep sea is blue-black and never brown. The
// magnitudes are compressed from real clear-ocean coefficients (red ~0.35/m
// would kill red inside 15 m) so the whole 1200 m column stays legible; the
// ratios are kept in the real order kR >> kG > kB.
export const EXTINCTION = Object.freeze([0.045, 0.0165, 0.008]);

// Downwelling light AT the surface, in linear light, pre-exposure — this is a
// night ocean, so "brightest" is still dim. The final ACES+sRGB pass is the
// only tonemap (frame-graph rule 2); nothing here encodes.
//
// Calibration note (why these numbers and not "whatever looks bright"): the
// trails pass subtracts a 1.5/255 epsilon per frame below 8/255, so a STEADY
// emitter only survives above eps/(1 − fadeK) — 0.0235 linear under the
// moonlit preset, 0.0062 under ink. That is a hard black floor the background
// sits against. These values put the sunlit zone above it (the upper ~100 m
// visibly glows) and mid-water below it (the default board's water stays the
// near-black v3.3 water), which is both the calibration that keeps v3.3
// unchanged at the default depth and, happily, the truth about night water.
export const SURFACE_LIGHT = Object.freeze([0.022, 0.04, 0.055]);

// The lobe of moon/sky light that reads as "the surface, above you". Peaks
// around 165-205/255 after ACES at the app's 3.4 exposure: a bright silver
// ceiling, deliberately short of blowout since bloom smears it further.
export const SURFACE_GLOW = Object.freeze([0.02, 0.026, 0.032]);

// Abyssal sediment floor — warm-neutral silt against the cold water. Above the
// moonlit epsilon floor (see above) by design, or the seabed would render as
// the same black as the water and the column would end in nothing.
export const FLOOR_COLOUR = Object.freeze([0.038, 0.035, 0.03]);

// transmittance from the surface down to depthM, per channel
export function transmittanceInto(depthM, out) {
  const d = -clampDepthM(depthM);
  out[0] = Math.exp(-EXTINCTION[0] * d);
  out[1] = Math.exp(-EXTINCTION[1] * d);
  out[2] = Math.exp(-EXTINCTION[2] * d);
  return out;
}

// ---- the art-directed profile (keyframed) ---------------------------------
// Physics gives colour; these give the scene its dramaturgy. Each key is a
// full record and sampleDepth() smoothsteps between the two that bracket the
// requested depth, so the profile is C0 and visually C1-ish everywhere.
//
// Every multiplier is exactly 1 at NEUTRAL_DEPTH_M so "depth modulates the
// weather preset" is a true multiply-by-one at the default board.
//
//   caustics  x preset caustics intensity   (0 below -400 m: no shafts reach)
//   sedAlpha  x preset sediment intensity
//   sedFrac   fraction of the mote pool drawn (world-space density)
//   fogScale  x uFogScale (spare multiplier on the preset's uFogDensity)
//   tint      x preset uFogTint, per channel — red-first absorption again
//   shimmer   surface wave shimmer on the background ceiling
//   glow      surface glow lobe strength
//   bio       bioluminescence weight (deep creatures / plankton — integrator)
//   floor     how present the seabed haze is
const KEYS = [
  //         m     caustics sedAlpha sedFrac fogScale        tint          shimmer glow  bio  floor
  { m: 0, caustics: 1.0, sedAlpha: 0.45, sedFrac: 0.13, fogScale: 0.55, tint: [1.15, 1.0, 0.9], shimmer: 1.0, glow: 1.0, bio: 0.0, floor: 0 },
  { m: -40, caustics: 1.0, sedAlpha: 0.58, sedFrac: 0.2, fogScale: 0.66, tint: [1.16, 1.0, 0.9], shimmer: 0.8, glow: 0.88, bio: 0.02, floor: 0 },
  { m: -80, caustics: 1.0, sedAlpha: 0.74, sedFrac: 0.3, fogScale: 0.8, tint: [1.14, 1.01, 0.92], shimmer: 0.42, glow: 0.62, bio: 0.05, floor: 0 },
  { m: -160, caustics: 1.0, sedAlpha: 1.0, sedFrac: 0.52, fogScale: 1.0, tint: [1.0, 1.0, 1.0], shimmer: 0.08, glow: 0.26, bio: 0.1, floor: 0 },
  { m: -300, caustics: 0.62, sedAlpha: 1.04, sedFrac: 0.6, fogScale: 1.18, tint: [1.14, 1.03, 0.94], shimmer: 0, glow: 0.08, bio: 0.18, floor: 0 },
  { m: -400, caustics: 0.0, sedAlpha: 1.06, sedFrac: 0.64, fogScale: 1.3, tint: [1.24, 1.07, 0.92], shimmer: 0, glow: 0.03, bio: 0.23, floor: 0 },
  { m: -500, caustics: 0.0, sedAlpha: 1.08, sedFrac: 0.68, fogScale: 1.45, tint: [1.36, 1.13, 0.9], shimmer: 0, glow: 0.012, bio: 0.3, floor: 0 },
  { m: -800, caustics: 0.0, sedAlpha: 1.16, sedFrac: 0.8, fogScale: 1.85, tint: [1.7, 1.26, 0.86], shimmer: 0, glow: 0, bio: 0.55, floor: 0.04 },
  { m: -1000, caustics: 0.0, sedAlpha: 1.24, sedFrac: 0.9, fogScale: 2.1, tint: [1.9, 1.33, 0.84], shimmer: 0, glow: 0, bio: 0.75, floor: 0.3 },
  { m: -1120, caustics: 0.0, sedAlpha: 1.34, sedFrac: 0.97, fogScale: 2.35, tint: [2.0, 1.38, 0.83], shimmer: 0, glow: 0, bio: 0.9, floor: 0.8 },
  { m: -1200, caustics: 0.0, sedAlpha: 1.4, sedFrac: 1, fogScale: 2.5, tint: [2.05, 1.4, 0.83], shimmer: 0, glow: 0, bio: 1.0, floor: 1.0 },
];

function smoothstep01(t) {
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

// A caller-owned record. Layers keep exactly one of these for the lifetime of
// the module and re-fill it; sampleDepth never allocates.
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
  };
}

export function sampleDepth(depthM, out) {
  const m = clampDepthM(depthM);
  out.depthM = m;
  out.zone = zoneAt(m);

  // -- bracket the keys (11 entries; a linear scan beats any cleverness) --
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].m > m) i++;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const span = a.m - b.m;
  const e = smoothstep01(span > 0 ? (a.m - m) / span : 0);

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
  out.floor = a.floor + (b.floor - a.floor) * e;

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
// fade); depth is applied on top of the faded value, after controls.tick().
//
// Fog: the preset owns uFogDensity and uFogTint; depth rides the spare
// uFogScale multiplier and multiplies the tint per channel.
export function composeFogScale(sample) {
  return sample.fogScale;
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

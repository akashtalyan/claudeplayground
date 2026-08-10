// Bioluminescence — v3.7. The creatures that make their own light.
//
// The app has always rendered every animal AS light. That was never the same
// claim as an animal that MAKES light, and until now nothing distinguished the
// two: a dolphin at 20 m and an anglerfish at 900 m were both lit by the same
// uLightDir, and both were dimmed by the same water. In the midnight zone,
// where the depth profile has correctly extinguished the sun, that is the only
// distinction left — everything you can see down there is either making light
// or standing next to something that is.
//
// This module is the DATA HALF of that: species -> pattern, colour, strength.
// The RENDERING half is the uBio block in src/shaders/dots.js, which owns the
// three physical properties that make emission emission (no light direction,
// no attenuation by the water ABOVE the animal, attenuation by the water in
// FRONT of it) and the five patterns below. Nothing here touches three.js, the
// DOM, a clock or an RNG — it is pure data plus pure functions, node-importable
// exactly like depthbands.js and oceandata.js, and it is deterministic by
// construction: the same name yields the same light on every machine, so the
// same URL hash still reproduces the same board.
//
// WHAT THE INTEGRATOR CALLS
//   bioForSpec(spec)                 -> record | null   (once, at spawn)
//   applyBio(material, rec, opts)    -> boolean         (writes the uniforms)
//   clearBio(material)                                  (back to v3.6 exactly)
//   setBioMaster(globalUniforms, g)                     (one global dimmer)
//   bioDepthGain(depthM)             -> 0..1            (optional, see below)
//   describeBio(rec) / bioNoteFor(name)                 (for the inspector)
//
// THE FIVE PATTERNS, and why these five
//   ROWS   photophore rows along the flank and belly. COUNTER-ILLUMINATION:
//          the animal matches the dim light coming down from above so that
//          nothing beneath it sees a silhouette. This is the commonest use of
//          light in the ocean — hatchetfish, lanternfish, most mesopelagic
//          squid, lanternsharks — and it is the reason the rows are AIMED
//          (uBioAim) rather than painted all over.
//   LURE   one hot point held off the head. An anglerfish's esca is not even
//          its own light: it is a colony of symbiotic bacteria in a pouch.
//          Dragonfish carry theirs on a chin barbel.
//   PULSE  a whole-body flash, or Atolla wyvillei's "burglar alarm": a wave of
//          light spinning around the bell to call in something big enough to
//          eat whatever is currently eating the jelly.
//   GLOW   a diffuse field. Dinoflagellates flashing in sheared water; the
//          crystal jelly's ring, whose green fluorescent protein is the GFP in
//          every biology lab on earth.
//
// COLOUR, and the exceptions
//   Sea water transmits blue-green furthest (see EXTINCTION in
//   depthprofile.js: red first, then green, blue last), so almost everything
//   in the open ocean emits at ~470-490 nm and almost everything down there
//   sees best at ~480 nm. That is the default here, and it is a physical
//   default, not a stylistic one. The documented exceptions are honoured
//   rather than flattened into cyan: the dragonfishes (Malacosteus,
//   Aristostomias) carry a suborbital organ that emits deep RED, which almost
//   nothing else in the deep sea can see — a private torch; Tomopteris, a
//   pelagic polychaete, is one of the very few animals whose light is YELLOW;
//   the crystal jelly and several ophiuroids are green.
//
// HONESTY (the rules oceandata.js sets, applied to this table)
//   * A record is marked `real: false` when the ANIMAL is invented (dragon,
//     kraken, wraith). Those get light because they live in the dark half of
//     the column and it would be strange if they did not, but the record says
//     out loud that this is decoration, not zoology.
//   * `lit: false` records exist on purpose — coral, the man o' war, the
//     common octopus. They carry a note and no light, so the inspector can say
//     "makes no light of its own" instead of implying everything glows. What
//     corals do under blue light is FLUORESCENCE: they re-emit light that
//     arrived from somewhere else, which is a different phenomenon and does
//     not belong in an additive emissive layer.
//   * Researched fields win. If src/data/ocean-data.json grows bioNote /
//     bioColour / bioPattern for a species, those override this table, which
//     is a curated fallback and says so via `source`.
//
// BUDGET (frame-graph, and the two harness bounds this must not break)
//   The emission is additive and rides in the same alpha as everything else,
//   so it is divided by the small-creature merge correction and by the DOF
//   1/k^2 automatically. The shader clamps emitted radiance at BIO_MAX = 3.0
//   per channel; the strengths below are chosen so a whole-body pattern adds
//   at most ~0.5 to a dot whose lit value is ~0.5-1.5, and only the LURE — a
//   handful of dots per creature — is allowed to be hot. The pileup blowout
//   bound (8% of pixels fully white) and the trails soak bound are budgets
//   this layer spends a sliver of, not headroom it may take.

import { RAW, speciesKeyFor } from './oceandata.js';

// ---------------------------------------------------------------------------
// The pattern modes — the contract with shaders/dots.js
// ---------------------------------------------------------------------------
// These five numbers are duplicated as consts in the vertex shader (BIO_ROWS
// ... BIO_ROWS_LURE). They are a frozen interface: append, never renumber.

export const BIO = Object.freeze({
  OFF: 0,
  ROWS: 1,
  LURE: 2,
  PULSE: 3,
  GLOW: 4,
  ROWS_LURE: 5,
});

export const PATTERN_NAMES = Object.freeze([
  'dark',
  'photophore rows',
  'lure',
  'pulse',
  'glow',
  'rows + lure',
]);

/** The wavelength most marine bioluminescence sits at, in nanometres. */
export const BLUE_GREEN_NM = 480;

// ---------------------------------------------------------------------------
// Wavelength -> linear sRGB
// ---------------------------------------------------------------------------
//
// Emission spectra are the honest way to carry "blue-green (~480 nm)" through
// to a pixel, and they make the exceptions fall out for free instead of being
// hand-picked hex codes. The CIE colour-matching functions are the multi-lobe
// Gaussian fits of Wyman, Sloan & Shirley (JCGT 2013) — a few hundred bytes of
// arithmetic instead of a 471-row table, well inside the accuracy anything
// here needs.
//
// Real emission is a BAND, not a line: bioluminescent spectra run 50-90 nm
// wide at half maximum. Integrating over that band (DEFAULT_FWHM) matters —
// a monochromatic 480 nm is an impossibly saturated laser line, while the
// integrated band is the believable cyan a camera actually records.
//
// The result is normalised so the largest channel is 1.0: this function
// returns a HUE, and strength is a separate number everywhere in this module.

const DEFAULT_FWHM = 60;

// g(x; mu, sigma1, sigma2) — a Gaussian with different widths either side
function lobe(x, mu, s1, s2) {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}

function addXYZ(nm, w, out) {
  out[0] += w * (1.056 * lobe(nm, 599.8, 37.9, 31.0)
    + 0.362 * lobe(nm, 442.0, 16.0, 26.7)
    - 0.065 * lobe(nm, 501.1, 20.4, 26.2));
  out[1] += w * (0.821 * lobe(nm, 568.8, 46.9, 40.5)
    + 0.286 * lobe(nm, 530.9, 16.3, 31.1));
  out[2] += w * (1.217 * lobe(nm, 437.0, 11.8, 36.0)
    + 0.681 * lobe(nm, 459.0, 26.0, 13.8));
}

// module-scope scratch: the spectral integral allocates nothing per call
const XYZ = [0, 0, 0];

/**
 * A dominant wavelength as a linear-sRGB hue, largest channel 1.0.
 *
 * @param {number} nm      dominant wavelength, 380..780
 * @param {number[]} [out] 3-slot destination (a fresh array if omitted)
 * @param {object} [opts]  fwhm: emission bandwidth in nm (default 60; 0 = a
 *                         monochromatic line). desat: 0..1 mix toward white,
 *                         for a source bright enough to bleach its own hue.
 */
export function wavelengthToLinear(nm, out, opts) {
  const o = out || [0, 0, 0];
  const lambda = Math.min(Math.max(+nm || BLUE_GREEN_NM, 360), 830);
  const fwhm = opts && opts.fwhm != null ? Math.max(+opts.fwhm || 0, 0) : DEFAULT_FWHM;
  XYZ[0] = 0;
  XYZ[1] = 0;
  XYZ[2] = 0;
  if (fwhm <= 0) {
    addXYZ(lambda, 1, XYZ);
  } else {
    // 21 samples over +/-2.5 sigma — the band is smooth, this is plenty
    const sigma = fwhm / 2.3548;
    let wsum = 0;
    for (let i = -10; i <= 10; i++) {
      const w = Math.exp(-0.125 * i * i); // exp(-0.5 * (i/2)^2)
      wsum += w;
      addXYZ(lambda + i * sigma * 0.5, w, XYZ);
    }
    XYZ[0] /= wsum;
    XYZ[1] /= wsum;
    XYZ[2] /= wsum;
  }
  // XYZ (D65) -> linear sRGB. Spectral colours fall outside the sRGB gamut, so
  // negative channels are clamped: the hue stays, the impossible saturation
  // does not.
  let r = 3.2406 * XYZ[0] - 1.5372 * XYZ[1] - 0.4986 * XYZ[2];
  let g = -0.9689 * XYZ[0] + 1.8758 * XYZ[1] + 0.0415 * XYZ[2];
  let b = 0.0557 * XYZ[0] - 0.204 * XYZ[1] + 1.057 * XYZ[2];
  r = r > 0 ? r : 0;
  g = g > 0 ? g : 0;
  b = b > 0 ? b : 0;
  const mx = Math.max(r, g, b, 1e-6);
  r /= mx;
  g /= mx;
  b /= mx;
  const d = opts && opts.desat ? Math.min(Math.max(opts.desat, 0), 1) : 0;
  o[0] = r + (1 - r) * d;
  o[1] = g + (1 - g) * d;
  o[2] = b + (1 - b) * d;
  return o;
}

// Spawn-path memo: the table has a dozen distinct wavelengths and every
// creature asks for one of them.
const spectra = new Map();

function hueFor(nm) {
  const key = Math.round(nm);
  let hit = spectra.get(key);
  if (!hit) {
    hit = Object.freeze(wavelengthToLinear(key, [0, 0, 0]));
    spectra.set(key, hit);
  }
  return hit;
}

// ---------------------------------------------------------------------------
// Colour parsing — what a researched `bioColour` field may say
// ---------------------------------------------------------------------------
//
// The research path records prose ("blue-green (~470-490 nm)"), and prose is
// what this has to survive. A number inside the visible range always wins,
// because a wavelength is the most specific thing a source can give; then a
// hex code; then a colour word.

const NAMED_NM = Object.freeze({
  violet: 420,
  'blue-violet': 450,
  blue: 470,
  'blue-green': 480,
  bluegreen: 480,
  cyan: 487,
  turquoise: 495,
  'green-blue': 495,
  green: 505,
  'yellow-green': 545,
  yellowgreen: 545,
  yellow: 565,
  amber: 585,
  orange: 595,
  red: 700,
  'deep red': 705,
});

// longest first, so "blue-green" is not eaten by "blue"
const NAMED_KEYS = Object.freeze(Object.keys(NAMED_NM).sort((a, b) => b.length - a.length));

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Anything a species record might carry as a colour -> { rgb, nm }.
 * Returns null when nothing usable is present — a caller then keeps the
 * blue-green default rather than inventing a colour.
 *
 *   [0.1, 0.9, 1]        already linear rgb
 *   480 / '480 nm'       a wavelength
 *   '#66e0ff'            an sRGB hex
 *   'blue-green'         a colour word
 *   'blue-green, ~480nm' both — the number wins
 */
export function parseBioColour(value) {
  if (value == null) return null;
  if (Array.isArray(value) && value.length >= 3) {
    const mx = Math.max(Math.abs(value[0]), Math.abs(value[1]), Math.abs(value[2]), 1e-6);
    return { rgb: [value[0] / mx, value[1] / mx, value[2] / mx], nm: null };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 360 && value <= 830
      ? { rgb: hueFor(value).slice(), nm: value }
      : null;
  }
  if (typeof value !== 'string') return null;
  const s = value.toLowerCase();
  const num = s.match(/(\d{3}(?:\.\d+)?)\s*(?:nm)?/);
  if (num) {
    const nm = parseFloat(num[1]);
    if (nm >= 360 && nm <= 830) return { rgb: hueFor(nm).slice(), nm };
  }
  const hex = s.match(/#?([0-9a-f]{6})\b/);
  if (hex) {
    const v = parseInt(hex[1], 16);
    const rgb = [
      srgbToLinear(((v >> 16) & 255) / 255),
      srgbToLinear(((v >> 8) & 255) / 255),
      srgbToLinear((v & 255) / 255),
    ];
    const mx = Math.max(rgb[0], rgb[1], rgb[2], 1e-6);
    return { rgb: [rgb[0] / mx, rgb[1] / mx, rgb[2] / mx], nm: null };
  }
  for (const k of NAMED_KEYS) {
    if (s.indexOf(k) >= 0) {
      const nm = NAMED_NM[k];
      return { rgb: hueFor(nm).slice(), nm };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------
//
//   pattern      BIO.* — the shader's uBio.y
//   patternName  a word for the inspector
//   strength     master emissive strength (uBio.x)
//   rate         Hz of the pattern's own time — slow. Nothing down there
//                strobes; a lure twitches, an alarm turns, a row breathes.
//   param        pattern parameter (uBio.w):
//                  ROWS  lamps along the whole body (a pitch, not a count of
//                        lit dots — the geometry decides how many dots land on
//                        each lamp)
//                  PULSE 0 = a wave down the body, 1 = a spinning sector
//                  GLOW  0 = one even sheet, 1 = all per-cell sparkle
//   aim          [x,y,z] body-fixed unit direction the rows sit on. Local -Y
//                is the belly for every archetype in the registry (fish and
//                eel bodies run head at -X with dorsal +Y; bells stand on +Y).
//   spread       angular width of that band (0.25 tight, 0.8 broad)
//   lureDir      [x,y,z] body-fixed unit direction the lure hangs in
//   lureFrac     the aRing fraction that is the lure's station: positive from
//                the head/root end, negative from the tail/tip end
//   colour       [r,g,b] linear hue of the body light
//   lureColour   [r,g,b] linear, ALREADY scaled by the lure's own gain — a red
//                dragonfish barbel over a blue-green body is two organs, not
//                one tinted animal
//   nm/lureNm    dominant wavelengths, or null when a source gave only a hex
//   note         one honest line
//   lit          false for a documented dark animal (record exists, no light)
//   real         false when the ANIMAL is invented
//   source       'data' | 'curated' | 'inferred'

const DEFAULTS = Object.freeze({
  strength: 0.85,
  rate: 0.12,
  param: 18,
  aim: Object.freeze([0, -1, 0]),
  spread: 0.55,
  lureDir: Object.freeze([-0.55, 0.83, 0]),
  lureFrac: 0.06,
  lureGain: 2.4,
  nm: BLUE_GREEN_NM,
  lureNm: null,
  note: '',
  lit: true,
  real: true,
  source: 'curated',
});

function unit(v, fallback) {
  if (!Array.isArray(v) || v.length < 3) return fallback;
  const l = Math.hypot(v[0], v[1], v[2]);
  if (!(l > 1e-6)) return fallback;
  return Object.freeze([v[0] / l, v[1] / l, v[2] / l]);
}

function make(pattern, over) {
  const o = { ...DEFAULTS, ...(over || {}) };
  const nm = o.nm;
  const lureNm = o.lureNm != null ? o.lureNm : nm;
  const colour = o.rgb ? o.rgb : hueFor(nm);
  const lureHue = o.lureRgb ? o.lureRgb : hueFor(lureNm);
  const gain = Math.max(o.lureGain, 0);
  const lit = pattern !== BIO.OFF && o.lit !== false;
  return Object.freeze({
    pattern: lit ? pattern : BIO.OFF,
    patternName: PATTERN_NAMES[lit ? pattern : BIO.OFF],
    strength: lit ? o.strength : 0,
    rate: o.rate,
    param: o.param,
    aim: unit(o.aim, DEFAULTS.aim),
    spread: o.spread,
    lureDir: unit(o.lureDir, DEFAULTS.lureDir),
    lureFrac: o.lureFrac,
    colour: Object.freeze(colour.slice ? colour.slice() : [colour[0], colour[1], colour[2]]),
    lureColour: Object.freeze([lureHue[0] * gain, lureHue[1] * gain, lureHue[2] * gain]),
    nm: o.rgb ? o.nmHint ?? null : nm,
    lureNm: o.lureRgb ? null : lureNm,
    note: o.note,
    lit,
    real: o.real !== false,
    source: o.source,
    key: o.key || null,
  });
}

// pattern shorthands — the table below reads as prose because of these
const rows = (over) => make(BIO.ROWS, { strength: 0.9, rate: 0.1, param: 18, ...over });
const lure = (over) => make(BIO.LURE, { strength: 1.0, rate: 0.22, param: 0, ...over });
const pulse = (over) => make(BIO.PULSE, { strength: 0.8, rate: 0.3, param: 0, ...over });
const glow = (over) => make(BIO.GLOW, { strength: 0.5, rate: 0.09, param: 0.35, ...over });
const rowsLure = (over) => make(BIO.ROWS_LURE, { strength: 0.85, rate: 0.16, param: 16, ...over });
const dark = (note, over) => make(BIO.OFF, { note, lit: false, ...over });

// ---------------------------------------------------------------------------
// The species table
// ---------------------------------------------------------------------------
//
// Keyed on lexicon words (src/lexicon.js LEX) first, because those are the
// words a user can actually summon, plus the famous deep-sea names a user is
// likely to TYPE even though the lexicon has no archetype for them — a typed
// "dragonfish" still resolves here and still gets its red barbel, whatever
// body the archetype hash hands it.

export const BIO_SPECIES = Object.freeze({
  // ---- the deep fish -----------------------------------------------------
  anglerfish: lure({
    strength: 1.1, nm: 480, lureNm: 485, lureGain: 2.4, rate: 0.19,
    note: 'the esca is not the fish’s own light — it is a pouch of symbiotic bacteria',
  }),
  angler: lure({
    strength: 1.1, nm: 480, lureNm: 485, lureGain: 2.4, rate: 0.19,
    note: 'the esca is not the fish’s own light — it is a pouch of symbiotic bacteria',
  }),
  dragonfish: rowsLure({
    strength: 0.85, nm: 480, lureNm: 705, lureGain: 2.2, param: 15, rate: 0.14,
    lureDir: [-0.7, -0.5, 0],
    note: 'a red torch below the eye — almost nothing else in the deep can see red',
  }),
  viperfish: rowsLure({
    strength: 0.9, nm: 480, lureNm: 482, param: 20, rate: 0.15,
    lureDir: [-0.35, 0.93, 0], lureFrac: 0.05,
    note: 'photophore rows along the belly, a lure on the first dorsal ray',
  }),
  lanternfish: rows({ strength: 1.0, nm: 480, param: 22, note: 'the most numerous vertebrates on earth, and every one of them lit' }),
  myctophid: rows({ strength: 1.0, nm: 480, param: 22, note: 'the most numerous vertebrates on earth, and every one of them lit' }),
  hatchetfish: rows({
    strength: 1.15, nm: 485, param: 13, spread: 0.42,
    note: 'ventral lamps tuned to the light above, so nothing below sees a silhouette',
  }),
  flashlightfish: lure({
    strength: 1.0, nm: 490, lureGain: 2.2, rate: 0.55, lureDir: [-0.8, 0.35, 0], lureFrac: 0.08,
    note: 'a bacterial lamp under each eye, blinked with a lid of skin',
  }),
  lanternshark: rows({ strength: 0.8, nm: 486, param: 16, spread: 0.7, note: 'counter-illuminated along the belly and flanks' }),
  cookiecutter: rows({
    strength: 0.85, nm: 480, param: 12, spread: 0.75,
    note: 'lit all over except a dark collar, which from below reads as a small fish',
  }),
  // the fish archetype's spectral names live where the light gives out
  ghost: glow({ strength: 0.4, nm: 484, param: 0.3, real: false, note: 'invented — given the light the water at its depth would have' }),
  phantom: glow({ strength: 0.4, nm: 484, param: 0.3, real: false, note: 'invented — given the light the water at its depth would have' }),
  wraith: glow({ strength: 0.42, nm: 478, param: 0.3, real: false, note: 'invented — given the light the water at its depth would have' }),
  spirit: glow({ strength: 0.4, nm: 484, param: 0.3, real: false, note: 'invented — given the light the water at its depth would have' }),

  // ---- cephalopods -------------------------------------------------------
  squid: rows({
    strength: 0.85, nm: 470, param: 14, spread: 0.7,
    note: 'photophores down the mantle and arms, matched to the light above',
  }),
  fireflysquid: rows({ strength: 1.1, nm: 470, param: 20, spread: 0.75, note: 'a thousand photophores; they light the bay at spawning' }),
  watasenia: rows({ strength: 1.1, nm: 470, param: 20, spread: 0.75, note: 'a thousand photophores; they light the bay at spawning' }),
  vampyroteuthis: pulse({
    strength: 0.75, nm: 470, param: 0.25, rate: 0.12,
    note: 'no ink at this depth — it releases a cloud of light and leaves in the dark',
  }),
  kraken: pulse({ strength: 0.6, nm: 474, param: 0.35, rate: 0.1, real: false, note: 'invented — the abyss lends it a cephalopod’s light' }),
  octopus: dark('most octopuses make no light; only a few deep genera carry lit suckers'),
  octo: dark('most octopuses make no light; only a few deep genera carry lit suckers'),
  nautilus: dark('makes no light of its own'),
  cuttlefish: dark('makes no light of its own'),

  // ---- jellies and the gelatinous drift ----------------------------------
  jellyfish: pulse({
    strength: 0.8, nm: 472, param: 0.5, rate: 0.28,
    note: 'many deep medusae flash when touched; Atolla spins its alarm right around the bell',
  }),
  jelly: pulse({ strength: 0.8, nm: 472, param: 0.5, rate: 0.28, note: 'many deep medusae flash when touched' }),
  medusa: pulse({ strength: 0.8, nm: 472, param: 0.5, rate: 0.28, note: 'many deep medusae flash when touched' }),
  atolla: pulse({ strength: 0.95, nm: 470, param: 1.0, rate: 0.55, note: 'the burglar alarm: light spun around the bell to call in something bigger' }),
  crystaljelly: glow({ strength: 0.6, nm: 509, param: 0.2, rate: 0.07, note: 'its green fluorescent protein is the GFP in every lab on earth' }),
  aequorea: glow({ strength: 0.6, nm: 509, param: 0.2, rate: 0.07, note: 'its green fluorescent protein is the GFP in every lab on earth' }),
  comb: glow({
    strength: 0.34, nm: 490, param: 0.45, rate: 0.11,
    note: 'the rainbow running along its comb rows is diffraction, not light it makes — but many ctenophores do luminesce',
  }),
  siphonophore: pulse({ strength: 0.7, nm: 472, param: 0.15, rate: 0.2, note: 'a colony, flashing along its whole length' }),
  manowar: dark('a surface float — it makes no light'),

  // ---- the drifting small stuff ------------------------------------------
  plankton: glow({
    strength: 0.55, nm: 474, param: 0.8, rate: 0.5,
    note: 'dinoflagellates flash when the water around them shears — the light in a breaking wave',
  }),
  dinoflagellate: glow({ strength: 0.6, nm: 474, param: 0.85, rate: 0.6, note: 'flashes when the water around it shears' }),
  algae: glow({ strength: 0.4, nm: 474, param: 0.7, rate: 0.4, note: 'a bloom of dinoflagellates is what lights a bay at night' }),
  krill: rows({ strength: 0.75, nm: 476, param: 9, spread: 0.8, note: 'photophores under the eyes and along the swimming legs' }),
  shrimp: pulse({
    strength: 0.8, nm: 470, param: 0.1, rate: 0.35,
    note: 'deep shrimp spit a cloud of light into a predator’s face and leave',
  }),
  salp: glow({ strength: 0.38, nm: 490, param: 0.3, rate: 0.08, note: 'the related pyrosomes glow in chains metres long' }),
  blob: glow({ strength: 0.34, nm: 480, param: 0.4, real: false, note: 'invented — lit because everything at that depth is' }),
  ooze: glow({ strength: 0.34, nm: 480, param: 0.4, real: false, note: 'invented — lit because everything at that depth is' }),
  slime: glow({ strength: 0.34, nm: 480, param: 0.4, real: false, note: 'invented — lit because everything at that depth is' }),
  goo: glow({ strength: 0.34, nm: 480, param: 0.4, real: false, note: 'invented — lit because everything at that depth is' }),
  nebula: glow({ strength: 0.42, nm: 478, param: 0.55, rate: 0.05, real: false, note: 'invented — a cloud with nowhere to be, and light to spare' }),
  spore: glow({ strength: 0.3, nm: 480, param: 0.6, real: false, note: 'invented — lit because everything at that depth is' }),

  // ---- the floor and the long bodies -------------------------------------
  worm: glow({
    strength: 0.45, nm: 565, param: 0.3, rate: 0.16,
    note: 'Tomopteris is one of the very few animals whose light is yellow',
  }),
  brittlestar: pulse({
    strength: 0.7, nm: 500, param: 0.05, rate: 0.5,
    note: 'green light runs out along the arm it is about to shed',
  }),
  seapen: pulse({ strength: 0.6, nm: 490, param: 0.05, rate: 0.22, note: 'a wave of light travels the colony when it is touched' }),
  // myth, in the dark half of the column. Marked invented; given a real
  // adaptation because a serpent at 800 m with no light would be the only
  // thing down there without any.
  dragon: rows({ strength: 0.6, nm: 480, param: 24, spread: 0.5, real: false, note: 'invented — wearing a real adaptation' }),
  serpent: rows({ strength: 0.55, nm: 480, param: 26, spread: 0.5, real: false, note: 'invented — wearing a real adaptation' }),
  leviathan: rows({ strength: 0.55, nm: 478, param: 30, spread: 0.5, real: false, note: 'invented — wearing a real adaptation' }),
  wyrm: rows({ strength: 0.55, nm: 478, param: 30, spread: 0.5, real: false, note: 'invented — wearing a real adaptation' }),

  // ---- documented dark ---------------------------------------------------
  coral: dark('what a coral does under blue light is fluorescence — re-emitted light, not light it makes'),
  anemone: dark('makes no light of its own'),
  kelp: dark('makes no light of its own'),
  seagrass: dark('makes no light of its own'),
  dolphin: dark('makes no light of its own — the sparkle around it is plankton it disturbed'),
  seadragon: dark('a weedy shallow-water fish, and dark'),
});

const ALIASES = Object.freeze({
  jellies: 'jellyfish',
  medusae: 'medusa',
  'crystal jelly': 'crystaljelly',
  'firefly squid': 'fireflysquid',
  'vampire squid': 'vampyroteuthis',
  'lantern fish': 'lanternfish',
  'hatchet fish': 'hatchetfish',
  'dragon fish': 'dragonfish',
  'angler fish': 'anglerfish',
  'comb jelly': 'comb',
  'sea pen': 'seapen',
  'brittle star': 'brittlestar',
  ctenophore: 'comb',
  esca: 'anglerfish',
});

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------
// Same order as depthbands.bandKeyFor and oceandata.speciesKeyFor, so one name
// resolves the same way in all three: exact, alias, singular, then each word
// of a multi-word name right to left (the head noun of "red jellyfish" wins).

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function lookupWord(w) {
  if (has(ALIASES, w)) w = ALIASES[w];
  if (has(BIO_SPECIES, w)) return w;
  const s = w.replace(/s$/, '');
  if (s !== w) {
    if (has(ALIASES, s)) return ALIASES[s];
    if (has(BIO_SPECIES, s)) return s;
  }
  return null;
}

/** The bio-table key a name resolves to, or null. */
export function bioKeyFor(nameOrWord) {
  if (!nameOrWord) return null;
  const raw = String(nameOrWord).toLowerCase().trim().replace(/\s+/g, ' ');
  if (!raw) return null;
  const direct = lookupWord(raw);
  if (direct) return direct;
  if (raw.indexOf(' ') >= 0) {
    const words = raw.split(' ');
    for (let i = words.length - 1; i >= 0; i--) {
      const k = lookupWord(words[i]);
      if (k) return k;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The researched override
// ---------------------------------------------------------------------------
//
// src/data/ocean-data.json may grow per-species bio fields. Nothing here
// REQUIRES them — every access is guarded, so this module behaves identically
// whether the research has landed or not — but when they exist they win over
// the curated table, because they are sourced and it is not.
//
//   bioluminescent  false -> a documented dark animal
//   bioColour       '#66e0ff' | 480 | 'blue-green (~480 nm)' | [r,g,b]
//   bioLureColour   the same, for the lure organ only
//   bioPattern      'rows' | 'lure' | 'pulse' | 'glow' | 'rows+lure'
//   bioStrength     0..1.5 master strength
//   bioNote         one line, already written for a reader

const PATTERN_WORDS = Object.freeze({
  rows: BIO.ROWS,
  row: BIO.ROWS,
  photophores: BIO.ROWS,
  photophore: BIO.ROWS,
  counterillumination: BIO.ROWS,
  'counter-illumination': BIO.ROWS,
  lure: BIO.LURE,
  esca: BIO.LURE,
  barbel: BIO.LURE,
  pulse: BIO.PULSE,
  flash: BIO.PULSE,
  alarm: BIO.PULSE,
  glow: BIO.GLOW,
  diffuse: BIO.GLOW,
  'rows+lure': BIO.ROWS_LURE,
  'rows and lure': BIO.ROWS_LURE,
});

/** A pattern word, or a pattern inferred from a prose note, or null. */
export function patternFromWords(text) {
  if (text == null) return null;
  const s = String(text).toLowerCase();
  if (has(PATTERN_WORDS, s.trim())) return PATTERN_WORDS[s.trim()];
  // Prefix matches, not whole words: a note says "photophores", "flashes",
  // "glowing" as readily as the bare stem, and a missed match here silently
  // demotes a researched animal to the curated guess.
  const hasLure = /\b(lure|esca|illicium|barbel)/.test(s);
  const hasRows = /\b(photophore|counter-?illuminat|ventral row|rows?\b)/.test(s);
  if (hasLure && hasRows) return BIO.ROWS_LURE;
  if (hasLure) return BIO.LURE;
  if (hasRows) return BIO.ROWS;
  if (/\b(flash|alarm|pulse|burst|blink|strobe)/.test(s)) return BIO.PULSE;
  if (/\b(glow|luminesc|luminous|diffuse|shine|shimmer)/.test(s)) return BIO.GLOW;
  return null;
}

function dataEntryFor(nameOrWord) {
  const species = RAW && RAW.species;
  if (!species) return null;
  let key = null;
  try {
    key = speciesKeyFor(nameOrWord);
  } catch {
    key = null;
  }
  if (!key || !has(species, key)) return null;
  const s = species[key];
  const anyBio = s.bioluminescent != null || s.bioColour != null || s.bioColor != null
    || s.bioPattern != null || s.bioNote != null || s.bioStrength != null;
  return anyBio ? { key, s } : null;
}

const NOT_LIT = /\b(no light|makes no light|not bioluminescent|non-?luminous|does not (?:luminesc|glow)|no known biolum)/;

function fromData(entry, base) {
  const s = entry.s;
  // A researched note that says the animal is dark is as good as the flag —
  // and better than defaulting it to a glow because no pattern word matched.
  if (s.bioluminescent === false || (s.bioluminescent !== true && s.bioNote && NOT_LIT.test(String(s.bioNote).toLowerCase()))) {
    return make(BIO.OFF, {
      lit: false,
      source: 'data',
      key: entry.key,
      note: s.bioNote || 'makes no light of its own',
    });
  }
  const pattern = patternFromWords(s.bioPattern)
    ?? patternFromWords(s.bioNote)
    ?? (base ? base.pattern : BIO.GLOW);
  const col = parseBioColour(s.bioColour ?? s.bioColor);
  const lureCol = parseBioColour(s.bioLureColour ?? s.bioLureColor);
  const over = {
    source: 'data',
    key: entry.key,
    note: s.bioNote || (base ? base.note : ''),
    strength: Number.isFinite(s.bioStrength) ? s.bioStrength : (base ? base.strength : DEFAULTS.strength),
    rate: base ? base.rate : DEFAULTS.rate,
    param: base ? base.param : DEFAULTS.param,
    aim: base ? base.aim : DEFAULTS.aim,
    spread: base ? base.spread : DEFAULTS.spread,
    lureDir: base ? base.lureDir : DEFAULTS.lureDir,
    lureFrac: base ? base.lureFrac : DEFAULTS.lureFrac,
    real: base ? base.real : true,
  };
  if (col) {
    over.rgb = col.rgb;
    over.nmHint = col.nm;
  } else if (base) {
    over.nm = base.nm ?? BLUE_GREEN_NM;
  }
  if (lureCol) {
    over.lureRgb = [lureCol.rgb[0] * DEFAULTS.lureGain, lureCol.rgb[1] * DEFAULTS.lureGain, lureCol.rgb[2] * DEFAULTS.lureGain];
  } else if (base && base.lureNm != null) {
    over.lureNm = base.lureNm;
  }
  return make(pattern, over);
}

// ---------------------------------------------------------------------------
// The public lookup
// ---------------------------------------------------------------------------

const recordCache = new Map();

/**
 * The bioluminescence record for a name, or null when nothing is known and
 * nothing is inferred. A null means "leave the uniforms alone" — that creature
 * then renders exactly as it did in v3.6.
 *
 * @param {string} nameOrWord   "anglerfish", "three red jellyfish", "kelp"
 * @param {object} [opts]
 *   infer  a band record (depthbands.js). When given, a species with no entry
 *          anywhere still gets the light its LAYER implies — see inferBio.
 *          Off by default: inference is a guess and the caller opts in.
 */
export function bioForName(nameOrWord, opts) {
  const raw = String(nameOrWord == null ? '' : nameOrWord).toLowerCase().trim().replace(/\s+/g, ' ');
  if (!raw) return null;
  let rec = recordCache.get(raw);
  if (rec === undefined) {
    const key = bioKeyFor(raw);
    const base = key ? BIO_SPECIES[key] : null;
    const data = dataEntryFor(raw);
    rec = data ? fromData(data, base) : base;
    if (rec && key && !rec.key) rec = Object.freeze({ ...rec, key });
    recordCache.set(raw, rec || null);
    rec = rec || null;
  }
  if (rec) return rec;
  const band = opts && opts.infer;
  return band ? inferBio(band) : null;
}

/**
 * The record for a resolved lexicon spec, preferring the species over the
 * archetype — resolveName('red jellyfish') has arch 'medusa' and name
 * 'red jellyfish', and the jellyfish entry is the more specific answer.
 *
 * @param {object} spec  { name, arch, band } (a lexicon resolveName result, or
 *                       main.js's creature spec — both carry those fields)
 * @param {object} [opts] { infer: true } to fall back on the band's layer
 */
export function bioForSpec(spec, opts) {
  if (!spec) return null;
  const infer = opts && opts.infer;
  const byName = spec.name ? bioForName(spec.name) : null;
  if (byName) return byName;
  const byArch = spec.arch ? bioForName(spec.arch) : null;
  if (byArch) return byArch;
  if (!infer) return null;
  const band = (opts && opts.band) || spec.band || null;
  return band ? inferBio(band, spec.arch) : null;
}

/** The one-line note for a name, or null. Safe for the inspector to call. */
export function bioNoteFor(nameOrWord) {
  const rec = bioForName(nameOrWord);
  return rec && rec.note ? rec.note : null;
}

/**
 * The light a LAYER implies, for a species with no record of its own. Roughly
 * three quarters of the animals sampled between 200 and 1000 m emit light, so
 * for the deep half of the column "probably lit" is the better prior than
 * "dark" — but it IS a prior, so the record says source: 'inferred' and the
 * caller has to ask for it.
 *
 * @param {object} band  a depthbands.js band record (preferM, kind)
 * @param {string} [arch] archetype key, to pick a plausible pattern
 */
export function inferBio(band, arch) {
  if (!band) return null;
  const m = Number.isFinite(band.preferM) ? band.preferM : 0;
  if (m < 250) return null; // the sun still wins up here; nothing to gain
  const deep = Math.min(Math.max((m - 250) / 550, 0), 1); // 250 m -> 800 m
  const note = 'no record for this one — but most animals in this layer make light';
  if (arch === 'fish' || arch === 'eel' || arch === 'tetrapod') {
    return make(BIO.ROWS, {
      strength: 0.45 + 0.25 * deep, nm: 480, param: 18, spread: 0.6,
      source: 'inferred', real: true, note,
    });
  }
  if (arch === 'octo') {
    return make(BIO.ROWS, { strength: 0.4 + 0.25 * deep, nm: 470, param: 12, spread: 0.75, source: 'inferred', note });
  }
  if (arch === 'medusa') {
    return make(BIO.PULSE, { strength: 0.45 + 0.25 * deep, nm: 472, param: 0.4, rate: 0.25, source: 'inferred', note });
  }
  return make(BIO.GLOW, { strength: 0.28 + 0.2 * deep, nm: 480, param: 0.4, source: 'inferred', note });
}

// ---------------------------------------------------------------------------
// Depth: how much of it you should be seeing
// ---------------------------------------------------------------------------

function smooth01(t) {
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

/**
 * An OPTIONAL master for the layer as a function of camera or creature depth,
 * 0..1. Bioluminescence is an answer to a specific problem — a little light
 * from above and nothing else — and in the top few tens of metres it simply
 * loses: a photophore cannot compete with the sun, which is why so little
 * shallow water life bothers. This curve says that, and it is the natural
 * thing to feed setBioMaster().
 *
 * Pure, allocation-free, clock-free: safe on a frame path. Not applied
 * anywhere by default — the integrator decides whether the layer is depth-
 * aware, and passing 1.0 forever is a valid choice.
 */
export function bioDepthGain(depthM) {
  const m = +depthM;
  if (!Number.isFinite(m)) return 1;
  return 0.28 + 0.72 * smooth01((m - 30) / 220); // 0.28 at the surface, 1 by 250 m
}

// ---------------------------------------------------------------------------
// Writing the uniforms
// ---------------------------------------------------------------------------
//
// Duck-typed on purpose: these call .set()/.setRGB() on whatever objects
// shaders/dots.js put in the uniform slots, so this module never imports
// three.js and stays node-importable. Allocation-free — every write lands in
// an object that already exists.

/**
 * Point a creature's material at a bio record.
 *
 * @param {object} material  a createDotMaterial() result
 * @param {object} rec       a bio record, or null/an unlit record to clear
 * @param {object} [opts]
 *   gain     extra multiplier on the master strength (default 1) — this is the
 *            per-creature knob: depth, a control, a fade-in on spawn
 * @returns {boolean} true if the creature is now emitting
 */
export function applyBio(material, rec, opts) {
  const u = material && material.uniforms;
  if (!u || !u.uBio) return false;
  if (!rec || !rec.lit || !rec.pattern) {
    clearBio(material);
    return false;
  }
  const gain = opts && Number.isFinite(opts.gain) ? Math.max(opts.gain, 0) : 1;
  u.uBio.value.set(rec.strength * gain, rec.pattern, rec.rate, rec.param);
  u.uBioAim.value.set(rec.aim[0], rec.aim[1], rec.aim[2], rec.spread);
  u.uBioLure.value.set(rec.lureDir[0], rec.lureDir[1], rec.lureDir[2], rec.lureFrac);
  u.uBioColor.value.setRGB(rec.colour[0], rec.colour[1], rec.colour[2]);
  u.uBioLureColor.value.setRGB(rec.lureColour[0], rec.lureColour[1], rec.lureColour[2]);
  return true;
}

/** Turn the layer off for one creature: uBio.x = 0 is the shader's exact
 *  v3.6 path, not a dimmed version of the new one. */
export function clearBio(material) {
  const u = material && material.uniforms;
  if (!u || !u.uBio) return false;
  u.uBio.value.x = 0;
  return true;
}

/**
 * Re-scale one creature's emission without rebuilding anything: the cheap
 * per-frame call, if the integrator wants bio to fade with depth or with a
 * control. Allocation-free, and a no-op for a creature with no record.
 */
export function setBioStrength(material, rec, gain) {
  const u = material && material.uniforms;
  if (!u || !u.uBio || !rec || !rec.lit) return false;
  u.uBio.value.x = rec.strength * Math.max(gain, 0);
  return true;
}

/** The one global dimmer for the whole layer (globalUniforms.uBioGain). 1 is
 *  the identity; 0 turns every creature's own light off at once. */
export function setBioMaster(globalUniforms, gain) {
  const u = globalUniforms && globalUniforms.uBioGain;
  if (!u) return false;
  u.value = Math.max(+gain || 0, 0);
  return true;
}

// ---------------------------------------------------------------------------
// Words for the instruments
// ---------------------------------------------------------------------------

/** "≈480 nm blue-green" — the colour, said the way a source would say it. */
export function describeColour(rec) {
  if (!rec || !rec.lit) return null;
  const nm = rec.nm;
  if (nm == null) return null;
  let word = 'blue';
  if (nm >= 460 && nm < 495) word = 'blue-green';
  else if (nm >= 495 && nm < 530) word = 'green';
  else if (nm >= 530 && nm < 580) word = 'yellow';
  else if (nm >= 580 && nm < 620) word = 'orange';
  else if (nm >= 620) word = 'red';
  else if (nm < 440) word = 'violet';
  return `≈${Math.round(nm)} nm ${word}`;
}

/** "lure · ≈485 nm blue-green" — one line for the gauge plate. */
export function describeBio(rec) {
  if (!rec) return null;
  if (!rec.lit) return 'dark';
  const col = describeColour(rec);
  const lure = rec.lureNm != null && Math.abs(rec.lureNm - (rec.nm ?? rec.lureNm)) > 25
    ? ` · lure ≈${Math.round(rec.lureNm)} nm`
    : '';
  return col ? `${rec.patternName} · ${col}${lure}` : rec.patternName + lure;
}

/**
 * Render-ready rows for the inspector, in the shape oceandata.statRows uses:
 * { key, label, value, note }. A row exists only if it has something to say —
 * same rule, so the two tables can be concatenated without null checks.
 */
export function bioRows(nameOrWord) {
  const rec = bioForName(nameOrWord);
  if (!rec) return EMPTY;
  const out = [];
  if (!rec.lit) {
    out.push(Object.freeze({ key: 'bio', label: 'light', value: 'none of its own', note: rec.note || null }));
    return Object.freeze(out);
  }
  out.push(Object.freeze({
    key: 'bio',
    label: 'light',
    value: rec.patternName,
    note: rec.real === false ? 'invented animal' : (rec.source === 'inferred' ? 'inferred from its depth' : null),
  }));
  const col = describeColour(rec);
  if (col) {
    out.push(Object.freeze({
      key: 'bio-colour',
      label: 'wavelength',
      value: col,
      note: rec.lureNm != null && Math.abs(rec.lureNm - (rec.nm ?? rec.lureNm)) > 25
        ? `lure ≈${Math.round(rec.lureNm)} nm`
        : null,
    }));
  }
  if (rec.note) out.push(Object.freeze({ key: 'bio-note', label: 'note', value: rec.note, note: null }));
  return Object.freeze(out);
}

const EMPTY = Object.freeze([]);

export default {
  BIO,
  PATTERN_NAMES,
  BLUE_GREEN_NM,
  BIO_SPECIES,
  bioForName,
  bioForSpec,
  bioKeyFor,
  bioNoteFor,
  bioRows,
  inferBio,
  bioDepthGain,
  applyBio,
  clearBio,
  setBioStrength,
  setBioMaster,
  describeBio,
  describeColour,
  wavelengthToLinear,
  parseBioColour,
  patternFromWords,
};

// Tetrapod — the marine amniotes: the animals with FLIPPERS and (sometimes) a
// SHELL. Pure math, no three.js (node-importable, node-benchable).
//
// WHY THIS ARCHETYPE EXISTS
// Every other archetype in the menagerie is built on an undulating spine: a
// wave travels head→tail and the body follows it. That is how a fish, an eel
// and a ray move, and it is completely wrong for a sea turtle, a seal, a
// penguin or an otter. Those animals are tetrapods that went back to the
// water: a stiff rounded trunk plus PADDLING LIMBS. The thrust comes from the
// limb STROKE, not from the body wave. Before v3.7 "turtle" resolved to the
// RAY archetype — a flat sheet — which is the last structural geometry gap.
//
// CONTRACT (geometry-spec.md)
//   §2  rotation-minimizing frames, seeded from the creature's RNG
//   §3  per-STATION frames; dots use precomputed quantized angle tables
//   §4  ZERO allocation in updateTargets — every array below is built once
//   §5  curvature clamp through spine.maxKappaR + the local ring guard
//   §6  rings at equal arc length (spine.js owns this)
//   §7  quantized rings — here they also carry the turtle's SCUTE bands
//   §8  frozen RNG draw order; preset axes are preset-ONLY with neutral
//       defaults, so adding a preset never shifts a single draw
//   §10 local space, fixed bounding sphere (creatures.js boundR 2.6)
//
// NORMALS — the three classes of the spec's table all appear here:
//   body   TUBE   elliptical ring offset direction + taper-tilt correction
//   shell  SHEET  swept-ellipse dome: analytic ∂P/∂u × ∂P/∂v
//   limbs  SHEET  ruled blade: analytic ∂P/∂u × ∂P/∂v (NEVER an in-plane
//                 offset — that is the known M4 bug)
//   tusks  TUBE   ring offset direction + taper tilt
//
// MOTION CHARACTER
// The trunk barely undulates (`bodyUnd`, 0.18 for a turtle, 0.9 for an otter).
// The limbs STROKE. Each blade carries three angles, all analytic:
//   θ  stroke elevation  — the flipper sweeps up and down (underwater flight)
//   Λ  sweep / row       — fore-aft sweep, 90° out of phase with θ (rowing)
//   ψ  feather / pitch   — the blade pitches about its own span axis, 90° out
//                          of phase with the stroke. That phase relationship
//                          is the actual hydrodynamics of a flipper, and it is
//                          what makes the stroke read as thrust rather than
//                          as a wing flapping in air.
// `foreFlex` is how much of the stroke the blade tip adds over the shoulder:
// a penguin flipper is a fused, rigid hydrofoil (flex 0.12) beating fast; a
// turtle fore-flipper is a compliant blade (flex 0.45) beating slowly.

import { mulberry32, hashName } from './rng.js';
import { createSpine, makeRingTables, KAPPA_R_MAX, RING_SHRINK, TAU } from './spine.js';

// incommensurate secondary-wave ratio (spec §1 spirit — motion never repeats)
const W_RATIO = Math.SQRT2 * 1.618033988749895 * 0.5;

// ---- morph axes -----------------------------------------------------------
// SEED-DRAWN (7): elong, girth, flat, fore, hind, shellH, snout. A preset may
// override the VALUE; the draw always happens (spec §8).
// PRESET-ONLY: everything else. None of them CONSUMES A DRAW, which is the
// spec §8 property that matters — a seed-only tetrapod's dot count, its
// cross-ring shuffle and its twinkle phases are bit-identical no matter how
// many presets are added later, and adding an axis can never renumber the
// stream. Their defaults are not all NEUTRAL, though, and two deliberately are
// not: `head` defaults to 0.5 and `counter` to 0.3, because every amniote in
// the table has a skull and dark-above/pale-below shading, so a seed-only
// tetrapod is meant to have them too. Those two therefore DO change the trunk
// profile and the dot sizes of a seed-only build relative to v3.7.0.
//
//   elong      trunk elongation (length vs girth)
//   girth      trunk fatness (vertical half-height)
//   flat       section aspect: lateral radius / vertical radius. >1 = wider
//              than tall (turtle under its shell), <1 = laterally compressed
//              and deep-chested (penguin), 1 = round (seal)
//   tailFat    0..1 how much girth the rear HOLDS instead of tapering away —
//              an otter's thick sculling tail, a manatee's paddle root
//   neck       0..1 pinch behind the head (a sea lion has a neck; a walrus
//              does not)
//   snout      head-taper LENGTH; snoutPow head-taper SHARPNESS (decoupled:
//              a penguin's beak is long and sharp, a walrus muzzle short/blunt)
//   shellW/H   carapace lateral half-width / dome height, in units of the
//              trunk's vertical radius. At turtle values (1.75 / 1.05) this is
//              a true carapace overhanging the flanks; at cap values
//              (~0.6 / ~0.38 with shellRise ~0.55) the same surface becomes a
//              rounded dorsal contour hugging a seal's back.
//   shellRise  where the dome's centre sits, as a fraction of the local body
//              radius above the spine
//   shellArc   angular half-span of the dome, radians (how far it wraps down)
//   shellRidge keel amplitude, shellRidgeN keel count — the leatherback's
//              seven ridges are a cos(nθ) modulation of the dome radius, with
//              its derivative carried into the analytic normal
//   fore/hind  limb size (span AND chord). foreChord/hindChord trim the chord
//              independently (a manatee's fused hind paddle is all chord)
//   *Sweep     rest sweep-back Λ₀ (0 = straight out sideways, π/2 = straight
//              back — which is how the hind pair fuses into a tail paddle)
//   *Tilt      rest stroke elevation θ₀ (negative = trailing below the body)
//   *Lat/*Drop where on the trunk the limb attaches (lateral / below-axis)
//   *Amp       stroke amplitude, *Rate stroke frequency multiplier
//   *Flex      0..1 blade compliance (0 = rigid hydrofoil, 1 = whip)
//   *Pitch     feathering amplitude, *Row fore-aft rowing amplitude
//   *Alt       0 = both limbs in phase (underwater flight), 1 = alternating
//              (paddling). Half-values give a lazy asymmetry.
//   tusk       muzzle appendage LENGTH multiplier. This block is never empty:
//              at 0.3 it is a pair of whiskers/a beak, at 1.75 it is a
//              walrus's tusks. tuskSplay fans them out, tuskDrop bends them
//              down, tuskThick sets the taper radius.
//   bodyUnd    trunk undulation amount (0.18 turtle → 0.9 otter)
//   undulateH  undulation PLANE: 0 lateral (a phocid seal sculls side to
//              side), 1 vertical (an otter porpoises)
//   bank       constant roll, radians. 2.85 puts a sea otter belly-up at the
//              surface — its actual rest pose.
//   scale/tempo/speed  world hints consumed by lexicon.js only; ignored here.
export const TETRAPOD_MORPHS = {
  // ---- chelonians: the domed carapace + four flippers, fore pair flying ----
  // A turtle is mostly shell: the trunk under the carapace is SMALL (girth
  // 0.7) and the dome is large in both axes, so the carapace clears the back
  // by ~0.65 of the trunk radius and overhangs the flanks. Getting this
  // balance wrong is what makes a shelled animal read as "a seal with a lump".
  turtle: {
    elong: 0.92, girth: 0.7, flat: 1.2, tailFat: 0.18, neck: 0.55,
    snout: 0.85, snoutPow: 0.9,
    head: 0.55, counter: 0.15,
    shellW: 2.4, shellH: 1.65, shellRise: 0.12, shellArc: 1.85, shellRidge: 0,
    fore: 1.55, foreChord: 0.9, foreSweep: 0.62, foreTilt: 0.05, foreLat: 0.75,
    foreDrop: 0.15, foreAmp: 0.62, foreRate: 1.0, foreFlex: 0.45,
    forePitch: 0.55, foreRow: 0.42, foreAlt: 0,
    hind: 0.5, hindChord: 1.05, hindSweep: 1.15, hindTilt: -0.28, hindAmp: 0.3,
    hindRate: 1.0, hindFlex: 0.4, hindPitch: 0.3, hindRow: 0.25, hindAlt: 0.5,
    tusk: 0.32, tuskSplay: 0.1, tuskDrop: 0.55, tuskThick: 1.0,
    bodyUnd: 0.18, undulateH: 0.6, bank: 0,
    scale: 1.2, tempo: 0.75, speed: 0.8,
  },
  leatherback: {
    elong: 1.05, girth: 0.68, flat: 1.15, tailFat: 0.2, neck: 0.45,
    snout: 0.95, snoutPow: 1.0,
    head: 0.5, counter: 0.2,
    // seven keels: a cos(5θ) ridge over the ±1.78 rad arc reads as 5 crests on
    // the dome plus the two rim edges — the leatherback's whole silhouette
    shellW: 2.15, shellH: 1.6, shellRise: 0.1, shellArc: 1.78,
    shellRidge: 0.075, shellRidgeN: 5,
    fore: 1.85, foreChord: 0.8, foreSweep: 0.6, foreTilt: 0.05, foreLat: 0.7,
    foreDrop: 0.12, foreAmp: 0.68, foreRate: 0.85, foreFlex: 0.4,
    forePitch: 0.55, foreRow: 0.38, foreAlt: 0,
    hind: 0.45, hindChord: 1.0, hindSweep: 1.2, hindTilt: -0.3, hindAmp: 0.26,
    hindRate: 0.85, hindFlex: 0.4, hindPitch: 0.28, hindRow: 0.2, hindAlt: 0.5,
    tusk: 0.3, tuskSplay: 0.09, tuskDrop: 0.5, tuskThick: 1.0,
    bodyUnd: 0.16, undulateH: 0.6, bank: 0,
    scale: 1.75, tempo: 0.6, speed: 0.9,
  },

  // ---- pinnipeds ----------------------------------------------------------
  // Phocid: the true seal. The fore-flippers steer; the HIND pair does the
  // work, sculling side to side — so undulateH is low (lateral) and hindAlt
  // is high (the two hind blades alternate).
  seal: {
    elong: 1.28, girth: 1.0, flat: 0.95, tailFat: 0.3, neck: 0.25,
    snout: 0.8, snoutPow: 0.85,
    head: 0.62, counter: 0.4,
    shellW: 0.62, shellH: 0.4, shellRise: 0.55, shellArc: 1.2, shellRidge: 0,
    fore: 0.62, foreChord: 1.0, foreSweep: 0.75, foreTilt: -0.1, foreLat: 0.9,
    foreDrop: 0.2, foreAmp: 0.4, foreRate: 0.8, foreFlex: 0.5,
    forePitch: 0.45, foreRow: 0.35, foreAlt: 0.6,
    hind: 1.05, hindChord: 1.15, hindSweep: 1.3, hindTilt: -0.12, hindAmp: 0.75,
    hindRate: 0.85, hindFlex: 0.55, hindPitch: 0.5, hindRow: 0.55, hindAlt: 0.85,
    tusk: 0.3, tuskSplay: 0.42, tuskDrop: 0.3, tuskThick: 0.7,
    bodyUnd: 0.8, undulateH: 0.2, bank: 0,
    scale: 1.3, tempo: 0.9, speed: 1.0,
  },
  // Otariid: the sea lion. Long neck, huge fore-flippers that literally fly.
  sealion: {
    elong: 1.2, girth: 0.95, flat: 0.92, tailFat: 0.22, neck: 0.75,
    snout: 0.9, snoutPow: 0.95,
    head: 0.72, counter: 0.42,
    shellW: 0.6, shellH: 0.4, shellRise: 0.55, shellArc: 1.2, shellRidge: 0,
    fore: 1.35, foreChord: 0.85, foreSweep: 0.42, foreTilt: 0.02, foreLat: 0.85,
    foreDrop: 0.18, foreAmp: 0.85, foreRate: 1.15, foreFlex: 0.35,
    forePitch: 0.6, foreRow: 0.2, foreAlt: 0,
    hind: 0.55, hindChord: 1.1, hindSweep: 1.35, hindTilt: -0.2, hindAmp: 0.25,
    hindRate: 0.9, hindFlex: 0.5, hindPitch: 0.3, hindRow: 0.3, hindAlt: 0.6,
    tusk: 0.3, tuskSplay: 0.4, tuskDrop: 0.28, tuskThick: 0.7,
    bodyUnd: 0.6, undulateH: 0.35, bank: 0,
    scale: 1.35, tempo: 1.0, speed: 1.15,
  },
  walrus: {
    elong: 1.15, girth: 1.45, flat: 1.05, tailFat: 0.3, neck: 0.12,
    snout: 0.6, snoutPow: 0.6,
    head: 0.75, counter: 0.25,
    shellW: 0.68, shellH: 0.42, shellRise: 0.55, shellArc: 1.25, shellRidge: 0,
    fore: 0.95, foreChord: 1.05, foreSweep: 0.7, foreTilt: -0.08, foreLat: 0.9,
    foreDrop: 0.2, foreAmp: 0.5, foreRate: 0.65, foreFlex: 0.5,
    forePitch: 0.4, foreRow: 0.4, foreAlt: 0.6,
    hind: 0.9, hindChord: 1.15, hindSweep: 1.3, hindTilt: -0.15, hindAmp: 0.5,
    hindRate: 0.65, hindFlex: 0.55, hindPitch: 0.4, hindRow: 0.45, hindAlt: 0.85,
    // the tusks. Long, thick, driven down and barely splayed.
    tusk: 1.75, tuskSplay: 0.16, tuskDrop: 1.25, tuskThick: 2.2,
    bodyUnd: 0.6, undulateH: 0.25, bank: 0,
    scale: 1.9, tempo: 0.6, speed: 0.6,
  },

  // ---- the bird ------------------------------------------------------------
  // A penguin flies underwater: stiff fused wing-flippers, high beat rate,
  // feet trailing as rudders. foreFlex 0.12 is the lowest in the table and
  // foreRate 1.9 the highest — those two numbers ARE the penguin.
  penguin: {
    elong: 1.15, girth: 1.0, flat: 0.82, tailFat: 0.28, neck: 0.62,
    snout: 1.35, snoutPow: 1.5,
    head: 0.9, counter: 1.0,
    shellW: 0.5, shellH: 0.35, shellRise: 0.6, shellArc: 1.05, shellRidge: 0,
    fore: 1.0, foreChord: 0.62, foreSweep: 0.5, foreTilt: 0.0, foreLat: 0.85,
    foreDrop: 0.05, foreAmp: 0.95, foreRate: 1.9, foreFlex: 0.12,
    forePitch: 0.6, foreRow: 0.1, foreAlt: 0,
    hind: 0.32, hindChord: 1.0, hindSweep: 1.45, hindTilt: -0.1, hindAmp: 0.12,
    hindRate: 0.5, hindFlex: 0.3, hindPitch: 0.2, hindRow: 0.15, hindAlt: 0.4,
    tusk: 0.45, tuskSplay: 0.05, tuskDrop: 0.22, tuskThick: 0.6,
    bodyUnd: 0.2, undulateH: 0.5, bank: 0,
    scale: 0.85, tempo: 1.5, speed: 1.5,
  },

  // ---- the mustelid --------------------------------------------------------
  // A sea otter rests at the surface, belly up, near-horizontal: bank 2.85 rad
  // rolls the whole animal (frames, limbs and all) onto its back. Small
  // rowing paws, webbed hind feet, and a thick sculling tail (tailFat 0.82).
  otter: {
    elong: 1.05, girth: 1.0, flat: 0.95, tailFat: 0.82, neck: 0.5,
    snout: 0.75, snoutPow: 0.7,
    head: 0.7, counter: 0.35,
    shellW: 0.55, shellH: 0.35, shellRise: 0.55, shellArc: 1.1, shellRidge: 0,
    fore: 0.42, foreChord: 1.2, foreSweep: 0.55, foreTilt: -0.15, foreLat: 0.9,
    foreDrop: 0.3, foreAmp: 0.45, foreRate: 1.3, foreFlex: 0.6,
    forePitch: 0.4, foreRow: 0.6, foreAlt: 1.0,
    hind: 0.7, hindChord: 1.35, hindSweep: 1.05, hindTilt: -0.18, hindAmp: 0.6,
    hindRate: 1.2, hindFlex: 0.55, hindPitch: 0.45, hindRow: 0.6, hindAlt: 1.0,
    tusk: 0.28, tuskSplay: 0.5, tuskDrop: 0.25, tuskThick: 0.6,
    bodyUnd: 0.9, undulateH: 1, bank: 2.85,
    scale: 0.7, tempo: 1.2, speed: 0.9,
  },

  // ---- sirenians -----------------------------------------------------------
  // No hind limbs at all: the hind PAIR is fused into one paddle by setting
  // hindLat ≈ 0 (both blades on the midline) and hindSweep ≈ π/2 (the span
  // points straight back, so the chord — which is ⊥ the span — spans
  // laterally). The same limb code therefore produces a tail fluke.
  dugong: {
    elong: 1.35, girth: 1.28, flat: 1.05, tailFat: 0.45, neck: 0.1,
    snout: 0.65, snoutPow: 0.55,
    head: 0.55, counter: 0.2,
    shellW: 0.6, shellH: 0.36, shellRise: 0.55, shellArc: 1.15, shellRidge: 0,
    fore: 0.72, foreChord: 1.0, foreSweep: 0.85, foreTilt: -0.12, foreLat: 0.9,
    foreDrop: 0.22, foreAmp: 0.3, foreRate: 0.55, foreFlex: 0.5,
    forePitch: 0.3, foreRow: 0.4, foreAlt: 0.3,
    hind: 1.45, hindChord: 1.9, hindSweep: 1.45, hindTilt: -0.03, hindLat: 0.05,
    hindDrop: 0, hindAmp: 0.5, hindRate: 0.5, hindFlex: 0.45, hindPitch: 0.35,
    hindRow: 0.1, hindAlt: 0, hindTaper: 0.15,
    tusk: 0.26, tuskSplay: 0.45, tuskDrop: 0.35, tuskThick: 0.8,
    bodyUnd: 0.55, undulateH: 1, bank: 0,
    scale: 1.8, tempo: 0.5, speed: 0.5,
  },
  manatee: {
    elong: 1.3, girth: 1.34, flat: 1.05, tailFat: 0.7, neck: 0.08,
    snout: 0.6, snoutPow: 0.5,
    head: 0.55, counter: 0.2,
    shellW: 0.62, shellH: 0.36, shellRise: 0.55, shellArc: 1.15, shellRidge: 0,
    fore: 0.78, foreChord: 1.05, foreSweep: 0.8, foreTilt: -0.14, foreLat: 0.9,
    foreDrop: 0.24, foreAmp: 0.32, foreRate: 0.5, foreFlex: 0.55,
    forePitch: 0.3, foreRow: 0.45, foreAlt: 0.3,
    // rounder, broader paddle than the dugong's forked fluke
    hind: 1.2, hindChord: 2.4, hindSweep: 1.4, hindTilt: -0.03, hindLat: 0.05,
    hindDrop: 0, hindAmp: 0.45, hindRate: 0.45, hindFlex: 0.5, hindPitch: 0.35,
    hindRow: 0.1, hindAlt: 0, hindTaper: 0.1,
    tusk: 0.26, tuskSplay: 0.45, tuskDrop: 0.35, tuskThick: 0.85,
    bodyUnd: 0.5, undulateH: 1, bank: 0,
    scale: 1.8, tempo: 0.45, speed: 0.45,
  },
};

// seed → preset. The clean name of a bare species IS its seed via hashName
// (lexicon.js keeps the typed words in the clean name), so the board path —
// which passes only a seed — gets species shapes for free. Multi-word and
// plural spellings are registered explicitly because the clean name keeps its
// spaces ("sea turtle" hashes differently from "turtle").
//
// EVERY SPELLING IN lexicon.js's LEX.tetrapod MUST APPEAR BELOW (v3.7 fix).
// The v3.7 lexicon words are the CLOSED-UP forms — 'emperorpenguin',
// 'littlepenguin', 'leatherbackturtle', 'harbourseal', 'greenturtle' — and the
// table only carried the spaced ones, so those names resolved with morph:null
// and were built as SEED-ONLY tetrapods: an emperor penguin got a random
// generic body with none of the numbers (foreFlex 0.12, foreRate 1.9, snout
// 1.35) that make a penguin a penguin. That is why 'emperor penguin' rendered
// as a fat ovoid while 'penguin' rendered as a bird. lexicon.js normalises a
// typed "emperor penguin" to the same closed-up word, so registering the
// closed-up form fixes both the typed and the saved-board paths at once.
const MORPH_ALIASES = {
  turtle: [
    'turtle', 'sea turtle', 'seaturtle', 'green turtle', 'greenturtle',
    'loggerhead', 'hawksbill', 'hawksbill turtle', 'hawksbillturtle', 'terrapin',
  ],
  leatherback: ['leatherback', 'leatherback turtle', 'leatherbackturtle'],
  seal: [
    'seal', 'harbor seal', 'harborseal', 'harbour seal', 'harbourseal',
    'grey seal', 'gray seal', 'elephant seal', 'monk seal', 'fur seal', 'pinniped',
  ],
  sealion: ['sealion', 'sea lion'],
  walrus: ['walrus', 'walruses'],
  penguin: [
    'penguin', 'emperor penguin', 'emperorpenguin', 'king penguin',
    'little penguin', 'littlepenguin', 'fairy penguin', 'fairypenguin',
  ],
  otter: ['otter', 'sea otter', 'seaotter'],
  dugong: ['dugong'],
  manatee: ['manatee', 'sea cow', 'seacow'],
};
const MORPH_BY_SEED = new Map();
for (const k of Object.keys(TETRAPOD_MORPHS)) {
  const preset = TETRAPOD_MORPHS[k];
  const names = MORPH_ALIASES[k] || [k];
  for (const n of names) {
    MORPH_BY_SEED.set(hashName(n), preset);
    MORPH_BY_SEED.set(hashName(n + 's'), preset);
  }
}

/** Preset lookup by name, for lexicon.js (mirrors FISH_MORPHS[word] usage). */
export function tetrapodMorphFor(word) {
  if (!word) return null;
  const w = String(word).toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(TETRAPOD_MORPHS, w)) return TETRAPOD_MORPHS[w];
  const p = MORPH_BY_SEED.get(hashName(w));
  return p || null;
}

// ---------------------------------------------------------------------------

export function makeTetrapod(seed, opts = {}) {
  // Dot budget ≈ fish (1880), split for a body plan whose silhouette is
  // trunk + shell + four blades rather than trunk + fins:
  //   body   44×26 = 1144   rib pitch 2.3/43 ≈ 0.053 vs circumferential
  //                         2π·0.5/26 ≈ 0.12 at the thickest station — ribs
  //                         stay the dominant read (house look)
  //   shell  14×18 =  252   14 quantized bands = the scute rows
  //   fore   2×12×10 = 240  the pair that does the work, so the finer grid
  //   hind   2×9×7  = 126
  //   tusks  2×7×5  =  70
  //                = 1832
  const ringCount = opts.ringCount ?? 44;
  const dotsPerRing = opts.dotsPerRing ?? 26;
  const bodyCount = ringCount * dotsPerRing;
  const nShL = opts.shellRows ?? 14; // longitudinal scute bands
  const nShA = opts.shellCols ?? 18; // angular columns over the dome
  const shellCount = nShL * nShA;
  const nFu = opts.foreSpan ?? 12; //  fore blade: spanwise stations
  const nFv = opts.foreRows ?? 10; //             chordwise rows
  const nHu = opts.hindSpan ?? 9; //   hind blade
  const nHv = opts.hindRows ?? 7;
  const foreCount = 2 * nFu * nFv;
  const hindCount = 2 * nHu * nHv;
  const nTu = opts.tuskSegs ?? 7; //   muzzle appendage: stations
  const nTv = opts.tuskRing ?? 5; //                     dots per ring
  const tuskCount = 2 * nTu * nTv;
  const count = bodyCount + shellCount + foreCount + hindCount + tuskCount;
  // NOTE: count is identical for every morph — morphs change dimensions, never
  // dot counts, so the RNG draw structure below is fixed (spec §8).
  const bodyLen0 = opts.bodyLength ?? 2.3;
  const baseRadius0 = opts.radius ?? 0.5; // vertical half-height of the trunk
  const sampleCount = opts.sampleCount ?? 200; // spec §6

  const rng = mulberry32(seed);
  // ---- FROZEN DRAW ORDER (spec §8) — append only, never insert ----
  const seedAngle = rng() * TAU; //                      draw 1: RMF seed frame
  const phase1 = rng() * TAU; //                         draw 2: trunk wave
  const phase2 = rng() * TAU; //                         draw 3: shimmer wave
  const phase3 = rng() * TAU; //                         draw 4: slow flex
  const turnPhase1 = rng() * TAU; //                     draw 5: heading wander
  const turnPhase2 = rng() * TAU; //                     draw 6
  const twistPerRing = (rng() * 2 - 1) * 0.05; //        draw 7: faint rib spiral
  const strokePhase = rng() * TAU; //                    draw 8: limb stroke
  const hindLag = 0.35 + 0.55 * rng(); //                draw 9: hind phase lag
  const shellTwist = (rng() * 2 - 1) * 0.04; //          draw 10: scute row skew
  const sizeJit = new Float32Array(count); //            draws 11 .. 10+count
  for (let d = 0; d < count; d++) sizeJit[d] = 0.75 + 0.5 * rng();
  const twPhase = new Float32Array(count); //            next count draws
  for (let d = 0; d < count; d++) twPhase[d] = rng() * TAU;
  // Cross-ring shuffle (spec §9): drawRange prefix = uniform subsample.
  const perm = new Uint32Array(count); //                next count−1 draws
  for (let d = 0; d < count; d++) perm[d] = d;
  for (let d = count - 1; d > 0; d--) {
    const j = (rng() * (d + 1)) | 0;
    const t = perm[d];
    perm[d] = perm[j];
    perm[j] = t;
  }
  // Morphology axes — APPENDED after all prior draws (spec §8). Drawn
  // unconditionally with fixed counts; a preset may override the VALUES but
  // never skips a draw.
  const elongJ = 0.9 + 0.4 * rng(); //                    draw: trunk elongation
  const girthJ = 0.85 + 0.4 * rng(); //                   draw: trunk fatness
  const flatJ = 0.85 + 0.4 * rng(); //                    draw: section aspect
  const foreJ = 0.6 + 0.8 * rng(); //                     draw: fore limb size
  const hindJ = 0.5 + 0.8 * rng(); //                     draw: hind limb size
  const shellHJ = 0.28 + 0.24 * rng(); //                 draw: dorsal dome
  const snoutJ = 0.7 + 0.6 * rng(); //                    draw: snout profile
  // ---- end frozen draw order ----

  // preset resolution: explicit opts.morph wins; else the seed itself may BE a
  // named species (board path passes only the seed); else pure seed morphs.
  const preset = opts.morph ?? MORPH_BY_SEED.get(seed >>> 0) ?? null;
  const p = preset;
  const M = {
    elong: p?.elong ?? elongJ,
    girth: p?.girth ?? girthJ,
    flat: p?.flat ?? flatJ,
    fore: p?.fore ?? foreJ,
    hind: p?.hind ?? hindJ,
    shellH: p?.shellH ?? shellHJ,
    snout: p?.snout ?? snoutJ,
    // ---- preset-only axes; the neutral defaults describe a generic seal-ish
    // marine tetrapod, so a seed-only creature is well-formed and stable.
    tailFat: p?.tailFat ?? 0.3,
    neck: p?.neck ?? 0.35,
    snoutPow: p?.snoutPow ?? 1,
    // head-lobe amount (see the trunk profile): 0 is the pure v3.7.0 taper,
    // 1 a skull half again as thick as the barrel behind it. Every amniote in
    // the table has one, so the neutral default is a real head.
    head: p?.head ?? 0.5,
    // counter-shading, 0..1: how much dimmer the DORSAL dots are than the
    // ventral ones. A penguin is the extreme case and it is not decoration —
    // dark-above/pale-below is the single strongest read on a marine bird or
    // mammal, and in a dotted monochrome medium the only way to say it is dot
    // presence. 0 leaves every dot the size it had.
    counter: p?.counter ?? 0.3,
    shellW: p?.shellW ?? 0.62,
    shellRise: p?.shellRise ?? 0.55,
    shellArc: p?.shellArc ?? 1.2,
    shellRidge: p?.shellRidge ?? 0,
    shellRidgeN: p?.shellRidgeN ?? 5,
    foreChord: p?.foreChord ?? 1,
    foreSweep: p?.foreSweep ?? 0.6,
    foreTilt: p?.foreTilt ?? -0.05,
    foreLat: p?.foreLat ?? 0.88,
    foreDrop: p?.foreDrop ?? 0.2,
    foreAmp: p?.foreAmp ?? 0.6,
    foreRate: p?.foreRate ?? 1,
    foreFlex: p?.foreFlex ?? 0.45,
    forePitch: p?.forePitch ?? 0.5,
    foreRow: p?.foreRow ?? 0.3,
    foreAlt: p?.foreAlt ?? 0.3,
    foreTaper: p?.foreTaper ?? 0.45,
    hindChord: p?.hindChord ?? 1.1,
    hindSweep: p?.hindSweep ?? 1.25,
    hindTilt: p?.hindTilt ?? -0.15,
    hindLat: p?.hindLat ?? 0.75,
    hindDrop: p?.hindDrop ?? 0.15,
    hindAmp: p?.hindAmp ?? 0.55,
    hindRate: p?.hindRate ?? 0.9,
    hindFlex: p?.hindFlex ?? 0.5,
    hindPitch: p?.hindPitch ?? 0.4,
    hindRow: p?.hindRow ?? 0.45,
    hindAlt: p?.hindAlt ?? 0.7,
    hindTaper: p?.hindTaper ?? 0.4,
    tusk: p?.tusk ?? 0.3,
    tuskSplay: p?.tuskSplay ?? 0.4,
    tuskDrop: p?.tuskDrop ?? 0.3,
    tuskThick: p?.tuskThick ?? 0.8,
    bodyUnd: p?.bodyUnd ?? 0.6,
    undulateH: p?.undulateH ?? 0.4,
    bank: p?.bank ?? 0,
  };
  // Degeneracy guards: a zero-height or zero-width dome, or a blade whose
  // chord vanishes at the tip, would give a zero-length ∂P/∂u × ∂P/∂v. Clamp
  // once, here, so the frame path never has to test for it.
  const SHW = Math.max(M.shellW, 0.1);
  const SHH = Math.max(M.shellH, 0.1);
  const FORE_TAPER = Math.min(Math.max(M.foreTaper, 0), 0.6);
  const HIND_TAPER = Math.min(Math.max(M.hindTaper, 0), 0.6);

  // ---- dimensions. Elongation trades girth for length; the uniform norm
  // shrink keeps the whole animal — flipper tips and tusk points included —
  // inside the registry bounding sphere (boundR 2.6, spec §10) without
  // distorting the morph's proportions.
  let bodyLen = bodyLen0 * M.elong;
  let baseRadius = (baseRadius0 * M.girth) / Math.pow(M.elong, 0.5);
  const SPAN_K = 0.42; //  limb span, fraction of body length
  const CHORD_K = 0.17; // limb chord, fraction of body length
  const TUSK_K = 0.16; //  muzzle appendage length, fraction of body length
  {
    const lat = 0.9 * baseRadius * M.flat;
    // A blade swept back by Λ reaches (|x| + span·sinΛ) astern and
    // (lat + span·cosΛ) abeam — ignoring the sweep underestimates a seal's
    // trailing hind flippers by nearly a body length. The rowing amplitude
    // swings Λ, so take the worst of Λ₀ and Λ₀ ± row.
    const reachLimb = (span, chord, sweep, row, dx) => {
      let m = 0;
      for (let k = -1; k <= 1; k++) {
        const l = sweep + k * row;
        const r = Math.hypot(Math.abs(dx) + span * Math.abs(Math.sin(l)), lat + span * Math.abs(Math.cos(l)));
        if (r > m) m = r;
      }
      return m + 0.7 * chord;
    };
    const reachTail = 0.5 * bodyLen * (1 + 0.22 * M.tailFat);
    const reachHead = 0.5 * bodyLen + 0.8 * TUSK_K * bodyLen * M.tusk;
    const reachF = reachLimb(
      SPAN_K * bodyLen * M.fore, CHORD_K * bodyLen * M.fore * M.foreChord,
      M.foreSweep, M.foreRow, 0.2 * bodyLen,
    );
    const reachH = reachLimb(
      SPAN_K * bodyLen * M.hind, CHORD_K * bodyLen * M.hind * M.hindChord,
      M.hindSweep, M.hindRow, 0.29 * bodyLen,
    );
    const reachS = Math.hypot(0.42 * bodyLen, SHW * baseRadius);
    const est = Math.max(reachTail, reachHead, reachF, reachH, reachS);
    const norm = Math.min(1, 2.42 / est);
    bodyLen *= norm;
    baseRadius *= norm;
  }
  // lateral fatness: rz = WF·ry. >1 = wider than tall (a turtle's trunk under
  // the carapace), <1 = laterally compressed (a penguin's keel).
  const WF = M.flat;
  // undulation plane, same rigid-rotation convention as fish.js: at 0 the
  // trunk wave is lateral (a phocid seal sculls side to side), at 1 vertical
  // (an otter porpoises). The heading-turn bend is added AFTER the rotation
  // so a tetrapod still turns left and right, never up and down.
  const UB = M.undulateH * (Math.PI / 2);
  const UCB = Math.cos(UB);
  const USB = Math.sin(UB);

  const spine = createSpine(ringCount, sampleCount);
  const { cosT, sinT } = makeRingTables(ringCount, dotsPerRing, twistPerRing);

  // Elliptical-ring outward normal directions (unit, baked). The normal of the
  // ellipse point (ry·cosθ, rz·sinθ) is ∝ (cosθ/ry, sinθ/rz); with rz = WF·ry
  // the direction depends only on θ — one table shared by every station.
  const ncT = new Float32Array(bodyCount);
  const nsT = new Float32Array(bodyCount);
  for (let d = 0; d < bodyCount; d++) {
    const c = cosT[d];
    const s = sinT[d] / WF;
    const il = 1 / Math.sqrt(c * c + s * s);
    ncT[d] = c * il;
    nsT[d] = s * il;
  }

  // ---- trunk profile: blunt head, thickest ~40%, a neck pinch, and a rear
  // that either tapers away (turtle) or holds its girth (otter's tail).
  const hL = 0.13 * M.snout; //                head-taper span, fraction of body
  const hPow = 0.5 * M.snout * M.snoutPow; //  taper sharpness (decoupled)
  // ---- A HEAD (v3.7 fix) ---------------------------------------------------
  // `nose` on its own is a MONOTONE taper: the front of the animal went from
  // nothing to full girth inside ~5% of the body and never came back down, so
  // there was no skull and no neck — which is most of why a turtle rendered as
  // an almond and a penguin as a rugby ball. A tetrapod's head is a lobe with a
  // WAIST behind it, and that break is the single most recognisable thing about
  // the body plan. Two shapes now sit on top of the taper:
  //   headBulb  a Gaussian lobe at headAt, standing proud of the barrel
  //   neck      the existing pinch, moved to sit immediately BEHIND the lobe
  //             (it used to be pinned at f = 0.2, well aft of the skull, where
  //             it read as a dent in the shoulder) and given real depth
  // `head` is preset-only with a neutral default, so no RNG draw moves (spec 8).
  const headAt = Math.min(0.11, 0.045 + 0.05 * M.snout);
  const headW = 0.052 + 0.02 * M.snout;
  const neckAt = headAt + 0.075 + 0.03 * M.neck;
  const neckW = 0.05;
  const prof = new Float32Array(ringCount);
  const rNom = new Float32Array(ringCount);
  for (let i = 0; i < ringCount; i++) {
    const f = i / (ringCount - 1);
    // exponent 0.62 (fish uses 0.8): a tetrapod trunk is a rounder barrel
    const base = Math.pow(Math.sin(Math.PI * Math.min(1, f * 1.02 + 0.03)), 0.62);
    const nose = 0.14 + 0.86 * Math.pow(Math.min(1, f / hL), hPow);
    const hf = (f - headAt) / headW;
    const head = 1 + 1.15 * M.head * Math.exp(-hf * hf);
    const nk = (f - neckAt) / neckW;
    const neck = 1 - 0.46 * M.neck * Math.exp(-nk * nk);
    let v = base * nose * head * neck;
    // rear floor: blend toward a held girth over the back half
    const w = f > 0.55 ? Math.pow((f - 0.55) / 0.45, 2) : 0;
    v = v * (1 - w) + w * (0.44 * M.tailFat + v * (1 - 0.44 * M.tailFat));
    prof[i] = v;
    rNom[i] = baseRadius * prof[i];
  }
  const rEffY = new Float32Array(ringCount);
  const drds = new Float32Array(ringCount);
  const ds = bodyLen / (ringCount - 1);
  // per-station gravity-dressed frame: RMF (spec §2) is the transport basis;
  // V/H are a smooth in-plane rotation of it (vertical projection + bank roll)
  const Varr = new Float32Array(ringCount * 3);
  const Harr = new Float32Array(ringCount * 3);

  // ---- trunk wave constants. Low wavenumbers on purpose: this is a single
  // gentle body bend, not a traveling wave. `bodyUnd` scales the whole thing.
  const LSC = bodyLen / 3;
  const K1 = 1.6; //  primary trunk bend
  const K2 = 2.9; //  non-harmonic shimmer
  const K3 = 1.1; //  slow secondary flex
  const A1 = 0.075 * LSC * M.bodyUnd;
  const A2 = 0.026 * LSC * M.bodyUnd;
  const A3 = 0.03 * LSC * M.bodyUnd;
  const TURN_A = 0.3 * LSC; // whole-body bend into turns (·u²)
  let ca1 = 0;
  let ca2 = 0;
  let ca3 = 0;
  let cturn = 0;
  let cp1 = 0;
  let cp2 = 0;
  let cp3 = 0;
  const curve = (u, out, o) => {
    const env = 0.1 + 0.9 * Math.pow(u, 1.5); // head steady, rear swings
    const beat = env * (ca1 * Math.sin(K1 * u - cp1) + ca2 * Math.sin(K2 * u - cp2));
    const flex = ca3 * Math.sin(K3 * u - cp3) * (0.3 + 0.7 * u);
    out[o] = (u - 0.5) * bodyLen;
    out[o + 1] = UCB * flex + USB * beat;
    out[o + 2] = UCB * beat + cturn * u * u - USB * flex;
  };

  // ---- shell / dorsal dome statics -----------------------------------------
  // A swept ellipse: at longitudinal row m the cross-section is an ellipse of
  // vertical semi-axis hSh[m] and lateral semi-axis rSh[m], centred shellRise
  // body-radii above the spine, modulated by a cos(nθ) keel ridge.
  const shI = new Int32Array(nShL); // body station carrying each scute row
  const hSh = new Float32Array(nShL);
  const rSh = new Float32Array(nShL);
  const dhSh = new Float32Array(nShL);
  const drSh = new Float32Array(nShL);
  {
    const f0 = 0.13;
    const f1 = 0.93;
    for (let m = 0; m < nShL; m++) {
      const fu = m / (nShL - 1);
      shI[m] = Math.min(ringCount - 1, Math.max(0, Math.round((f0 + (f1 - f0) * fu) * (ringCount - 1))));
      // rounded plan form; a carapace is nearly circular seen from above
      const w = Math.pow(Math.sin(Math.PI * (0.07 + 0.86 * fu)), 0.55);
      hSh[m] = SHH * baseRadius * w;
      rSh[m] = SHW * baseRadius * w;
    }
    const inv0 = nShL - 1;
    for (let m = 0; m < nShL; m++) {
      const ma = m > 0 ? m - 1 : 0;
      const mb = m < nShL - 1 ? m + 1 : m;
      const iv = inv0 / (mb - ma);
      dhSh[m] = (hSh[mb] - hSh[ma]) * iv;
      drSh[m] = (rSh[mb] - rSh[ma]) * iv;
    }
  }
  // angular tables — the dome's columns are quantized, so per-dot trig is zero
  const shCa = new Float32Array(nShL * nShA);
  const shSa = new Float32Array(nShL * nShA);
  const shK = new Float32Array(nShL * nShA); // ridge factor k(a)
  const shDk = new Float32Array(nShL * nShA); // dk/da
  {
    const A = M.shellArc;
    const rg = M.shellRidge;
    const nR = M.shellRidgeN;
    for (let m = 0; m < nShL; m++) {
      const skew = shellTwist * (m - (nShL - 1) * 0.5);
      for (let k = 0; k < nShA; k++) {
        const a = -A + (2 * A * k) / (nShA - 1) + skew;
        const o = m * nShA + k;
        shCa[o] = Math.cos(a);
        shSa[o] = Math.sin(a);
        shK[o] = 1 + rg * Math.cos(nR * a);
        shDk[o] = -rg * nR * Math.sin(nR * a);
      }
    }
  }
  const shC = new Float32Array(nShL * 3); // per-frame dome centreline (scratch)

  // ---- limb statics ---------------------------------------------------------
  // Two pairs, driven by one code path. Everything a pair needs lives in these
  // 2-element tables so the frame loop has no branches and no per-pair objects.
  const pairI = new Int32Array(2); //        attach station
  const pairSpan = new Float32Array(2);
  const pairChord = new Float32Array(2);
  const pairLat = new Float32Array(2); //    lateral base offset (× local rz)
  const pairDrop = new Float32Array(2); //   base drop below the axis (× local ry)
  const pairSweep = new Float32Array(2); //  Λ₀ rest sweep-back
  const pairTilt = new Float32Array(2); //   θ₀ rest elevation
  const pairAmp = new Float32Array(2); //    stroke amplitude
  const pairRate = new Float32Array(2); //   stroke frequency
  const pairFBase = new Float32Array(2); //  shoulder share of the stroke
  const pairPitch = new Float32Array(2); //  feathering amplitude
  const pairRow = new Float32Array(2); //    fore-aft rowing amplitude
  const pairAlt = new Float32Array(2); //    left/right phase split
  const pairTaper = new Float32Array(2); //  chord taper toward the tip
  const pairLag = new Float32Array(2); //    phase lag behind the fore pair
  pairI[0] = Math.round(0.3 * (ringCount - 1));
  pairI[1] = Math.round(0.79 * (ringCount - 1));
  pairSpan[0] = SPAN_K * bodyLen * M.fore;
  pairSpan[1] = SPAN_K * bodyLen * M.hind;
  pairChord[0] = CHORD_K * bodyLen * M.fore * M.foreChord;
  pairChord[1] = CHORD_K * bodyLen * M.hind * M.hindChord;
  pairLat[0] = M.foreLat;
  pairLat[1] = M.hindLat;
  pairDrop[0] = M.foreDrop;
  pairDrop[1] = M.hindDrop;
  pairSweep[0] = M.foreSweep;
  pairSweep[1] = M.hindSweep;
  pairTilt[0] = M.foreTilt;
  pairTilt[1] = M.hindTilt;
  pairAmp[0] = M.foreAmp;
  pairAmp[1] = M.hindAmp;
  pairRate[0] = M.foreRate;
  pairRate[1] = M.hindRate;
  // flex 0 = rigid hydrofoil (tip and shoulder move together), 1 = whip
  pairFBase[0] = 1 - M.foreFlex;
  pairFBase[1] = 1 - M.hindFlex;
  pairPitch[0] = M.forePitch;
  pairPitch[1] = M.hindPitch;
  pairRow[0] = M.foreRow;
  pairRow[1] = M.hindRow;
  pairAlt[0] = M.foreAlt * (Math.PI / 2);
  pairAlt[1] = M.hindAlt * (Math.PI / 2);
  pairTaper[0] = FORE_TAPER;
  pairTaper[1] = HIND_TAPER;
  pairLag[0] = 0;
  pairLag[1] = hindLag;
  // chordwise offset tables — mostly trailing, like a real blade's section
  const pvF = new Float32Array(nFv);
  for (let n = 0; n < nFv; n++) pvF[n] = n / (nFv - 1) - 0.35;
  const pvH = new Float32Array(nHv);
  for (let n = 0; n < nHv; n++) pvH[n] = n / (nHv - 1) - 0.35;

  // ---- muzzle appendage statics (tusks / whiskers / beak) -------------------
  // Expressed in the head station's own (F, V, H) basis — F = forward = −T —
  // so every coefficient below, INCLUDING the ring frame, is build-time
  // constant. The frame path only maps three basis vectors per station.
  const iM = Math.min(ringCount - 1, Math.round(0.07 * (ringCount - 1)));
  const tkLen = TUSK_K * bodyLen * M.tusk;
  const tkRad = 0.055 * baseRadius * M.tuskThick;
  // centreline coefficients aF/aV (integrated), plus the ring frame per side
  const tkAF = new Float32Array(nTu);
  const tkAV = new Float32Array(nTu);
  const tkR = new Float32Array(nTu);
  const tkDr = new Float32Array(nTu);
  // ring basis, per side (0 = −1, 1 = +1), 3 coefficients (F, V, H) each
  const tkR1 = new Float32Array(2 * nTu * 3);
  const tkR2 = new Float32Array(2 * nTu * 3);
  // per-station unit direction in the (F, V, H) basis
  const tkD = new Float32Array(2 * nTu * 3);
  {
    const splay = M.tuskSplay;
    const dl = 1 / Math.sqrt(1 + splay * splay);
    let accF = 0;
    let accV = 0;
    for (let j = 0; j < nTu; j++) {
      const fj = j / (nTu - 1);
      const beta = 0.12 + M.tuskDrop * fj; // bends downward along its length
      if (j > 0) {
        const b0 = 0.12 + M.tuskDrop * ((j - 1) / (nTu - 1));
        const step = 1 / (nTu - 1);
        accF += 0.5 * (Math.cos(beta) + Math.cos(b0)) * step;
        accV += 0.5 * (Math.sin(beta) + Math.sin(b0)) * step;
      }
      tkAF[j] = accF;
      tkAV[j] = accV;
      tkR[j] = tkRad * (1 - 0.85 * fj);
      for (let s = 0; s < 2; s++) {
        const side = s === 0 ? -1 : 1;
        // dir = (cosβ·F − sinβ·V + side·splay·H) / √(1+splay²)
        const dF = Math.cos(beta) * dl;
        const dV = -Math.sin(beta) * dl;
        const dH = side * splay * dl;
        const o = (s * nTu + j) * 3;
        tkD[o] = dF;
        tkD[o + 1] = dV;
        tkD[o + 2] = dH;
        // ---- ring frame: TRANSPORTED, not re-chosen (geometry-spec §2) -----
        // The argmin-basis Gram-Schmidt below is the SEED frame and is run at
        // station 0 only. Re-running it per station — which is what this block
        // used to do — is not a rotation-minimizing frame: the argmin flips as
        // soon as the centreline bends past the basis vector it picked, and the
        // ring's angular phase jumps with it (measured: 93° between stations 0
        // and 1 on the walrus, 102° on the dugong and the manatee). The normals
        // stayed correct, so nothing looked wrong at nTu=7 × nTv=5 — but the
        // defect DIVERGES under refinement, so it would appear the moment tusk
        // resolution was raised, and the module's contract header claims §2.
        // Every later station rotates the previous frame by the minimal
        // rotation taking d_prev to d_cur, which is what double reflection
        // computes and is exact for a discrete curve.
        let e1;
        let e2;
        let e3;
        if (j === 0) {
          // seed: Gram-Schmidt against whichever basis vector is least aligned
          let ax = 0;
          let ay = 0;
          let az = 0;
          const ad = Math.abs(dF);
          if (ad <= Math.abs(dV) && ad <= Math.abs(dH)) ax = 1;
          else if (Math.abs(dV) <= Math.abs(dH)) ay = 1;
          else az = 1;
          const dp = ax * dF + ay * dV + az * dH;
          e1 = ax - dp * dF;
          e2 = ay - dp * dV;
          e3 = az - dp * dH;
        } else {
          const p = ((s * nTu) + j - 1) * 3;
          const pF = tkD[p];
          const pV = tkD[p + 1];
          const pH = tkD[p + 2];
          const r1 = tkR1[p];
          const r2 = tkR1[p + 1];
          const r3 = tkR1[p + 2];
          // Rodrigues about normalize(d_prev × d_cur) by the angle between them
          const kx = pV * dH - pH * dV;
          const ky = pH * dF - pF * dH;
          const kz = pF * dV - pV * dF;
          const sn = Math.sqrt(kx * kx + ky * ky + kz * kz);
          if (sn < 1e-9) {
            e1 = r1;
            e2 = r2;
            e3 = r3;
          } else {
            const ik = 1 / sn;
            const ux = kx * ik;
            const uy = ky * ik;
            const uz = kz * ik;
            const cs = pF * dF + pV * dV + pH * dH;
            const th = Math.atan2(sn, cs);
            const c = Math.cos(th);
            const s2 = Math.sin(th);
            const ud = ux * r1 + uy * r2 + uz * r3;
            e1 = r1 * c + (uy * r3 - uz * r2) * s2 + ux * ud * (1 - c);
            e2 = r2 * c + (uz * r1 - ux * r3) * s2 + uy * ud * (1 - c);
            e3 = r3 * c + (ux * r2 - uy * r1) * s2 + uz * ud * (1 - c);
          }
          // re-orthogonalize against d_cur; floating point drifts over 7 hops
          const dp2 = e1 * dF + e2 * dV + e3 * dH;
          e1 -= dp2 * dF;
          e2 -= dp2 * dV;
          e3 -= dp2 * dH;
        }
        const il = 1 / Math.sqrt(e1 * e1 + e2 * e2 + e3 * e3);
        e1 *= il;
        e2 *= il;
        e3 *= il;
        tkR1[o] = e1;
        tkR1[o + 1] = e2;
        tkR1[o + 2] = e3;
        // r2 = dir × r1 (in basis coordinates — the basis is orthonormal, so
        // the cross product transports unchanged into world space)
        tkR2[o] = dV * e3 - dH * e2;
        tkR2[o + 1] = dH * e1 - dF * e3;
        tkR2[o + 2] = dF * e2 - dV * e1;
      }
    }
    for (let j = 0; j < nTu; j++) {
      const ja = j > 0 ? j - 1 : 0;
      const jb = j < nTu - 1 ? j + 1 : j;
      const seg = ((jb - ja) * tkLen) / (nTu - 1);
      tkDr[j] = seg > 1e-9 ? (tkR[jb] - tkR[ja]) / seg : 0;
    }
  }
  const tkCa = new Float32Array(nTv);
  const tkSa = new Float32Array(nTv);
  for (let n = 0; n < nTv; n++) {
    const a = (n * TAU) / nTv;
    tkCa[n] = Math.cos(a);
    tkSa[n] = Math.sin(a);
  }

  function updateTargets(timeSec, sway, tempo, positions, normals) {
    const t = 2.0 * timeSec * tempo; // tetrapods stroke slower than a fish beats
    cp1 = phase1 + t;
    cp2 = phase2 + t * W_RATIO;
    cp3 = phase3 + t * 0.317;
    // slow non-repeating heading wander; the animal banks into it
    const tt = timeSec * (0.4 + 0.6 * tempo);
    const turn =
      0.588 * (Math.sin(0.31 * tt + turnPhase1) + 0.7 * Math.sin(0.1381 * tt + turnPhase2));
    ca1 = A1 * sway;
    ca2 = A2 * sway;
    ca3 = A3 * Math.min(sway, 1.2);
    cturn = TURN_A * turn;
    spine.update(curve, bodyLen, seedAngle);
    // sway clamp (spec §5): κ ~linear in amplitude, one correction pass
    const mk = spine.maxKappaR(rNom);
    if (mk > KAPPA_R_MAX) {
      const sc = KAPPA_R_MAX / mk;
      ca1 *= sc;
      ca2 *= sc;
      ca3 *= sc;
      cturn *= sc;
      spine.update(curve, bodyLen, seedAngle);
    }
    // effective sway after the clamp — drives limb stroke vigour too, so a
    // sway-0 tetrapod holds a clean static pose instead of a rowing one
    const relAmp = Math.min(sway, 2.4) / 2.4;
    const kap = spine.kappa;
    for (let i = 0; i < ringCount; i++) {
      let r = rNom[i];
      if (kap[i] * r > RING_SHRINK) r = RING_SHRINK / kap[i]; // local guard (§5)
      rEffY[i] = r;
    }
    for (let i = 0; i < ringCount; i++) {
      const ia = i > 0 ? i - 1 : 0;
      const ib = i < ringCount - 1 ? i + 1 : i;
      drds[i] = ib > ia ? (rEffY[ib] - rEffY[ia]) / ((ib - ia) * ds) : 0;
    }
    const P = spine.positions;
    const T = spine.tangents;
    const N = spine.normals;
    const B = spine.binormals;
    // ---- gravity-dressed frames V (up-in-plane, banked) / H = T×V.
    // Expressed in the RMF basis so transport stays RMF (spec §2). `M.bank` is
    // a CONSTANT roll on top of the turn bank — 2.85 rad is what puts a sea
    // otter on its back at the surface, limbs and all.
    const bank = M.bank + 0.3 * turn;
    const cb = Math.cos(bank);
    const sb = Math.sin(bank);
    for (let i = 0; i < ringCount; i++) {
      const oi = i * 3;
      const tx = T[oi];
      const ty = T[oi + 1];
      const tz = T[oi + 2];
      // v = up − (up·T)T, written in (N,B):  a = v·N, b = v·B
      const vx = -ty * tx;
      const vy = 1 - ty * ty;
      const vz = -ty * tz;
      let a = vx * N[oi] + vy * N[oi + 1] + vz * N[oi + 2];
      let b = vx * B[oi] + vy * B[oi + 1] + vz * B[oi + 2];
      const l2 = a * a + b * b;
      if (l2 > 1e-12) {
        const il = 1 / Math.sqrt(l2);
        a *= il;
        b *= il;
      } else {
        a = 1;
        b = 0;
      }
      const ar = a * cb - b * sb; // roll by bank around T
      const br = b * cb + a * sb;
      // V = ar·N + br·B ;  H = T×V = ar·B − br·N  (B = T×N, T×B = −N)
      Varr[oi] = ar * N[oi] + br * B[oi];
      Varr[oi + 1] = ar * N[oi + 1] + br * B[oi + 1];
      Varr[oi + 2] = ar * N[oi + 2] + br * B[oi + 2];
      Harr[oi] = ar * B[oi] - br * N[oi];
      Harr[oi + 1] = ar * B[oi + 1] - br * N[oi + 1];
      Harr[oi + 2] = ar * B[oi + 2] - br * N[oi + 2];
    }

    // ---- 1. trunk: elliptical rings + taper tilt (TUBE normals) ------------
    let d = 0;
    for (let i = 0; i < ringCount; i++) {
      const oi = i * 3;
      const px = P[oi];
      const py = P[oi + 1];
      const pz = P[oi + 2];
      const vX = Varr[oi];
      const vY = Varr[oi + 1];
      const vZ = Varr[oi + 2];
      const hX = Harr[oi];
      const hY = Harr[oi + 1];
      const hZ = Harr[oi + 2];
      const ry = rEffY[i];
      const rz = WF * ry;
      const g = drds[i];
      // taper tilt: n = (radial − r′(s)·T)/√(1+r′²) — unit without per-dot sqrt
      const inl = 1 / Math.sqrt(1 + g * g);
      const gtx = g * inl * T[oi];
      const gty = g * inl * T[oi + 1];
      const gtz = g * inl * T[oi + 2];
      const row = i * dotsPerRing;
      for (let j = 0; j < dotsPerRing; j++, d++) {
        const c = cosT[row + j];
        const s = sinT[row + j];
        const nc = ncT[row + j];
        const ns = nsT[row + j];
        const o = perm[d] * 3;
        positions[o] = px + ry * c * vX + rz * s * hX;
        positions[o + 1] = py + ry * c * vY + rz * s * hY;
        positions[o + 2] = pz + ry * c * vZ + rz * s * hZ;
        normals[o] = (nc * vX + ns * hX) * inl - gtx;
        normals[o + 1] = (nc * vY + ns * hY) * inl - gty;
        normals[o + 2] = (nc * vZ + ns * hZ) * inl - gtz;
      }
    }

    // ---- 2. carapace / dorsal dome (SHEET normals) -------------------------
    // P(m,a) = C(m) + k(a)·( hSh(m)·cos a·V(m) + rSh(m)·sin a·H(m) )
    // Pu = C′ + k·( cos a·(hSh′V + hSh·V′) + sin a·(rSh′H + rSh·H′) )
    // Pv = (k′cos a − k sin a)·hSh·V + (k′sin a + k cos a)·rSh·H
    // Both are true partials of the same surface — never an in-plane offset.
    for (let m = 0; m < nShL; m++) {
      const oi = shI[m] * 3;
      const rise = M.shellRise * rEffY[shI[m]];
      shC[m * 3] = P[oi] + rise * Varr[oi];
      shC[m * 3 + 1] = P[oi + 1] + rise * Varr[oi + 1];
      shC[m * 3 + 2] = P[oi + 2] + rise * Varr[oi + 2];
    }
    const shInv0 = nShL - 1;
    for (let m = 0; m < nShL; m++) {
      const ma = m > 0 ? m - 1 : 0;
      const mb = m < nShL - 1 ? m + 1 : m;
      const iv = shInv0 / (mb - ma);
      const om = shI[m] * 3;
      const oa = shI[ma] * 3;
      const ob = shI[mb] * 3;
      const cx = shC[m * 3];
      const cy = shC[m * 3 + 1];
      const cz = shC[m * 3 + 2];
      const dcx = (shC[mb * 3] - shC[ma * 3]) * iv;
      const dcy = (shC[mb * 3 + 1] - shC[ma * 3 + 1]) * iv;
      const dcz = (shC[mb * 3 + 2] - shC[ma * 3 + 2]) * iv;
      const hh = hSh[m];
      const rr = rSh[m];
      const dh = dhSh[m];
      const dr = drSh[m];
      // Wv = hSh·V, Wh = rSh·H  (the ellipse's semi-axis vectors)
      const wvx = hh * Varr[om];
      const wvy = hh * Varr[om + 1];
      const wvz = hh * Varr[om + 2];
      const whx = rr * Harr[om];
      const why = rr * Harr[om + 1];
      const whz = rr * Harr[om + 2];
      // U1 = hSh′V + hSh·V′ ; U2 = rSh′H + rSh·H′
      const u1x = dh * Varr[om] + hh * (Varr[ob] - Varr[oa]) * iv;
      const u1y = dh * Varr[om + 1] + hh * (Varr[ob + 1] - Varr[oa + 1]) * iv;
      const u1z = dh * Varr[om + 2] + hh * (Varr[ob + 2] - Varr[oa + 2]) * iv;
      const u2x = dr * Harr[om] + rr * (Harr[ob] - Harr[oa]) * iv;
      const u2y = dr * Harr[om + 1] + rr * (Harr[ob + 1] - Harr[oa + 1]) * iv;
      const u2z = dr * Harr[om + 2] + rr * (Harr[ob + 2] - Harr[oa + 2]) * iv;
      const ao = m * nShA;
      for (let k = 0; k < nShA; k++, d++) {
        const ca = shCa[ao + k];
        const sa = shSa[ao + k];
        const kk = shK[ao + k];
        const dk = shDk[ao + k];
        const o = perm[d] * 3;
        positions[o] = cx + kk * (ca * wvx + sa * whx);
        positions[o + 1] = cy + kk * (ca * wvy + sa * why);
        positions[o + 2] = cz + kk * (ca * wvz + sa * whz);
        const pux = dcx + kk * (ca * u1x + sa * u2x);
        const puy = dcy + kk * (ca * u1y + sa * u2y);
        const puz = dcz + kk * (ca * u1z + sa * u2z);
        const q1 = dk * ca - kk * sa;
        const q2 = dk * sa + kk * ca;
        const pvx = q1 * wvx + q2 * whx;
        const pvy = q1 * wvy + q2 * why;
        const pvz = q1 * wvz + q2 * whz;
        // Pv × Pu points OUT of the dome (away from the spine)
        let nx = pvy * puz - pvz * puy;
        let ny = pvz * pux - pvx * puz;
        let nz = pvx * puy - pvy * pux;
        const l2 = nx * nx + ny * ny + nz * nz;
        const il = l2 > 1e-20 ? 1 / Math.sqrt(l2) : 0;
        normals[o] = nx * il;
        normals[o + 1] = ny * il;
        normals[o + 2] = nz * il;
      }
    }

    // ---- 3. the four flippers (SHEET normals) ------------------------------
    // A ruled blade: P(fm,fn) = B + SP·fm·S(fm) + CP·ch(fm)·fn·C(fm), with
    //   e   = side·cosθ·H + sinθ·V     (out-and-up; θ is the STROKE)
    //   p   = e × T = side·cosθ·V − sinθ·H   (blade normal at zero feather)
    //   S   = cosΛ·e + sinΛ·T          (span, swept back by Λ = the ROW)
    //   g   = −sinΛ·e + cosΛ·T         (⊥ S, in the blade plane)
    //   C   = cosψ·g + sinψ·p          (chord, FEATHERED by ψ about S)
    // and the derivatives are exact:
    //   ∂e/∂θ = side·p     ∂p/∂θ = −side·e
    //   S′ = cosΛ·θ′·side·p + Λ′·g
    //   g′ = −sinΛ·θ′·side·p − Λ′·S
    //   C′ = −sinψ·ψ′·g + cosψ·g′ + cosψ·ψ′·p + sinψ·p′
    // Because Pu is affine in fn and Pv is independent of it, the whole
    // cross product collapses to n = (A×Q) + fn·(Bv×Q): two cross products
    // per SPAN STATION, and three multiply-adds plus one normalize per dot.
    for (let pr = 0; pr < 2; pr++) {
      const nU = pr === 0 ? nFu : nHu;
      const nV = pr === 0 ? nFv : nHv;
      const off = pr === 0 ? pvF : pvH;
      const i = pairI[pr];
      const oi = i * 3;
      const Tx = T[oi];
      const Ty = T[oi + 1];
      const Tz = T[oi + 2];
      const Vx = Varr[oi];
      const Vy = Varr[oi + 1];
      const Vz = Varr[oi + 2];
      const Hx = Harr[oi];
      const Hy = Harr[oi + 1];
      const Hz = Harr[oi + 2];
      const SPn = pairSpan[pr];
      const CPn = pairChord[pr];
      const th0 = pairTilt[pr];
      const lam0 = pairSweep[pr];
      const amp = pairAmp[pr] * (0.12 + 0.88 * relAmp);
      const rowA = pairRow[pr] * (0.12 + 0.88 * relAmp);
      const pitA = pairPitch[pr] * (0.12 + 0.88 * relAmp);
      const fb = pairFBase[pr];
      const tap = pairTaper[pr];
      const ph0 = strokePhase + pairLag[pr] + t * pairRate[pr];
      const ryA = rEffY[i];
      const rzA = WF * ryA;
      const latK = pairLat[pr] * rzA;
      const dropK = pairDrop[pr] * ryA;
      for (let side = -1; side <= 1; side += 2) {
        const ph = ph0 + side * pairAlt[pr];
        const sPh = Math.sin(ph);
        const cPh = Math.cos(ph); // the feather leads the stroke by 90°
        const bx = P[oi] + side * latK * Hx - dropK * Vx;
        const by = P[oi + 1] + side * latK * Hy - dropK * Vy;
        const bz = P[oi + 2] + side * latK * Hz - dropK * Vz;
        for (let m = 0; m < nU; m++) {
          const fm = m / (nU - 1);
          const env = fb + (1 - fb) * fm;
          const th = th0 + amp * sPh * env;
          const lam = lam0 + rowA * cPh * env;
          const psi = pitA * cPh * (0.15 + 0.85 * fm);
          const dth = amp * sPh * (1 - fb);
          const dlam = rowA * cPh * (1 - fb);
          const dpsi = pitA * cPh * 0.85;
          const ct = Math.cos(th);
          const st = Math.sin(th);
          const cl = Math.cos(lam);
          const sl = Math.sin(lam);
          const cps = Math.cos(psi);
          const sps = Math.sin(psi);
          const sc = side * ct;
          const ex = sc * Hx + st * Vx;
          const ey = sc * Hy + st * Vy;
          const ez = sc * Hz + st * Vz;
          const ppx = sc * Vx - st * Hx;
          const ppy = sc * Vy - st * Hy;
          const ppz = sc * Vz - st * Hz;
          const Sx = cl * ex + sl * Tx;
          const Sy = cl * ey + sl * Ty;
          const Sz = cl * ez + sl * Tz;
          const gx = cl * Tx - sl * ex;
          const gy = cl * Ty - sl * ey;
          const gz = cl * Tz - sl * ez;
          const k1 = cl * dth * side;
          const dSx = k1 * ppx + dlam * gx;
          const dSy = k1 * ppy + dlam * gy;
          const dSz = k1 * ppz + dlam * gz;
          const k2 = -sl * dth * side;
          const dgx = k2 * ppx - dlam * Sx;
          const dgy = k2 * ppy - dlam * Sy;
          const dgz = k2 * ppz - dlam * Sz;
          const k3 = -side * dth;
          const dpx = k3 * ex;
          const dpy = k3 * ey;
          const dpz = k3 * ez;
          const Cx = cps * gx + sps * ppx;
          const Cy = cps * gy + sps * ppy;
          const Cz = cps * gz + sps * ppz;
          const e1 = cps * dpsi;
          const e2 = -sps * dpsi;
          const dCx = e2 * gx + cps * dgx + e1 * ppx + sps * dpx;
          const dCy = e2 * gy + cps * dgy + e1 * ppy + sps * dpy;
          const dCz = e2 * gz + cps * dgz + e1 * ppz + sps * dpz;
          const ch = 1 - tap * fm;
          // Q = Pv = CP·ch·C ; A = SP·(S + fm·S′) ; Bv = CP·(ch′·C + ch·C′)
          const Qx = CPn * ch * Cx;
          const Qy = CPn * ch * Cy;
          const Qz = CPn * ch * Cz;
          const Ax = SPn * (Sx + fm * dSx);
          const Ay = SPn * (Sy + fm * dSy);
          const Az = SPn * (Sz + fm * dSz);
          const Bx = CPn * (ch * dCx - tap * Cx);
          const By = CPn * (ch * dCy - tap * Cy);
          const Bz = CPn * (ch * dCz - tap * Cz);
          const n0x = Ay * Qz - Az * Qy;
          const n0y = Az * Qx - Ax * Qz;
          const n0z = Ax * Qy - Ay * Qx;
          const n1x = By * Qz - Bz * Qy;
          const n1y = Bz * Qx - Bx * Qz;
          const n1z = Bx * Qy - By * Qx;
          const sx = bx + SPn * fm * Sx;
          const sy = by + SPn * fm * Sy;
          const sz = bz + SPn * fm * Sz;
          for (let n = 0; n < nV; n++, d++) {
            const fn = off[n];
            const o = perm[d] * 3;
            positions[o] = sx + fn * Qx;
            positions[o + 1] = sy + fn * Qy;
            positions[o + 2] = sz + fn * Qz;
            const nx = (n0x + fn * n1x) * side;
            const ny = (n0y + fn * n1y) * side;
            const nz = (n0z + fn * n1z) * side;
            const l2 = nx * nx + ny * ny + nz * nz;
            const il = l2 > 1e-20 ? 1 / Math.sqrt(l2) : 0;
            normals[o] = nx * il;
            normals[o + 1] = ny * il;
            normals[o + 2] = nz * il;
          }
        }
      }
    }

    // ---- 4. muzzle appendages: tusks / whiskers / beak (TUBE normals) ------
    // Coefficients live in the head station's (F, V, H) basis, so this loop
    // does no trig at all: it maps three basis vectors and combines.
    {
      const om = iM * 3;
      const Fx = -T[om];
      const Fy = -T[om + 1];
      const Fz = -T[om + 2];
      const Vx = Varr[om];
      const Vy = Varr[om + 1];
      const Vz = Varr[om + 2];
      const Hx = Harr[om];
      const Hy = Harr[om + 1];
      const Hz = Harr[om + 2];
      const rm = rEffY[iM];
      for (let s = 0; s < 2; s++) {
        const side = s === 0 ? -1 : 1;
        // base: a little forward of the muzzle station and below the axis
        const bx = P[om] + 0.35 * rm * Fx - 0.3 * rm * Vx + side * 0.3 * rm * WF * Hx;
        const by = P[om + 1] + 0.35 * rm * Fy - 0.3 * rm * Vy + side * 0.3 * rm * WF * Hy;
        const bz = P[om + 2] + 0.35 * rm * Fz - 0.3 * rm * Vz + side * 0.3 * rm * WF * Hz;
        for (let j = 0; j < nTu; j++) {
          const o3 = (s * nTu + j) * 3;
          const aF = tkLen * tkAF[j];
          const aV = tkLen * tkAV[j];
          const aH = tkLen * (j / (nTu - 1)) * M.tuskSplay * side;
          const cx = bx + aF * Fx - aV * Vx + aH * Hx;
          const cy = by + aF * Fy - aV * Vy + aH * Hy;
          const cz = bz + aF * Fz - aV * Vz + aH * Hz;
          const r1x = tkR1[o3] * Fx + tkR1[o3 + 1] * Vx + tkR1[o3 + 2] * Hx;
          const r1y = tkR1[o3] * Fy + tkR1[o3 + 1] * Vy + tkR1[o3 + 2] * Hy;
          const r1z = tkR1[o3] * Fz + tkR1[o3 + 1] * Vz + tkR1[o3 + 2] * Hz;
          const r2x = tkR2[o3] * Fx + tkR2[o3 + 1] * Vx + tkR2[o3 + 2] * Hx;
          const r2y = tkR2[o3] * Fy + tkR2[o3 + 1] * Vy + tkR2[o3 + 2] * Hy;
          const r2z = tkR2[o3] * Fz + tkR2[o3 + 1] * Vz + tkR2[o3 + 2] * Hz;
          const dx = tkD[o3] * Fx + tkD[o3 + 1] * Vx + tkD[o3 + 2] * Hx;
          const dy = tkD[o3] * Fy + tkD[o3 + 1] * Vy + tkD[o3 + 2] * Hy;
          const dz = tkD[o3] * Fz + tkD[o3 + 1] * Vz + tkD[o3 + 2] * Hz;
          const rad = tkR[j];
          const gr = tkDr[j];
          const inl = 1 / Math.sqrt(1 + gr * gr);
          const gtx = gr * inl * dx;
          const gty = gr * inl * dy;
          const gtz = gr * inl * dz;
          for (let n = 0; n < nTv; n++, d++) {
            const ca = tkCa[n];
            const sa = tkSa[n];
            const ux = ca * r1x + sa * r2x;
            const uy = ca * r1y + sa * r2y;
            const uz = ca * r1z + sa * r2z;
            const o = perm[d] * 3;
            positions[o] = cx + rad * ux;
            positions[o + 1] = cy + rad * uy;
            positions[o + 2] = cz + rad * uz;
            normals[o] = ux * inl - gtx;
            normals[o + 1] = uy * inl - gty;
            normals[o + 2] = uz * inl - gtz;
          }
        }
      }
    }
  }

  function init({ aSize, aTw, aRing }) {
    let d = 0;
    // ---- DOT PRESENCE IS THE ONLY CONTRAST THIS MEDIUM HAS -----------------
    // v3.7.0 gave the trunk, the carapace and the flippers near-identical dot
    // sizes, so at the ~150 px an animal actually occupies they composited into
    // one undifferentiated cloud: the shell had no edge against the back under
    // it and a flipper mid-stroke read as scattered spray beside the body
    // rather than as a paddle. Nothing here moves a dot — every number below
    // is aSize only, so positions, normals, the RNG draw order and the dot
    // count are all untouched (spec 8/9). What changes is which structure the
    // eye picks out first, which for a shelled or flippered animal IS the
    // silhouette.
    //
    // shellDom: is this dome a real carapace (turtle 2.4x1.65 -> 1) or just the
    // rounded dorsal contour every other morph carries (seal 0.62x0.4 -> 0.09)?
    const shellDom = Math.min(1, Math.max(0, (SHW * SHH - 0.32) / 1.9));
    // trunk
    for (let i = 0; i < ringCount; i++) {
      const rf = i / (ringCount - 1);
      const sz = 0.55 + 0.45 * prof[i];
      const row = i * dotsPerRing;
      for (let j = 0; j < dotsPerRing; j++, d++) {
        const sl = perm[d];
        // cosT is the ring angle's VERTICAL component in the station frame:
        // +1 straight up the animal's back, -1 straight down its belly.
        const up = cosT[row + j];
        // counter-shading, and the shell's own shadow: under a real carapace
        // the back is not visible at all, so its dots step aside for the dome
        // instead of speckling through it.
        const shade = 1 - M.counter * 0.42 * Math.max(0, up)
          - shellDom * 0.5 * Math.max(0, up);
        aSize[sl] = sz * Math.max(shade, 0.3) * sizeJit[d];
        aTw[sl] = twPhase[d];
        aRing[sl] = rf; // head→tail fraction, ring-quantized
      }
    }
    // carapace — aRing follows the scute BANDS, so twinkle/iridescence read
    // as plate rows rather than as noise on a dome. A true carapace is the
    // animal's DOMINANT surface and gets the biggest dots on the body; the
    // crown is weighted over the rim so the dome has a gradient of its own and
    // reads as curved rather than as a flat plate.
    for (let m = 0; m < nShL; m++) {
      const rf = shI[m] / (ringCount - 1);
      const ao = m * nShA;
      for (let k = 0; k < nShA; k++, d++) {
        const sl = perm[d];
        const crown = 0.72 + 0.28 * Math.abs(shCa[ao + k]); // 1 at the crest
        aSize[sl] = (0.7 + 0.5 * shellDom) * crown * sizeJit[d];
        aTw[sl] = twPhase[d];
        aRing[sl] = rf;
      }
    }
    // flippers — a blade is read from its EDGES. The chordwise weighting puts
    // the presence on the leading edge and lets the middle of the blade fall
    // away, which is what turns a patch of dots into a paddle with a stroke;
    // the spanwise taper keeps the tip lighter than the shoulder.
    for (let pr = 0; pr < 2; pr++) {
      const nU = pr === 0 ? nFu : nHu;
      const nV = pr === 0 ? nFv : nHv;
      const pv = pr === 0 ? pvF : pvH;
      const rf = pairI[pr] / (ringCount - 1);
      for (let side = 0; side < 2; side++) {
        for (let m = 0; m < nU; m++) {
          const fm = m / (nU - 1);
          for (let n = 0; n < nV; n++, d++) {
            const sl = perm[d];
            // pv runs −0.35 (leading edge) to +0.65 (trailing edge)
            const e = pv[n] + 0.35; // 0 .. 1 across the chord
            const edge = 0.55 + 0.45 * Math.abs(2 * e - 1); // bright at both edges
            aSize[sl] = 0.82 * (1 - 0.34 * fm) * edge * sizeJit[d];
            aTw[sl] = twPhase[d];
            aRing[sl] = rf;
          }
        }
      }
    }
    // muzzle appendages
    for (let s = 0; s < 2; s++) {
      for (let j = 0; j < nTu; j++) {
        const fj = j / (nTu - 1);
        for (let n = 0; n < nTv; n++, d++) {
          const sl = perm[d];
          aSize[sl] = 0.5 * (1 - 0.35 * fj) * sizeJit[d];
          aTw[sl] = twPhase[d];
          aRing[sl] = 0.02 * fj; // the very front of the animal
        }
      }
    }
  }

  return { count, ringCount, init, updateTargets };
}

// Creature registry — all 9 archetypes behind one factory. Pure module (only
// imports the three-free geometry makers) so it stays node-importable.
//
// Per-archetype visual/behavior defaults live here so the board (main.js)
// stays a thin conductor:
//   maker     factory (seed, opts?) → { count, ringCount, init, updateTargets }
//   class     'swimmer' | 'rooted' | 'drifter'
//   boundR    fixed local bounding-sphere radius (geometry-spec §10),
//             measured over sway 2.4 sweeps with margin
//   scale     local units → CSS px (world) at size modifier 1
//   dotPx     dot sprite size in CSS px at the creature's depth
//   alpha     per-creature brightness multiplier
//   speed     roam speed, px/s (swimmers only)
//   yawOffset rotation.y added so local "forward" faces the heading
//             (eel/fish bodies run head at −x → π; ray head at −z → −π/2)
//   pitch     base rotation.x — flat archetypes tilt toward the camera
//   spin      idle yaw spin rad/s (drifters; star spins internally → 0)
//   band      v3.4 — the archetype's home in the vertical water column
//             (src/depthbands.js), in METRES below the surface. This is the
//             DEFAULT: a named species ("anglerfish", "dolphin") overrides it
//             via the lexicon's own band lookup. Note the two floor classes:
//             the rooted archetypes (bloom, kelp) are planted in the seabed —
//             flora cannot float, that is not tunable — and `star` is benthic,
//             an animal that lives ON the floor without being rooted to it.

import { makeEel } from './geometry/eel.js';
import { makeRay } from './geometry/ray.js';
import { makeMedusa } from './geometry/medusa.js';
import { makeFish } from './geometry/fish.js';
import { makeOcto } from './geometry/octo.js';
import { makeStar } from './geometry/star.js';
import { makeAmorph } from './geometry/amorph.js';
import { makeBloom } from './geometry/bloom.js';
import { makeKelp } from './geometry/kelp.js';
import { makeTetrapod } from './geometry/tetrapod.js';
import { ARCH_BANDS, bandFor, isRootedBand, isFloorBand } from './depthbands.js';

const HPI = Math.PI / 2;

export const REGISTRY = {
  eel: {
    maker: makeEel, class: 'swimmer', boundR: 3.5,
    scale: 52, dotPx: 3.07, alpha: 1.0, speed: 30,
    yawOffset: Math.PI, pitch: 0, spin: 0,
    band: ARCH_BANDS.eel,
  },
  fish: {
    maker: makeFish, class: 'swimmer', boundR: 2.6,
    scale: 54, dotPx: 2.87, alpha: 1.1, speed: 40,
    yawOffset: Math.PI, pitch: 0, spin: 0,
    band: ARCH_BANDS.fish,
  },
  ray: {
    maker: makeRay, class: 'swimmer', boundR: 3.4,
    scale: 50, dotPx: 3.37, alpha: 1.5, speed: 24,
    yawOffset: -HPI, pitch: -0.85, spin: 0,
    band: ARCH_BANDS.ray,
  },
  medusa: {
    maker: makeMedusa, class: 'drifter', boundR: 6.4,
    scale: 30, dotPx: 3.11, alpha: 1.0, speed: 0,
    yawOffset: 0, pitch: 0, spin: 0.09,
    band: ARCH_BANDS.medusa,
  },
  octo: {
    maker: makeOcto, class: 'drifter', boundR: 3.3,
    scale: 40, dotPx: 2.85, alpha: 0.95, speed: 0,
    yawOffset: 0, pitch: 0.12, spin: 0.11,
    band: ARCH_BANDS.octo,
  },
  star: {
    maker: makeStar, class: 'drifter', boundR: 2.7,
    scale: 46, dotPx: 3.11, alpha: 1.15, speed: 0,
    yawOffset: 0, pitch: -1.05, spin: 0, // spins internally (~0.2 rad/s)
    band: ARCH_BANDS.star, // benthic: an animal ON the floor, not rooted to it
  },
  amorph: {
    maker: makeAmorph, class: 'drifter', boundR: 2.9,
    scale: 40, dotPx: 2.63, alpha: 0.9, speed: 0,
    yawOffset: 0, pitch: 0, spin: 0.07,
    band: ARCH_BANDS.amorph,
  },
  bloom: {
    maker: makeBloom, class: 'rooted', boundR: 3.9,
    // alpha 1.05 -> 0.82: dense-crown morphs (anemone, rose) pile many short
    // petals into a small area and blew out to a white core.
    scale: 46, dotPx: 3.03, alpha: 0.82, speed: 0,
    yawOffset: 0, pitch: 0, spin: 0,
    band: ARCH_BANDS.bloom, // rooted — planted on the seabed, never floating
  },
  kelp: {
    maker: makeKelp, class: 'rooted', boundR: 5.8,
    scale: 42, dotPx: 2.6, alpha: 0.95, speed: 0,
    yawOffset: 0, pitch: 0, spin: 0,
    band: ARCH_BANDS.kelp, // rooted — planted on the seabed, never floating
  },
  // v3.7 — the marine tetrapods: a rounded trunk plus PADDLING limbs, the one
  // body plan the undulating-spine archetypes could not express. Before this,
  // "turtle" resolved to `ray` (a flat sheet). Local forward is head at −x,
  // the same convention as eel/fish, so yawOffset is π.
  //
  // APPENDED DELIBERATELY: ARCHETYPES is Object.keys(REGISTRY), so a new key
  // goes at the END — inserting one mid-object would renumber every existing
  // archetype for any index-based consumer.
  tetrapod: {
    maker: makeTetrapod, class: 'swimmer', boundR: 2.6,
    scale: 56, dotPx: 2.95, alpha: 1.05, speed: 28,
    yawOffset: Math.PI, pitch: 0, spin: 0,
    // boundR 2.6 is measured, not guessed: max |P| = 2.02 over all 9 presets
    // plus 60 seed-only builds × sway {0, 1, 2.4} × 240 frames — 1.28× margin
    // (geometry-spec §10, fixed local bounding sphere).
    //
    // Air-breathers live at the ceiling of the column and must surface.
    // depthbands.js has no `tetrapod` ARCH_BAND yet, so the turtle species
    // band (1–130 m, "must reach air") is the archetype default — see the
    // handoff note about adding seal / penguin / otter / walrus bands.
    band: bandFor('turtle'),
  },
};

export const ARCHETYPES = Object.keys(REGISTRY);

// One factory: archetype name → built skeleton generator.
export function makeCreatureGeometry(arch, seed, opts) {
  const entry = REGISTRY[arch];
  if (!entry) throw new Error(`unknown archetype: ${arch}`);
  return entry.maker(seed, opts);
}

// ---- v3.4 depth helpers ---------------------------------------------------
// Thin, so callers never have to know whether a band came from the archetype
// table or the species table. depthbands.js remains the authority; nothing
// here re-derives a band.

/** The archetype's default depth band (metres below the surface). */
export function bandForArch(arch) {
  const entry = REGISTRY[arch];
  return (entry && entry.band) || bandFor(arch);
}

/** True if this archetype is planted in the seabed (bloom, kelp). Identical to
 *  `REGISTRY[arch].class === 'rooted'` by construction — the two are kept in
 *  agreement here so a future archetype cannot drift apart from its band. */
export function isRootedArch(arch) {
  return isRootedBand(bandForArch(arch));
}

/** True if the archetype lives ON the floor: rooted flora OR benthic animals
 *  (star). Placement uses the seabed relief for both. */
export function isFloorArch(arch) {
  return isFloorBand(bandForArch(arch));
}

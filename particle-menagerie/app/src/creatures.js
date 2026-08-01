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

import { makeEel } from './geometry/eel.js';
import { makeRay } from './geometry/ray.js';
import { makeMedusa } from './geometry/medusa.js';
import { makeFish } from './geometry/fish.js';
import { makeOcto } from './geometry/octo.js';
import { makeStar } from './geometry/star.js';
import { makeAmorph } from './geometry/amorph.js';
import { makeBloom } from './geometry/bloom.js';
import { makeKelp } from './geometry/kelp.js';

const HPI = Math.PI / 2;

export const REGISTRY = {
  eel: {
    maker: makeEel, class: 'swimmer', boundR: 3.5,
    scale: 52, dotPx: 3.07, alpha: 1.0, speed: 30,
    yawOffset: Math.PI, pitch: 0, spin: 0,
  },
  fish: {
    maker: makeFish, class: 'swimmer', boundR: 2.6,
    scale: 54, dotPx: 2.87, alpha: 1.1, speed: 40,
    yawOffset: Math.PI, pitch: 0, spin: 0,
  },
  ray: {
    maker: makeRay, class: 'swimmer', boundR: 3.4,
    scale: 50, dotPx: 3.37, alpha: 1.5, speed: 24,
    yawOffset: -HPI, pitch: -0.85, spin: 0,
  },
  medusa: {
    maker: makeMedusa, class: 'drifter', boundR: 6.4,
    scale: 30, dotPx: 3.11, alpha: 1.0, speed: 0,
    yawOffset: 0, pitch: 0, spin: 0.09,
  },
  octo: {
    maker: makeOcto, class: 'drifter', boundR: 3.3,
    scale: 40, dotPx: 2.85, alpha: 0.95, speed: 0,
    yawOffset: 0, pitch: 0.12, spin: 0.11,
  },
  star: {
    maker: makeStar, class: 'drifter', boundR: 2.7,
    scale: 46, dotPx: 3.11, alpha: 1.15, speed: 0,
    yawOffset: 0, pitch: -1.05, spin: 0, // spins internally (~0.2 rad/s)
  },
  amorph: {
    maker: makeAmorph, class: 'drifter', boundR: 2.9,
    scale: 40, dotPx: 2.63, alpha: 0.9, speed: 0,
    yawOffset: 0, pitch: 0, spin: 0.07,
  },
  bloom: {
    maker: makeBloom, class: 'rooted', boundR: 3.9,
    // alpha 1.05 -> 0.82: dense-crown morphs (anemone, rose) pile many short
    // petals into a small area and blew out to a white core.
    scale: 46, dotPx: 3.03, alpha: 0.82, speed: 0,
    yawOffset: 0, pitch: 0, spin: 0,
  },
  kelp: {
    maker: makeKelp, class: 'rooted', boundR: 5.8,
    scale: 42, dotPx: 2.6, alpha: 0.95, speed: 0,
    yawOffset: 0, pitch: 0, spin: 0,
  },
};

export const ARCHETYPES = Object.keys(REGISTRY);

// One factory: archetype name → built skeleton generator.
export function makeCreatureGeometry(arch, seed, opts) {
  const entry = REGISTRY[arch];
  if (!entry) throw new Error(`unknown archetype: ${arch}`);
  return entry.maker(seed, opts);
}

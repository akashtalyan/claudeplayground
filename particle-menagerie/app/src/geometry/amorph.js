// Amorph — volume archetype. Pure math, no three.js (node-benchable).
// Contract: geometry-spec.md. LOCAL space (§10); radial pseudo-normals from
// the blob center (§ normals table — deliberate stylization); zero allocation
// in updateTargets (§4). Dots sit on QUANTIZED concentric shells (§7): the
// dotted-rib look in 3D. Shape = 2-3 low-frequency plane-wave harmonics
// (incommensurate rates, so the morph never repeats — spec §1 spirit),
// breathing pulse traveling center→surface, slow differential drift-rotation
// per shell (inner shells turn faster — v2's drift-morph, lifted to 3D).

import { mulberry32, hashName } from './rng.js';
import { TAU } from './spine.js';

const GA = Math.PI * (3 - Math.sqrt(5)); // golden angle — Fibonacci lattice
const SWAY_MAX = 2.4; // slider 2.4 = max safe sway (spec §5 normalization)
const BR_A = 0.055; // breathing amp per sway unit → 0.132 at 2.4 (v2: 0.13)
const WOB_A = 0.13; // harmonic amp per sway unit → 0.312 at 2.4 (v2: 0.32)
// three incommensurate morph rates + breath rate (never phase-locks)
const W_BR = 1.4;
const W1 = 1.9;
const W2 = 1.9 / 1.618033988749895;
const W3 = 1.9 * 0.41421356237; // √2−1
const A1H = 0.5; // harmonic mix, Σ = 1 (amplitude normalization: at sway
const A2H = 0.3; // 2.4 the radial field stays within ±0.312 — shells can
const A3H = 0.2; // never collapse through the center or fold negative)
const SQUASH_Y = 0.88; // v2's gentle vertical squash

// ---- named-species morph presets (v3.8) -----------------------------------
// LEX.amorph is the catch-all bucket, so it had collected animals with wildly
// different body plans — a krill, a scallop, a pyrosome and a copepod were all
// the SAME gently-wobbling ball, differing only in size. The blob is the right
// primitive for all of them (none has a skeleton the tube/sheet archetypes
// could hang off), but it needed axes:
//   size    R0 ×
//   long    x semi-axis ×  — the ONLY way to say "this animal is a tube".
//           A salp/pyrosome colony is a metres-long hollow cylinder; a krill is
//           a 5:1 dart. A sphere cannot express either.
//   flat    y semi-axis ×, on top of SQUASH_Y. A scallop is two hinged plates:
//           its whole identity is that it is flat (0.3), and a sand-dollar-ish
//           limpet likewise.
//   wide    z semi-axis ×  — bivalve shells are flat AND round, not flat rods.
//   lumpy   harmonic amplitude ×. A nudibranch is all frills (1.9); a shelled
//           mollusc is smooth and rigid (0.15) — a wobbling clam is wrong.
//   breath  breathing-pulse ×. Cemented/shelled things barely move.
//   scale/tempo/speed  world hints for lexicon.js; ignored here.
export const AMORPH_MORPHS = {
  // Crustacean darts: long, laterally compressed, faintly segmented.
  krill: {
    size: 0.5, long: 2.6, flat: 0.62, wide: 0.72, lumpy: 1.25, breath: 1.3,
    scale: 0.4, tempo: 1.6, speed: 1.3,
  },
  shrimp: {
    size: 0.72, long: 2.3, flat: 0.7, wide: 0.78, lumpy: 1.2, breath: 1.15,
    scale: 0.6, tempo: 1.35, speed: 1.1,
  },
  // Copepods are the most numerous animals on Earth and they are TINY —
  // a millimetre of teardrop with one long antenna pair.
  copepod: {
    size: 0.34, long: 2.0, flat: 0.8, wide: 0.85, lumpy: 1.0, breath: 1.5,
    scale: 0.3, tempo: 2.0, speed: 1.4,
  },
  // Bivalves: two flat, smooth, near-rigid plates. lumpy is nearly off.
  bivalve: {
    size: 0.62, long: 1.05, flat: 0.3, wide: 1.15, lumpy: 0.15, breath: 0.35,
    scale: 0.5, tempo: 0.3, speed: 0.15,
  },
  // A scallop is a bivalve that SWIMS by clapping — same plates, live hinge.
  scallop: {
    size: 0.66, long: 1.0, flat: 0.34, wide: 1.15, lumpy: 0.22, breath: 1.5,
    scale: 0.5, tempo: 1.1, speed: 0.5,
  },
  // Cemented cone on rock: a low dome, wider than tall, essentially inert.
  barnacle: {
    size: 0.5, long: 0.95, flat: 0.55, wide: 0.95, lumpy: 0.3, breath: 0.25,
    scale: 0.35, tempo: 0.4, speed: 0,
  },
  // Sea slugs are soft, elongate and covered in cerata — maximum lumpy.
  nudibranch: {
    size: 0.72, long: 1.85, flat: 0.72, wide: 0.9, lumpy: 1.9, breath: 1.1,
    scale: 0.5, tempo: 0.8, speed: 0.35,
  },
  // Pelagic tunicates: transparent hollow cylinders, some colonies metres long.
  // Smooth to the point of featureless — the lumpy field is what would make a
  // pyrosome look like a blob instead of a tube.
  salp: {
    size: 0.8, long: 3.4, flat: 0.85, wide: 0.85, lumpy: 0.12, breath: 0.8,
    scale: 0.7, tempo: 0.6, speed: 0.45,
  },
  pyrosome: {
    size: 1.15, long: 4.2, flat: 0.9, wide: 0.9, lumpy: 0.1, breath: 0.5,
    scale: 1.4, tempo: 0.35, speed: 0.3,
  },
  // Single cells and the things that glow when you disturb them: small spheres.
  microplankton: {
    size: 0.3, long: 1, flat: 1, wide: 1, lumpy: 0.8, breath: 1.4,
    scale: 0.28, tempo: 1.5, speed: 0.7,
  },
};
const AMORPH_ALIASES = {
  krill: ['krill', 'euphausiid'],
  shrimp: ['shrimp', 'prawn', 'amphipod'],
  copepod: ['copepod'],
  bivalve: ['clam', 'quahog', 'oyster', 'mussel', 'cockle', 'abalone', 'limpet', 'chiton'],
  scallop: ['scallop'],
  barnacle: ['barnacle'],
  nudibranch: ['nudibranch', 'seaslug', 'sea slug'],
  salp: ['salp', 'seasquirt', 'sea squirt', 'tunicate'],
  pyrosome: ['pyrosome', 'seapickle', 'sea pickle'],
  microplankton: [
    'plankton', 'foraminifera', 'foram', 'seasparkle', 'sea sparkle',
    'noctiluca', 'dinoflagellate', 'dinoflagellatebloom', 'redtide', 'red tide',
  ],
};
const MORPH_BY_SEED = new Map();
for (const k of Object.keys(AMORPH_MORPHS)) {
  for (const n of AMORPH_ALIASES[k] || [k]) {
    MORPH_BY_SEED.set(hashName(n), AMORPH_MORPHS[k]);
    MORPH_BY_SEED.set(hashName(n + 's'), AMORPH_MORPHS[k]);
  }
}
/** Preset lookup by name, for lexicon.js (mirrors FISH_MORPHS[word] usage). */
export function amorphMorphFor(word) {
  if (!word) return null;
  const w = String(word).toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(AMORPH_MORPHS, w)) return AMORPH_MORPHS[w];
  return MORPH_BY_SEED.get(hashName(w)) || null;
}

export function makeAmorph(seed, opts = {}) {
  // v3.2 density uplift: 1300 dots / 12 shells → 3000 / 16 (2.31×). Shells and
  // dots rise together (~1.33× radial, ~1.35× tangential on the outer shell) so
  // the nested-shell read is preserved: pushing shells alone would separate
  // them into visibly discrete onion layers, pushing dots alone would blur the
  // shells into a solid ball. The Fibonacci lattice per shell keeps its crisp
  // spiral quantization (§7) — nothing is randomly scattered.
  const shellCount = opts.shellCount ?? 16;
  const count = opts.count ?? 3000;
  const baseRadius = opts.radius ?? 1.8;
  // preset resolution (pure function of opts.morph / seed — no RNG, so the
  // frozen draw order below is untouched and determinism is unaffected)
  const preset = opts.morph ?? MORPH_BY_SEED.get(seed >>> 0) ?? null;
  // semi-axis scales. sy folds in v2's stock SQUASH_Y so an unpresetted blob
  // is byte-identical to v3.7.
  const M = {
    size: preset?.size ?? 1,
    sx: preset?.long ?? 1,
    sy: SQUASH_Y * (preset?.flat ?? 1),
    sz: preset?.wide ?? 1,
    lumpy: preset?.lumpy ?? 1,
    breath: preset?.breath ?? 1,
  };
  // Ellipsoid normal ∝ (x/a², y/b², z/c²). v3.7 normalized the raw position,
  // which is only correct on a SPHERE; at sx = 4.2 (a pyrosome) that points a
  // tube's flank down its own axis and the whole colony shades as one flat
  // smear. Precomputing 1/s² keeps it to three multiplies per dot.
  const iax = 1 / (M.sx * M.sx);
  const iay = 1 / (M.sy * M.sy);
  const iaz = 1 / (M.sz * M.sz);

  const rng = mulberry32(seed);
  // ---- FROZEN DRAW ORDER (spec §8) — append only, never insert ----
  const axZ = 2 * rng() - 1; //                           draw 1: drift axis
  const axAng = rng() * TAU; //                           draw 2
  const breathPhase = rng() * TAU; //                     draw 3
  const R0 = baseRadius * (0.85 + 0.3 * rng()) * M.size; // draw 4: size jitter
  const driftRate = 0.18 + 0.14 * rng(); //               draw 5: drift-morph
  const twistPerShell = (rng() * 2 - 1) * 0.7; //         draw 6: shell twist
  // 3 harmonics × (wave-vector dir 2, magnitude 1, phase 1) draws 7 .. 18
  const qx = new Float32Array(3);
  const qy = new Float32Array(3);
  const qz = new Float32Array(3);
  const qPh = new Float32Array(3);
  for (let h = 0; h < 3; h++) {
    const z = 2 * rng() - 1;
    const a = rng() * TAU;
    const mag = 1.6 + 1.4 * rng(); // |q| ∈ [1.6, 3.0] → 2-3 lobes across blob
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    qx[h] = mag * r * Math.cos(a);
    qy[h] = mag * z;
    qz[h] = mag * r * Math.sin(a);
    qPh[h] = rng() * TAU;
  }
  const sizeJit = new Float32Array(count); //             draws 19 .. 18+count
  for (let d = 0; d < count; d++) sizeJit[d] = 0.75 + 0.5 * rng();
  const twPhase = new Float32Array(count); //             next count draws
  for (let d = 0; d < count; d++) twPhase[d] = rng() * TAU;
  // Cross-shell shuffle (spec §9): drawRange prefix = uniform subsample.
  const perm = new Uint32Array(count); //                 next count−1 draws
  for (let d = 0; d < count; d++) perm[d] = d;
  for (let d = count - 1; d > 0; d--) {
    const j = (rng() * (d + 1)) | 0;
    const t = perm[d];
    perm[d] = perm[j];
    perm[j] = t;
  }
  // ---- end frozen draw order ----

  // drift axis (unit)
  const axR = Math.sqrt(Math.max(0, 1 - axZ * axZ));
  const ux = axR * Math.cos(axAng);
  const uy = axZ;
  const uz = axR * Math.sin(axAng);

  // ---- quantized shells: fr_i = (i+1)/S; per-shell dot counts ∝ a blend of
  // fr² (uniform surface density) with a floor so inner shells stay visible.
  // Deterministic pure math (spec §9: counts never vary), exact-sum rounding.
  const frs = new Float32Array(shellCount);
  const shellStart = new Uint32Array(shellCount + 1);
  {
    let W = 0;
    for (let i = 0; i < shellCount; i++) {
      const f = (i + 1) / shellCount;
      frs[i] = f;
      W += 0.18 + 0.82 * f * f;
    }
    let cw = 0;
    shellStart[0] = 0;
    for (let i = 0; i < shellCount; i++) {
      const f = frs[i];
      cw += 0.18 + 0.82 * f * f;
      shellStart[i + 1] = Math.round((count * cw) / W); // exact-sum rounding
    }
  }

  // ---- static per-dot tables: unit direction on each shell's Fibonacci
  // lattice (crisp, never randomly scattered — §7) + per-harmonic phase
  // decomposition sin(a+ωt) = sin(a)cos(ωt) + cos(a)sin(ωt), so the frame
  // loop does ZERO per-dot trig (spec §3, amortized to build time).
  const dirX = new Float32Array(count);
  const dirY = new Float32Array(count);
  const dirZ = new Float32Array(count);
  const sA1 = new Float32Array(count);
  const cA1 = new Float32Array(count);
  const sA2 = new Float32Array(count);
  const cA2 = new Float32Array(count);
  const sA3 = new Float32Array(count);
  const cA3 = new Float32Array(count);
  for (let i = 0; i < shellCount; i++) {
    const n = shellStart[i + 1] - shellStart[i];
    const fr = frs[i];
    const tw = twistPerShell * i;
    for (let k = 0; k < n; k++) {
      const d = shellStart[i] + k;
      const y = 1 - (2 * (k + 0.5)) / n;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const th = k * GA + tw;
      const x = r * Math.cos(th);
      const z = r * Math.sin(th);
      dirX[d] = x;
      dirY[d] = y;
      dirZ[d] = z;
      const a1 = (qx[0] * x + qy[0] * y + qz[0] * z) * fr + qPh[0];
      const a2 = (qx[1] * x + qy[1] * y + qz[1] * z) * fr + qPh[1];
      const a3 = (qx[2] * x + qy[2] * y + qz[2] * z) * fr + qPh[2];
      sA1[d] = A1H * Math.sin(a1);
      cA1[d] = A1H * Math.cos(a1);
      sA2[d] = A2H * Math.sin(a2);
      cA2[d] = A2H * Math.cos(a2);
      sA3[d] = A3H * Math.sin(a3);
      cA3[d] = A3H * Math.cos(a3);
    }
  }

  function updateTargets(timeSec, sway, tempo, positions, normals) {
    const t = timeSec * tempo;
    const s = Math.min(sway, SWAY_MAX);
    const br = BR_A * s * M.breath;
    const wob = WOB_A * s * M.lumpy;
    const pB = breathPhase + W_BR * t;
    // per-frame trig: 2 per harmonic + 1 breath + 2 per shell — that's it
    const c1 = Math.cos(W1 * t);
    const s1 = Math.sin(W1 * t);
    const c2 = Math.cos(W2 * t);
    const s2 = Math.sin(W2 * t);
    const c3 = Math.cos(W3 * t);
    const s3 = Math.sin(W3 * t);
    const driftT = driftRate * t;
    for (let i = 0; i < shellCount; i++) {
      const fr = frs[i];
      // breathing pulse travels center → surface (3D upgrade of v2's pulse)
      const breath = 1 + br * Math.sin(pB - fr * 0.9);
      const shellR = R0 * fr * breath;
      // slow drift-morph: differential rotation, inner shells faster (v2)
      const th = driftT * (1 - 0.85 * fr);
      const ca = Math.cos(th);
      const sa = Math.sin(th);
      const ic = 1 - ca; // Rodrigues rotation about the drift axis
      const m00 = ca + ux * ux * ic;
      const m01 = ux * uy * ic - uz * sa;
      const m02 = ux * uz * ic + uy * sa;
      const m10 = uy * ux * ic + uz * sa;
      const m11 = ca + uy * uy * ic;
      const m12 = uy * uz * ic - ux * sa;
      const m20 = uz * ux * ic - uy * sa;
      const m21 = uz * uy * ic + ux * sa;
      const m22 = ca + uz * uz * ic;
      const end = shellStart[i + 1];
      for (let d = shellStart[i]; d < end; d++) {
        // low-frequency radial field: Σ A_h·sin(q_h·P0 + ω_h·t + φ_h)
        const w =
          1 +
          wob *
            (sA1[d] * c1 + cA1[d] * s1 + (sA2[d] * c2 + cA2[d] * s2) + (sA3[d] * c3 + cA3[d] * s3));
        const rad = shellR * w;
        const x0 = dirX[d];
        const y0 = dirY[d];
        const z0 = dirZ[d];
        const px = (m00 * x0 + m01 * y0 + m02 * z0) * rad * M.sx;
        const py = (m10 * x0 + m11 * y0 + m12 * z0) * rad * M.sy;
        const pz = (m20 * x0 + m21 * y0 + m22 * z0) * rad * M.sz;
        // ellipsoid pseudo-normal from the blob center (spec normals table —
        // still radial, now anisotropy-corrected so elongated bodies shade)
        const nx = px * iax;
        const ny = py * iay;
        const nz = pz * iaz;
        const il = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        const o = perm[d] * 3;
        positions[o] = px;
        positions[o + 1] = py;
        positions[o + 2] = pz;
        normals[o] = nx * il;
        normals[o + 1] = ny * il;
        normals[o + 2] = nz * il;
      }
    }
  }

  function init({ aSize, aTw, aRing }) {
    const inv = shellCount > 1 ? 1 / (shellCount - 1) : 0;
    for (let i = 0; i < shellCount; i++) {
      const rf = i * inv; // center → surface fraction, shell-quantized
      const sz = 0.5 + 0.5 * frs[i]; // outer shells carry the larger dots
      const end = shellStart[i + 1];
      for (let d = shellStart[i]; d < end; d++) {
        const sl = perm[d];
        aSize[sl] = sz * sizeJit[d];
        aTw[sl] = twPhase[d];
        aRing[sl] = rf;
      }
    }
  }

  return { count, ringCount: shellCount, init, updateTargets };
}

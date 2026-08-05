// Eel — tube archetype. Pure math, no three.js (node-benchable).
// Contract: geometry-spec.md. LOCAL space (§10); ring-offset normals with
// taper tilt (§ normals table); zero allocation in updateTargets (§4).

import { mulberry32, hashName } from './rng.js';
import { createSpine, makeRingTables, KAPPA_R_MAX, RING_SHRINK, TAU } from './spine.js';

// w2/w1 = √2·φ — incommensurate, so the coil never repeats (spec §1)
const W_RATIO = Math.SQRT2 * 1.618033988749895;

// ---- named-species morph presets (v3.8) -----------------------------------
// eel.js had NO preset system at all, so every long soft body — moray,
// dragonfish, gulper eel, sea cucumber — was byte-identical in shape and
// differed only by sway phase. These axes are the ones that separate them:
//   len       body length ×          girth     tube radius ×
//   headBulk  anterior SWELLING, added over the first `headSpan` of the body.
//             The gulper eel is almost entirely jaw ("a loose net bigger than
//             the rest of its body") and nothing in the plain taper could
//             express a flared head.
//   headSpan  how far back the swelling reaches (fraction of body)
//   taper     tail taper exponent. The stock 0.75 drives the radius to zero —
//             correct for an eel, WRONG for a sea cucumber, which is a tube of
//             near-constant thickness with two rounded ends (taper ≈ 0.12).
//   undulate  traveling-wave amplitude ×. A cucumber creeps; it does not
//             undulate, so its waves are cut to a quarter.
//   scale/tempo/speed  world hints for lexicon.js; ignored here.
export const EEL_MORPHS = {
  // A ribbon with a heavy head and a whip tail; the red barbel is biolum's job
  dragonfish: {
    len: 0.95, girth: 0.6, headBulk: 0.9, headSpan: 0.1, taper: 0.95,
    undulate: 1.15, scale: 0.55, tempo: 1.1,
  },
  // Mostly jaw. headBulk 2.6 over the first 13% is the whole animal.
  gulpereel: {
    len: 0.95, girth: 0.85, headBulk: 2.6, headSpan: 0.13, taper: 1.6,
    undulate: 0.95, scale: 0.85, tempo: 0.8, speed: 0.7,
  },
  // A stubby sausage of near-constant thickness with both ends rounded.
  seacucumber: {
    len: 0.42, girth: 1.55, headBulk: 0.12, headSpan: 0.3, taper: 0.12,
    undulate: 0.22, scale: 0.7, tempo: 0.35, speed: 0.3,
  },
};
const EEL_ALIASES = {
  dragonfish: ['dragonfish', 'black dragonfish', 'blackdragonfish'],
  gulpereel: ['gulpereel', 'gulper eel', 'gulper', 'pelicaneel', 'pelican eel'],
  seacucumber: ['seacucumber', 'sea cucumber', 'cucumber', 'holothurian'],
};
const MORPH_BY_SEED = new Map();
for (const k of Object.keys(EEL_MORPHS)) {
  for (const n of EEL_ALIASES[k] || [k]) {
    MORPH_BY_SEED.set(hashName(n), EEL_MORPHS[k]);
    MORPH_BY_SEED.set(hashName(n + 's'), EEL_MORPHS[k]);
  }
}
/** Preset lookup by name, for lexicon.js (mirrors FISH_MORPHS[word] usage). */
export function eelMorphFor(word) {
  if (!word) return null;
  const w = String(word).toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(EEL_MORPHS, w)) return EEL_MORPHS[w];
  return MORPH_BY_SEED.get(hashName(w)) || null;
}

export function makeEel(seed, opts = {}) {
  // v3.2 density uplift: 52×24 (1248) → 80×32 (2560), a uniform ~1.5× linear
  // refinement in BOTH directions, so ribs get finer without the tube going
  // stripy: rib pitch 6.0/79 ≈ 0.076 vs circumferential 2πr/32 ≈ 0.078 at the
  // fullest station — isotropic dot spacing is what reads as "finer detail"
  // rather than "mush". Ring QUANTIZATION is untouched (spec §7).
  // Only the count-sized RNG blocks (sizeJit / twPhase / perm) change length;
  // the draw ORDER and block structure are byte-for-byte the same (spec §8).
  const ringCount = opts.ringCount ?? 80;
  const dotsPerRing = opts.dotsPerRing ?? 32;
  const count = ringCount * dotsPerRing;
  // preset resolution (pure function of opts.morph / seed — no RNG, so the
  // frozen draw order below is untouched and determinism is unaffected)
  const preset = opts.morph ?? MORPH_BY_SEED.get(seed >>> 0) ?? null;
  const M = {
    len: preset?.len ?? 1,
    girth: preset?.girth ?? 1,
    headBulk: preset?.headBulk ?? 0,
    headSpan: preset?.headSpan ?? 0.12,
    taper: preset?.taper ?? 0.75,
    undulate: preset?.undulate ?? 1,
  };
  const bodyLen = (opts.bodyLength ?? 6.0) * M.len;
  const baseRadius = (opts.radius ?? 0.4) * M.girth;
  // Arc samples stay at v3.1's 200 (spec §6's "~200"). The worry was that κ is
  // differenced over the now-finer station pitch, so a starved sampler would
  // make κ noisy and the §5 sway clamp bite harder — a denser eel that sways
  // LESS. Measured against a 600-sample build over 240 frames at sway 0/1/2.4:
  // max position delta 0.0014 = 0.05% of extent. It doesn't; 200 is plenty.
  const sampleCount = opts.sampleCount ?? 200;

  const rng = mulberry32(seed);
  // ---- FROZEN DRAW ORDER (spec §8) — append only, never insert ----
  const seedAngle = rng() * TAU; //                      draw 1: RMF seed frame
  const phase1 = rng() * TAU; //                         draw 2
  const phase2 = rng() * TAU; //                         draw 3
  const twistPerRing = (rng() * 2 - 1) * 0.11; //        draw 4: spiral rib twist
  const sizeJit = new Float32Array(count); //            draws 5 .. 4+count
  for (let d = 0; d < count; d++) sizeJit[d] = 0.75 + 0.5 * rng();
  const twPhase = new Float32Array(count); //            next count draws
  for (let d = 0; d < count; d++) twPhase[d] = rng() * TAU;
  // Cross-ring shuffle (spec §9): dot→vertex-slot permutation so any
  // drawRange prefix is a uniform subsample.        next count−1 draws
  const perm = new Uint32Array(count);
  for (let d = 0; d < count; d++) perm[d] = d;
  for (let d = count - 1; d > 0; d--) {
    const j = (rng() * (d + 1)) | 0;
    const t = perm[d];
    perm[d] = perm[j];
    perm[j] = t;
  }
  // ---- end frozen draw order ----

  const spine = createSpine(ringCount, sampleCount);
  const { cosT, sinT } = makeRingTables(ringCount, dotsPerRing, twistPerRing);

  // taper: blunt head, full by ~1/8 body, tapers to a point at the tail.
  // v3.8: `taper` exposes the tail exponent (0.75 = the eel identity; 0.12 is
  // a sea cucumber's near-uniform tube) and `headBulk` adds a gaussian
  // anterior swelling (a gulper eel's jaw).
  const prof = new Float32Array(ringCount);
  const rNom = new Float32Array(ringCount);
  for (let i = 0; i < ringCount; i++) {
    const f = i / (ringCount - 1);
    let p = Math.sqrt(Math.min(1, 0.25 + 6 * f)) * Math.pow(1 - f, M.taper);
    if (M.headBulk > 0) {
      const z = f / M.headSpan;
      p *= 1 + M.headBulk * Math.exp(-z * z);
    }
    prof[i] = p;
    rNom[i] = baseRadius * p;
  }
  const rEff = new Float32Array(ringCount);
  const drds = new Float32Array(ringCount);
  const ds = bodyLen / (ringCount - 1);

  // two incommensurate traveling waves (spec §1); non-harmonic spatial freqs
  const K1 = 4.6;
  const K2 = 2.9;
  const A1 = 0.3 * (bodyLen / 6) * M.undulate;
  const A2 = 0.22 * (bodyLen / 6) * M.undulate;
  let ca1 = 0;
  let ca2 = 0;
  let cp1 = 0;
  let cp2 = 0;
  const curve = (u, out, o) => {
    const env = 0.25 + 0.75 * u; // head steadier than tail
    out[o] = (u - 0.5) * bodyLen;
    out[o + 1] = ca1 * env * Math.sin(K1 * u - cp1);
    out[o + 2] = ca2 * env * Math.sin(K2 * u - cp2);
  };

  function updateTargets(timeSec, sway, tempo, positions, normals) {
    const t = 1.7 * timeSec * tempo;
    cp1 = phase1 + t;
    cp2 = phase2 + t * W_RATIO;
    ca1 = A1 * sway;
    ca2 = A2 * sway;
    spine.update(curve, bodyLen, seedAngle);
    // sway clamp (spec §5): rescale amplitude so max(κ·r) ≤ 0.7, re-evaluate
    // (κ is ~linear in amplitude, one correction pass suffices)
    const m = spine.maxKappaR(rNom);
    if (m > KAPPA_R_MAX) {
      const sc = KAPPA_R_MAX / m;
      ca1 *= sc;
      ca2 *= sc;
      spine.update(curve, bodyLen, seedAngle);
    }
    const kap = spine.kappa;
    for (let i = 0; i < ringCount; i++) {
      let r = rNom[i];
      if (kap[i] * r > RING_SHRINK) r = RING_SHRINK / kap[i]; // local guard (§5)
      rEff[i] = r;
    }
    for (let i = 0; i < ringCount; i++) {
      const ia = i > 0 ? i - 1 : 0;
      const ib = i < ringCount - 1 ? i + 1 : i;
      drds[i] = ib > ia ? (rEff[ib] - rEff[ia]) / ((ib - ia) * ds) : 0;
    }
    const P = spine.positions;
    const T = spine.tangents;
    const N = spine.normals;
    const B = spine.binormals;
    let d = 0;
    for (let i = 0; i < ringCount; i++) {
      const oi = i * 3;
      const px = P[oi];
      const py = P[oi + 1];
      const pz = P[oi + 2];
      const nx = N[oi];
      const ny = N[oi + 1];
      const nz = N[oi + 2];
      const bx = B[oi];
      const by = B[oi + 1];
      const bz = B[oi + 2];
      const r = rEff[i];
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
        const dx = c * nx + s * bx;
        const dy = c * ny + s * by;
        const dz = c * nz + s * bz;
        const o = perm[d] * 3;
        positions[o] = px + r * dx;
        positions[o + 1] = py + r * dy;
        positions[o + 2] = pz + r * dz;
        normals[o] = dx * inl - gtx;
        normals[o + 1] = dy * inl - gty;
        normals[o + 2] = dz * inl - gtz;
      }
    }
  }

  function init({ aSize, aTw, aRing }) {
    let d = 0;
    for (let i = 0; i < ringCount; i++) {
      const rf = i / (ringCount - 1);
      const sz = 0.55 + 0.45 * prof[i];
      for (let j = 0; j < dotsPerRing; j++, d++) {
        const sl = perm[d];
        aSize[sl] = sz * sizeJit[d];
        aTw[sl] = twPhase[d];
        aRing[sl] = rf; // head→tail fraction, ring-quantized
      }
    }
  }

  return { count, ringCount, init, updateTargets };
}

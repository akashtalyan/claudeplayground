// Kelp — rooted flora, tube class. Pure math, no three.js (node-benchable).
// Contract: geometry-spec.md. LOCAL space (§10): root anchor at the local
// origin, growth along +Y; ring-offset normals with taper tilt (§ normals
// table); zero allocation in updateTargets (§4); frozen RNG draw order (§8,
// unconditional draws — always MAX_STRANDS per-strand draws, fixed dot count
// regardless of how many strands the seed actually grows).
//
// Motion soul ported from v2 ARCH.kelp: 3-6 strands from one anchor, a
// current-driven traveling wave running root→tip (sin(t·w − u·k) form, v2's
// `t*freq*0.85 - u*2.6 + st*1.4`), amplitude ramping with height so the root
// stays planted and the tip swings free, per-strand phase offsets and length
// variance (v2's `hm`), plus a gentle downstream lean standing in for
// G.current. Upgraded to 3D: each strand is an arc-length-true RMF tube
// (spine.js, §§2/5/6) with a second incommensurate wave in the cross-current
// plane so the canopy weaves instead of fanning in a flat sheet.

import { mulberry32 } from './rng.js';
import { createSpine, makeRingTables, KAPPA_R_MAX, RING_SHRINK, TAU } from './spine.js';

// secondary (cross-current) wave rate — incommensurate with the main wave
// (spec §1 spirit) so the weave pattern never repeats
const W_RATIO = Math.SQRT2 * 1.618033988749895 * 0.5;
const MAX_STRANDS = 6;
const K1 = 2.6; // main wave spatial freq (radians over the strand) — v2's u*2.6
const K2 = 1.7; // cross wave spatial freq, non-harmonic with K1
const T_RATE = 0.9; // calm — kelp sways slower than anything that swims

export function makeKelp(seed, opts = {}) {
  // Phase E polish: 120×10 (1200 dots) → 132×12 (1584) — a fuller canopy
  // within the ~1600 budget; ring/dot counts are the only densification, so
  // the RNG stream keeps its exact block structure (draw ORDER unchanged,
  // per-dot blocks simply extended — append-only within each block).
  const ringsTotal = opts.rings ?? 132; // rings shared across strands
  const dotsPerRing = opts.dotsPerRing ?? 12;
  const count = ringsTotal * dotsPerRing; // fixed 1584 for every seed
  const H0 = opts.height ?? 4.6;
  const baseRadius = opts.radius ?? 0.1;
  // Anchor fan radius. v2 spaced strand bases ~0.12·H apart (a visible stand
  // of kelp); the original 0.35 clumped all roots into one apparent stalk —
  // integrator bug fix: widened, with strands fanned evenly in azimuth below.
  const spread = opts.spread ?? 1.05;
  const sampleCount = opts.sampleCount ?? 140; // per-strand curve samples

  const rng = mulberry32(seed);
  // ---- FROZEN DRAW ORDER (spec §8) — append only, never insert ----
  const K = 4 + ((rng() * 3) | 0); //   draw 1: strand count 4-6 (Phase E: min
  //                     3 → 4, denser stand — pure remap of the same draw)
  const seedAng = new Float32Array(MAX_STRANDS); // per-strand block: 8 × 6 draws
  const ph1 = new Float32Array(MAX_STRANDS); //     (always MAX_STRANDS, so the
  const ph2 = new Float32Array(MAX_STRANDS); //      stream never shifts with K)
  const lenJ = new Float32Array(MAX_STRANDS);
  const twist = new Float32Array(MAX_STRANDS);
  const baseAng = new Float32Array(MAX_STRANDS);
  const baseDist = new Float32Array(MAX_STRANDS);
  const ampJ = new Float32Array(MAX_STRANDS);
  for (let k = 0; k < MAX_STRANDS; k++) {
    seedAng[k] = rng() * TAU; //                          RMF seed frame (§2)
    ph1[k] = rng() * TAU; //                              main wave phase
    ph2[k] = rng() * TAU; //                              cross wave phase
    lenJ[k] = 0.78 + 0.42 * rng(); //                     length variance (v2 hm)
    twist[k] = (rng() * 2 - 1) * 0.14; //                 spiral rib twist (§7)
    baseAng[k] = rng() * TAU; //                          anchor azimuth
    baseDist[k] = Math.sqrt(rng()) * spread; //           anchor offset
    ampJ[k] = 0.85 + 0.3 * rng(); //                      sway amplitude variance
  }
  const sizeJit = new Float32Array(count); //             next count draws
  for (let d = 0; d < count; d++) sizeJit[d] = 0.75 + 0.5 * rng();
  const twPhase = new Float32Array(count); //             next count draws
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

  // Distribute the fixed ring budget across the K live strands (first
  // `ringsTotal % K` strands take one extra ring; total is always exact).
  const strands = [];
  const baseRings = (ringsTotal / K) | 0;
  for (let k = 0; k < K; k++) {
    const rings = baseRings + (k < ringsTotal % K ? 1 : 0);
    const len = H0 * lenJ[k];
    const { cosT, sinT } = makeRingTables(rings, dotsPerRing, twist[k]);
    // taper: slim stipe at the root, fullest low-mid, thinning to the tip
    const prof = new Float32Array(rings);
    const rNom = new Float32Array(rings);
    for (let i = 0; i < rings; i++) {
      const f = i / (rings - 1);
      prof[i] = Math.pow(1 - 0.62 * f, 0.85) * Math.sqrt(Math.min(1, 0.3 + 5 * f));
      rNom[i] = baseRadius * prof[i];
    }
    // Even azimuth fan with seeded jitter (same draws, new placement map):
    // strands surround the anchor instead of clumping into one stalk.
    const fanAng = (k / K) * TAU + ((baseAng[k] / TAU - 0.5) * TAU * 0.6) / K;
    const fanDist = spread * 0.5 + baseDist[k] * 0.5;
    strands.push({
      spine: createSpine(rings, sampleCount),
      rings,
      len,
      ds: len / (rings - 1),
      bx: Math.cos(fanAng) * fanDist,
      bz: Math.sin(fanAng) * fanDist,
      cosT,
      sinT,
      prof,
      rNom,
      rEff: new Float32Array(rings),
      drds: new Float32Array(rings),
    });
  }

  // per-strand curve state, written before each spine.update (no closures
  // allocated per frame — one shared curve function reads these)
  let cBx = 0;
  let cBz = 0;
  let cLen = 1;
  let cA1 = 0;
  let cA2 = 0;
  let cP1 = 0;
  let cP2 = 0;
  let cLn = 0;
  const curve = (u, out, o) => {
    const env = Math.pow(u, 1.55); // planted at the root, free at the tip
    const bow = u * u; // downstream lean (v2's G.current push)
    out[o] = cBx + cA1 * env * Math.sin(K1 * u - cP1) + cLn * bow;
    out[o + 1] = u * cLen; // grows +Y; arc-length trueness makes the tip
    out[o + 2] = cBz + cA2 * env * Math.sin(K2 * u - cP2) + cLn * 0.35 * bow; //  dip as it sways (§6)
  };

  const A1 = 0.5; // main (downstream) wave amplitude per unit sway, at H0
  const A2 = 0.32; // cross-current weave amplitude
  const LEAN = 0.28; // steady downstream bow per unit sway

  function updateTargets(timeSec, sway, tempo, positions, normals) {
    const t = T_RATE * timeSec * tempo;
    let d = 0;
    for (let k = 0; k < K; k++) {
      const st = strands[k];
      const relLen = st.len / H0;
      cBx = st.bx;
      cBz = st.bz;
      cLen = st.len;
      cP1 = ph1[k] + t;
      cP2 = ph2[k] + t * W_RATIO;
      cA1 = A1 * relLen * ampJ[k] * sway;
      cA2 = A2 * relLen * ampJ[k] * sway;
      cLn = LEAN * relLen * sway;
      const spine = st.spine;
      spine.update(curve, st.len, seedAng[k]);
      // sway clamp (spec §5): rescale so max(κ·r) ≤ 0.7; κ ~linear in
      // amplitude, one correction pass suffices
      const m = spine.maxKappaR(st.rNom);
      if (m > KAPPA_R_MAX) {
        const sc = KAPPA_R_MAX / m;
        cA1 *= sc;
        cA2 *= sc;
        cLn *= sc;
        spine.update(curve, st.len, seedAng[k]);
      }
      const rings = st.rings;
      const kap = spine.kappa;
      const rEff = st.rEff;
      const drds = st.drds;
      const rNom = st.rNom;
      for (let i = 0; i < rings; i++) {
        let r = rNom[i];
        if (kap[i] * r > RING_SHRINK) r = RING_SHRINK / kap[i]; // local guard (§5)
        rEff[i] = r;
      }
      for (let i = 0; i < rings; i++) {
        const ia = i > 0 ? i - 1 : 0;
        const ib = i < rings - 1 ? i + 1 : i;
        drds[i] = ib > ia ? (rEff[ib] - rEff[ia]) / ((ib - ia) * st.ds) : 0;
      }
      const P = spine.positions;
      const T = spine.tangents;
      const N = spine.normals;
      const B = spine.binormals;
      const cosT = st.cosT;
      const sinT = st.sinT;
      for (let i = 0; i < rings; i++) {
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
        // taper tilt: n = (radial − r′(s)·T)/√(1+r′²) — unit, no per-dot sqrt
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
  }

  function init({ aSize, aTw, aRing }) {
    let d = 0;
    for (let k = 0; k < K; k++) {
      const st = strands[k];
      for (let i = 0; i < st.rings; i++) {
        const rf = i / (st.rings - 1);
        const sz = 0.55 + 0.45 * st.prof[i];
        for (let j = 0; j < dotsPerRing; j++, d++) {
          const sl = perm[d];
          aSize[sl] = sz * sizeJit[d];
          aTw[sl] = twPhase[d];
          aRing[sl] = rf; // root→tip fraction, ring-quantized (§7)
        }
      }
    }
  }

  return { count, ringCount: ringsTotal, init, updateTargets };
}

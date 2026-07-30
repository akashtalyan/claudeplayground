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
//
// Ocean-plant morphs (Phase F): appended seed-drawn axes — strand count up to
// 12 (extra per-strand block appended after the frozen v1 stream), blade
// flatness (elliptical ring squash, fish-style baked normal tables), curl
// (spatial frequency + amplitude of the travelling waves), droop (static
// outward bow with vertical sag), fan (confine the stand near the XZ x-axis
// plane, strands leaning laterally — sea-fan silhouette), plus width/height
// spread. Named species resolve exactly like FISH_MORPHS: a preset overrides
// VALUES only — every RNG draw still happens, so the stream never shifts.

import { mulberry32, hashName } from './rng.js';
import { createSpine, makeRingTables, KAPPA_R_MAX, RING_SHRINK, TAU } from './spine.js';

// secondary (cross-current) wave rate — incommensurate with the main wave
// (spec §1 spirit) so the weave pattern never repeats
const W_RATIO = Math.SQRT2 * 1.618033988749895 * 0.5;
const MAX_STRANDS = 6; //  v1 frozen per-strand draw block (never grows)
const MAX_STRANDS2 = 12; // morph ceiling; strands 7-12 draw from the APPENDED block
const K1 = 2.6; // main wave spatial freq (radians over the strand) — v2's u*2.6
const K2 = 1.7; // cross wave spatial freq, non-harmonic with K1
const T_RATE = 0.9; // calm — kelp sways slower than anything that swims
const FAN_LEAN = 1.1; // lateral in-plane lean at fan=1 (× len at the tip, ·u²)
const DROOP_BEND = 2.2; // outward bow at droop=1 (× len at the tip, ·u²)

// ---- named-species morph presets -----------------------------------------
// Axes (multipliers on the seed-drawn base unless noted):
//   strands  absolute strand count 1..12 (seed default: 4-6)
//   width    strand radius ×            height  strand length × (keep ≤ 1.05)
//   flat     cross-section squash: 1 = round tube, →0.15 flattened ribbon
//   curl     wave spatial freq × (sway amplitude follows as √curl)
//   droop    0..1 static outward bow + vertical sag (stubby/weeping look)
//   fan      0..1 planar confinement: anchors on the ±X axis, strands lean
//            laterally in-plane, cross-current wave + downstream lean damped
//   spread   anchor fan radius ×
//   scale    world-scale hint — consumed by lexicon.js only, ignored here
// Exported for lexicon.js (resolve/params path). makeKelp also resolves a
// preset directly from its seed (hashName of the bare species name) so the
// board path — which passes only the seed — gets species shapes for free.
export const KELP_MORPHS = {
  seagrass: { strands: 12, width: 0.55, height: 0.55, flat: 0.22, curl: 0.6, droop: 0.08, fan: 0, spread: 1.15, scale: 0.9 },
  seaweed: { strands: 3, width: 2.3, height: 0.85, flat: 0.3, curl: 1.7, droop: 0.18, fan: 0, spread: 0.8, scale: 1.0 },
  seafan: { strands: 12, width: 0.8, height: 0.72, flat: 0.5, curl: 0.5, droop: 0, fan: 1, spread: 0.45, scale: 1.05 },
  coral: { strands: 10, width: 2.6, height: 0.32, flat: 1.0, curl: 1.3, droop: 0.55, fan: 0, spread: 1.3, scale: 0.9 },
};
KELP_MORPHS.fan = KELP_MORPHS.seafan; // word alias ("fan" → sea fan)

// seed → preset (the clean name of a bare species IS its seed via hashName;
// plural too; plus the two-word 'sea fan' spelling the lexicon produces)
const MORPH_BY_SEED = new Map();
for (const k of Object.keys(KELP_MORPHS)) {
  MORPH_BY_SEED.set(hashName(k), KELP_MORPHS[k]);
  MORPH_BY_SEED.set(hashName(k + 's'), KELP_MORPHS[k]);
}
MORPH_BY_SEED.set(hashName('sea fan'), KELP_MORPHS.seafan);
MORPH_BY_SEED.set(hashName('sea fans'), KELP_MORPHS.seafan);

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

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
  const seedAng = new Float32Array(MAX_STRANDS2); // per-strand block: 8 × 6 draws
  const ph1 = new Float32Array(MAX_STRANDS2); //    (always MAX_STRANDS here, so
  const ph2 = new Float32Array(MAX_STRANDS2); //     the stream never shifts with
  const lenJ = new Float32Array(MAX_STRANDS2); //    K; entries 6-11 come from
  const twist = new Float32Array(MAX_STRANDS2); //   the APPENDED block below)
  const baseAng = new Float32Array(MAX_STRANDS2);
  const baseDist = new Float32Array(MAX_STRANDS2);
  const ampJ = new Float32Array(MAX_STRANDS2);
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
  // Morph axes — APPENDED after the whole v1 stream (spec §8). Unconditional,
  // fixed counts; a named-species preset overrides VALUES, never skips draws.
  const widthJ = 0.85 + 0.3 * rng(); //                   draw: strand width ×
  const heightJ = 0.85 + 0.15 * rng(); //                 draw: strand height ×
  const flatJ = 0.55 + 0.45 * rng(); //                   draw: blade flatness
  const curlJ = 0.75 + 0.5 * rng(); //                    draw: curl amount
  const droopJ = 0.22 * rng(); //                         draw: droop amount
  for (let k = MAX_STRANDS; k < MAX_STRANDS2; k++) { //   appended strand block
    seedAng[k] = rng() * TAU; //                          (6 × 8 draws, same
    ph1[k] = rng() * TAU; //                               field order as the
    ph2[k] = rng() * TAU; //                               v1 block above)
    lenJ[k] = 0.78 + 0.42 * rng();
    twist[k] = (rng() * 2 - 1) * 0.14;
    baseAng[k] = rng() * TAU;
    baseDist[k] = Math.sqrt(rng()) * spread;
    ampJ[k] = 0.85 + 0.3 * rng();
  }
  // ---- end frozen draw order ----

  // preset resolution: explicit opts.morph wins; else the seed itself may BE
  // a named species (board path passes only the seed); else pure seed morphs
  const preset = opts.morph ?? MORPH_BY_SEED.get(seed >>> 0) ?? null;
  const M = {
    strands: clamp(Math.round(preset?.strands ?? K), 1, MAX_STRANDS2),
    width: preset?.width ?? widthJ,
    height: clamp(preset?.height ?? heightJ, 0.1, 1.05),
    flat: clamp(preset?.flat ?? flatJ, 0.15, 1),
    curl: clamp(preset?.curl ?? curlJ, 0.25, 2.5),
    droop: clamp(preset?.droop ?? droopJ, 0, 1),
    fan: clamp(preset?.fan ?? 0, 0, 1),
    spread: preset?.spread ?? 1,
  };
  const Ke = M.strands;
  const ampM = Math.sqrt(M.curl); // curlier ribbons also swing a bit harder
  // Many-strand stands (> v1 max) get proportionally fewer curve samples per
  // strand: rings-per-strand shrinks with Ke, so per-strand arc sampling can
  // too — keeps a 12-strand stand near the 5-strand frame budget (§3). Pure
  // function of (opts, morph): no RNG, no per-machine variance (§8/§9 safe).
  const sampEff =
    Ke > MAX_STRANDS ? Math.max(48, Math.round((sampleCount * MAX_STRANDS) / Ke)) : sampleCount;

  // Distribute the fixed ring budget across the Ke live strands (first
  // `ringsTotal % Ke` strands take one extra ring; total is always exact).
  const strands = [];
  const baseRings = (ringsTotal / Ke) | 0;
  for (let k = 0; k < Ke; k++) {
    const rings = baseRings + (k < ringsTotal % Ke ? 1 : 0);
    const len = H0 * lenJ[k] * M.height;
    const { cosT, sinT } = makeRingTables(rings, dotsPerRing, twist[k]);
    // Blade flatness: squash the ring into an ellipse (B axis × flat). The
    // outward normal of (r·cosθ, flat·r·sinθ) is ∝ (cosθ, sinθ/flat) — bake
    // unit normal tables (the fish ellipse pattern) and bake the squash into
    // sinT itself so the per-dot loop stays exactly as cheap as a round tube.
    const n = rings * dotsPerRing;
    const ncT = new Float32Array(n);
    const nsT = new Float32Array(n);
    for (let dd = 0; dd < n; dd++) {
      const c = cosT[dd];
      const s = sinT[dd] / M.flat;
      const il = 1 / Math.sqrt(c * c + s * s);
      ncT[dd] = c * il;
      nsT[dd] = s * il;
      sinT[dd] *= M.flat; // position offset along B — squashed in place
    }
    // taper: slim stipe at the root, fullest low-mid, thinning to the tip
    const prof = new Float32Array(rings);
    const rNom = new Float32Array(rings);
    for (let i = 0; i < rings; i++) {
      const f = i / (rings - 1);
      prof[i] = Math.pow(1 - 0.62 * f, 0.85) * Math.sqrt(Math.min(1, 0.3 + 5 * f));
      rNom[i] = baseRadius * M.width * prof[i];
    }
    // Even azimuth fan with seeded jitter (same draws, new placement map):
    // strands surround the anchor instead of clumping into one stalk. At
    // fan→1 the azimuth collapses onto the ±X axis (planar sea-fan stand).
    const azR = (k / Ke) * TAU + ((baseAng[k] / TAU - 0.5) * TAU * 0.6) / Ke;
    const az = azR * (1 - M.fan) + (k % 2) * Math.PI * M.fan;
    const fanDist = (spread * 0.5 + baseDist[k] * 0.5) * M.spread;
    // static bend: droop bows outward from the stand center and sags the tip;
    // fan leans strands laterally in-plane, spread −1..1 across the stand
    const fanIdx = Ke > 1 ? (2 * k) / (Ke - 1) - 1 : 0;
    const bendMag = (1 - M.fan) * DROOP_BEND * M.droop;
    strands.push({
      spine: createSpine(rings, sampEff),
      rings,
      len,
      ds: len / (rings - 1),
      bx: Math.cos(az) * fanDist,
      bz: Math.sin(az) * fanDist,
      bendX: (M.fan * FAN_LEAN * fanIdx + bendMag * Math.cos(az)) * len,
      bendZ: bendMag * Math.sin(az) * len,
      sag: 0.5 * M.droop,
      k1: K1 * M.curl,
      k2: K2 * M.curl,
      cosT,
      sinT,
      ncT,
      nsT,
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
  let cK1 = K1;
  let cK2 = K2;
  let cBendX = 0;
  let cBendZ = 0;
  let cSag = 0;
  const curve = (u, out, o) => {
    const env = Math.pow(u, 1.55); // planted at the root, free at the tip
    const bow = u * u; // downstream lean (v2's G.current push) + static bend
    out[o] = cBx + cA1 * env * Math.sin(cK1 * u - cP1) + (cLn + cBendX) * bow;
    out[o + 1] = u * cLen * (1 - cSag * bow); // grows +Y; arc-length trueness
    out[o + 2] = cBz + cA2 * env * Math.sin(cK2 * u - cP2) + (cLn * 0.35 + cBendZ) * bow; // makes the tip dip as it sways (§6)
  };

  const A1 = 0.5; // main (downstream) wave amplitude per unit sway, at H0
  const A2 = 0.32; // cross-current weave amplitude
  const LEAN = 0.28; // steady downstream bow per unit sway
  const crossM = 1 - 0.85 * M.fan; // sea fans keep their plane in the current

  function updateTargets(timeSec, sway, tempo, positions, normals) {
    const t = T_RATE * timeSec * tempo;
    let d = 0;
    for (let k = 0; k < Ke; k++) {
      const st = strands[k];
      const relLen = st.len / H0;
      cBx = st.bx;
      cBz = st.bz;
      cLen = st.len;
      cP1 = ph1[k] + t;
      cP2 = ph2[k] + t * W_RATIO;
      cA1 = A1 * relLen * ampJ[k] * ampM * sway;
      cA2 = A2 * relLen * ampJ[k] * ampM * sway * crossM;
      cLn = LEAN * relLen * sway * crossM;
      cK1 = st.k1;
      cK2 = st.k2;
      cBendX = st.bendX;
      cBendZ = st.bendZ;
      cSag = st.sag;
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
      const sinT = st.sinT; // squash-baked: already × flat
      const ncT = st.ncT;
      const nsT = st.nsT;
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
          const nc = ncT[row + j];
          const ns = nsT[row + j];
          const o = perm[d] * 3;
          positions[o] = px + r * (c * nx + s * bx);
          positions[o + 1] = py + r * (c * ny + s * by);
          positions[o + 2] = pz + r * (c * nz + s * bz);
          normals[o] = (nc * nx + ns * bx) * inl - gtx;
          normals[o + 1] = (nc * ny + ns * by) * inl - gty;
          normals[o + 2] = (nc * nz + ns * bz) * inl - gtz;
        }
      }
    }
  }

  function init({ aSize, aTw, aRing }) {
    let d = 0;
    for (let k = 0; k < Ke; k++) {
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

// Star — starfish archetype. Central oblate disc + 5-7 radial arms, arms as
// flattened tubes (tube class, elliptical rings squashed in local y).
// Pure math, no three.js (node-benchable).
// Contract: geometry-spec.md. LOCAL space (§10); zero allocation in
// updateTargets (§4); frozen RNG draw order (§8); cross-ring shuffle (§9).
//
// Motion character (ported from v2 ARCH.star): slow radial ripple traveling
// outward along each arm, a gentle in-plane arm wave at an incommensurate
// frequency, soft disc breathing, and — non-swimmer — a whole-body idle spin
// (~0.2 rad/s) so its 3D reads.
//
// Frames: each arm runs the shared RMF spine (arc-length stations, curvature,
// double-reflection frames — spec §§2-6). The *ellipse anisotropy axis* is a
// surface property, not a frame: a real starfish arm is flat in the disc
// plane, so the minor axis is local up projected into the ring plane (arms
// stay near-horizontal, so this never degenerates; the RMF normal is the
// fallback if it ever did). Ring-offset normals + taper tilt (§ normals
// table, tube row), generalized to the ellipse: n ∝ (b·cosθ)·M + (a·sinθ)·V.

import { mulberry32, hashName } from './rng.js';
import { createSpine, makeRingTables, KAPPA_R_MAX, RING_SHRINK, TAU } from './spine.js';

const SWAY_MAX = 2.4; // slider 2.4 = max safe sway (spec §5 normalization)
const MAX_ARMS = 7; // length of the armJit DRAW block — not a cap on arm count
const SQUASH = 0.45; // minor/major axis ratio of the arm cross-section
const GOLD = 2.399963229728653; // golden angle — deterministic offsets, no draws
// ripple vs in-plane wave frequency ratio — incommensurate (spec §1 spirit)
const W_RIP = 1.1; // slow outward-traveling ripple (rad/s at tempo 1)
const W_WIG = W_RIP * Math.SQRT2 * 1.618033988749895 * 0.5;
const K_RIP = 4.2; // spatial frequency of the ripple along the arm
const K_WIG = 2.6;

// ---- named-species morph presets (v3.8) -----------------------------------
// LEX.star is "radially symmetric benthos", and it had ONE body: a 5-armed
// flat starfish. A sea urchin, a sand dollar, a crab and a brittle star are
// all echinoderm-or-arthropod variations on a central body with radiating
// appendages — the archetype is right — but they need these axes:
//   armMul   arm-count ×, applied to the seed's draw. An urchin needs ~30
//            spines; MAX_ARMS was a cap on the COUNT and is now only the size
//            of the jitter draw block (arms index it cyclically), so the
//            frozen draw order is untouched.
//   armLen / armR / armTaper   length, thickness, and the taper exponent.
//            armTaper > 1 gives a needle (an urchin spine); the stock 0.85 is
//            a starfish's blunt-tipped ray.
//   dome     0 = arms radiate in the disc plane (a starfish, flat on rock);
//            1 = arms distributed over a SPHERE (an urchin's spines point in
//            every direction). Nothing planar can look like an urchin.
//   squash   arm cross-section minor/major. 1 = a round spine, 0.45 = a
//            flattened starfish ray.
//   disc / discFlat   central body radius × and its height:radius ratio.
//            discFlat 1 is a ball (urchin test), 0.16 a plate (sand dollar).
//   long     x-stretch of the whole animal. Radial symmetry is exactly wrong
//            for a lobster; this is the axis that says "bilateral, elongate".
//   curl     static tip curl ×. Negative bends the tips DOWN — crab legs.
//   spin     idle-spin ×.
//   scale/tempo/speed  world hints for lexicon.js; ignored here.
export const STAR_MORPHS = {
  // The stock body, named so "sea star" resolves to something explicit.
  seastar: {
    armMul: 1, armLen: 1, armR: 1, armTaper: 0.85, dome: 0, squash: 0.45,
    disc: 1, discFlat: 0.4, long: 1, curl: 1, spin: 1, scale: 0.7, tempo: 0.6,
  },
  // Solaster: many short rays on a broad disc.
  sunstar: {
    armMul: 2.3, armLen: 0.62, armR: 1.05, armTaper: 0.8, dome: 0.1, squash: 0.5,
    disc: 1.5, discFlat: 0.36, long: 1, curl: 0.9, spin: 0.9,
    scale: 0.8, tempo: 0.6,
  },
  // Ophiuroid: a small button of a disc with five long, thin, writhing arms
  // sharply set off from it — the diagnostic difference from a sea star.
  brittlestar: {
    armMul: 1, armLen: 2.0, armR: 0.4, armTaper: 1.15, dome: 0.06, squash: 0.85,
    disc: 0.55, discFlat: 0.34, long: 1, curl: 2.2, spin: 0.8,
    scale: 0.65, tempo: 1.2,
  },
  // Gorgonocephalus: brittle star taken to its extreme — a thicket.
  basketstar: {
    armMul: 1.7, armLen: 2.1, armR: 0.34, armTaper: 1.35, dome: 0.25, squash: 0.9,
    disc: 0.7, discFlat: 0.4, long: 1, curl: 2.8, spin: 0.6,
    scale: 0.9, tempo: 0.8,
  },
  // Echinoid: a near-spherical test carrying ~30 needle spines in EVERY
  // direction. dome 1 + squash 1 + armTaper 1.7 is the whole animal.
  urchin: {
    armMul: 5.2, armLen: 0.8, armR: 0.3, armTaper: 1.7, dome: 1, squash: 1,
    disc: 1.45, discFlat: 0.92, long: 1, curl: 0.15, spin: 0.25,
    scale: 0.55, tempo: 0.35, speed: 0.15,
  },
  // A flattened, burrowing urchin: all test, spines reduced to a velvet nap.
  sanddollar: {
    armMul: 3.0, armLen: 0.06, armR: 0.42, armTaper: 1.4, dome: 0.22, squash: 1,
    disc: 2.1, discFlat: 0.14, long: 1, curl: 0.1, spin: 0.2,
    scale: 0.5, tempo: 0.25, speed: 0.1,
  },
  // Brachyuran: a wide flat carapace, slightly broader than long, on 8-10
  // jointed legs that arch UP from the body and bend down at the tips —
  // hence the negative curl.
  crab: {
    armMul: 1.65, armLen: 1.0, armR: 0.44, armTaper: 1.0, dome: 0.12, squash: 0.7,
    disc: 1.55, discFlat: 0.4, long: 0.92, curl: -1.6, spin: 0.35,
    scale: 0.65, tempo: 0.9, speed: 0.5,
  },
  // Hermits wear a shell, so the "disc" is a tall lump rather than a plate.
  hermitcrab: {
    armMul: 1.35, armLen: 0.85, armR: 0.42, armTaper: 1.0, dome: 0.1, squash: 0.7,
    disc: 1.3, discFlat: 0.85, long: 1.15, curl: -1.4, spin: 0.3,
    scale: 0.5, tempo: 0.9, speed: 0.4,
  },
  // Nephropid: elongate and bilateral, not radial. `long` carries it.
  lobster: {
    armMul: 1.5, armLen: 0.95, armR: 0.42, armTaper: 1.05, dome: 0.1, squash: 0.65,
    disc: 1.2, discFlat: 0.5, long: 2.7, curl: -1.2, spin: 0.25,
    scale: 0.85, tempo: 0.8, speed: 0.45,
  },
  // Limulus: one big smooth domed carapace, legs almost entirely hidden
  // beneath it, plus a long rigid telson the elongation stands in for.
  horseshoecrab: {
    armMul: 1.5, armLen: 0.5, armR: 0.36, armTaper: 1.2, dome: 0.05, squash: 0.75,
    disc: 1.9, discFlat: 0.5, long: 1.45, curl: -1.0, spin: 0.15,
    scale: 0.8, tempo: 0.5, speed: 0.3,
  },
};
const STAR_ALIASES = {
  seastar: ['seastar', 'sea star', 'starfish', 'star'],
  sunstar: ['sunstar', 'sun star', 'solaster'],
  brittlestar: ['brittlestar', 'brittle star', 'ophiuroid'],
  basketstar: ['basketstar', 'basket star', 'gorgonocephalus'],
  urchin: ['urchin', 'seaurchin', 'sea urchin', 'echinoid'],
  sanddollar: ['sanddollar', 'sand dollar'],
  crab: ['crab', 'kingcrab', 'king crab', 'spidercrab', 'spider crab'],
  hermitcrab: ['hermitcrab', 'hermit crab', 'hermit'],
  lobster: ['lobster', 'crayfish', 'langoustine'],
  horseshoecrab: ['horseshoecrab', 'horseshoe crab', 'limulus'],
};
const MORPH_BY_SEED = new Map();
for (const k of Object.keys(STAR_MORPHS)) {
  for (const n of STAR_ALIASES[k] || [k]) {
    MORPH_BY_SEED.set(hashName(n), STAR_MORPHS[k]);
    MORPH_BY_SEED.set(hashName(n + 's'), STAR_MORPHS[k]);
  }
}
/** Preset lookup by name, for lexicon.js (mirrors FISH_MORPHS[word] usage). */
export function starMorphFor(word) {
  if (!word) return null;
  const w = String(word).toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(STAR_MORPHS, w)) return STAR_MORPHS[w];
  return MORPH_BY_SEED.get(hashName(w)) || null;
}

export function makeStar(seed, opts = {}) {
  // v3.2 density uplift: 1100 → 2400 (2.18×) with armRings 12 → 22 and the
  // disc's latitude rings 9 → 13 (below). At 12 rings a 1.8-long arm had a
  // 0.16 arc pitch — visibly banded; 22 brings it to 0.086, close to the
  // elliptical ring's own dot pitch, so the arm reads as a tapering flattened
  // tube instead of a stack of hoops. dotsPerRing still absorbs the arm-count
  // variation so the TOTAL stays exactly `count` for every seed.
  const count = opts.count ?? 2400; // TOTAL is fixed — draw counts never vary
  const armRings = opts.armRings ?? 22;
  // Arc samples stay at v3.1's 48 — verified shape-neutral at 22 armRings
  // (vs a 200-sample build: max delta 0.0027 = 0.14% of extent, sway 0/1/2.4).
  const sampleCount = opts.sampleCount ?? 48;
  // preset resolution (pure function of opts.morph / seed — no RNG, so the
  // frozen draw order below is untouched and determinism is unaffected)
  const preset = opts.morph ?? MORPH_BY_SEED.get(seed >>> 0) ?? null;
  const M = {
    armMul: preset?.armMul ?? 1,
    armLen: preset?.armLen ?? 1,
    armR: preset?.armR ?? 1,
    armTaper: preset?.armTaper ?? 0.85,
    dome: preset?.dome ?? 0,
    squash: preset?.squash ?? SQUASH,
    disc: preset?.disc ?? 1,
    discFlat: preset?.discFlat ?? 0.4,
    long: preset?.long ?? 1,
    curl: preset?.curl ?? 1,
    spin: preset?.spin ?? 1,
  };
  const SQ = M.squash; // per-instance arm cross-section (was the module const)
  const Q_TILT = 0.5 * (1 + SQ); // mean ellipse-slope factor for taper tilt
  const baseArmRadius = (opts.armRadius ?? 0.17) * M.armR;
  const discRadiusBase = (opts.discRadius ?? 0.55) * M.disc;

  const rng = mulberry32(seed);
  // ---- FROZEN DRAW ORDER (spec §8) — append only, never insert ----
  // draw 1: arm count. The preset SCALES the draw rather than replacing it, so
  // individuals still vary (a 27-spine urchin next to a 32-spine one).
  const K = Math.max(3, Math.round((5 + ((rng() * 3) | 0)) * M.armMul));
  const seedAngle = rng() * TAU; //                      draw 2: RMF seed frames
  const armLen = (1.5 + 0.6 * rng()) * M.armLen; //      draw 3
  const spinDir = rng() < 0.5 ? -1 : 1; //               draw 4
  const spinRate = (0.16 + 0.08 * rng()) * M.spin; //    draw 5: idle spin ~0.2 rad/s
  const ripplePhase = rng() * TAU; //                    draw 6
  const wigglePhase = rng() * TAU; //                    draw 7
  const twistPerRing = (rng() * 2 - 1) * 0.08; //        draw 8: spiral rib twist
  const armJit = new Float32Array(MAX_ARMS); //          draws 9..15 (always 7)
  for (let k = 0; k < MAX_ARMS; k++) armJit[k] = 0.85 + 0.3 * rng();
  const discR = discRadiusBase * (0.9 + 0.2 * rng()); // draw 16
  const sizeJit = new Float32Array(count); //            draws 17 .. 16+count
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

  // Dot budget: ~78% in arms; dotsPerRing absorbs the arm-count variation so
  // the TOTAL stays exactly `count` for every seed (fixed buffers, fixed draws).
  let dotsPerRing = Math.max(6, Math.round((count * 0.78) / (K * armRings)));
  // A many-armed preset (an urchin's ~30 spines) needs the budget spread
  // thinner; the floor of 1 keeps the arms from vanishing entirely.
  while (dotsPerRing > 1 && K * armRings * dotsPerRing > count - 60) dotsPerRing--;
  const discDots = count - K * armRings * dotsPerRing;

  // ---- central disc: static dots on an oblate spheroid, quantized latitude
  // rings (spec §7). Per frame it only spins + breathes — zero trig per dot.
  const bAxis = M.discFlat * discR; // vertical semi-axis (0.4 = the flat disc)
  const dP = new Float32Array(discDots * 3); // rest positions
  const dN = new Float32Array(discDots * 3); // rest unit normals
  const dSz = new Float32Array(discDots);
  const dRing = new Float32Array(discDots);
  {
    const nDiscRings = 13; // v3.2: 9 → 13, matching the disc's dot budget rise
    let wTot = 0;
    for (let m = 0; m < nDiscRings; m++) wTot += Math.sin(((m + 0.5) / nDiscRings) * Math.PI);
    let cumW = 0;
    let di = 0;
    for (let m = 0; m < nDiscRings; m++) {
      const phi = ((m + 0.5) / nDiscRings) * Math.PI;
      cumW += Math.sin(phi);
      const upto = Math.round((discDots * cumW) / wTot); // cumulative rounding → exact total
      const n = upto - di;
      const sph = Math.sin(phi);
      const cph = Math.cos(phi);
      for (let j = 0; j < n; j++, di++) {
        const a = (j / n) * TAU + m * GOLD;
        const x = discR * sph * Math.cos(a);
        const y = bAxis * cph;
        const z = discR * sph * Math.sin(a);
        const o = di * 3;
        dP[o] = x;
        dP[o + 1] = y;
        dP[o + 2] = z;
        // spheroid normal ∝ (x/a², y/b², z/a²). The `long` x-stretch is applied
        // AFTER the idle spin (below), in the same frame the arms are stretched
        // in — bake it in here and a spinning lobster's body would rotate out
        // from under its own legs.
        let nx = x / (discR * discR);
        let ny = y / (bAxis * bAxis);
        let nz = z / (discR * discR);
        const il = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        dN[o] = nx * il;
        dN[o + 1] = ny * il;
        dN[o + 2] = nz * il;
        dSz[di] = 0.7 + 0.3 * sph;
        dRing[di] = 0.3 * sph; // radial fraction — arms continue 0.3→1
      }
    }
  }

  // ---- arms: shared ring tables (quantized angles + twist, spec §7) and the
  // matching ellipse-normal tables (unit by construction, zero per-dot sqrt
  // beyond one normalize folded into the static table).
  const { cosT, sinT } = makeRingTables(armRings, dotsPerRing, twistPerRing);
  const ncN = new Float32Array(armRings * dotsPerRing);
  const nsN = new Float32Array(armRings * dotsPerRing);
  for (let i = 0; i < armRings * dotsPerRing; i++) {
    const c = cosT[i];
    const s = sinT[i];
    const q = 1 / Math.sqrt(SQ * SQ * c * c + s * s);
    ncN[i] = SQ * c * q;
    nsN[i] = s * q;
  }
  // taper: wide at the disc, to a point at the tip. armTaper > 1 is a needle
  // (urchin spine); 0.85 is a starfish ray's blunt taper.
  const prof = new Float32Array(armRings);
  const rNom = new Float32Array(armRings);
  for (let i = 0; i < armRings; i++) {
    const f = i / (armRings - 1);
    prof[i] = Math.pow(1 - f, M.armTaper);
    rNom[i] = baseArmRadius * prof[i];
  }
  const rEffS = new Float32Array(armRings); // scratch, reused across arms
  const drdsS = new Float32Array(armRings);

  const r0 = discR * 0.75; // arm root radius (emerges from under the disc rim)
  const curlA = 0.14 * M.curl; // static tip curl (negative = crab legs, down)
  const iXS = 1 / M.long;
  const XS = M.long; // x-stretch, applied to the arm curve as it is built so
  // the spine's arc length / curvature / frames all come out of the STRETCHED
  // curve rather than being corrected after the fact
  const spines = [];
  const cB = new Float32Array(K); // cos/sin of arm base angles (× elevation cos)
  const sB = new Float32Array(K);
  const eY = new Float32Array(K); // sin of the arm's elevation out of the plane
  const phR = new Float32Array(K); // per-arm ripple/wiggle phase offsets
  const phW = new Float32Array(K);
  const seedA = new Float32Array(K);
  const bodyLenK = new Float32Array(K);
  for (let k = 0; k < K; k++) {
    spines.push(createSpine(armRings, sampleCount));
    // Arm directions. dome 0 keeps the v3.7 behaviour exactly (evenly spaced
    // in the disc plane); dome > 0 lifts them onto a spherical Fibonacci
    // lattice, which is the only way an urchin's spines can point everywhere.
    const ey = M.dome > 0 ? (1 - (2 * (k + 0.5)) / K) * M.dome : 0;
    const er = Math.sqrt(Math.max(1e-6, 1 - ey * ey));
    // Uniform azimuth would stack a domed animal's arms into visible meridian
    // rows; the golden angle is what makes the lattice read as even.
    const a = M.dome > 0.25 ? k * GOLD : (k / K) * TAU;
    cB[k] = er * Math.cos(a);
    sB[k] = er * Math.sin(a);
    eY[k] = ey;
    phR[k] = ripplePhase + k * 2.4;
    phW[k] = wigglePhase + k * 1.7;
    seedA[k] = seedAngle + k * GOLD;
    // armJit is a fixed-size DRAW block (spec §8); arms beyond it index it
    // cyclically rather than growing the block and shifting every later draw.
    bodyLenK[k] = armLen * armJit[k % MAX_ARMS];
  }

  // curve closure state (set per arm per frame — no allocation)
  let cvCa = 1;
  let cvSa = 0;
  let cvPh = 0;
  let cvPh2 = 0;
  let cvLen = 1;
  let rPhT = 0;
  let wPhT = 0;
  let aY = 0;
  let aW = 0;
  let cvEy = 0;
  const curve = (u, out, o) => {
    const rad = r0 + u * cvLen;
    const w = aW * Math.sin(K_WIG * u - wPhT + cvPh2) * u; // in-plane arm wave
    out[o] = (rad * cvCa - w * cvSa) * XS;
    // elevation out of the disc plane (dome), then the outward-traveling
    // ripple whose amplitude grows toward the tip, then the static curl
    out[o + 1] = rad * cvEy + aY * Math.sin(K_RIP * u - rPhT + cvPh) * u + curlA * u * u;
    out[o + 2] = rad * cvSa + w * cvCa;
  };

  function updateTargets(timeSec, sway, tempo, positions, normals) {
    let s = sway > 0 ? sway : 0;
    if (s > SWAY_MAX) s = SWAY_MAX;
    const t = timeSec * tempo;
    rPhT = W_RIP * t;
    wPhT = W_WIG * t;
    aY = 0.085 * armLen * s;
    aW = 0.05 * armLen * (0.25 + 0.31 * s);
    // whole-body idle spin — one sin/cos pair, composed with the static base
    // angles so the per-arm setup does zero trig
    const spinAng = spinDir * spinRate * t;
    const cs = Math.cos(spinAng);
    const sn = Math.sin(spinAng);
    // pass A: all arm spines at requested amplitude
    let mx = 0;
    for (let k = 0; k < K; k++) {
      cvCa = cB[k] * cs - sB[k] * sn;
      cvSa = sB[k] * cs + cB[k] * sn;
      cvPh = phR[k];
      cvPh2 = phW[k];
      cvLen = bodyLenK[k];
      cvEy = eY[k];
      spines[k].update(curve, bodyLenK[k], seedA[k]);
      const mk = spines[k].maxKappaR(rNom);
      if (mk > mx) mx = mk;
    }
    // sway clamp (spec §5): rescale so max(κ·r) ≤ 0.7 (κ ~linear in amplitude,
    // one correction pass suffices), then the local ring-shrink guard below
    if (mx > KAPPA_R_MAX) {
      const sc = KAPPA_R_MAX / mx;
      aY *= sc;
      aW *= sc;
      for (let k = 0; k < K; k++) {
        cvCa = cB[k] * cs - sB[k] * sn;
        cvSa = sB[k] * cs + cB[k] * sn;
        cvPh = phR[k];
        cvPh2 = phW[k];
        cvLen = bodyLenK[k];
        cvEy = eY[k];
        spines[k].update(curve, bodyLenK[k], seedA[k]);
      }
    }
    // ---- disc: breathe + spin (rest positions/normals static; normals are
    // invariant under the uniform breathing scale)
    const p = 1 + 0.045 * s * Math.sin(1.5 * t + ripplePhase);
    let d = 0;
    for (let m3 = 0; d < discDots; m3 += 3, d++) {
      const x = dP[m3];
      const z = dP[m3 + 2];
      const nx = dN[m3];
      const nz = dN[m3 + 2];
      const o = perm[d] * 3;
      positions[o] = (x * cs - z * sn) * p * XS;
      positions[o + 1] = dP[m3 + 1] * p;
      positions[o + 2] = (x * sn + z * cs) * p;
      // normal under the diag(XS,1,1) stretch is the inverse-transpose,
      // (n_x/XS, n_y, n_z), renormalized — one rsqrt, and only when XS ≠ 1
      let bx = nx * cs - nz * sn;
      let by = dN[m3 + 1];
      let bz = nx * sn + nz * cs;
      if (XS !== 1) {
        bx *= iXS;
        const bl = 1 / Math.sqrt(bx * bx + by * by + bz * bz);
        bx *= bl;
        by *= bl;
        bz *= bl;
      }
      normals[o] = bx;
      normals[o + 1] = by;
      normals[o + 2] = bz;
    }
    // ---- arms: flattened elliptical rings on each spine
    for (let k = 0; k < K; k++) {
      const sp = spines[k];
      const kap = sp.kappa;
      const dsK = bodyLenK[k] / (armRings - 1);
      for (let i = 0; i < armRings; i++) {
        let r = rNom[i];
        if (kap[i] * r > RING_SHRINK) r = RING_SHRINK / kap[i]; // local guard (§5)
        rEffS[i] = r;
      }
      for (let i = 0; i < armRings; i++) {
        const ia = i > 0 ? i - 1 : 0;
        const ib = i < armRings - 1 ? i + 1 : i;
        drdsS[i] = ib > ia ? (rEffS[ib] - rEffS[ia]) / ((ib - ia) * dsK) : 0;
      }
      const P = sp.positions;
      const T = sp.tangents;
      const N = sp.normals;
      for (let i = 0; i < armRings; i++) {
        const oi = i * 3;
        const px = P[oi];
        const py = P[oi + 1];
        const pz = P[oi + 2];
        const tx = T[oi];
        const ty = T[oi + 1];
        const tz = T[oi + 2];
        // minor axis V = local up projected into the ring plane (the arm is
        // flat in the DISC plane — a surface property, not the frame chain;
        // gentle clamped ripple keeps arms near-horizontal so l2 stays ~1;
        // RMF normal is the degenerate-case fallback)
        let vx;
        let vy;
        let vz;
        const l2 = 1 - ty * ty;
        if (l2 > 1e-6) {
          const il = 1 / Math.sqrt(l2);
          vx = -ty * tx * il;
          vy = l2 * il;
          vz = -ty * tz * il;
        } else {
          vx = N[oi];
          vy = N[oi + 1];
          vz = N[oi + 2];
        }
        // major axis M = T × V — horizontal, tangential to the disc
        const mx0 = ty * vz - tz * vy;
        const my0 = tz * vx - tx * vz;
        const mz0 = tx * vy - ty * vx;
        const rMaj = rEffS[i];
        const rMin = SQ * rMaj;
        // taper tilt (unit exactly: ellipse normal ⊥ T, per-station slope)
        const g = drdsS[i] * Q_TILT;
        const inl = 1 / Math.sqrt(1 + g * g);
        const gtx = g * inl * tx;
        const gty = g * inl * ty;
        const gtz = g * inl * tz;
        const row = i * dotsPerRing;
        for (let j = 0; j < dotsPerRing; j++, d++) {
          const c = cosT[row + j];
          const si = sinT[row + j];
          const nc = ncN[row + j];
          const ns = nsN[row + j];
          const o = perm[d] * 3;
          positions[o] = px + rMaj * c * mx0 + rMin * si * vx;
          positions[o + 1] = py + rMaj * c * my0 + rMin * si * vy;
          positions[o + 2] = pz + rMaj * c * mz0 + rMin * si * vz;
          normals[o] = (nc * mx0 + ns * vx) * inl - gtx;
          normals[o + 1] = (nc * my0 + ns * vy) * inl - gty;
          normals[o + 2] = (nc * mz0 + ns * vz) * inl - gtz;
        }
      }
    }
  }

  function init({ aSize, aTw, aRing }) {
    let d = 0;
    for (let m = 0; m < discDots; m++, d++) {
      const sl = perm[d];
      aSize[sl] = dSz[m] * sizeJit[d];
      aTw[sl] = twPhase[d];
      aRing[sl] = dRing[m];
    }
    for (let k = 0; k < K; k++) {
      for (let i = 0; i < armRings; i++) {
        const f = i / (armRings - 1);
        const sz = 0.55 + 0.45 * prof[i];
        const rf = 0.3 + 0.7 * f; // radial fraction, continues the disc's 0→0.3
        for (let j = 0; j < dotsPerRing; j++, d++) {
          const sl = perm[d];
          aSize[sl] = sz * sizeJit[d];
          aTw[sl] = twPhase[d];
          aRing[sl] = rf;
        }
      }
    }
  }

  return { count, ringCount: armRings, init, updateTargets };
}

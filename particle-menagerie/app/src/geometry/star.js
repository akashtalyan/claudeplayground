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

import { mulberry32 } from './rng.js';
import { createSpine, makeRingTables, KAPPA_R_MAX, RING_SHRINK, TAU } from './spine.js';

const SWAY_MAX = 2.4; // slider 2.4 = max safe sway (spec §5 normalization)
const MAX_ARMS = 7;
const SQUASH = 0.45; // minor/major axis ratio of the arm cross-section
const GOLD = 2.399963229728653; // golden angle — deterministic offsets, no draws
// ripple vs in-plane wave frequency ratio — incommensurate (spec §1 spirit)
const W_RIP = 1.1; // slow outward-traveling ripple (rad/s at tempo 1)
const W_WIG = W_RIP * Math.SQRT2 * 1.618033988749895 * 0.5;
const K_RIP = 4.2; // spatial frequency of the ripple along the arm
const K_WIG = 2.6;
const Q_TILT = 0.5 * (1 + SQUASH); // mean ellipse-slope factor for taper tilt

export function makeStar(seed, opts = {}) {
  const count = opts.count ?? 1100; // TOTAL is fixed — draw counts never vary
  const armRings = opts.armRings ?? 12;
  const sampleCount = opts.sampleCount ?? 48;
  const baseArmRadius = opts.armRadius ?? 0.17;
  const discRadiusBase = opts.discRadius ?? 0.55;

  const rng = mulberry32(seed);
  // ---- FROZEN DRAW ORDER (spec §8) — append only, never insert ----
  const K = 5 + ((rng() * 3) | 0); //                    draw 1: arm count 5-7
  const seedAngle = rng() * TAU; //                      draw 2: RMF seed frames
  const armLen = 1.5 + 0.6 * rng(); //                   draw 3
  const spinDir = rng() < 0.5 ? -1 : 1; //               draw 4
  const spinRate = 0.16 + 0.08 * rng(); //               draw 5: idle spin ~0.2 rad/s
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
  while (K * armRings * dotsPerRing > count - 60) dotsPerRing--;
  const discDots = count - K * armRings * dotsPerRing;

  // ---- central disc: static dots on an oblate spheroid, quantized latitude
  // rings (spec §7). Per frame it only spins + breathes — zero trig per dot.
  const bAxis = 0.4 * discR; // vertical semi-axis (flat disc)
  const dP = new Float32Array(discDots * 3); // rest positions
  const dN = new Float32Array(discDots * 3); // rest unit normals
  const dSz = new Float32Array(discDots);
  const dRing = new Float32Array(discDots);
  {
    const nDiscRings = 9;
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
        // spheroid normal ∝ (x/a², y/b², z/a²)
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
    const q = 1 / Math.sqrt(SQUASH * SQUASH * c * c + s * s);
    ncN[i] = SQUASH * c * q;
    nsN[i] = s * q;
  }
  // taper: wide at the disc, to a point at the tip
  const prof = new Float32Array(armRings);
  const rNom = new Float32Array(armRings);
  for (let i = 0; i < armRings; i++) {
    const f = i / (armRings - 1);
    prof[i] = Math.pow(1 - f, 0.85);
    rNom[i] = baseArmRadius * prof[i];
  }
  const rEffS = new Float32Array(armRings); // scratch, reused across arms
  const drdsS = new Float32Array(armRings);

  const r0 = discR * 0.75; // arm root radius (emerges from under the disc rim)
  const curlA = 0.14; // static upward tip curl
  const spines = [];
  const cB = new Float32Array(K); // cos/sin of arm base angles
  const sB = new Float32Array(K);
  const phR = new Float32Array(K); // per-arm ripple/wiggle phase offsets
  const phW = new Float32Array(K);
  const seedA = new Float32Array(K);
  const bodyLenK = new Float32Array(K);
  for (let k = 0; k < K; k++) {
    spines.push(createSpine(armRings, sampleCount));
    const a = (k / K) * TAU;
    cB[k] = Math.cos(a);
    sB[k] = Math.sin(a);
    phR[k] = ripplePhase + k * 2.4;
    phW[k] = wigglePhase + k * 1.7;
    seedA[k] = seedAngle + k * GOLD;
    bodyLenK[k] = armLen * armJit[k];
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
  const curve = (u, out, o) => {
    const rad = r0 + u * cvLen;
    const w = aW * Math.sin(K_WIG * u - wPhT + cvPh2) * u; // in-plane arm wave
    out[o] = rad * cvCa - w * cvSa;
    // outward-traveling ripple, amplitude grows toward the tip; static curl
    out[o + 1] = aY * Math.sin(K_RIP * u - rPhT + cvPh) * u + curlA * u * u;
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
      positions[o] = (x * cs - z * sn) * p;
      positions[o + 1] = dP[m3 + 1] * p;
      positions[o + 2] = (x * sn + z * cs) * p;
      normals[o] = nx * cs - nz * sn;
      normals[o + 1] = dN[m3 + 1];
      normals[o + 2] = nx * sn + nz * cs;
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
        const rMin = SQUASH * rMaj;
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

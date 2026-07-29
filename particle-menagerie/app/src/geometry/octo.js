// Octo — compact mantle dome (revolution-surface normals, tube class) plus
// 8 arms fanned in a full 3D circle, each an RMF tube strand (spine.js).
// Pure math, no three.js (node-benchable). Contract: geometry-spec.md.
// LOCAL space (§10); zero allocation in updateTargets (§4); frozen RNG draw
// order (§8). Motion soul ported from v2 ARCH.octo: mantle breathing pulse,
// per-arm fan sway, curl waves traveling tipward with tip-heavy envelope,
// slow independent tip curl, deterministic per-arm length variation.
//
// Arm centerlines are angle-integrated: pitch φ(u) = rest droop + traveling
// curvature wave + tip curl (∝u²), integrated in the arm's vertical plane at
// build-fixed step, plus an out-of-plane side wave. The spine machinery then
// re-parameterizes by true arc length (§6) and provides RMF frames (§2) and
// curvature for the sway clamp (§5).

import { mulberry32 } from './rng.js';
import { createSpine, makeRingTables, KAPPA_R_MAX, RING_SHRINK, TAU } from './spine.js';

// incommensurate secondary rate (spec §1 spirit) — side wave never locks
// phase with the main curl wave
const W_RATIO = Math.SQRT2 * 1.618033988749895 * 0.5;
const SWAY_MAX = 2.4; // slider 2.4 = max safe sway (spec §5 normalization)
const ARMS = 8;

export function makeOcto(seed, opts = {}) {
  const mantleRings = opts.mantleRings ?? 16;
  const mantleDots = opts.mantleDots ?? 40;
  const armStations = opts.armStations ?? 29;
  const armDots = opts.armDots ?? 5;
  const mantleCount = mantleRings * mantleDots;
  const armCount = ARMS * armStations * armDots;
  const count = mantleCount + armCount; // defaults: 640 + 1160 = 1800
  const ringCount = mantleRings + armStations;

  const R = opts.mantleRadius ?? 0.72; // equatorial mantle radius
  const H = opts.mantleHeight ?? 0.95; // dome semi-height (v2: ×1.2 elongation)
  const armLenBase = opts.armLength ?? 2.55;
  const armR0 = opts.armRadius ?? 0.11;
  const M = opts.armSamples ?? 96; // centerline integration/sample points

  const rng = mulberry32(seed);
  // ---- FROZEN DRAW ORDER (spec §8) — append only, never insert ----
  const breathPhase = rng() * TAU; //                    draw 1: mantle pulse
  const mantleTwist = (rng() * 2 - 1) * 0.06; //         draw 2: rib twist
  const armTwist = (rng() * 2 - 1) * 0.16; //            draw 3: arm rib twist
  const armSeed = new Float32Array(ARMS); //   per-arm block: 6 draws × 8 arms
  const azJit = new Float32Array(ARMS);
  const wavePh = new Float32Array(ARMS);
  const curlPh = new Float32Array(ARMS);
  const sidePh = new Float32Array(ARMS);
  const bendK = new Float32Array(ARMS);
  for (let k = 0; k < ARMS; k++) {
    armSeed[k] = rng() * TAU; //                          RMF seed frame (§2)
    azJit[k] = (rng() * 2 - 1) * 0.07;
    wavePh[k] = rng() * TAU;
    curlPh[k] = rng() * TAU;
    sidePh[k] = rng() * TAU;
    bendK[k] = 1.45 + (rng() * 2 - 1) * 0.3; //           rest droop curvature
  }
  const sizeJit = new Float32Array(count); //             next count draws
  for (let d = 0; d < count; d++) sizeJit[d] = 0.75 + 0.5 * rng();
  const twPhase = new Float32Array(count); //             next count draws
  for (let d = 0; d < count; d++) twPhase[d] = rng() * TAU;
  // Cross-ring shuffle (spec §9): drawRange prefix = uniform subsample.
  const perm = new Uint32Array(count); //                 next count−1 draws
  for (let d = 0; d < count; d++) perm[d] = d;
  for (let d = count - 1; d > 0; d--) {
    const j = (rng() * (d + 1)) | 0;
    const t = perm[d];
    perm[d] = perm[j];
    perm[j] = t;
  }
  // ---- end frozen draw order ----

  // ---- mantle: static revolution profile, phi from near-apex past the
  // equator so the skirt tucks under (v2 dome look). y is static; breathing
  // scales radius only, so per-ring normal tilt is recomputed per frame.
  const PHI0 = 0.14;
  const PHI1 = 1.95;
  const mRad0 = new Float32Array(mantleRings);
  const mY = new Float32Array(mantleRings);
  const yOff = -H * Math.cos(PHI1); // skirt rim sits at y = 0
  for (let i = 0; i < mantleRings; i++) {
    const phi = PHI0 + ((PHI1 - PHI0) * i) / (mantleRings - 1);
    mRad0[i] = R * Math.sin(phi);
    mY[i] = yOff + H * Math.cos(phi);
  }
  const mRad = new Float32Array(mantleRings); // breathed radius (per frame)
  const mNr = new Float32Array(mantleRings); // per-ring normal: radial comp
  const mNy = new Float32Array(mantleRings); //                  y comp
  const mT = makeRingTables(mantleRings, mantleDots, mantleTwist);

  // ---- arms: static per-arm/per-station tables
  const armLenArr = new Float32Array(ARMS);
  const azBase = new Float32Array(ARMS);
  for (let k = 0; k < ARMS; k++) {
    // v2 soul: dist scale 0.75+0.25·sin(k·2.7) — deterministic length spread
    armLenArr[k] = armLenBase * (0.75 + 0.25 * Math.sin(k * 2.7));
    azBase[k] = (k / ARMS) * TAU + azJit[k];
  }
  const RSK = R * Math.sin(PHI1) * 0.92; // arm attach radius on the skirt
  const Y_BASE = 0.04;
  const PHI_REST = 0.05; // base pitch just below horizontal, flaring out
  // arm radius profile: full at base, fine tip (v2: 1−0.8u, pushed further)
  const armProf = new Float32Array(armStations);
  const armRNom = new Float32Array(armStations);
  for (let i = 0; i < armStations; i++) {
    const u = i / (armStations - 1);
    armProf[i] = 1 - 0.86 * Math.pow(u, 0.9);
    armRNom[i] = armR0 * armProf[i];
  }
  // per-arm quantized ring tables (shared twist, arm-offset start angle)
  const cosTA = new Float32Array(ARMS * armStations * armDots);
  const sinTA = new Float32Array(ARMS * armStations * armDots);
  for (let k = 0; k < ARMS; k++) {
    for (let i = 0; i < armStations; i++) {
      const tw = k * 2.4 + armTwist * i;
      for (let j = 0; j < armDots; j++) {
        const a = tw + (j * TAU) / armDots;
        const o = (k * armStations + i) * armDots + j;
        cosTA[o] = Math.cos(a);
        sinTA[o] = Math.sin(a);
      }
    }
  }
  const spines = [];
  for (let k = 0; k < ARMS; k++) spines.push(createSpine(armStations, M));
  // per-frame scratch (preallocated — spec §4)
  const rArr = new Float32Array(M); // integrated in-plane radial
  const yArr = new Float32Array(M); // integrated in-plane vertical
  const wArr = new Float32Array(M); // out-of-plane side displacement
  const rEffA = new Float32Array(armStations);
  const drdsA = new Float32Array(armStations);

  // wave numbers (v2: −u·5 spatial phase) — non-harmonic pair
  const KW = 5.0;
  const KW2 = 3.3;

  // ---- shared arm curve closure state (mutable, set per arm per frame)
  let cAz = 1;
  let sAz = 0;
  let bx = 0;
  let bz = 0;
  const curve = (u, out, o) => {
    let f = u * (M - 1);
    let j = f | 0;
    if (j > M - 2) j = M - 2;
    f -= j;
    const r = rArr[j] + f * (rArr[j + 1] - rArr[j]);
    const y = yArr[j] + f * (yArr[j + 1] - yArr[j]);
    const w = wArr[j] + f * (wArr[j + 1] - wArr[j]);
    out[o] = bx + r * cAz - w * sAz;
    out[o + 1] = Y_BASE + y;
    out[o + 2] = bz + r * sAz + w * cAz;
  };

  // integrate one arm centerline at amplitude scale `amp` (κ of the wave and
  // curl terms is linear in their angle amplitudes, so the §5 clamp is a
  // single rescale pass, eel-style)
  let iBend = 0;
  let iCurl = 0;
  let iAw = 0;
  let iPw = 0;
  let iAs = 0;
  let iPs = 0;
  let iH = 0;
  function integrateArm(amp) {
    const cu = iCurl * amp;
    const aw = iAw * amp;
    const as = iAs * amp;
    const invM = 1 / (M - 1);
    let r = 0;
    let y = 0;
    rArr[0] = 0;
    yArr[0] = 0;
    wArr[0] = 0;
    for (let j = 1; j < M; j++) {
      const um = (j - 0.5) * invM; // midpoint angle sample
      const phi = PHI_REST + iBend * um + cu * um * um + aw * um * Math.sin(KW * um - iPw);
      r += iH * Math.cos(phi);
      y -= iH * Math.sin(phi);
      rArr[j] = r;
      yArr[j] = y;
      const u = j * invM;
      wArr[j] = as * u * u * Math.sin(KW2 * u - iPs);
    }
  }

  function updateTargets(timeSec, sway, tempo, positions, normals) {
    const t = timeSec * tempo;
    const s = Math.min(sway, SWAY_MAX);
    // ---- mantle: breathing pulse (v2: 1 + 0.08·amp·sin(t·freq·1.6 + ph))
    const breath = 1 + 0.08 * s * Math.sin(1.6 * t + breathPhase);
    for (let i = 0; i < mantleRings; i++) mRad[i] = mRad0[i] * breath;
    for (let i = 0; i < mantleRings; i++) {
      const ia = i > 0 ? i - 1 : 0;
      const ib = i < mantleRings - 1 ? i + 1 : i;
      // revolution-surface normal in the (radial, y) profile plane:
      // n ∝ (−dy)·radialDir + (drad)·ŷ, outward for top-down phi
      const nr = -(mY[ib] - mY[ia]);
      const ny = mRad[ib] - mRad[ia];
      const il = 1 / Math.sqrt(nr * nr + ny * ny);
      mNr[i] = nr * il;
      mNy[i] = ny * il;
    }
    let d = 0;
    for (let i = 0; i < mantleRings; i++) {
      const r = mRad[i];
      const py = mY[i];
      const nr = mNr[i];
      const ny = mNy[i];
      const row = i * mantleDots;
      for (let j = 0; j < mantleDots; j++, d++) {
        const c = mT.cosT[row + j];
        const sn = mT.sinT[row + j];
        const o = perm[d] * 3;
        positions[o] = r * c;
        positions[o + 1] = py;
        positions[o + 2] = r * sn;
        normals[o] = nr * c; // unit: nr²+ny²=1, c²+sn²=1
        normals[o + 1] = ny;
        normals[o + 2] = nr * sn;
      }
    }
    // ---- arms
    const rskB = RSK * breath;
    const swayAz = 0.25 * s; // v2: fan sway 0.25·amp, rate 1.1, k·1.8 offset
    const curlA = 0.55 * s; //  tip curl (v2: u²·0.8·sin(t·0.5+k)), slow rate
    const awA = 0.42 * s; //    traveling curvature wave, tipward (v2 rate 1.8)
    for (let k = 0; k < ARMS; k++) {
      const L = armLenArr[k];
      const az = azBase[k] + swayAz * Math.sin(1.1 * t + k * 1.8 + sidePh[k]);
      cAz = Math.cos(az);
      sAz = Math.sin(az);
      bx = rskB * cAz;
      bz = rskB * sAz;
      iBend = bendK[k];
      iCurl = curlA * Math.sin(0.5 * t + k + curlPh[k]);
      iAw = awA;
      iPw = wavePh[k] + 1.8 * t;
      iAs = 0.055 * L * s;
      iPs = sidePh[k] + 1.8 * W_RATIO * t;
      iH = L / (M - 1);
      const sp = spines[k];
      integrateArm(1);
      sp.update(curve, L, armSeed[k]);
      // sway clamp (spec §5): rescale wave/curl amplitude so max(κ·r) ≤ 0.7
      const m = sp.maxKappaR(armRNom);
      if (m > KAPPA_R_MAX) {
        integrateArm(KAPPA_R_MAX / m);
        sp.update(curve, L, armSeed[k]);
      }
      const kap = sp.kappa;
      for (let i = 0; i < armStations; i++) {
        let r = armRNom[i];
        if (kap[i] * r > RING_SHRINK) r = RING_SHRINK / kap[i]; // local guard
        rEffA[i] = r;
      }
      const ds = L / (armStations - 1);
      for (let i = 0; i < armStations; i++) {
        const ia = i > 0 ? i - 1 : 0;
        const ib = i < armStations - 1 ? i + 1 : i;
        drdsA[i] = ib > ia ? (rEffA[ib] - rEffA[ia]) / ((ib - ia) * ds) : 0;
      }
      const P = sp.positions;
      const T = sp.tangents;
      const N = sp.normals;
      const B = sp.binormals;
      const tabBase = k * armStations * armDots;
      for (let i = 0; i < armStations; i++) {
        const oi = i * 3;
        const px = P[oi];
        const py = P[oi + 1];
        const pz = P[oi + 2];
        const nx = N[oi];
        const ny = N[oi + 1];
        const nz = N[oi + 2];
        const bxx = B[oi];
        const byy = B[oi + 1];
        const bzz = B[oi + 2];
        const r = rEffA[i];
        const g = drdsA[i];
        // taper tilt: n = (radial − r′(s)·T)/√(1+r′²) — unit, no per-dot sqrt
        const inl = 1 / Math.sqrt(1 + g * g);
        const gtx = g * inl * T[oi];
        const gty = g * inl * T[oi + 1];
        const gtz = g * inl * T[oi + 2];
        const row = tabBase + i * armDots;
        for (let j = 0; j < armDots; j++, d++) {
          const c = cosTA[row + j];
          const sn = sinTA[row + j];
          const dx = c * nx + sn * bxx;
          const dy = c * ny + sn * byy;
          const dz = c * nz + sn * bzz;
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
    const invRings = 1 / (ringCount - 1);
    for (let i = 0; i < mantleRings; i++) {
      const sz = 0.7 + 0.3 * (mRad0[i] / R);
      const rf = i * invRings;
      for (let j = 0; j < mantleDots; j++, d++) {
        const sl = perm[d];
        aSize[sl] = sz * sizeJit[d];
        aTw[sl] = twPhase[d];
        aRing[sl] = rf; // apex→skirt→arm-tip fraction, ring-quantized
      }
    }
    for (let k = 0; k < ARMS; k++) {
      for (let i = 0; i < armStations; i++) {
        const sz = 0.45 + 0.55 * armProf[i];
        const rf = (mantleRings + i) * invRings;
        for (let j = 0; j < armDots; j++, d++) {
          const sl = perm[d];
          aSize[sl] = sz * sizeJit[d];
          aTw[sl] = twPhase[d];
          aRing[sl] = rf;
        }
      }
    }
  }

  return { count, ringCount, init, updateTargets };
}

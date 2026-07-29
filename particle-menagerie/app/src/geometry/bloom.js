// Bloom — rooted sea-flower. Pure math, no three.js (node-benchable).
// Contract: geometry-spec.md. LOCAL space (§10), root anchor at origin, stem
// grows +Y. Three parts:
//   stem  — RMF tube (createSpine), ring-offset normals + taper tilt;
//           vertical-archetype seed frame ⊥ stem axis (§2) comes from spine's
//           least-aligned-axis seed construction (T0 ≈ +Y ⇒ frame in XZ).
//   core  — small quantized-ring dome at the crown; analytic height-field
//           normals, static in the crown frame (moves/tilts with the stem).
//   petals— 8–14 radial SHEETS. Each petal centerline is a circular arc
//           α(u) = α0 + α1·u peeling away from the stem axis (closed form —
//           exact ∂/∂u), width sin(πu), v² cup across the chord. Normals are
//           analytic ∂P/∂u × ∂P/∂v (M4 trap: every time-dependent term —
//           arc, width taper, cup — appears in the derivatives; nothing is
//           finite-differenced or dropped). u stations are cell-centered so
//           width never hits zero ⇒ the cross product never degenerates.
// Motion soul (from v2): rooted quadratic stem sway (tip moves most),
// opening/closing breath cycle of the petal cone, slow rotation of the
// rosette about the stem axis with a gentle rotary wobble.
// Zero allocation in updateTargets (§4); per-frame trig is per-petal /
// per-u-station only (§3), never per dot.

import { mulberry32 } from './rng.js';
import { createSpine, makeRingTables, KAPPA_R_MAX, RING_SHRINK, TAU } from './spine.js';

// incommensurate stem-lean frequency pair (spec §1 spirit)
const W_RATIO = Math.SQRT2 * 1.618033988749895;
const WS1 = 0.31;
const WS2 = WS1 * W_RATIO;
const WB = 0.55; // breath cycle (~11 s at tempo 1 — v2's freq·0.45 feel)
const SWAY_MAX = 2.4; // slider 2.4 = max safe sway (spec §5 normalization)
const P_MAX = 14; // per-petal RNG draws use this FIXED count, never petalCount

export function makeBloom(seed, opts = {}) {
  const stemRings = opts.stemRings ?? 16;
  const dotsPerStemRing = opts.dotsPerStemRing ?? 10;
  const coreRings = opts.coreRings ?? 4;
  const coreDotsPerRing = opts.coreDotsPerRing ?? 20;
  const petalCols = opts.petalCols ?? 6; // quantized v-columns per petal (§7)
  const petalBudget = opts.petalBudget ?? 1160;
  const stemLen = opts.stemLength ?? 2.3;
  const stemRadius = opts.stemRadius ?? 0.09;
  const petalLen = opts.petalLength ?? 1.15;
  const coreRadius = opts.coreRadius ?? 0.2;
  const coreHeight = opts.coreHeight ?? 0.12;
  const sampleCount = opts.sampleCount ?? 200;

  const stemCount = stemRings * dotsPerStemRing;
  const coreCount = coreRings * coreDotsPerRing;

  const rng = mulberry32(seed);
  // ---- FROZEN DRAW ORDER (spec §8) — append only, never insert.
  // All draws are unconditional; per-petal arrays draw P_MAX entries even
  // though only petalCount are used, so the stream never depends on draw 2.
  const seedAngle = rng() * TAU; //                      draw 1: RMF seed frame
  const petalCount = 8 + Math.floor(rng() * 7); //       draw 2: 8..14 petals
  const leanPhase1 = rng() * TAU; //                     draw 3
  const leanPhase2 = rng() * TAU; //                     draw 4
  const breathPhase = rng() * TAU; //                    draw 5
  const rotPhase = rng() * TAU; //                       draw 6: rosette start
  const rotMag = 0.08 + 0.08 * rng(); //                 draw 7: rad/s
  const rotSpeed = rng() < 0.5 ? -rotMag : rotMag; //    draw 8: direction
  const twistPerRing = (rng() * 2 - 1) * 0.15; //        draw 9: stem rib twist
  const lenJ = new Float32Array(P_MAX); //               draws 10 .. 9+P_MAX
  for (let p = 0; p < P_MAX; p++) lenJ[p] = 0.85 + 0.3 * rng();
  const widJ = new Float32Array(P_MAX); //               next P_MAX draws
  for (let p = 0; p < P_MAX; p++) widJ[p] = 0.85 + 0.3 * rng();
  const cupJ = new Float32Array(P_MAX); //               next P_MAX draws
  for (let p = 0; p < P_MAX; p++) cupJ[p] = 0.6 + 0.8 * rng();
  const phJ = new Float32Array(P_MAX); //                next P_MAX draws
  for (let p = 0; p < P_MAX; p++) phJ[p] = rng() * 0.5;

  // petal grid derives only from draw 2 — deterministic per seed
  const dotsPerPetal = Math.floor(petalBudget / petalCount);
  const petalRows = Math.max(2, Math.floor(dotsPerPetal / petalCols));
  const count = stemCount + coreCount + petalCount * petalRows * petalCols;

  const sizeJit = new Float32Array(count); //            next count draws
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
  // ---- end frozen draw order ----

  // ---- stem (tube) statics
  const spine = createSpine(stemRings, sampleCount);
  const { cosT, sinT } = makeRingTables(stemRings, dotsPerStemRing, twistPerRing);
  const rNom = new Float32Array(stemRings); // gentle root→crown taper
  for (let i = 0; i < stemRings; i++) {
    const f = i / (stemRings - 1);
    rNom[i] = stemRadius * (1 - 0.35 * f);
  }
  const rEff = new Float32Array(stemRings);
  const drds = new Float32Array(stemRings);
  const ds = stemLen / (stemRings - 1);

  // rooted quadratic lean (v2 soul: sway·u², tip moves most, base anchored)
  let bx = 0;
  let bz = 0;
  const curve = (u, out, o) => {
    const q = u * u;
    out[o] = bx * q;
    out[o + 1] = u * stemLen;
    out[o + 2] = bz * q;
  };

  // ---- core dome statics: quantized equal-area rings on a paraboloid,
  // coordinates and unit normals precomputed in the crown frame (N,B,T)
  const coreN = new Float32Array(coreCount);
  const coreB = new Float32Array(coreCount);
  const coreT = new Float32Array(coreCount);
  const coreNn = new Float32Array(coreCount);
  const coreNb = new Float32Array(coreCount);
  const coreNt = new Float32Array(coreCount);
  {
    let d = 0;
    const g = (2 * coreHeight) / (coreRadius * coreRadius);
    for (let ri = 0; ri < coreRings; ri++) {
      const rho = coreRadius * Math.sqrt((ri + 0.5) / coreRings);
      const off = ri * 0.5; // stagger rings so spokes don't align
      for (let j = 0; j < coreDotsPerRing; j++, d++) {
        const a = off + (j * TAU) / coreDotsPerRing;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        coreN[d] = rho * ca;
        coreB[d] = rho * sa;
        coreT[d] = coreHeight * (1 - (rho * rho) / (coreRadius * coreRadius));
        // height-field normal ∝ (g·ρ·cos, g·ρ·sin, 1), normalized once here
        const il = 1 / Math.sqrt(g * g * rho * rho + 1);
        coreNn[d] = g * rho * ca * il;
        coreNb[d] = g * rho * sa * il;
        coreNt[d] = il;
      }
    }
  }

  // ---- petal statics: cell-centered u stations (width > 0 everywhere ⇒
  // analytic normal never degenerates), exact-edge v columns
  const uT = new Float32Array(petalRows);
  const sinPi = new Float32Array(petalRows);
  const cosPi = new Float32Array(petalRows);
  for (let i = 0; i < petalRows; i++) {
    const u = (i + 0.5) / petalRows;
    uT[i] = u;
    sinPi[i] = Math.sin(Math.PI * u);
    cosPi[i] = Math.cos(Math.PI * u);
  }
  const vT = new Float32Array(petalCols);
  for (let j = 0; j < petalCols; j++) vT[j] = j / (petalCols - 1) - 0.5;

  const AMP1 = 0.22; // stem lean amplitudes (world units at tip, per sway=1)
  const AMP2 = 0.16;

  function updateTargets(timeSec, sway, tempo, positions, normals) {
    const s = Math.min(sway, SWAY_MAX);
    const t = timeSec * tempo;
    bx = AMP1 * s * Math.sin(WS1 * t + leanPhase1);
    bz = AMP2 * s * Math.sin(WS2 * t + leanPhase2);
    spine.update(curve, stemLen, seedAngle);
    // sway clamp (spec §5): κ ~linear in lean, one correction pass suffices
    const m = spine.maxKappaR(rNom);
    if (m > KAPPA_R_MAX) {
      const sc = KAPPA_R_MAX / m;
      bx *= sc;
      bz *= sc;
      spine.update(curve, stemLen, seedAngle);
    }
    const kap = spine.kappa;
    for (let i = 0; i < stemRings; i++) {
      let r = rNom[i];
      if (kap[i] * r > RING_SHRINK) r = RING_SHRINK / kap[i]; // local guard (§5)
      rEff[i] = r;
    }
    for (let i = 0; i < stemRings; i++) {
      const ia = i > 0 ? i - 1 : 0;
      const ib = i < stemRings - 1 ? i + 1 : i;
      drds[i] = ib > ia ? (rEff[ib] - rEff[ia]) / ((ib - ia) * ds) : 0;
    }
    const P = spine.positions;
    const T = spine.tangents;
    const N = spine.normals;
    const B = spine.binormals;
    let d = 0;
    // --- stem dots (tube normals: ring offset + taper tilt, as eel)
    for (let i = 0; i < stemRings; i++) {
      const oi = i * 3;
      const px = P[oi];
      const py = P[oi + 1];
      const pz = P[oi + 2];
      const nx = N[oi];
      const ny = N[oi + 1];
      const nz = N[oi + 2];
      const bxv = B[oi];
      const byv = B[oi + 1];
      const bzv = B[oi + 2];
      const r = rEff[i];
      const g = drds[i];
      const inl = 1 / Math.sqrt(1 + g * g);
      const gtx = g * inl * T[oi];
      const gty = g * inl * T[oi + 1];
      const gtz = g * inl * T[oi + 2];
      const row = i * dotsPerStemRing;
      for (let j = 0; j < dotsPerStemRing; j++, d++) {
        const c = cosT[row + j];
        const sn = sinT[row + j];
        const dx = c * nx + sn * bxv;
        const dy = c * ny + sn * byv;
        const dz = c * nz + sn * bzv;
        const o = perm[d] * 3;
        positions[o] = px + r * dx;
        positions[o + 1] = py + r * dy;
        positions[o + 2] = pz + r * dz;
        normals[o] = dx * inl - gtx;
        normals[o + 1] = dy * inl - gty;
        normals[o + 2] = dz * inl - gtz;
      }
    }
    // --- crown frame: last spine station (petals + core inherit stem tilt)
    const ci = (stemRings - 1) * 3;
    const cxp = P[ci];
    const cyp = P[ci + 1];
    const czp = P[ci + 2];
    const tx = T[ci];
    const ty = T[ci + 1];
    const tz = T[ci + 2];
    const nx0 = N[ci];
    const ny0 = N[ci + 1];
    const nz0 = N[ci + 2];
    const bx0 = B[ci];
    const by0 = B[ci + 1];
    const bz0 = B[ci + 2];
    // --- core dome dots (static in crown frame; unit local normals stay
    // unit under the orthonormal (N,B,T) transform — no renormalize)
    for (let k = 0; k < coreCount; k++, d++) {
      const a = coreN[k];
      const b = coreB[k];
      const c = coreT[k];
      const o = perm[d] * 3;
      positions[o] = cxp + a * nx0 + b * bx0 + c * tx;
      positions[o + 1] = cyp + a * ny0 + b * by0 + c * ty;
      positions[o + 2] = czp + a * nz0 + b * bz0 + c * tz;
      const na = coreNn[k];
      const nb = coreNb[k];
      const nc = coreNt[k];
      normals[o] = na * nx0 + nb * bx0 + nc * tx;
      normals[o + 1] = na * ny0 + nb * by0 + nc * ty;
      normals[o + 2] = na * nz0 + nb * bz0 + nc * tz;
    }
    // --- petals: breath cycle + slow rotation + rotary wobble (v2 soul)
    const depth = Math.min(1, 0.45 * s); // breath depth scales with sway
    const thetaBase = rotPhase + rotSpeed * t + 0.06 * s * Math.sin(0.5 * t + breathPhase);
    const step = TAU / petalCount;
    for (let p = 0; p < petalCount; p++) {
      const br = Math.sin(WB * t + breathPhase + phJ[p]);
      const open = 1 - depth * (0.5 - 0.5 * br); // ∈ [1−depth, 1]
      const a0 = 0.1 + 1.05 * open; // base tilt off the stem axis
      const a1 = 0.5 + 0.45 * open; // outward curl along the petal (≥ 0.5)
      const theta = thetaBase + p * step;
      const cth = Math.cos(theta);
      const sth = Math.sin(theta);
      // petal basis: R̂ radial, Ŵ = T̂×R̂ chordwise, T̂ crown axis
      const rx = cth * nx0 + sth * bx0;
      const ry = cth * ny0 + sth * by0;
      const rz = cth * nz0 + sth * bz0;
      const wx = -sth * nx0 + cth * bx0;
      const wy = -sth * ny0 + cth * by0;
      const wz = -sth * nz0 + cth * bz0;
      const L = petalLen * lenJ[p];
      const widC = 0.4 * L * widJ[p]; // full width scale; ×sin(πu) profile
      const cupK = cupJ[p];
      const Larc = L / a1; // circular-arc centerline radius
      const cosA0 = Math.cos(a0);
      const sinA0 = Math.sin(a0);
      for (let i = 0; i < petalRows; i++) {
        const alpha = a0 + a1 * uT[i];
        const sinA = Math.sin(alpha);
        const cosA = Math.cos(alpha);
        const w = widC * sinPi[i];
        const wP = widC * Math.PI * cosPi[i]; // dw/du
        const cR = Larc * (cosA0 - cosA); // arc centerline, exact
        const cT = Larc * (sinA - sinA0);
        const puR0 = L * sinA; // dC/du = L(sinα R̂ + cosα T̂)
        const puT0 = L * cosA;
        // cup ∂/∂u pieces: cup = cupK·v²·w·N̂l, N̂l = cosα R̂ − sinα T̂,
        // N̂l′ = −a1(sinα R̂ + cosα T̂)  — all terms kept (M4)
        const g1 = cupK * (wP * cosA - w * a1 * sinA);
        const g2 = cupK * (-wP * sinA - w * a1 * cosA);
        const cwc = cupK * w * cosA;
        const cws = cupK * w * sinA;
        for (let j = 0; j < petalCols; j++, d++) {
          const v = vT[j];
          const v2 = v * v;
          // position in (R̂, Ŵ, T̂)
          const xR = cR + v2 * cwc;
          const xW = v * w;
          const xT = cT - v2 * cws;
          // ∂P/∂u, ∂P/∂v in the same basis
          const puR = puR0 + v2 * g1;
          const puW = v * wP;
          const puT = puT0 + v2 * g2;
          const pvR = 2 * v * cwc;
          const pvW = w;
          const pvT = -2 * v * cws;
          // n = ∂P/∂u × ∂P/∂v (orthonormal basis ⇒ same components in 3D)
          const nR = puW * pvT - puT * pvW;
          const nW = puT * pvR - puR * pvT;
          const nT = puR * pvW - puW * pvR;
          let ox = nR * rx + nW * wx + nT * tx;
          let oy = nR * ry + nW * wy + nT * ty;
          let oz = nR * rz + nW * wz + nT * tz;
          const il = 1 / Math.sqrt(ox * ox + oy * oy + oz * oz);
          const o = perm[d] * 3;
          positions[o] = cxp + xR * rx + xW * wx + xT * tx;
          positions[o + 1] = cyp + xR * ry + xW * wy + xT * ty;
          positions[o + 2] = czp + xR * rz + xW * wz + xT * tz;
          normals[o] = ox * il;
          normals[o + 1] = oy * il;
          normals[o + 2] = oz * il;
        }
      }
    }
  }

  function init({ aSize, aTw, aRing }) {
    let d = 0;
    for (let i = 0; i < stemRings; i++) {
      const rf = (0.45 * i) / (stemRings - 1); // root→crown ∈ [0, 0.45]
      for (let j = 0; j < dotsPerStemRing; j++, d++) {
        const sl = perm[d];
        aSize[sl] = 0.55 * sizeJit[d];
        aTw[sl] = twPhase[d];
        aRing[sl] = rf;
      }
    }
    for (let k = 0; k < coreCount; k++, d++) {
      const sl = perm[d];
      aSize[sl] = 0.9 * sizeJit[d];
      aTw[sl] = twPhase[d];
      aRing[sl] = 0.47;
    }
    for (let p = 0; p < petalCount; p++) {
      for (let i = 0; i < petalRows; i++) {
        const rf = 0.5 + 0.5 * uT[i]; // crown→petal-tip ∈ (0.5, 1)
        const sz = 0.8 - 0.3 * uT[i]; // slimmer dots toward the tip
        for (let j = 0; j < petalCols; j++, d++) {
          const sl = perm[d];
          aSize[sl] = sz * sizeJit[d];
          aTw[sl] = twPhase[d];
          aRing[sl] = rf;
        }
      }
    }
  }

  return { count, ringCount: stemRings + coreRings + petalRows, init, updateTargets };
}

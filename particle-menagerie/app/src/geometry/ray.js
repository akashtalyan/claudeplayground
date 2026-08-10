// Ray — sheet archetype. Pure math, no three.js (node-benchable).
// Contract: geometry-spec.md. LOCAL space (§10); normals = normalized
// ∂P/∂u × ∂P/∂v from analytic derivatives built on per-STATION tables —
// per-dot work is table combines + one normalize, zero per-dot trig.
// Dots sit on quantized (u,v) lines for the dotted-rib look (§7).

import { mulberry32 } from './rng.js';
import { TAU } from './spine.js';

// flap vs undulation frequency ratio — incommensurate (spec §1 spirit)
const W_RATIO = Math.SQRT2 * 1.618033988749895 * 0.5;
const WF = 1.7;
const WU = WF * W_RATIO;
const SWAY_MAX = 2.4; // slider 2.4 = max safe sway (spec §5 normalization)

export function makeRay(seed, opts = {}) {
  // v3.2 density uplift: 40×30 (1200) → 58×42 (2436). Both grid directions go
  // up ~1.45×, so the (u,v) cells stay near-square (span 5.2/57 ≈ 0.091 vs
  // chord 2.4/41 ≈ 0.059 at the root, tighter at the tips where the chord
  // narrows) — the wing reads as a finer dotted membrane, and the quantized
  // v-lines stay legible as ribs (spec §7). Draw ORDER unchanged (spec §8);
  // only the count-sized blocks (sizeJit / twPhase / perm) lengthen.
  //
  // v3.7 fix round 2: the uplift bought resolution the sprite could not spend.
  // At the archetype's tuned dotPx the chordwise pitch came out at 2.93 world
  // px against a ~3.0 px dot — a ratio under 1, so the membrane rendered as a
  // continuous saturated mass with a halo and no dot structure at all (the
  // blowout metric never caught it: a solid white body at maxChannel 249 is
  // exactly as dead as one at 255). The ray is the one SHEET archetype: unlike
  // the tube archetypes it has no far side to hide half its dots, and it is
  // banked toward the lens, which foreshortens one grid direction on top of
  // everything else. 44 × 30 puts the chord pitch at 4.14 world px against the
  // retuned 2.57 px dot (ratio 1.6, above the fish's 1.2), which is what the
  // dotted-rib identity in geometry-spec §7 actually costs on a flat sheet.
  const nU = opts.spanDots ?? 44; // spanwise stations (u lines)
  const nV = opts.chordDots ?? 30; // chordwise rows (v lines)
  const count = nU * nV;
  const ringCount = nV; // "rings" = quantized chordwise v-lines, front→back
  const span = opts.span ?? 5.2;
  const halfSpan = span / 2;
  const chord = opts.chord ?? 2.4;

  const rng = mulberry32(seed);
  // ---- FROZEN DRAW ORDER (spec §8) — append only, never insert ----
  const flapPhase = rng() * TAU; //                      draw 1
  const undPhase = rng() * TAU; //                       draw 2
  const lag = 0.9 + 0.5 * rng(); //                      draw 3: spanwise flap lag
  const sizeJit = new Float32Array(count); //            draws 4 .. 3+count
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

  // ---- static per-u-station tables (planform, envelopes, ∂/∂u by central
  // difference over the same tables, du in u∈[−1,1] domain units)
  const X = new Float32Array(nU); // spanwise position
  const zC = new Float32Array(nU); // chord centerline (swept-back tips)
  const cU = new Float32Array(nU); // local chord length
  const yR = new Float32Array(nU); // rest camber (gentle arch)
  const flapC = new Float32Array(nU); // flapEnv·cos(lag|u|)
  const flapS = new Float32Array(nU); // flapEnv·sin(lag|u|)
  const undH = new Float32Array(nU); // undulation envelope
  const dzC = new Float32Array(nU);
  const dcU = new Float32Array(nU);
  const dyR = new Float32Array(nU);
  const dFlapC = new Float32Array(nU);
  const dFlapS = new Float32Array(nU);
  const dUndH = new Float32Array(nU);
  for (let i = 0; i < nU; i++) {
    const u = -1 + (2 * i) / (nU - 1);
    const uu = Math.abs(u);
    X[i] = u * halfSpan;
    cU[i] = chord * (0.22 + 0.78 * Math.pow(1 - uu, 0.85));
    zC[i] = chord * (0.55 * uu * uu - 0.2);
    yR[i] = 0.18 * (1 - uu * uu) - 0.1;
    const flapEnv = 0.12 + 0.88 * Math.pow(uu, 1.6);
    flapC[i] = flapEnv * Math.cos(lag * uu);
    flapS[i] = flapEnv * Math.sin(lag * uu);
    undH[i] = 1 - 0.55 * uu;
  }
  const du = 2 / (nU - 1);
  for (let i = 0; i < nU; i++) {
    const ia = i > 0 ? i - 1 : 0;
    const ib = i < nU - 1 ? i + 1 : i;
    const inv = 1 / ((ib - ia) * du);
    dzC[i] = (zC[ib] - zC[ia]) * inv;
    dcU[i] = (cU[ib] - cU[ia]) * inv;
    dyR[i] = (yR[ib] - yR[ia]) * inv;
    dFlapC[i] = (flapC[ib] - flapC[ia]) * inv;
    dFlapS[i] = (flapS[ib] - flapS[ia]) * inv;
    dUndH[i] = (undH[ib] - undH[ia]) * inv;
  }
  // ---- static per-v-row tables: traveling wave decomposed so the per-frame
  // trig cost is 4 calls total, not per dot
  const KV = TAU * 0.85;
  const sV = new Float32Array(nV);
  const cV = new Float32Array(nV);
  const vH = new Float32Array(nV); // v − 0.5
  for (let j = 0; j < nV; j++) {
    const v = j / (nV - 1);
    sV[j] = Math.sin(KV * v);
    cV[j] = Math.cos(KV * v);
    vH[j] = v - 0.5;
  }

  const FLAP_A = 0.4;
  const UND_A = 0.15;

  function updateTargets(timeSec, sway, tempo, positions, normals) {
    const t = timeSec * tempo;
    const pf = flapPhase + WF * t;
    const pu = undPhase + WU * t;
    const sF = Math.sin(pf);
    const cF = Math.cos(pf);
    const sU = Math.sin(pu);
    const cUp = Math.cos(pu);
    const s = Math.min(sway, SWAY_MAX);
    const Af = FLAP_A * s;
    const Au = UND_A * s;
    let d = 0;
    for (let i = 0; i < nU; i++) {
      const x = X[i];
      const zc = zC[i];
      const c = cU[i];
      const dzc = dzC[i];
      const dc = dcU[i];
      // sin(Φf − lag|u|)·env = sF·flapC − cF·flapS (per station, no dot trig)
      const fu = yR[i] + Af * (sF * flapC[i] - cF * flapS[i]);
      const dfu = dyR[i] + Af * (sF * dFlapC[i] - cF * dFlapS[i]);
      const hu = Au * undH[i];
      const dhu = Au * dUndH[i];
      for (let j = 0; j < nV; j++, d++) {
        const q = sV[j] * cUp - cV[j] * sU; // sin(KV·v − Φu)
        const dq = KV * (cV[j] * cUp + sV[j] * sU); // ∂q/∂v
        const vh = vH[j];
        const Y = fu + hu * q;
        const Yu = dfu + dhu * q;
        const Yv = hu * dq;
        const Zu = dzc + vh * dc;
        // n ∝ Pv × Pu with Pu=(halfSpan,Yu,Zu), Pv=(0,Yv,c); +y at rest
        let nx = Zu * Yv - Yu * c;
        let ny = halfSpan * c;
        let nz = -halfSpan * Yv;
        const il = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        const o = perm[d] * 3;
        positions[o] = x;
        positions[o + 1] = Y;
        positions[o + 2] = zc + vh * c;
        normals[o] = nx * il;
        normals[o + 1] = ny * il;
        normals[o + 2] = nz * il;
      }
    }
  }

  function init({ aSize, aTw, aRing }) {
    let d = 0;
    for (let i = 0; i < nU; i++) {
      const sz = 0.55 + 0.45 * Math.sqrt(cU[i] / chord); // smaller at wingtips
      for (let j = 0; j < nV; j++, d++) {
        const sl = perm[d];
        aSize[sl] = sz * sizeJit[d];
        aTw[sl] = twPhase[d];
        aRing[sl] = j / (nV - 1); // chordwise fraction, row-quantized
      }
    }
  }

  return { count, ringCount, init, updateTargets };
}

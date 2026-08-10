// Medusa — jellyfish. Pure math, no three.js (node-benchable).
// Contract: geometry-spec.md. LOCAL space (§10). Two parts:
//   Bell: surface of revolution around the local y axis (tube class per the
//     normals table) — quantized rings on the bell meridian, normals from
//     ring offsets + full profile tilt (the taper-tilt correction generalized
//     to the meridian slope, exact for a surface of revolution).
//   Tentacles: 6–10 thin RMF strand tubes (createSpine per strand), traveling
//     waves + drag lag behind the bell pulse, curvature-clamped like the eel.
// Zero allocation in updateTargets (§4); frozen RNG draw order (§8).
//
// Motion (ported from v2 ARCH.medusa): rhythmic bell pulse — radius swell
// anti-phased with vertical squash — with the pulse phase propagating apex→rim
// so the rim curls under late in each contraction; tentacles trail with an
// inward drift, a traveling wave whose amplitude grows toward the tip, and a
// radial flare that lags the bell pulse down their length.

import { mulberry32, hashName } from './rng.js';
import { createSpine, makeRingTables, KAPPA_R_MAX, RING_SHRINK, TAU } from './spine.js';

// incommensurate secondary-frequency ratio (spec §1 spirit, same family as eel)
const W_RATIO = Math.SQRT2 * 1.618033988749895;
const SWAY_MAX = 2.4; // slider 2.4 = max safe sway (spec §5 normalization)

// bell meridian: polar angle from just-off-apex to past-equator (tucked rim)
const PHI_MIN = 0.18;
const PHI_SPAN = 1.72;
const LAG_BELL = 1.9; // pulse phase lag apex→rim (the propagating rim curl)

// ---- named-species morph presets (v3.8) -----------------------------------
// Every gelatinous animal in LEX.medusa rendered as the SAME hemispherical
// bell with 6-10 medium tentacles. That is a passable Aurelia and a bad
// everything-else: a comb jelly has no tentacles at all and is an ovoid, a
// siphonophore is a metres-long chain that is mostly trailing, a box jelly is
// taller than it is wide with four corner clusters. Axes:
//   bell     bell radius ×
//   height   bell y semi-axis × — dome vs saucer vs ovoid. The single most
//            diagnostic number: a moon jelly is a flat plate (0.5), a comb
//            jelly a tall egg (1.5).
//   span     bell meridian span ×. <1 stops at/above the equator (an open
//            saucer); >1 wraps the meridian past it into a closed body — the
//            only way to make a ctenophore read as a sealed ovoid rather than
//            a bowl with a visible underside.
//   tent     tentacle length ×
//   tentMul  tentacle-count ×, applied to the seed's draw (never replaces it,
//            so the count still varies per individual)
//   tentR    strand thickness ×
//   pulse    bell-pulse amplitude ×
//   scale/tempo/speed  world hints for lexicon.js; ignored here.
export const MEDUSA_MORPHS = {
  // Aurelia: a flat translucent plate trailing a fine short fringe.
  moonjelly: {
    bell: 1.0, height: 0.5, span: 0.82, tent: 0.35, tentMul: 2.6, tentR: 0.6,
    pulse: 1.15, scale: 0.85, tempo: 0.9,
  },
  // The largest jellyfish there is: a broad ruffled bell over a dense curtain.
  lionsmane: {
    bell: 1.5, height: 0.72, span: 0.95, tent: 2.3, tentMul: 3.0, tentR: 0.7,
    pulse: 0.9, scale: 1.5, tempo: 0.6, speed: 0.6,
  },
  // Cubozoan: bell taller than wide, tentacles from four corners only.
  boxjelly: {
    bell: 0.85, height: 1.35, span: 0.88, tent: 2.6, tentMul: 0.45, tentR: 1.15,
    pulse: 1.2, scale: 0.8, tempo: 1.25, speed: 1.5,
  },
  // A siphonophore is a colony, not a bell — a small swimming nectosome at the
  // top and a very long trailing siphosome. Almost all length, almost no bell.
  siphonophore: {
    bell: 0.42, height: 1.1, span: 0.9, tent: 4.4, tentMul: 0.55, tentR: 0.85,
    pulse: 0.7, scale: 1.2, tempo: 0.5, speed: 0.4,
  },
  // Ctenophore: a sealed ovoid ribbed with comb rows, NOT a bell. span > 1
  // closes the meridian; the two long trailing tentilla are the only strands.
  combjelly: {
    bell: 0.72, height: 1.55, span: 1.14, tent: 1.5, tentMul: 0.25, tentR: 0.7,
    pulse: 0.55, scale: 0.6, tempo: 1.1, speed: 0.8,
  },
  // Atolla: deep-red domed bell, ~20 short marginal tentacles and one
  // hypertrophied trailing one. Its alarm display is bioluminescence's job.
  atolla: {
    bell: 0.9, height: 0.62, span: 0.9, tent: 1.05, tentMul: 2.2, tentR: 0.65,
    pulse: 1.0, scale: 0.7, tempo: 0.85, speed: 0.7,
  },
  // Aequorea: a clean hemisphere with a very dense fine marginal fringe —
  // the animal GFP came from.
  crystaljelly: {
    bell: 0.95, height: 0.78, span: 0.86, tent: 0.6, tentMul: 3.2, tentR: 0.5,
    pulse: 1.05, scale: 0.7, tempo: 1.0,
  },
  // Physalia is not a medusa at all: a gas float riding the surface above
  // tentacles that reach tens of metres. Tall short bell, enormous trail.
  manowar: {
    bell: 0.8, height: 1.25, span: 0.7, tent: 4.0, tentMul: 1.4, tentR: 0.8,
    pulse: 0.45, scale: 0.9, tempo: 0.4, speed: 0.35,
  },
  // Sea angel: a small swimming sea slug. No tentacle curtain, wing-flapping
  // body — the closest the bell can get is a tiny, tall, nearly bare form.
  seaangel: {
    bell: 0.5, height: 1.2, span: 1.05, tent: 0.3, tentMul: 0.3, tentR: 0.8,
    pulse: 1.5, scale: 0.4, tempo: 1.4, speed: 0.9,
  },
};
const MEDUSA_ALIASES = {
  moonjelly: ['moonjelly', 'moon jelly', 'aurelia', 'jellyfish', 'jelly', 'medusa'],
  lionsmane: ['lionsmane', 'lions mane', "lion's mane", 'lionsmanejelly', 'cyanea'],
  boxjelly: ['boxjelly', 'box jelly', 'cubozoan', 'seawasp', 'sea wasp', 'irukandji'],
  siphonophore: ['siphonophore', 'praya', 'apolemia'],
  combjelly: ['combjelly', 'comb jelly', 'ctenophore', 'comb', 'seagooseberry'],
  atolla: ['atolla', 'atollajellyfish', 'alarmjelly', 'alarm jelly'],
  crystaljelly: ['crystaljelly', 'crystal jelly', 'aequorea'],
  manowar: ['manowar', 'man o war', 'manofwar', 'portuguesemanowar', 'physalia', 'bluebottle'],
  seaangel: ['seaangel', 'sea angel', 'clione'],
};
const MORPH_BY_SEED = new Map();
for (const k of Object.keys(MEDUSA_MORPHS)) {
  for (const n of MEDUSA_ALIASES[k] || [k]) {
    MORPH_BY_SEED.set(hashName(n), MEDUSA_MORPHS[k]);
    MORPH_BY_SEED.set(hashName(n + 's'), MEDUSA_MORPHS[k]);
  }
}
/** Preset lookup by name, for lexicon.js (mirrors FISH_MORPHS[word] usage). */
export function medusaMorphFor(word) {
  if (!word) return null;
  const w = String(word).toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(MEDUSA_MORPHS, w)) return MEDUSA_MORPHS[w];
  return MORPH_BY_SEED.get(hashName(w)) || null;
}

export function makeMedusa(seed, opts = {}) {
  // v3.2 density uplift: bell 24×34 (816) → 32×54 (1728); tentacle budget
  // 684 → 1560, split as 4 dots/ring × ~2.2× the stations rather than 3 ×
  // ~3×: at 3 the strand read as a flat dotted ribbon, and spending the whole
  // budget on stations would have driven the per-strand arc sampler (below)
  // harder than the dots themselves cost. A 3.5-long strand goes from ~0.12
  // arc pitch to ~0.055. Bell meridian pitch B·1.72/31 ≈
  // 0.089 vs equator circumference 2πB/54 ≈ 0.186: the bell is a wide dome,
  // so meridian ribs stay the dominant read while the ribs themselves get
  // twice the dots. Total ≈ 1509 → ≈ 3290 (~2.2×).
  const bellRings = opts.bellRings ?? 32;
  const bellDots = opts.bellDotsPerRing ?? 54;
  const bellCount = bellRings * bellDots; // 1728
  const tentDotsPerRing = 4; // thin strand tube
  const tentBudget = opts.tentDotBudget ?? 1560; // bell + tentacles ≈ 3290
  // preset resolution (pure function of opts.morph / seed — no RNG, so the
  // frozen draw order below is untouched and determinism is unaffected)
  const preset = opts.morph ?? MORPH_BY_SEED.get(seed >>> 0) ?? null;
  const M = {
    bell: preset?.bell ?? 1,
    height: preset?.height ?? 1,
    span: preset?.span ?? 1,
    tent: preset?.tent ?? 1,
    tentMul: preset?.tentMul ?? 1,
    tentR: preset?.tentR ?? 1,
    pulse: preset?.pulse ?? 1,
  };
  const baseB = (opts.bellRadius ?? 1.6) * M.bell;

  const rng = mulberry32(seed);
  // ---- FROZEN DRAW ORDER (spec §8) — append only, never insert ----
  const bellJit = 0.85 + 0.3 * rng(); //                 draw 1: bell size
  const bellPhase = rng() * TAU; //                      draw 2: pulse phase
  const swayPhase = rng() * TAU; //                      draw 3: drift wobble
  const curlJit = 0.7 + 0.6 * rng(); //                  draw 4: rim curl depth
  const twistBell = (rng() * 2 - 1) * 0.06; //           draw 5: bell rib twist
  const twistTent = (rng() * 2 - 1) * 0.15; //           draw 6: strand twist
  // draw 7: tentacle count. The preset SCALES the draw rather than replacing
  // it, so a box jelly still varies individual-to-individual (3-4 corner
  // clusters) instead of every one having exactly the same fringe.
  const T = Math.max(2, Math.round((6 + Math.floor(rng() * 5)) * M.tentMul));
  // per-tentacle draws — 4 each, T fixed by draw 7, so counts are seed-exact
  const azC = new Float32Array(T);
  const azS = new Float32Array(T);
  const lenJit = new Float32Array(T);
  const wavePh = new Float32Array(T);
  const seedAng = new Float32Array(T);
  for (let k = 0; k < T; k++) {
    const az = ((k + 0.5) * TAU) / T + (rng() - 0.5) * (TAU / T) * 0.35;
    azC[k] = Math.cos(az);
    azS[k] = Math.sin(az);
    lenJit[k] = 0.65 + 0.55 * rng();
    wavePh[k] = rng() * TAU;
    seedAng[k] = rng() * TAU;
  }
  const tentStations = Math.round(tentBudget / (tentDotsPerRing * T));
  // Arc sampling must stay AHEAD of the station count, or two stations share
  // one sample interval and the equal-arc-length inversion (spec §6) can no
  // longer resolve them. v3.1's flat 60 was ahead of 29 stations; at up to 65
  // it no longer is, hence the floor. Only a floor, not a ratio: measured
  // against a 500-sample build, tentacle dots move <0.05% of extent, so extra
  // samples here buy nothing but Math.sin calls. Pure function of (opts, draw
  // 7) — no RNG, so counts still never vary by machine (spec §8/§9).
  const tentSample = Math.max(opts.tentSampleCount ?? 60, tentStations + 4);
  const count = bellCount + T * tentStations * tentDotsPerRing; // ~3290
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

  const B = baseB * bellJit;
  const tentLen = (opts.tentLength ?? baseB * 2.2) * bellJit * M.tent;

  // ---- bell statics: meridian parameter, rest angle, rim-curl envelope,
  // quantized ring tables (spec §7)
  const qB = new Float32Array(bellRings);
  const phi0 = new Float32Array(bellRings);
  const curlEnv = new Float32Array(bellRings);
  for (let i = 0; i < bellRings; i++) {
    const q = i / (bellRings - 1);
    qB[i] = q;
    phi0[i] = PHI_MIN + q * PHI_SPAN * M.span;
    const e = Math.min(1, Math.max(0, (q - 0.55) / 0.45));
    curlEnv[i] = e * e * (3 - 2 * e); // smoothstep: curl lives near the rim
  }
  const bellTab = makeRingTables(bellRings, bellDots, twistBell);
  // per-frame meridian state + central differences (prealloc, spec §4)
  const rhoB = new Float32Array(bellRings);
  const yB = new Float32Array(bellRings);
  const cxB = new Float32Array(bellRings);
  const czB = new Float32Array(bellRings);
  const dRho = new Float32Array(bellRings);
  const dY = new Float32Array(bellRings);
  const dCx = new Float32Array(bellRings);
  const dCz = new Float32Array(bellRings);

  // ---- tentacle statics: one RMF spine per strand (own temporal seed frame),
  // shared radius profile + scratch (strands are processed sequentially)
  const spines = [];
  for (let k = 0; k < T; k++) spines.push(createSpine(tentStations, tentSample));
  const tentTab = makeRingTables(tentStations, tentDotsPerRing, twistTent);
  const rNomT = new Float32Array(tentStations);
  for (let i = 0; i < tentStations; i++) {
    const u = i / (tentStations - 1);
    rNomT[i] = B * 0.048 * M.tentR * (1 - 0.7 * u); // thin, tapering to the tip
  }
  const rEffT = new Float32Array(tentStations);
  const drdsT = new Float32Array(tentStations);

  // ---- tentacle curve: current-frame params live in outer lets so the
  // closure is built once (zero per-frame allocation)
  let tCa = 1;
  let tSa = 0;
  let tLen = 1;
  let cPB = 0; // bell-pulse phase (flare drags behind it down the strand)
  let cWT = 0; // traveling-wave phase (v2: sin(1.6t − 5u + per-tentacle phase))
  let cW2 = 0; // secondary incommensurate wave, radial plane
  let cWA = 0;
  let cFA = 0;
  let cW2A = 0;
  let rhoAtt = 0;
  let yAtt = 0;
  let cxAtt = 0;
  let czAtt = 0;
  const curveT = (u, out, o) => {
    const rad =
      rhoAtt * (1 - 0.25 * u) + // v2 inward drift toward the axis
      cFA * u * Math.sin(cPB - 2.6 * u - 0.8) + // flare, drag-lagged bell pulse
      cW2A * u * Math.sin(cW2 - 3.1 * u);
    const tang = cWA * u * Math.sin(cWT - 5 * u); // amplitude grows tipward
    out[o] = cxAtt + rad * tCa - tang * tSa;
    out[o + 1] = yAtt - u * tLen;
    out[o + 2] = czAtt + rad * tSa + tang * tCa;
  };

  function updateTargets(timeSec, sway, tempo, positions, normals) {
    const s = Math.min(sway, SWAY_MAX);
    const tt = timeSec * tempo;
    const pB = 2.0 * tt + bellPhase; // v2 pulse rate
    const hScale = 1 - 0.12 * s * Math.sin(pB); // squash, anti-phase with swell
    const curlA = 0.09 * s * curlJit * M.pulse;
    const pulseA = 0.13 * s * M.pulse;
    const wob1 = 0.06 * B * s * Math.sin(0.9 * tt + swayPhase);
    const wob2 = 0.06 * B * s * Math.sin(0.9 * W_RATIO * tt + swayPhase + 2.1);
    // --- bell meridian: pulse propagates apex→rim; curl folds the rim under
    for (let i = 0; i < bellRings; i++) {
      const q = qB[i];
      const pw = Math.sin(pB - LAG_BELL * q);
      const phi = phi0[i] + curlA * curlEnv[i] * pw;
      let rho = B * Math.sin(phi) * (1 + pulseA * pw);
      if (rho < 0.02 * B) rho = 0.02 * B;
      rhoB[i] = rho;
      yB[i] = B * M.height * hScale * Math.cos(phi);
      cxB[i] = wob1 * q; // gentle drift wobble, apex steady, rim trailing
      czB[i] = wob2 * q;
    }
    for (let i = 0; i < bellRings; i++) {
      const ia = i > 0 ? i - 1 : 0;
      const ib = i < bellRings - 1 ? i + 1 : i;
      const inv = 1 / (ib - ia);
      dRho[i] = (rhoB[ib] - rhoB[ia]) * inv;
      dY[i] = (yB[ib] - yB[ia]) * inv;
      dCx[i] = (cxB[ib] - cxB[ia]) * inv;
      dCz[i] = (czB[ib] - czB[ia]) * inv;
    }
    // --- bell dots. Surface of revolution P(q,A) = C(q) + ρ(q)·u(A):
    // n ∝ (ρ′ + C′·u)·ŷ − y′·u — ring-offset direction tilted by the meridian
    // slope (exact taper tilt), unit after one normalize per dot.
    const { cosT: bc, sinT: bs } = bellTab;
    let d = 0;
    for (let i = 0; i < bellRings; i++) {
      const rho = rhoB[i];
      const y = yB[i];
      const cx = cxB[i];
      const cz = czB[i];
      const dr = dRho[i];
      const dy = dY[i];
      const dcx = dCx[i];
      const dcz = dCz[i];
      const row = i * bellDots;
      for (let j = 0; j < bellDots; j++, d++) {
        const c = bc[row + j];
        const sn = bs[row + j];
        let nx = -dy * c;
        let ny = dr + dcx * c + dcz * sn;
        let nz = -dy * sn;
        let l2 = nx * nx + ny * ny + nz * nz;
        if (l2 < 1e-20) {
          nx = 0;
          ny = 1;
          nz = 0;
          l2 = 1;
        }
        const il = 1 / Math.sqrt(l2);
        const o = perm[d] * 3;
        positions[o] = cx + rho * c;
        positions[o + 1] = y;
        positions[o + 2] = cz + rho * sn;
        normals[o] = nx * il;
        normals[o + 1] = ny * il;
        normals[o + 2] = nz * il;
      }
    }
    // --- tentacles hang from just inside the rim and follow its motion
    const ir = bellRings - 1;
    rhoAtt = rhoB[ir] * 0.9;
    yAtt = yB[ir] + 0.03 * B;
    cxAtt = cxB[ir];
    czAtt = czB[ir];
    cPB = pB;
    const wA0 = 0.16 * B * s;
    const fA0 = 0.08 * B * s;
    const w2A0 = 0.06 * B * s;
    const { cosT: tc, sinT: ts } = tentTab;
    for (let k = 0; k < T; k++) {
      tCa = azC[k];
      tSa = azS[k];
      tLen = tentLen * lenJit[k];
      cWT = 1.6 * tt + wavePh[k];
      cW2 = 1.6 * W_RATIO * tt + wavePh[k] * 1.9;
      cWA = wA0;
      cFA = fA0;
      cW2A = w2A0;
      const sp = spines[k];
      sp.update(curveT, tLen, seedAng[k]);
      // sway clamp per strand (spec §5): κ ~linear in wave amps, one pass
      const m = sp.maxKappaR(rNomT);
      if (m > KAPPA_R_MAX) {
        const sc = KAPPA_R_MAX / m;
        cWA *= sc;
        cFA *= sc;
        cW2A *= sc;
        sp.update(curveT, tLen, seedAng[k]);
      }
      const kap = sp.kappa;
      for (let i = 0; i < tentStations; i++) {
        let r = rNomT[i];
        if (kap[i] * r > RING_SHRINK) r = RING_SHRINK / kap[i]; // local guard (§5)
        rEffT[i] = r;
      }
      const dsT = tLen / (tentStations - 1);
      for (let i = 0; i < tentStations; i++) {
        const ia = i > 0 ? i - 1 : 0;
        const ib = i < tentStations - 1 ? i + 1 : i;
        drdsT[i] = ib > ia ? (rEffT[ib] - rEffT[ia]) / ((ib - ia) * dsT) : 0;
      }
      const P = sp.positions;
      const Tt = sp.tangents;
      const N = sp.normals;
      const Bn = sp.binormals;
      for (let i = 0; i < tentStations; i++) {
        const oi = i * 3;
        const px = P[oi];
        const py = P[oi + 1];
        const pz = P[oi + 2];
        const nx = N[oi];
        const ny = N[oi + 1];
        const nz = N[oi + 2];
        const bx = Bn[oi];
        const by = Bn[oi + 1];
        const bz = Bn[oi + 2];
        const r = rEffT[i];
        const g = drdsT[i];
        // taper tilt: n = (radial − r′(s)·T)/√(1+r′²) — unit, no per-dot sqrt
        const inl = 1 / Math.sqrt(1 + g * g);
        const gtx = g * inl * Tt[oi];
        const gty = g * inl * Tt[oi + 1];
        const gtz = g * inl * Tt[oi + 2];
        const row = i * tentDotsPerRing;
        for (let j = 0; j < tentDotsPerRing; j++, d++) {
          const c = tc[row + j];
          const sn = ts[row + j];
          const dx = c * nx + sn * bx;
          const dy = c * ny + sn * by;
          const dz = c * nz + sn * bz;
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
    for (let i = 0; i < bellRings; i++) {
      const q = qB[i];
      const sz = 0.95 - 0.25 * q; // apex dots read slightly heavier
      for (let j = 0; j < bellDots; j++, d++) {
        const sl = perm[d];
        aSize[sl] = sz * sizeJit[d];
        aTw[sl] = twPhase[d];
        aRing[sl] = 0.4 * q; // formation fraction: bell 0→0.4, tentacles 0.4→1
      }
    }
    for (let k = 0; k < T; k++) {
      for (let i = 0; i < tentStations; i++) {
        const u = i / (tentStations - 1);
        const sz = 0.7 * (1 - 0.45 * u); // strands thin out toward the tip
        for (let j = 0; j < tentDotsPerRing; j++, d++) {
          const sl = perm[d];
          aSize[sl] = sz * sizeJit[d];
          aTw[sl] = twPhase[d];
          aRing[sl] = 0.4 + 0.6 * u;
        }
      }
    }
  }

  return { count, ringCount: bellRings + tentStations, init, updateTargets };
}

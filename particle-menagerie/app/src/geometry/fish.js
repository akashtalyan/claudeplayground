// Fish — fusiform tube body + sheet fins. Pure math, no three.js (node-benchable).
// Contract: geometry-spec.md. LOCAL space (§10). Body: elliptical ring offsets
// with taper tilt (tube row of the normals table). Fins (dorsal, pectorals,
// caudal): SHEET patches — normals are analytic ∂P/∂u × ∂P/∂v, normalized
// (the M4 trap: never in-plane offsets). Zero allocation in updateTargets (§4).
//
// Motion character (ported from v2 ARCH.finned): carangiform tail beat — a
// sub-wavelength lateral wave whose amplitude grows toward the tail while the
// head stays steady; a forked caudal fan that lags the beat; pectorals that
// flap-and-feather on a slower cycle; plus (new for 3D) a slow two-sine
// heading wander the fish banks into.

import { mulberry32, hashName } from './rng.js';
import { createSpine, makeRingTables, KAPPA_R_MAX, RING_SHRINK, TAU } from './spine.js';

// incommensurate secondary-wave ratio (spec §1 spirit — the motion never repeats)
const W_RATIO = Math.SQRT2 * 1.618033988749895 * 0.5;

// ---- named-species morph presets -----------------------------------------
// Axes (all multipliers on the seed-drawn base, 1 = neutral):
//   elong    body elongation (length vs girth)
//   depth    body depth ratio (vertical half-height; also flattens width)
//   fork     caudal shape: <0 rounded, 0 truncate, 1 forked, >1 lunate
//   dorsal   dorsal fin height
//   dorsalLen dorsal sail spread along the base (<1 concentrated/triangular)
//   pect     pectoral fin size (span + chord)
//   snout    snout profile (<1 blunt, >1 pointed; >2 = bill/rostrum)
//   tailLen  caudal fin length (+ flex "flow")
//   scale    world-scale hint — consumed by lexicon.js only, ignored here
//   tempo/speed  same: beat + roam hints for lexicon.js, ignored here
// Preset-only axes (no seed draw — like dorsalLen/tailLen, they default to a
// neutral value so every seed-morphed fish is bit-identical to v3.2):
//   flukeH    0..1 tail PLANE: 0 = vertical fish caudal (identity), 1 = fully
//             horizontal cetacean fluke. Rotates the caudal sheet about the
//             body axis at the tail station (the frame rotates, so the sheet's
//             analytic ∂P/∂u × ∂P/∂v rotates with it — see updateTargets).
//   undulateH 0..1 undulation PLANE: 0 = side-to-side carangiform beat
//             (identity), 1 = up-and-down mammalian body undulation (the
//             primary wave swaps into the vertical, the small secondary flex
//             into the lateral). The heading-turn bend stays horizontal at
//             both ends — a whale still turns left and right, not up and down.
//   tailSpan  caudal half-span multiplier (wide whale fluke vs narrow lunate)
//   snoutPow  taper sharpness multiplier, decoupled from snout LENGTH — a
//             narwhal tusk is longer AND far thinner than a marlin bill, a
//             whale head is short AND blunt; snout alone couples the two
//   width     lateral fatness multiplier: fish are laterally compressed
//             (WF 0.45), cetaceans are near-round in section (WF ≈ 0.8)
// Exported for lexicon.js (resolve/params path). makeFish also resolves a
// preset directly from its seed (hashName of the bare species name) so the
// board path — which passes only the seed — gets species shapes for free.
export const FISH_MORPHS = {
  shark: { elong: 1.24, depth: 0.82, fork: 1.15, dorsal: 1.75, dorsalLen: 0.72, pect: 1.25, snout: 1.15, tailLen: 1.0, scale: 1.35 },
  tuna: { elong: 1.12, depth: 1.0, fork: 1.35, dorsal: 0.85, dorsalLen: 0.9, pect: 0.85, snout: 1.05, tailLen: 0.9, scale: 1.12 },
  angelfish: { elong: 0.7, depth: 1.5, fork: -0.35, dorsal: 1.85, dorsalLen: 1.25, pect: 0.75, snout: 0.75, tailLen: 0.6, scale: 0.85 },
  clownfish: { elong: 0.84, depth: 1.15, fork: -0.5, dorsal: 0.8, dorsalLen: 1.0, pect: 1.3, snout: 0.7, tailLen: 0.85, scale: 0.6 },
  marlin: { elong: 1.3, depth: 0.8, fork: 1.3, dorsal: 1.7, dorsalLen: 0.95, pect: 0.8, snout: 2.7, tailLen: 0.95, scale: 1.3 },
  swordfish: { elong: 1.32, depth: 0.78, fork: 1.3, dorsal: 1.3, dorsalLen: 0.8, pect: 0.8, snout: 2.9, tailLen: 0.95, scale: 1.3 },
  goldfish: { elong: 0.8, depth: 1.25, fork: 0.55, dorsal: 0.9, dorsalLen: 1.0, pect: 1.1, snout: 0.7, tailLen: 1.55, scale: 0.8 },
  minnow: { elong: 1.0, depth: 0.8, fork: 0.35, dorsal: 0.7, dorsalLen: 0.9, pect: 0.8, snout: 0.9, tailLen: 0.85, scale: 0.45 },
  // ---- cetaceans (v3.3): horizontal fluke + vertical undulation. Before
  // this they all fell through to the generic fish archetype (morph null,
  // scale 1) and differed only by seed jitter — "why do dolphin and whale
  // look the same?". Every one is round in section, blunter than a fish, and
  // beats up-and-down; the silhouette differences below carry the species.
  whale: {
    elong: 2.05, depth: 1.15, fork: 1.15, dorsal: 0.3, dorsalLen: 0.85,
    pect: 0.95, snout: 0.5, tailLen: 0.8,
    flukeH: 1, undulateH: 1, tailSpan: 1.45, snoutPow: 0.55, width: 1.85,
    scale: 2.35, tempo: 0.55, speed: 0.6,
  },
  dolphin: {
    elong: 1.55, depth: 0.95, fork: 1.7, dorsal: 1.55, dorsalLen: 0.6,
    pect: 1.0, snout: 1.9, tailLen: 0.85,
    flukeH: 1, undulateH: 1, tailSpan: 0.9, snoutPow: 0.85, width: 1.6,
    scale: 1.2, tempo: 1.1, speed: 1.15,
  },
  orca: {
    elong: 1.5, depth: 1.0, fork: 1.15, dorsal: 2.9, dorsalLen: 0.5,
    pect: 1.7, snout: 0.5, tailLen: 0.85,
    flukeH: 1, undulateH: 1, tailSpan: 1.3, snoutPow: 0.8, width: 1.75,
    scale: 1.8, tempo: 0.85, speed: 1.0,
  },
  narwhal: {
    elong: 1.6, depth: 0.95, fork: 1.35, dorsal: 0.12, dorsalLen: 1.45,
    pect: 0.85, snout: 3.0, tailLen: 0.85,
    flukeH: 1, undulateH: 1, tailSpan: 1.05, snoutPow: 1.8, width: 1.6,
    scale: 1.15, tempo: 0.9, speed: 0.95,
  },
  humpback: {
    elong: 1.8, depth: 1.2, fork: 1.2, dorsal: 0.5, dorsalLen: 0.8,
    pect: 2.6, snout: 0.45, tailLen: 0.85,
    flukeH: 1, undulateH: 1, tailSpan: 1.4, snoutPow: 0.6, width: 1.8,
    scale: 2.1, tempo: 0.6, speed: 0.65,
  },
  beluga: {
    elong: 1.45, depth: 1.05, fork: 1.05, dorsal: 0.1, dorsalLen: 1.5,
    pect: 1.0, snout: 0.42, tailLen: 0.85,
    flukeH: 1, undulateH: 1, tailSpan: 1.1, snoutPow: 0.5, width: 1.75,
    scale: 1.25, tempo: 0.8, speed: 0.8,
  },
  porpoise: {
    elong: 1.3, depth: 1.0, fork: 1.25, dorsal: 1.0, dorsalLen: 0.9,
    pect: 0.85, snout: 0.6, tailLen: 0.8,
    flukeH: 1, undulateH: 1, tailSpan: 0.95, snoutPow: 0.7, width: 1.55,
    scale: 0.85, tempo: 1.15, speed: 1.2,
  },
};

// seed → preset (the clean name of a bare species IS its seed via hashName;
// plural too, since resolveName keeps the typed word in the clean name)
const MORPH_BY_SEED = new Map();
for (const k of Object.keys(FISH_MORPHS)) {
  MORPH_BY_SEED.set(hashName(k), FISH_MORPHS[k]);
  MORPH_BY_SEED.set(hashName(k + 's'), FISH_MORPHS[k]);
}

export function makeFish(seed, opts = {}) {
  // v3.2 density uplift, per part (fish was the LEAST dense archetype and it
  // carries 8 named species, so it gets the biggest lift):
  //   body   36×18 = 648 → 52×26 = 1352   (rib pitch 3.0/51 ≈ 0.059 vs
  //          circumferential ≈ 0.085 at the thickest station — ribs stay the
  //          dominant read, which is what makes a fish body legible)
  //   dorsal 12×5  =  60 → 18×8  =  144   pectorals 2×8×6 = 96 → 2×12×9 = 216
  //   caudal  9×8  =  72 → 14×12 =  168   (fork edge gets real resolution)
  // 876 → 1880 (~2.15×). Fins scale slightly harder than the body because at
  // 5-8 rows they were the parts that read as loose dot scatter, not sheets.
  const ringCount = opts.ringCount ?? 52;
  const dotsPerRing = opts.dotsPerRing ?? 26;
  const bodyCount = ringCount * dotsPerRing;
  // fin grids (sheet patches)
  const nDu = opts.dorsalSpan ?? 18; //   dorsal: stations along the back
  const nDv = opts.dorsalRows ?? 8; //            rows up the sail
  const nPu = opts.pectoralSpan ?? 12; // pectoral: stations along the span
  const nPv = opts.pectoralRows ?? 9; //           rows across the chord
  const nCu = opts.caudalRays ?? 14; //   caudal: rays across the fork (v-dir)
  const nCv = opts.caudalRows ?? 12; //           rows back from the peduncle
  const dorsalCount = nDu * nDv;
  const pectCount = 2 * nPu * nPv;
  const caudCount = nCu * nCv;
  const count = bodyCount + dorsalCount + pectCount + caudCount; // 1880 default
  // NOTE: count is identical for every morph — morphs change dimensions, not
  // dot counts, so the RNG draw structure below stays fixed (spec §8).
  const bodyLen0 = opts.bodyLength ?? 3.0;
  const baseRadius0 = opts.radius ?? 0.46; // vertical half-height (deep body)
  // Arc samples stay at v3.1's 200 (spec §6). Verified shape-neutral at the new
  // 52 stations: vs a 600-sample build, 240 frames at sway 0/1/2.4, max
  // position delta is 0.005 = 0.25% of extent (worst case marlin) — the §5
  // curvature clamp does not get noisier, so the sampler keeps its v3.1 cost.
  const sampleCount = opts.sampleCount ?? 200;

  const rng = mulberry32(seed);
  // ---- FROZEN DRAW ORDER (spec §8) — append only, never insert ----
  const seedAngle = rng() * TAU; //                      draw 1: RMF seed frame
  const phase1 = rng() * TAU; //                         draw 2: tail-beat wave
  const phase2 = rng() * TAU; //                         draw 3: shimmer wave
  const phase3 = rng() * TAU; //                         draw 4: vertical flex
  const turnPhase1 = rng() * TAU; //                     draw 5: heading wander
  const turnPhase2 = rng() * TAU; //                     draw 6
  const twistPerRing = (rng() * 2 - 1) * 0.05; //        draw 7: faint rib spiral
  const flapPhase = rng() * TAU; //                      draw 8: pectoral cycle
  const dorsalLag = 0.7 + 0.5 * rng(); //                draw 9: dorsal phase lag
  const tailLag = 0.4 + 0.5 * rng(); //                  draw 10: caudal phase lag
  const sizeJit = new Float32Array(count); //            draws 11 .. 10+count
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
  // Morphology axes — APPENDED after all prior draws (spec §8). Drawn
  // unconditionally with fixed counts; a named-species preset may override
  // the VALUES but never skips a draw.
  const elongJ = 0.88 + 0.34 * rng(); //                  draw: body elongation
  const depthJ = 0.8 + 0.5 * rng(); //                    draw: body depth ratio
  const forkJ = -0.5 + 1.6 * rng(); //                    draw: caudal fork/round
  const dorsJ = 0.7 + 0.9 * rng(); //                     draw: dorsal height
  const pectJ = 0.75 + 0.7 * rng(); //                    draw: pectoral size
  const snoutJ = 0.7 + 0.8 * rng(); //                    draw: snout profile
  // ---- end frozen draw order ----

  // preset resolution: explicit opts.morph wins; else the seed itself may BE
  // a named species (board path passes only the seed); else pure seed morphs
  const preset = opts.morph ?? MORPH_BY_SEED.get(seed >>> 0) ?? null;
  const M = {
    elong: preset?.elong ?? elongJ,
    depth: preset?.depth ?? depthJ,
    fork: preset?.fork ?? forkJ,
    dorsal: preset?.dorsal ?? dorsJ,
    dorsalLen: preset?.dorsalLen ?? 1,
    pect: preset?.pect ?? pectJ,
    snout: preset?.snout ?? snoutJ,
    tailLen: preset?.tailLen ?? 1,
    // preset-only axes; the neutral defaults reproduce v3.2 exactly
    flukeH: preset?.flukeH ?? 0,
    undulateH: preset?.undulateH ?? 0,
    tailSpan: preset?.tailSpan ?? 1,
    snoutPow: preset?.snoutPow ?? 1,
    width: preset?.width ?? 1,
  };
  // morphed dimensions; elongation trades girth for length. The uniform norm
  // shrink keeps nose→caudal-tip inside the registry bounding sphere
  // (boundR 2.6, spec §10) without distorting the morph's proportions.
  let bodyLen = bodyLen0 * M.elong;
  let baseRadius = (baseRadius0 * M.depth) / Math.pow(M.elong, 0.6);
  const norm = Math.min(1, 2.28 / (bodyLen * (0.5 + 0.252 * M.tailLen)));
  bodyLen *= norm;
  baseRadius *= norm;
  // lateral compression: deep-bodied morphs get proportionally flatter.
  // width lifts it back toward round (1) for cetaceans — a whale is a tube,
  // not a slab. width 1 = the v3.2 value exactly.
  const WF = (0.45 / Math.sqrt(Math.max(M.depth, 1))) * M.width;
  // ---- plane rotations (the cetacean axes). Both are rigid rotations about
  // the body axis, so nothing below needs a special case: the caudal sheet is
  // built in a rotated {Vc,Hc} frame (Hc = T×Vc keeps the handedness, so the
  // analytic Pu×Pv still points out of the same face), and the spine wave is
  // rotated in the (flex, beat) plane before the RMF ever sees it.
  const FA = M.flukeH * (Math.PI / 2); //   caudal plane: 0 vertical → π/2 flat
  const FCA = Math.cos(FA);
  const FSA = Math.sin(FA);
  const UB = M.undulateH * (Math.PI / 2); // undulation plane, same convention
  const UCB = Math.cos(UB);
  const USB = Math.sin(UB);

  const spine = createSpine(ringCount, sampleCount);
  const { cosT, sinT } = makeRingTables(ringCount, dotsPerRing, twistPerRing);

  // Elliptical-ring outward normal directions (unit, baked): the normal of the
  // ellipse point (ry·cosθ, rz·sinθ) is ∝ (cosθ/ry, sinθ/rz); with rz=WF·ry
  // the direction depends only on θ — one table shared by all stations.
  const ncT = new Float32Array(bodyCount);
  const nsT = new Float32Array(bodyCount);
  for (let d = 0; d < bodyCount; d++) {
    const c = cosT[d];
    const s = sinT[d] / WF;
    const il = 1 / Math.sqrt(c * c + s * s);
    ncT[d] = c * il;
    nsT[d] = s * il;
  }

  // fusiform profile (ported from v2): pointed nose, thickest ~45%, tail → 0;
  // the snout morph multiplies in a head taper — blunt (snout<1) to a long
  // thin rostrum/bill (snout>2, marlin/swordfish)
  const hL = 0.115 * M.snout; // head-taper span, fraction of body
  const hPow = 0.55 * M.snout * M.snoutPow; // taper sharpness (see snoutPow)
  const prof = new Float32Array(ringCount);
  const rNom = new Float32Array(ringCount);
  for (let i = 0; i < ringCount; i++) {
    const f = i / (ringCount - 1);
    const base = Math.pow(Math.sin(Math.PI * Math.min(1, f * 1.04 + 0.02)), 0.8);
    const nose = 0.05 + 0.95 * Math.pow(Math.min(1, f / hL), hPow);
    prof[i] = base * nose;
    rNom[i] = baseRadius * prof[i];
  }
  const rEffY = new Float32Array(ringCount);
  const drds = new Float32Array(ringCount);
  const ds = bodyLen / (ringCount - 1);
  // per-station gravity-dressed frame: RMF (spec §2) is the transport basis;
  // V/H are a smooth in-plane rotation of it (vertical projection + bank roll)
  const Varr = new Float32Array(ringCount * 3);
  const Harr = new Float32Array(ringCount * 3);

  // ---- wave constants (carangiform: < 1 wavelength on body, tail-heavy env)
  const LSC = bodyLen / 3;
  const K1 = 4.0; // primary tail beat (v2: sin(s·4 − beat))
  const K2 = 7.3; // non-harmonic shimmer
  const K3 = 2.2; // slow vertical flex
  const A1 = 0.13 * LSC;
  const A2 = 0.045 * LSC;
  const A3 = 0.05 * LSC;
  const TURN_A = 0.42 * LSC; // whole-body bend into turns (·u²)
  let ca1 = 0;
  let ca2 = 0;
  let ca3 = 0;
  let cturn = 0;
  let cp1 = 0;
  let cp2 = 0;
  let cp3 = 0;
  // beat = the primary tail-beat wave, flex = the slow secondary flex. At
  // undulateH 0 beat lives in z (lateral) and flex in y (vertical) — the
  // literal v3.2 expressions. At undulateH 1 they swap: the beat drives the
  // body up and down (mammal), the flex becomes a faint lateral roll. The
  // turn bend is added AFTER the rotation so it stays horizontal always.
  const curve = (u, out, o) => {
    const env = 0.05 + 0.95 * Math.pow(u, 1.7); // head steady, tail swings
    const beat = env * (ca1 * Math.sin(K1 * u - cp1) + ca2 * Math.sin(K2 * u - cp2));
    const flex = ca3 * Math.sin(K3 * u - cp3) * (0.3 + 0.7 * u);
    out[o] = (u - 0.5) * bodyLen;
    out[o + 1] = UCB * flex + USB * beat;
    out[o + 2] = UCB * beat + cturn * u * u - USB * flex;
  };

  // ---- fin statics (morph-scaled)
  const HD = 0.09 * bodyLen * M.dorsal; // dorsal max height
  const SP = 0.14 * bodyLen * M.pect; //   pectoral span
  const CP = 0.1 * bodyLen * M.pect; //    pectoral chord
  const LC = 0.24 * bodyLen * M.tailLen; // caudal length
  const HC = 0.14 * bodyLen * (0.55 + 0.45 * M.tailLen) * M.tailSpan; // caudal half-span
  const FLOW = 0.7 + 0.3 * M.tailLen; //   long tails flex more ("flowy")
  const SWEEP_C = Math.cos(0.6); // pectoral sweep-back ~35°
  const SWEEP_S = Math.sin(0.6);
  // dorsal base maps 1:1 onto consecutive body stations starting at dor0
  const dor0 = Math.min(Math.round(0.3 * (ringCount - 1)), ringCount - 1 - nDu);
  // pectoral attach: behind the rostrum on long-snouted morphs
  const iP = Math.round((0.18 + 0.08 * Math.max(M.snout - 1, 0)) * (ringCount - 1));
  const iT = ringCount - 1; //                      caudal attach station
  const hD = new Float32Array(nDu); // sail height profile (peak leans forward)
  const envD = new Float32Array(nDu); // flex envelope (rear flexes more)
  const phiD = new Float32Array(nDu); // K1·u_body at each dorsal station
  // dorsalLen spreads (>1) or concentrates (<1, triangular) the sail along
  // its base; at dorsalLen 1 this is exactly the legacy profile
  const DL = M.dorsalLen;
  for (let m = 0; m < nDu; m++) {
    const fu = m / (nDu - 1);
    hD[m] =
      HD * (0.1 + 0.15 * DL + 0.75 * Math.pow(Math.sin(Math.PI * Math.pow(fu, 0.75)), 1 / DL));
    envD[m] = 0.6 + 0.4 * fu;
    phiD[m] = (K1 * (dor0 + m)) / (ringCount - 1);
  }
  const dfuInv = nDu - 1; // 1/dfu
  const fvT = new Float32Array(nDv);
  for (let j = 0; j < nDv; j++) fvT[j] = (j + 1) / nDv;
  const pvOff = new Float32Array(nPv); // chord offset: mostly trailing
  for (let n = 0; n < nPv; n++) pvOff[n] = n / (nPv - 1) - 0.35;
  const cuV = new Float32Array(nCu); // caudal fork tables
  // length factor g(cu) = aC + bC·cu²: fork>0 → long at edges (forked/lunate,
  // fork 1 = legacy), fork 0 → truncate, fork<0 → rounded (middle longest).
  // Edge/middle max is always ≤ 1 so LC bounds the caudal extent.
  const gC = new Float32Array(nCu);
  const dgC = new Float32Array(nCu);
  const bC = 0.45 * M.fork;
  const aC = 1 - Math.max(bC, 0);
  for (let k = 0; k < nCu; k++) {
    const cu = -1 + (2 * k) / (nCu - 1);
    cuV[k] = cu;
    gC[k] = aC + bC * cu * cu;
    dgC[k] = 2 * bC * cu;
  }
  // dorsal per-frame scratch (preallocated — spec §4)
  const dorC = new Float32Array(nDu * 3);
  const dorDel = new Float32Array(nDu);

  function updateTargets(timeSec, sway, tempo, positions, normals) {
    const t = 2.6 * timeSec * tempo; // fish beat faster than eel (v2: 3× vs 2.1×)
    cp1 = phase1 + t;
    cp2 = phase2 + t * W_RATIO;
    cp3 = phase3 + t * 0.317;
    // slow non-repeating heading wander; the fish banks into it
    const tt = timeSec * (0.4 + 0.6 * tempo);
    const turn =
      0.588 * (Math.sin(0.37 * tt + turnPhase1) + 0.7 * Math.sin(0.1613 * tt + turnPhase2));
    ca1 = A1 * sway;
    ca2 = A2 * sway;
    ca3 = A3 * Math.min(sway, 1.2);
    cturn = TURN_A * turn;
    spine.update(curve, bodyLen, seedAngle);
    // sway clamp (spec §5): κ ~linear in amplitude, one correction pass
    const mk = spine.maxKappaR(rNom);
    if (mk > KAPPA_R_MAX) {
      const sc = KAPPA_R_MAX / mk;
      ca1 *= sc;
      ca2 *= sc;
      ca3 *= sc;
      cturn *= sc;
      spine.update(curve, bodyLen, seedAngle);
    }
    const relAmp = ca1 / A1; // post-clamp effective sway (drives fin vigor)
    const kap = spine.kappa;
    for (let i = 0; i < ringCount; i++) {
      let r = rNom[i];
      if (kap[i] * r > RING_SHRINK) r = RING_SHRINK / kap[i]; // local guard (§5)
      rEffY[i] = r;
    }
    for (let i = 0; i < ringCount; i++) {
      const ia = i > 0 ? i - 1 : 0;
      const ib = i < ringCount - 1 ? i + 1 : i;
      drds[i] = ib > ia ? (rEffY[ib] - rEffY[ia]) / ((ib - ia) * ds) : 0;
    }
    const P = spine.positions;
    const T = spine.tangents;
    const N = spine.normals;
    const B = spine.binormals;
    // ---- gravity-dressed frames V (up-in-plane, banked) / H = T×V.
    // Expressed in the RMF basis so the transport itself stays RMF (spec §2);
    // the fish spine never nears vertical, so the projection is well-posed
    // (guarded anyway). Bank rolls the whole cross-section into the turn.
    const bank = 0.35 * turn;
    const cb = Math.cos(bank);
    const sb = Math.sin(bank);
    for (let i = 0; i < ringCount; i++) {
      const oi = i * 3;
      const tx = T[oi];
      const ty = T[oi + 1];
      const tz = T[oi + 2];
      // v = up − (up·T)T, written in (N,B):  a = v·N, b = v·B
      const vx = -ty * tx;
      const vy = 1 - ty * ty;
      const vz = -ty * tz;
      let a = vx * N[oi] + vy * N[oi + 1] + vz * N[oi + 2];
      let b = vx * B[oi] + vy * B[oi + 1] + vz * B[oi + 2];
      const l2 = a * a + b * b;
      if (l2 > 1e-12) {
        const il = 1 / Math.sqrt(l2);
        a *= il;
        b *= il;
      } else {
        a = 1;
        b = 0;
      }
      const ar = a * cb - b * sb; // roll by bank around T
      const br = b * cb + a * sb;
      // V = ar·N + br·B ;  H = T×V = ar·B − br·N  (B = T×N, T×B = −N)
      Varr[oi] = ar * N[oi] + br * B[oi];
      Varr[oi + 1] = ar * N[oi + 1] + br * B[oi + 1];
      Varr[oi + 2] = ar * N[oi + 2] + br * B[oi + 2];
      Harr[oi] = ar * B[oi] - br * N[oi];
      Harr[oi + 1] = ar * B[oi + 1] - br * N[oi + 1];
      Harr[oi + 2] = ar * B[oi + 2] - br * N[oi + 2];
    }
    // ---- body: elliptical rings (deep, laterally compressed) + taper tilt
    let d = 0;
    for (let i = 0; i < ringCount; i++) {
      const oi = i * 3;
      const px = P[oi];
      const py = P[oi + 1];
      const pz = P[oi + 2];
      const vX = Varr[oi];
      const vY = Varr[oi + 1];
      const vZ = Varr[oi + 2];
      const hX = Harr[oi];
      const hY = Harr[oi + 1];
      const hZ = Harr[oi + 2];
      const ry = rEffY[i];
      const rz = WF * ry;
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
        const nc = ncT[row + j];
        const ns = nsT[row + j];
        const o = perm[d] * 3;
        positions[o] = px + ry * c * vX + rz * s * hX;
        positions[o + 1] = py + ry * c * vY + rz * s * hY;
        positions[o + 2] = pz + ry * c * vZ + rz * s * hZ;
        normals[o] = (nc * vX + ns * hX) * inl - gtx;
        normals[o + 1] = (nc * vY + ns * hY) * inl - gty;
        normals[o + 2] = (nc * vZ + ns * hZ) * inl - gtz;
      }
    }
    // ---- dorsal fin (sheet): P(fu,fv) = C(fu) + fv·h·V + fv²·δ·H
    // normal = ∂P/∂fu × ∂P/∂fv (analytic in fv, station-table diffs in fu)
    const dAmp = 0.02 + 0.08 * relAmp;
    for (let m = 0; m < nDu; m++) {
      const im = dor0 + m;
      const oi = im * 3;
      const rb = 0.92 * rEffY[im];
      dorC[m * 3] = P[oi] + rb * Varr[oi];
      dorC[m * 3 + 1] = P[oi + 1] + rb * Varr[oi + 1];
      dorC[m * 3 + 2] = P[oi + 2] + rb * Varr[oi + 2];
      dorDel[m] = dAmp * envD[m] * Math.sin(phiD[m] - cp1 - dorsalLag);
    }
    for (let m = 0; m < nDu; m++) {
      const ma = m > 0 ? m - 1 : 0;
      const mb = m < nDu - 1 ? m + 1 : m;
      const inv = dfuInv / (mb - ma);
      const om = (dor0 + m) * 3;
      const oa = (dor0 + ma) * 3;
      const ob = (dor0 + mb) * 3;
      const h = hD[m];
      const del = dorDel[m];
      const dh = (hD[mb] - hD[ma]) * inv;
      const dd = (dorDel[mb] - dorDel[ma]) * inv;
      // e0 = C′, e1 = h′V + hV′, e2 = δ′H + δH′  →  Pu = e0 + fv·e1 + fv²·e2
      const e0x = (dorC[mb * 3] - dorC[ma * 3]) * inv;
      const e0y = (dorC[mb * 3 + 1] - dorC[ma * 3 + 1]) * inv;
      const e0z = (dorC[mb * 3 + 2] - dorC[ma * 3 + 2]) * inv;
      const e1x = dh * Varr[om] + h * (Varr[ob] - Varr[oa]) * inv;
      const e1y = dh * Varr[om + 1] + h * (Varr[ob + 1] - Varr[oa + 1]) * inv;
      const e1z = dh * Varr[om + 2] + h * (Varr[ob + 2] - Varr[oa + 2]) * inv;
      const e2x = dd * Harr[om] + del * (Harr[ob] - Harr[oa]) * inv;
      const e2y = dd * Harr[om + 1] + del * (Harr[ob + 1] - Harr[oa + 1]) * inv;
      const e2z = dd * Harr[om + 2] + del * (Harr[ob + 2] - Harr[oa + 2]) * inv;
      const hvx = h * Varr[om];
      const hvy = h * Varr[om + 1];
      const hvz = h * Varr[om + 2];
      const dhx = del * Harr[om];
      const dhy = del * Harr[om + 1];
      const dhz = del * Harr[om + 2];
      for (let j = 0; j < nDv; j++, d++) {
        const fv = fvT[j];
        const fv2 = fv * fv;
        const o = perm[d] * 3;
        positions[o] = dorC[m * 3] + fv * hvx + fv2 * dhx;
        positions[o + 1] = dorC[m * 3 + 1] + fv * hvy + fv2 * dhy;
        positions[o + 2] = dorC[m * 3 + 2] + fv * hvz + fv2 * dhz;
        const pux = e0x + fv * e1x + fv2 * e2x;
        const puy = e0y + fv * e1y + fv2 * e2y;
        const puz = e0z + fv * e1z + fv2 * e2z;
        const pvx = hvx + 2 * fv * dhx;
        const pvy = hvy + 2 * fv * dhy;
        const pvz = hvz + 2 * fv * dhz;
        let nx = puy * pvz - puz * pvy;
        let ny = puz * pvx - pux * pvz;
        let nz = pux * pvy - puy * pvx;
        const il = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        normals[o] = nx * il;
        normals[o + 1] = ny * il;
        normals[o + 2] = nz * il;
      }
    }
    // ---- pectoral fins (sheets, both sides): swept-back quads that flap and
    // feather; ∂P/∂pv ∥ T so the analytic normal is per-span-station
    const oP = iP * 3;
    const rzP = WF * rEffY[iP];
    const dropP = 0.25 * rEffY[iP];
    const flapA = 0.25 + 0.3 * relAmp;
    for (let side = -1; side <= 1; side += 2) {
      const flapS = flapA * Math.sin(0.9 * t + flapPhase + side * 0.9);
      const bx = P[oP] + side * 0.9 * rzP * Harr[oP] - dropP * Varr[oP];
      const by = P[oP + 1] + side * 0.9 * rzP * Harr[oP + 1] - dropP * Varr[oP + 1];
      const bz = P[oP + 2] + side * 0.9 * rzP * Harr[oP + 2] - dropP * Varr[oP + 2];
      for (let m = 0; m < nPu; m++) {
        const fm = m / (nPu - 1);
        const phi = 0.35 + flapS * (0.35 + 0.65 * fm); // rest droop + feathered flap
        const dphi = flapS * 0.65;
        const cf = Math.cos(phi);
        const sf = Math.sin(phi);
        // e_out = side·cosφ·H − sinφ·V ;  d_span = cosΛ·e_out + sinΛ·T
        const eox = side * cf * Harr[oP] - sf * Varr[oP];
        const eoy = side * cf * Harr[oP + 1] - sf * Varr[oP + 1];
        const eoz = side * cf * Harr[oP + 2] - sf * Varr[oP + 2];
        const dsx = SWEEP_C * eox + SWEEP_S * T[oP];
        const dsy = SWEEP_C * eoy + SWEEP_S * T[oP + 1];
        const dsz = SWEEP_C * eoz + SWEEP_S * T[oP + 2];
        // ∂d_span/∂fm = cosΛ·φ′·(−side·sinφ·H − cosφ·V)
        const k = SWEEP_C * dphi;
        const tvx = dsx + fm * k * (-side * sf * Harr[oP] - cf * Varr[oP]);
        const tvy = dsy + fm * k * (-side * sf * Harr[oP + 1] - cf * Varr[oP + 1]);
        const tvz = dsz + fm * k * (-side * sf * Harr[oP + 2] - cf * Varr[oP + 2]);
        // normal = (∂P/∂pu × ∂P/∂pv)·side  (∂P/∂pv ∥ T) — same for all pv
        let nx = (tvy * T[oP + 2] - tvz * T[oP + 1]) * side;
        let ny = (tvz * T[oP] - tvx * T[oP + 2]) * side;
        let nz = (tvx * T[oP + 1] - tvy * T[oP]) * side;
        const il = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx *= il;
        ny *= il;
        nz *= il;
        const sx = bx + SP * fm * dsx;
        const sy = by + SP * fm * dsy;
        const sz = bz + SP * fm * dsz;
        const cm = CP * (1 - 0.55 * fm); // chord narrows to the tip
        for (let n = 0; n < nPv; n++, d++) {
          const pc = pvOff[n] * cm;
          const o = perm[d] * 3;
          positions[o] = sx + pc * T[oP];
          positions[o + 1] = sy + pc * T[oP + 1];
          positions[o + 2] = sz + pc * T[oP + 2];
          normals[o] = nx;
          normals[o + 1] = ny;
          normals[o + 2] = nz;
        }
      }
    }
    // ---- caudal fin (sheet): forked fan continuing the body wave with lag;
    // rows twist progressively (tip lags peduncle) — the whip of the tail beat
    const oT = iT * 3;
    const psiA = (0.08 + 0.45 * relAmp) * FLOW;
    const tailArg = K1 - cp1 - tailLag;
    // The fluke plane: {V,H} at the tail station rotated by −FA about T.
    //   Vc = cosα·V − sinα·H          (the sheet's span direction)
    //   Hc = cosα·H + sinα·V = T×Vc   (the whip direction — checks out:
    //     T×Vc = cosα(T×V) − sinα(T×H) = cosα·H + sinα·V, since T×V = H and
    //     T×H = −V). Handedness is preserved, so Pv×Pu below still faces the
    //     same way, and because the rotation is rigid and constant in (u,v)
    //     the derivatives rotate with the surface — substituting Vc/Hc into
    //     the SAME analytic Pu, Pv is exactly R·(Pu₀), R·(Pv₀), and
    //     R(Pu₀)×R(Pv₀) = R(Pu₀×Pv₀) for a rotation. Still a true
    //     ∂P/∂u × ∂P/∂v, never an in-plane offset (the M4 trap).
    //   The −α sign puts the whip on +V at flukeH 1, matching the +V body
    //   beat that undulateH 1 produces, so fluke and body stay in phase.
    // At flukeH 0 this is Vc = V, Hc = H — the v3.2 caudal fin untouched.
    const vcX = FCA * Varr[oT] - FSA * Harr[oT];
    const vcY = FCA * Varr[oT + 1] - FSA * Harr[oT + 1];
    const vcZ = FCA * Varr[oT + 2] - FSA * Harr[oT + 2];
    const hcX = FCA * Harr[oT] + FSA * Varr[oT];
    const hcY = FCA * Harr[oT + 1] + FSA * Varr[oT + 1];
    const hcZ = FCA * Harr[oT + 2] + FSA * Varr[oT + 2];
    for (let n = 0; n < nCv; n++) {
      const cv = (n + 1) / nCv;
      const psi = psiA * Math.sin(tailArg - 1.1 * cv);
      const dpsi = -1.1 * psiA * Math.cos(tailArg - 1.1 * cv);
      const cps = Math.cos(psi);
      const sps = Math.sin(psi);
      // e_back = cosψ·T + sinψ·Hc ; e_back′ = ψ′·(−sinψ·T + cosψ·Hc)
      const ebx = cps * T[oT] + sps * hcX;
      const eby = cps * T[oT + 1] + sps * hcY;
      const ebz = cps * T[oT + 2] + sps * hcZ;
      const dbx = dpsi * (-sps * T[oT] + cps * hcX);
      const dby = dpsi * (-sps * T[oT + 1] + cps * hcY);
      const dbz = dpsi * (-sps * T[oT + 2] + cps * hcZ);
      const hgt = 0.3 + 0.7 * cv;
      // Pv (per row, cu-independent part): L·(e_back + cv·e_back′)
      const pvbx = LC * (ebx + cv * dbx);
      const pvby = LC * (eby + cv * dby);
      const pvbz = LC * (ebz + cv * dbz);
      for (let k = 0; k < nCu; k++, d++) {
        const cu = cuV[k];
        const g = gC[k];
        const dg = dgC[k];
        // P = Ptail + L·g(cu)·cv·e_back + HC·cu·hgt(cv)·Vc
        const o = perm[d] * 3;
        positions[o] = P[oT] + LC * g * cv * ebx + HC * cu * hgt * vcX;
        positions[o + 1] = P[oT + 1] + LC * g * cv * eby + HC * cu * hgt * vcY;
        positions[o + 2] = P[oT + 2] + LC * g * cv * ebz + HC * cu * hgt * vcZ;
        const pvx = g * pvbx + HC * 0.7 * cu * vcX;
        const pvy = g * pvby + HC * 0.7 * cu * vcY;
        const pvz = g * pvbz + HC * 0.7 * cu * vcZ;
        const pux = LC * dg * cv * ebx + HC * hgt * vcX;
        const puy = LC * dg * cv * eby + HC * hgt * vcY;
        const puz = LC * dg * cv * ebz + HC * hgt * vcZ;
        let nx = pvy * puz - pvz * puy;
        let ny = pvz * pux - pvx * puz;
        let nz = pvx * puy - pvy * pux;
        const il = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        normals[o] = nx * il;
        normals[o + 1] = ny * il;
        normals[o + 2] = nz * il;
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
    for (let m = 0; m < nDu; m++) {
      const rf = (dor0 + m) / (ringCount - 1);
      for (let j = 0; j < nDv; j++, d++) {
        const sl = perm[d];
        aSize[sl] = 0.6 * (1 - 0.35 * fvT[j]) * sizeJit[d];
        aTw[sl] = twPhase[d];
        aRing[sl] = rf;
      }
    }
    const rfP = iP / (ringCount - 1);
    for (let side = 0; side < 2; side++) {
      for (let m = 0; m < nPu; m++) {
        const fm = m / (nPu - 1);
        for (let n = 0; n < nPv; n++, d++) {
          const sl = perm[d];
          aSize[sl] = 0.55 * (1 - 0.3 * fm) * sizeJit[d];
          aTw[sl] = twPhase[d];
          aRing[sl] = rfP;
        }
      }
    }
    for (let n = 0; n < nCv; n++) {
      const cv = (n + 1) / nCv;
      for (let k = 0; k < nCu; k++, d++) {
        const sl = perm[d];
        aSize[sl] = (0.58 - 0.22 * cv) * sizeJit[d];
        aTw[sl] = twPhase[d];
        aRing[sl] = 0.92 + 0.08 * cv; // caudal rows continue past the body tip
      }
    }
  }

  return { count, ringCount, init, updateTargets };
}

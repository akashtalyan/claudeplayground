// Click-to-gather — v3.2 scene event. Supersedes the Phase E feeding mote
// (src/feeding.js is now a thin back-compat shim over this module; there is
// exactly ONE implementation and exactly ONE canvas click listener).
//
// A click on empty water (creature clicks are filtered through the hit-test
// callback supplied by main.js — controls.js owns the one hit-test, never
// duplicated here) plants a glowing amber BEACON at that world point: a
// summons, not bait. Every swimmer and drifter on the board heads for it
// regardless of distance, overriding whatever behavior it was in; rooted
// plants cannot swim, so they LEAN toward it instead, with lean strength
// falling off with distance. The beacon lives ~11.9 s (0.4 rise + 9.5 hold +
// 2.0 retire) and then everyone eases back to what they were doing. Clicking
// elsewhere moves the beacon and re-gathers (a new "epoch").
//
// Individuality, not a magnet: every creature gets its own reaction delay,
// approach speed, steering rate, curved (banana) approach, orbit phase/rate,
// vertical offset and — crucially — its own soft MINIMUM RADIUS, so the crowd
// mills and orbits around the point instead of stacking into one blown-out
// blob. All of it is derived from the per-creature phases the creature already
// drew at construction (c.d0/d1/d2) plus the epoch counter: no new RNG draws,
// so the frozen draw order (geometry-spec §8) is untouched.
//
// Promises kept from feeding.js:
//   * SLEEPERS NEVER WAKE — the steering hook refuses any creature whose
//     ctrl.behavior === 'sleep' (rooted or not), so it falls through to
//     exactly today's code path.
//   * c.ctrl.behavior is NEVER mutated. Prior behavior therefore resumes by
//     construction the moment the hook stops driving; nothing to restore.
//   * The little dot-burst delight when a creature actually reaches the point.
//
// Rendering reuses the ONE dot shader program (frame-graph rule 7) via
// createDotMaterial, so beacon, ping ring and arrival burst all live in the
// same additive -> trails -> bloom -> tonemap chain as every creature. uSmall
// stays 0 (no merge correction, exactly as the old mote). No tonemap, no sRGB
// encode here (rule 2). All time comes from the injectable clock via
// update(timeSec, dt) / steer(t, dt) — no wall-time reads (rule 11). Nothing
// allocates per frame, and the beacon is SESSION-ONLY: it never touches the
// URL hash, so board determinism is unaffected.
//
// Visual language is the Bathyscaphe design language, unchanged: phosphor
// amber (#ffc37a family), a 400 ms rise-through-water ignition, and the port
// light's 2.6 s expanding ping ring — the beacon is the console's lamp put
// into the water.

import * as THREE from 'three';
import { mulberry32 } from './geometry/rng.js';
import { createDotMaterial } from './shaders/dots.js';

const REF_DIST = 10; // must match REF_DIST in shaders/dots.js
const BEACON_Z = -60; // the pleasant band just behind the z=0 plane
const TAU = Math.PI * 2;

// ---- beacon life (seconds) -------------------------------------------------
const RISE_S = 0.4; // design language: 400 ms rise-through-water
const HOLD_S = 9.5; // the gather proper
const RETIRE_S = 2.0; // dissolve + everyone eases back (total life ~11.9 s)
const PING_S = 2.6; // design language: the port light's ping cycle

// ---- beacon look -----------------------------------------------------------
const N_CORE = 30; // 1 hot core + a 12-dot gauge ring + a 17-dot shell
const N_PING = 24; // dots on the expanding ping ring
const N_BURST = 22; // arrival burst
const CORE_R = 16; // world px, core cluster radius (the old mote was 8)
const RING_R = 0.85; // gauge ring radius as a fraction of CORE_R
const PING_R0 = 15; // world px, ping ring start radius
const PING_R1 = 138; // world px, ping ring end radius
const ALPHA0 = 2.2; // resting beacon brightness (the old mote was 1.5)
const PING_A = 0.85;
const BURST_A = 2.0;
const BURST_R = 46; // world px, arrival burst final radius
const BURST_S = 0.8;
const BOB = 3; // world px: the beacon holds station, it does not sink

// ---- gather steering -------------------------------------------------------
const PULL_IN = 2.6; // 1/s ease into the gather
const PULL_OUT = 2.2; // 1/s ease back to the previous behavior
const PULL_EPS = 0.03; // below this the hook hands the creature back
const REACT_S = 0.85; // max per-creature reaction delay (the stagger)
const RACE = 1.85; // speed boost at full pull, before per-creature eagerness
const DRIFT_SPD = 46; // px/s approach speed for drifters (registry speed is 0)
// Urgency: distance-scaled eagerness so a creature on the far side of the
// board still arrives inside the beacon's life, while one already close keeps
// its calm cruising speed. Decays as it closes, so the profile reads as a
// sprint that settles rather than a constant tow.
const URG_LO = 0.7;
const URG_D = 430; // world px per +1.0 of urgency
const URG_MAX = 2.6;
const MILL_K = 0.55; // min radius grows with the creature's own radius
const MILL_BASE = 24; // + up to 90 px of per-creature jitter
const ARRIVE_PAD = 18; // world px slack on the arrival test
const MAX_TURN = 2.2; // rad/s steering cap (no snap turns while milling)
const BANK_MAX = 0.55; // rad roll cap on the lunge
const LEAN_MAX = 0.38; // rad: how far a rooted plant bends at zero distance
const LEAN_R = 620; // world px: half-strength lean distance

const frac = (v) => v - Math.floor(v);

/**
 * @param {object} deps
 * @param {THREE.Scene} deps.scene
 * @param {HTMLCanvasElement} deps.canvas
 * @param {object} deps.state - integrator state (W, H read-only here)
 * @param {() => number} deps.getCamDist
 * @param {() => number} [deps.getCamY] - v3.4: the porthole's world height, so
 *        a screen click maps into the water column the user is actually
 *        looking at. Defaults to 0 (the v3.3 stationary camera).
 * @param {object} deps.globalUniforms - shared uniform set (shaders/dots.js)
 * @param {(x:number, y:number) => any} deps.hitTest - controls.hitTest;
 *        truthy = the click landed on a creature (select, not summon)
 * @param {[number, number]} [deps.zRange] - water depth band, default main.js's
 * @param {number} [deps.z] - beacon plane, default BEACON_Z
 * @param {number} [deps.hold] - hold seconds (the ~8-12 s life knob)
 */
export function initGather({
  scene,
  canvas,
  state,
  getCamDist,
  getCamY,
  globalUniforms,
  hitTest,
  zRange = [-340, 40],
  z = BEACON_Z,
  hold = HOLD_S,
}) {
  const Z_MIN = zRange[0];
  const Z_MAX = zRange[1];
  const beaconZ = z;

  // ---- three static seeded dot clouds, built once -------------------------
  // Own RNG stream (fixed seed): never shares or reorders any creature's draws.
  const rng = mulberry32(0xbea6c04e);

  function makeCloud(n, fill) {
    const pos = new Float32Array(n * 3);
    const nor = new Float32Array(n * 3);
    const base = new Float32Array(n); // authored CSS-px size, pre depth scale
    const aTw = new Float32Array(n);
    const aRing = new Float32Array(n);
    fill(pos, nor, base, aTw, aRing);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    const aSize = new THREE.BufferAttribute(new Float32Array(n), 1);
    g.setAttribute('aSize', aSize);
    g.setAttribute('aTw', new THREE.BufferAttribute(aTw, 1));
    g.setAttribute('aRing', new THREE.BufferAttribute(aRing, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);
    const material = createDotMaterial(globalUniforms);
    // Phosphor amber. Linear-HDR out: the mid dots encode near --amber-bright
    // (#ffd9a8) and the hot core blows to warm white — the port light, drowned.
    material.uniforms.uColor.value.setRGB(1.0, 0.72, 0.4);
    material.uniforms.uAlpha.value = 0;
    material.uniforms.uFormation.value = 1;
    material.uniforms.uTwk.value.set(1.4, 0.22); // slow, deliberate — an instrument
    const points = new THREE.Points(g, material);
    points.frustumCulled = false;
    points.visible = false;
    scene.add(points);
    return { geometry: g, material, points, base, aSize };
  }

  // 1. the beacon core: hot center, a quantized 12-dot gauge ring in the
  //    xy plane (deliberate, console-like), then a soft shell.
  const core = makeCloud(N_CORE, (pos, nor, base, aTw, aRing) => {
    for (let i = 0; i < N_CORE; i++) {
      let dx;
      let dy;
      let dz;
      let r;
      if (i === 0) {
        dx = 0;
        dy = 1;
        dz = 0;
        r = 0;
        base[i] = 6.6;
      } else if (i <= 12) {
        const a = ((i - 1) / 12) * TAU;
        dx = Math.cos(a);
        dy = Math.sin(a);
        dz = 0;
        r = CORE_R * RING_R;
        base[i] = 2.4;
      } else {
        dx = rng() * 2 - 1;
        dy = rng() * 2 - 1;
        dz = rng() * 2 - 1;
        const il = 1 / Math.max(Math.hypot(dx, dy, dz), 1e-4);
        dx *= il;
        dy *= il;
        dz *= il;
        r = CORE_R * Math.pow(rng(), 0.55);
        base[i] = 1.8 + 1.6 * rng();
      }
      pos[i * 3] = dx * r;
      pos[i * 3 + 1] = dy * r;
      pos[i * 3 + 2] = dz * r;
      // outward normals: the cluster shades as a tiny glowing lamp
      nor[i * 3] = dx;
      nor[i * 3 + 1] = dy;
      nor[i * 3 + 2] = dz;
      aTw[i] = rng();
      aRing[i] = rng();
    }
  });

  // 2. the ping ring: unit circle in xy, scaled outward each cycle. Dot pixel
  //    size is independent of points.scale, so it expands as a 1-dot-thick
  //    ring exactly like the design's port-light ping.
  const ping = makeCloud(N_PING, (pos, nor, base, aTw, aRing) => {
    for (let i = 0; i < N_PING; i++) {
      const a = (i / N_PING) * TAU;
      pos[i * 3] = Math.cos(a);
      pos[i * 3 + 1] = Math.sin(a);
      pos[i * 3 + 2] = 0;
      nor[i * 3] = Math.cos(a);
      nor[i * 3 + 1] = Math.sin(a);
      nor[i * 3 + 2] = 0;
      base[i] = 2.0;
      aTw[i] = rng();
      aRing[i] = rng();
    }
  });

  // 3. the arrival burst: unit sphere, scaled out and faded (the consumption
  //    delight from feeding, now fired when a creature reaches the summons).
  const burst = makeCloud(N_BURST, (pos, nor, base, aTw, aRing) => {
    for (let i = 0; i < N_BURST; i++) {
      let dx = rng() * 2 - 1;
      let dy = rng() * 2 - 1;
      let dz = rng() * 2 - 1;
      const il = 1 / Math.max(Math.hypot(dx, dy, dz), 1e-4);
      dx *= il;
      dy *= il;
      dz *= il;
      const r = 0.45 + 0.55 * rng();
      pos[i * 3] = dx * r;
      pos[i * 3 + 1] = dy * r;
      pos[i * 3 + 2] = dz * r;
      nor[i * 3] = dx;
      nor[i * 3 + 1] = dy;
      nor[i * 3 + 2] = dz;
      base[i] = 1.9 + 1.5 * rng();
      aTw[i] = rng();
      aRing[i] = rng();
    }
  });

  // Dot sizes are authored in CSS px at the beacon plane; the shader renders
  // px = aSize * REF_DIST / viewDist, so bake the depth scale in. Refreshed
  // only when camDist actually changes (boot, resize) — never per frame.
  let sizeKey = -1;
  function refreshSizes() {
    const key = getCamDist() - bz;
    if (key === sizeKey) return;
    sizeKey = key;
    const s = key / REF_DIST;
    for (const c of [core, ping, burst]) {
      const a = c.aSize.array;
      for (let i = 0; i < a.length; i++) a[i] = c.base[i] * s;
      c.aSize.needsUpdate = true;
    }
  }

  // ---- beacon state -------------------------------------------------------
  let phase = 'idle'; // 'idle' | 'rise' | 'hold' | 'retire'
  let bx = 0;
  let by = 0;
  let bz = beaconZ;
  let t0 = 0; // sim time the current epoch ignited
  let retireT = 0; // seconds into the retire
  let epoch = 0; // increments per summons; per-creature params re-derive
  let arrivals = 0; // creatures that reached this epoch's beacon
  let fed = false; // has ANY creature reached it (latched for the epoch)
  let simT = 0; // last time handed to update() — the injectable clock
  let burstT = -1; // <0 idle, else seconds into the burst

  // Shared read-only returns: point() / info() hand back these same objects
  // every call so a per-frame caller allocates nothing. Read, don't retain.
  const ptOut = { x: 0, y: 0, z: beaconZ };
  const infoOut = { phase: 'idle', age: 0, epoch: 0, arrivals: 0, fed: false };

  function setPoint(a, b, c) {
    // tolerant: setPoint({x,y,z?}) | setPoint(x, y, z?)
    let x;
    let y;
    let zz = beaconZ;
    if (a && typeof a === 'object') {
      x = a.x;
      y = a.y;
      if (typeof a.z === 'number') zz = a.z;
    } else {
      x = a;
      y = b;
      if (typeof c === 'number') zz = c;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    bx = x;
    by = y;
    bz = Math.min(Math.max(zz, Z_MIN + 20), Z_MAX - 10);
    t0 = simT;
    retireT = 0;
    phase = 'rise';
    epoch++;
    arrivals = 0;
    fed = false;
    refreshSizes();
    core.points.visible = true;
    ping.points.visible = true;
    return true;
  }

  // CSS px -> world at the beacon plane (the click path; also the test hook).
  // v3.4: the vertical half is relative to the camera's own height — the
  // screen is a porthole into a column that moves, so a click 40 px above
  // centre means 40 px above the VESSEL, not above the surface.
  function setPointFromScreen(cssX, cssY) {
    const camDist = getCamDist();
    const vd = (camDist - beaconZ) / camDist;
    const camY = getCamY ? getCamY() : 0;
    return setPoint((cssX - state.W / 2) * vd, (state.H / 2 - cssY) * vd + camY, beaconZ);
  }

  // Graceful by default: the beacon dissolves and the crowd eases back over
  // RETIRE_S. clear(true) cuts it dead (dispose / scene teardown).
  function clear(immediate) {
    if (phase === 'idle') return;
    if (immediate) {
      phase = 'idle';
      core.points.visible = false;
      ping.points.visible = false;
      core.material.uniforms.uAlpha.value = 0;
      ping.material.uniforms.uAlpha.value = 0;
      return;
    }
    if (phase !== 'retire') {
      phase = 'retire';
      retireT = 0;
    }
  }

  // ---- per-frame (driven by main.js with the injectable clock) ------------
  function update(timeSec, dt) {
    simT = timeSec;
    core.material.uniforms.uTime.value = timeSec;
    ping.material.uniforms.uTime.value = timeSec;
    burst.material.uniforms.uTime.value = timeSec;

    // arrival burst runs independently of the beacon's own phase
    if (burstT >= 0) {
      burstT += dt;
      const b = Math.min(burstT / BURST_S, 1);
      const ease = 1 - (1 - b) * (1 - b);
      burst.points.position.set(bx, by, bz);
      burst.points.scale.setScalar(0.3 + BURST_R * ease);
      burst.material.uniforms.uAlpha.value = BURST_A * (1 - b) * (1 - b);
      if (b >= 1) {
        burstT = -1;
        burst.points.visible = false;
        burst.material.uniforms.uAlpha.value = 0;
      }
    }

    if (phase === 'idle') return;
    refreshSizes();
    const age = timeSec - t0;

    // ignition: 400 ms rise-through-water — blooms open from the point and
    // drifts 6 world px up into place, with a brief phosphor flare.
    const u = Math.min(age / RISE_S, 1);
    const e = 1 - (1 - u) * (1 - u) * (1 - u);
    let a = ALPHA0 * e * (1 + 0.8 * (1 - u));
    let sc = 0.35 + 0.65 * e;
    let yOff = -6 * (1 - e);

    if (phase === 'rise' && age >= RISE_S) phase = 'hold';
    if (phase === 'hold') {
      // deliberate: a slow shallow breath, not the old mote's quick shimmer
      a = ALPHA0 * (0.86 + 0.14 * Math.sin(1.5 * age));
      sc = 1 + 0.05 * Math.sin(1.5 * age);
      yOff = 0;
      if (age - RISE_S >= hold) {
        phase = 'retire';
        retireT = 0;
      }
    }

    let fadeK = 1;
    if (phase === 'retire') {
      retireT += dt;
      const r = Math.min(retireT / RETIRE_S, 1);
      fadeK = (1 - r) * (1 - r);
      sc = 1 + 1.4 * (1 - fadeK);
      yOff = 12 * r; // the lamp loosens upward as it goes out
      a = ALPHA0 * fadeK;
      if (r >= 1) {
        clear(true);
        return;
      }
    }

    const py = by + yOff + BOB * Math.sin(0.55 * age);
    core.points.position.set(bx, py, bz);
    core.points.scale.setScalar(sc);
    core.material.uniforms.uAlpha.value = a;

    // the ping: one ring per PING_S, expanding and fading (design: scale .4 ->
    // 2.8 over 2.6 s ease-out, infinite). Reads as sonar in water.
    const p = frac(age / PING_S);
    const pe = 1 - (1 - p) * (1 - p) * (1 - p);
    ping.points.position.set(bx, py, bz);
    ping.points.scale.setScalar(PING_R0 + (PING_R1 - PING_R0) * pe);
    ping.material.uniforms.uAlpha.value = PING_A * (1 - p) * (1 - p) * fadeK * e;
  }

  function fireBurst() {
    arrivals++;
    fed = true;
    // one burst at a time; a fresh arrival mid-burst restarts it rather than
    // stacking additive flares on top of each other
    if (burstT < 0 || burstT > 0.55 * BURST_S) burstT = 0;
    burst.points.visible = true;
  }

  // ---- per-creature steering hook -----------------------------------------
  // Wired ONCE in Creature.applyMotion (see the module header of feeding.js
  // for the exact call site). Returns true when it drove the creature this
  // frame; when it returns false the creature's own class/behavior motion runs
  // untouched. c.ctrl is never mutated.
  //
  // Per-creature scratch lives on c.gth, created once per creature and mutated
  // in place thereafter (the same lazy pattern as main.js's c.patC) — nothing
  // allocates per frame.
  function steer(c, t, dt) {
    if (phase === 'idle') return false;
    if (c.klass === 'legacy' || c.state !== 'alive') return false;
    if (c.ctrl.behavior === 'sleep') return false; // sleepers NEVER wake
    if (c.material.uniforms.uFormation.value < 0.35) return false; // still forming

    let g = c.gth;
    if (!g) {
      g = c.gth = {
        ep: -1,
        pull: 0,
        t0: 0,
        reached: false,
        react: 0,
        eager: 1,
        turn: 2.4,
        swirl: 0,
        millBase: MILL_BASE,
        yoF: 0,
        ang: 0,
        omK: 0.3,
      };
    }
    if (g.ep !== epoch) {
      // Individuality without new RNG draws: c.d0/d1/d2 are the phases the
      // creature already drew at construction, re-mixed with the epoch so a
      // second summons is not a replay of the first. Deterministic given the
      // same click sequence; session-only either way.
      const q = epoch * 0.6180339887;
      const f0 = frac(c.d0 / TAU + q);
      const f1 = frac(c.d1 / TAU + q * 1.7);
      const f2 = frac(c.d2 / TAU + q * 2.3);
      const f3 = frac(f0 * 7.31 + f1 * 3.17 + f2 * 1.61);
      g.ep = epoch;
      g.t0 = t;
      g.reached = false;
      g.react = REACT_S * f1; // the stagger: they notice at different moments
      g.eager = 0.78 + 0.52 * f0; // approach speed
      g.turn = 1.7 + 2.1 * f2; // steering rate (how tightly it commits)
      g.swirl = f3 * 2 - 1; // signed curve of the approach
      g.millBase = MILL_BASE + 90 * frac(f0 * 3.7 + f2); // soft min radius
      g.yoF = (frac(f1 * 5.3 + f0) * 2 - 1) * 0.7; // vertical layering
      g.ang = f2 * TAU; // orbit phase
      // Signed fraction of its own cruising speed the creature spends going
      // AROUND the point. Deliberately below the speed it can actually make
      // at the mill (see `arrive`), so the orbit target never laps its pursuer
      // — a lapped target makes a creature spin on the spot.
      g.omK = (0.24 + 0.18 * f1) * (f3 < 0.5 ? -1 : 1);
    }

    const want = phase === 'retire' ? 0 : t - g.t0 >= g.react ? 1 : 0;
    g.pull += (want - g.pull) * (1 - Math.exp(-(want > g.pull ? PULL_IN : PULL_OUT) * dt));
    if (g.pull < PULL_EPS) {
      // pre-reaction, or fully eased back: hand the creature to its own motion
      if (want === 0) g.pull = 0;
      return false;
    }

    const s = c.spec;
    const o = c.points;
    const dx = bx - c.px;
    const dy = by - c.py;
    const dz = bz - c.pz;
    const dist = Math.hypot(dx, dy, dz) || 1;

    // ---- rooted: they cannot swim, so they lean ---------------------------
    if (c.klass === 'rooted') {
      const dh = Math.hypot(dx, dz) || 1;
      const ux = dx / dh;
      const uz = dz / dh;
      const q = dist / LEAN_R;
      const fall = 1 / (1 + q * q); // 1 at the stem, half-strength at LEAN_R
      // the bend breathes toward the summons instead of sitting rigid
      const lean = LEAN_MAX * fall * g.pull * (0.86 + 0.14 * Math.sin(0.6 * t + c.d1));
      const wob = 1 + 0.6 * fall * g.pull; // straining, not merely tilted
      // The plant's own yaw is applied OUTSIDE the tilt (Euler order YXZ =
      // Ry·Rx·Rz), so a raw x/z tilt would lean by (world direction rotated by
      // that yaw). Undo it: express the direction in the pre-yaw frame first,
      // then +x rotation leans the stem toward +z and -z rotation toward +x.
      const yaw = s.rot[1] + 0.06 * Math.sin(0.04 * t + c.d0);
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      const lx = ux * cy - uz * sy;
      const lz = ux * sy + uz * cy;
      o.position.set(c.px, c.py, c.pz);
      // Base terms are the rooted class wobble, unchanged (main.js
      // applyMotion, non-sleep w = 1), amplified along the strain.
      o.rotation.set(
        0.03 * wob * Math.sin(0.05 * t + c.d1) + lean * lz,
        yaw,
        0.03 * wob * Math.sin(0.06 * t + c.d2) - lean * lx,
      );
      return true;
    }

    // ---- swimmers + drifters: converge, then mill -------------------------
    // Each creature chases a point on ITS OWN orbit shell around the beacon,
    // never the beacon itself — that is the soft minimum radius, so a crowd
    // can never pile onto one pixel. While far away the shell phase is drawn
    // toward the creature's own bearing, so the approach is a straight run at
    // the near side rather than a chase of a swinging target; by the time it
    // arrives the phase is already its own and the orbit takes over smoothly.
    const mill = c.rad * MILL_K + g.millBase;
    // cruising speed this creature would make on its own (drifters have no
    // registry speed at all — they are carried by the water, so the summons
    // has to lend them one)
    const cruise = c.klass === 'drifter' ? DRIFT_SPD * c.ctrl.tempo * g.eager : (c.speed || 30) * c.ctrl.tempo;
    g.ang += ((g.omK * cruise) / mill) * dt; // constant tangential speed
    const bear = Math.atan2(c.pz - bz, c.px - bx);
    let ad = bear - g.ang;
    while (ad > Math.PI) ad -= TAU;
    while (ad < -Math.PI) ad += TAU;
    const far = Math.min(Math.max((dist - mill * 1.5) / (mill * 3), 0), 1);
    g.ang += ad * far * Math.min(1, 4 * dt);

    const urg = Math.min(URG_MAX, URG_LO + dist / URG_D); // sprint from afar
    const tx = bx + Math.cos(g.ang) * mill;
    const tz = bz + Math.sin(g.ang) * mill * 0.7; // flatter in depth than in x
    const ty = by + g.yoF * mill;

    if (!g.reached && dist < mill + ARRIVE_PAD) {
      g.reached = true;
      fireBurst(); // the consumption delight, kept
    }

    if (c.klass === 'drifter') {
      // no heading, no bank: they translate and keep their idle spin. The
      // class wander is crossfaded out by pull, so this is continuous with
      // main.js's drifter branch at pull 0 and pure approach at pull 1.
      const ax = tx - c.px;
      const ay = ty - c.py;
      const az = tz - c.pz;
      const ad3 = Math.hypot(ax, ay, az) || 1;
      const cw = g.swirl * 0.5 * Math.min(1, dist / 460);
      const vx = ax / ad3 - (az / ad3) * cw;
      const vz = az / ad3 + (ax / ad3) * cw;
      const vy = ay / ad3;
      const spd = cruise * urg * (0.25 + 0.75 * g.pull);
      const step = Math.min(spd * dt, ad3 * 0.5);
      c.px += vx * step;
      c.py += vy * step;
      c.pz = Math.min(Math.max(c.pz + vz * step, Z_MIN + 20), Z_MAX - 10);
      const w = 1 - g.pull;
      o.position.set(
        c.px + s.driftAmp[0] * Math.sin(0.055 * t + c.d0) * w,
        c.py + s.driftAmp[1] * Math.sin(0.04 * t + c.d1) * w,
        c.pz + s.driftAmp[2] * Math.sin(0.03 * t + c.d2) * w,
      );
      o.rotation.set(
        s.rot[0] + 0.08 * Math.sin(0.05 * t + c.d1),
        s.rot[1] + s.spin * (t - c.spawnT) + 0.1 * Math.sin(0.06 * t + c.d0),
        0.06 * Math.sin(0.045 * t + c.d2),
      );
      return true;
    }

    // swimmer: heading steering in the xz plane, exactly the class's own
    // integration, with the target replaced and a per-creature curve added.
    const ax = tx - c.px;
    const az = tz - c.pz;
    const ah = Math.hypot(ax, az) || 1;
    const cw = g.swirl * 0.55 * Math.min(1, dist / 460); // banana approach
    const aimX = ax / ah - (az / ah) * cw;
    const aimZ = az / ah + (ax / ah) * cw;
    const wantH = Math.atan2(-aimZ, aimX);
    // the wander term the swimmer would otherwise be turning by — crossfaded
    // against the summons so the hand-back at the end of the gather is smooth
    const wander =
      Math.sin(t * 0.31 + c.d0) * 0.35 +
      Math.sin(t * 0.13 + c.d1) * 0.25 -
      0.4 * Math.sin(2 * c.heading);
    let diff = wantH - c.heading;
    while (diff > Math.PI) diff -= TAU;
    while (diff < -Math.PI) diff += TAU;
    // rate-limited steering: right on top of its orbit target the aim
    // direction can swing hard, and an unlimited correction would read as a
    // snap. MAX_TURN is well above every ordinary correction.
    const turnRate = Math.min(Math.max(diff * g.turn * g.pull, -MAX_TURN), MAX_TURN);
    c.heading += (turnRate + wander * (1 - g.pull)) * dt;
    // Pursuit that settles instead of oscillating: speed falls off with the
    // remaining distance to the orbit target, so the creature converges to a
    // small steady lag behind it (~15 px) and is carried around the point.
    // The 0.08 floor keeps a fish from ever coming to a dead stop.
    const arrive = Math.min(1, ah / (mill * 0.55 + 30) + 0.08);
    // at pull 0 this is exactly the class cruising speed; at pull 1 it is the
    // full summons sprint — so the hand-back has no speed discontinuity
    const spd = cruise * (1 + (RACE * g.eager * urg - 1) * g.pull) * arrive;
    c.px += Math.cos(c.heading) * spd * dt;
    c.pz = Math.min(Math.max(c.pz - Math.sin(c.heading) * spd * dt, Z_MIN + 20), Z_MAX - 10);
    c.py +=
      (ty - c.py) * (1 - Math.exp(-1.4 * g.pull * dt)) +
      Math.sin(t * 0.09 + c.d2) * cruise * 0.3 * (1 - g.pull) * dt;
    o.position.set(c.px, c.py, c.pz);
    o.rotation.set(
      s.rot[0] + 0.05 * Math.sin(0.07 * t + c.d1),
      c.heading + s.yawOffset,
      // bank into the summons (feeding.js's expression, bounded so a
      // near-180-degree correction cannot roll the body onto its back)
      Math.min(Math.max(-diff * 0.35 * g.pull, -BANK_MAX), BANK_MAX),
    );
    return true;
  }

  // ---- click wiring (chrome sits above the canvas, so its clicks never
  // land here; creature clicks are filtered via the provided hit-test) ------
  const onClick = (e) => {
    if (hitTest && hitTest(e.clientX, e.clientY)) return; // creature click = selection's job
    setPointFromScreen(e.clientX, e.clientY);
  };
  canvas.addEventListener('click', onClick);

  return {
    // ---- the documented surface ------------------------------------------
    setPoint, // setPoint({x,y,z?}) | setPoint(x, y, z?) — world px
    clear, // clear() retires gracefully; clear(true) cuts it dead
    update, // update(timeSec, dt) — the injectable clock, once per frame
    active: () => phase !== 'idle', // true until the crowd has eased back
    point: () => {
      if (phase === 'idle') return null;
      ptOut.x = bx;
      ptOut.y = by;
      ptOut.z = bz;
      return ptOut; // shared object — read, don't retain
    },
    dispose() {
      canvas.removeEventListener('click', onClick);
      for (const c of [core, ping, burst]) {
        scene.remove(c.points);
        c.geometry.dispose();
        c.material.dispose();
      }
      phase = 'idle';
    },
    // ---- the per-creature steering hook main.js needs ---------------------
    steer, // steer(creature, simT, dt) -> bool (true = it drove the creature)
    // ---- test / integrator surface ---------------------------------------
    setPointFromScreen, // (cssX, cssY) — the click path, callable from tests
    info: () => {
      infoOut.phase = phase;
      infoOut.age = phase === 'idle' ? 0 : simT - t0;
      infoOut.epoch = epoch;
      infoOut.arrivals = arrivals;
      infoOut.fed = fed;
      return infoOut; // shared object — read, don't retain
    },
  };
}

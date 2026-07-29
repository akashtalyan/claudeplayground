// Feeding — Phase E interaction. A click on empty water (creature clicks are
// filtered through the hit-test callback supplied by main.js — controls.js
// owns the one hit-test, never duplicated here) drops ONE glowing mote: a
// small pulsing cluster of amber dots that sinks slowly. Swimmers within
// ATTRACT_R break behavior and race to it via a temporary motion override —
// their ctrl.behavior is never mutated, so prior behavior resumes by
// construction the moment the mote is gone. Sleepers never wake (the override
// refuses them). A second click moves the mote; consumption pops a little
// burst of dots; an uneaten mote dissolves quietly at the seabed.
//
// Rendering reuses the ONE dot shader program (frame-graph rule 7) via
// createDotMaterial, so the mote lives in the same additive -> trails ->
// bloom -> tonemap chain as every creature. All time comes from the
// injectable clock (state.simT / tick(simT, dt)) — no wall-time reads.

import * as THREE from 'three';
import { mulberry32 } from './geometry/rng.js';
import { createDotMaterial } from './shaders/dots.js';

const REF_DIST = 10; // must match REF_DIST in shaders/dots.js
const MOTE_Z = -60; // the pleasant band just behind the z=0 plane
const N_DOTS = 20; // cluster: 1 hot core + 19 satellites
const CLUSTER_R = 8; // world px
const SINK = 9; // px/s — slow, deliberate
const SWAY_X = 6; // px lateral sway while sinking
const ATTRACT_R = 380; // world px: swimmers inside this break behavior
const RACE = 1.7; // speed boost while racing to food
const EAT_PAD = 16; // world px arrival slack before consumption
const BURST_S = 0.8; // consumption burst duration (s)
const FADE_S = 1.2; // seabed dissolve duration (s)
const ALPHA0 = 1.5; // resting mote brightness (pre-pulse)
const TAU = Math.PI * 2;

/**
 * @param {object} deps
 * @param {THREE.Scene} deps.scene
 * @param {HTMLCanvasElement} deps.canvas
 * @param {object} deps.state - integrator state (W, H, simT read-only here)
 * @param {() => number} deps.getCamDist
 * @param {object} deps.globalUniforms - shared uniform set (shaders/dots.js)
 * @param {(x:number, y:number) => string|null} deps.hitTest - controls.hitTest;
 *        truthy = the click landed on a creature (select, not feed)
 */
export function initFeeding({ scene, canvas, state, getCamDist, globalUniforms, hitTest }) {
  // ---- mote points: static seeded cluster in local space ------------------
  const rng = mulberry32(0x5eedf00d);
  const pos = new Float32Array(N_DOTS * 3);
  const nor = new Float32Array(N_DOTS * 3);
  const sizeBase = new Float32Array(N_DOTS);
  const aTw = new Float32Array(N_DOTS);
  const aRing = new Float32Array(N_DOTS);
  for (let i = 0; i < N_DOTS; i++) {
    let dx = rng() * 2 - 1;
    let dy = rng() * 2 - 1;
    let dz = rng() * 2 - 1;
    const il = 1 / Math.max(Math.hypot(dx, dy, dz), 1e-4);
    dx *= il;
    dy *= il;
    dz *= il;
    const r = i === 0 ? 0 : CLUSTER_R * Math.pow(rng(), 0.7);
    pos[i * 3] = dx * r;
    pos[i * 3 + 1] = dy * r;
    pos[i * 3 + 2] = dz * r;
    // outward normals: the cluster shades as a tiny glowing ball
    nor[i * 3] = dx;
    nor[i * 3 + 1] = dy;
    nor[i * 3 + 2] = dz;
    sizeBase[i] = i === 0 ? 5.4 : 1.7 + 1.9 * rng();
    aTw[i] = rng();
    aRing[i] = rng();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  const aSizeAttr = new THREE.BufferAttribute(new Float32Array(N_DOTS), 1);
  geometry.setAttribute('aSize', aSizeAttr);
  geometry.setAttribute('aTw', new THREE.BufferAttribute(aTw, 1));
  geometry.setAttribute('aRing', new THREE.BufferAttribute(aRing, 1));

  const material = createDotMaterial(globalUniforms);
  material.uniforms.uColor.value.setRGB(1.0, 0.78, 0.5); // phosphor amber — food reads warm in cold water
  material.uniforms.uAlpha.value = 0;
  material.uniforms.uFormation.value = 1;
  material.uniforms.uTwk.value.set(3.2, 0.5); // quick shimmer — "alive" bait

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.visible = false;
  scene.add(points);

  // ---- mote state ---------------------------------------------------------
  // null | { x0, y0, x, y, z, t0, phase: 'sink'|'burst'|'fade', bt }
  let mote = null;

  function drop(cssX, cssY) {
    const camDist = getCamDist();
    const vd = (camDist - MOTE_Z) / camDist; // CSS px -> world px at MOTE_Z
    // refresh aSize for the current viewport (shader: px = aSize*REF_DIST/viewDist)
    const s = (camDist - MOTE_Z) / REF_DIST;
    for (let i = 0; i < N_DOTS; i++) aSizeAttr.array[i] = sizeBase[i] * s;
    aSizeAttr.needsUpdate = true;
    // one mote at a time: a second click replaces/moves it
    mote = {
      x0: (cssX - state.W / 2) * vd,
      y0: (state.H / 2 - cssY) * vd,
      x: 0,
      y: 0,
      z: MOTE_Z,
      t0: state.simT,
      phase: 'sink',
      bt: 0,
    };
    mote.x = mote.x0;
    mote.y = mote.y0;
    points.visible = true;
    points.scale.setScalar(1);
    points.position.set(mote.x, mote.y, mote.z);
  }

  // ---- per-frame (driven by main.js with the injectable clock) ------------
  function tick(simT, dt) {
    material.uniforms.uTime.value = simT;
    if (!mote) return;
    if (mote.phase === 'sink') {
      const age = simT - mote.t0;
      mote.x = mote.x0 + SWAY_X * Math.sin(0.7 * age);
      mote.y = mote.y0 - SINK * age;
      const camDist = getCamDist();
      const vd = (camDist - MOTE_Z) / camDist;
      const bottom = -(state.H / 2 - 24) * vd;
      if (mote.y <= bottom) {
        // reached the seabed uneaten: dissolve quietly
        mote.y = bottom;
        mote.phase = 'fade';
        mote.bt = 0;
      }
      points.position.set(mote.x, mote.y, mote.z);
      points.scale.setScalar(1 + 0.08 * Math.sin(2.2 * age)); // gentle breath
      material.uniforms.uAlpha.value = ALPHA0 * (0.72 + 0.28 * Math.sin(2.6 * age));
      return;
    }
    // burst (eaten) or fade (seabed): dots fly outward while the glow dies
    const dur = mote.phase === 'burst' ? BURST_S : FADE_S;
    mote.bt += dt / dur;
    const b = Math.min(mote.bt, 1);
    const ease = 1 - (1 - b) * (1 - b);
    const grow = mote.phase === 'burst' ? 5.5 : 1.6;
    const pop = mote.phase === 'burst' ? 1 + 1.2 * b : 1; // brief flare, then gone
    points.scale.setScalar(1 + grow * ease);
    points.position.set(mote.x, mote.y, mote.z);
    material.uniforms.uAlpha.value = ALPHA0 * pop * (1 - b) * (1 - b);
    if (b >= 1) {
      points.visible = false;
      material.uniforms.uAlpha.value = 0;
      mote = null;
    }
  }

  // ---- temporary behavior override (hooked in Creature.applyMotion) -------
  // Returns true when it drove the creature this frame. Never touches
  // c.ctrl.behavior; the moment this returns false the class motion resumes.
  function overrideMotion(c, t, dt) {
    if (!mote || mote.phase !== 'sink') return false;
    if (c.klass !== 'swimmer' || c.state !== 'alive') return false;
    if (c.ctrl.behavior === 'sleep') return false; // sleepers don't wake
    if (c.material.uniforms.uFormation.value < 0.35) return false; // still forming
    const dx = mote.x - c.px;
    const dy = mote.y - c.py;
    const dz = mote.z - c.pz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > ATTRACT_R) return false;
    if (dist < c.rad * 0.6 + EAT_PAD) {
      // first to arrive eats it: burst of dots, everyone resumes next frame
      mote.phase = 'burst';
      mote.bt = 0;
      return false;
    }
    // race: applyFollow-shaped steering toward the mote, hungrier
    const want = Math.atan2(-dz, dx);
    let diff = want - c.heading;
    while (diff > Math.PI) diff -= TAU;
    while (diff < -Math.PI) diff += TAU;
    c.heading += diff * Math.min(1, 3.0 * dt);
    const spd =
      (c.speed || 30) * c.ctrl.tempo * RACE * Math.min(1, dist / (c.rad * 0.8 + 40) + 0.2);
    c.px += Math.cos(c.heading) * spd * dt;
    c.pz += -Math.sin(c.heading) * spd * dt;
    c.py += dy * Math.min(1, 2.0 * dt);
    const o = c.points;
    o.position.set(c.px, c.py, c.pz);
    o.rotation.set(
      c.spec.rot[0] + 0.05 * Math.sin(0.07 * t + c.d1),
      c.heading + c.spec.yawOffset,
      -diff * 0.35, // bank into the lunge
    );
    return true;
  }

  // ---- click wiring (chrome sits above the canvas, so its clicks never
  // land here; creature clicks are filtered via the provided hit-test) ------
  const onClick = (e) => {
    if (hitTest(e.clientX, e.clientY)) return; // creature click = selection's job
    drop(e.clientX, e.clientY);
  };
  canvas.addEventListener('click', onClick);

  return {
    tick,
    overrideMotion,
    drop, // test surface: __menagerie.feeding.drop(cssX, cssY)
    getMote: () => (mote ? { x: mote.x, y: mote.y, z: mote.z, phase: mote.phase } : null),
    dispose() {
      canvas.removeEventListener('click', onClick);
      scene.remove(points);
      geometry.dispose();
      material.dispose();
    },
  };
}

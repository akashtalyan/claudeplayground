// Integrator — Phase C board, v3.4 water column. WebGL2 gate, renderer, camera
// with a 1:1 CSS-pixel z=0 plane that now TRAVELS VERTICALLY through 1200 m of
// ocean, the full 9-archetype menagerie (registry + lexicon), board
// spawn/disperse with staggered formation, per-class motion (swimmers roam,
// rooted plant on the abyssal seabed, drifters wander + idle spin), per-species
// depth bands, same-species schooling, ambient plankton, URL-hash persistence
// (including the vessel's depth), injectable clock, and the window.__menagerie
// test surface. Phase B spike scenes (?scene=duo|eel|ray|pileup) are preserved
// verbatim for the harness: they never build a column, so the camera stays at
// y = 0 and every Phase B pixel contract still holds.
//
// v3.4 module map — who owns what:
//   src/column.js       THE world: metres<->world-px scale, surface/seabed
//                       planes, seabed relief, the camera's depth + easing,
//                       the two dotted boundary sheets, culling info.
//   src/depthprofile.js the OPTICS at a depth (re-exports column.js's units —
//                       there is exactly one definition of the scale).
//   src/depthbands.js   the ECOLOGY: which metre band a species lives in,
//                       placement on the relief, per-frame band steering.
//   src/ui/depthgauge.js the vessel's depth instrument.
// This file wires them together and owns nothing of the model itself.

import * as THREE from 'three';
import { createPipeline } from './render/pipeline.js';
import { createGlobalUniforms, createDotMaterial } from './shaders/dots.js';
import { mulberry32, hashName } from './geometry/rng.js';
import { REGISTRY } from './creatures.js';
import { resolveName, colorFromHue } from './lexicon.js';
import { createControls, defaultCtrl, PRESETS } from './controls.js';
import { create as createAtmosphere } from './atmosphere/index.js';
import { createBackground } from './background.js';
import {
  createColumn,
  seabedYAt,
  METRES_PER_PX,
  DEFAULT_DEPTH_M,
  DEFAULT_SHORE_M,
  TRANSECT_METRES_PER_PX,
} from './column.js';
import {
  createDepthSample,
  sampleDepth,
  composeFogTintInto,
  composeTrailsK,
} from './depthprofile.js';
import {
  setDepthUnits,
  placeSpot,
  attachDepth,
  steerDepth,
  clampToBand,
  clampToTransect,
  transectRangeFor,
  worldYForDepth,
  floorYAt,
  depthUnits,
} from './depthbands.js';
import { bioForSpec, applyBio, setBioMaster, bioDepthGain } from './biolum.js';
import { initSummon } from './ui/summon.js';
import { initPlate } from './ui/plate.js';
import { initRotary } from './ui/rotary.js';
import { initAmbient } from './ui/ambient.js';
import { initLabels } from './ui/labels.js';
import { initDepthGauge } from './ui/depthgauge.js';
import { initShoreGauge } from './ui/shoregauge.js';
import { initInspector } from './ui/inspector.js';
import { initGather } from './gather.js';
import { initCapture } from './capture.js';
import { createGovernor } from './governor.js';

const REF_DIST = 10; // must match REF_DIST in shaders/dots.js
const FOV = 55;
const FORM_TIME = 1.5; // seconds, uFormation 0 -> 1
const EASE_RATE = 4.5; // 1/s; same coefficient eases positions AND normals
const MAXC = 14; // board population cap
const SPAWN_STAGGER = 0.35; // s between formation starts in a batch
const DIE_TIME = 1.3; // s disperse fade
const DEPTH_RANGE = 150; // world px z offset at depth ctrl = ±1
const TAU = Math.PI * 2;
// v3.4 culling: a creature this far outside the porthole's band stops paying
// for its skeleton (the O(n) target math + ease + buffer upload) and stops
// being drawn. One extra screen of slack means nothing is ever simulated-out
// while it is still on its way in; re-entry snaps the dots straight onto their
// targets for one frame so a returning creature never eases in from stale
// geometry (i.e. never pops).
const CULL_MARGIN_SCREENS = 1.0;
// How far through the water a gather summons carries. Bands are hundreds of
// metres apart now, so a global summons would ask a dolphin to visit the abyss;
// the beacon reaches about a screen and a half, which is as far as a creature
// can actually swim inside the beacon's ~12 s life.
const GATHER_REACH_SCREENS = 2.0;

const params = new URLSearchParams(location.search);

// ---- WebGL2 gate ----------------------------------------------------------
const probe = document.createElement('canvas');
if (!probe.getContext('webgl2')) {
  document.getElementById('webgl-required').style.display = 'flex';
} else {
  boot();
}

function boot() {
  const canvas = document.getElementById('scene');
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    preserveDrawingBuffer: false, // frame-graph hard rule 6
    powerPreference: 'high-performance',
  });

  // Camera: z=0 plane maps 1:1 to CSS pixels — camDist = (cssH/2)/tan(fov/2).
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 5000);
  let camDist = 1;
  let camYaw = 0;
  // v3.4: the column owns the camera's HEIGHT. camDist and the yaw arc are
  // untouched — travelling the column is a pure vertical TRANSLATION, so the
  // z = 0 plane keeps its 1:1 CSS-pixel mapping at every depth. `column` is
  // null in the Phase B spike scenes, which keep the v3.3 stationary camera.
  let column = null;
  function applyCamera() {
    if (column) {
      column.applyTo(camera, camDist, camYaw);
      return;
    }
    camera.position.set(Math.sin(camYaw) * camDist, 0, Math.cos(camYaw) * camDist);
    camera.lookAt(0, 0, 0);
  }
  const camY = () => (column ? column.camY() : 0);
  // v3.7 — the vessel's world X. Everything pinned to the VESSEL rather than to
  // the world (the plankton lattice, the caustic shafts, a cursor mapping) has
  // to add this, exactly as it already adds camY. Anything pinned to the WORLD
  // (creatures, the seabed sheet) must not.
  const camX = () => (column ? column.camX() : 0);
  // A creature roams inside a HOME RANGE around where its species lives, not
  // around world x = 0 — that was the flat-world assumption on the horizontal
  // axis, the exact twin of the `|py| > H/2` clamp v3.4 removed on the vertical
  // one. One screen of slack: local motion, true position.
  const ROAM_HALF_PX = () => state.W * 0.5 + 140;
  function updateCameraDistance(cssH) {
    camDist = cssH / 2 / Math.tan((FOV * Math.PI) / 360);
    applyCamera();
  }
  updateCameraDistance(window.innerHeight || 540);

  const scene = new THREE.Scene();
  const background = createBackground(scene);

  // ---- global lighting / medium: cool abyssal water -----------------------
  // (tuning pass: monochrome-by-default cool-cyan cast — light is a cold
  // white-blue instead of the spike's warm lamp)
  const globalUniforms = createGlobalUniforms(renderer);
  globalUniforms.uLightDir.value.set(-0.45, 0.75, 0.4).normalize();
  globalUniforms.uLightColor.value.setRGB(0.8, 0.94, 1.05);
  globalUniforms.uRim.value = 1.25;
  globalUniforms.uFogDensity.value = 0.0015;
  globalUniforms.uAperture.value = 0.0016;
  globalUniforms.uFocusZ.value = camDist;

  // ---- state --------------------------------------------------------------
  const state = {
    sway: parseFloatOr(params.get('sway'), 1.0),
    simT: 0,
    creatures: [],
    pending: [], // { due, spec } — staggered formation ramp
    focus: null, // creature whose depth drives uFocusZ (spike scenes)
    boardMode: false,
    spawnSlot: 0, // deterministic placement counter
    W: window.innerWidth || 960,
    H: window.innerHeight || 540,
    // Phase D control plumbing
    cursor: { x: 0, y: 0 }, // world px at the z=0 plane ('follow' behavior)
    turbulence: 1, // global sway multiplier (weather presets)
    current: 0, // px/s lateral drift (weather presets; atmosphere reads it)
    planktonRate: 1, // plankton time-warp (weather current)
    planktonT: 0,
    govDensity: 1, // Phase F governor lever 4 — render-fraction ONLY (drawRange)
  };
  let nextId = 1; // creature ids ('c1', 'c2', ...) for the controls API
  let maxAlive = MAXC; // Phase F governor lever 5 (14 -> 10)
  let controls = null; // assigned after the pipeline exists
  let gather = null; // v3.2 gather beacon (assigned with the UI, board mode only)
  let capture = null; // Phase E snapshot/record I/O (board mode only)

  function parseFloatOr(v, d) {
    const f = parseFloat(v);
    return Number.isFinite(f) ? f : d;
  }

  // ---- creature -----------------------------------------------------------
  class Creature {
    constructor(spec) {
      this.spec = spec;
      const entry = REGISTRY[spec.arch];
      this.klass = spec.klass; // 'legacy' | 'swimmer' | 'rooted' | 'drifter'
      this.id = spec.id ?? 'c' + nextId++;
      // control overlay (Phase D) — spec.ctrl arrives from URL-hash restore
      this.ctrl = spec.ctrl ? { ...defaultCtrl(), ...spec.ctrl } : defaultCtrl();
      this.sizeCur = this.ctrl.size; // eased whole-body size morph
      this.zOff = this.ctrl.depth * DEPTH_RANGE; // eased z-band offset
      this.patC = null; // patrol center, captured lazily
      this.gen = entry.maker(spec.seed, spec.morph ? { morph: spec.morph } : undefined);
      const n = this.gen.count;
      this.tpos = new Float32Array(n * 3);
      this.tnor = new Float32Array(n * 3);

      const pos = new Float32Array(n * 3);
      const nor = new Float32Array(n * 3);
      const aSize = new Float32Array(n);
      const aTw = new Float32Array(n);
      const aRing = new Float32Array(n);
      this.gen.init({ aSize, aTw, aRing });
      // aSize is authored ~[0.4..1.25]; rescale so a dot at this creature's
      // depth renders ~spec.dotPx CSS px (shader: px = aSize*REF_DIST/viewDist)
      const viewDist0 = camDist - spec.base[2];
      const sizeScale = (spec.dotPx * viewDist0) / REF_DIST;
      for (let i = 0; i < n; i++) aSize[i] *= sizeScale;
      // Phase F small-creature merge correction (shaders/dots.js uSmall):
      // because aSize is normalized to spawn depth above while dot spacing
      // scales with the creature, the overlap ratio relative to the
      // archetype's tuned default is exactly this constant / worldScale.
      this.smallBase = (entry.scale * viewDist0) / camDist;

      // formation start: scattered cloud in local space, random normals; the
      // shared easing pulls both toward targets while uFormation ramps.
      const rng = mulberry32(spec.seed ^ 0x5f356495);
      const R = spec.scatterR;
      for (let i = 0; i < n * 3; i++) pos[i] = (rng() * 2 - 1) * R;
      for (let i = 0; i < n * 3; i++) nor[i] = rng() * 2 - 1;

      const g = new THREE.BufferGeometry();
      this.posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
      this.norAttr = new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('position', this.posAttr);
      g.setAttribute('normal', this.norAttr);
      g.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
      g.setAttribute('aTw', new THREE.BufferAttribute(aTw, 1));
      g.setAttribute('aRing', new THREE.BufferAttribute(aRing, 1));
      // fixed local bounding sphere (geometry-spec section 10) — never recomputed
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), spec.boundR);
      this.geometry = g;

      this.material = createDotMaterial(globalUniforms);
      this.material.uniforms.uAlpha.value = spec.alpha * this.ctrl.glow;
      this.material.uniforms.uFormation.value = 0;
      // color / twinkle / iridescence / density (drawRange over the build-time
      // cross-ring shuffle — geometry is NEVER rebuilt)
      this.applyCtrlVisual();

      this.points = new THREE.Points(g, this.material);
      this.points.rotation.order = 'YXZ'; // yaw, then pitch, then bank
      this.points.scale.setScalar(spec.scale * this.sizeCur);
      this.spawnT = state.simT;
      this.state = 'alive';
      this.dieT = 0;
      this.d0 = rng() * TAU;
      this.d1 = rng() * TAU;
      this.d2 = rng() * TAU;
      // anchor position + heading (board classes move the anchor)
      this.px = spec.base[0];
      this.py = spec.base[1];
      this.pz = spec.base[2];
      this.heading = spec.heading ?? 0;
      this.speed = spec.speed ?? 0;
      this.rad = spec.boundR * spec.scale * this.sizeCur; // world-px interaction radius
      // v3.4 — stamp the creature with its home in the water column. `homeM`
      // and `liftPx` are exactly the ones boardSpec's placeDepth() already
      // used, so steering agrees with placement to the last decimal (hand the
      // steering a different lift and a lifted plant is dragged back into the
      // sediment). The spike scenes have no band and are never steered.
      if (spec.band) {
        attachDepth(this, {
          band: spec.band,
          seed: spec.seed,
          instance: spec.instance ?? 0,
          homeM: spec.depthM,
          liftPx: spec.liftPx ?? 0,
          // v3.7 — the horizontal home, handed over from placement for exactly
          // the reason homeM is: steering that re-derives it would disagree
          // with the spawn by a jitter's width and pull the creature sideways
          // out of the group it was placed in.
          homeS: spec.transectM,
          homeX: spec.homeX ?? spec.base[0],
        });
      }
      // ---- v3.7 bioluminescence -------------------------------------------
      // The record is the species' own (src/biolum.js, overridden by the
      // researched `bioluminescent`/`bioNote`/`bioColour` fields in
      // ocean-data.json). `infer` lights the unlisted species whose BAND sits
      // in the dark, because that is what the layer does — roughly three
      // quarters of the animals below 250 m emit light. A null record leaves
      // the uniforms alone and the creature renders exactly as it did in v3.6.
      this.bio = spec.band ? bioForSpec(spec, { infer: true, band: spec.band }) : bioForSpec(spec);
      if (this.bio) applyBio(this.material, this.bio);
      // culling state: `culled` is true while the creature is outside the
      // porthole's band + margin (skeleton math skipped, not drawn); `catchUp`
      // asks the next visible frame to place the dots ON their targets instead
      // of easing from wherever they were left.
      this.culled = false;
      this.catchUp = false;
      this.applyMotion(state.simT, 0);
    }

    // static ctrl values -> uniforms/drawRange (color, twinkle, iridescence,
    // density). Called at construction and by controls.setParam.
    applyCtrlVisual() {
      const u = this.material.uniforms;
      const col = this.ctrl.color != null ? colorFromHue(this.ctrl.color) : this.spec.color;
      u.uColor.value.setRGB(col[0], col[1], col[2]);
      // default twinkle 1 -> uTwk (2.1, 0.4), byte-identical to Phase C
      u.uTwk.value.set(2.1 * Math.max(this.ctrl.twinkle, 0.15), 0.4 * this.ctrl.twinkle);
      u.uIrid.value = this.ctrl.iridescence;
      // state.govDensity is the governor's lever 4 (1 -> 0.5): still drawRange
      // over the same build-time shuffle — build counts NEVER change
      const frac = this.spec.drawFrac * this.ctrl.density * state.govDensity;
      this.geometry.setDrawRange(0, Math.max(1, Math.floor(this.gen.count * frac)));
      // merge correction tracks render density: fewer rendered dots = sqrt(frac)
      // wider effective spacing = proportionally less overlap to conserve
      u.uSmall.value = this.smallBase * Math.sqrt(frac);
    }

    // re-form: scatter back to a cloud and replay the formation ramp
    reform() {
      const rng = mulberry32((this.spec.seed ^ 0x2545f491 ^ ((state.simT * 977) | 0)) >>> 0);
      const R = this.spec.scatterR;
      const p = this.posAttr.array;
      const q = this.norAttr.array;
      for (let i = 0; i < p.length; i++) p[i] = (rng() * 2 - 1) * R;
      for (let i = 0; i < q.length; i++) q[i] = rng() * 2 - 1;
      this.posAttr.needsUpdate = true;
      this.norAttr.needsUpdate = true;
      this.spawnT = state.simT;
      this.material.uniforms.uFormation.value = 0;
    }

    // legacy spike drift — byte-for-byte the Phase B behavior
    applyDrift(t) {
      const s = this.spec;
      const o = this.points;
      o.position.set(
        s.base[0] + s.driftAmp[0] * Math.sin(0.11 * t + this.d0),
        s.base[1] + s.driftAmp[1] * Math.sin(0.07 * t + this.d1),
        s.base[2] + s.driftAmp[2] * Math.sin(0.045 * t + this.d2),
      );
      o.rotation.set(
        s.rot[0] + 0.06 * Math.sin(0.05 * t + this.d1),
        s.rot[1] + s.yawAmp * Math.sin(0.08 * t + this.d0),
        s.rot[2] + 0.05 * Math.sin(0.06 * t + this.d2),
      );
    }

    applyMotion(t, dt) {
      const s = this.spec;
      const o = this.points;
      if (this.klass === 'legacy') {
        this.applyDrift(t);
        return;
      }
      const b = this.ctrl.behavior;
      if (this.klass === 'rooted') {
        // anchored to the seabed; only a gentle current wobble in the frame
        // (behavior modes are no-ops for the rooted, except sleep stills them)
        const w = b === 'sleep' ? 0.25 : 1;
        o.position.set(this.px, this.py, this.pz);
        o.rotation.set(
          0.03 * w * Math.sin(0.05 * t + this.d1),
          s.rot[1] + 0.06 * w * Math.sin(0.04 * t + this.d0),
          0.03 * w * Math.sin(0.06 * t + this.d2),
        );
        return;
      }
      // Phase D behavior modes ('drift' and 'school' keep the class motion;
      // schooling attraction for 'school' lives in applySchooling)
      if (b === 'sleep') return this.applySleep(t, dt);
      // Phase E: a dropped mote temporarily overrides swimmer motion (checked
      // after sleep so sleepers never wake; behavior itself is untouched).
      // v3.4: only creatures within the beacon's reach hear it — see
      // GATHER_REACH_SCREENS. `inReach` is refreshed once per frame by the
      // board loop, so this stays an O(1) read.
      if (gather && this.inReach && gather.steer(this, t, dt)) return;
      if (b === 'patrol') return this.applyPatrol(t, dt);
      if (b === 'follow') return this.applyFollow(t, dt);
      if (this.klass === 'drifter') {
        // slow closed-form wander around the anchor + idle spin
        o.position.set(
          this.px + s.driftAmp[0] * Math.sin(0.055 * t + this.d0),
          this.py + s.driftAmp[1] * Math.sin(0.04 * t + this.d1),
          this.pz + s.driftAmp[2] * Math.sin(0.03 * t + this.d2),
        );
        o.rotation.set(
          s.rot[0] + 0.08 * Math.sin(0.05 * t + this.d1),
          s.rot[1] + s.spin * (t - this.spawnT) + 0.1 * Math.sin(0.06 * t + this.d0),
          0.06 * Math.sin(0.045 * t + this.d2),
        );
        return;
      }
      // swimmer: v2's two-sine heading wander, integrated in 3D (yaw through
      // depth — no 2D flip), with soft steering back into the water volume.
      // A gentle restoring term biases headings toward the cross-screen axes
      // (heading ≡ 0 or π) so bodies read side-on more than end-on — an
      // end-on creature is both unreadable and an additive hot spot.
      const turn =
        Math.sin(t * 0.31 + this.d0) * 0.35 +
        Math.sin(t * 0.13 + this.d1) * 0.25 -
        0.4 * Math.sin(2 * this.heading);
      this.heading += turn * dt;
      // v3.7: the roam box is centred on the creature's OWN place on the
      // transect, not on world x = 0. Steering back toward x = 0 was the
      // horizontal flat-world assumption — it would have marched every animal
      // on the board to the far offshore end of a 36 km ocean within a minute.
      const home = this.homeX ?? 0;
      const hw = ROAM_HALF_PX() - 140;
      const out =
        Math.abs(this.px - home) > hw || this.pz < Z_MIN + 40 || this.pz > Z_MAX - 30;
      if (out) {
        const ta = Math.atan2(-(Z_MID - this.pz), home - this.px);
        let diff = ta - this.heading;
        while (diff > Math.PI) diff -= TAU;
        while (diff < -Math.PI) diff += TAU;
        this.heading += diff * 1.4 * dt;
      }
      this.px += Math.cos(this.heading) * this.speed * dt;
      this.pz += -Math.sin(this.heading) * this.speed * dt;
      // v3.4: the vertical bob stays, but the old `|py| > H/2 - 120` clamp to
      // the middle of the SCREEN is gone — that was the flat-world assumption.
      // The creature's species band (steerDepth, run by the board loop before
      // this) is what holds it vertically now, so a swimmer keeps its own
      // altitude while the vessel travels past it.
      this.py += Math.sin(t * 0.09 + this.d2) * this.speed * 0.3 * dt;
      o.position.set(this.px, this.py, this.pz);
      o.rotation.set(
        s.rot[0] + 0.05 * Math.sin(0.07 * t + this.d1),
        this.heading + s.yawOffset,
        -turn * 0.35, // bank into the turn
      );
    }

    // sleep: settle to the bottom of its OWN band, minimal motion. v3.3 sank
    // sleepers to the projected bottom edge of the screen; in a 1200 m column
    // that would drop a dolphin into the abyss every time you looked away, so
    // "settle" now means the deep edge of the species' own water. Floor
    // dwellers are already on the floor and simply stay where they are.
    applySleep(t, dt) {
      const s = this.spec;
      const o = this.points;
      const b = this.band;
      const bottom =
        b && b.kind === 'pelagic'
          ? worldYForDepth(Math.min(b.maxM, (this.homeM ?? b.preferM) + 25))
          : this.py;
      this.py += (bottom - this.py) * (1 - Math.exp(-0.35 * dt));
      this.px += Math.sin(0.05 * t + this.d0) * 2 * dt;
      o.position.set(this.px, this.py, this.pz);
      o.rotation.set(
        s.rot[0] + 0.02 * Math.sin(0.04 * t + this.d1),
        o.rotation.y,
        0.02 * Math.sin(0.05 * t + this.d2),
      );
    }

    // patrol: slow closed elliptical path around the point where patrol began
    applyPatrol(t, dt) {
      const s = this.spec;
      const o = this.points;
      if (!this.patC) {
        this.patC = {
          x: this.px,
          y: this.py,
          z: Math.min(Math.max(this.pz, Z_MIN + 90), Z_MAX - 70),
        };
        this.patAng = this.d0;
      }
      const spd = (this.speed || 26) * this.ctrl.tempo;
      this.patAng += (spd / 150) * dt; // tangential speed ~ roam speed
      const a = this.patAng;
      // v3.7: bounded around the patrol's own centre — which is where the
      // creature was when patrol began, i.e. its own water — not around the
      // world origin.
      const home = this.homeX ?? 0;
      const hw = ROAM_HALF_PX() - 100;
      this.px = Math.min(Math.max(this.patC.x + 150 * Math.cos(a), home - hw), home + hw);
      this.pz = Math.min(Math.max(this.patC.z + 60 * Math.sin(a), Z_MIN + 20), Z_MAX - 10);
      this.py += (this.patC.y + 20 * Math.sin(a * 0.5) - this.py) * Math.min(1, 1.5 * dt);
      const dx = -Math.sin(a);
      const dz = 0.4 * Math.cos(a);
      this.heading = Math.atan2(-dz, dx);
      o.position.set(this.px, this.py, this.pz);
      if (this.klass === 'swimmer') {
        o.rotation.set(s.rot[0], this.heading + s.yawOffset, -0.15 * Math.cos(a));
      } else {
        o.rotation.set(
          s.rot[0] + 0.06 * Math.sin(0.05 * t + this.d1),
          s.rot[1] + s.spin * (t - this.spawnT),
          0.05 * Math.sin(0.05 * t + this.d2),
        );
      }
    }

    // follow: steer toward the cursor's world point, slowing on arrival
    applyFollow(t, dt) {
      const s = this.spec;
      const o = this.points;
      const cx = state.cursor.x;
      const cy = state.cursor.y;
      const tz = -60; // a pleasant band just behind the z=0 plane
      const dx = cx - this.px;
      const dz = tz - this.pz;
      const want = Math.atan2(-dz, dx);
      let diff = want - this.heading;
      while (diff > Math.PI) diff -= TAU;
      while (diff < -Math.PI) diff += TAU;
      this.heading += diff * Math.min(1, 2.2 * dt);
      const dist = Math.hypot(dx, cy - this.py, dz);
      const spd = (this.speed || 30) * this.ctrl.tempo * Math.min(1, dist / (this.rad * 1.4 + 40));
      this.px += Math.cos(this.heading) * spd * dt;
      this.pz = Math.min(Math.max(this.pz - Math.sin(this.heading) * spd * dt, Z_MIN + 20), Z_MAX - 10);
      this.py += (cy - this.py) * Math.min(1, 1.2 * dt);
      o.position.set(this.px, this.py, this.pz);
      if (this.klass === 'swimmer') {
        o.rotation.set(
          s.rot[0] + 0.05 * Math.sin(0.07 * t + this.d1),
          this.heading + s.yawOffset,
          -diff * 0.3,
        );
      } else {
        o.rotation.set(
          s.rot[0],
          s.rot[1] + s.spin * (t - this.spawnT),
          0.05 * Math.sin(0.05 * t + this.d2),
        );
      }
    }

    // `visible` (v3.4) is the column's culling verdict for this frame. When it
    // is false the creature keeps its cheap O(1) life — it drifts, ages, fades,
    // holds its band — but pays nothing for its ~2000-dot skeleton and is not
    // drawn. The frame it comes back, the dots are placed ON their targets
    // rather than eased toward them, so it re-enters mid-stroke instead of
    // unfolding out of stale geometry.
    update(simT, dt, sway, visible = true) {
      if (!visible) {
        this.culled = true;
        this.catchUp = true;
        this.points.visible = false;
        return this.updateCheap(simT, dt);
      }
      if (this.culled) this.culled = false;
      this.points.visible = true;
      // sleep slows the body's own animation as well as its travel
      const slp = this.ctrl.behavior === 'sleep' ? 0.35 : 1;
      this.gen.updateTargets(
        simT + this.spec.phase,
        sway * this.ctrl.sway * slp,
        this.spec.tempo * this.ctrl.tempo * slp,
        this.tpos,
        this.tnor,
      );
      const c = this.catchUp ? 1 : 1 - Math.exp(-EASE_RATE * dt);
      this.catchUp = false;
      const p = this.posAttr.array;
      const q = this.norAttr.array;
      const tp = this.tpos;
      const tn = this.tnor;
      for (let i = 0; i < p.length; i++) {
        p[i] += (tp[i] - p[i]) * c;
        q[i] += (tn[i] - q[i]) * c;
      }
      this.posAttr.needsUpdate = true;
      this.norAttr.needsUpdate = true;
      const u = this.material.uniforms;
      u.uTime.value = simT;
      u.uFormation.value = Math.min(Math.max((simT - this.spawnT) / FORM_TIME, 0), 1);
      if (this.state === 'dying') {
        this.dieT += dt;
        const f = Math.max(0, 1 - this.dieT / DIE_TIME);
        u.uAlpha.value = this.spec.alpha * this.ctrl.glow * f * f;
        this.py += 14 * dt; // released creatures loosen upward as they fade
      } else {
        u.uAlpha.value = this.spec.alpha * this.ctrl.glow;
      }
      // eased whole-body size morph (ctrl.size)
      this.sizeCur += (this.ctrl.size - this.sizeCur) * (1 - Math.exp(-3 * dt));
      this.points.scale.setScalar(this.spec.scale * this.sizeCur);
      this.rad = this.spec.boundR * this.spec.scale * this.sizeCur;
      this.applyMotion(simT, dt);
      this.applyDepthOffset(dt);
      return !(this.state === 'dying' && this.dieT >= DIE_TIME);
    }

    // The O(1) half of update(): everything that must keep running while the
    // creature is off the porthole's band — motion, fade, size morph, the z
    // parallax — with the O(n) skeleton work and the draw call skipped.
    updateCheap(simT, dt) {
      const u = this.material.uniforms;
      u.uFormation.value = Math.min(Math.max((simT - this.spawnT) / FORM_TIME, 0), 1);
      if (this.state === 'dying') {
        this.dieT += dt;
        const f = Math.max(0, 1 - this.dieT / DIE_TIME);
        u.uAlpha.value = this.spec.alpha * this.ctrl.glow * f * f;
        this.py += 14 * dt;
      }
      this.sizeCur += (this.ctrl.size - this.sizeCur) * (1 - Math.exp(-3 * dt));
      this.points.scale.setScalar(this.spec.scale * this.sizeCur);
      this.rad = this.spec.boundR * this.spec.scale * this.sizeCur;
      this.applyMotion(simT, dt);
      this.applyDepthOffset(dt);
      return !(this.state === 'dying' && this.dieT >= DIE_TIME);
    }

    // eased z-band offset (ctrl.depth): a parallax layer on top of the class
    // motion. v3.4: the rooted used to have their SCREEN-relative y rescaled by
    // the new view distance — a flat-world trick that would now teleport a
    // plant hundreds of metres up the column. A plant pushed back in z is
    // instead re-planted on the seabed relief at its new (x, z), which is both
    // correct and the reason the dune field is a pure function.
    applyDepthOffset(dt) {
      if (this.klass === 'legacy') return;
      this.zOff += (this.ctrl.depth * DEPTH_RANGE - this.zOff) * (1 - Math.exp(-1.5 * dt));
      if (Math.abs(this.zOff) <= 0.01) return;
      const o = this.points;
      const z0 = o.position.z;
      const z1 = Math.min(z0 + this.zOff, camDist - 140);
      // v3.5: rooted things stand on the substrate at THEIR OWN depth — the
      // shelf bench for a kelp holdfast at 13 m, the abyssal plain for
      // anything that genuinely lives down there. Passing homeM is what
      // reaches the shelf at all (seabedYAt with no depth = the plain).
      if (this.klass === 'rooted') {
        o.position.y = seabedYAt(this.px, z1, this.homeM) + (this.liftPx || 0);
      }
      o.position.z = z1;
    }

    disperse() {
      if (this.state === 'alive') {
        this.state = 'dying';
        this.dieT = 0;
      }
    }

    dispose() {
      this.geometry.dispose();
      this.material.dispose();
    }
  }

  // ---- water volume (world px; z band shared by placement + steering) -----
  const Z_MIN = -340;
  const Z_MAX = 40;
  const Z_MID = -130;

  // ---- Phase B spike scenes (verbatim from the spike — harness contract) --
  function eelSpec(over) {
    return {
      kind: 'eel',
      arch: 'eel',
      klass: 'legacy',
      seed: 1337,
      base: [0, 15, -20],
      rot: [0, -0.45, 0.06],
      scale: 60,
      dotPx: 5.0,
      color: [0.7, 0.87, 1.0],
      alpha: 1.0,
      tempo: 1.0,
      phase: 0,
      boundR: 4.2,
      scatterR: 3.0,
      driftAmp: [26, 16, 10],
      yawAmp: 0.28,
      drawFrac: 1,
      focus: false,
      ...over,
    };
  }

  function raySpec(over) {
    return {
      kind: 'ray',
      arch: 'ray',
      klass: 'legacy',
      seed: 4242,
      base: [0, -10, -60],
      rot: [-1.05, 0.4, 0],
      scale: 95,
      dotPx: 4.6,
      color: [0.85, 0.88, 1.0],
      alpha: 1.35,
      tempo: 1.0,
      phase: 0,
      boundR: 3.4,
      scatterR: 2.6,
      driftAmp: [24, 12, 14],
      yawAmp: 0.18,
      drawFrac: 1,
      focus: false,
      ...over,
    };
  }

  function sceneSpecs(name) {
    switch (name) {
      case 'eel':
        return [eelSpec({ focus: true, scale: 72 })];
      case 'ray':
        return [raySpec({ focus: true, rot: [-1.0, 0.35, 0] })];
      case 'pileup': {
        const specs = [];
        for (let i = 0; i < 10; i++) {
          specs.push(
            eelSpec({
              seed: 7000 + i,
              base: [0, 10, -30],
              scale: 55,
              phase: i * 0.77,
              focus: i === 0,
            }),
          );
        }
        return specs;
      }
      case 'duo':
      default:
        return [
          // eel mid-frame coiling, in focus; ray deeper, dimmed + defocused
          eelSpec({ base: [-120, 60, -10], rot: [0, -0.35, 0.08], scale: 78, focus: true }),
          raySpec({ base: [185, -100, -280], rot: [-1.05, 0.5, 0], scale: 95 }),
        ];
    }
  }

  // ---- board: lexicon spec -> placed creature spec ------------------------
  function boardSpec(res, instance) {
    const entry = REGISTRY[res.arch];
    const slot = state.spawnSlot++;
    const prng = mulberry32((res.seed ^ Math.imul(slot + 1, 0x9e3779b9)) >>> 0);
    const school = res.count > 1;
    const scale = entry.scale * res.scale * (0.88 + 0.24 * prng()) * (school ? 0.82 : 1);
    const klass = entry.class;
    // v3.4: the species' home in the water column. `res.band` comes from the
    // lexicon (species entry first, archetype second) and is a frozen record.
    const band = res.band || REGISTRY[res.arch].band;
    // Floor dwellers — rooted flora AND benthic animals (starfish, crab) — are
    // planted on the real seabed relief; everything else lives at its own metre
    // depth in open water. Both branches draw EXACTLY three prng values, so the
    // frozen draw order of everything after them (rot, tempo, phase, speed) is
    // unchanged from v3.3 and a legacy hash still yields the same bodies.
    const floorDweller = band.kind === 'rooted' || band.kind === 'benthic';
    // v3.7: a ROOTED BAND makes a creature rooted whatever archetype draws it.
    // A barnacle wears the amorph body plan (it is a lump) but it is cemented
    // to the rock, and letting the amorph's drifter wander carry it would be
    // the "flora cannot float" rule broken sideways. This affects MOTION only —
    // the `rot` draw below still keys off the registry's own class, so the
    // frozen prng order is untouched.
    const liveKlass = band.kind === 'rooted' ? 'rooted' : klass;
    let base;
    let liftPx = 0;
    let depthM = 0;
    let transectM = 0;
    let heading = prng() * TAU;
    // ---- v3.7: WHERE IT ACTUALLY LIVES, in both axes ----------------------
    // The world x is no longer a screen-relative scatter around the camera. It
    // is the creature's own place on the 36 km transect (depthbands.placeSpot),
    // plus a small LATERAL jitter so a batch of five is a group rather than a
    // line. The jitter is the SAME prng draw the screen scatter used, remapped
    // — no extra calls, so the frozen draw order of everything after it (rot,
    // tempo, phase, speed) is byte-identical to v3.4 and a legacy hash still
    // yields the same bodies.
    if (floorDweller) {
      const jitterPx = (prng() * 2 - 1) * (state.W / 2 - 120);
      const pz = -280 + prng() * 260;
      // Rooted geometry puts the root anchor at LOCAL y = 0 (geometry-spec:
      // "root at local origin, stem grows +Y"), so the object's origin IS the
      // holdfast — placing it at the floor plants the thing. A small negative
      // embed sinks the base a few px into the silt, which is where a holdfast
      // actually is. Same single prng draw.
      const embed = -(3 + prng() * 11);
      liftPx = band.kind === 'rooted' ? embed : 0; // benthic hover comes from the band
      const pl = placeSpot({
        band, name: res.name, arch: res.arch, seed: res.seed, instance,
        z: pz, jitterPx, liftPx,
      });
      base = [pl.worldX, pl.worldY, pz];
      depthM = pl.depthM;
      transectM = pl.transectM;
    } else {
      const jitterPx = (prng() * 2 - 1) * (state.W / 2 - 180);
      prng(); // v3.3 drew y here; the band owns it now. Draw kept, value dropped.
      const pz = Z_MIN + 20 + prng() * (Z_MAX - Z_MIN - 40);
      const pl = placeSpot({
        band, name: res.name, arch: res.arch, seed: res.seed, instance,
        z: pz, jitterPx,
      });
      base = [pl.worldX, pl.worldY, pz];
      depthM = pl.depthM;
      transectM = pl.transectM;
    }
    return {
      id: 'c' + nextId++, // assigned at spec time so summon() can report it
      kind: res.arch,
      arch: res.arch,
      klass: liveKlass,
      name: res.name,
      count: res.count,
      instance,
      seed: res.seed,
      morph: res.morph ?? null, // named-species fish geometry ("blue shark")
      base,
      heading,
      rot: [entry.pitch, klass === 'rooted' || klass === 'drifter' ? prng() * TAU : 0, 0],
      scale,
      dotPx: entry.dotPx,
      color: colorFromHue(res.hue),
      alpha: entry.alpha * (res.ghost ? 0.45 : 1),
      tempo: res.tempo * (0.85 + 0.3 * prng()),
      phase: prng() * TAU + instance * 0.77,
      boundR: entry.boundR,
      scatterR: entry.boundR * 0.8,
      // v3.4: a benthic drifter (starfish, crab) must not bob 26 px off the
      // floor it is standing on — its wander is flattened, not removed.
      driftAmp: liveKlass === 'drifter' ? (floorDweller ? [30, 5, 20] : [44, 26, 30]) : [0, 0, 0],
      yawAmp: 0,
      yawOffset: entry.yawOffset,
      spin: entry.spin,
      speed: entry.speed * res.speed * (0.8 + 0.4 * prng()),
      drawFrac: school ? 0.55 : 1,
      focus: false,
      // ---- v3.4 vertical placement (read by the Creature ctor + framing) ----
      band,
      depthM,
      liftPx,
      // ---- v3.7 horizontal placement — metres offshore, the same contract ---
      transectM,
      homeX: base[0],
    };
  }

  function aliveCount() {
    let n = 0;
    for (const c of state.creatures) if (c.state === 'alive') n++;
    return n + state.pending.length;
  }

  function spawnName(raw, opts = {}) {
    const res = resolveName(raw);
    if (!res.name) return null;
    state.boardMode = true;
    const n = Math.min(res.count, 6);
    // over cap: disperse oldest alive (v2 rule; maxAlive = MAXC unless the
    // governor's lever 5 has lowered it)
    for (let over = aliveCount() + n - maxAlive; over > 0; over--) {
      const oldest = state.creatures.find((c) => c.state === 'alive');
      if (!oldest) break;
      oldest.disperse();
    }
    let first = null;
    for (let i = 0; i < n; i++) {
      const spec = boardSpec(res, i);
      if (opts.center && n === 1) {
        // Museum pose (test.solo / a centred single shot): the creature is
        // placed on the column's axis and the VESSEL is taken to it, rather
        // than the creature being dragged to a screen-relative pose. A floor
        // dweller keeps its footing on the relief under the axis.
        const floor = spec.band && (spec.band.kind === 'rooted' || spec.band.kind === 'benthic');
        // v3.7: "the column's axis" is now the vessel's OWN x — the museum pose
        // brings the vessel to the creature's true transect position (below)
        // and stands it there, rather than dragging the creature to world x=0,
        // which on the transect is the far end of the abyssal plain.
        const cx = spec.base[0];
        const y = floor
          ? seabedYAt(cx, -60) + (spec.base[1] - seabedYAt(spec.base[0], spec.base[2]))
          : spec.base[1];
        spec.base = [cx, y, -60];
        spec.homeX = cx;
        spec.heading = Math.PI * 0.08;
        spec.speed = 0;
      }
      if (!first) {
        first = spec;
        // v3.8 — the vessel travels to a summoned creature, and that journey
        // can take 15+ seconds across the transect. For all of it the porthole
        // showed empty water with nothing marking which animal was the one you
        // asked for, so "goldfish" looked like it had produced whatever was
        // already on the board. Selecting it names it on the plate the moment
        // it forms. QUIET, so it does not raise the inspector over the ocean.
        if (opts.select !== false) spec.selectOnSpawn = true;
      }
      state.pending.push({ due: state.simT + i * SPAWN_STAGGER * (opts.now ? 0 : 1), spec });
    }
    // v3.4 — a summoned creature must be VISIBLE. If its species lives outside
    // the porthole's band ("coral" while you are at the surface), the vessel
    // goes to look: the column's own critically-damped travel does the rest, so
    // it reads as a deliberate descent, not a cut. Board loads and hash
    // restores never do this (they set the depth themselves); only an explicit
    // summons moves the vessel.
    if (column && first && opts.travel !== false) {
      ensureVisible(first.base[1], first.base[2], first.boundR * first.scale, {
        instant: !!opts.center,
        source: 'summon',
        x: first.base[0], // v3.7: and along the transect, to where it lives
      });
    }
    saveHash();
    return res;
  }

  /**
   * Bring a world point into the porthole if it is not already there. Commands
   * a SET-POINT only — the column owns the easing, so nothing here can snap the
   * camera (except the museum/test path, which asks for it explicitly).
   */
  function ensureVisible(worldY, worldZ, radiusPx, opts = {}) {
    if (!column) return false;
    const worldX = opts.x;
    const r = radiusPx * 0.6;
    const offY = column.outOfBandPx(worldY, worldZ, r);
    const offX = worldX == null ? 0 : column.outOfBandPxX(worldX, worldZ, r);
    if (!opts.instant && offY <= 0 && offX <= 0) return false;
    // v3.7 — the horizontal half first, for the same reason frameBoard does it
    // in that order: the depth stops depend on the seabed under the vessel.
    if (worldX != null && (opts.instant || offX > 0)) {
      column.setShore(column.worldXToTransect(worldX), {
        instant: !!opts.instant,
        source: opts.source || 'auto',
      });
    }
    if (opts.instant || offY > 0) {
      column.setDepth(column.worldYToMetres(worldY), {
        instant: !!opts.instant,
        source: opts.source || 'auto',
      });
    }
    return true;
  }

  // Hash derives from live state (same hash → identical board, spec §8-10):
  // one entry per species batch, count re-prefixed like v2 ("school of fish"
  // round-trips as "5 fish"). Phase D extends the schema with extra ';'
  // segments (preset + per-creature control diffs) via the controls hook;
  // plain name-list hashes remain valid input.
  const NUM_WORDS = { 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six' };
  let hashExtrasFn = null; // set by createControls
  let hashDirtyT = -1; // throttled saves (slider drags), flushed in frame()

  function boardBatches() {
    const out = [];
    const seen = new Set();
    const add = (spec) => {
      if (spec.instance !== 0 || seen.has(spec.name)) return;
      seen.add(spec.name);
      out.push({ name: spec.name, count: spec.count });
    };
    for (const c of state.creatures) if (c.state === 'alive' && c.klass !== 'legacy') add(c.spec);
    for (const p of state.pending) add(p.spec);
    return out;
  }

  function hashBody() {
    const batches = boardBatches();
    const names = batches.map((b) => (b.count > 1 ? `${NUM_WORDS[b.count]} ${b.name}` : b.name));
    const parts = names.length ? [names.join(',')] : [];
    if (hashExtrasFn) parts.push(...hashExtrasFn(batches));
    // v3.4 — the vessel's COMMANDED depth ('d=430'), so a shared board restores
    // the view as well as the creatures. Rounded to the metre: the gauge reads
    // metres, and a stable integer is what makes serialize -> restore ->
    // serialize a byte-identical round trip.
    if (column) parts.push('d=' + Math.round(column.targetDepth()));
    // v3.7 — and the vessel's COMMANDED position on the transect ('s=12400',
    // metres offshore). The same contract as 'd=': rounded to the metre so
    // serialize -> restore -> serialize is a byte-identical round trip, and
    // absent in the spike scenes, which have no column. A v3.6 hash with no
    // 's=' restores at the far offshore end, which is where v3.6's world was.
    if (column) parts.push('s=' + Math.round(column.targetShore()));
    return parts.join(';');
  }

  /** Pull 'd=<metres>' out of a hash body, or null. Static — usable before the
   *  column exists, which is exactly when the boot depth has to be known. */
  function depthFromHash(str) {
    return numFromHash(str, 'd');
  }

  /** Pull 's=<metres offshore>' out of a hash body, or null. */
  function shoreFromHash(str) {
    return numFromHash(str, 's');
  }

  function numFromHash(str, key) {
    for (const seg of String(str ?? '').split(';')) {
      const m = new RegExp('^\\s*' + key + '=(-?\\d+(?:\\.\\d+)?)\\s*$').exec(seg);
      if (m) {
        const v = parseFloat(m[1]);
        if (Number.isFinite(v)) return v;
      }
    }
    return null;
  }

  /**
   * Where the vessel surfaces when nothing in the URL says otherwise: the depth
   * that frames the most of the board. Candidates are the boarded creatures'
   * own depths (open-water species first — a board of one kelp still frames the
   * plain, but a board with anything swimming in it does not dump you on the
   * seabed just because a plant is rooted there). Ties go to the SHALLOWEST
   * candidate, so a fresh board opens nearer the light and the journey is
   * downward. Deterministic: a pure function of the board and the viewport.
   */
  function frameBoard() {
    if (!column) return;
    const specs = [];
    for (const c of state.creatures) if (c.state === 'alive' && c.spec.band) specs.push(c.spec);
    for (const p of state.pending) if (p.spec.band) specs.push(p.spec);
    if (!specs.length) return;
    const open = specs.filter((s) => s.band.kind === 'pelagic');
    const pool = open.length ? open : specs;
    // v3.7 — the same vote, over PAIRS. Each candidate is one creature's actual
    // place in the ocean, (metres down, metres offshore), and it scores the
    // number of creatures that would land inside the porthole from there. It
    // has to be the pair and not one vote per axis: voting separately picks the
    // best row and the best column of a sparse grid, and their intersection is
    // routinely empty — a board of twelve species spread over 36 km and 1200 m
    // opened on a frame with nothing in it. n <= 14, so this is 196 comparisons
    // once per board load.
    const halfM = (state.H / 2) * METRES_PER_PX;
    const halfS = (state.W / 2) * TRANSECT_METRES_PER_PX;
    const r = column.range(); // shared object — read the two numbers now
    const lo = r.min;
    const hi = r.max;
    const sr = column.shoreRange();
    // sorted shallowest-first, then most-inshore: with a strictly-greater test
    // below, ties go to the stop nearest the light and nearest the coast, so a
    // fresh board opens where the journey begins rather than where it ends.
    const cands = pool
      .map((s) => ({ d: s.depthM, t: s.transectM ?? sr.max }))
      .sort((a, b) => a.d - b.d || a.t - b.t);
    let bestD = cands[0].d;
    let bestS = cands[0].t;
    let bestN = -1;
    for (const c of cands) {
      // where the vessel would actually sit: the depth stops depend on the
      // seabed under THAT stretch of transect, so the shore clamp comes first
      const st = c.t < sr.min ? sr.min : c.t > sr.max ? sr.max : c.t;
      const floorHere = column.profileDepthAt(st);
      const dHi = Math.min(hi, Math.max(floorHere * 0.75, lo));
      const d = c.d < lo ? lo : c.d > dHi ? dHi : c.d;
      let n = 0;
      for (const s of specs) {
        const rad = s.boundR * s.scale * 0.55;
        if (
          Math.abs(s.depthM - d) <= halfM + rad * METRES_PER_PX
          && Math.abs((s.transectM ?? sr.max) - st) <= halfS + rad * TRANSECT_METRES_PER_PX
        ) n++;
      }
      if (n > bestN) {
        bestN = n;
        bestD = c.d;
        bestS = c.t;
      }
    }
    // shore first: the navigable DEPTH range depends on the local seabed, so
    // commanding the depth against the wrong stretch of transect would clamp it
    // against a floor the vessel is about to leave.
    column.setShore(bestS, { instant: true, source: 'frame' });
    column.setDepth(bestD, { instant: true, source: 'frame' });
  }

  function saveHash() {
    if (!state.boardMode) return;
    hashDirtyT = -1;
    const body = hashBody();
    try {
      history.replaceState(null, '', body ? '#' + encodeURIComponent(body) : location.pathname + location.search);
    } catch {
      /* about:blank / file contexts */
    }
  }

  function requestSave() {
    if (hashDirtyT < 0) hashDirtyT = state.simT;
  }

  function loadBoard(csv, opts = {}) {
    releaseAll();
    state.spawnSlot = 0;
    state.boardMode = true;
    const names = String(csv)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAXC);
    // Loading a board is not a summons: it must never yank the vessel around
    // once per name. The caller (boot / restore) sets the depth once, after.
    for (const n of names) spawnName(n, { travel: false, ...opts });
  }

  function releaseAll() {
    for (const c of state.creatures) {
      scene.remove(c.points);
      c.dispose();
    }
    state.creatures = [];
    state.pending = [];
    state.focus = null;
  }

  function setScene(name) {
    releaseAll();
    state.boardMode = false;
    for (const spec of sceneSpecs(name)) {
      const c = new Creature(spec);
      state.creatures.push(c);
      scene.add(c.points);
      if (spec.focus) state.focus = c;
    }
    if (!state.focus && state.creatures.length) state.focus = state.creatures[0];
  }

  // ---- ambient plankton: one 400-dot Points, drifting ---------------------
  // Board-mode only: the Phase B spike scenes (?scene=) are a pixel-level
  // harness contract (soak decay-to-black, pileup blowout bound) and must not
  // gain a persistent emitter.
  const plankton = (() => {
    const N = 400;
    const rng = mulberry32(0xabad1dea);
    const bx = new Float32Array(N);
    const by = new Float32Array(N);
    const bz = new Float32Array(N);
    const vx = new Float32Array(N);
    const vy = new Float32Array(N);
    const ph = new Float32Array(N);
    const hw = state.W / 2 + 150;
    const hh = state.H / 2 + 100;
    for (let i = 0; i < N; i++) {
      bx[i] = (rng() * 2 - 1) * hw;
      by[i] = (rng() * 2 - 1) * hh;
      bz[i] = Z_MIN - 60 + rng() * (Z_MAX - Z_MIN + 90);
      vx[i] = 3 + 7 * rng();
      vy[i] = (rng() * 2 - 1) * 2.5;
      ph[i] = rng() * TAU;
    }
    const pos = new Float32Array(N * 3);
    const nor = new Float32Array(N * 3);
    const aSize = new Float32Array(N);
    const aTw = new Float32Array(N);
    const aRing = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let nx = rng() * 2 - 1;
      let ny = rng() * 2 - 1;
      let nz = rng() * 2 - 1;
      const il = 1 / Math.max(Math.hypot(nx, ny, nz), 1e-4);
      nor[i * 3] = nx * il;
      nor[i * 3 + 1] = ny * il;
      nor[i * 3 + 2] = nz * il;
      const vd = (camDist - bz[i]) / REF_DIST;
      aSize[i] = (1.6 + 1.6 * rng()) * vd;
      aTw[i] = rng();
      aRing[i] = rng();
    }
    const g = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', posAttr);
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
    g.setAttribute('aTw', new THREE.BufferAttribute(aTw, 1));
    g.setAttribute('aRing', new THREE.BufferAttribute(aRing, 1));
    const material = createDotMaterial(globalUniforms);
    material.uniforms.uColor.value.setRGB(0.62, 0.84, 1.0);
    material.uniforms.uAlpha.value = 0.4;
    material.uniforms.uFormation.value = 1;
    const points = new THREE.Points(g, material);
    points.frustumCulled = false;
    const wrap = (v, half) => {
      const span = half * 2;
      let m = (v + half) % span;
      if (m < 0) m += span;
      return m - half;
    };
    // v3.4: the field is wrapped around the CAMERA's height, not around world
    // y = 0. Each speck still has a fixed world trajectory; it is simply drawn
    // at the lattice image nearest the porthole (a whole-period shift, which is
    // off-screen by construction), so the water is full of motes at every depth
    // instead of leaving them all glued to the surface. Identical to v3.3 when
    // vy is 0 — the spike scenes never run this anyway.
    // v3.7: the same lattice trick on the horizontal axis. Each speck keeps a
    // fixed world trajectory and is drawn at the image nearest the porthole —
    // a whole-period shift, off-screen by construction — so the water is full
    // of motes 18 km inshore too, and they still slide past you as you travel
    // instead of being glued to the glass.
    function update(t, viewY = 0, viewX = 0) {
      for (let i = 0; i < N; i++) {
        pos[i * 3] = viewX + wrap(bx[i] + vx[i] * t - viewX, hw);
        pos[i * 3 + 1] =
          viewY + wrap(by[i] + vy[i] * t + 9 * Math.sin(0.4 * t + ph[i]) - viewY, hh);
        pos[i * 3 + 2] = bz[i];
      }
      posAttr.needsUpdate = true;
      material.uniforms.uTime.value = t;
    }
    update(0);
    return { points, update };
  })();
  plankton.enabled = !params.get('scene');
  if (plankton.enabled) scene.add(plankton.points);

  // ---- v3.4 the water column ---------------------------------------------
  // Board mode only, for exactly the reason the plankton and the atmosphere
  // are: the Phase B spike scenes (?scene=) are a pixel-level harness contract
  // (soak decay-to-black, pileup blowout bound, the duo/eel/ray framing) and
  // they are authored against a camera at y = 0 with no boundary sheets. With
  // no column the camera never leaves y = 0, no sheet is ever built and no
  // depth composition runs, so every one of those contracts holds unchanged.
  // The FRAMES are not byte-identical to v3.3 and the claim that they were was
  // wrong: createBackground runs in every mode and the v3.4 plate is the depth
  // -aware column evaluated at DEFAULT_DEPTH_M, which is a different (dimmer,
  // bluer) water than v3.3's fixed gradient — the soak scenario's creature-free
  // baseline moved from maxChannel 18 to 66 on that account alone. Every Phase B
  // assertion is relative (decay against that baseline, blown fraction), which
  // is why they still pass. Keep it that way: anything added to the plate from
  // here on has to be gated off at DEFAULT_DEPTH_M the way the scattered
  // daylight and the bioluminescent field are, or a spike scene inherits it.
  //
  // Built BEFORE the pipeline so renderer.compile() prewarms the two sheets'
  // materials with everything else (they reuse the one dot program — frame
  // graph rule 7 — but the prewarm still wants the objects in the scene).
  const bootHash = decodeURIComponent(location.hash.slice(1));
  const bootDepthM = depthFromHash(bootHash);
  const bootShoreM = shoreFromHash(bootHash);
  if (plankton.enabled) {
    column = createColumn(scene, globalUniforms, {
      canvas,
      width: state.W,
      height: state.H,
      camDist,
      depth: bootDepthM != null ? bootDepthM : DEFAULT_DEPTH_M,
      shore: bootShoreM != null ? bootShoreM : DEFAULT_SHORE_M,
      layers: true,
      nav: true,
      onCamera: () => applyCamera(),
    });
    // depthbands.js is authored entirely in metres and learns the metre <->
    // world-px scale (and the seabed relief) from exactly here. ONE definition
    // of the scale, in column.js; every other module reads it.
    setDepthUnits(column);
    // Any commanded depth change belongs in the URL, throttled like a slider
    // drag (this fires on the SET-POINT, not on the eased position, so a dive
    // writes the hash once and not sixty times a second).
    column.onDepthChange(() => requestSave());
    column.onShoreChange(() => requestSave()); // v3.7, the same contract
    applyCamera();
  }

  // ---- Phase E atmosphere: caustic shafts (-20) / AO pools (-10) / sediment
  // motes (0), board mode only — the Phase B spike scenes (?scene=) are a
  // pixel-level harness contract and must stay atmosphere-free, exactly like
  // the plankton above. Created before the pipeline so compile() prewarms its
  // two small shaders with everything else. Layer intensities boot at the
  // moonlit preset (the default weather); controls.applyScene drives them on
  // every preset crossfade thereafter.
  const rootedScratch = []; // reused every frame — ao.js reads it synchronously
  const atmosphere = plankton.enabled
    ? createAtmosphere(scene, globalUniforms, {
        seed: 0x0a7305fe,
        width: state.W,
        height: state.H,
        camDist,
        zRange: [Z_MIN, Z_MAX],
        getRooted: () => {
          rootedScratch.length = 0;
          for (const c of state.creatures) if (c.klass === 'rooted') rootedScratch.push(c);
          return rootedScratch;
        },
      })
    : null;
  if (atmosphere) {
    const p0 = PRESETS.moonlit;
    atmosphere.caustics.setIntensity(p0.caustics);
    atmosphere.sediment.setIntensity(p0.sediment);
    atmosphere.ao.setIntensity(p0.ao);
  }

  // ---- same-species schooling (v2 rule, in 3D): always separate, pull
  // toward same-name neighbors; anchors move, sine-wander rides on top ------
  function applySchooling(dt) {
    const sw = [];
    for (const c of state.creatures) {
      if (c.state === 'alive' && c.klass !== 'rooted' && c.klass !== 'legacy' && c.ctrl.behavior !== 'sleep') sw.push(c);
    }
    for (let i = 0; i < sw.length; i++) {
      for (let j = i + 1; j < sw.length; j++) {
        const a = sw[i];
        const b = sw[j];
        const dx = b.px - a.px;
        const dy = b.py - a.py;
        const dz = b.pz - a.pz;
        const dist = Math.hypot(dx, dy, dz) || 1;
        const min = (a.rad + b.rad) * 0.72;
        const ux = dx / dist;
        const uy = dy / dist;
        const uz = dz / dist;
        if (dist < min) {
          const push = ((min - dist) / min) * 22 * dt;
          a.px -= ux * push;
          a.py -= uy * push;
          a.pz -= uz * push;
          b.px += ux * push;
          b.py += uy * push;
          b.pz += uz * push;
        } else if (
          dist < 560 &&
          ((a.spec.name && a.spec.name === b.spec.name) ||
            a.ctrl.behavior === 'school' ||
            b.ctrl.behavior === 'school')
        ) {
          const pull = 7 * dt;
          a.px += ux * pull;
          a.py += uy * pull;
          a.pz += uz * pull;
          b.px -= ux * pull;
          b.py -= uy * pull;
          b.pz -= uz * pull;
        }
      }
    }
  }

  // ---- boot mode flags (the load itself runs after controls exist, so the
  // extended #hash schema can restore control values + preset) --------------
  const sceneParam = params.get('scene');
  const boardParam = params.get('board');
  const hashBoard = decodeURIComponent(location.hash.slice(1));

  // ---- Bathyscaphe chrome (src/ui/*) mounts after the boot board exists
  // (below). Spike-scene mode (?scene=) never mounts the UI and hides the
  // static summon row so the Phase B screenshots stay pixel-clean.
  if (sceneParam) {
    const form = document.getElementById('summon');
    if (form) form.style.display = 'none';
  }

  // cursor world point at the z=0 plane (1:1 CSS px) — 'follow' behavior.
  // v3.4: the screen is a porthole into a moving column, so the vertical half
  // of the mapping is relative to the camera's height, not to world y = 0.
  // v3.7: and the horizontal half is relative to the camera's own X, for the
  // same reason — the porthole now travels sideways too.
  window.addEventListener('pointermove', (e) => {
    state.cursor.x = e.clientX - state.W / 2 + camX();
    state.cursor.y = state.H / 2 - e.clientY + camY();
  });

  // ---- pipeline (created after creatures exist so compile() prewarms) -----
  // exposure trimmed 4.2 -> 3.4 so a 12-creature board glows without washing
  // out (tuning pass; single-creature scenes stay clearly readable)
  const pipeline = createPipeline(renderer, scene, camera, {
    exposure: parseFloatOr(params.get('exposure'), 3.4),
    trailsK: parseFloatOr(params.get('trails'), 0.25),
  });

  // ---- Phase D controls (engine-side plumbing; the UI codes against it) ---
  controls = createControls({
    state,
    camera,
    canvas,
    getCamDist: () => camDist,
    // v3.7: a horizontal pan over the porthole ends in a click. The column
    // holds `dragging()` true through that click so navigating the transect
    // never deselects what you were looking at.
    canSelect: () => !column || !column.dragging(),
    globalUniforms,
    pipeline,
    plankton,
    atmosphere,
    spawnName,
    releaseAll,
    loadBoard,
    saveHash,
    requestSave,
    hashBody,
    setHashExtras: (fn) => {
      hashExtrasFn = fn;
    },
  });

  // ---- boot mode: ?scene= (Phase B spike) > ?board= > #hash > default -----
  // v3.4 adds the vertical half of "boot": the vessel's depth. A hash that
  // carries 'd=' pins it (a shared board restores the VIEW, not just the
  // creatures); anything else frames the board it just loaded. Board loads
  // never glide — only an explicit summons moves the vessel — so this is the
  // one place the depth is set from the board.
  if (sceneParam) {
    setScene(sceneParam);
  } else if (boardParam) {
    loadBoard(boardParam, { travel: false });
    frameBoard();
  } else if (hashBoard.trim()) {
    controls.restore(hashBoard); // extended schema; plain name lists still work
    // v3.7: a hash that pins only one axis still has the other framed on the
    // board, so a v3.6 link (no 's=') opens looking at its own creatures rather
    // than at the empty far end of the transect.
    if (bootDepthM == null || bootShoreM == null) {
      const keepD = bootDepthM != null ? column && column.targetDepth() : null;
      const keepS = bootShoreM != null ? column && column.targetShore() : null;
      frameBoard();
      if (keepD != null) column.setDepth(keepD, { instant: true, source: 'hash' });
      if (keepS != null) column.setShore(keepS, { instant: true, source: 'hash' });
    }
  } else {
    // The default board is the TRANSECT, because that is what the world is now:
    // a sea otter in the kelp 2 km out, a dolphin working the sunlit water over
    // the shelf, a jellyfish pulsing in the twilight past the break, and an
    // anglerfish out over the slope. It boots framed on the most of them, which
    // puts you on the shelf with the coast to your left and the drop to your
    // right — the two ends of the journey both visible as directions.
    loadBoard('sea otter,dolphin,kelp,jellyfish,anglerfish', { travel: false });
    frameBoard();
  }

  // ---- Bathyscaphe UI chrome (Phase D) — mounted ONCE, after the boot board
  // is loaded so labels can seed its id->name registry from the serialized
  // hash (and so the boot restore goes through the undecorated controls).
  // Never mounted in spike-scene mode. Chrome stays hidden until the first
  // rendered frame via body.booted (see chrome.css).
  let ui = null;
  if (!sceneParam) {
    ui = {
      labels: initLabels(controls), // decorates controls.summon/restore
      summon: initSummon(controls),
      plate: initPlate(controls),
      rotary: initRotary(controls),
      ambient: initAmbient(), // registers __menagerie.ui.forceAmbient
      // v3.4 — the vessel's depth instrument, down the left edge. It reads the
      // column and writes SET-POINTS to it; the column owns all easing.
      depthGauge: initDepthGauge(column),
      // v3.7 — the vessel's CROSS-SHELF instrument, along the bottom edge. It
      // draws the bathymetric profile as a dotted contour with the vessel's
      // mark riding it, and writes set-points the same way the depth gauge
      // does: the column owns every metre of easing on both axes.
      shoreGauge: initShoreGauge(column),
      // v3.6 — the specimen inspector. Clicking a creature raises a modal with
      // the animal itself on the left, turnable to any angle, and its record
      // on the right. It runs its OWN small renderer on its own canvas, so the
      // board's HDR/trails/bloom chain is untouched by it.
      // ?inspector=off keeps selection from raising the modal — the harness
      // drives the plate directly, and an auto-raised modal would cover it.
      inspector: initInspector(controls, {
        state,
        openOnSelect: params.get('inspector') !== 'off',
      }),
    };
    // v3.4 — selecting a creature that is not in the porthole takes the vessel
    // to it. Clicking one you can see never moves the camera (it is in band by
    // definition), so this only fires for a programmatic / off-screen select,
    // where the alternative is a gauge plate anchored to nothing.
    controls.onSelectionChange((snap) => {
      if (!snap || !column) return;
      for (const c of state.creatures) {
        if (c.id !== snap.id || c.state !== 'alive') continue;
        ensureVisible(c.points.position.y, c.points.position.z, c.rad, {
          source: 'select',
          x: c.points.position.x,
        });
        break;
      }
    });
    // ---- v3.2: the gather beacon + snapshot/record (board mode only; spike
    // scenes stay pixel-clean and listener-free). Empty-water clicks are
    // told apart from creature clicks via controls' own hit-test. A click
    // summons EVERY swimmer and drifter; rooted flora lean toward it and
    // sleepers never wake (both handled inside gather.steer).
    gather = initGather({
      scene,
      canvas,
      state,
      getCamDist: () => camDist,
      getCamY: camY, // v3.4: a click maps to world at the PORTHOLE's height
      getCamX: camX, // v3.7: ...and at its position along the transect
      globalUniforms,
      hitTest: (x, y) => controls.hitTest(x, y),
      canDrop: () => !column || !column.dragging(),
    });
    capture = initCapture(canvas, pipeline);
  }

  // ---- Phase F adaptive quality governor (F2 ladder — src/governor.js) ----
  // Hard-off under ?fixedstep=1 (harness contract: screenshots must never
  // show a degraded scene, and SwiftShader wall time would instantly floor
  // every lever) or ?governor=off; telemetry.reason says which.
  const fixedStep = params.get('fixedstep') === '1';
  const govOffParam = params.get('governor') === 'off';
  // Levers 1+2 share the pipeline's one backing-size input: backing =
  // css x min(dpr, dprCap) x renderScale, expressed through setRenderScale
  // (which still enforces the spec's 0.5 renderScale floor). On dpr <= 1
  // screens the DPR-cap lever is correctly a no-op.
  let govScale = 1;
  let govDprCap = 1.5;
  let govSprite = 1;
  const glMaxPointPx = globalUniforms.uMaxPointPx.value; // GL cap, queried at boot
  function applyGovSprite() {
    // lever 3: 30% off the effective app sprite cap (APP_CAP_PX = 32 CSS px in
    // shaders/dots.js, x uDpr device ratio), never above the GL-queried max
    globalUniforms.uMaxPointPx.value =
      govSprite >= 1 ? glMaxPointPx : Math.min(32 * globalUniforms.uDpr.value, glMaxPointPx) * govSprite;
  }
  function applyGovBacking() {
    const dpr = window.devicePixelRatio || 1;
    pipeline.setRenderScale(govScale * (Math.min(dpr, govDprCap) / Math.min(dpr, 1.5)));
    globalUniforms.uDpr.value = renderer.getPixelRatio();
    applyGovSprite(); // the sprite cap is in device px — track the ratio change
  }
  const governor = createGovernor({
    off: fixedStep || govOffParam,
    reason: govOffParam ? 'governor=off' : fixedStep ? 'fixedstep' : null,
    hooks: {
      renderScale: (v) => {
        govScale = v;
        applyGovBacking();
      },
      dprCap: (v) => {
        govDprCap = v;
        applyGovBacking();
      },
      spriteCap: (v) => {
        govSprite = v;
        applyGovSprite();
      },
      density: (v) => {
        // lever 4 — render-fraction ONLY (drawRange over the cross-ring
        // shuffle, applied inside applyCtrlVisual; geometry is never rebuilt)
        state.govDensity = v;
        for (const c of state.creatures) c.applyCtrlVisual();
      },
      creatureCap: (v) => {
        // lever 5 — cap 14 -> 10; oldest alive disperse (v2 rule). Releasing
        // back to 14 only raises the allowance; nothing respawns.
        maxAlive = v;
        for (let over = aliveCount() - v; over > 0; over--) {
          const oldest = state.creatures.find((c) => c.state === 'alive');
          if (!oldest) break;
          oldest.disperse();
        }
      },
    },
  });

  function onResize() {
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    state.W = w;
    state.H = h;
    updateCameraDistance(h);
    // The column's navigable range and both boundary sheets are functions of
    // the viewport; resize() re-derives every one of them arithmetically (no
    // RNG draws), so the world survives a resize byte-identically.
    if (column) column.resize(w, h, camDist);
    pipeline.resize(w, h);
    if (atmosphere) atmosphere.resize(w, h);
    // the row -> depth mapping of the background plate is per viewport height
    background.resize(w, h);
    globalUniforms.uDpr.value = renderer.getPixelRatio();
    applyGovSprite(); // governor sprite cap is in device px — track uDpr
    // Fog is relative to the z=0 creature plane (uFogRef = camDist): the plane
    // is unfogged and relative depth is viewport-invariant by construction, so
    // the old 540/h normalization is retired. v3.4 gives uFogScale a job again
    // — depth's multiplier on the preset's density — written every frame in
    // frame(); it is NOT reset here, or a resize would flash the abyss clear.
    globalUniforms.uFogRef.value = camDist;
  }
  window.addEventListener('resize', onResize);
  onResize();

  // ---- HUD (dev only, ?hud=1) --------------------------------------------
  let hudEl = null;
  if (params.get('hud') === '1') {
    hudEl = document.createElement('div');
    hudEl.style.cssText =
      'position:fixed;top:8px;left:8px;z-index:9;color:rgba(220,235,255,.75);' +
      'font:11px ui-monospace,Menlo,monospace;white-space:pre;pointer-events:none';
    document.body.appendChild(hudEl);
  }
  function updateHud() {
    if (!hudEl) return;
    const g = governor.telemetry;
    const gov = g.off
      ? `gov OFF (${g.reason})`
      : `gov L${g.level}${g.engaged.length ? ' [' + g.engaged.join(',') + ']' : ''}`;
    hudEl.textContent =
      `${stats.lastFrameCpuMs.toFixed(2)} ms cpu  ` +
      `${state.creatures.length} creatures\n` +
      `${gov}  p50 ${g.framesMsP50.toFixed(1)} ms\n` +
      pipeline.info.rendererString;
  }

  // ---- clock (frame-graph rule 11: the ONE place wall time is read) -------
  // (fixedStep itself is declared with the governor above, which needs it)
  const nowMs = () => performance.now();
  const stats = { lastFrameCpuMs: 0 };
  let booted = false; // chrome is revealed after the first rendered frame

  // ---- v3.7: the atmosphere follows the vessel along the transect ----------
  //
  // Two layers are authored around world x = 0 and would simply be left behind
  // once the vessel travels 18,000 px inshore. They are moved by setting the
  // object's own x, which costs nothing and touches no other module — but they
  // are moved DIFFERENTLY, because they are different kinds of field:
  //
  //   * SEDIMENT is a periodic world lattice (that is the whole point of it —
  //     a mote holds still in the water while you descend past it). Its x wrap
  //     has period 2 x hw, so shifting the object by a WHOLE NUMBER of periods
  //     is exactly invisible: the field is identical, and the motes keep their
  //     parallax against the seabed. Same trick sediment.js already plays on
  //     the vertical axis, applied from outside.
  //   * CAUSTICS are already camera-anchored vertically (their surface plane is
  //     computed as an offset from the porthole, not from world y = 0), so they
  //     ride the camera horizontally too. Shafts are light on the surface film;
  //     there is no parallax claim to break.
  let sedPeriod = 0;
  let sedShift = 0;
  function followCamX(vx) {
    const sed = atmosphere && atmosphere.sediment ? atmosphere.sediment.points : null;
    if (sed) {
      if (sedPeriod <= 0) sedPeriod = (state.W / 2 + 120) * 2;
      const k = Math.round(vx / sedPeriod) * sedPeriod;
      if (k !== sedShift) {
        sedShift = k;
        sed.position.x = k;
      }
    }
    const caus = atmosphere && atmosphere.caustics ? atmosphere.caustics.mesh : null;
    if (caus) caus.position.x = vx;
  }

  // v3.4 per-frame scratch — filled once per frame, never allocated on the path
  const depthSample = createDepthSample();
  const STEER_SOFT = { scale: 0.25 }; // band hold while a summons has the floor
  // Set by test.setTrails: once a test has taken the trail length by hand, the
  // depth composition stops writing it (the soak scenarios pin k = 0.99 and
  // then measure decay — depth must not fight them). Never set in normal use.
  let trailsLocked = false;
  let lastWeatherR = -1;
  let lastWeatherG = -1;
  let lastWeatherB = -1;
  let lastWeatherGain = -1;
  let lastAtmDepth = -1e9;
  let lastBioGain = -1;
  // v3.7 — set by test.setBioGain(), the layer's documented on/off A/B switch.
  // Same contract as trailsLocked: once a harness takes the dimmer by hand the
  // depth driver below stops writing it for the rest of the page's life.
  let bioLocked = false;

  function frame(dt) {
    const t0 = nowMs();
    background.update(state.simT);
    if (controls) controls.tick(dt); // preset crossfade, current, selection
    // ---- the vessel moves FIRST: everything below reads its new height -----
    if (column) column.update(dt, state.simT);
    const vy = camY();
    const vx = camX();
    if (column) {
      const depthM = column.depth(); // eased position, not the set-point
      // Depth MULTIPLIES the already-crossfaded weather, it never replaces it
      // (depthprofile.js's rule). Every multiplier is 1.0 at 120 m, so a
      // preset switch still crossfades exactly as it did in v3.3 and a dive
      // reads THROUGH a weather change instead of fighting it.
      sampleDepth(depthM, depthSample);
      const live = controls.liveScene(); // shared object — read, don't retain
      globalUniforms.uFogScale.value = depthSample.fogScale;
      composeFogTintInto(live.fogTint, depthSample, globalUniforms.uFogTint.value);
      // Trails: the preset says how streaky the weather is, depth says how fast
      // that streak must die. In sunlit water the background sits ABOVE the
      // trails pass's 8/255 epsilon window, so the epsilon that keeps a tail
      // crisp never fires and every mote grows a comet tail; the depth profile
      // pays for the brightness with a faster fade. Identity below ~120 m.
      if (!trailsLocked) pipeline.setTrails(composeTrailsK(live.trailsK, depthSample));
      background.setDepth(depthM);
      // the preset's light as HUE only; depth decides how much light there is
      const lc = live.lightColor;
      if (lc[0] !== lastWeatherR || lc[1] !== lastWeatherG || lc[2] !== lastWeatherB || live.gain !== lastWeatherGain) {
        lastWeatherR = lc[0];
        lastWeatherG = lc[1];
        lastWeatherB = lc[2];
        lastWeatherGain = live.gain;
        background.setWeather(lc, live.gain);
      }
      // the atmosphere layers re-derive a keyframe sample on every setDepth, so
      // only tell them when the vessel has actually moved a measurable amount
      if (atmosphere && Math.abs(depthM - lastAtmDepth) > 0.02) {
        lastAtmDepth = depthM;
        atmosphere.setDepth(depthM);
      }
      // v3.7 — the one global dimmer on the bioluminescent layer. It is a
      // GAUGE of the water, not part of any animal: a lure is nearly invisible
      // against a sunlit inner shelf and unmistakable at 600 m, which is
      // exactly what makes travelling inshore change what you can see. Because
      // the shore end of the transect is also its shallow end, this is already
      // correct along the horizontal axis with no horizontal term.
      const bg = bioLocked ? lastBioGain : bioDepthGain(depthM);
      if (bg !== lastBioGain) {
        lastBioGain = bg;
        setBioMaster(globalUniforms, bg);
      }
    }
    if (gather) gather.update(state.simT, dt); // v3.2 beacon (injectable clock)
    // staggered formation ramp: promote due pending spawns
    while (state.pending.length && state.pending[0].due <= state.simT) {
      const { spec } = state.pending.shift();
      const c = new Creature(spec);
      state.creatures.push(c);
      scene.add(c.points);
      if (spec.selectOnSpawn && controls) controls.select(c.id, { quiet: true });
    }
    const sway = state.sway * (state.turbulence ?? 1);
    const cullMargin = state.H * CULL_MARGIN_SCREENS;
    const beacon = gather ? gather.point() : null;
    const reach = state.H * GATHER_REACH_SCREENS;
    for (let i = state.creatures.length - 1; i >= 0; i--) {
      const c = state.creatures[i];
      let visible = true;
      if (column && c.klass !== 'legacy') {
        // v3.7: reach is a distance in the water, not a difference in depth —
        // a creature 20 km along the transect is not "near" the beacon just
        // because it happens to be at the same depth.
        c.inReach =
          !beacon || (Math.abs(c.py - beacon.y) <= reach && Math.abs(c.px - beacon.x) <= reach * 1.8);
        // Hold station in the species' own water BEFORE the class motion reads
        // c.py — this is what makes creatures STAY at their depth while the
        // vessel travels past them. While the gather beacon owns a creature the
        // hold is softened rather than switched off, so the two negotiate and
        // the hand-back at the end of the summons has no discontinuity.
        if (c.ctrl.behavior !== 'sleep') {
          steerDepth(c, state.simT, dt, beacon && c.inReach ? STEER_SOFT : null);
        }
        // v3.7: cull on BOTH axes. A board now spreads across 36 km of ocean,
        // so the horizontal test is doing most of the work — without it every
        // creature on the transect would pay for its skeleton every frame while
        // 18 of the 19 screens it lives on are off camera.
        visible = column.inViewXY(c.px, c.py, c.pz, c.rad, cullMargin);
      } else {
        c.inReach = true;
      }
      if (!c.update(state.simT, dt, sway, visible)) {
        scene.remove(c.points);
        c.dispose();
        state.creatures.splice(i, 1);
        if (state.focus === c) state.focus = null;
      }
    }
    if (state.boardMode) applySchooling(dt);
    // Backstop: schooling writes c.py directly, so nothing — not a shove from a
    // neighbour, not a control — can strand a dolphin in the abyss even for one
    // frame. Cheap, blunt, and it only ever fires at the band edges. Creatures
    // the beacon currently owns are exempt: while they are answering a summons
    // the summons is allowed to win.
    if (column) {
      const summoning = !!beacon;
      for (const c of state.creatures) {
        if (!c.band || c.state !== 'alive') continue;
        if (summoning && c.inReach) continue;
        clampToBand(c, 25);
        // v3.7 — the horizontal backstop, the exact twin of the one above. A
        // reef fish cannot end up over the abyssal plain because a school
        // shove or an hour of roaming carried it there.
        clampToTransect(c, state.W);
      }
    }
    if (plankton.enabled) {
      // plankton time-warp: the weather's current speeds the drift up
      state.planktonT += dt * (state.planktonRate ?? 1);
      plankton.update(state.planktonT, vy, vx);
    }
    // Phase E atmosphere rides the same injectable clock; the weather's
    // current (px/s, set by controls.tick) drives shaft sway + mote drift
    if (atmosphere) {
      atmosphere.update(state.simT, state.current ?? 0);
      followCamX(vx);
    }
    if (hashDirtyT >= 0 && state.simT - hashDirtyT >= 0.3) saveHash();
    globalUniforms.uFocusZ.value = state.focus
      ? camDist - state.focus.points.position.z
      : state.boardMode
        ? camDist - Z_MID * 0.5
        : camDist;
    // frame-graph rule 4: camera motion flushes screen-space trail history
    // instead of streaking it. Hardcoded 0 until v3.4, because the camera
    // could not move; the column reports its vertical travel in world px,
    // which at the z = 0 plane is exactly CSS px.
    //
    // The MAGNITUDE is what rule 4 asks for. deltaPx() is signed and descending
    // makes it negative (depth grows downward, world y shrinks), while
    // computeFadeK clamps its argument at 0 — so passing the raw delta would
    // flush history on ascents and streak every dive, which is the direction
    // the vessel spends most of its time travelling.
    pipeline.render(dt, column ? Math.abs(column.deltaPx()) : 0);
    if (!booted) {
      booted = true;
      document.body.classList.add('booted'); // chrome surfaces after frame 1
    }
    stats.lastFrameCpuMs = nowMs() - t0;
    updateHud();
  }

  function stepMany(n, dt) {
    for (let i = 0; i < n; i++) {
      state.simT += dt;
      frame(dt);
    }
  }

  if (!fixedStep) {
    let prev = nowMs();
    const tick = () => {
      const t = nowMs();
      const rawMs = t - prev; // REAL frame delta — the governor's evidence
      prev = t;
      const dt = Math.min(rawMs / 1000, 0.05);
      state.simT += dt;
      frame(dt);
      // presentation-time telemetry + F2 ladder; values are handed in so the
      // wall clock is still read in exactly one place (rule 11)
      governor.tick(rawMs, t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } else {
    frame(0); // one settled frame so the canvas is composited before stepping
  }

  // ---- test surface -------------------------------------------------------
  // spread preserves keys registered before this assignment (ambient.js
  // attaches __menagerie.ui.forceAmbient at UI mount, above)
  window.__menagerie = {
    ...(window.__menagerie || {}),
    rendererString: pipeline.info.rendererString,
    clock: { fixed: fixedStep, stepMany },
    controls, // Phase D control API (the UI chrome's contract)
    gather, // v3.2 beacon (null in spike scenes): setPoint / clear / info / steer
    capture, // Phase E I/O (null in spike scenes): snapshotPNG / toggleRecording
    atmosphere, // Phase E layers (null in spike scenes): caustics/sediment/ao
    // v3.5 debug/harness surface: the substrate resolver and unit wiring, so a
    // test can prove a rooted creature is standing on the ground it should be.
    depth: { floorYAt, units: () => depthUnits() },
    column, // v3.4 water column (null in spike scenes) — createColumn's API
    // Phase F telemetry (live object, mutated in place): {level, framesMsP50,
    // engaged:[...], off, reason} — off===true (reason 'fixedstep' or
    // 'governor=off') means no lever can ever move this session
    governor: governor.telemetry,
    test: {
      setScene,
      spawn: (name) => spawnName(name),
      aliveCount, // alive + pending population (Phase D harness)
      board: (csv) => loadBoard(csv),
      solo: (name) => {
        releaseAll();
        state.boardMode = true;
        spawnName(name, { center: true, now: true });
      },
      setSway: (v) => {
        state.sway = v;
      },
      creaturePos: (id) => {
        const c = state.creatures.find((cc) => cc.id === id && cc.state === 'alive');
        return c ? { x: c.px, y: c.py, z: c.pz } : null;
      },
      // v3.2 gather harness hook: every alive creature's id/class/position,
      // so a test can assert the WHOLE menagerie converged (and that a
      // sleeper did not move).
      creatureList: () =>
        state.creatures
          .filter((c) => c.state === 'alive')
          .map((c) => ({ id: c.id, klass: c.klass, behavior: c.ctrl.behavior, x: c.px, y: c.py, z: c.pz })),
      setPlankton: (alpha) => {
        plankton.points.material.uniforms.uAlpha.value = alpha;
      },
      // Taking the trail length by hand also takes it away from the depth
      // profile for the rest of the page's life (see trailsLocked).
      setTrails: (k) => {
        trailsLocked = true;
        pipeline.setTrails(k);
      },
      /** v3.7 — force the GLOBAL bioluminescent dimmer (biolum.js's
       *  setBioMaster). This is the layer's documented A/B switch: 0 is
       *  bit-for-bit v3.6, i.e. the same animal with its lamps off and its
       *  counter-shading gone. Locks out the depth driver for the rest of the
       *  page's life, exactly like setTrails. */
      setBioGain: (g) => {
        bioLocked = true;
        lastBioGain = g;
        setBioMaster(globalUniforms, g);
      },
      // dev/harness lever check: walks the real F2 ladder to level n,
      // bypassing hysteresis (explicit call only — never fires on its own)
      setGovernorLevel: (n) => governor.force(n),
      releaseAll,
      setCameraYaw: (rad) => {
        camYaw = rad;
        applyCamera();
      },
      setLightAzimuth: (az) => {
        const el = 0.85;
        globalUniforms.uLightDir.value
          .set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az))
          .normalize();
      },
      // ---- v3.4 water column harness hooks --------------------------------
      /** Command a depth in metres. `instant` bypasses the vessel's easing —
       *  use it to place the camera, never to test that the easing exists. */
      setDepth: (m, instant) =>
        column ? column.setDepth(m, { instant: !!instant, source: 'test' }) : null,
      /** v3.7 — command a position along the transect, metres offshore. Same
       *  contract as setDepth: `instant` bypasses the vessel's easing. */
      setShore: (m, instant) =>
        column ? column.setShore(m, { instant: !!instant, source: 'test' }) : null,
      /** Eased (live) transect position, the set-point, the rate, the stops and
       *  the LOCAL seabed depth under the vessel — the assertion surface for
       *  "travelling inshore is a real journey over a real profile". */
      shoreInfo: () => {
        if (!column) return null;
        const r = column.shoreRange();
        const i = column.info();
        return {
          shore: column.shore(),
          target: column.targetShore(),
          rate: column.shoreRate(),
          camX: column.camX(),
          min: r.min,
          max: r.max,
          break: r.break,
          breakDepth: r.breakDepth,
          plain: r.plain,
          zone: column.shoreZoneAt(column.shore()).id,
          floorM: i.floorM,
          seabedAtM: column.profileDepthAt(column.shore()),
          depthMin: column.range().min,
          depthMax: column.range().max,
        };
      },
      /** World px of water a gather summons carries through — creatures further
       *  than this from the beacon never hear it (see GATHER_REACH_SCREENS). */
      gatherReachPx: () => state.H * GATHER_REACH_SCREENS,
      /** Eased (live) depth, commanded depth, rate, and the navigable stops. */
      depthInfo: () => {
        if (!column) return null;
        const r = column.range();
        const b = column.visibleBand();
        return {
          depth: column.depth(),
          target: column.targetDepth(),
          rate: column.rate(),
          camY: column.camY(),
          min: r.min,
          max: r.max,
          surface: r.surface,
          seabed: r.seabed,
          topM: b.topM,
          bottomM: b.bottomM,
          zone: column.zoneAt(column.depth()).id,
        };
      },
      /** Every alive creature with its metre depth, band kind and visibility —
       *  the assertion surface for "creatures live at their species' depth and
       *  STAY there while the camera travels". */
      creatureDepths: () =>
        state.creatures
          .filter((c) => c.state === 'alive')
          .map((c) => ({
            id: c.id,
            name: c.spec.name || c.spec.kind,
            klass: c.klass,
            kind: c.band ? c.band.kind : 'legacy',
            depthM: column ? column.worldYToMetres(c.py) : 0,
            homeM: c.homeM ?? null,
            y: c.py,
            floorY: seabedYAt(c.px, c.pz, c.homeM),
            visible: c.points.visible,
            // ---- v3.7, the second axis ------------------------------------
            x: c.px,
            transectM: column ? column.worldXToTransect(c.px) : 0,
            homeS: c.homeS ?? null,
            // the mean seabed depth where this creature actually is: for a
            // benthic or rooted thing this must equal its own depth
            seabedAtM: column ? column.profileDepthAt(column.worldXToTransect(c.px)) : 0,
            shoreZone: column ? column.shoreZoneAt(column.worldXToTransect(c.px)).id : null,
            zones: (c.band && c.band.shoreZones) || null,
            lit: !!(c.bio && c.bio.lit),
            bioPattern: c.bio ? c.bio.patternName || c.bio.pattern : null,
          })),
    },
    stats,
  };
}

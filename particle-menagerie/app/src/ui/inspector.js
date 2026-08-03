// Bathyscaphe v3.6 — the SPECIMEN INSPECTOR.
//
// ---------------------------------------------------------------------------
// WHY THERE IS A MODAL HERE AT ALL (read this before "fixing" it)
// ---------------------------------------------------------------------------
// design/bathyscaphe/README.md says, under Screens/Views: "One screen, ever.
// No modals, no navigation, no pages." That rule is DELIBERATELY SUPERSEDED
// for this one feature, by the user, in their own words:
//
//   "When I click on a species make it open in a modal where it opens the
//    specimen on the left and details on the right. Left side where the
//    specimen is I should be able to pan and look at the object from all
//    sides, like how you can see all the render details."
//
// So: the no-modal constraint is overridden; NOTHING ELSE IS. Every token in
// this module is the Bathyscaphe language verbatim — amber phosphor
// (#ffc37a / #ffd9a8), Spectral 500 small-caps + IBM Plex Mono, the glass
// panel rgba(10,8,4,.42) + backdrop blur, brass hairlines, the 400ms
// rise-through-water entry (blur 8px -> 0 + 6px drift) reversing slightly
// faster on exit, and the 40% -> 85% warm-white hover ramp. The gauge needle
// and its felt detent survive on the intent rows, exactly as on the plate.
// If a future revision reinstates "no modals", this whole file goes; the
// visual language it borrows does not change either way.
//
// ---------------------------------------------------------------------------
// WHAT IT IS
// ---------------------------------------------------------------------------
// LEFT  — the selected creature ALONE: the same seed, the same species, the
//         same morph, rebuilt from REGISTRY[arch].maker and driven by its own
//         updateTargets every frame, so it breathes/swims/undulates in place.
//         Drag to turn it, wheel to dolly, and it turns itself slowly when you
//         leave it alone, so its three-dimensionality is always on show.
// RIGHT — what the console actually knows about the real animal
//         (oceandata.statRows), plus the intent controls, kept visually
//         secondary to the specimen record.
//
// ---------------------------------------------------------------------------
// THE RENDER (and what it must never touch)
// ---------------------------------------------------------------------------
// The board's frame graph — HDR scene target, trails feedback, bloom, the one
// tonemap + one sRGB encode — is NOT touched, not borrowed, not paused. The
// inspector owns a SECOND, small THREE.WebGLRenderer on its own canvas: one
// additive dot pass into a half-float target, then one quad that tonemaps
// (the same ACES + highlight-shoulder + sRGB as render/pipeline.js) over a
// painted ground. No trails, no bloom, no DOF, no fog — an inspector shows the
// specimen, not the weather.
//
// CONTEXT DISCIPLINE (the correctness risk): that renderer is created ONCE,
// lazily, on the first open, and lives until dispose(). Opening and closing
// the modal a hundred times therefore creates exactly ONE WebGL context, not a
// hundred — a browser only allows ~16 live contexts, and "create on open,
// destroy on close" is how you find that out in production. What IS built and
// torn down per specimen is the geometry + material (disposeSpecimen), which
// is bounded and cheap. The private rAF is cancelled on close, so a shut
// inspector costs nothing at all.
//
// ---------------------------------------------------------------------------
// TURNTABLE, NOT ORBIT-CAM (and where the key light lives)
// ---------------------------------------------------------------------------
// The camera and the light are BOLTED DOWN; the specimen turns under them
// (two nested nodes: pitch outside, yaw inside, so yaw is a turntable about
// the specimen's own vertical and pitch tilts the whole turntable toward the
// glass). This is identical on screen to orbiting the camera, and it buys two
// things the brief asked for:
//   1. The key light is fixed RELATIVE TO THE CAMERA for free — you are
//      turning the object, not the sun, which is how a specimen under a lamp
//      behaves and the only way the lit volume stays readable from behind. A
//      world-fixed sun would leave the far side unlit and the whole exercise
//      pointless. Zero per-frame maths and zero allocation to keep it that way.
//   2. dots.js's uLightDir is a WORLD-space direction, so a moving camera
//      would need it recomputed and renormalised every frame. It never moves.
// Pitch is clamped just short of the poles, so the turntable can never
// gimbal-flip; dolly is clamped either side of the framing distance.
//
// ---------------------------------------------------------------------------
// MOUNTING (main.js — the integrator wires this; this file never touches it)
// ---------------------------------------------------------------------------
//   import { initInspector } from './ui/inspector.js';
//
//   ui = {
//     labels: initLabels(controls),
//     summon: initSummon(controls),
//     plate: initPlate(controls),
//     rotary: initRotary(controls),
//     ambient: initAmbient(),
//     depthGauge: initDepthGauge(column),
//     inspector: initInspector(controls, { state }),   // <-- the whole wiring
//   };
//
// `state` is main.js's own board state object; the inspector reads
// state.creatures to recover the selected creature's arch / seed / morph /
// tempo / phase / ctrl — the identity bits controls.getSelected() does not
// carry. Nothing is mutated. If you would rather not hand over `state`, pass
// a resolver instead and keep `state` private:
//
//     initInspector(controls, { getCreature: (id) =>
//       state.creatures.find((c) => c.id === id && c.state === 'alive') })
//
// deps:
//   state          main.js's board state ({ creatures: [...] })      [either]
//   getCreature    (id) => creature | null                           [or this]
//   openOnSelect   default TRUE — a creature click opens the modal, which is
//                  the behaviour the user asked for. Pass false and drive it
//                  yourself with the returned open(id).
//
// Also registered, the way ambient.js registers its own hook, for the harness
// and for any other agent's UI:
//   window.__menagerie.ui.inspector = { open, close, isOpen, el }
//
// Consumes ONLY the controls API for anything mutable (setIntent / getIntent /
// intentAxes / setParam / getParam / reform / release / onSelectionChange), so
// the modal shapes the SAME creature the plate does and cannot desync from it.
//
// Styles: ./chrome.css, section "v3.6 — SPECIMEN INSPECTOR". Loaded once via
// <link> in index.html — do NOT re-import it here.

import * as THREE from 'three';
import { REGISTRY } from '../creatures.js';
import { createGlobalUniforms, createDotMaterial } from '../shaders/dots.js';
import { colorFromHue } from '../lexicon.js';
import { statRows, DISCLAIMER } from '../oceandata.js';

// ---- fidelity constants ---------------------------------------------------
const SURFACE_MS = 400; // rise: blur 8px->0 + 6px drift, ease-out (README)
const SINK_MS = 300; // exit reverses, slightly faster

// ---- the specimen view ----------------------------------------------------
const FOV = 45; // narrower than the board's 55: an inspector, not a porthole
const REF_DIST = 10; // must match REF_DIST in shaders/dots.js
// Fraction of the pane's half-extent the specimen occupies. Tuned against the
// MEASURED radius below, which is a union over several phases of the animation
// and so already carries the sway's own margin — a kelp at rest lands around
// two thirds of the pane and its widest sweep still clears the edge.
const FILL = 0.84;
// Opening pitch when the archetype has no pitch of its own (see openPitch()).
const PITCH_DEFAULT = 0.18;
const EASE_RATE = 4.5; // same coefficient main.js eases positions AND normals with
const DOLLY_MIN = 0.42; // x framing distance
const DOLLY_MAX = 2.6;
const WHEEL_RATE = 0.0013; // per wheel delta unit
const DRAG_RATE = 0.0075; // rad per px
const PITCH_LIMIT = Math.PI / 2 - 0.055; // just short of the poles — never flips
const AUTO_IDLE_S = 3.0; // hands off this long -> the turntable resumes
const AUTO_YAW = 0.24; // rad/s, slow enough to read
const AUTO_RAMP = 1.6; // 1/s, how fast the auto-rotate fades back in
const SIZE_COMPRESS = 0.45; // see sizeVis() — the size intent, legibly compressed
const SIZE_MIN = 0.62;
// FILL x SIZE_MAX must stay under 1, or 'giant' walks out of the pane.
const SIZE_MAX = 1.14;
// Board-matched exposure: render/pipeline.js multiplies by exposure / 0.6 with
// exposure 3.4, then applies the same shoulder and the same ACES fit.
const EXPOSURE = 3.4 / 0.6;
const SHOULDER_KNEE = 1.25;
const SHOULDER_CEIL = 6.0;
// Phase-sampling of the animation to measure the specimen's real extent (see
// measure()) — irrational-ish spacing so no archetype's cycle is stroboscoped.
const MEASURE_TS = [0, 1.7, 3.4, 5.1, 6.8, 8.5];

// ---- the intent rows ------------------------------------------------------
// motion / light / size / doing, and colour as swatches — exactly the plate's
// vocabulary minus `depth`, which is the creature's PARALLAX BAND on the board
// (a z offset among other creatures). In a pane holding one isolated specimen
// it has no referent, so it is not offered here; the plate still owns it.
const AXES_HERE = ['motion', 'light', 'size', 'doing'];
const V2_PALETTE = [null, 45, 15, 185, 165, 215, 275, 310, 130]; // as ui/plate.js
const OMEGA = 16; // needle spring, rad/s (plate.js constants, verbatim)
const ZETA = 0.62;
const OVER = 0.4;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (Number.isFinite(v) ? v : d);

// A value is printable only if it is a non-empty string that is not one of the
// four ways a missing figure leaks into a UI. oceandata.statRows already
// guarantees this (rule 1: a null row is OMITTED, never substituted) — this is
// the belt to its braces, so nothing downstream can ever render "null".
function printable(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!s) return false;
  return s !== 'null' && s !== 'undefined' && s !== 'NaN' && s !== 'Infinity';
}

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = position.xy * 0.5 + 0.5;
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

// One tonemap, one sRGB encode, over a painted ground — the inspector's whole
// composite. ACESFilmicToneMapping / RRTAndODTFit / linearToSRGB /
// highlightShoulder are the SAME bodies as src/render/pipeline.js (which took
// them from three r185's ShaderChunks), so a dot reads the same brightness
// here as it does on the board. The ground is the app's own night-water
// gradient (README: #0a1522 -> #04060a) painted in the shader rather than in
// CSS, so the output is opaque and the composite has no alpha subtleties.
const QUAD_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform float uExposure;
uniform float uKnee;
uniform float uCeil;
varying vec2 vUv;

vec3 linearToSRGB( vec3 c ) {
	return mix( c * 12.92, 1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055, step( vec3( 0.0031308 ), c ) );
}

vec3 RRTAndODTFit( vec3 v ) {
	vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
	vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
	return a / b;
}

vec3 ACESFilmicToneMapping( vec3 color ) {
	const mat3 ACESInputMat = mat3(
		vec3( 0.59719, 0.07600, 0.02840 ),
		vec3( 0.35458, 0.90834, 0.13383 ),
		vec3( 0.04823, 0.01566, 0.83777 )
	);
	const mat3 ACESOutputMat = mat3(
		vec3( 1.60475, - 0.10208, - 0.00327 ),
		vec3( - 0.53108, 1.10813, - 0.07276 ),
		vec3( - 0.07367, - 0.00605, 1.07602 )
	);
	color = ACESInputMat * color;
	color = RRTAndODTFit( color );
	color = ACESOutputMat * color;
	return clamp( color, 0.0, 1.0 );
}

vec3 highlightShoulder( vec3 c ) {
	float m = max( c.r, max( c.g, c.b ) );
	if ( m <= uKnee ) return c;
	float range = max( uCeil - uKnee, 1e-3 );
	float mapped = uKnee + range * ( 1.0 - exp( - ( m - uKnee ) / range ) );
	return c * ( mapped / m );
}

void main() {
	vec3 color = texture2D( tInput, vUv ).rgb;
	color *= uExposure;
	color = highlightShoulder( color );
	color = ACESFilmicToneMapping( color );
	color = linearToSRGB( color );
	// night water: a soft top glow falling to the abyssal plate, additive under
	// the specimen so the dots read as light IN water rather than on paper.
	float g = smoothstep( 0.0, 0.92, length( ( vUv - vec2( 0.5, 0.86 ) ) * vec2( 1.05, 1.0 ) ) );
	vec3 ground = mix( vec3( 0.039, 0.082, 0.133 ), vec3( 0.016, 0.024, 0.039 ), g );
	gl_FragColor = vec4( ground + color, 1.0 );
}
`;

/**
 * Mount the specimen inspector. Builds #inspector (appended to <body>),
 * replacing any stale instance. Nothing is rendered and no WebGL context is
 * created until the first open().
 *
 * @param {object} controls  the createControls(engine) instance
 * @param {object} [deps]    { state } or { getCreature }, plus { openOnSelect }
 * @returns {{ el: HTMLElement, open(id): boolean, close(): void,
 *             isOpen(): boolean, dispose(): void }}
 */
export function initInspector(controls, deps = {}) {
  const stale = document.getElementById('inspector');
  if (stale) stale.remove();

  // ---- creature lookup ----------------------------------------------------
  // controls.getSelected() carries the CONSOLE's view of a creature (name,
  // index tag, params, intents). The inspector additionally needs its
  // IDENTITY — arch, seed, morph — plus the per-instance tempo/phase, so the
  // specimen in the pane is the same animal, mid-stroke, and not a stand-in.
  function findCreature(id) {
    if (typeof deps.getCreature === 'function') return deps.getCreature(id) || null;
    const list = deps.state && deps.state.creatures;
    if (!list) return null;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.id === id && c.state === 'alive') return c;
    }
    return null;
  }

  // ---- markup -------------------------------------------------------------
  const el = document.createElement('div');
  el.id = 'inspector';

  const backdrop = document.createElement('div');
  backdrop.className = 'insp-backdrop';

  const modal = document.createElement('div');
  modal.className = 'insp-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'specimen inspector');
  modal.tabIndex = -1;

  // -- left: the stage
  const stage = document.createElement('div');
  stage.className = 'insp-stage';
  const canvas = document.createElement('canvas');
  canvas.className = 'insp-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const hint = document.createElement('div');
  hint.className = 'insp-hint';
  hint.textContent = 'drag to turn · scroll to zoom';
  const reset = document.createElement('span');
  reset.className = 'chrome-action insp-reset';
  reset.textContent = 'reset view';
  reset.setAttribute('role', 'button');
  reset.tabIndex = 0;
  stage.append(canvas, hint, reset);

  // -- right: the record
  const detail = document.createElement('div');
  detail.className = 'insp-detail';

  const head = document.createElement('div');
  head.className = 'insp-head';
  const nameEl = document.createElement('span');
  nameEl.className = 'insp-name';
  const tagEl = document.createElement('span');
  tagEl.className = 'insp-tag';
  head.append(nameEl, tagEl);

  const specEl = document.createElement('div');
  specEl.className = 'insp-spec';

  const intentDivider = document.createElement('div');
  intentDivider.className = 'plate-divider insp-divider';
  const intentCap = document.createElement('div');
  intentCap.className = 'insp-caption';
  intentCap.textContent = 'specimen controls';
  const rowsEl = document.createElement('div');
  rowsEl.className = 'plate-intents insp-intents';

  const actions = document.createElement('div');
  actions.className = 'plate-actions insp-actions';
  const mkAction = (label, act) => {
    const s = document.createElement('span');
    s.className = 'chrome-action';
    s.dataset.act = act;
    s.textContent = label;
    s.setAttribute('role', 'button');
    s.tabIndex = 0;
    actions.appendChild(s);
  };
  mkAction('re-form', 'reform');
  mkAction('release', 'release');

  detail.append(head, specEl, intentDivider, intentCap, rowsEl, actions);

  const closeBtn = document.createElement('span');
  closeBtn.className = 'chrome-action insp-close';
  closeBtn.textContent = 'close';
  closeBtn.setAttribute('role', 'button');
  closeBtn.setAttribute('aria-label', 'close specimen inspector');
  closeBtn.tabIndex = 0;

  modal.append(stage, detail, closeBtn);
  el.append(backdrop, modal);
  document.body.appendChild(el);

  // ---- intent rows (the plate's idiom, verbatim) --------------------------
  let selId = null;
  const rows = [];

  function buildRow(axis) {
    const n = axis.options.length;
    const row = document.createElement('div');
    row.className = 'plate-row plate-intent';
    row.dataset.axis = axis.id;
    row.tabIndex = 0;
    row.setAttribute('role', 'listbox');
    row.setAttribute('aria-label', axis.label);

    const label = document.createElement('span');
    label.className = 'plate-label';
    label.textContent = axis.label;

    const strip = document.createElement('div');
    strip.className = 'plate-notches';
    const notchEls = [];
    for (let i = 0; i < n; i++) {
      const notch = document.createElement('div');
      notch.className = 'plate-notch';
      notch.dataset.i = String(i);
      notch.setAttribute('role', 'option');
      notch.setAttribute('aria-label', axis.options[i]);
      notch.setAttribute('aria-selected', 'false');
      strip.appendChild(notch);
      notchEls.push(notch);
    }
    const needle = document.createElement('div');
    needle.className = 'plate-needle';
    strip.appendChild(needle);

    const word = document.createElement('span');
    word.className = 'plate-value';
    row.append(label, strip, word);
    rowsEl.appendChild(row);

    const r = {
      axis: axis.id, options: axis.options, n,
      i: 0, v: 0, vel: 0, target: 0, active: false,
      row, needle, word, notchEls, lastPct: -1, lastWord: '',
    };
    rows.push(r);

    strip.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      const t = ev.target.closest('.plate-notch');
      if (!t) return;
      ev.preventDefault();
      row.focus({ preventScroll: true });
      pick(r, +t.dataset.i);
    });
    const cycle = (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      row.focus({ preventScroll: true });
      pick(r, r.i + 1);
    };
    label.addEventListener('pointerdown', cycle);
    word.addEventListener('pointerdown', cycle);

    row.addEventListener('keydown', (ev) => {
      let next = -1;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = Math.min(r.i + 1, r.n - 1);
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = Math.max(r.i - 1, 0);
      else if (ev.key === 'Home') next = 0;
      else if (ev.key === 'End') next = r.n - 1;
      else if (ev.key === 'Enter' || ev.key === ' ') next = (r.i + 1) % r.n;
      else return; // Escape keeps bubbling — the modal's own handler takes it
      ev.preventDefault();
      ev.stopPropagation();
      pick(r, next);
    });
    return r;
  }

  function pick(r, i) {
    if (!selId) return;
    const idx = ((i % r.n) + r.n) % r.n;
    r.i = idx;
    r.target = idx;
    r.active = true;
    setWord(r, r.options[idx]);
    controls.setIntent(selId, r.axis, r.options[idx]);
  }

  function setWord(r, w) {
    if (w === r.lastWord) return;
    r.lastWord = w;
    r.word.textContent = w;
    for (let k = 0; k < r.n; k++) {
      r.notchEls[k].setAttribute('aria-selected', k === r.i ? 'true' : 'false');
    }
  }

  function renderRow(r) {
    const pct = ((r.v + 0.5) / r.n) * 100;
    if (Math.abs(pct - r.lastPct) < 0.02) return;
    r.lastPct = pct;
    r.needle.style.left = pct.toFixed(2) + '%';
  }

  function snapRow(r, value) {
    const i = Math.max(r.options.indexOf(value), 0);
    r.i = i;
    r.v = r.target = i;
    r.vel = 0;
    r.active = false;
    r.lastWord = '';
    r.lastPct = -1;
    setWord(r, r.options[i]);
    renderRow(r);
  }

  for (const axis of controls.intentAxes()) {
    if (AXES_HERE.indexOf(axis.id) >= 0) buildRow(axis);
  }

  // colour: a hue is visual, never a number (plate.js's reasoning, unchanged)
  const colRow = document.createElement('div');
  colRow.className = 'plate-row plate-colors';
  const colLabel = document.createElement('span');
  colLabel.className = 'plate-label';
  colLabel.textContent = 'color';
  const swatches = document.createElement('div');
  swatches.className = 'plate-swatches';
  const swatchEls = V2_PALETTE.map((h) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'plate-swatch';
    b.style.background = h == null ? '#fff' : 'hsl(' + h + ' 78% 62%)';
    b.setAttribute('aria-label', h == null ? 'monochrome' : 'hue ' + h);
    b.addEventListener('click', () => {
      if (!selId) return;
      controls.setParam(selId, 'color', h);
      markSwatch(h);
      applyLook(); // the specimen recolours in the pane, immediately
    });
    swatches.appendChild(b);
    return b;
  });
  colRow.append(colLabel, swatches);
  rowsEl.appendChild(colRow);

  let curHue = null;
  function markSwatch(h) {
    curHue = h;
    swatchEls.forEach((b, i) => {
      const v = V2_PALETTE[i];
      b.classList.toggle('current', v == null ? h == null : v === h);
    });
  }

  // ---- the specimen record (right pane) -----------------------------------
  // Rows arrive ready-made from oceandata.statRows(): a field the research
  // could not confirm is ABSENT from the array, so nothing here renders a
  // placeholder, a zero or a guess, and the size row is already labelled with
  // the CORRECT measure ('disc width' for a manta, 'height' for kelp).
  function populateSpecimen(name) {
    specEl.textContent = '';
    const list = statRows(name);
    if (!list || !list.length) {
      // No record at all (nonsense words, 'blob', generic names). The pane
      // keeps its head and says so once, quietly. It does not apologise, it
      // does not print "unknown", and it does not show a provenance line for
      // data it does not have.
      const empty = document.createElement('div');
      empty.className = 'insp-empty';
      empty.textContent = 'no record is held for this specimen.';
      specEl.appendChild(empty);
      return;
    }
    for (const r of list) {
      if (!printable(r.value)) continue; // belt to statRows' braces
      const row = document.createElement('div');
      row.className = 'insp-spec-row';
      const label = document.createElement('span');
      label.className = 'insp-spec-label';
      label.textContent = r.label;
      const val = document.createElement('span');
      // Binomials are italicised: typographic correctness, and it marks the
      // real-world fact off from the app's own invented vocabulary.
      val.className = r.key === 'species' ? 'insp-spec-value insp-spec-sci' : 'insp-spec-value';
      val.textContent =
        r.key === 'iucn' && printable(r.note) ? `${r.value} (${r.note})` : r.value;
      row.append(label, val);
      specEl.appendChild(row);
      if (r.key !== 'iucn' && printable(r.note)) {
        const note = document.createElement('div');
        note.className = 'insp-spec-note';
        note.textContent = r.note;
        specEl.appendChild(note);
      }
    }
    const prov = document.createElement('div');
    prov.className = 'insp-prov';
    prov.textContent = DISCLAIMER;
    specEl.appendChild(prov);
  }

  // ---- actions ------------------------------------------------------------
  const runAction = (act) => {
    if (!selId) return;
    if (act === 'reform') {
      controls.reform(selId);
      reformSpecimen(); // the pane replays the formation too
    } else if (act === 'release') {
      controls.release(selId); // engine deselects -> onSelectionChange closes us
    }
  };
  actions.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (t) runAction(t.dataset.act);
  });
  actions.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target.closest('[data-act]');
    if (t) {
      e.preventDefault();
      runAction(t.dataset.act);
    }
  });

  // =========================================================================
  // THE SPECIMEN VIEW
  // =========================================================================
  let gl = null; // the ONE renderer + its scene graph, built lazily, kept
  let spec = null; // the current specimen's buffers/geometry/material

  function ensureGL() {
    if (gl) return gl;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: false, // frame-graph rule 6, honoured here too
      powerPreference: 'low-power', // a 500px pane; the board owns the GPU
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // The composite quad owns the single tonemap + single sRGB encode, exactly
    // as the board's pipeline does — keep the renderer out of the conversion
    // business so nothing can double-encode upstream.
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.setClearColor(0x000000, 0);

    // createGlobalUniforms registers window.__menagerie.dots as a debug hook
    // pointing at whichever uniform set was made last. The BOARD owns that
    // hook; hand it straight back so a harness poking setDepthTint still talks
    // to the real scene and not to this 500px pane.
    const boardDots = window.__menagerie && window.__menagerie.dots;
    const uniforms = createGlobalUniforms(renderer);
    if (boardDots && window.__menagerie) window.__menagerie.dots = boardDots;

    // uDpr from createGlobalUniforms is a getter folding in quality.js's GLOBAL
    // render scale — that belongs to the board's supersampled targets, and the
    // governor moving it must not resize this pane's sprites. Replace it with a
    // plain value this module owns outright.
    uniforms.uDpr = { value: renderer.getPixelRatio() };

    // An inspector shows the specimen, not the weather: no fog, no aerial
    // perspective, no defocus. uAperture 0 pins the shader's DOF factor k at
    // exactly 1, so every dot is in focus from every angle.
    uniforms.uFogDensity.value = 0;
    uniforms.uFogScale.value = 1;
    uniforms.uFogRef.value = 0;
    uniforms.uDepthTint.value = 0;
    uniforms.uGain.value = 1;
    uniforms.uAperture.value = 0;
    uniforms.uFocusZ.value = 1;
    uniforms.uRim.value = 1.35; // a touch above the board's 1.25: silhouettes
    uniforms.uLightColor.value.setRGB(0.86, 0.95, 1.06); // the board's cool key
    // World space == camera space here (the camera never moves), so this IS
    // the camera-relative key light: high, front-left, slightly toward the
    // glass. See the turntable note at the top of the file.
    uniforms.uLightDir.value.set(-0.42, 0.66, 0.62).normalize();

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 500);
    camera.position.set(0, 0, 1);
    camera.lookAt(0, 0, 0);

    // pitch outside, yaw inside: yaw is a turntable about the specimen's own
    // vertical, pitch tilts the whole turntable toward the glass. Explicit
    // nesting rather than one Euler, so no rotation-order convention can
    // silently change what "drag up" means.
    const pitchNode = new THREE.Object3D();
    const yawNode = new THREE.Object3D();
    pitchNode.add(yawNode);
    scene.add(pitchNode);

    const rt = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    const quadMat = new THREE.ShaderMaterial({
      uniforms: {
        tInput: { value: rt.texture },
        uExposure: { value: EXPOSURE },
        uKnee: { value: SHOULDER_KNEE },
        uCeil: { value: SHOULDER_CEIL },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: QUAD_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const quadGeo = new THREE.PlaneGeometry(2, 2);
    const quad = new THREE.Mesh(quadGeo, quadMat);
    quad.frustumCulled = false;
    const quadScene = new THREE.Scene();
    quadScene.add(quad);
    const quadCam = new THREE.Camera();

    gl = {
      renderer, uniforms, scene, camera, pitchNode, yawNode,
      rt, quad, quadGeo, quadMat, quadScene, quadCam,
      w: 0, h: 0, pr: renderer.getPixelRatio(),
    };
    return gl;
  }

  function sizeGL() {
    if (!gl) return;
    const w = Math.max(stage.clientWidth | 0, 1);
    const h = Math.max(stage.clientHeight | 0, 1);
    if (w === gl.w && h === gl.h) return;
    gl.w = w;
    gl.h = h;
    gl.renderer.setSize(w, h, false);
    gl.rt.setSize(Math.round(w * gl.pr), Math.round(h * gl.pr));
    gl.camera.aspect = w / h;
    gl.camera.updateProjectionMatrix();
    if (spec) frameSpecimen(); // the framing distance is a function of the pane
  }

  // ---- view state (turntable) ---------------------------------------------
  let yaw = 0.5;
  let pitch = PITCH_DEFAULT;
  let dolly = 1; // multiplier on the framing distance
  let idleS = 0; // seconds since the last touch — drives the auto-rotate
  let autoAmt = 0; // 0..1 eased ramp so the turntable never jerks into motion
  let dragging = false;
  let dragId = -1;
  let lastX = 0;
  let lastY = 0;

  function touched() {
    idleS = 0;
    autoAmt = 0;
  }
  // The opening pose. REGISTRY[arch].pitch is the tilt the BOARD gives an
  // archetype so it reads at all — a ray and a starfish are flat sheets in the
  // local XZ plane, and at pitch 0 an inspector would open on a one-dot-thick
  // edge, which is the worst possible first impression of a manta. Borrowing
  // the board's own tilt means every archetype opens on the silhouette it was
  // authored to be seen at; everything without one gets a slight look-down.
  function openPitch() {
    const p = spec && spec.entry ? spec.entry.pitch || 0 : 0;
    return clamp(p !== 0 ? p : PITCH_DEFAULT, -PITCH_LIMIT, PITCH_LIMIT);
  }
  function resetView() {
    yaw = 0.5;
    pitch = openPitch();
    dolly = 1;
    touched();
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    dragId = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.classList.add('dragging');
    canvas.setPointerCapture(e.pointerId);
    touched();
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== dragId) return;
    yaw += (e.clientX - lastX) * DRAG_RATE;
    pitch = clamp(pitch + (e.clientY - lastY) * DRAG_RATE, -PITCH_LIMIT, PITCH_LIMIT);
    lastX = e.clientX;
    lastY = e.clientY;
    touched();
  });
  const endDrag = (e) => {
    if (!dragging || (e && e.pointerId !== dragId)) return;
    dragging = false;
    dragId = -1;
    canvas.classList.remove('dragging');
    touched();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault(); // the modal never scrolls under the specimen
      dolly = clamp(dolly * Math.exp(e.deltaY * WHEEL_RATE), DOLLY_MIN, DOLLY_MAX);
      touched();
    },
    { passive: false },
  );
  // keyboard parity: the stage is reachable and turnable without a mouse
  canvas.tabIndex = 0;
  canvas.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.35 : 0.12;
    if (e.key === 'ArrowLeft') yaw -= step;
    else if (e.key === 'ArrowRight') yaw += step;
    else if (e.key === 'ArrowUp') pitch = clamp(pitch - step, -PITCH_LIMIT, PITCH_LIMIT);
    else if (e.key === 'ArrowDown') pitch = clamp(pitch + step, -PITCH_LIMIT, PITCH_LIMIT);
    else if (e.key === '+' || e.key === '=') dolly = clamp(dolly * 0.88, DOLLY_MIN, DOLLY_MAX);
    else if (e.key === '-') dolly = clamp(dolly * 1.14, DOLLY_MIN, DOLLY_MAX);
    else if (e.key === '0') resetView();
    else return;
    e.preventDefault();
    e.stopPropagation();
    touched();
  });
  reset.addEventListener('click', resetView);
  reset.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      resetView();
    }
  });

  // ---- building the specimen ----------------------------------------------
  function disposeSpecimen() {
    if (!spec) return;
    if (gl) gl.yawNode.remove(spec.points);
    spec.geometry.dispose();
    spec.material.dispose();
    spec = null;
  }

  // The measured extent of the ANIMATED skeleton. REGISTRY[arch].boundR is a
  // radius about the LOCAL ORIGIN, and for the rooted archetypes that origin is
  // the holdfast, not the middle — framing a kelp on boundR alone parks it in
  // the top half of the pane with a screenful of empty water under it. So the
  // extent is measured over several phases of the creature's own animation
  // (union AABB), which gives both a centre to pivot about and a radius that
  // already covers the sway sweep. boundR still has a job: it is the floor on
  // that radius, so a degenerate or unusually still morph can never frame
  // itself into the camera.
  // Two passes over the samples:
  //   1. the CENTROID of the dots, which is the pivot. Not the AABB midpoint —
  //      a ray's tail and a kelp's stipe drag a box centre a long way off the
  //      body, and once the turntable tilts, that offset becomes a lopsided
  //      composition. The centroid sits where the animal's mass is.
  //   2. the largest distance from that centroid, which is the true bounding
  //      radius. Orientation-independent by construction, so the framing holds
  //      at every angle, and appreciably tighter than the box's half-diagonal.
  function measure(gen, tpos, tnor, boundR) {
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (let s = 0; s < MEASURE_TS.length; s++) {
      gen.updateTargets(MEASURE_TS[s], 1, 1, tpos, tnor);
      for (let i = 0; i < tpos.length; i += 3) {
        sx += tpos[i];
        sy += tpos[i + 1];
        sz += tpos[i + 2];
        n++;
      }
    }
    if (!n || !Number.isFinite(sx)) return { cx: 0, cy: 0, cz: 0, r: boundR };
    const cx = sx / n, cy = sy / n, cz = sz / n;
    let r2 = 0;
    for (let s = 0; s < MEASURE_TS.length; s++) {
      gen.updateTargets(MEASURE_TS[s], 1, 1, tpos, tnor);
      for (let i = 0; i < tpos.length; i += 3) {
        const dx = tpos[i] - cx, dy = tpos[i + 1] - cy, dz = tpos[i + 2] - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) r2 = d2;
      }
    }
    return { cx, cy, cz, r: Math.max(Math.sqrt(r2), boundR * 0.3, 0.25) };
  }

  // The size intent, legibly compressed. Straight size (tiny 0.45 -> giant 2.8)
  // would either overflow the pane or vanish in it; ^0.45 keeps the ORDER and
  // the felt difference while staying inside the frame at both ends. The top of
  // the range SATURATES on purpose — 'large' and 'giant' both land on the same
  // pane-filling specimen, because an inspector frames its specimen and does
  // not let it walk out of the glass. Size is a property of the creature in the
  // WATER; the plate and the board still show it in full.
  function sizeVis() {
    const s = selId ? controls.getParam(selId, 'size') : 1;
    return clamp(Math.pow(Number.isFinite(s) ? s : 1, SIZE_COMPRESS), SIZE_MIN, SIZE_MAX);
  }

  // Camera distance + dot sizes for the current pane. Both are functions of the
  // pane's pixels, so this re-runs on resize and never per frame.
  function frameSpecimen() {
    if (!gl || !spec) return;
    const tanH = Math.tan((FOV * Math.PI) / 360);
    const aspect = gl.camera.aspect || 1;
    // fit vertically AND horizontally: a kelp (tall) and a starfish (wide) both
    // land inside the same FILL of the pane
    const dV = spec.r / (FILL * tanH);
    const dH = spec.r / (FILL * tanH * Math.max(aspect, 1e-3));
    spec.frameDist = Math.max(dV, dH);

    // Dot sprites: reproduce the BOARD's dot-size : dot-spacing ratio exactly,
    // whatever the pane's size, so the dotted ribs read the way they do in the
    // water instead of merging into a slug or scattering into dust.
    //   pxPerUnit = how many CSS px one local unit spans at the framing plane
    //   the board spends entry.scale px on that same unit
    const pxPerUnit = gl.h / 2 / (spec.frameDist * tanH);
    const dotScale = clamp(pxPerUnit / spec.entry.scale, 0.35, 2.2);
    const px = spec.entry.dotPx * dotScale;
    const k = (px * spec.frameDist) / REF_DIST;
    const a = spec.aSizeAttr.array;
    const base = spec.aSizeBase;
    for (let i = 0; i < base.length; i++) a[i] = base[i] * k;
    spec.aSizeAttr.needsUpdate = true;
  }

  function buildSpecimen(rec) {
    ensureGL();
    disposeSpecimen();
    const entry = REGISTRY[rec.arch] || REGISTRY.fish;
    const gen = entry.maker(rec.seed, rec.morph ? { morph: rec.morph } : undefined);
    const n = gen.count;

    const tpos = new Float32Array(n * 3);
    const tnor = new Float32Array(n * 3);
    const pos = new Float32Array(n * 3);
    const nor = new Float32Array(n * 3);
    const aSize = new Float32Array(n);
    const aTw = new Float32Array(n);
    const aRing = new Float32Array(n);
    gen.init({ aSize, aTw, aRing });
    const aSizeBase = aSize.slice(); // authored ~[0.4..1.25], rescaled per pane

    const m = measure(gen, tpos, tnor, entry.boundR);
    // start ON the pose rather than easing in from a scatter cloud: an
    // inspector should be readable the instant it opens (re-form still replays
    // the formation on demand — see reformSpecimen).
    gen.updateTargets(0, 1, 1, tpos, tnor);
    pos.set(tpos);
    nor.set(tnor);

    const g = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    const norAttr = new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage);
    const aSizeAttr = new THREE.BufferAttribute(aSize, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', posAttr);
    g.setAttribute('normal', norAttr);
    g.setAttribute('aSize', aSizeAttr);
    g.setAttribute('aTw', new THREE.BufferAttribute(aTw, 1));
    g.setAttribute('aRing', new THREE.BufferAttribute(aRing, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(m.cx, m.cy, m.cz), m.r);

    const material = createDotMaterial(gl.uniforms);
    material.uniforms.uFormation.value = 1;
    // Small-creature merge correction, in the inspector's terms: the shader
    // computes merge = uSmall / (worldScale * 1.35), and worldScale here IS the
    // visual size multiplier. uSmall = 1.35 therefore makes merge exactly 1 at
    // normal size (byte-identical to no correction) and lets a shrunken
    // specimen conserve energy the same way the board's small creatures do.
    material.uniforms.uSmall.value = 1.35;

    const points = new THREE.Points(g, material);
    points.frustumCulled = false;
    // pivot about the MEASURED centre, so the turntable turns the specimen
    // about itself rather than swinging it around its holdfast
    points.position.set(-m.cx, -m.cy, -m.cz);

    spec = {
      gen, geometry: g, material, points, entry,
      tpos, tnor, posAttr, norAttr, aSizeAttr, aSizeBase,
      r: m.r, frameDist: 1, formT: 1,
      tempo: Number.isFinite(rec.tempo) ? rec.tempo : 1,
      phase: Number.isFinite(rec.phase) ? rec.phase : 0,
      baseColor: rec.color,
      alpha: entry.alpha,
      count: n,
    };
    gl.yawNode.add(points);
    sizeGL();
    frameSpecimen();
    look.hue = look.tw = look.irid = look.glow = look.dens = NaN; // new specimen
    applyLook();
  }

  // Re-scatter and replay the formation ramp, the way main.js's reform() does.
  function reformSpecimen() {
    if (!spec) return;
    const R = spec.r * 0.55;
    const p = spec.posAttr.array;
    const q = spec.norAttr.array;
    // deterministic-enough scatter; this is presentation, not the sim
    let s = 0x9e3779b9;
    const rnd = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < p.length; i++) p[i] = (rnd() * 2 - 1) * R;
    for (let i = 0; i < q.length; i++) q[i] = rnd() * 2 - 1;
    spec.posAttr.needsUpdate = true;
    spec.norAttr.needsUpdate = true;
    spec.formT = 0;
    spec.material.uniforms.uFormation.value = 0;
  }

  // Static ctrl values -> uniforms, mirroring Creature.applyCtrlVisual().
  // Called on open, on a colour pick, and by the ~10Hz external-change poll.
  // The poll is why this memoises: colorFromHue() returns a fresh array, so an
  // unconditional call would allocate ten times a second for nothing.
  const look = { hue: NaN, tw: NaN, irid: NaN, glow: NaN, dens: NaN };
  function applyLook() {
    if (!spec || !selId) return;
    const u = spec.material.uniforms;
    const hue = controls.getParam(selId, 'color') ?? null;
    const twk = num(controls.getParam(selId, 'twinkle'), 1);
    const irid = num(controls.getParam(selId, 'iridescence'), 0);
    const glow = num(controls.getParam(selId, 'glow'), 1);
    const dens = clamp(num(controls.getParam(selId, 'density'), 1), 0.05, 1);
    if (hue === look.hue && twk === look.tw && irid === look.irid
      && glow === look.glow && dens === look.dens) return;
    if (hue !== look.hue) {
      const col = hue != null ? colorFromHue(hue) : spec.baseColor;
      if (col) u.uColor.value.setRGB(col[0], col[1], col[2]);
    }
    // default twinkle 1 -> uTwk (2.1, 0.4), byte-identical to the board
    u.uTwk.value.set(2.1 * Math.max(twk, 0.15), 0.4 * twk);
    u.uIrid.value = irid;
    u.uAlpha.value = spec.alpha * glow;
    // density is the creature's own dot fraction; the board's school thinning
    // (spec.drawFrac) and the governor's lever are deliberately NOT applied —
    // this is the inspector, where you came to see all the render detail.
    spec.geometry.setDrawRange(0, Math.max(1, Math.floor(spec.count * dens)));
    look.hue = hue;
    look.tw = twk;
    look.irid = irid;
    look.glow = glow;
    look.dens = dens;
  }

  // ---- the private frame loop --------------------------------------------
  let raf = 0;
  let lastT = 0;
  let simT = 0;
  let syncTick = 0;
  const kSpring = OMEGA * OMEGA;
  const cSpring = 2 * ZETA * OMEGA;

  function stepSprings(dt) {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.active) continue;
      r.vel += (kSpring * (r.target - r.v) - cSpring * r.vel) * dt;
      r.v += r.vel * dt;
      r.v = clamp(r.v, -OVER, r.n - 1 + OVER);
      if (Math.abs(r.v - r.target) < 0.008 && Math.abs(r.vel) < 0.05) {
        r.v = r.target;
        r.vel = 0;
        r.active = false;
      }
      renderRow(r);
    }
  }

  // External changes (the plate behind, a preset, a raw setParam from anywhere)
  // show up as the NEAREST intent — the rows are a view of the params, never a
  // store. A poll at ~10Hz, exactly as the plate does it.
  function refreshFromEngine() {
    if (!selId) return;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.active) continue;
      const cur = controls.getIntent(selId, r.axis);
      if (cur && cur !== r.lastWord) {
        const idx = Math.max(r.options.indexOf(cur), 0);
        r.i = idx;
        r.target = idx;
        r.active = true;
        setWord(r, cur);
      }
    }
    const hue = controls.getParam(selId, 'color') ?? null;
    if (hue !== curHue) markSwatch(hue);
    applyLook();
  }

  function loop(t) {
    raf = requestAnimationFrame(loop);
    const dt = clamp((t - lastT) / 1000, 0.001, 0.05);
    lastT = t;
    simT += dt;

    stepSprings(dt);
    if (++syncTick >= 6) {
      syncTick = 0;
      refreshFromEngine();
    }
    if (!gl || !spec) return;
    sizeGL();

    // ---- the specimen is ALIVE: its own updateTargets, every frame ---------
    spec.gen.updateTargets(
      simT + spec.phase,
      num(controls.getParam(selId, 'sway'), 1),
      spec.tempo * num(controls.getParam(selId, 'tempo'), 1),
      spec.tpos,
      spec.tnor,
    );
    const c = 1 - Math.exp(-EASE_RATE * dt);
    const p = spec.posAttr.array;
    const q = spec.norAttr.array;
    const tp = spec.tpos;
    const tn = spec.tnor;
    for (let i = 0; i < p.length; i++) {
      p[i] += (tp[i] - p[i]) * c;
      q[i] += (tn[i] - q[i]) * c;
    }
    spec.posAttr.needsUpdate = true;
    spec.norAttr.needsUpdate = true;
    spec.material.uniforms.uTime.value = simT;
    if (spec.formT < 1) {
      spec.formT = Math.min(spec.formT + dt / 1.5, 1);
      spec.material.uniforms.uFormation.value = spec.formT;
    }

    // ---- the turntable ----------------------------------------------------
    idleS += dt;
    if (!dragging && idleS >= AUTO_IDLE_S) {
      autoAmt = Math.min(autoAmt + AUTO_RAMP * dt, 1);
      yaw += AUTO_YAW * autoAmt * dt;
    }
    gl.pitchNode.rotation.x = pitch;
    gl.yawNode.rotation.y = yaw;
    const s = sizeVis();
    gl.pitchNode.scale.setScalar(s);
    gl.camera.position.z = spec.frameDist * dolly;
    gl.camera.updateMatrixWorld();

    // ---- one dot pass, one composite --------------------------------------
    gl.renderer.setRenderTarget(gl.rt);
    gl.renderer.clear();
    gl.renderer.render(gl.scene, gl.camera);
    gl.renderer.setRenderTarget(null);
    gl.renderer.render(gl.quadScene, gl.quadCam);
  }

  // =========================================================================
  // OPEN / CLOSE — rising through water
  // =========================================================================
  let open_ = false;
  let anim = null;
  let bdAnim = null;
  let prevFocus = null;

  function focusables() {
    return Array.prototype.filter.call(
      modal.querySelectorAll(
        'canvas[tabindex], [role="button"], [role="listbox"], button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
      (n) => n.offsetParent !== null || n === document.activeElement,
    );
  }

  /**
   * Open the inspector on a creature id. Returns false (and changes nothing)
   * when that creature is not alive or its archetype is unknown.
   */
  function open(id) {
    const c = findCreature(id);
    if (!c) return false;
    const arch = c.spec && c.spec.arch;
    if (!arch || !REGISTRY[arch]) return false;
    const name = (c.spec.name || c.spec.kind || '').toString();

    selId = id;
    nameEl.textContent = name;
    const snap = controls.getSelected();
    tagEl.textContent = snap && snap.id === id && snap.indexTag ? snap.indexTag : '';

    populateSpecimen(name);
    for (const r of rows) snapRow(r, controls.getIntent(id, r.axis) || r.options[0]);
    markSwatch(controls.getParam(id, 'color') ?? null);

    buildSpecimen({
      arch,
      seed: c.spec.seed,
      morph: c.spec.morph || null,
      tempo: c.spec.tempo,
      phase: c.spec.phase,
      color: c.spec.color,
    });
    resetView();
    detail.scrollTop = 0;

    if (open_) return true; // switching specimens while up: no second rise
    open_ = true;
    prevFocus = document.activeElement;
    el.classList.remove('sinking'); // reopened mid-sink: it is rising again
    el.classList.add('open');
    document.body.classList.add('inspecting');
    sizeGL();
    frameSpecimen();

    if (anim) anim.cancel();
    if (bdAnim) bdAnim.cancel();
    // "rising through water": blur 8px -> 0 plus a 6px drift over 400ms.
    anim = modal.animate(
      [
        { opacity: 0, filter: 'blur(8px)', transform: 'translateY(6px)' },
        { opacity: 1, filter: 'blur(0px)', transform: 'translateY(0px)' },
      ],
      { duration: SURFACE_MS, easing: 'ease-out' },
    );
    anim.onfinish = () => {
      anim = null;
    };
    bdAnim = backdrop.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: SURFACE_MS,
      easing: 'ease-out',
    });
    bdAnim.onfinish = () => {
      bdAnim = null;
    };

    lastT = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
    modal.focus({ preventScroll: true });
    return true;
  }

  function close() {
    if (!open_) return;
    open_ = false;
    selId = null;
    if (anim) anim.cancel();
    if (bdAnim) bdAnim.cancel();
    el.classList.add('sinking');
    anim = modal.animate(
      [
        { opacity: 1, filter: 'blur(0px)', transform: 'translateY(0px)' },
        { opacity: 0, filter: 'blur(8px)', transform: 'translateY(6px)' },
      ],
      { duration: SINK_MS, easing: 'ease-in', fill: 'forwards' },
    );
    bdAnim = backdrop.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: SINK_MS,
      easing: 'ease-in',
      fill: 'forwards',
    });
    const done = () => {
      if (open_) return; // reopened mid-sink: leave it up
      el.classList.remove('open', 'sinking');
      document.body.classList.remove('inspecting');
      if (anim) {
        anim.cancel();
        anim = null;
      }
      if (bdAnim) {
        bdAnim.cancel();
        bdAnim = null;
      }
      // The rAF stops here and the specimen's buffers go with it. The RENDERER
      // and its context do NOT — see the context-discipline note at the top.
      cancelAnimationFrame(raf);
      raf = 0;
      disposeSpecimen();
    };
    anim.onfinish = done;
    // paranoia: if the animation is cancelled by a page hide, still stop the loop
    setTimeout(() => {
      if (!open_ && raf) done();
    }, SINK_MS + 80);

    if (prevFocus && typeof prevFocus.focus === 'function') {
      try {
        prevFocus.focus({ preventScroll: true });
      } catch {
        /* the node may be gone */
      }
    }
    prevFocus = null;
  }

  const isOpen = () => open_;

  // ---- dismissal ----------------------------------------------------------
  backdrop.addEventListener('click', () => close());
  closeBtn.addEventListener('click', () => close());
  closeBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      close();
    }
  });

  // Esc closes the MODAL and nothing else. controls.js has its own
  // document-level Escape handler that deselects the creature; capturing on
  // window and stopping propagation means dismissing the inspector leaves the
  // selection (and the gauge plate) exactly as it was — one Escape, one effect.
  // Tab is trapped inside the dialog while it is up.
  function onKeyDown(e) {
    if (!open_) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const list = focusables();
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (!modal.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus({ preventScroll: true });
      return;
    }
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus({ preventScroll: true });
    }
  }
  window.addEventListener('keydown', onKeyDown, true);

  // focus can still be stolen programmatically (the summon field grabs it on
  // some paths) — pull it back while the dialog owns the screen
  function onFocusIn(e) {
    if (!open_ || modal.contains(e.target)) return;
    modal.focus({ preventScroll: true });
  }
  document.addEventListener('focusin', onFocusIn, true);

  const ro =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          if (open_) sizeGL();
        })
      : null;
  if (ro) ro.observe(stage);

  // ---- wiring -------------------------------------------------------------
  // A creature click selects it (controls owns the hit test) and, unless the
  // integrator says otherwise, that is what raises the inspector. Deselection
  // — empty water, release, Escape on the board — closes it.
  const openOnSelect = deps.openOnSelect !== false;
  const off = controls.onSelectionChange((sel) => {
    if (!sel) {
      if (open_) close();
      return;
    }
    if (openOnSelect) open(sel.id);
    else if (open_) open(sel.id); // already up: follow the selection
  });

  // test hook — attached now AND on the next macrotask, so it survives main.js
  // assigning window.__menagerie after the UI modules boot (ambient.js's trick)
  const api = { el, open, close, isOpen };
  const attach = () => {
    const m = (window.__menagerie = window.__menagerie || {});
    const ui = (m.ui = m.ui || {});
    ui.inspector = api;
  };
  attach();
  setTimeout(attach, 0);

  return {
    el,
    open,
    close,
    isOpen,
    dispose() {
      close();
      cancelAnimationFrame(raf);
      raf = 0;
      if (typeof off === 'function') off();
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      if (ro) ro.disconnect();
      disposeSpecimen();
      if (gl) {
        gl.rt.dispose();
        gl.quadGeo.dispose();
        gl.quadMat.dispose();
        gl.renderer.dispose(); // the one context, released exactly once
        gl = null;
      }
      el.remove();
      const ui = window.__menagerie && window.__menagerie.ui;
      if (ui && ui.inspector === api) delete ui.inspector;
    },
  };
}

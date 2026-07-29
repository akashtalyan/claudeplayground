// Bathyscaphe in-scene chrome — hover creature labels.
// Fidelity contract: design/bathyscaphe/README.md ("In-world creature
// labels"): hovering a creature fades its name in beside it — 10px mono,
// letter-spacing ~.35em, low-opacity warm white, soft glow text-shadow. DOM,
// but it must feel in-water: the label follows controls.screenAnchor every
// frame and its opacity attenuates with the creature's depth through the
// scene's exponential fog, so a deep body carries a dimmer name.
//
// Styles live in ./chrome.css ("In-scene hover labels" section), loaded once
// via <link> in index.html — do NOT re-import it. Markup is built here.
//
// Consumes the controls API (src/controls.js): hitTest (engine hook) for
// hover picking, screenAnchor for position, getParam(id,'depth') +
// sceneValues().fogDensity for the fog fade, serialize()/onSummon-era
// decoration + onSelectionChange for names.
//
// id -> name: the controls contract exposes names only for the SELECTED
// creature, so this module keeps its own registry:
//   1. boot — serialize()'s name csv is the flattened spawn order and the
//      engine assigns ids 'c1'.. in exactly that order; parsing each entry
//      with the same lexicon the engine uses reproduces the mapping.
//   2. summons — controls.summon is decorated (behavior preserved exactly)
//      to pair the returned first id with the resolved name (a batch of n
//      gets n sequential ids).
//   3. selection — getSelected() snapshots are authoritative and self-heal
//      anything learned no other way.
// controls.restore respawns at an unknown id base, so the decoration there
// clears the registry; an unknown id simply shows no label (never a wrong
// one). Creatures spawned via the __menagerie.test back-doors are unknown
// until first selected.

import { resolveName } from '../lexicon.js';

const FADE_RATE = 6; // 1/s — label surfaces/fades over ~250ms
const GAP_PX = 14; // gap between the body's radius and the name
const DEPTH_RANGE = 150; // world px at ctrl.depth = ±1 (mirrors main.js)
const FOG_FALLBACK = 0.0015; // moonlit fog, if sceneValues is unavailable
const FOG_POLL_S = 0.25;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * Wire the hover labels. Builds #labels (appended to <body>), replaces any
 * stale instance, and drives itself from a private rAF loop — main.js only
 * has to create it.
 *
 * @param {object} controls - the createControls(engine) instance
 * @returns {{ el: HTMLElement, dispose(): void }}
 */
export function initLabels(controls) {
  const stale = document.getElementById('labels');
  if (stale) stale.remove();

  const layer = document.createElement('div');
  layer.id = 'labels';
  const tag = document.createElement('div');
  tag.className = 'scene-label';
  layer.appendChild(tag);
  document.body.appendChild(layer);

  // ---- id -> name registry -------------------------------------------------
  const known = new Map(); // numeric id part -> display name
  const idNum = (id) => {
    const n = parseInt(String(id).slice(1), 10);
    return Number.isFinite(n) ? n : null;
  };

  function learnBatch(firstId, name, count) {
    const base = idNum(firstId);
    if (base == null) return;
    for (let i = 0; i < count; i++) known.set(base + i, name);
  }

  function seedFromHash() {
    let body = '';
    try {
      body = String(controls.serialize() || '');
    } catch {
      return;
    }
    const csv = body.split(';')[0]; // names segment of the extended schema
    if (!csv.trim()) return;
    let ord = 1; // boot boards spawn from id c1 in flattened batch order
    for (const entry of csv.split(',')) {
      const s = entry.trim();
      if (!s) continue;
      const res = resolveName(s); // the engine's own parser -> same names
      const n = Math.min(res.count, 6); // engine caps batches at 6
      for (let i = 0; i < n; i++) known.set(ord++, res.name);
    }
  }
  seedFromHash();

  // decorate summon/restore on the shared controls object (same returns,
  // same behavior — we only listen in)
  const origSummon = controls.summon;
  const wrapSummon = (text) => {
    const out = origSummon(text);
    if (out && out.ok && out.id) {
      const res = resolveName(text);
      learnBatch(out.id, res.name, Math.min(res.count, 6));
    }
    return out;
  };
  controls.summon = wrapSummon;
  const origRestore = controls.restore;
  const wrapRestore = (str) => {
    known.clear(); // fresh ids at an unknown base — never guess a name
    return origRestore(str);
  };
  controls.restore = wrapRestore;

  const offSel = controls.onSelectionChange((sel) => {
    if (!sel) return;
    const n = idNum(sel.id);
    if (n != null) known.set(n, sel.name);
  });

  // ---- hover tracking ------------------------------------------------------
  const pxy = { x: -1e5, y: -1e5 };
  let overChrome = false;
  const onMove = (e) => {
    pxy.x = e.clientX;
    pxy.y = e.clientY;
    const t = e.target;
    overChrome = !!(t && t.closest && t.closest('#plate, #summon, #rotary'));
  };
  window.addEventListener('pointermove', onMove, { passive: true });

  let hoverId = null; // creature the label element is bound to
  let effWant = null; // debounced hover target (see below)
  let candidate = null;
  let candT = 0;
  let alpha = 0;
  let fogMul = 1;
  let fogAt = -1e9;
  const STABLE_S = 0.15; // a new pick must hold this long to steal the label

  function fogFactor(id, nowS) {
    if (nowS - fogAt < FOG_POLL_S) return fogMul;
    fogAt = nowS;
    let density = FOG_FALLBACK;
    if (typeof controls.sceneValues === 'function') {
      const f = controls.sceneValues().fogDensity;
      if (Number.isFinite(f)) density = f;
    }
    // the dots attenuate as exp(-density * viewDepth); ctrl.depth moves the
    // body DEPTH_RANGE px toward (+1) or away from (-1) the lens, so the
    // label inherits the same falloff around the board's resting band
    const depth = clamp(Number(controls.getParam(id, 'depth')) || 0, -1, 1);
    fogMul = Math.exp(-density * DEPTH_RANGE * (1 - depth));
    return fogMul;
  }

  // ---- private frame loop --------------------------------------------------
  let raf = 0;
  let lastT = performance.now();
  function loop(t) {
    raf = requestAnimationFrame(loop);
    const dt = clamp((t - lastT) / 1000, 0.001, 0.05);
    lastT = t;

    let want = null;
    if (!overChrome && typeof controls.hitTest === 'function') {
      want = controls.hitTest(pxy.x, pxy.y);
      if (want != null && !known.has(idNum(want))) want = null; // no name, no label
    }

    // debounce: where bodies overlap, the engine's pick can flap between two
    // creatures frame to frame — a new pick must stay stable to take over
    if (want === effWant) {
      candidate = null;
      candT = 0;
    } else if (effWant == null) {
      effWant = want; // acquiring from nothing is immediate
    } else if (want === candidate) {
      candT += dt;
      if (candT >= STABLE_S) effWant = want;
    } else {
      candidate = want;
      candT = 0;
    }

    // one label: fade out fully before rebinding to another creature
    if (hoverId !== effWant && alpha <= 0.02) {
      hoverId = effWant;
      if (hoverId != null) {
        tag.textContent = known.get(idNum(hoverId)) || '';
        fogAt = -1e9; // re-read fog for the new body
      }
    }
    const target = hoverId != null && hoverId === effWant ? 1 : 0;
    alpha += (target - alpha) * Math.min(1, FADE_RATE * dt);

    if (hoverId == null) {
      if (tag.style.opacity !== '0') tag.style.opacity = '0';
      return;
    }
    const a = controls.screenAnchor(hoverId);
    if (!a) {
      // the body dispersed under the pointer — the name goes with it
      hoverId = null;
      effWant = null;
      candidate = null;
      alpha = 0;
      tag.style.opacity = '0';
      return;
    }
    const W = window.innerWidth;
    const x = clamp(a.x, 24, Math.max(W - 24, 24));
    let y = a.y - a.radiusPx - GAP_PX; // above the body, riding its drift
    if (y < 12) y = a.y + a.radiusPx + GAP_PX * 0.6; // near the surface: below
    tag.style.left = x.toFixed(1) + 'px';
    tag.style.top = y.toFixed(1) + 'px';
    tag.style.opacity = (alpha * fogFactor(hoverId, t / 1000)).toFixed(3);
  }
  raf = requestAnimationFrame(loop);

  return {
    el: layer,
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      if (typeof offSel === 'function') offSel();
      if (controls.summon === wrapSummon) controls.summon = origSummon;
      if (controls.restore === wrapRestore) controls.restore = origRestore;
      layer.remove();
    },
  };
}

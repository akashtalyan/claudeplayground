// Bathyscaphe State B chrome — the gauge plate.
// Fidelity contract: design/bathyscaphe/README.md (State B + Interactions).
//
// Styles live in ./chrome.css ("State B — gauge plate" section), loaded once
// via <link> in index.html — do NOT re-import it. Markup is built here.
//
// Consumes ONLY the controls API (src/controls.js):
//   controls.onSelectionChange(cb)  — cb(snapshot|null): surface / sink
//   controls.getSelected()          — { id, name, indexTag, params }
//   controls.screenAnchor(id)       — { x, y, radiusPx } per frame; the plate
//                                     follows it smoothly, avoiding edges
//   controls.setParam / getParam / paramRange
//   controls.reform / release
//
// Interactions per the contract:
//   entry  = blur 8px -> 0 + 6px upward drift, 400ms ease-out ("rising
//            through water"); exit reverses, slightly faster
//   drag   = inertia (the needle chases the pointer on an underdamped
//            spring) + soft felt detents on the display-unit grid; on
//            release the needle overshoots ~1 display unit and settles
//   values apply live via controls.setParam while the needle moves
//   behind 'more ›': twinkle / iridescence / dot density / depth sliders,
//   behavior as ONE 5-notch rotary, and the compact v2 color swatch row —
//   never inline ("at most 3 things visible without an explicit more").

const MAIN_KEYS = ['glow', 'tempo', 'sway', 'size'];
const ADV_KEYS = ['twinkle', 'iridescence', 'density', 'depth'];
const ADV_LABELS = { density: 'dot density' };

// v2 palette (particle-menagerie.html SWATCH): null = monochrome default
const V2_PALETTE = [null, 45, 15, 185, 165, 215, 275, 310, 130];

const SURFACE_MS = 400; // rise: blur 8px->0 + 6px upward drift, ease-out
const SINK_MS = 300; // exit reverses, slightly faster
const EDGE_PX = 14; // canvas-edge margin the plate never crosses
const GAP_PX = 18; // gap between the creature's radius and the plate
const FOLLOW_RATE = 10; // 1-exp(-rate*dt) anchor smoothing
const OMEGA = 16; // slider needle spring, rad/s
const ZETA = 0.55; // underdamped -> visible overshoot
const ROT_ZETA = 0.8; // rotary: overshoots ~a degree, not a notch

// one display unit per key (the gauge readout's grid — soft-detent spacing
// and the ~1-unit release overshoot), derived from PARAM_RANGES' fmt scale
const DISPLAY_UNIT = {
  glow: 1 / 50,
  tempo: 1 / 40,
  sway: 1 / 25,
  size: 0.1,
  twinkle: 1 / 50,
  iridescence: 1 / 100,
  density: 1 / 100,
  depth: 1 / 50,
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * Wire the State B gauge plate. Builds #plate (appended to <body>), replaces
 * any stale instance, and drives itself from a private rAF loop (anchor
 * follow + needle springs) — main.js only has to create it.
 *
 * @param {object} controls - the createControls(engine) instance
 * @returns {{ el: HTMLElement, dispose(): void }}
 */
export function initPlate(controls) {
  const stale = document.getElementById('plate');
  if (stale) stale.remove();

  const el = document.createElement('div');
  el.id = 'plate';

  // ---- markup -------------------------------------------------------------
  const head = document.createElement('div');
  head.className = 'plate-head';
  const nameEl = document.createElement('span');
  nameEl.className = 'plate-name';
  const tagEl = document.createElement('span');
  tagEl.className = 'plate-tag';
  head.append(nameEl, tagEl);

  const sliders = document.createElement('div');
  sliders.className = 'plate-sliders';

  const divider = document.createElement('div');
  divider.className = 'plate-divider';

  const actions = document.createElement('div');
  actions.className = 'plate-actions';
  const mkAction = (label, act) => {
    const s = document.createElement('span');
    s.className = 'chrome-action';
    s.dataset.act = act;
    s.textContent = label;
    s.setAttribute('role', 'button');
    s.tabIndex = 0;
    actions.appendChild(s);
    return s;
  };
  mkAction('re-form', 'reform');
  mkAction('release', 'release');
  const moreBtn = mkAction('more ›', 'more');
  moreBtn.setAttribute('aria-expanded', 'false');

  const more = document.createElement('div');
  more.className = 'plate-more';

  el.append(head, sliders, divider, actions, more);
  document.body.appendChild(el);

  // ---- slider rows + needle springs ---------------------------------------
  let selId = null;
  let visible = false;
  const springs = new Map(); // key -> spring/row state

  function buildRow(parent, key, adv) {
    const range = controls.paramRange(key);
    const row = document.createElement('div');
    row.className = 'plate-row' + (adv ? ' plate-row-adv' : '');
    row.dataset.key = key;
    row.tabIndex = 0;
    row.setAttribute('role', 'slider');
    row.setAttribute('aria-label', ADV_LABELS[key] || key);
    row.setAttribute('aria-valuemin', String(range.min));
    row.setAttribute('aria-valuemax', String(range.max));

    const label = document.createElement('span');
    label.className = 'plate-label';
    label.textContent = ADV_LABELS[key] || key;
    const track = document.createElement('div');
    track.className = 'plate-track';
    const needle = document.createElement('div');
    needle.className = 'plate-needle';
    track.appendChild(needle);
    const value = document.createElement('span');
    value.className = 'plate-value';
    row.append(label, track, value);
    parent.appendChild(row);

    const s = {
      key,
      range,
      unit: DISPLAY_UNIT[key],
      v: range.min,
      vel: 0,
      target: range.min,
      dir: 1,
      active: false,
      dragging: false,
      row,
      track,
      needle,
      value,
      lastPct: -1,
      lastTxt: '',
    };
    springs.set(key, s);

    // drag: needle chases the pointer (inertia) through soft detents
    const setTargetFromPointer = (ev) => {
      const r = s.track.getBoundingClientRect();
      if (r.width <= 0) return;
      const raw =
        s.range.min +
        clamp((ev.clientX - r.left) / r.width, 0, 1) * (s.range.max - s.range.min);
      const detent = Math.round(raw / s.unit) * s.unit;
      if (raw !== s.target) s.dir = Math.sign(raw - s.target) || s.dir;
      s.target = raw + (detent - raw) * 0.4; // soft felt detent pull
      s.active = true;
    };
    row.addEventListener('pointerdown', (ev) => {
      if (!selId || ev.button !== 0) return;
      ev.preventDefault();
      row.setPointerCapture(ev.pointerId);
      s.dragging = true;
      setTargetFromPointer(ev);
    });
    row.addEventListener('pointermove', (ev) => {
      if (s.dragging) setTargetFromPointer(ev);
    });
    const endDrag = () => {
      if (!s.dragging) return;
      s.dragging = false;
      const final = clamp(
        Math.round(s.target / s.unit) * s.unit,
        s.range.min,
        s.range.max,
      );
      // release: guarantee the ~1-display-unit overshoot before settling
      const need = s.unit * OMEGA * 1.6;
      if (Math.abs(s.vel) < need && Math.abs(final - s.v) < 3 * s.unit) {
        s.vel = (Math.sign(final - s.v) || s.dir) * need;
      }
      s.target = final;
    };
    row.addEventListener('pointerup', endDrag);
    row.addEventListener('pointercancel', endDrag);

    // keyboard: one display unit per arrow press
    row.addEventListener('keydown', (ev) => {
      const d = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
      if (!d || !selId) return;
      ev.preventDefault();
      ev.stopPropagation(); // keep the summon field from stealing focus keys
      s.dir = d;
      s.target = clamp(s.target + d * s.unit, s.range.min, s.range.max);
      s.active = true;
    });
    return s;
  }

  for (const k of MAIN_KEYS) buildRow(sliders, k, false);
  for (const k of ADV_KEYS) buildRow(more, k, true);

  function renderRow(s) {
    const cv = clamp(s.v, s.range.min, s.range.max);
    const pct = ((cv - s.range.min) / (s.range.max - s.range.min)) * 100;
    if (Math.abs(pct - s.lastPct) > 0.02) {
      s.lastPct = pct;
      s.needle.style.left = pct.toFixed(2) + '%';
    }
    const txt = s.range.fmt(cv);
    if (txt !== s.lastTxt) {
      s.lastTxt = txt;
      s.value.textContent = txt;
      s.row.setAttribute('aria-valuenow', String(+cv.toFixed(3)));
    }
  }

  // ---- behavior: one 5-notch rotary ---------------------------------------
  const behaviors = controls.paramRange('behavior').options;
  const behRow = document.createElement('div');
  behRow.className = 'plate-row plate-row-adv plate-behavior';
  const behLabel = document.createElement('span');
  behLabel.className = 'plate-label';
  behLabel.textContent = 'behavior';
  const mkArrow = (glyph, dir) => {
    const a = document.createElement('span');
    a.className = 'chrome-action plate-rot-arrow';
    a.textContent = glyph;
    a.setAttribute('role', 'button');
    a.setAttribute('aria-label', dir > 0 ? 'next behavior' : 'previous behavior');
    a.addEventListener('click', () => stepBehavior(dir));
    return a;
  };
  const rotary = document.createElement('div');
  rotary.className = 'plate-rotary';
  const ticks = document.createElement('div');
  ticks.className = 'plate-rotary-ticks';
  const disc = document.createElement('div');
  disc.className = 'plate-rotary-disc';
  const word = document.createElement('span');
  word.className = 'plate-rotary-word';
  rotary.append(ticks, disc, word);
  rotary.addEventListener('click', () => stepBehavior(1));
  behRow.append(behLabel, mkArrow('‹', -1), rotary, mkArrow('›', 1));
  more.appendChild(behRow);

  // rotary spring: 72 deg per notch, felt-detent settle (~1 deg overshoot)
  const rot = { a: 0, vel: 0, target: 0, notch: 0, active: false, last: 1e9 };
  function renderRotary() {
    if (Math.abs(rot.a - rot.last) < 0.05) return;
    rot.last = rot.a;
    ticks.style.transform = 'rotate(' + rot.a.toFixed(2) + 'deg)';
  }
  function stepBehavior(dir) {
    if (!selId) return;
    rot.notch += dir;
    rot.target = rot.notch * 72;
    rot.active = true;
    const idx = ((rot.notch % behaviors.length) + behaviors.length) % behaviors.length;
    word.textContent = behaviors[idx];
    controls.setParam(selId, 'behavior', behaviors[idx]);
  }

  // ---- color: compact v2 swatch row ---------------------------------------
  const colRow = document.createElement('div');
  colRow.className = 'plate-row plate-row-adv plate-colors';
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
    });
    swatches.appendChild(b);
    return b;
  });
  colRow.append(colLabel, swatches);
  more.appendChild(colRow);

  let curHue = null;
  function markSwatch(h) {
    curHue = h;
    swatchEls.forEach((b, i) => {
      const v = V2_PALETTE[i];
      b.classList.toggle('current', v == null ? h == null : v === h);
    });
  }

  // ---- actions ------------------------------------------------------------
  const runAction = (act) => {
    if (!selId) return;
    if (act === 'reform') controls.reform(selId);
    else if (act === 'release') controls.release(selId); // engine deselects -> sink
    else if (act === 'more') {
      const open = !el.classList.contains('more-open');
      el.classList.toggle('more-open', open);
      moreBtn.setAttribute('aria-expanded', String(open));
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

  // ---- surface / sink (rising through water) ------------------------------
  let anim = null;
  let snap = true;
  let px = 0;
  let py = 0;

  function populate(sel) {
    selId = sel.id;
    nameEl.textContent = sel.name;
    tagEl.textContent = sel.indexTag;
    for (const s of springs.values()) {
      s.v = s.target = clamp(sel.params[s.key], s.range.min, s.range.max);
      s.vel = 0;
      s.active = false;
      s.dragging = false;
      s.lastPct = -1;
      s.lastTxt = '';
      renderRow(s);
    }
    const bi = Math.max(behaviors.indexOf(sel.params.behavior), 0);
    rot.notch = bi;
    rot.a = rot.target = bi * 72;
    rot.vel = 0;
    rot.active = false;
    rot.last = 1e9;
    renderRotary();
    word.textContent = behaviors[bi];
    markSwatch(sel.params.color ?? null);
    el.classList.remove('more-open'); // a fresh selection starts minimal
    moreBtn.setAttribute('aria-expanded', 'false');
  }

  function surface(sel) {
    const wasVisible = visible;
    if (anim) {
      anim.cancel();
      anim = null;
    }
    el.classList.remove('sinking');
    populate(sel);
    if (wasVisible) return; // switching creatures: stay up, glide over
    visible = true;
    snap = true;
    el.classList.add('surfaced');
    place(0); // position before the rise so it doesn't fly across the screen
    anim = el.animate(
      [
        { opacity: 0, filter: 'blur(8px)', transform: 'translateY(6px)' },
        { opacity: 1, filter: 'blur(0px)', transform: 'translateY(0px)' },
      ],
      { duration: SURFACE_MS, easing: 'ease-out' },
    );
    anim.onfinish = () => {
      anim = null;
    };
  }

  function sink() {
    selId = null;
    if (!visible) return;
    visible = false;
    if (anim) anim.cancel();
    el.classList.add('sinking');
    anim = el.animate(
      [
        { opacity: 1, filter: 'blur(0px)', transform: 'translateY(0px)' },
        { opacity: 0, filter: 'blur(8px)', transform: 'translateY(6px)' },
      ],
      { duration: SINK_MS, easing: 'ease-in', fill: 'forwards' },
    );
    const done = () => {
      el.classList.remove('surfaced', 'sinking', 'more-open');
      moreBtn.setAttribute('aria-expanded', 'false');
      if (anim) {
        anim.cancel();
        anim = null;
      }
    };
    anim.onfinish = done;
  }

  // ---- anchor follow ------------------------------------------------------
  function place(dt) {
    const a = controls.screenAnchor(selId);
    if (!a) return;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let tx = a.x + a.radiusPx + GAP_PX; // prefer beside, to the right
    if (tx + w + EDGE_PX > W) tx = a.x - a.radiusPx - GAP_PX - w; // flip left
    tx = clamp(tx, EDGE_PX, Math.max(W - w - EDGE_PX, EDGE_PX));
    let ty = clamp(a.y - h / 2, EDGE_PX, Math.max(H - h - EDGE_PX, EDGE_PX));
    // The summon row (bottom-center, ~360px wide band above the bottom edge)
    // outranks the plate: lift the plate clear when they would overlap.
    const SUMMON_H = 104;
    const summonHalf = 190;
    if (tx + w > W / 2 - summonHalf && tx < W / 2 + summonHalf && ty + h > H - SUMMON_H) {
      ty = Math.max(H - h - SUMMON_H, EDGE_PX);
    }
    if (snap) {
      snap = false;
      px = tx;
      py = ty;
    } else {
      const k = 1 - Math.exp(-FOLLOW_RATE * dt);
      px += (tx - px) * k;
      py += (ty - py) * k;
    }
    el.style.left = px.toFixed(1) + 'px';
    el.style.top = py.toFixed(1) + 'px';
  }

  // ---- springs + live apply -----------------------------------------------
  function stepSprings(dt) {
    for (const s of springs.values()) {
      if (!s.active) continue;
      const k = OMEGA * OMEGA;
      const c = 2 * ZETA * OMEGA;
      s.vel += (k * (s.target - s.v) - c * s.vel) * dt;
      s.v += s.vel * dt;
      // the needle may overshoot the range by ~1 display unit, no further
      s.v = clamp(s.v, s.range.min - s.unit * 1.5, s.range.max + s.unit * 1.5);
      if (
        !s.dragging &&
        Math.abs(s.v - s.target) < s.unit * 0.05 &&
        Math.abs(s.vel) < s.unit * 0.5
      ) {
        s.v = s.target;
        s.vel = 0;
        s.active = false;
      }
      controls.setParam(selId, s.key, clamp(s.v, s.range.min, s.range.max));
      renderRow(s);
    }
    if (rot.active) {
      const k = OMEGA * OMEGA;
      const c = 2 * ROT_ZETA * OMEGA;
      rot.vel += (k * (rot.target - rot.a) - c * rot.vel) * dt;
      rot.a += rot.vel * dt;
      if (Math.abs(rot.a - rot.target) < 0.05 && Math.abs(rot.vel) < 0.5) {
        rot.a = rot.target;
        rot.vel = 0;
        rot.active = false;
      }
      renderRotary();
    }
  }

  // external changes (restore, other UI) reflected while idle
  function refreshFromEngine() {
    if (!selId) return;
    for (const s of springs.values()) {
      if (s.active || s.dragging) continue;
      const gv = controls.getParam(selId, s.key);
      if (typeof gv === 'number' && Math.abs(gv - s.v) > 1e-4) {
        s.v = s.target = gv;
        s.vel = 0;
        renderRow(s);
      }
    }
    const b = controls.getParam(selId, 'behavior');
    if (!rot.active && b && b !== word.textContent && behaviors.includes(b)) {
      const bi = behaviors.indexOf(b);
      rot.notch = bi;
      rot.a = rot.target = bi * 72;
      rot.last = 1e9;
      renderRotary();
      word.textContent = b;
    }
    const hue = controls.getParam(selId, 'color') ?? null;
    if (hue !== curHue) markSwatch(hue);
  }

  // ---- private frame loop -------------------------------------------------
  let raf = 0;
  let lastT = performance.now();
  function loop(t) {
    raf = requestAnimationFrame(loop);
    const dt = clamp((t - lastT) / 1000, 0.001, 0.05);
    lastT = t;
    if (!visible || !selId) return;
    place(dt);
    stepSprings(dt);
    refreshFromEngine();
  }
  raf = requestAnimationFrame(loop);

  // ---- wiring -------------------------------------------------------------
  const off = controls.onSelectionChange((sel) => (sel ? surface(sel) : sink()));
  const already = controls.getSelected();
  if (already) surface(already);

  return {
    el,
    dispose() {
      cancelAnimationFrame(raf);
      if (typeof off === 'function') off();
      if (anim) anim.cancel();
      el.remove();
    },
  };
}

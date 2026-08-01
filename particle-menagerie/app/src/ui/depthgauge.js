// Bathyscaphe chrome — the DEPTH GAUGE (v3.4).
//
// The vessel's own depth instrument: a slim vertical scale down the left edge
// that both READS the column ("where am I") and DRIVES it ("take me there").
// Fidelity contract: design/bathyscaphe/README.md — brass hairlines, amber
// phosphor needle, IBM Plex Mono readout, Spectral small-caps zone name,
// 150-200ms hovers, the 400ms rise-through-water entry, and the State C
// ambient rule (sinks with the rest of the chrome, returns on input).
//
// Styles live in ./chrome.css ("v3.4 — depth gauge" section), loaded once via
// <link> in index.html — do NOT re-import it. Markup is built here.
//
// Consumes ONLY the column API (src/column.js) and the zone/format helpers
// re-exported by src/depthprofile.js:
//   column.setDepth(m, { source })  — commanded depth; the COLUMN owns the
//                                     easing (critically damped + flank cap),
//                                     so every interaction here is a set-point
//                                     write and never a position write.
//   column.nudge(dm, { source })    — relative (wheel / arrow keys)
//   column.depth()                  — the eased, live depth: what the NEEDLE
//                                     and the readout show
//   column.targetDepth()            — the commanded depth: the set-point bug
//   column.range()                  — { min, max, surface, seabed, span };
//                                     SHARED object, read immediately
//   zoneAt(m).label                 — 'sunlit' / 'twilight' / 'midnight' /
//                                     'abyssal' (column.js's ZONES table is
//                                     the source of truth for zone names)
//   formatDepthM(m)                 — "643 m"
//
// The scale spans the WHOLE column (0 m .. seabed) so the numerals are true
// metres; the slightly inset navigable band (range().min .. .max — the vessel
// can never put the porthole above the waterline or below the floor) is drawn
// as a brighter segment of the same hairline, so the travel stops explain
// themselves without a word of copy.
//
// Contracts honoured:
//   * no per-frame allocation on the engine's path, and none of its own while
//     the vessel is parked: the rAF mirror reads numbers, and touches the DOM
//     only when a value actually moved (position past a sub-metre threshold,
//     text only when the ROUNDED metre changes). Nothing here allocates
//     objects or typed arrays; getBoundingClientRect is called on pointer
//     events only, never in the loop.
//   * no engine coupling — this module never touches the scene, the clock or
//     the sim; its private rAF loop only mirrors column state into the DOM.
//   * determinism — the gauge holds no state of its own that the board depends
//     on; the column (and therefore the URL hash) is the only owner of depth.

import { zoneAt, formatDepthM, SEABED_DEPTH_M, METRES_PER_PX, WHEEL_GAIN } from '../depthprofile.js';

// ---- scale ---------------------------------------------------------------
const MAJOR_M = 200; // major graduation (numeral) — also the zone boundaries
const MINOR_M = 50; // minor graduation between them

// ---- navigation gains ----------------------------------------------------
// Wheel over the gauge must feel EXACTLY like the wheel over the water, or the
// instrument and the porthole disagree about what a scroll means. The gain is
// column.js's own WHEEL_GAIN (world px of dive per wheel px) — imported, not
// mirrored, so the two can never drift apart — converted to metres here.
const WHEEL_M_PER_PX = WHEEL_GAIN * METRES_PER_PX;
const KEY_STEP_M = 25; // arrow key: a fine trim
const PAGE_STEP_M = MAJOR_M; // PageUp/PageDown: exactly one graduation

// ---- repaint thresholds (the "don't touch the DOM" guards) ---------------
const POS_EPS = 0.02; // % of the column — below this the needle hasn't moved
const TARGET_EPS_M = 3; // set-point bug appears once the vessel is this far off

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Mount the depth gauge.
 *
 * @param {object} column - the createColumn() instance (src/column.js)
 * @param {object} [opts]
 *   mount    parent element (default: document.body)
 * @returns {{ el: HTMLElement|null, depth(): number, dispose(): void }}
 */
export function initDepthGauge(column, opts = {}) {
  // Model-less boot (spike scenes never mount chrome): stay inert rather than
  // throwing into the integrator's boot path.
  if (!column || typeof column.setDepth !== 'function') {
    return { el: null, depth: () => 0, dispose() {} };
  }

  const stale = document.getElementById('depthgauge');
  if (stale) stale.remove();

  const parent = opts.mount || document.body;
  const span = SEABED_DEPTH_M || 1;
  const pct = (m) => clamp01(m / span) * 100;

  // ---- markup ------------------------------------------------------------
  const el = document.createElement('div');
  el.id = 'depthgauge';

  // numerals live LEFT of the hairline; the readout rides RIGHT of it, so the
  // two never collide as the needle sweeps the scale
  const scale = document.createElement('div');
  scale.className = 'dg-scale';

  const colEl = document.createElement('div');
  colEl.className = 'dg-column';
  colEl.tabIndex = 0;
  colEl.setAttribute('role', 'slider');
  colEl.setAttribute('aria-label', 'depth');
  colEl.setAttribute('aria-orientation', 'vertical');
  colEl.setAttribute('aria-valuemin', '0');
  colEl.setAttribute('aria-valuemax', String(Math.round(span)));

  // the reachable segment of the hairline (range().min .. .max)
  const reach = document.createElement('div');
  reach.className = 'dg-reach';
  colEl.appendChild(reach);

  // graduations + numerals — positioned in PERCENT, so a viewport resize
  // re-lays the whole scale with no JS and no reflow storm
  for (let m = 0; m <= span + 0.001; m += MINOR_M) {
    const major = Math.abs(m % MAJOR_M) < 0.001;
    const t = document.createElement('i');
    t.className = major ? 'dg-tick major' : 'dg-tick';
    t.style.top = pct(m).toFixed(4) + '%';
    colEl.appendChild(t);
    if (!major) continue;
    const n = document.createElement('i');
    n.className = 'dg-num';
    n.textContent = String(Math.round(m));
    n.style.top = pct(m).toFixed(4) + '%';
    scale.appendChild(n);
  }

  // the commanded-depth bug (a set-point marker: where the vessel is HEADED)
  const bug = document.createElement('i');
  bug.className = 'dg-bug';
  colEl.appendChild(bug);

  // the needle: the plate's 2x10px amber gauge needle, laid on its side
  const needle = document.createElement('i');
  needle.className = 'dg-needle';
  colEl.appendChild(needle);

  const read = document.createElement('div');
  read.className = 'dg-read';
  const value = document.createElement('span');
  value.className = 'dg-value';
  const zone = document.createElement('span');
  zone.className = 'dg-zone';
  read.append(value, zone);

  el.append(scale, colEl, read);
  parent.appendChild(el);

  // ---- interaction -------------------------------------------------------
  // Every gesture writes a SET-POINT. The column eases to it; the needle
  // follows the column. Nothing here ever positions the vessel directly.

  let dragging = false;

  function metresAt(clientY) {
    const r = colEl.getBoundingClientRect(); // pointer events only, never rAF
    return clamp01((clientY - r.top) / Math.max(r.height, 1)) * span;
  }

  function travel(clientY) {
    column.setDepth(metresAt(clientY), { source: 'gauge' });
  }

  const onPointerDown = (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation(); // never reads as an empty-water deselect click
    dragging = true;
    el.classList.add('awake');
    colEl.classList.add('dragging');
    try {
      colEl.setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety; the move listener still works without it */
    }
    travel(ev.clientY); // click anywhere on the column = travel there
  };
  const onPointerMove = (ev) => {
    if (!dragging) return;
    ev.preventDefault();
    travel(ev.clientY); // drag the needle
  };
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    colEl.classList.remove('dragging');
    if (!colEl.matches(':hover') && document.activeElement !== colEl) {
      el.classList.remove('awake');
    }
  };
  colEl.addEventListener('pointerdown', onPointerDown);
  colEl.addEventListener('pointermove', onPointerMove);
  colEl.addEventListener('pointerup', endDrag);
  colEl.addEventListener('pointercancel', endDrag);

  // wheel over the gauge — same gain as the wheel over the water
  const onWheel = (ev) => {
    ev.preventDefault(); // a dive control, not a scrollbar
    ev.stopPropagation();
    let px = ev.deltaY;
    if (ev.deltaMode === 1) px *= 16;
    else if (ev.deltaMode === 2) px *= window.innerHeight || 540;
    column.nudge(px * WHEEL_M_PER_PX, { source: 'gauge' });
  };
  colEl.addEventListener('wheel', onWheel, { passive: false });

  // arrow keys when focused. Handled keys are stopped here so column.js's own
  // window-level bindings don't apply the SAME step a second time; everything
  // else (Escape, typing) is left to bubble untouched.
  const onKey = (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const r = column.range();
    const lo = r.min;
    const hi = r.max;
    switch (ev.key) {
      case 'ArrowDown':
        column.nudge(KEY_STEP_M, { source: 'gauge' });
        break;
      case 'ArrowUp':
        column.nudge(-KEY_STEP_M, { source: 'gauge' });
        break;
      case 'PageDown':
        column.nudge(PAGE_STEP_M, { source: 'gauge' });
        break;
      case 'PageUp':
        column.nudge(-PAGE_STEP_M, { source: 'gauge' });
        break;
      case 'Home':
        column.setDepth(lo, { source: 'gauge' });
        break;
      case 'End':
        column.setDepth(hi, { source: 'gauge' });
        break;
      default:
        return;
    }
    ev.preventDefault();
    ev.stopPropagation();
  };
  colEl.addEventListener('keydown', onKey);

  // hover / focus lifts the scale out of the water (150-200ms, per the design)
  const wake = () => el.classList.add('awake');
  const rest = () => {
    if (!dragging && document.activeElement !== colEl) el.classList.remove('awake');
  };
  colEl.addEventListener('pointerenter', wake);
  colEl.addEventListener('pointerleave', rest);
  colEl.addEventListener('focus', wake);
  colEl.addEventListener('blur', rest);

  // ---- the live read (private rAF mirror; allocation-free at rest) --------
  let lastPos = -1e9; // % — needle + readout position
  let lastBug = -1e9; // % — set-point bug
  let lastBugOn = null;
  let lastM = -1e9; // rounded metres (drives every string we build)
  let lastZone = '';
  let lastLo = -1e9;
  let lastHi = -1e9;

  function paint() {
    const m = column.depth();
    const p = pct(m);
    if (Math.abs(p - lastPos) > POS_EPS) {
      lastPos = p;
      const s = p.toFixed(3) + '%';
      needle.style.top = s;
      read.style.top = s;
    }

    const rounded = Math.round(m);
    if (rounded !== lastM) {
      lastM = rounded;
      value.textContent = formatDepthM(rounded);
      colEl.setAttribute('aria-valuenow', String(rounded));
      const z = zoneAt(m).label;
      if (z !== lastZone) {
        lastZone = z;
        zone.textContent = z;
      }
      colEl.setAttribute('aria-valuetext', rounded + ' metres, ' + lastZone);
    }

    // the set-point bug: only while the vessel is still travelling to it
    const tgt = column.targetDepth();
    const on = Math.abs(tgt - m) > TARGET_EPS_M;
    if (on) {
      const bp = pct(tgt);
      if (Math.abs(bp - lastBug) > POS_EPS) {
        lastBug = bp;
        bug.style.top = bp.toFixed(3) + '%';
      }
    }
    if (on !== lastBugOn) {
      lastBugOn = on;
      bug.style.opacity = on ? '1' : '0';
    }

    // the navigable segment moves when the viewport height changes
    const r = column.range(); // shared object — read now, never retained
    if (r.min !== lastLo || r.max !== lastHi) {
      lastLo = r.min;
      lastHi = r.max;
      const a = pct(r.min);
      reach.style.top = a.toFixed(3) + '%';
      reach.style.height = Math.max(0, pct(r.max) - a).toFixed(3) + '%';
    }
  }

  let raf = 0;
  function loop() {
    raf = requestAnimationFrame(loop);
    paint();
  }

  // ---- entry: rise through water -----------------------------------------
  // 400ms ease-out, blur 8px -> 0 with a 6px upward drift (README Motion).
  // Held until the engine's first frame (body.booted), so the instrument
  // surfaces INTO a rendered scene instead of animating behind the boot gate.
  let mo = null;
  function rise() {
    if (typeof el.animate !== 'function') return;
    el.animate(
      [
        { opacity: 0, filter: 'blur(8px)', transform: 'translateY(6px)' },
        { opacity: 1, filter: 'blur(0px)', transform: 'translateY(0)' },
      ],
      { duration: 400, easing: 'ease-out' },
    );
  }
  const booted = () => document.body.classList.contains('booted');
  if (booted()) {
    rise();
  } else if (typeof MutationObserver === 'function') {
    mo = new MutationObserver(() => {
      if (!booted()) return;
      mo.disconnect();
      mo = null;
      rise();
    });
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  paint(); // first read before the first frame — never a blank instrument
  raf = requestAnimationFrame(loop);

  const api = {
    el,
    /** What the instrument is reading right now (metres). Test hook. */
    depth: () => column.depth(),
    dispose() {
      cancelAnimationFrame(raf);
      if (mo) mo.disconnect();
      colEl.removeEventListener('wheel', onWheel);
      el.remove();
    },
  };

  // Test hook, registered the way ui/ambient.js registers its own (twice, so
  // it survives main.js assigning window.__menagerie after the UI boots).
  const attach = () => {
    const m = (window.__menagerie = window.__menagerie || {});
    const ui = (m.ui = m.ui || {});
    ui.depthGauge = api;
  };
  attach();
  setTimeout(attach, 0);

  return api;
}

export default initDepthGauge;

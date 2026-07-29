// Bathyscaphe State A chrome — the weather rotary.
// Fidelity contract: design/bathyscaphe/README.md (State A + Interactions,
// latest revision: the rotary lives bottom-right at rest; the selected-state
// dial cluster is out of scope).
//
// Styles live in ./chrome.css ("State A — weather rotary" section), loaded
// once via <link> in index.html — do NOT re-import it. Markup is built here.
//
// Consumes ONLY the controls API (src/controls.js):
//   controls.presetNames() — ['moonlit','abyss','bioluminescent bay','ink','shallows']
//   controls.getPreset()   — polled so external changes (URL restore) turn the dial
//   controls.setPreset(n)  — the ENGINE owns the ~2s weather crossfade
//
// Look per the contract: ~40px circular tick ring
// (repeating-conic-gradient(rgba(255,195,122,.3) 0deg 1.6deg, transparent
// 1.6deg 72deg)), inner disc rgba(6,7,9,.92) inset 3px, current preset word
// centered in Spectral italic #ffd9a8; on hover the dial grows to 92px and
// the ‹ › affordances surface (rgba(255,235,214,.35), hover .8).
// ‹ › and drag-rotate step presets; the dial turns with inertia and soft
// felt detents, overshooting ~1 degree on release before settling.

const NOTCH = 72; // deg per preset stop (5 stops = the 5 tick groups)
const OMEGA = 16; // detent-settle spring, rad/s — same feel as the plate
const ZETA = 0.8; // slightly underdamped: ~1 deg overshoot, never a notch
const DETENT_PULL = 0.35; // soft felt detents while dragging
const CLICK_DEG = 3; // a press that turns less than this reads as a tap
// the rest disc is ~34px inside — the one preset word that cannot fit at
// 7px italic is shown abbreviated at rest (full word at hover size)
const REST_WORD = { 'bioluminescent bay': 'biolum. bay' };

const mod = (n, m) => ((n % m) + m) % m;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * Wire the weather rotary. Builds #rotary (appended to <body>), replaces any
 * stale instance, and drives itself from a private rAF loop (detent spring +
 * external preset sync) — main.js only has to create it.
 *
 * @param {object} controls - the createControls(engine) instance
 * @returns {{ el: HTMLElement, dispose(): void }}
 */
export function initRotary(controls) {
  const stale = document.getElementById('rotary');
  if (stale) stale.remove();

  const names = controls.presetNames();

  const el = document.createElement('div');
  el.id = 'rotary';

  const mkArrow = (glyph, dir, side, label) => {
    const a = document.createElement('span');
    a.className = 'rotary-arrow rotary-' + side;
    a.textContent = glyph;
    a.setAttribute('role', 'button');
    a.setAttribute('aria-label', label);
    a.tabIndex = 0;
    a.addEventListener('click', () => step(dir));
    a.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      step(dir);
    });
    return a;
  };

  const dial = document.createElement('div');
  dial.className = 'rotary-dial';
  dial.tabIndex = 0;
  dial.setAttribute('role', 'slider');
  dial.setAttribute('aria-label', 'weather');
  dial.setAttribute('aria-valuemin', '0');
  dial.setAttribute('aria-valuemax', String(names.length - 1));
  const ticks = document.createElement('div');
  ticks.className = 'rotary-ticks';
  const disc = document.createElement('div');
  disc.className = 'rotary-disc';
  const word = document.createElement('span');
  word.className = 'rotary-word';
  dial.append(ticks, disc, word);

  el.append(
    mkArrow('‹', -1, 'prev', 'previous weather'),
    dial,
    mkArrow('›', 1, 'next', 'next weather'),
  );
  document.body.appendChild(el);

  // ---- state ---------------------------------------------------------------
  let committed = typeof controls.getPreset === 'function' ? controls.getPreset() : names[0];
  if (!names.includes(committed)) committed = names[0];
  const rot = {
    a: names.indexOf(committed) * NOTCH,
    vel: 0,
    notch: names.indexOf(committed),
    active: false,
    last: 1e9,
  };
  let open = false;
  let drag = null; // { ang, raw, turned }

  function renderTicks() {
    if (Math.abs(rot.a - rot.last) < 0.05) return;
    rot.last = rot.a;
    ticks.style.transform = 'rotate(' + rot.a.toFixed(2) + 'deg)';
  }

  function setWord() {
    word.textContent = open ? committed : REST_WORD[committed] || committed;
    dial.setAttribute('aria-valuenow', String(mod(rot.notch, names.length)));
    dial.setAttribute('aria-valuetext', committed);
  }

  function setOpen(on) {
    if (open === on) return;
    open = on;
    el.classList.toggle('open', on);
    setWord();
  }

  function commit(notch) {
    const name = names[mod(notch, names.length)];
    if (name === committed) return;
    committed = name;
    controls.setPreset(name); // the engine crossfades the weather (~2s)
    setWord();
  }

  function step(dir) {
    rot.notch += dir;
    rot.active = true; // a 72-deg spring travel overshoots ~1 deg by itself
    commit(rot.notch);
  }

  // ---- drag-rotate ---------------------------------------------------------
  const angleOf = (ev) => {
    const r = dial.getBoundingClientRect();
    return (
      (Math.atan2(ev.clientY - (r.top + r.height / 2), ev.clientX - (r.left + r.width / 2)) *
        180) /
      Math.PI
    );
  };
  dial.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    dial.setPointerCapture(ev.pointerId);
    drag = { ang: angleOf(ev), raw: rot.a, turned: 0 };
    rot.active = false;
    rot.vel = 0;
    setOpen(true);
  });
  dial.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const ang = angleOf(ev);
    let d = ang - drag.ang;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    drag.ang = ang;
    drag.raw += d;
    drag.turned += Math.abs(d);
    const notch = Math.round(drag.raw / NOTCH);
    if (notch !== rot.notch) {
      rot.notch = notch;
      commit(notch); // crossing a detent IS the preset step
    }
    // the needle sticks slightly to the felt detent under the finger
    rot.a = drag.raw + (notch * NOTCH - drag.raw) * DETENT_PULL;
    renderTicks();
  });
  const endDrag = () => {
    if (!drag) return;
    const tapped = drag.turned < CLICK_DEG;
    drag = null;
    if (tapped) {
      step(1); // a tap on the dial turns to the next mood
    } else {
      // settle onto the detent with the felt ~1 deg overshoot
      const target = rot.notch * NOTCH;
      const need = OMEGA * 1.6;
      if (Math.abs(rot.vel) < need) rot.vel = (Math.sign(target - rot.a) || 1) * need;
      rot.active = true;
    }
    if (!el.matches(':hover') && !el.contains(document.activeElement)) setOpen(false);
  };
  dial.addEventListener('pointerup', endDrag);
  dial.addEventListener('pointercancel', endDrag);

  // keyboard: one preset per arrow press
  dial.addEventListener('keydown', (ev) => {
    const dir =
      ev.key === 'ArrowRight' || ev.key === 'ArrowUp'
        ? 1
        : ev.key === 'ArrowLeft' || ev.key === 'ArrowDown'
          ? -1
          : 0;
    if (!dir) return;
    ev.preventDefault();
    step(dir);
  });

  // ---- hover / focus grows the dial 40px -> 92px ---------------------------
  // only KEYBOARD focus (:focus-visible) holds the dial open once the
  // pointer leaves — a mouse click parks focus on the arrows and must not
  // pin the grown state
  const keyFocusInside = () => {
    const a = document.activeElement;
    try {
      return !!(a && el.contains(a) && a.matches(':focus-visible'));
    } catch {
      return !!(a && el.contains(a));
    }
  };
  const onEnter = () => setOpen(true);
  const onLeave = () => {
    if (!drag && !keyFocusInside()) setOpen(false);
  };
  const onFocusIn = () => setOpen(true);
  const onFocusOut = () => {
    // let focus land before deciding the dial is abandoned
    setTimeout(() => {
      if (!drag && !keyFocusInside() && !el.matches(':hover')) setOpen(false);
    }, 0);
  };
  el.addEventListener('pointerenter', onEnter);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('focusin', onFocusIn);
  el.addEventListener('focusout', onFocusOut);

  // ---- private frame loop: detent spring + external preset sync ------------
  let raf = 0;
  let lastT = performance.now();
  function loop(t) {
    raf = requestAnimationFrame(loop);
    const dt = clamp((t - lastT) / 1000, 0.001, 0.05);
    lastT = t;
    if (rot.active && !drag) {
      const target = rot.notch * NOTCH;
      const k = OMEGA * OMEGA;
      const c = 2 * ZETA * OMEGA;
      rot.vel += (k * (target - rot.a) - c * rot.vel) * dt;
      rot.a += rot.vel * dt;
      if (Math.abs(rot.a - target) < 0.05 && Math.abs(rot.vel) < 0.5) {
        rot.a = target;
        rot.vel = 0;
        rot.active = false;
      }
      renderTicks();
    } else if (!drag && !rot.active) {
      // the engine changed weather without us (URL restore, tests): turn to it
      const p = controls.getPreset();
      if (p !== committed && names.includes(p)) {
        committed = p;
        const cur = mod(rot.notch, names.length);
        let d = names.indexOf(p) - cur;
        if (d > names.length / 2) d -= names.length;
        if (d < -names.length / 2) d += names.length;
        rot.notch += d;
        rot.active = true;
        setWord();
      }
    }
  }

  renderTicks();
  setWord();
  raf = requestAnimationFrame(loop);

  return {
    el,
    dispose() {
      cancelAnimationFrame(raf);
      el.remove();
    },
  };
}

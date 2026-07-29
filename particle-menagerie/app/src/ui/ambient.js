// Bathyscaphe State C chrome — the ambient state machine.
// Fidelity contract: design/bathyscaphe/README.md (State C + State
// Management): ~30s since the last pointer/key event -> the needles keep
// drifting with the water for ~3s more, then ALL chrome sinks out of frame
// (downward drift + fade). Any keystroke, click, or mouse move past a small
// threshold returns State A — input first (the summon row rises before the
// rotary, the rotary before the plate; stagger lives in chrome.css).
//
// This module owns NO markup and draws nothing: it toggles `ambient` on
// <body> and lets the "State C — ambient" section of ./chrome.css move the
// chrome (#summon, #rotary, #plate, #labels). Pointer events are disabled on
// sunken chrome so the water underneath stays clickable.
//
// Test hook (required by the Phase D harness):
//   window.__menagerie.ui.forceAmbient(bool)

const IDLE_S = 30; // idle threshold since the last pointer/key event
const SETTLE_S = 3; // needles drift with the water this long before sinking
const WAKE_PX = 8; // mouse travel needed to wake — a tremor is not input
const CHECK_MS = 500; // idle-poll granularity

/**
 * Start the ambient state machine. Returns the controller; also registers
 * the forceAmbient test hook on window.__menagerie.ui.
 *
 * @returns {{ forceAmbient(on: boolean): void, isAmbient(): boolean, dispose(): void }}
 */
export function initAmbient() {
  let last = performance.now(); // last real input, ms
  let ambient = false;
  let anchor = null; // pointer position at ambient entry (wake threshold)

  function enter() {
    if (ambient) return;
    ambient = true;
    anchor = null;
    document.body.classList.add('ambient');
  }

  function wake() {
    last = performance.now(); // every input resets the idle clock
    if (!ambient) return;
    ambient = false;
    anchor = null;
    document.body.classList.remove('ambient'); // chrome.css staggers the rise
  }

  // keys and clicks always count as input; mouse motion must clear WAKE_PX
  // while ambient (per the contract: "mouse move past threshold")
  const onKey = () => wake();
  const onDown = () => wake();
  const onWheel = () => wake();
  const onMove = (e) => {
    if (!ambient) {
      last = performance.now();
      return;
    }
    if (!anchor) {
      anchor = { x: e.clientX, y: e.clientY };
      return;
    }
    if (Math.hypot(e.clientX - anchor.x, e.clientY - anchor.y) > WAKE_PX) wake();
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('wheel', onWheel, { capture: true, passive: true });
  window.addEventListener('pointermove', onMove, { capture: true, passive: true });

  // idle clock: sink begins IDLE_S + SETTLE_S after the last input — the
  // first IDLE_S is State A, the ~3s after are the needles' last drift
  const iv = setInterval(() => {
    if (!ambient && (performance.now() - last) / 1000 >= IDLE_S + SETTLE_S) enter();
  }, CHECK_MS);

  function forceAmbient(on) {
    if (on) enter();
    else wake();
  }
  const isAmbient = () => ambient;

  // test hook — attach now AND on the next macrotask, so it survives main.js
  // assigning window.__menagerie after the UI modules boot
  const attach = () => {
    const m = (window.__menagerie = window.__menagerie || {});
    const ui = (m.ui = m.ui || {});
    ui.forceAmbient = forceAmbient;
    ui.isAmbient = isAmbient;
  };
  attach();
  setTimeout(attach, 0);

  return {
    forceAmbient,
    isAmbient,
    dispose() {
      clearInterval(iv);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('wheel', onWheel, { capture: true });
      window.removeEventListener('pointermove', onMove, { capture: true });
      document.body.classList.remove('ambient');
    },
  };
}

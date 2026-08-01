// Bathyscaphe State A chrome — summon input + port light + sonar ring.
// Fidelity contract: design/bathyscaphe/README.md (State A + Interactions).
//
// Markup lives in index.html (#summon / #summon-input / .port-light); styles
// in ./chrome.css, loaded once via <link> in index.html — do NOT re-import it.
//
// Consumes the controls API (src/controls.js):
//   controls.summon(text)          — Enter submits the trimmed field text
//   controls.onSummon(cb)          — cb({ id, sizePx }); fires ONE sonar ring
//                                    whose radius = the new creature's sizePx
//
// No loading/error chrome ever: unknown names still form something (engine
// guarantee), so the field simply clears on Enter and we never inspect the
// summon() result.

const PING_MS = 2600; // sonar ring reuses the port-light ping timing
const PORT_PX = 6; // port-light diameter; the ring expands from it

/**
 * Wire the summon row. Idempotent per element set: binds to the markup in
 * index.html, building it (appended to <body>) only if absent — so tests can
 * boot the module on a bare page.
 *
 * @param {object} controls - the createControls(engine) instance
 * @returns {{ el: HTMLFormElement, input: HTMLInputElement, dispose(): void }}
 */
export function initSummon(controls) {
  let form = document.getElementById('summon');
  if (!form) {
    form = document.createElement('form');
    form.id = 'summon';
    form.autocomplete = 'off';
    form.innerHTML =
      '<span class="port-light" aria-hidden="true"><span class="port-ping"></span></span>' +
      '<input id="summon-input" placeholder="name a creature" autocomplete="off"' +
      ' autocapitalize="none" spellcheck="false" aria-label="name a creature">';
    document.body.appendChild(form);
  }
  const input = form.querySelector('#summon-input');
  const port = form.querySelector('.port-light');

  const onSubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    controls.summon(text);
    input.value = ''; // field clears; the sonar ring answers via onSummon
  };
  form.addEventListener('submit', onSubmit);

  // Any printable keystroke steers into the field (State C re-entry is
  // "any input brings State A back, input first").
  const onKeydown = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
    const a = document.activeElement;
    if (a === input || (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable))) return;
    input.focus();
  };
  document.addEventListener('keydown', onKeydown);

  const off = controls.onSummon(({ sizePx }) => fireSonarRing(port, sizePx));

  return {
    el: form,
    input,
    dispose() {
      form.removeEventListener('submit', onSubmit);
      document.removeEventListener('keydown', onKeydown);
      if (typeof off === 'function') off();
    },
  };
}

/**
 * One sonar ring expanding from the port light: 1px brass-50 border circle,
 * final radius = sizePx (CSS px), scaling up from port-light size while
 * fading .8 -> 0 over 2.6s ease-out (the ping's own curve), then removed.
 *
 * @param {HTMLElement} port - the .port-light element (position: relative)
 * @param {number} sizePx - the new creature's radius in CSS px
 */
export function fireSonarRing(port, sizePx) {
  if (!port) return;
  const d = Math.max(PORT_PX, (Number(sizePx) || 0) * 2); // final diameter
  const ring = document.createElement('span');
  ring.className = 'sonar-ring';
  ring.style.width = d + 'px';
  ring.style.height = d + 'px';
  port.appendChild(ring);
  const s0 = Math.min(1, PORT_PX / d);
  const anim = ring.animate(
    [
      { transform: `translate(-50%, -50%) scale(${s0})`, opacity: 0.8 },
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 0 },
    ],
    { duration: PING_MS, easing: 'ease-out' },
  );
  const done = () => ring.remove();
  anim.onfinish = done;
  anim.oncancel = done;
}

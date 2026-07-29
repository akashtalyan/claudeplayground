// Capture — Phase E I/O. PNG snapshots via the pipeline's same-rAF
// render-then-toBlob path (frame-graph rule 6: preserveDrawingBuffer stays
// false; pipeline.snapshot() re-composites into the drawing buffer and reads
// it back in the same tick). WebM recording via canvas.captureStream(30) +
// MediaRecorder (vp9, falling back to vp8, then plain webm), 60 s max,
// auto-download on stop.
//
// Keyboard: 'p' = snapshot, 'v' = toggle recording — ignored while the summon
// input (or any editable element) has focus. Registered capture-phase so the
// summon row's steer-any-key-into-the-field listener never sees these two.
//
// Chrome: NO new visible elements. While recording, the existing port-light
// ping ring is tinted a subtle coral recording pulse via body.recording
// (styles injected here, reusing chrome.css's ping keyframes untouched).
//
// This module is pure I/O: it reads wall time only for filenames and the 60 s
// stop timer — nothing here feeds back into the deterministic sim.

const MAX_RECORD_MS = 60_000;
const STYLE_ID = 'capture-recording-style';

// body.recording tints the resting chrome; the ping animation itself is the
// one already defined in chrome.css — reused, just re-colored and quickened.
const RECORDING_CSS = `
body.recording #summon .port-light {
  background: #ff9d8a;
  box-shadow: 0 0 8px rgba(255, 130, 110, 0.8);
}
body.recording #summon .port-ping {
  border-color: rgba(255, 130, 110, 0.55);
  animation-duration: 1.4s;
}
`;

function timestamp() {
  // I/O only (filename) — never read in a sim path
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '-' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // revoke on a macrotask so the click's navigation has read the URL
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ snapshot: () => Promise<Blob> }} pipeline
 * @returns {{ snapshotPNG(): Promise<Blob>, toggleRecording(): boolean,
 *             isRecording(): boolean, dispose(): void }}
 */
export function initCapture(canvas, pipeline) {
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = RECORDING_CSS;
    document.head.appendChild(st);
  }

  let recorder = null;
  let chunks = [];
  let stopTimer = 0;
  let recording = false;

  function snapshotPNG() {
    return pipeline.snapshot().then((blob) => {
      download(blob, `menagerie-${timestamp()}.png`);
      return blob;
    });
  }

  function startRecording() {
    if (typeof canvas.captureStream !== 'function') {
      console.warn('capture: canvas.captureStream unavailable — recording disabled');
      return false;
    }
    const mime = pickMime();
    if (!mime) {
      console.warn('capture: MediaRecorder webm unsupported — recording disabled');
      return false;
    }
    const stream = canvas.captureStream(30);
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    } catch (err) {
      console.warn('capture: MediaRecorder failed to start', err);
      return false;
    }
    chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      chunks = [];
      for (const track of stream.getTracks()) track.stop();
      if (blob.size) download(blob, `menagerie-${timestamp()}.webm`);
    };
    recorder.start(1000); // 1 s chunks so a long take never sits in one buffer
    stopTimer = setTimeout(() => {
      if (recording) toggleRecording(); // 60 s cap -> auto-stop + download
    }, MAX_RECORD_MS);
    recording = true;
    document.body.classList.add('recording');
    return true;
  }

  function stopRecording() {
    clearTimeout(stopTimer);
    recording = false;
    document.body.classList.remove('recording');
    if (recorder && recorder.state !== 'inactive') recorder.stop(); // onstop downloads
    recorder = null;
  }

  function toggleRecording() {
    if (recording) stopRecording();
    else startRecording();
    return recording;
  }

  // ---- keyboard: 'p' snapshot / 'v' record toggle -------------------------
  // Capture phase: runs before summon.js's document-level steer-into-field
  // listener; stopPropagation keeps these two keys out of the input.
  const onKeydown = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key !== 'p' && e.key !== 'v') return;
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'p') snapshotPNG();
    else if (!e.repeat) toggleRecording();
  };
  document.addEventListener('keydown', onKeydown, true);

  return {
    snapshotPNG,
    toggleRecording,
    isRecording: () => recording,
    dispose() {
      document.removeEventListener('keydown', onKeydown, true);
      if (recording) stopRecording();
    },
  };
}

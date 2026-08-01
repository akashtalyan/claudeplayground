/* fake-scene: canvas mock of the abyssal particle aquarium (dotted creatures + drifting specks) */
(function () {
  if (customElements.get('fake-scene')) return;
  function rng(seed) { let a = seed >>> 0 || 1; return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  class FakeScene extends HTMLElement {
    constructor() { super(); this._cfg = { variant: 'jelly', cx: 0.5, cy: 0.45, scale: 1, seed: 1 }; }
    static get observedAttributes() { return ['variant', 'cx', 'cy', 'scale', 'seed']; }
    attributeChangedCallback(n, _, v) { if (v == null) return; this._cfg[n] = n === 'variant' ? v : parseFloat(v); }
    connectedCallback() {
      for (const k of ['variant', 'cx', 'cy', 'scale', 'seed']) {
        if (Object.prototype.hasOwnProperty.call(this, k)) { this._cfg[k] = k === 'variant' ? this[k] : parseFloat(this[k]); delete this[k]; }
        const a = this.getAttribute(k); if (a != null) this._cfg[k] = k === 'variant' ? a : parseFloat(a);
      }
      this.style.display = 'block'; if (!this.style.width) this.style.width = '100%'; if (!this.style.height) this.style.height = '100%';
      const c = document.createElement('canvas'); c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%'; this.style.position = this.style.position || 'absolute'; this.appendChild(c);
      this._canvas = c; this._ctx = c.getContext('2d');
      const r = rng((this._cfg.seed || 1) * 9973);
      this._specks = Array.from({ length: 110 }, () => ({ x: r(), y: r(), a: 0.03 + r() * 0.09, s: 0.6 + r() * 1.2, w: 0.2 + r() * 0.8, p: r() * 6.28 }));
      this._agents = Array.from({ length: 60 }, () => ({ a: 20 + r() * 90, b: 12 + r() * 50, w: 0.05 + r() * 0.12, p: r() * 6.28, tilt: r() * 6.28, tw: r() * 6.28 }));
      this._ro = new ResizeObserver(() => this._size()); this._ro.observe(this); this._size();
      this._t0 = performance.now() + (this._cfg.seed || 0) * 1700;
      const loop = () => { this._raf = requestAnimationFrame(loop); this._draw(); };
      loop();
    }
    disconnectedCallback() { cancelAnimationFrame(this._raf); this._ro && this._ro.disconnect(); }
    _size() {
      const d = Math.min(devicePixelRatio || 1, 1.5), w = this.clientWidth, h = this.clientHeight;
      this._canvas.width = Math.max(1, w * d); this._canvas.height = Math.max(1, h * d); this._d = d; this._w = w; this._h = h;
    }
    _dot(x, y, rr, a, hue) {
      const g = this._ctx; const col = hue || '214,238,255';
      g.fillStyle = 'rgba(' + col + ',' + (a * 0.1).toFixed(3) + ')'; g.beginPath(); g.arc(x, y, rr * 3.2, 0, 6.283); g.fill();
      g.fillStyle = 'rgba(' + col + ',' + a.toFixed(3) + ')'; g.beginPath(); g.arc(x, y, rr, 0, 6.283); g.fill();
    }
    _draw() {
      const g = this._ctx, d = this._d, w = this._w, h = this._h; if (!w || !h) return;
      const t = (performance.now() - this._t0) / 1000;
      g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, w, h);
      for (const s of this._specks) {
        const x = ((s.x + t * 0.004 * s.w) % 1) * w, y = ((s.y + Math.sin(t * 0.1 + s.p) * 0.01) % 1) * h;
        this._dot(x, y, s.s * 0.8, s.a * (0.7 + 0.3 * Math.sin(t * s.w * 2 + s.p)));
      }
      const cx = this._cfg.cx * w + Math.sin(t * 0.13) * 14, cy = this._cfg.cy * h + Math.sin(t * 0.09 + 2) * 10, S = this._cfg.scale || 1;
      const v = this._cfg.variant;
      if (v === 'eel') this._eel(t, cx, cy, S); else if (v === 'school') this._school(t, cx, cy, S); else this._jelly(t, cx, cy, S);
    }
    _jelly(t, cx, cy, S) {
      const R = 74 * S, pulse = 1 + 0.07 * Math.sin(t * 0.9);
      for (let j = 0; j <= 8; j++) {
        const th = (j / 8) * 1.15, rr = R * Math.sin(th) * pulse, y = cy - R * 0.72 * Math.cos(th) + R * 0.1;
        const n = Math.max(5, Math.round(26 * Math.sin(th)));
        for (let i = 0; i < n; i++) {
          const ph = (i / n) * 6.283 + j * 0.35 + t * 0.05;
          const x = cx + Math.cos(ph) * rr, yy = y + Math.sin(ph) * rr * 0.24;
          this._dot(x, yy, 1.5 * S, 0.5 + 0.3 * Math.sin(ph * 2 + t));
        }
      }
      for (let k = 0; k < 6; k++) {
        const x0 = cx + (k - 2.5) * R * 0.3;
        for (let m = 0; m < 26; m++) {
          const y = cy + R * 0.32 + m * 6.2 * S;
          const x = x0 + Math.sin(t * 1.25 + m * 0.42 + k * 1.7) * m * 0.95 * S;
          this._dot(x, y, 1.15 * S, Math.max(0.05, 0.5 - m * 0.017));
        }
      }
    }
    _eel(t, cx, cy, S) {
      const hx = cx + Math.sin(t * 0.23) * 60, hy = cy + Math.sin(t * 0.31 + 1) * 30;
      for (let i = 0; i < 78; i++) {
        const x = hx - i * 6.4 * S + Math.sin(t * 0.5 + i * 0.06) * 8;
        const y = hy + Math.sin(t * 1.7 - i * 0.34) * (10 + i * 0.5) * S;
        const th = Math.max(0.4, 2.2 - i * 0.06) * S;
        this._dot(x, y - th, 1.3 * S, Math.max(0.06, 0.75 - i * 0.009), '255,214,224');
        this._dot(x, y + th, 1.3 * S, Math.max(0.06, 0.75 - i * 0.009), '255,214,224');
        if (i % 3 === 0) this._dot(x, y, 1.1 * S, 0.35, '255,235,240');
      }
    }
    _school(t, cx, cy, S) {
      for (const a of this._agents) {
        const ph = t * a.w * 3 + a.p;
        const x = cx + Math.cos(ph) * a.a * S + Math.sin(t * 0.7 + a.tw) * 5;
        const y = cy + Math.sin(ph) * a.b * S + Math.cos(t * 0.9 + a.tw) * 4;
        const dx = -Math.sin(ph), dy = Math.cos(ph) * (a.b / a.a);
        const L = Math.hypot(dx, dy) || 1;
        this._dot(x, y, 1.4 * S, 0.7);
        this._dot(x - (dx / L) * 4.5 * S, y - (dy / L) * 4.5 * S, 1.0 * S, 0.35);
      }
    }
  }
  customElements.define('fake-scene', FakeScene);
})();

// dsh-notemap Lit components — shadow DOM isolates ALL styles from host app.
// Floating draggable window variant (matches client.js dialog behavior).
import { LitElement, html, css } from 'lit';

export class NotemapPanel extends LitElement {
  static styles = css`
    :host { all: initial; }
    .toggle {
      position: fixed; top: 118px; right: 0; z-index: 2147483000;
      width: 34px; height: 34px; border: 1px solid #d1d5db; border-left: 0;
      border-radius: 0 9px 9px 0; background: rgba(255,255,255,.97); color: #4b5563;
      font-size: 14px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.12); padding: 0;
    }
    .toggle:hover { background: #f3f4f6; color: #111827; }
    .window {
      position: fixed; z-index: 2147482999; display: none;
      flex-direction: column; min-width: 320px; min-height: 240px;
      background: #fff; border: 1px solid #d1d5db; border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0,0,0,.35); overflow: hidden;
      font: 13px/1.5 Inter, system-ui, sans-serif; color: #1e293b;
    }
    .window.open { display: flex; }
    .head {
      display: flex; align-items: center; gap: 8px; padding: 7px 10px;
      border-bottom: 1px solid #e2e8f0; background: #fff;
      font: 600 13px Inter, system-ui, sans-serif; color: #1e293b;
      cursor: grab; user-select: none; flex: none;
    }
    .head:active { cursor: grabbing; }
    .head button { margin-left: auto; border: 0; background: none; font-size: 15px; cursor: pointer; color: #6b7280; }
    iframe { flex: 1; border: 0; width: 100%; background: #fff; }
    .grip { position: absolute; right: 2px; bottom: 2px; width: 14px; height: 14px; cursor: se-resize; }
  `;

  static properties = { open: { type: Boolean, reflect: true } };

  constructor() {
    super();
    this.open = false;
    this._rect = null;
    try {
      const r = JSON.parse(localStorage.getItem('dsh.notemap.rect') || 'null');
      if (r && r.left != null && r.top != null && r.w >= 320 && r.h >= 240) this._rect = r;
    } catch { /* ignore */ }
    if (!this._rect) this._rect = { left: Math.max(8, window.innerWidth - 600), top: 88, w: 560, h: 420 };
  }

  firstUpdated() {
    const win = this.renderRoot.querySelector('.window');
    win.style.left = this._rect.left + 'px';
    win.style.top = this._rect.top + 'px';
    win.style.width = this._rect.w + 'px';
    win.style.height = this._rect.h + 'px';
    const head = this.renderRoot.querySelector('.head');
    const grip = this.renderRoot.querySelector('.grip');
    const save = () => {
      try { localStorage.setItem('dsh.notemap.rect', JSON.stringify({ left: win.offsetLeft, top: win.offsetTop, w: win.offsetWidth, h: win.offsetHeight })); } catch { /* ignore */ }
    };
    let drag = null;
    head.addEventListener('pointerdown', (e) => { drag = { dx: e.clientX - win.offsetLeft, dy: e.clientY - win.offsetTop, moved: false }; head.setPointerCapture(e.pointerId); });
    head.addEventListener('pointermove', (e) => {
      if (!drag) return;
      win.style.left = Math.min(Math.max(0, e.clientX - drag.dx), window.innerWidth - 40) + 'px';
      win.style.top = Math.min(Math.max(0, e.clientY - drag.dy), window.innerHeight - 40) + 'px';
      drag.moved = true;
    });
    head.addEventListener('pointerup', () => { if (drag) { const m = drag.moved; drag = null; if (m) save(); } });
    let resize = null;
    grip.addEventListener('pointerdown', (e) => { resize = { x: e.clientX, y: e.clientY, w: win.offsetWidth, h: win.offsetHeight }; grip.setPointerCapture(e.pointerId); e.stopPropagation(); });
    grip.addEventListener('pointermove', (e) => {
      if (!resize) return;
      win.style.width = Math.max(320, Math.min(window.innerWidth - win.offsetLeft, resize.w + (e.clientX - resize.x))) + 'px';
      win.style.height = Math.max(240, Math.min(window.innerHeight - win.offsetTop, resize.h + (e.clientY - resize.y))) + 'px';
    });
    grip.addEventListener('pointerup', () => { if (resize) { resize = null; save(); } });
  }

  get frame() { return this.renderRoot.querySelector('iframe'); }

  toggle() { this.open = !this.open; }

  render() {
    return html`
      <button class="toggle" title="Knowledge map (dsh-notemap)" @click=${this.toggle}>🧠</button>
      <section class="window ${this.open ? 'open' : ''}">
        <div class="head"><span>🧠 知识图谱</span>
          <button title="Close" @click=${() => (this.open = false)}>✕</button></div>
        <iframe title="dsh-notemap canvas" src="/notemap/"></iframe>
        <div class="grip"></div>
      </section>
    `;
  }
}

if (!customElements.get('dsh-notemap-panel')) {
  customElements.define('dsh-notemap-panel', NotemapPanel);
}

export function mount(host) {
  const el = document.createElement('dsh-notemap-panel');
  (host || document.body).append(el);
  return el;
}

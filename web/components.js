// dsh-notemap Lit components — shadow DOM isolates ALL styles from host app
// (root cause fix for plugin UI collisions like web-ui-all sidebar menu breakage)
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
    .panel {
      position: fixed; top: 0; right: 0; bottom: 0;
      width: min(46vw, 720px); min-width: 340px; z-index: 2147482999;
      background: #f8fafc; border-left: 1px solid #e2e8f0;
      box-shadow: -8px 0 28px rgba(0,0,0,.16); display: flex; flex-direction: column;
      transform: translateX(100%); transition: transform .2s ease;
    }
    .panel.open { transform: translateX(0); }
    .head {
      display: flex; align-items: center; gap: 8px; padding: 9px 12px;
      border-bottom: 1px solid #e2e8f0; background: #fff;
      font: 600 13px Inter, system-ui, sans-serif; color: #1e293b;
    }
    .head button { margin-left: auto; border: 0; background: none; font-size: 15px; cursor: pointer; color: #6b7280; }
    iframe { flex: 1; border: 0; width: 100%; background: #fff; }
  `;

  static properties = { open: { type: Boolean, reflect: true } };

  constructor() { super(); this.open = false; }

  get frame() { return this.renderRoot.querySelector('iframe'); }

  toggle() { this.open = !this.open; }

  render() {
    return html`
      <button class="toggle" title="Knowledge map (dsh-notemap)" @click=${this.toggle}>🧠</button>
      <section class="panel ${this.open ? 'open' : ''}">
        <div class="head"><span>🧠 Notemap</span>
          <button title="Close" @click=${() => (this.open = false)}>✕</button></div>
        <iframe title="dsh-notemap canvas" src="/notemap/"></iframe>
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

// dsh-notemap client - injects a Lit-based side-map panel into the DSH web app
// Lit shadow DOM isolates ALL styles/IDs - zero collision with other UI plugins (web-ui-all etc.)
window.__ModuleLoader__.load({
  id: '@snow-the/dsh-notemap',
  factory: () => {
    const module = { exports: {} };

    // health marker: set as soon as this client executes (guide_boot uiChecks target)
    document.documentElement.setAttribute('data-notemap-mounted', '');

    // ---- factory-level bootstrap: runs immediately, does NOT depend on apply() ----
    let frame = null;
    (async () => {
      try {
        const mod = await import('/notemap/lit.bundle.js');
        const panel = mod.mount(document.body);
        frame = panel.frame;
      } catch (err) {
        console.error('[dsh-notemap] lit bundle load failed', err);
      }
    })();

    const send = (type, payload) => {
      frame?.contentWindow?.postMessage({ source: 'dsh-notemap', type, ...payload }, location.origin);
    };
    const togglePanel = () => {
      if (!frame) return;
      const hidden = frame.style.display === 'none';
      frame.style.display = hidden ? '' : 'none';
      if (hidden) send('notemap:refresh', {});
    };

    // ---- official conversation.session.header slot entry ----
    // DOM-injected into the official [data-slot] container: no React dependency.
    const ensureHeaderButton = () => {
      const host = document.querySelector('[data-slot="conversation.session.header"]');
      if (!host) return;
      const bar = host.querySelector('header') || host;
      if (bar.querySelector('[data-notemap-anchor]')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.notemapAnchor = 'true';
      btn.title = '打开图谱视图(notemap)';
      btn.setAttribute('aria-label', '打开图谱视图');
      btn.textContent = '图谱';
      btn.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border:1px solid var(--ds-border, #444);border-radius:6px;background:transparent;color:inherit;font-size:12px;cursor:pointer;line-height:1.6;';
      btn.addEventListener('click', togglePanel);
      bar.appendChild(btn);
    };
    const headerObserver = new MutationObserver(ensureHeaderButton);
    headerObserver.observe(document.body, { childList: true, subtree: true });
    ensureHeaderButton();

    module.exports.inject = ['sessions'];
    module.exports.apply = async () => {
      // legacy: no-op - bootstrap already ran in factory scope
    };
    return module.exports;
  }
});

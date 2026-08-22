// dsh-notemap client — injects a side-map panel into the DSH web app
// Official mechanism: window.__ModuleLoader__.load({ id, factory })
window.__ModuleLoader__.load({
  id: 'dsh-notemap',
  factory: () => {
    const module = { exports: {} };

    module.exports.inject = ['sessions'];

    module.exports.apply = (ctx) => {
      // ---- styles (dsh-notemap- prefixed to avoid clashing with web-ui-all) ----
      const style = document.createElement('style');
      style.textContent = [
        '.dsh-notemap-toggle{position:fixed;top:118px;right:0;z-index:9000;width:34px;height:34px;border:1px solid #d1d5db;border-left:0;border-radius:0 9px 9px 0;background:rgba(255,255,255,.97);color:#4b5563;font-size:14px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.12);padding:0}',
        '.dsh-notemap-toggle:hover{background:#f3f4f6;color:#111827}',
        '.dsh-notemap-panel{position:fixed;top:0;right:0;bottom:0;width:min(46vw,720px);min-width:340px;z-index:8999;background:#f8fafc;border-left:1px solid #e2e8f0;box-shadow:-8px 0 28px rgba(0,0,0,.16);display:flex;flex-direction:column;transition:transform .2s ease}',
        '.dsh-notemap-panel[hidden]{display:none}',
        '.dsh-notemap-panel-head{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid #e2e8f0;background:#fff;font:600 13px Inter,system-ui,sans-serif;color:#1e293b}',
        '.dsh-notemap-panel-head button{margin-left:auto;border:0;background:none;font-size:15px;cursor:pointer;color:#6b7280}',
        '.dsh-notemap-panel iframe{flex:1;border:0;width:100%;background:#fff}'
      ].join('');
      document.head.append(style);

      // ---- host DOM ----
      const host = document.createElement('div');
      host.className = 'dsh-notemap-host';
      host.innerHTML = [
        '<button type="button" class="dsh-notemap-toggle" title="Knowledge map (dsh-notemap)">🧠</button>',
        '<section class="dsh-notemap-panel" hidden><div class="dsh-notemap-panel-head"><span>🧠 Notemap</span><button type="button" title="Close">✕</button></div><iframe title="dsh-notemap canvas" src="/notemap/"></iframe></section>'
      ].join('');
      document.body.append(host);
      const toggle = host.querySelector('.dsh-notemap-toggle');
      const panel = host.querySelector('.dsh-notemap-panel');
      const frame = panel.querySelector('iframe');
      const closeBtn = panel.querySelector('.dsh-notemap-panel-head button');

      const send = (type, payload) => {
        frame.contentWindow?.postMessage({ source: 'dsh-notemap', type, ...payload }, location.origin);
      };

      const projectEvents = (events) => {
        if (!events.length) return;
        void fetch('/notemap/api/project', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ events }),
        }).catch(() => {});
      };

      // ---- session event projection: user/assistant messages + todos become graph nodes ----
      let lastSeq = 0;
      const projectSession = (sessionId) => {
        const scope = ctx.sessions.scope(sessionId);
        const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope);
        if (session === undefined) return;
        const state = session.getSnapshot();
        const events = [];
        let prevId = null;
        for (const block of state.partial?.blocks ?? []) {
          if (block.kind !== 'text') continue;
          const text = block.text?.slice(0, 600) ?? '';
          if (!text) continue;
          const isUser = block.role === 'user';
          const evId = 'sess-' + sessionId + '-' + (block.seq ?? block.id ?? Math.random().toString(36).slice(2, 8));
          events.push({
            id: evId,
            title: (isUser ? '🗣 ' : '🤖 ') + text.replace(/\s+/g, ' ').slice(0, 48),
            content: text,
            type: isUser ? 'user-message' : 'assistant-message',
            parentId: prevId,
            edgeType: isUser ? 'asks' : 'answers',
            weight: 0.8,
          });
          prevId = evId;
        }
        if (events.length) projectEvents(events);
      };

      // subscribe to live session state; debounce a bit
      let timer = 0;
      const liveUnsubscribers = new Map();
      const sync = () => {
        const snapshot = ctx.sessions.list.getSnapshot();
        for (const id of snapshot.ids) {
          if (liveUnsubscribers.has(id)) continue;
          const scope = ctx.sessions.scope(id);
          const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope);
          if (session === undefined) continue;
          const publish = () => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => projectSession(id), 700);
          };
          liveUnsubscribers.set(id, session.subscribe(publish));
          publish();
        }
        for (const [id, unsubscribe] of liveUnsubscribers) {
          if (!snapshot.ids.includes(id)) { unsubscribe(); liveUnsubscribers.delete(id); }
        }
      };
      if (ctx.sessions?.list?.subscribe) {
        ctx.sessions.list.subscribe(sync);
      }
      sync();

      // ---- toggle ----
      const open = () => {
        panel.hidden = false;
        sync();
        send('notemap:open', {});
      };
      const close = () => { panel.hidden = true; };
      toggle.addEventListener('click', () => {
        if (panel.hidden) open(); else close();
      });
      closeBtn.addEventListener('click', close);

      // ---- postMessage bridge (origin-checked) ----
      window.addEventListener('message', (ev) => {
        if (ev.origin !== location.origin) return;
        if (ev.data?.source !== 'dsh-notemap') return;
        const type = ev.data.type;
        if (type === 'notemap:graph-changed') {
          if (!panel.hidden) send('notemap:refresh', {});
        }
      });

      // ---- dispose ----
      return () => {
        for (const unsubscribe of liveUnsubscribers.values()) unsubscribe();
        liveUnsubscribers.clear();
        host.remove();
        style.remove();
      };
    };

    return module.exports;
  },
});
// dsh-notemap client — injects a Lit-based side-map panel into the DSH web app
// Lit shadow DOM isolates ALL styles/IDs — zero collision with other UI plugins (web-ui-all etc.)
window.__ModuleLoader__.load({
  id: 'dsh-notemap',
  factory: () => {
    const module = { exports: {} };

    module.exports.inject = ['sessions'];

    module.exports.apply = async (ctx) => {
      // ---- load Lit bundle (single-file, pre-built, committed to repo) ----
      let panel = null;
      try {
        const mod = await import('/notemap/lit.bundle.js');
        panel = mod.mount(document.body);
      } catch (err) {
        console.error('[dsh-notemap] lit bundle load failed', err);
        return;
      }

      const frame = panel.frame;
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

      // ---- session event projection: user/assistant messages become graph nodes ----
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

      // ---- postMessage bridge (origin-checked) ----
      window.addEventListener('message', (ev) => {
        if (ev.origin !== location.origin) return;
        if (ev.data?.source !== 'dsh-notemap') return;
        const type = ev.data.type;
        if (type === 'notemap:graph-changed') {
          if (panel.open) send('notemap:refresh', {});
        }
      });

      // ---- dispose ----
      return () => {
        for (const unsubscribe of liveUnsubscribers.values()) unsubscribe();
        liveUnsubscribers.clear();
        panel?.remove();
      };
    };

    return module;
  },
});

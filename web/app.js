// dsh-notemap canvas — zero-dependency infinite canvas
(function () {
  const canvas = document.getElementById('nm-canvas');
  const ctx2d = canvas.getContext('2d');
  const search = document.getElementById('nm-search');
  const countEl = document.getElementById('nm-count');
  const inspector = document.getElementById('nm-inspector');
  let nodes = [];
  let edges = [];
  let view = { x: 0, y: 0, scale: 1 };
  let drag = null;
  let pan = null;
  let selectedId = null;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function screenToWorld(sx, sy) {
    return { x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale };
  }

  function draw() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx2d.clearRect(0, 0, w, h);
    ctx2d.save();
    ctx2d.translate(view.x, view.y);
    ctx2d.scale(view.scale, view.scale);
    // grid
    ctx2d.strokeStyle = 'rgba(0,0,0,0.06)';
    ctx2d.lineWidth = 1 / view.scale;
    const gs = 40;
    const x0 = Math.floor(-view.x / view.scale / gs) * gs;
    const y0 = Math.floor(-view.y / view.scale / gs) * gs;
    ctx2d.beginPath();
    for (let x = x0; x < x0 + w / view.scale + gs; x += gs) { ctx2d.moveTo(x, y0); ctx2d.lineTo(x, y0 + h / view.scale + gs); }
    for (let y = y0; y < y0 + h / view.scale + gs; y += gs) { ctx2d.moveTo(x0, y); ctx2d.lineTo(x0 + w / view.scale + gs, y); }
    ctx2d.stroke();
    // edges
    for (const e of edges) {
      const s = nodes.find((n) => n.id === e.source);
      const t = nodes.find((n) => n.id === e.target);
      if (!s || !t) continue;
      const weight = e.weight ?? 1;
      ctx2d.strokeStyle = selectedId === e.source || selectedId === e.target ? '#6366f1' : 'rgba(100,116,139,0.35)';
      ctx2d.lineWidth = Math.max(0.5, Math.min(3.5, weight * 3)) / view.scale;
      ctx2d.beginPath();
      ctx2d.moveTo(s.x, s.y);
      ctx2d.lineTo(t.x, t.y);
      ctx2d.stroke();
    }
    // nodes
    for (const n of nodes) {
      const r = Math.max(10, Math.min(26, 10 + (n.content?.length ?? 0) / 40));
      const isSel = n.id === selectedId;
      ctx2d.beginPath();
      ctx2d.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx2d.fillStyle = isSel ? '#6366f1' : (n.type === 'session-event' ? '#0ea5e9' : '#f59e0b');
      ctx2d.fill();
      ctx2d.strokeStyle = isSel ? '#fff' : 'rgba(0,0,0,0.2)';
      ctx2d.lineWidth = isSel ? 2 : 1;
      ctx2d.stroke();
      const label = String(n.title ?? n.id).slice(0, 24);
      ctx2d.fillStyle = '#1f2937';
      ctx2d.font = '11px Inter, system-ui, sans-serif';
      ctx2d.fillText(label, n.x + r + 4, n.y + 4);
    }
    ctx2d.restore();
  }

  // simple force-directed layout (radial fallback if no edges)
  function layout() {
    const n = nodes.length;
    if (n === 0) return;
    if (edges.length === 0) {
      nodes.forEach((node, i) => {
        const a = (i / n) * Math.PI * 2;
        const rr = Math.max(120, n * 24);
        node.x = Math.cos(a) * rr; node.y = Math.sin(a) * rr;
      });
      return;
    }
    // seed ring
    nodes.forEach((node, i) => { const a = (i / n) * Math.PI * 2; const rr = Math.max(150, n * 18); node.x = Math.cos(a) * rr; node.y = Math.sin(a) * rr; });
    // iterate attraction/repulsion
    for (let iter = 0; iter < 80; iter++) {
      const forces = nodes.map(() => ({ x: 0, y: 0 }));
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d = Math.max(1, Math.hypot(dx, dy));
          const rep = 1200 / (d * d);
          forces[i].x += (dx / d) * rep; forces[i].y += (dy / d) * rep;
          forces[j].x -= (dx / d) * rep; forces[j].y -= (dy / d) * rep;
        }
      }
      for (const e of edges) {
        const s = nodes.find((n) => n.id === e.source);
        const t = nodes.find((n) => n.id === e.target);
        if (!s || !t) continue;
        const dx = t.x - s.x, dy = t.y - s.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const want = 120;
        const f = (d - want) * 0.03;
        const si = nodes.indexOf(s), ti = nodes.indexOf(t);
        forces[si].x += (dx / d) * f; forces[si].y += (dy / d) * f;
        forces[ti].x -= (dx / d) * f; forces[ti].y -= (dy / d) * f;
      }
      nodes.forEach((node, i) => { node.x += forces[i].x * 0.5; node.y += forces[i].y * 0.5; });
    }
  }

  async function load() {
    try {
      const res = await fetch('/notemap/api/graph');
      const data = await res.json();
      nodes = (data.nodes ?? []).map((n) => ({ id: n.id, title: n.title, content: n.content, type: n.type, x: 0, y: 0 }));
      edges = (data.edges ?? []).map((e) => ({ source: e.source, target: e.target, weight: e.weight }));
      layout();
      countEl.textContent = nodes.length + ' nodes · ' + edges.length + ' edges';
      draw();
    } catch (err) { countEl.textContent = 'load error: ' + err; }
  }

  function findNodeAt(sx, sy) {
    const p = screenToWorld(sx, sy);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const r = Math.max(10, Math.min(26, 10 + (n.content?.length ?? 0) / 40)) + 6;
      if (Math.hypot(n.x - p.x, n.y - p.y) <= r) return n;
    }
    return null;
  }

  async function showInspector(node) {
    selectedId = node.id;
    document.getElementById('nm-inspector-title').textContent = node.title;
    document.getElementById('nm-inspector-body').textContent = node.content || '(no content)'
    const relEl = document.getElementById('nm-inspector-related');
    try {
      const res = await fetch('/notemap/api/related?id=' + encodeURIComponent(node.id) + '&limit=8');
      const data = await res.json();
      relEl.textContent = 'related: ' + (data.items ?? []).map((i) => i.title).join(' → ') || '—';
    } catch { relEl.textContent = 'related: n/a'; }
    inspector.hidden = false;
    draw();
  }

  canvas.addEventListener('pointerdown', (ev) => {
    const node = findNodeAt(ev.clientX - canvas.getBoundingClientRect().left, ev.clientY - canvas.getBoundingClientRect().top);
    if (node) { drag = { id: node.id, dx: node.x, dy: node.y, px: ev.clientX, py: ev.clientY }; canvas.setPointerCapture(ev.pointerId); }
    else { pan = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y }; canvas.setPointerCapture(ev.pointerId); }
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (drag) {
      const node = nodes.find((n) => n.id === drag.id);
      if (node) { const p = screenToWorld(ev.clientX, ev.clientY); node.x = drag.dx + (p.x - screenToWorld(drag.px, drag.py).x); node.y = drag.dy + (p.y - screenToWorld(drag.px, drag.py).y); }
      draw();
    } else if (pan) {
      view.x = pan.vx + (ev.clientX - pan.x);
      view.y = pan.vy + (ev.clientY - pan.y);
      draw();
    }
  });
  canvas.addEventListener('pointerup', (ev) => {
    if (drag) {
      if (Math.hypot(ev.clientX - drag.px, ev.clientY - drag.py) < 5) { const node = nodes.find((n) => n.id === drag.id); if (node) void showInspector(node); }
      drag = null;
    } else { pan = null; }
  });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const factor = ev.deltaY > 0 ? 0.9 : 1.1;
    const rect = canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
    const p = screenToWorld(sx, sy);
    view.scale = Math.min(4, Math.max(0.1, view.scale * factor));
    view.x = sx - p.x * view.scale;
    view.y = sy - p.y * view.scale;
    draw();
  }, { passive: false });

  document.getElementById('nm-add').addEventListener('click', () => {
    const title = prompt('Note title:');
    if (!title) return;
    void fetch('/notemap/api/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) })
      .then(() => load());
  });

  // workspace: import material (paste text/URL -> knowledge node)
  document.getElementById('nm-import').addEventListener('click', async () => {
    const text = prompt('导入资料(粘贴文本或 URL):\n\n第一行作为标题,其余作为内容。');
    if (!text || !text.trim()) return;
    const lines = text.split('\n');
    const title = (lines[0] || 'untitled').trim().slice(0, 80);
    const content = lines.slice(1).join('\n').trim() || text.trim();
    const type = /^https?:\/\//.test(content.trim()) ? 'link' : 'note';
    await fetch('/notemap/api/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, content, type }) });
    await load();
  });

  // workspace: import DSH sessions (checkpoint knowledge extraction)
  document.getElementById('nm-sessions').addEventListener('click', async () => {
    const btn = document.getElementById('nm-sessions');
    btn.textContent = '⏳ 提取中…';
    btn.disabled = true;
    try {
      const res = await fetch('/notemap/api/import-session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const data = await res.json();
      alert('已导入: ' + data.sessions + ' 个会话, ' + data.checkpoints + ' 个知识点, ' + data.events + ' 个用户事件(扫描 ' + data.scanned + ' 个文件)');
    } catch (err) {
      alert('导入失败: ' + err);
    }
    btn.textContent = '🗨 会话';
    btn.disabled = false;
    await load();
  });

  // workspace: clear (needs confirm)
  document.getElementById('nm-clear').addEventListener('click', async () => {
    if (!confirm('清空整个知识图谱?(所有节点和边将被删除,快照历史保留)')) return;
    await fetch('/notemap/api/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
    await load();
  });
  document.getElementById('nm-layout').addEventListener('click', () => { layout(); draw(); });
  document.getElementById('nm-fit').addEventListener('click', () => { view = { x: 0, y: 0, scale: 1 }; draw(); });
  document.getElementById('nm-inspector-close').addEventListener('click', () => { inspector.hidden = true; selectedId = null; draw(); });
  search.addEventListener('input', () => {
    const q = search.value.trim();
    if (!q) { draw(); return; }
    const hits = new Set(nodes.filter((n) => (n.title + ' ' + (n.content ?? '')).toLowerCase().includes(q.toLowerCase())).map((n) => n.id));
    nodes.forEach((n) => { n._dim = !hits.has(n.id); });
    draw();
  });
  window.addEventListener('resize', resize);
  setInterval(() => { void load(); }, 8000);
  resize();
  void load();
})();
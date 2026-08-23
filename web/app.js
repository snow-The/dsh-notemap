// dsh-notemap canvas — litegraph.js node editor.
// Knowledge notes become draggable nodes with input/output ports; drag from a
// port to another node to link knowledge ACROSS sessions (persisted to graph.db).
// "Classify" button auto-groups nodes into columns by type (auto-categorization).
(function () {
  'use strict';
  const TYPE_COLORS = {
    session: '#059669', checkpoint: '#7c3aed', 'session-event': '#0284c7',
    note: '#d97706', link: '#dc2626',
  };
  const TYPE_ORDER = ['session', 'checkpoint', 'session-event', 'note', 'link'];
  const TYPE_COL_X = { session: 0, checkpoint: 380, 'session-event': 760, note: 1140, link: 1520 };

  const countEl = document.getElementById('nm-count');
  const inspector = document.getElementById('nm-inspector');

  const post = (url, body) => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).catch(() => {});
  const unlink = (source, target, type) => post('/notemap/api/unlink', { source, target, type });

  // ---- custom node type: one knowledge note ----
  function NoteNode() {
    LiteGraph.LGraphNode.call(this); // REQUIRED: initializes properties/inputs/outputs
    this.addInput('in', 'flow');
    this.addOutput('out', 'flow');
    this.size = [240, 64];
  }
  NoteNode.prototype = Object.create(LiteGraph.LGraphNode.prototype);
  NoteNode.prototype.constructor = NoteNode;
  NoteNode.prototype.onDblClick = function () { showInspector(this); };
  LiteGraph.registerNodeType('note/note', NoteNode);

  const graph = new LGraph();
  const canvas = new LGraphCanvas(document.getElementById('nm-canvas'), graph);
  canvas.background_image = null;
  canvas.clear_background = true;
  canvas.render_canvas_border = false;
  canvas.show_info = false;               // no T/I/N/V/FPS debug overlay
  canvas.background = '#f8fafc';          // light canvas, matches page
  canvas.default_connection_color = '#6366f1';
  canvas.links_render_mode = LiteGraph.SPLINE_CURVE;

  const nodeMap = {};    // noteId -> litegraph node
  const slotLinks = {};  // noteId:slot -> {linkId, source, type} (persist disconnects)

  // persist manual connections (drag port -> port) in graph.db
  graph.onConnectionChange = function (node, link, connected, slot, slot_type, input_or_output) {
    if (!node || !node.properties || !node.properties.id) return;
    if (input_or_output !== LiteGraph.INPUT) return;
    const key = node.properties.id + ':' + slot;
    if (connected && link) {
      const src = graph.getNodeById(link.origin_id);
      if (!src || !src.properties.id) return;
      const type = (link.type && link.type !== 0) ? String(link.type) : 'related';
      if (slotLinks[key]) unlink(slotLinks[key].source, node.properties.id, slotLinks[key].type);
      slotLinks[key] = { linkId: link.id, source: src.properties.id, type };
      post('/notemap/api/link', { source: src.properties.id, target: node.properties.id, type, weight: 1, confidence: 1 });
    } else if (slotLinks[key]) {
      const old = slotLinks[key];
      delete slotLinks[key];
      unlink(old.source, node.properties.id, old.type);
    }
  };

  // ---- load graph from graph.db ----
  async function load() {
    try {
      const res = await fetch('/notemap/api/graph');
      const data = await res.json();
      graph.clear();
      for (const k of Object.keys(nodeMap)) delete nodeMap[k];
      for (const k of Object.keys(slotLinks)) delete slotLinks[k];
      const byId = {};
      for (const n of data.nodes || []) {
        const ln = new NoteNode();
        ln.properties.id = n.data.id;
        ln.properties.type = n.data.type || 'note';
        ln.properties.label = n.data.label || n.data.id;
        ln.title = ln.properties.label.slice(0, 44);
        ln.tooltip = ln.properties.label;
        ln.color = TYPE_COLORS[ln.properties.type] || '#6b7280';
        graph.add(ln);
        byId[n.data.id] = ln;
        nodeMap[n.data.id] = ln;
      }
      for (const e of data.edges || []) {
        const s = byId[e.data.source], t = byId[e.data.target];
        if (s && t) { try { s.connect(0, t, 0); } catch { /* duplicate edge */ } }
      }
      autoLayout();
      countEl.textContent = (data.nodes || []).length + ' nodes · ' + (data.edges || []).length + ' links';
      graph.setDirtyCanvas(true, true);
    } catch (err) { countEl.textContent = 'load error: ' + err; }
  }

  // ---- auto-classification: column layout grouped by node type ----
  function autoLayout() {
    const colY = {};
    const nodes = graph._nodes.slice().sort((a, b) => {
      const ta = TYPE_ORDER.indexOf(a.properties.type), tb = TYPE_ORDER.indexOf(b.properties.type);
      return (ta < 0 ? 99 : ta) - (tb < 0 ? 99 : tb);
    });
    for (const n of nodes) {
      const t = TYPE_ORDER.includes(n.properties.type) ? n.properties.type : 'note';
      const y = colY[t] = (colY[t] ?? 0);
      n.pos[0] = TYPE_COL_X[t];
      n.pos[1] = y;
      colY[t] += (n.size[1] || 64) + 48;
    }
    graph.setDirtyCanvas(true, true);
  }

  // ---- inspector (double-click a node) ----
  function showInspector(node) {
    const id = node.properties.id;
    document.getElementById('nm-inspector-title').textContent = node.properties.label || node.title;
    document.getElementById('nm-inspector-body').textContent = node.tooltip || node.properties.label;
    const relEl = document.getElementById('nm-inspector-related');
    fetch('/notemap/api/related?id=' + encodeURIComponent(id) + '&limit=8')
      .then((r) => r.json())
      .then((data) => { relEl.textContent = 'related: ' + ((data.items || []).map((i) => i.title).join(' → ') || '—'); })
      .catch(() => { relEl.textContent = 'related: n/a'; });
    const del = document.getElementById('nm-inspector-delete');
    del.hidden = false;
    del.onclick = async () => {
      await post('/notemap/api/remove', { id });
      inspector.hidden = true;
      await load();
    };
    inspector.hidden = false;
  }

  document.getElementById('nm-inspector-close').addEventListener('click', () => { inspector.hidden = true; });
  document.getElementById('nm-inspector-delete').hidden = true;

  // ---- toolbar ----
  document.getElementById('nm-add').addEventListener('click', () => {
    const title = prompt('Note title:');
    if (!title) return;
    post('/notemap/api/add', { title }).then(() => load());
  });

  document.getElementById('nm-import').addEventListener('click', async () => {
    const text = prompt('导入资料(粘贴文本或 URL):\n\n第一行作为标题,其余作为内容。');
    if (!text || !text.trim()) return;
    const lines = text.split('\n');
    const title = (lines[0] || 'untitled').trim().slice(0, 80);
    const content = lines.slice(1).join('\n').trim() || text.trim();
    const type = /^https?:\/\//.test(content.trim()) ? 'link' : 'note';
    await post('/notemap/api/add', { title, content, type });
    await load();
  });

  document.getElementById('nm-sessions').addEventListener('click', async () => {
    const btn = document.getElementById('nm-sessions');
    btn.textContent = '⏳ 提取中…';
    btn.disabled = true;
    try {
      const res = await fetch('/notemap/api/import-session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const data = await res.json();
      alert('已导入: ' + data.sessions + ' 个会话, ' + data.checkpoints + ' 个知识点, ' + data.events + ' 个用户事件(扫描 ' + data.scanned + ' 个文件)');
    } catch (err) { alert('导入失败: ' + err); }
    btn.textContent = '🗨 会话';
    btn.disabled = false;
    await load();
  });

  document.getElementById('nm-clear').addEventListener('click', async () => {
    if (!confirm('清空整个知识图谱?(所有节点和边将被删除,快照历史保留)')) return;
    await post('/notemap/api/clear', { confirm: true });
    await load();
  });

  document.getElementById('nm-layout').addEventListener('click', () => autoLayout());
  document.getElementById('nm-fit').addEventListener('click', () => { canvas.setView(0, 0, 1); graph.setDirtyCanvas(true, true); });

  // search: dim non-matching nodes
  const search = document.getElementById('nm-search');
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    for (const ln of graph._nodes) {
      const hit = !q || (ln.properties.label || '').toLowerCase().includes(q);
      ln.bgcolor = hit ? null : '#374151';
    }
    graph.setDirtyCanvas(true, true);
  });

  // avoid clobbering user interaction: only auto-sync when idle > 5s
  let lastInteract = 0;
  document.getElementById('nm-canvas').addEventListener('pointerdown', () => { lastInteract = Date.now(); });
  setInterval(() => { if (Date.now() - lastInteract > 5000) void load(); }, 8000);

  window.addEventListener('resize', () => {
    canvas.setSize(document.getElementById('nm-canvas').clientWidth, document.getElementById('nm-canvas').clientHeight);
  });

  void load();
})();

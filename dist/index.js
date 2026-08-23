// src/index.ts
import { defineTool as dshDefineTool } from "@deepseek-ai/dsh-tools";

// src/ui.ts
import { readFile } from "node:fs/promises";

// src/graph.ts
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
var SCHEMA_VERSION = 1;
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function encodeEmbedding(v) {
  if (!v) return null;
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}
function decodeEmbedding(b) {
  if (!b) return null;
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}
var GraphStore = class {
  db;
  constructor(dbPath) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }
  migrate() {
    const schema = [
      "CREATE TABLE IF NOT EXISTS nodes (",
      "  id TEXT PRIMARY KEY,",
      "  type TEXT NOT NULL DEFAULT 'note',",
      "  title TEXT NOT NULL,",
      "  content TEXT NOT NULL DEFAULT '',",
      "  embedding BLOB,",
      "  meta TEXT NOT NULL DEFAULT '{}',",
      "  created_at TEXT NOT NULL,",
      "  updated_at TEXT NOT NULL,",
      "  deleted_at TEXT",
      ");",
      "CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);",
      "CREATE INDEX IF NOT EXISTS idx_nodes_title ON nodes(title);",
      "",
      "CREATE TABLE IF NOT EXISTS edges (",
      "  source TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,",
      "  target TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,",
      "  type TEXT NOT NULL DEFAULT 'related',",
      "  weight REAL NOT NULL DEFAULT 1.0,",
      "  confidence REAL NOT NULL DEFAULT 1.0,",
      "  meta TEXT NOT NULL DEFAULT '{}',",
      "  created_at TEXT NOT NULL,",
      "  deleted_at TEXT,",
      "  PRIMARY KEY (source, target, type)",
      ");",
      "CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);",
      "",
      "CREATE TABLE IF NOT EXISTS snapshots (",
      "  snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  schema_version INTEGER NOT NULL,",
      "  created_at TEXT NOT NULL",
      ");",
      "",
      "CREATE TABLE IF NOT EXISTS changes (",
      "  change_id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  snapshot_id INTEGER NOT NULL REFERENCES snapshots(snapshot_id),",
      "  table_name TEXT NOT NULL,",
      "  op TEXT NOT NULL,",
      "  key TEXT NOT NULL,",
      "  data TEXT NOT NULL DEFAULT '{}',",
      "  created_at TEXT NOT NULL",
      ");",
      "CREATE INDEX IF NOT EXISTS idx_changes_snapshot ON changes(snapshot_id);"
    ].join("\n");
    this.db.exec(schema);
  }
  close() {
    this.db.close();
  }
  /** Run fn inside an IMMEDIATE transaction; rollback on throw. */
  withTx(fn) {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const r = fn();
      this.db.exec("COMMIT;");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK;");
      throw e;
    }
  }
  // ---------- node CRUD ----------
  addNode(opts) {
    const id = opts.id ?? crypto.randomUUID();
    const t = nowIso();
    this.db.prepare(
      "INSERT INTO nodes (id, type, title, content, embedding, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET type = excluded.type, title = excluded.title, content = excluded.content, embedding = excluded.embedding, meta = excluded.meta, updated_at = excluded.updated_at, deleted_at = NULL"
    ).run(id, opts.type ?? "note", opts.title, opts.content ?? "", encodeEmbedding(opts.embedding ?? null), JSON.stringify(opts.meta ?? {}), t, t);
    return this.getNode(id);
  }
  getNode(id) {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ? AND deleted_at IS NULL").get(id);
    return row ? this.rowToNode(row) : null;
  }
  rowToNode(row) {
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      content: row.content,
      embedding: decodeEmbedding(row.embedding),
      meta: JSON.parse(row.meta),
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }
  updateNode(id, patch) {
    const cur = this.getNode(id);
    if (!cur) return null;
    const nextTitle = patch.title ?? cur.title;
    const nextContent = patch.content ?? cur.content;
    const nextMeta = patch.meta ?? cur.meta;
    const nextEmb = patch.embedding !== void 0 ? patch.embedding : cur.embedding;
    this.db.prepare(
      "UPDATE nodes SET title = ?, content = ?, embedding = ?, meta = ?, updated_at = ? WHERE id = ?"
    ).run(nextTitle, nextContent, encodeEmbedding(nextEmb), JSON.stringify(nextMeta), nowIso(), id);
    return this.getNode(id);
  }
  removeNode(id) {
    const r = this.db.prepare("UPDATE nodes SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(nowIso(), nowIso(), id);
    if (r.changes > 0) {
      this.db.prepare("UPDATE edges SET deleted_at = ? WHERE (source = ? OR target = ?) AND deleted_at IS NULL").run(nowIso(), id, id);
    }
    return r.changes > 0;
  }
  /** Soft-delete every node and edge — resets the working graph while keeping snapshots/changes history. */
  clearAll() {
    return this.withTx(() => {
      const n = Number(this.db.prepare("UPDATE nodes SET deleted_at = ?, updated_at = ? WHERE deleted_at IS NULL").run(nowIso(), nowIso()).changes);
      const e = Number(this.db.prepare("UPDATE edges SET deleted_at = ? WHERE deleted_at IS NULL").run(nowIso()).changes);
      return { nodes: n, edges: e };
    });
  }
  listNodes(limit = 100, offset = 0) {
    const rows = this.db.prepare("SELECT * FROM nodes WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ? OFFSET ?").all(limit, offset);
    return rows.map((r) => this.rowToNode(r));
  }
  searchNodes(q, limit = 20) {
    return this.searchWithContext(q, limit).map((h) => h.node);
  }
  /** SQL-side processed recall: each hit comes back with its connected neighborhood
   *  aggregated in one query (JSON array of related nodes + edge weights) and a
   *  compact snippet around the best-matching term — a ready-to-read knowledge pack. */
  searchWithContext(q, limit = 20) {
    const tokens = q.split(/[\s，。、；：！？,.!?;:()（）"'\[\]{}]+/).filter(Boolean);
    if (tokens.length === 0) return [];
    const params = [];
    const conds = [];
    for (const t of tokens) {
      const like = "%" + t + "%";
      conds.push("(n.title LIKE ? OR n.content LIKE ?)");
      params.push(like, like);
    }
    const score = conds.map(() => "CASE WHEN n.title LIKE ? OR n.content LIKE ? THEN 1 ELSE 0 END").join(" + ");
    for (const t of tokens) {
      const like = "%" + t + "%";
      params.push(like, like);
    }
    params.push(String(limit));
    const rows = this.db.prepare(
      "SELECT n.*, (SELECT json_group_array(json_object('id', e.target, 'type', e.type, 'weight', e.weight))   FROM edges e WHERE e.source = n.id AND e.deleted_at IS NULL LIMIT 6) AS neighbors_json FROM nodes n WHERE n.deleted_at IS NULL AND (" + conds.join(" OR ") + ") ORDER BY (" + score + ") DESC, n.updated_at DESC LIMIT ?"
    ).all(...params);
    const out = [];
    for (const r of rows) {
      const node = this.rowToNode(r);
      let neighbors = [];
      try {
        neighbors = JSON.parse(String(r.neighbors_json ?? "[]"));
      } catch {
      }
      const needle = tokens.find((t) => node.title.includes(t)) ?? tokens.find((t) => node.content.includes(t)) ?? tokens[0];
      const i = node.content.indexOf(needle);
      const snippet = i >= 0 ? node.content.slice(Math.max(0, i - 40), i + 120) : node.content.slice(0, 140);
      out.push({ node, neighbors, snippet: snippet.replace(/\s+/g, " ").trim() });
    }
    return out;
  }
  // ---------- edge CRUD ----------
  addEdge(opts) {
    this.db.prepare(
      "INSERT INTO edges (source, target, type, weight, confidence, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source, target, type) DO UPDATE SET weight = excluded.weight, confidence = excluded.confidence, meta = excluded.meta, deleted_at = NULL"
    ).run(opts.source, opts.target, opts.type ?? "related", opts.weight ?? 1, opts.confidence ?? 1, JSON.stringify(opts.meta ?? {}), nowIso());
    return this.getEdge(opts.source, opts.target, opts.type ?? "related");
  }
  getEdge(source, target, type = "related") {
    const row = this.db.prepare("SELECT * FROM edges WHERE source = ? AND target = ? AND type = ? AND deleted_at IS NULL").get(source, target, type);
    return row ? this.rowToEdge(row) : null;
  }
  rowToEdge(row) {
    return {
      source: row.source,
      target: row.target,
      type: row.type,
      weight: row.weight,
      confidence: row.confidence,
      meta: JSON.parse(row.meta),
      created_at: row.created_at
    };
  }
  removeEdge(source, target, type = "related") {
    const r = this.db.prepare("UPDATE edges SET deleted_at = ? WHERE source = ? AND target = ? AND type = ? AND deleted_at IS NULL").run(nowIso(), source, target, type);
    return r.changes > 0;
  }
  neighbors(id, dir = "out") {
    if (dir === "out") {
      return this.db.prepare("SELECT * FROM edges WHERE source = ? AND deleted_at IS NULL").all(id);
    }
    if (dir === "in") {
      return this.db.prepare("SELECT * FROM edges WHERE target = ? AND deleted_at IS NULL").all(id);
    }
    return this.db.prepare("SELECT * FROM edges WHERE (source = ? OR target = ?) AND deleted_at IS NULL").all(id, id);
  }
  // ---------- snapshots (DuckLake-inspired) ----------
  /** Commit a snapshot capturing current graph state + change stream tail. */
  commitSnapshot(opts) {
    return this.withTx(() => {
      const t = nowIso();
      const r = this.db.prepare("INSERT INTO snapshots (schema_version, created_at) VALUES (?, ?)").run(SCHEMA_VERSION, t);
      const sid = Number(r.lastInsertRowid);
      const nodes = this.listNodes(1e5);
      for (const n of nodes) {
        this.db.prepare("INSERT INTO changes (snapshot_id, table_name, op, key, data, created_at) VALUES (?, 'nodes', 'upsert', ?, ?, ?)").run(sid, n.id, JSON.stringify({ type: n.type, title: n.title, updated_at: n.updated_at }), t);
      }
      const edges = this.db.prepare("SELECT * FROM edges WHERE deleted_at IS NULL").all();
      for (const e of edges) {
        this.db.prepare("INSERT INTO changes (snapshot_id, table_name, op, key, data, created_at) VALUES (?, 'edges', 'upsert', ?, ?, ?)").run(sid, e.source + "|" + e.target + "|" + e.type, JSON.stringify({ weight: e.weight, confidence: e.confidence }), t);
      }
      return { snapshot_id: sid, schema_version: SCHEMA_VERSION, created_at: t };
    });
  }
  listSnapshots(limit = 20) {
    return this.db.prepare("SELECT snapshot_id, schema_version, created_at FROM snapshots ORDER BY snapshot_id DESC LIMIT ?").all(limit);
  }
  /** Changes between two snapshots (like DuckLake table_changes(from,to)). */
  tableChanges(from, to) {
    const rows = this.db.prepare(
      "SELECT table_name, op, key, data, created_at FROM changes WHERE snapshot_id > ? AND snapshot_id <= ? ORDER BY change_id"
    ).all(from, to);
    return rows.map((r) => ({
      table_name: r.table_name,
      op: r.op,
      key: r.key,
      data: JSON.parse(r.data),
      created_at: r.created_at
    }));
  }
  // ---------- graph algorithms ----------
  /** BFS from a node; returns visited node ids in discovery order. */
  bfs(start, maxDepth = 5) {
    const visited = /* @__PURE__ */ new Set([start]);
    const queue = [[start, 0]];
    const out = [start];
    while (queue.length > 0) {
      const [cur, depth] = queue.shift();
      if (depth >= maxDepth) continue;
      for (const e of this.neighbors(cur, "out")) {
        if (!visited.has(e.target)) {
          visited.add(e.target);
          out.push(e.target);
          queue.push([e.target, depth + 1]);
        }
      }
    }
    return out;
  }
  /** DFS from a node; returns visited node ids in discovery order. */
  dfs(start, maxDepth = 10) {
    const visited = /* @__PURE__ */ new Set([start]);
    const out = [start];
    const walk = (id, depth) => {
      if (depth >= maxDepth) return;
      for (const e of this.neighbors(id, "out")) {
        if (!visited.has(e.target)) {
          visited.add(e.target);
          out.push(e.target);
          walk(e.target, depth + 1);
        }
      }
    };
    walk(start, 0);
    return out;
  }
  /** Dijkstra shortest paths from start; returns map node -> { dist, prev }. */
  dijkstra(start) {
    const dist = { [start]: 0 };
    const prev = { [start]: null };
    const settled = /* @__PURE__ */ new Set();
    const pq = [[0, start]];
    while (pq.length > 0) {
      pq.sort((a, b) => a[0] - b[0]);
      const [d, cur] = pq.shift();
      if (settled.has(cur)) continue;
      settled.add(cur);
      for (const e of this.neighbors(cur, "out")) {
        const w = Math.max(e.weight, 1e-4);
        const nd = d + 1 / w;
        if (dist[e.target] === void 0 || nd < dist[e.target]) {
          dist[e.target] = nd;
          prev[e.target] = cur;
          pq.push([nd, e.target]);
        }
      }
    }
    const result = {};
    for (const k of Object.keys(dist)) result[k] = { dist: dist[k], prev: prev[k] };
    return result;
  }
  /** Shortest path as ordered node list (via Dijkstra). */
  shortestPath(from, to) {
    const sp = this.dijkstra(from);
    if (sp[to] === void 0) return null;
    const path = [];
    let cur = to;
    while (cur !== null) {
      path.unshift(cur);
      cur = sp[cur].prev;
    }
    return path;
  }
  /** Common neighbors of two nodes (any direction). */
  commonNeighbors(a, b) {
    const setA = /* @__PURE__ */ new Set();
    for (const e of this.neighbors(a, "both")) setA.add(e.source === a ? e.target : e.source);
    const out = [];
    for (const e of this.neighbors(b, "both")) {
      const n = e.source === b ? e.target : e.source;
      if (setA.has(n)) out.push(n);
    }
    return out;
  }
  /** Degree centrality: normalized node count of connections (in+out). */
  degreeCentrality(limit = 20) {
    const deg = {};
    for (const e of this.db.prepare("SELECT source, target FROM edges WHERE deleted_at IS NULL").all()) {
      const s = e.source;
      const t = e.target;
      deg[s] = (deg[s] ?? 0) + 1;
      deg[t] = (deg[t] ?? 0) + 1;
    }
    return Object.fromEntries(
      Object.entries(deg).sort((a, b) => b[1] - a[1]).slice(0, limit)
    );
  }
  /** PageRank approximation (power iteration, undirected edge weights as transitions). */
  pageRank(iterations = 20, damping = 0.85) {
    const nodes = this.listNodes(1e5).map((n) => n.id);
    if (nodes.length === 0) return {};
    let rank = {};
    for (const n of nodes) rank[n] = 1 / nodes.length;
    const outDeg = {};
    for (const n of nodes) outDeg[n] = this.neighbors(n, "out").length;
    for (let i = 0; i < iterations; i++) {
      const next = {};
      const base = (1 - damping) / nodes.length;
      for (const n of nodes) next[n] = base;
      for (const n of nodes) {
        const deg = outDeg[n];
        if (deg === 0) continue;
        const share = damping * rank[n] / deg;
        for (const e of this.neighbors(n, "out")) next[e.target] = (next[e.target] ?? base) + share;
      }
      rank = next;
    }
    return rank;
  }
  /** Related nodes by weight + confidence + shared neighbors. */
  related(id, limit = 10) {
    const scores = /* @__PURE__ */ new Map();
    const bump = (nid, delta) => scores.set(nid, (scores.get(nid) ?? 0) + delta);
    for (const e of this.neighbors(id, "both")) {
      const other = e.source === id ? e.target : e.source;
      bump(other, e.weight * e.confidence);
    }
    for (const e of this.neighbors(id, "both")) {
      const other = e.source === id ? e.target : e.source;
      for (const e2 of this.neighbors(other, "both")) {
        const o2 = e2.source === other ? e2.target : e2.source;
        if (o2 !== id && !scores.has(o2)) bump(o2, e.weight * e2.weight * 0.3);
      }
    }
    const out = [...scores.entries()].map(([nid, score]) => ({ node: this.getNode(nid), score })).filter((x) => x.node !== null).sort((a, b) => b.score - a.score).slice(0, limit);
    return out;
  }
  // ---------- export ----------
  /** cytoscape.js-compatible elements JSON. */
  exportElements() {
    const nodes = this.listNodes(1e5).map((n) => ({
      data: { id: n.id, label: n.title, type: n.type }
    }));
    const edges = this.db.prepare("SELECT * FROM edges WHERE deleted_at IS NULL").all().map((e) => ({
      data: { id: e.source + "|" + e.target + "|" + e.type, source: e.source, target: e.target, label: e.type, weight: e.weight }
    }));
    return { nodes, edges };
  }
  stats() {
    const n = this.db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE deleted_at IS NULL").get();
    const e = this.db.prepare("SELECT COUNT(*) AS c FROM edges WHERE deleted_at IS NULL").get();
    const s = this.db.prepare("SELECT COUNT(*) AS c FROM snapshots").get();
    return { nodes: n.c, edges: e.c, snapshots: s.c };
  }
};

// src/notemap.ts
import { mkdirSync as mkdirSync2 } from "node:fs";
import { join } from "node:path";
var store = null;
function getStore(dbPath) {
  if (!store) {
    const path = dbPath ?? (process.env.DSH_NOTEMAP_DB ?? join(process.env.DSH_DATA_DIR ?? join(process.env.USERPROFILE ?? ".", ".dsh"), "notemap", "graph.db"));
    mkdirSync2(join(process.env.DSH_DATA_DIR ?? join(process.env.USERPROFILE ?? ".", ".dsh"), "notemap"), { recursive: true });
    store = new GraphStore(path);
  }
  return store;
}
function closeStore() {
  if (store) {
    store.close();
    store = null;
  }
}
function addNote(args) {
  return getStore().addNode(args);
}
function linkNotes(args) {
  return getStore().addEdge(args);
}
function removeNote(id) {
  return getStore().removeNode(id);
}
function clearAll() {
  return getStore().clearAll();
}
function searchNotes(args) {
  return getStore().searchNodes(args.q, args.limit ?? 20);
}
function searchWithContext(args) {
  return getStore().searchWithContext(args.q, args.limit ?? 10);
}
function findPaths(args) {
  return getStore().shortestPath(args.from, args.to);
}
function findRelated(args) {
  return getStore().related(args.id, args.limit ?? 10);
}
function exportGraph() {
  return getStore().exportElements();
}
function graphStats() {
  return getStore().stats();
}
function snapshotNow() {
  return getStore().commitSnapshot();
}
function centrality(limit) {
  return getStore().degreeCentrality(limit ?? 20);
}
function pagerank() {
  return getStore().pageRank();
}
function neighborsOf(args) {
  const all = getStore().neighbors(args.id, args.dir ?? "out");
  return all.slice(0, args.limit ?? 50);
}
function commonNeighbors(args) {
  return getStore().commonNeighbors(args.a, args.b);
}

// src/ui.ts
var sendFile = (res, type, body) => {
  res.writeHead(200, { "content-type": type });
  res.end(body);
};
var sendJson = (res, obj, code = 200) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
};
var readBody = (req) => new Promise((resolve, reject) => {
  let data = "";
  req.on("data", (chunk) => {
    data += chunk.toString("utf8");
  });
  req.on("end", () => resolve(data));
  req.on("error", reject);
});
async function apiHandler(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = url.pathname.replace(/^\/notemap\/api/, "") || "/";
  const method = req.method ?? "GET";
  try {
    if (route === "/graph" && method === "GET") {
      sendJson(res, exportGraph());
      return;
    }
    if (route === "/stats" && method === "GET") {
      sendJson(res, graphStats());
      return;
    }
    if (route === "/related" && method === "GET") {
      const id = url.searchParams.get("id") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? 10);
      sendJson(res, findRelated({ id, limit }));
      return;
    }
    if (route === "/add" && method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      sendJson(res, addNote({ title: String(body.title ?? "untitled"), content: body.content, type: body.type }));
      return;
    }
    if (route === "/link" && method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      sendJson(res, linkNotes({ source: String(body.source), target: String(body.target), type: body.type, weight: body.weight, confidence: body.confidence }));
      return;
    }
    if (route === "/project" && method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      const events = Array.isArray(body.events) ? body.events : [];
      const created = [];
      for (const ev of events) {
        if (!ev || typeof ev.id !== "string") continue;
        const title = String(ev.title ?? "event");
        const content = typeof ev.content === "string" ? ev.content : "";
        const type = typeof ev.type === "string" ? ev.type : "session-event";
        try {
          const node = addNote({ id: ev.id, title, content, type });
          created.push(node.id);
          if (typeof ev.parentId === "string" && ev.parentId && ev.parentId !== ev.id) {
            linkNotes({ source: ev.parentId, target: ev.id, type: ev.edgeType ?? "follows", weight: ev.weight ?? 0.8, confidence: 1 });
          }
        } catch {
        }
      }
      sendJson(res, { ok: true, created: created.length });
      return;
    }
    if (route === "/search" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      sendJson(res, searchNotes({ q, limit: 20 }));
      return;
    }
    if (route === "/import-session" && method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      sendJson(res, await importSessions({ limit: body.limit }));
      return;
    }
    if (route === "/remove" && method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      sendJson(res, { removed: removeNote(String(body.id ?? "")) });
      return;
    }
    if (route === "/clear" && method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      if (body.confirm !== true) {
        sendJson(res, { cleared: false, reason: "confirm=true required" });
        return;
      }
      sendJson(res, { cleared: true, ...clearAll() });
      return;
    }
    sendJson(res, { error: "not found" }, 404);
  } catch (err) {
    sendJson(res, { error: err?.message ?? String(err) }, 500);
  }
}
async function registerUi(ctx) {
  const ws = ctx.webServer;
  if (!ws) return;
  const base = new URL("../web/", import.meta.url);
  const read = (p) => readFile(new URL(p, base), "utf8");
  ws.register({ kind: "exact", path: "/notemap", handler: (_req, res) => {
    res.writeHead(302, { location: "/notemap/" });
    res.end();
  } });
  ws.register({ kind: "exact", path: "/notemap/", handler: async (_req, res) => {
    sendFile(res, "text/html; charset=utf-8", await read("index.html"));
  } });
  ws.register({ kind: "exact", path: "/notemap/app.js", handler: async (_req, res) => {
    sendFile(res, "text/javascript; charset=utf-8", await read("app.js"));
  } });
  ws.register({ kind: "exact", path: "/notemap/lit.bundle.js", handler: async (_req, res) => {
    sendFile(res, "text/javascript; charset=utf-8", await read("lit.bundle.js"));
  } });
  ws.register({ kind: "exact", path: "/notemap/styles.css", handler: async (_req, res) => {
    sendFile(res, "text/css; charset=utf-8", await read("styles.css"));
  } });
  ws.register({ kind: "prefix", path: "/notemap/api", handler: apiHandler });
}
function disposeUi() {
  try {
    closeStore();
  } catch {
  }
}

// src/index.ts
var defineTool = (o) => {
  let parameters = o.parameters;
  const p = o.parameters;
  if (p && p.type === "object" && p.properties) {
    const required = new Set(p.required ?? []);
    parameters = {};
    for (const [k, v] of Object.entries(p.properties)) {
      parameters[k] = { ...v, ...required.has(k) ? { required: true } : {} };
    }
  }
  return dshDefineTool({ ...o, parameters, output: o.output ?? { schema: { type: "json" }, render: () => [] } });
};
var name = "dsh-notemap";
var inject = ["tools", "webServer"];
var RT_CTX = "Current runtime context";
var CHECKPOINT = "This is an automatically generated checkpoint";
var SKIP_PREFIXES = ["<system-reminder>", "<available_skills>", "The available skill catalog changed"];
function extractSummary(text) {
  const m = text.match(/<compacted-summary>([\s\S]*?)<\/compacted-summary>/);
  if (m && m[1] && m[1].trim().length > 10) return m[1].trim();
  const rt = text.indexOf(RT_CTX);
  const body = rt >= 0 ? text.slice(0, rt) : text;
  const banner = body.indexOf("\n");
  return banner >= 0 ? body.slice(banner + 1).trim() : body.trim();
}
function extractTopic(summary) {
  for (const line of summary.split("\n")) {
    const t = line.replace(/^#+\s*/, "").replace(/^\*\*/, "").trim();
    if (t && t.length <= 60) return t;
  }
  return summary.slice(0, 60).replace(/\s+/g, " ").trim();
}
function cleanText(s) {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
async function importSessions(opts) {
  const { execFileSync } = await import("node:child_process");
  const { readdirSync, statSync } = await import("node:fs");
  const { join: join2 } = await import("node:path");
  const { homedir } = await import("node:os");
  const { createHash } = await import("node:crypto");
  const hash = (s) => createHash("sha1").update(s).digest("hex").slice(0, 16);
  const root = join2(homedir(), ".dsh", "sessions");
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((d) => d.name);
    } catch {
      return;
    }
    for (const name2 of entries) {
      const p = join2(dir, name2);
      try {
        if (statSync(p).isDirectory()) walk(p);
        else if (name2.endsWith(".zstd")) files.push(p);
      } catch {
      }
    }
  };
  walk(root);
  const limit = opts?.limit ?? 30;
  const maxLines = opts?.maxLines ?? 2e3;
  const imported = [];
  let sessions = 0, checkpoints = 0, events = 0;
  for (const f of files.slice(0, limit)) {
    let text = "";
    try {
      text = execFileSync("zstd", ["-d", "-c", f], { timeout: 2e4, encoding: "utf8", windowsHide: true });
    } catch {
      text = "";
    }
    const lines = text.split("\n").filter(Boolean).slice(0, maxLines);
    const base = f.split(/[\\/]/).pop() ?? f;
    const fileKey = hash(f);
    const sessId = "sess:" + fileKey;
    let sessTitle = "";
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (ev?.type === "session/title" && ev?.data?.title) {
          sessTitle = String(ev.data.title).slice(0, 60);
          break;
        }
      } catch {
      }
    }
    const title = sessTitle || "session: " + base.replace(/\.zstd$/, "").slice(0, 40);
    const chkNodes = [];
    const evtNodes = [];
    let chkIdx = 0, evtIdx = 0;
    for (const line of lines) {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      const evType = ev?.type ?? "";
      const m = ev?.message;
      let c;
      if (typeof m === "string") c = m;
      else if (m && typeof m.content === "string") c = m.content;
      else {
        const d = ev?.data;
        if (d && Array.isArray(d.content)) {
          c = d.content.filter((b) => b && typeof b.text === "string").map((b) => b.text).join("\n");
        } else if (d && typeof d.text === "string") {
          c = d.text;
        }
      }
      if (!c || c.length < 20) continue;
      if (c.startsWith(RT_CTX)) continue;
      if (SKIP_PREFIXES.some((p) => c.startsWith(p))) continue;
      if (c.startsWith(CHECKPOINT) || c.includes("compacted-summary")) {
        const summary = extractSummary(c);
        if (summary.length < 20) continue;
        const id = "chk:" + fileKey + ":" + chkIdx++;
        const topic = extractTopic(summary);
        await addNote({ id, title: topic || "checkpoint " + chkIdx, content: summary.slice(0, 800), type: "checkpoint", meta: { file: base } });
        chkNodes.push(id);
        checkpoints++;
      } else if (c.includes("system-reminder") || c.startsWith("<") && c.includes(">")) {
        continue;
      } else if (evType === "user/message" || evType === "") {
        const clean = cleanText(c);
        if (clean.length < 8) continue;
        const id = "evt:" + fileKey + ":" + evtIdx++;
        await addNote({ id, title: clean.slice(0, 60), content: clean.slice(0, 600), type: "session-event", meta: { file: base } });
        evtNodes.push(id);
        events++;
      }
    }
    if (chkNodes.length + evtNodes.length === 0) continue;
    await addNote({ id: sessId, title, content: chkNodes.length + " checkpoint(s), " + evtNodes.length + " event(s) from " + base, type: "session", meta: { file: base } });
    for (const id of chkNodes) await linkNotes({ source: sessId, target: id, type: "checkpoint", weight: 1, confidence: 1 });
    for (const id of evtNodes) await linkNotes({ source: sessId, target: id, type: "follows", weight: 0.8, confidence: 1 });
    if (chkNodes.length && evtNodes.length) {
      await linkNotes({ source: chkNodes[chkNodes.length - 1], target: evtNodes[0], type: "produces", weight: 0.6, confidence: 0.7 });
    }
    sessions++;
    imported.push(sessId);
  }
  return { scanned: files.length, sessions, checkpoints, events, imported };
}
function apply(ctx) {
  const reg = ctx.tools?.register?.bind(ctx.tools);
  if (!reg) return;
  void registerUi(ctx);
  reg(defineTool({
    name: "notemap_add",
    description: "Add a note node to the networked knowledge graph (dsh-notemap). Returns the created node.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Node title" },
        content: { type: "string", description: "Node body content (optional)" },
        type: { type: "string", description: "Node type, default note" },
        id: { type: "string", description: "Explicit node id (optional, default uuid)" }
      },
      required: ["title"]
    },
    execute: (args) => addNote(args)
  }));
  reg(defineTool({
    name: "notemap_link",
    description: "Create/update a weighted, confidence-scored edge between two nodes. Relation strength is quantified.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source node id" },
        target: { type: "string", description: "Target node id" },
        type: { type: "string", description: "Relation type, default related" },
        weight: { type: "number", description: "Relation strength 0-1+ (default 1.0)" },
        confidence: { type: "number", description: "Confidence 0-1 (default 1.0)" }
      },
      required: ["source", "target"]
    },
    execute: (args) => linkNotes(args)
  }));
  reg(defineTool({
    name: "notemap_search",
    description: "Full-text search over note titles and content. Returns matching nodes.",
    parameters: {
      type: "object",
      properties: {
        q: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default 20)" }
      },
      required: ["q"]
    },
    execute: (args) => searchNotes(args)
  }));
  reg(defineTool({
    name: "notemap_paths",
    description: "Shortest path (Dijkstra, weight-aware) between two nodes. Reveals hidden chains of association.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start node id" },
        to: { type: "string", description: "End node id" }
      },
      required: ["from", "to"]
    },
    execute: (args) => findPaths(args)
  }));
  reg(defineTool({
    name: "notemap_related",
    description: "Rank nodes related to a node by edge weight*confidence plus shared-neighbor signal.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Node id" },
        limit: { type: "number", description: "Max results (default 10)" }
      },
      required: ["id"]
    },
    execute: (args) => findRelated(args)
  }));
  reg(defineTool({
    name: "notemap_export",
    description: "Export the whole graph as cytoscape.js-compatible elements JSON (for infinite-canvas UI rendering).",
    parameters: { type: "object", properties: {}, required: [] },
    execute: () => exportGraph()
  }));
  reg(defineTool({
    name: "notemap_stats",
    description: "Graph statistics: node/edge/snapshot counts.",
    parameters: { type: "object", properties: {}, required: [] },
    execute: () => graphStats()
  }));
  reg(defineTool({
    name: "notemap_snapshot",
    description: "Commit a named snapshot (DuckLake-inspired) for time travel; changes() can diff snapshots.",
    parameters: { type: "object", properties: {}, required: [] },
    execute: () => snapshotNow()
  }));
  reg(defineTool({
    name: "notemap_centrality",
    description: "Degree centrality ranking \u2014 the most connected nodes in the graph.",
    parameters: {
      type: "object",
      properties: { limit: { type: "number", description: "Top N (default 20)" } },
      required: []
    },
    execute: (args) => centrality(args?.limit)
  }));
  reg(defineTool({
    name: "notemap_pagerank",
    description: "PageRank approximation \u2014 authority/hub nodes by iterative propagation.",
    parameters: { type: "object", properties: {}, required: [] },
    execute: () => pagerank()
  }));
  reg(defineTool({
    name: "notemap_neighbors",
    description: "List direct neighbors (edges) of a node, direction-aware.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Node id" },
        dir: { type: "string", enum: ["out", "in", "both"], description: "Edge direction (default out)" },
        limit: { type: "number", description: "Max edges (default 50)" }
      },
      required: ["id"]
    },
    execute: (args) => neighborsOf(args)
  }));
  reg(defineTool({
    name: "notemap_common",
    description: "Common neighbors of two nodes \u2014 shared context that may link otherwise distant notes.",
    parameters: {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a", "b"]
    },
    execute: (args) => commonNeighbors(args)
  }));
  reg(defineTool({
    name: "notemap_commit",
    description: "Record the current conversation key point as a graph node (title/content/type) so the canvas accumulates the main-thread decision chain over time.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title of the key point" },
        content: { type: "string", description: "Facts / decisions / recovery pointers (compact)" },
        type: { type: "string", description: "Node type, default note" }
      },
      required: ["title"]
    },
    execute: (args) => addNote(args)
  }));
  reg(defineTool({
    name: "notemap_recall",
    description: "Query the graph and return matching node summaries \u2014 use instead of pasting full context; hits are compact and linked.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default 10)" }
      },
      required: ["query"]
    },
    execute: (args) => searchWithContext({ q: args.query, limit: args.limit ?? 10 }).map((h) => ({
      id: h.node?.id,
      title: h.node?.title,
      type: h.node?.type,
      snippet: h.snippet,
      linked: (h.neighbors ?? []).map((nb) => nb.id + " (" + nb.type + " w" + nb.weight + ")").join(", ")
    }))
  }));
  reg(defineTool({
    name: "notemap_import_session",
    description: "Scan ~/.dsh/sessions/**/session.jsonl.zstd and extract each session into the knowledge graph: session node + checkpoint nodes (ACP-compacted summaries, the real knowledge density) + user event nodes (skipping runtime-context/system noise). Deterministic ids: re-import is idempotent. Uses zstd CLI when available.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max session files to import (default 30)" }
      },
      required: []
    },
    execute: (args) => importSessions({ limit: args?.limit })
  }));
  reg(defineTool({
    name: "notemap_remove",
    description: "Remove a node (and its edges) from the knowledge graph.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Node id to remove" } },
      required: ["id"]
    },
    execute: (args) => ({ removed: removeNote(args.id) })
  }));
  reg(defineTool({
    name: "notemap_clear",
    description: "Clear the whole knowledge graph (soft-delete all nodes+edges; snapshots/history kept). Requires confirm=true.",
    parameters: {
      type: "object",
      properties: { confirm: { type: "boolean", description: "Must be true to actually clear" } },
      required: ["confirm"]
    },
    execute: (args) => {
      if (args?.confirm !== true) return { cleared: false, reason: "confirm=true required" };
      return { cleared: true, ...clearAll() };
    }
  }));
}
function dispose() {
  try {
    disposeUi();
  } catch {
  }
  closeStore();
}
export {
  apply,
  dispose,
  importSessions,
  inject,
  name
};

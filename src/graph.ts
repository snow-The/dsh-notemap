import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------- types ----------
export interface NodeRecord {
  id: string;
  type: string;
  title: string;
  content: string;
  embedding: Float32Array | null;
  meta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface EdgeRecord {
  source: string;
  target: string;
  type: string;
  weight: number;
  confidence: number;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface SnapshotInfo {
  snapshot_id: number;
  schema_version: number;
  created_at: string;
}

export interface PathStep {
  node: string;
  via?: string;
  weight: number;
}

// ---------- constants ----------
const SCHEMA_VERSION = 1;

// ---------- helpers ----------
export function nowIso(): string { return new Date().toISOString(); }

function encodeEmbedding(v: Float32Array | null): Uint8Array | null {
  if (!v) return null;
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

function decodeEmbedding(b: Uint8Array | null): Float32Array | null {
  if (!b) return null;
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

// ---------- GraphStore ----------
/**
 * Networked knowledge graph backed by node:sqlite (WAL + withTx).
 * DuckLake-inspired: snapshot table + change stream for time travel & audit.
 */
export class GraphStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
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
      "CREATE INDEX IF NOT EXISTS idx_changes_snapshot ON changes(snapshot_id);",
    ].join('\n');
    this.db.exec(schema);
  }

  close(): void { this.db.close(); }

  /** Run fn inside an IMMEDIATE transaction; rollback on throw. */
  withTx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const r = fn();
      this.db.exec('COMMIT;');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK;');
      throw e;
    }
  }

  // ---------- node CRUD ----------
  addNode(opts: { id?: string; type?: string; title: string; content?: string; embedding?: Float32Array | null; meta?: Record<string, unknown> }): NodeRecord {
    const id = opts.id ?? crypto.randomUUID();
    const t = nowIso();
    this.db.prepare(
      'INSERT INTO nodes (id, type, title, content, embedding, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(id) DO UPDATE SET type = excluded.type, title = excluded.title, content = excluded.content, '
      + 'embedding = excluded.embedding, meta = excluded.meta, updated_at = excluded.updated_at, deleted_at = NULL'
    ).run(id, opts.type ?? 'note', opts.title, opts.content ?? '', encodeEmbedding(opts.embedding ?? null), JSON.stringify(opts.meta ?? {}), t, t);
    return this.getNode(id)!;
  }

  getNode(id: string): NodeRecord | null {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ? AND deleted_at IS NULL').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToNode(row) : null;
  }

  private rowToNode(row: Record<string, unknown>): NodeRecord {
    return {
      id: row.id as string,
      type: row.type as string,
      title: row.title as string,
      content: row.content as string,
      embedding: decodeEmbedding(row.embedding as Uint8Array | null),
      meta: JSON.parse(row.meta as string) as Record<string, unknown>,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  updateNode(id: string, patch: { title?: string; content?: string; embedding?: Float32Array | null; meta?: Record<string, unknown> }): NodeRecord | null {
    const cur = this.getNode(id);
    if (!cur) return null;
    const nextTitle = patch.title ?? cur.title;
    const nextContent = patch.content ?? cur.content;
    const nextMeta = patch.meta ?? cur.meta;
    const nextEmb = patch.embedding !== undefined ? patch.embedding : cur.embedding;
    this.db.prepare(
      'UPDATE nodes SET title = ?, content = ?, embedding = ?, meta = ?, updated_at = ? WHERE id = ?'
    ).run(nextTitle, nextContent, encodeEmbedding(nextEmb), JSON.stringify(nextMeta), nowIso(), id);
    return this.getNode(id);
  }

  removeNode(id: string): boolean {
    const r = this.db.prepare('UPDATE nodes SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(nowIso(), nowIso(), id);
    if (r.changes > 0) {
      this.db.prepare('UPDATE edges SET deleted_at = ? WHERE (source = ? OR target = ?) AND deleted_at IS NULL').run(nowIso(), id, id);
    }
    return r.changes > 0;
  }

  /** Soft-delete every node and edge — resets the working graph while keeping snapshots/changes history. */
  clearAll(): { nodes: number; edges: number } {
    return this.withTx(() => {
      const n = Number(this.db.prepare('UPDATE nodes SET deleted_at = ?, updated_at = ? WHERE deleted_at IS NULL').run(nowIso(), nowIso()).changes);
      const e = Number(this.db.prepare('UPDATE edges SET deleted_at = ? WHERE deleted_at IS NULL').run(nowIso()).changes);
      return { nodes: n, edges: e };
    });
  }

  listNodes(limit = 100, offset = 0): NodeRecord[] {
    const rows = this.db.prepare('SELECT * FROM nodes WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(limit, offset) as Record<string, unknown>[];
    return rows.map(r => this.rowToNode(r));
  }

  searchNodes(q: string, limit = 20): NodeRecord[] {
    return this.searchWithContext(q, limit).map((h) => h.node);
  }

  /** SQL-side processed recall: each hit comes back with its connected neighborhood
   *  aggregated in one query (JSON array of related nodes + edge weights) and a
   *  compact snippet around the best-matching term — a ready-to-read knowledge pack. */
  searchWithContext(q: string, limit = 20): { node: NodeRecord; neighbors: { id: string; type: string; weight: number }[]; snippet: string }[] {
    const tokens = q.split(/[\s，。、；：！？,.!?;:()（）"'\[\]{}]+/).filter(Boolean);
    if (tokens.length === 0) return [];
    const params: string[] = [];
    const conds: string[] = [];
    for (const t of tokens) {
      const like = '%' + t + '%';
      conds.push('(n.title LIKE ? OR n.content LIKE ?)');
      params.push(like, like);
    }
    const score = conds.map(() => 'CASE WHEN n.title LIKE ? OR n.content LIKE ? THEN 1 ELSE 0 END').join(' + ');
    for (const t of tokens) { const like = '%' + t + '%'; params.push(like, like); }
    params.push(String(limit));
    const rows = this.db.prepare(
      'SELECT n.*, '
      + "(SELECT json_group_array(json_object('id', e.target, 'type', e.type, 'weight', e.weight)) "
      + '  FROM edges e WHERE e.source = n.id AND e.deleted_at IS NULL LIMIT 6) AS neighbors_json '
      + 'FROM nodes n WHERE n.deleted_at IS NULL AND (' + conds.join(' OR ') + ') '
      + 'ORDER BY (' + score + ') DESC, n.updated_at DESC LIMIT ?'
    ).all(...params) as Record<string, unknown>[];
    const out: { node: NodeRecord; neighbors: { id: string; type: string; weight: number }[]; snippet: string }[] = [];
    for (const r of rows) {
      const node = this.rowToNode(r);
      let neighbors: { id: string; type: string; weight: number }[] = [];
      try { neighbors = JSON.parse(String(r.neighbors_json ?? '[]')); } catch { /* ignore */ }
      const needle = tokens.find((t) => node.title.includes(t)) ?? tokens.find((t) => node.content.includes(t)) ?? tokens[0];
      const i = node.content.indexOf(needle);
      const snippet = i >= 0 ? node.content.slice(Math.max(0, i - 40), i + 120) : node.content.slice(0, 140);
      out.push({ node, neighbors, snippet: snippet.replace(/\s+/g, ' ').trim() });
    }
    return out;
  }

  // ---------- edge CRUD ----------
  addEdge(opts: { source: string; target: string; type?: string; weight?: number; confidence?: number; meta?: Record<string, unknown> }): EdgeRecord {
    this.db.prepare(
      'INSERT INTO edges (source, target, type, weight, confidence, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT (source, target, type) DO UPDATE SET weight = excluded.weight, confidence = excluded.confidence, meta = excluded.meta, deleted_at = NULL'
    ).run(opts.source, opts.target, opts.type ?? 'related', opts.weight ?? 1.0, opts.confidence ?? 1.0, JSON.stringify(opts.meta ?? {}), nowIso());
    return this.getEdge(opts.source, opts.target, opts.type ?? 'related')!;
  }

  getEdge(source: string, target: string, type = 'related'): EdgeRecord | null {
    const row = this.db.prepare('SELECT * FROM edges WHERE source = ? AND target = ? AND type = ? AND deleted_at IS NULL').get(source, target, type) as Record<string, unknown> | undefined;
    return row ? this.rowToEdge(row) : null;
  }

  private rowToEdge(row: Record<string, unknown>): EdgeRecord {
    return {
      source: row.source as string,
      target: row.target as string,
      type: row.type as string,
      weight: row.weight as number,
      confidence: row.confidence as number,
      meta: JSON.parse(row.meta as string) as Record<string, unknown>,
      created_at: row.created_at as string,
    };
  }

  removeEdge(source: string, target: string, type = 'related'): boolean {
    const r = this.db.prepare('UPDATE edges SET deleted_at = ? WHERE source = ? AND target = ? AND type = ? AND deleted_at IS NULL').run(nowIso(), source, target, type);
    return r.changes > 0;
  }

  neighbors(id: string, dir: 'out' | 'in' | 'both' = 'out'): EdgeRecord[] {
    if (dir === 'out') {
      return this.db.prepare('SELECT * FROM edges WHERE source = ? AND deleted_at IS NULL').all(id) as unknown as EdgeRecord[];
    }
    if (dir === 'in') {
      return this.db.prepare('SELECT * FROM edges WHERE target = ? AND deleted_at IS NULL').all(id) as unknown as EdgeRecord[];
    }
    return this.db.prepare('SELECT * FROM edges WHERE (source = ? OR target = ?) AND deleted_at IS NULL').all(id, id) as unknown as EdgeRecord[];
  }
// ---------- snapshots (DuckLake-inspired) ----------
  /** Commit a snapshot capturing current graph state + change stream tail. */
  commitSnapshot(opts?: { note?: string }): SnapshotInfo {
    return this.withTx(() => {
      const t = nowIso();
      const r = this.db.prepare('INSERT INTO snapshots (schema_version, created_at) VALUES (?, ?)').run(SCHEMA_VERSION, t);
      const sid = Number(r.lastInsertRowid);
      // record the state as change rows so table_changes(from,to) works
      const nodes = this.listNodes(100000);
      for (const n of nodes) {
        this.db.prepare("INSERT INTO changes (snapshot_id, table_name, op, key, data, created_at) VALUES (?, 'nodes', 'upsert', ?, ?, ?)")
          .run(sid, n.id, JSON.stringify({ type: n.type, title: n.title, updated_at: n.updated_at }), t);
      }
      const edges = this.db.prepare('SELECT * FROM edges WHERE deleted_at IS NULL').all() as unknown as EdgeRecord[];
      for (const e of edges) {
        this.db.prepare("INSERT INTO changes (snapshot_id, table_name, op, key, data, created_at) VALUES (?, 'edges', 'upsert', ?, ?, ?)")
          .run(sid, e.source + '|' + e.target + '|' + e.type, JSON.stringify({ weight: e.weight, confidence: e.confidence }), t);
      }
      return { snapshot_id: sid, schema_version: SCHEMA_VERSION, created_at: t };
    });
  }

  listSnapshots(limit = 20): SnapshotInfo[] {
    return this.db.prepare('SELECT snapshot_id, schema_version, created_at FROM snapshots ORDER BY snapshot_id DESC LIMIT ?').all(limit) as unknown as SnapshotInfo[];
  }

  /** Changes between two snapshots (like DuckLake table_changes(from,to)). */
  tableChanges(from: number, to: number): { table_name: string; op: string; key: string; data: Record<string, unknown>; created_at: string }[] {
    const rows = this.db.prepare(
      'SELECT table_name, op, key, data, created_at FROM changes WHERE snapshot_id > ? AND snapshot_id <= ? ORDER BY change_id'
    ).all(from, to) as Record<string, unknown>[];
    return rows.map(r => ({
      table_name: r.table_name as string,
      op: r.op as string,
      key: r.key as string,
      data: JSON.parse(r.data as string) as Record<string, unknown>,
      created_at: r.created_at as string,
    }));
  }

  // ---------- graph algorithms ----------
  /** BFS from a node; returns visited node ids in discovery order. */
  bfs(start: string, maxDepth = 5): string[] {
    const visited = new Set<string>([start]);
    const queue: [string, number][] = [[start, 0]];
    const out: string[] = [start];
    while (queue.length > 0) {
      const [cur, depth] = queue.shift()!;
      if (depth >= maxDepth) continue;
      for (const e of this.neighbors(cur, 'out')) {
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
  dfs(start: string, maxDepth = 10): string[] {
    const visited = new Set<string>([start]);
    const out: string[] = [start];
    const walk = (id: string, depth: number) => {
      if (depth >= maxDepth) return;
      for (const e of this.neighbors(id, 'out')) {
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
  dijkstra(start: string): Record<string, { dist: number; prev: string | null }> {
    const dist: Record<string, number> = { [start]: 0 };
    const prev: Record<string, string | null> = { [start]: null };
    const settled = new Set<string>();
    const pq: [number, string][] = [[0, start]];
    while (pq.length > 0) {
      pq.sort((a, b) => a[0] - b[0]);
      const [d, cur] = pq.shift()!;
      if (settled.has(cur)) continue;
      settled.add(cur);
      for (const e of this.neighbors(cur, 'out')) {
        const w = Math.max(e.weight, 0.0001);
        const nd = d + (1 / w);
        if (dist[e.target] === undefined || nd < dist[e.target]) {
          dist[e.target] = nd;
          prev[e.target] = cur;
          pq.push([nd, e.target]);
        }
      }
    }
    const result: Record<string, { dist: number; prev: string | null }> = {};
    for (const k of Object.keys(dist)) result[k] = { dist: dist[k], prev: prev[k] };
    return result;
  }

  /** Shortest path as ordered node list (via Dijkstra). */
  shortestPath(from: string, to: string): string[] | null {
    const sp = this.dijkstra(from);
    if (sp[to] === undefined) return null;
    const path: string[] = [];
    let cur: string | null = to;
    while (cur !== null) {
      path.unshift(cur);
      cur = sp[cur].prev;
    }
    return path;
  }

  /** Common neighbors of two nodes (any direction). */
  commonNeighbors(a: string, b: string): string[] {
    const setA = new Set<string>();
    for (const e of this.neighbors(a, 'both')) setA.add(e.source === a ? e.target : e.source);
    const out: string[] = [];
    for (const e of this.neighbors(b, 'both')) {
      const n = e.source === b ? e.target : e.source;
      if (setA.has(n)) out.push(n);
    }
    return out;
  }

  /** Degree centrality: normalized node count of connections (in+out). */
  degreeCentrality(limit = 20): Record<string, number> {
    const deg: Record<string, number> = {};
    for (const e of this.db.prepare('SELECT source, target FROM edges WHERE deleted_at IS NULL').all() as Record<string, unknown>[]) {
      const s = e.source as string;
      const t = e.target as string;
      deg[s] = (deg[s] ?? 0) + 1;
      deg[t] = (deg[t] ?? 0) + 1;
    }
    return Object.fromEntries(
      Object.entries(deg).sort((a, b) => b[1] - a[1]).slice(0, limit)
    );
  }

  /** PageRank approximation (power iteration, undirected edge weights as transitions). */
  pageRank(iterations = 20, damping = 0.85): Record<string, number> {
    const nodes = this.listNodes(100000).map(n => n.id);
    if (nodes.length === 0) return {};
    let rank: Record<string, number> = {};
    for (const n of nodes) rank[n] = 1 / nodes.length;
    const outDeg: Record<string, number> = {};
    for (const n of nodes) outDeg[n] = this.neighbors(n, 'out').length;
    for (let i = 0; i < iterations; i++) {
      const next: Record<string, number> = {};
      const base = (1 - damping) / nodes.length;
      for (const n of nodes) next[n] = base;
      for (const n of nodes) {
        const deg = outDeg[n];
        if (deg === 0) continue;
        const share = (damping * rank[n]) / deg;
        for (const e of this.neighbors(n, 'out')) next[e.target] = (next[e.target] ?? base) + share;
      }
      rank = next;
    }
    return rank;
  }

  /** Related nodes by weight + confidence + shared neighbors. */
  related(id: string, limit = 10): { node: NodeRecord; score: number }[] {
    const scores = new Map<string, number>();
    const bump = (nid: string, delta: number) => scores.set(nid, (scores.get(nid) ?? 0) + delta);
    for (const e of this.neighbors(id, 'both')) {
      const other = e.source === id ? e.target : e.source;
      bump(other, e.weight * e.confidence);
    }
    // second-degree: shared neighbors add a weaker signal
    for (const e of this.neighbors(id, 'both')) {
      const other = e.source === id ? e.target : e.source;
      for (const e2 of this.neighbors(other, 'both')) {
        const o2 = e2.source === other ? e2.target : e2.source;
        if (o2 !== id && !scores.has(o2)) bump(o2, e.weight * e2.weight * 0.3);
      }
    }
    const out = [...scores.entries()]
      .map(([nid, score]) => ({ node: this.getNode(nid)!, score }))
      .filter(x => x.node !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return out;
  }

  // ---------- export ----------
  /** cytoscape.js-compatible elements JSON. */
  exportElements(): { nodes: { data: { id: string; label: string; type: string } }[]; edges: { data: { id: string; source: string; target: string; label: string; weight: number } }[] } {
    const nodes = this.listNodes(100000).map(n => ({
      data: { id: n.id, label: n.title, type: n.type },
    }));
    const edges = (this.db.prepare('SELECT * FROM edges WHERE deleted_at IS NULL').all() as unknown as EdgeRecord[]).map(e => ({
      data: { id: e.source + '|' + e.target + '|' + e.type, source: e.source, target: e.target, label: e.type, weight: e.weight },
    }));
    return { nodes, edges };
  }

  stats(): { nodes: number; edges: number; snapshots: number } {
    const n = this.db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE deleted_at IS NULL').get() as { c: number };
    const e = this.db.prepare('SELECT COUNT(*) AS c FROM edges WHERE deleted_at IS NULL').get() as { c: number };
    const s = this.db.prepare('SELECT COUNT(*) AS c FROM snapshots').get() as { c: number };
    return { nodes: n.c, edges: e.c, snapshots: s.c };
  }
}

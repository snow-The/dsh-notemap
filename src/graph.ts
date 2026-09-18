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
  updated_at: string;
  /** Bitemporal (light, Graphiti-inspired): when the fact became valid / was invalidated. */
  valid_at: string;
  invalid_at: string | null;
}

/**
 * Optional semantic layer (LightRAG deferred vector indexing / mem0 EmbeddingBase).
 * Plug in any embedding provider; nothing else changes. When absent, keyword
 * (FTS5) retrieval still works — vectors are an optional upgrade.
 */
export interface EmbeddingProvider {
  readonly dim: number;
  /** Embed a batch of texts into float32 vectors (same order). */
  embed(texts: string[]): Float32Array[];
  /** Optional model label for stats/debug. */
  label?: string;
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
const SCHEMA_VERSION = 2;

// ---------- helpers ----------
export function nowIso(): string { return new Date().toISOString(); }

/** Normalization contract (LightRAG insert_custom_kg): trim + collapse whitespace + case fold. */
export function normalizeName(s: string): string {
  return String(s).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Filter DSL -> SQL. Operators: eq, ne, gt, gte, lt, lte, in, exists.
 * Keys: "type", "title", or "meta.<top-level-key>"; AND/OR/NOT nest.
 * meta.* values are matched with json_each on the meta column.
 */
function buildFilterSql(filter: Record<string, unknown>): { where: string; args: (string | number | null | bigint | Uint8Array)[] } {
  const args: (string | number | null | bigint | Uint8Array)[] = [];
  const parts: string[] = [];
  const cmp = (col: string, cond: unknown): string => {
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      const o = cond as Record<string, unknown>;
      if ('exists' in o) return o.exists ? col + ' IS NOT NULL' : col + ' IS NULL';
      if ('in' in o) {
        const list = (o as { in: unknown[] }).in;
        for (const v of list) args.push(v as string | number | null);
        return col + ' IN (' + list.map(() => '?').join(',') + ')';
      }
      const opMap: Record<string, string> = { eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
      for (const op of Object.keys(opMap)) {
        if (op in o) { args.push(o[op] as string | number | null); return col + ' ' + opMap[op] + ' ?'; }
      }
      return '1=0';
    }
    args.push(cond as string | number | null);
    return col + ' = ?';
  };
  for (const [key, cond] of Object.entries(filter)) {
    if (key === 'AND' || key === 'OR') {
      const subs = (Array.isArray(cond) ? cond : [cond]).map((c) => buildFilterSql(c as Record<string, unknown>));
      parts.push('(' + subs.map((s) => s.where).join(key === 'AND' ? ' AND ' : ' OR ') + ')');
      for (const s of subs) args.push(...s.args);
      continue;
    }
    if (key === 'NOT') {
      const sub = buildFilterSql(cond as Record<string, unknown>);
      parts.push('NOT (' + sub.where + ')');
      args.push(...sub.args);
      continue;
    }
    if (key.startsWith('meta.')) {
      const metaKey = key.slice(5);
      const isObj = cond !== null && typeof cond === 'object' && !Array.isArray(cond);
      if (isObj && 'exists' in (cond as Record<string, unknown>)) {
        // key presence: json_each with path yields rows only when the key exists
        parts.push(((cond as Record<string, unknown>).exists ? 'EXISTS' : 'NOT EXISTS') + ' (SELECT 1 FROM json_each(nodes.meta, ?))');
        args.push('$.' + metaKey);
      } else {
        // path-based json_each: scalar values yield 1 row, array values yield one row per element
        args.push('$.' + metaKey);
        parts.push('EXISTS (SELECT 1 FROM json_each(nodes.meta, ?) je WHERE ' + cmp('je.value', cond) + ')');
      }
    } else if (key === 'type' || key === 'title') {
      parts.push(cmp('nodes.' + key, cond));
    }
  }
  return { where: parts.length ? parts.join(' AND ') : '1=1', args };
}

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
      "",
      "",
      "",
      "CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(",
      "  title, content,",
      "  content='nodes', content_rowid='rowid',",
      "  tokenize='trigram'",
      ");",
      // backfill FTS index for pre-existing rows (migrate runs before any writes)
      "INSERT INTO nodes_fts(nodes_fts) VALUES('delete-all');",
      "INSERT INTO nodes_fts(rowid, title, content) SELECT rowid, title, content FROM nodes;",
      "CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN",
      "  INSERT INTO nodes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);",
      "END;",
      "CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN",
      "  INSERT INTO nodes_fts(nodes_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);",
      "END;",
      "CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE OF title, content ON nodes BEGIN",
      "  INSERT INTO nodes_fts(nodes_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);",
      "  INSERT INTO nodes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);",
      "END;",
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
    // idempotent schema-v2 migrations (safe on every boot)
    try { this.db.exec("ALTER TABLE edges ADD COLUMN updated_at TEXT;"); } catch { /* already present */ }
    try { this.db.exec("UPDATE edges SET updated_at = created_at WHERE updated_at IS NULL;"); } catch { /* no-op */ }
    // schema-v3: bitemporal edges (light version, Graphiti-inspired)
    try { this.db.exec("ALTER TABLE edges ADD COLUMN valid_at TEXT;"); } catch { /* already present */ }
    try { this.db.exec("UPDATE edges SET valid_at = created_at WHERE valid_at IS NULL;"); } catch { /* no-op */ }
    try { this.db.exec("ALTER TABLE edges ADD COLUMN invalid_at TEXT;"); } catch { /* already present */ }
    // schema-v3: degree cache table (kept in sync via triggers)
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS degree_cache (" +
      "  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE," +
      "  degree INTEGER NOT NULL DEFAULT 0" +
      ");"
    );
    this.db.exec(
      "CREATE TRIGGER IF NOT EXISTS edges_deg_ai AFTER INSERT ON edges WHEN NEW.deleted_at IS NULL AND NEW.invalid_at IS NULL BEGIN" +
      "  INSERT INTO degree_cache(node_id, degree) VALUES (NEW.source, 1) ON CONFLICT(node_id) DO UPDATE SET degree = degree + 1;" +
      "  INSERT INTO degree_cache(node_id, degree) VALUES (NEW.target, 1) ON CONFLICT(node_id) DO UPDATE SET degree = degree + 1;" +
      "END;"
    );
    this.db.exec(
      "CREATE TRIGGER IF NOT EXISTS edges_deg_ad AFTER UPDATE OF deleted_at, invalid_at ON edges" +
      " WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) OR (OLD.invalid_at IS NULL AND NEW.invalid_at IS NOT NULL) BEGIN" +
      "  UPDATE degree_cache SET degree = MAX(0, degree - 1) WHERE node_id IN (OLD.source, OLD.target);" +
      "END;"
    );
    this.db.exec(
      "CREATE TRIGGER IF NOT EXISTS edges_deg_au AFTER UPDATE OF deleted_at, invalid_at ON edges" +
      " WHEN (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL) OR (OLD.invalid_at IS NOT NULL AND NEW.invalid_at IS NULL) BEGIN" +
      "  INSERT INTO degree_cache(node_id, degree) VALUES (NEW.source, 1) ON CONFLICT(node_id) DO UPDATE SET degree = degree + 1;" +
      "  INSERT INTO degree_cache(node_id, degree) VALUES (NEW.target, 1) ON CONFLICT(node_id) DO UPDATE SET degree = degree + 1;" +
      "END;"
    );
    // backfill degree cache once (idempotent: rebuild only when empty)
    const degCount = this.db.prepare('SELECT COUNT(*) AS c FROM degree_cache').get() as { c: number };
    if (degCount.c === 0) {
      this.db.exec(
        'INSERT INTO degree_cache(node_id, degree) ' +
        "SELECT node_id, COUNT(*) FROM (SELECT source AS node_id FROM edges WHERE deleted_at IS NULL AND invalid_at IS NULL " +
        "UNION ALL SELECT target AS node_id FROM edges WHERE deleted_at IS NULL AND invalid_at IS NULL) GROUP BY node_id"
      );
    }
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
    const title = String(opts.title).replace(/\s+/g, ' ').trim();
    if (!title) throw new Error('node title cannot be empty after normalization');
    const id = opts.id ?? crypto.randomUUID();
    const t = nowIso();
    this.db.prepare(
      'INSERT INTO nodes (id, type, title, content, embedding, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(id) DO UPDATE SET type = excluded.type, title = excluded.title, content = excluded.content, '
      + 'embedding = excluded.embedding, meta = excluded.meta, updated_at = excluded.updated_at, deleted_at = NULL'
    ).run(id, opts.type ?? 'note', title, opts.content ?? '', encodeEmbedding(opts.embedding ?? null), JSON.stringify(opts.meta ?? {}), t, t);
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
      const t = nowIso();
      this.db.prepare('UPDATE edges SET deleted_at = ?, invalid_at = ? WHERE (source = ? OR target = ?) AND deleted_at IS NULL AND invalid_at IS NULL').run(t, t, id, id);
    }
    return r.changes > 0;
  }

  /** Soft-delete every node and edge — resets the working graph while keeping snapshots/changes history. */
  clearAll(): { nodes: number; edges: number } {
    return this.withTx(() => {
      const n = Number(this.db.prepare('UPDATE nodes SET deleted_at = ?, updated_at = ? WHERE deleted_at IS NULL').run(nowIso(), nowIso()).changes);
      const t = nowIso();
      const e = Number(this.db.prepare('UPDATE edges SET deleted_at = ?, invalid_at = ? WHERE deleted_at IS NULL AND invalid_at IS NULL').run(t, t).changes);
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
    const query = String(q).trim();
    if (!query) return [];
    // FTS5 trigram handles CJK substring matching; rank by BM25, fall back to LIKE.
    let rows: Record<string, unknown>[] = [];
    try {
      const ftsQuery = query.replace(/"|'/g, ' ').trim().slice(0, 64);
      rows = this.db.prepare(
        'SELECT n.*, bm25(nodes_fts, 8.0, 2.0) AS bm25, '
        + "(SELECT json_group_array(json_object('id', e.target, 'type', e.type, 'weight', e.weight)) "
        + '  FROM edges e WHERE e.source = n.id AND e.deleted_at IS NULL AND e.invalid_at IS NULL LIMIT 6) AS neighbors_json '
        + 'FROM nodes_fts JOIN nodes n ON n.rowid = nodes_fts.rowid '
        + "WHERE nodes_fts MATCH ? AND n.deleted_at IS NULL "
        + 'ORDER BY bm25 LIMIT ?'
      ).all('"' + ftsQuery + '"', limit) as Record<string, unknown>[];
    } catch { /* trigram/FTS unavailable — fall through to LIKE */ }
    if (rows.length === 0) {
      const like = '%' + query + '%';
      rows = this.db.prepare(
        'SELECT n.*, 0 AS bm25, '
        + "(SELECT json_group_array(json_object('id', e.target, 'type', e.type, 'weight', e.weight)) "
        + '  FROM edges e WHERE e.source = n.id AND e.deleted_at IS NULL AND e.invalid_at IS NULL LIMIT 6) AS neighbors_json '
        + 'FROM nodes n WHERE n.deleted_at IS NULL AND (n.title LIKE ? OR n.content LIKE ?) '
        + 'ORDER BY CASE WHEN n.title LIKE ? THEN 0 ELSE 1 END, n.updated_at DESC LIMIT ?'
      ).all(like, like, like, limit) as Record<string, unknown>[];
    }
    const out: { node: NodeRecord; neighbors: { id: string; type: string; weight: number }[]; snippet: string }[] = [];
    for (const r of rows) {
      const node = this.rowToNode(r);
      let neighbors: { id: string; type: string; weight: number }[] = [];
      try { neighbors = JSON.parse(String(r.neighbors_json ?? '[]')); } catch { /* ignore */ }
      const needle = query;
      const i = node.content.indexOf(needle);
      const snippet = i >= 0 ? node.content.slice(Math.max(0, i - 40), i + 120) : node.content.slice(0, 140);
      out.push({ node, neighbors, snippet: snippet.replace(/\s+/g, ' ').trim() });
    }
    return out;
  }

  // ---------- edge CRUD ----------
  addEdge(opts: { source: string; target: string; type?: string; weight?: number; confidence?: number; meta?: Record<string, unknown>; version?: boolean }): EdgeRecord {
    const source = String(opts.source).replace(/\s+/g, ' ').trim();
    const target = String(opts.target).replace(/\s+/g, ' ').trim();
    if (!source || !target) throw new Error('edge endpoints cannot be empty after normalization');
    if (source === target) throw new Error('self-loop edges are not allowed');
    const t = nowIso();
    // Light bitemporal semantics: the primary key (source, target, type) is
    // immutable, so a re-add overwrites the current fact (valid_at keeps the
    // first-seen time, invalid_at is cleared on reactivation). The timeline is
    // auditable via invalid_at + the changes table rather than duplicate rows.
    this.db.prepare(
      'INSERT INTO edges (source, target, type, weight, confidence, meta, created_at, updated_at, valid_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT (source, target, type) DO UPDATE SET weight = excluded.weight, confidence = excluded.confidence, meta = excluded.meta, deleted_at = NULL, invalid_at = NULL, updated_at = excluded.updated_at'
    ).run(source, target, opts.type ?? 'related', opts.weight ?? 1.0, opts.confidence ?? 1.0, JSON.stringify(opts.meta ?? {}), t, t, t);
    return this.getEdge(source, target, opts.type ?? 'related')!;
  }

  /** Full edge history for a pair (bitemporal timeline, newest first). */
  edgeHistory(source: string, target: string, type = 'related'): EdgeRecord[] {
    return this.db.prepare(
      'SELECT * FROM edges WHERE source = ? AND target = ? AND type = ? ORDER BY valid_at DESC LIMIT 50'
    ).all(source, target, type) as unknown as EdgeRecord[];
  }

  getEdge(source: string, target: string, type = 'related'): EdgeRecord | null {
    const row = this.db.prepare('SELECT * FROM edges WHERE source = ? AND target = ? AND type = ? AND deleted_at IS NULL AND invalid_at IS NULL').get(source, target, type) as Record<string, unknown> | undefined;
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
      updated_at: (row.updated_at as string) ?? (row.created_at as string),
      valid_at: (row.valid_at as string) ?? (row.created_at as string),
      invalid_at: (row.invalid_at as string | null) ?? null,
    };
  }

  removeEdge(source: string, target: string, type = 'related'): boolean {
    const t = nowIso();
    const r = this.db.prepare(
      'UPDATE edges SET deleted_at = ?, invalid_at = ?, updated_at = ? WHERE source = ? AND target = ? AND type = ? AND deleted_at IS NULL AND invalid_at IS NULL AND invalid_at IS NULL'
    ).run(t, t, t, source, target, type);
    return r.changes > 0;
  }

  neighbors(id: string, dir: 'out' | 'in' | 'both' = 'out'): EdgeRecord[] {
    if (dir === 'out') {
      return this.db.prepare('SELECT * FROM edges WHERE source = ? AND deleted_at IS NULL AND invalid_at IS NULL').all(id) as unknown as EdgeRecord[];
    }
    if (dir === 'in') {
      return this.db.prepare('SELECT * FROM edges WHERE target = ? AND deleted_at IS NULL AND invalid_at IS NULL').all(id) as unknown as EdgeRecord[];
    }
    return this.db.prepare('SELECT * FROM edges WHERE (source = ? OR target = ?) AND deleted_at IS NULL AND invalid_at IS NULL').all(id, id) as unknown as EdgeRecord[];
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
      const edges = this.db.prepare('SELECT * FROM edges WHERE deleted_at IS NULL AND invalid_at IS NULL').all() as unknown as EdgeRecord[];
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

  /** Degree centrality from the degree cache (in+out, O(1) per node). */
  degreeCentrality(limit = 20): Record<string, number> {
    const rows = this.db.prepare(
      'SELECT d.node_id, d.degree FROM degree_cache d JOIN nodes n ON n.id = d.node_id WHERE n.deleted_at IS NULL ORDER BY d.degree DESC LIMIT ?'
    ).all(limit) as { node_id: string; degree: number }[];
    return Object.fromEntries(rows.map(r => [r.node_id, r.degree]));
  }

  /** Cached degree of a node (falls back to a live count when uncached). */
  degreeOf(id: string): number {
    const row = this.db.prepare('SELECT degree FROM degree_cache WHERE node_id = ?').get(id) as { degree: number } | undefined;
    if (row) return row.degree;
    return this.db.prepare('SELECT COUNT(*) AS c FROM edges WHERE (source = ? OR target = ?) AND deleted_at IS NULL AND invalid_at IS NULL').get(id, id) as unknown as number;
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

  /** Related nodes by weight + confidence + degree signal (LightRAG rank=(edge_degree, weight)). */
  related(id: string, limit = 10): { node: NodeRecord; score: number }[] {
    const scores = new Map<string, number>();
    const bump = (nid: string, delta: number) => scores.set(nid, (scores.get(nid) ?? 0) + delta);
    for (const e of this.neighbors(id, 'both')) {
      const other = e.source === id ? e.target : e.source;
      const degree = this.degreeOf(other);
      bump(other, e.weight * e.confidence * (1 + Math.log1p(degree) / 4));
    }
    // second-degree: shared neighbors add a decaying signal (mem0 two-hop
    // boost: 1/(1+0.001(n-1)^2), n = hops away)
    for (const e of this.neighbors(id, 'both')) {
      const other = e.source === id ? e.target : e.source;
      for (const e2 of this.neighbors(other, 'both')) {
        const o2 = e2.source === other ? e2.target : e2.source;
        if (o2 !== id && !scores.has(o2)) {
          const n = 2; // two hops
          const decay = 1 / (1 + 0.001 * (n - 1) * (n - 1));
          bump(o2, e.weight * e2.weight * 0.3 * decay);
        }
      }
    }
    const out = [...scores.entries()]
      .map(([nid, score]) => ({ node: this.getNode(nid)!, score }))
      .filter(x => x.node !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return out;
  }

  // ---------- retrieval (P3: multi-path + RRF fusion) ----------
  /**
   * Multi-path retrieval with Reciprocal Rank Fusion (Graphiti-style):
   * candidates from FTS5 BM25, LIKE fallback, and graph BFS expansion are
   * merged with RRF (k=60). Budgets cap per-path candidates and BFS depth so
   * large graphs stay responsive.
   */
  searchFused(q: string, opts: { limit?: number; maxDepth?: number; budget?: number; rrfK?: number } = {}): { node: NodeRecord; score: number }[] {
    const query = String(q).trim();
    const limit = opts.limit ?? 20;
    const maxDepth = opts.maxDepth ?? 2;
    const budget = opts.budget ?? 60;
    const k = opts.rrfK ?? 60;
    if (!query) return [];

    const paths: string[][] = [];
    // Path 1: FTS5 BM25
    const fts: string[] = [];
    try {
      const ftsQuery = query.replace(/"|'/g, ' ').trim().slice(0, 64);
      const rows = this.db.prepare(
        'SELECT n.id FROM nodes_fts JOIN nodes n ON n.rowid = nodes_fts.rowid '
        + "WHERE nodes_fts MATCH ? AND n.deleted_at IS NULL ORDER BY bm25(nodes_fts, 8.0, 2.0) LIMIT ?"
      ).all('"' + ftsQuery + '"', budget) as { id: string }[];
      for (const r of rows) fts.push(r.id);
    } catch { /* FTS unavailable */ }
    if (fts.length) paths.push(fts);

    // Path 2: LIKE substring (title first, then content)
    const like = '%' + query + '%';
    const likeRows = this.db.prepare(
      'SELECT id FROM nodes WHERE deleted_at IS NULL AND (title LIKE ? OR content LIKE ?) '
      + 'ORDER BY CASE WHEN title LIKE ? THEN 0 ELSE 1 END, updated_at DESC LIMIT ?'
    ).all(like, like, like, budget) as { id: string }[];
    if (likeRows.length) paths.push(likeRows.map(r => r.id));

    // Path 3: BFS expansion from FTS seeds (shared-neighbor recall, budgeted)
    if (fts.length && maxDepth > 0) {
      const bfsIds: string[] = [];
      const visited = new Set<string>(fts);
      const queue: [string, number][] = fts.map(id => [id, 0] as [string, number]);
      while (queue.length > 0 && bfsIds.length < budget) {
        const [cur, depth] = queue.shift()!;
        if (depth >= maxDepth) continue;
        for (const e of this.neighbors(cur, 'both')) {
          const other = e.source === cur ? e.target : e.source;
          if (!visited.has(other)) {
            visited.add(other);
            bfsIds.push(other);
            queue.push([other, depth + 1]);
          }
        }
      }
      if (bfsIds.length) paths.push(bfsIds);
    }

    // RRF fusion: score = sum over paths of 1/(k + rank)
    const scores = new Map<string, number>();
    for (const p of paths) {
      for (let i = 0; i < p.length; i++) {
        scores.set(p[i], (scores.get(p[i]) ?? 0) + 1 / (k + i + 1));
      }
    }
    return [...scores.entries()]
      .map(([id, score]) => ({ node: this.getNode(id), score }))
      .filter((x): x is { node: NodeRecord; score: number } => x.node !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // ---------- filter DSL (P3: eq/ne/gt/AND/OR/NOT via json_each) ----------
  /**
   * Filter nodes by a DSL over type + meta. Operators: eq, ne, gt, gte, lt,
   * lte, in, exists, and logical AND/OR/NOT. Meta values are matched with
   * json_each so nested keys like "meta.kind" work.
   */
  filterNodes(filter: Record<string, unknown>, limit = 50): NodeRecord[] {
    const sql = buildFilterSql(filter);
    const rows = this.db.prepare(
      'SELECT * FROM nodes WHERE deleted_at IS NULL AND ' + sql.where + ' ORDER BY updated_at DESC LIMIT ?'
    ).all(...sql.args, limit) as Record<string, unknown>[];
    return rows.map(r => this.rowToNode(r));
  }

  // ---------- export ----------
  /** cytoscape.js-compatible elements JSON. */
  // ---------- P4: semantic auto-linking ----------
  // Link nodes whose content is lexically similar (bigram Jaccard), so BFS
  // expansion in searchFused can surface topically-related nodes that share
  // no exact query term. O(n^2) on the given subset; keep subsets small.
  autoLinkSemantic(ids?: string[], opts: { minSim?: number; maxPerNode?: number; type?: string } = {}): { edges: number; pairs: number } {
    const minSim = opts.minSim ?? 0.22;
    const maxPerNode = opts.maxPerNode ?? 4;
    const type = opts.type ?? 'semantic';
    const all = ids ? ids.map((id) => this.getNode(id)).filter((n): n is NodeRecord => !!n) : this.listNodes(100000);
    if (all.length < 2) return { edges: 0, pairs: 0 };
    const tok = (n: NodeRecord): Set<string> => {
      const s = (n.title + ' ' + n.content).toLowerCase();
      const t = new Set<string>();
      for (let i = 0; i < s.length - 1; i++) {
        const c = s.charCodeAt(i);
        // keep CJK + latin runs only (skip whitespace/punct bigrams)
        if (c > 127 || /[a-z0-9]/.test(s[i])) t.add(s.slice(i, i + 2));
      }
      return t;
    };
    const jaccard = (a: Set<string>, b: Set<string>): number => {
      let inter = 0;
      for (const x of a) if (b.has(x)) inter++;
      const union = a.size + b.size - inter;
      return union === 0 ? 0 : inter / union;
    };
    const toks = all.map((n) => tok(n));
    const sizes = toks.map((t) => t.size);
    // 倒排索引:bigram -> 文档下标列表(只比较共享 >=1 bigram 的对,而非全 O(n^2))
    const inverted = new Map<string, number[]>();
    for (let i = 0; i < toks.length; i++) {
      for (const b of toks[i]) {
        let l = inverted.get(b);
        if (!l) { l = []; inverted.set(b, l); }
        l.push(i);
      }
    }
    // 高频 bigram(文档频率 > dfCap)无区分度且候选对爆炸,跳过 —— 可能漏掉交集仅由高频 bigram 组成的对(近似)
    const dfCap = Math.max(500, Math.floor(all.length * 0.2));
    const N = all.length;
    const pairInter = new Map<number, number>();
    let candidates = 0;
    for (const [, docs] of inverted) {
      if (docs.length > dfCap) continue;
      for (let x = 0; x < docs.length; x++) {
        for (let y = x + 1; y < docs.length; y++) {
          const k = docs[x] * N + docs[y];
          pairInter.set(k, (pairInter.get(k) ?? 0) + 1);
        }
      }
    }
    const edgesByNode: Map<string, { target: string; sim: number }[]> = new Map();
    let pairs = 0;
    for (const [k, inter] of pairInter) {
      candidates++;
      const i = Math.floor(k / N), j = k % N;
      // 交集下界剪枝:sim >= minSim 要求 inter >= ceil(minSim * max(|a|,|b|))
      const maxSize = sizes[i] > sizes[j] ? sizes[i] : sizes[j];
      if (inter < Math.ceil(minSim * maxSize)) continue;
      const union = sizes[i] + sizes[j] - inter;
      const sim = inter / union;
      if (sim < minSim) continue;
      pairs++;
      const push = (a: number, b: number) => {
        const kk = all[a].id;
        const list = edgesByNode.get(kk) ?? [];
        list.push({ target: all[b].id, sim });
        edgesByNode.set(kk, list);
      };
      push(i, j); push(j, i);
    }
    let edges = 0;
    for (const [source, list] of edgesByNode) {
      list.sort((a, b) => b.sim - a.sim);
      for (const e of list.slice(0, maxPerNode)) {
        this.addEdge({ source, target: e.target, type, weight: Math.round(e.sim * 100) / 100, confidence: 0.75 });
        edges++;
      }
    }
    return { edges, pairs };
  }

  exportElements(): { nodes: { data: { id: string; label: string; type: string } }[]; edges: { data: { id: string; source: string; target: string; label: string; weight: number } }[] } {
    const nodes = this.listNodes(100000).map(n => ({
      data: { id: n.id, label: n.title, type: n.type },
    }));
    const edges = (this.db.prepare('SELECT * FROM edges WHERE deleted_at IS NULL AND invalid_at IS NULL').all() as unknown as EdgeRecord[]).map(e => ({
      data: { id: e.source + '|' + e.target + '|' + e.type, source: e.source, target: e.target, label: e.type, weight: e.weight },
    }));
    return { nodes, edges };
  }

  // ---------- semantic layer (optional EmbeddingProvider) ----------
  private provider: EmbeddingProvider | null = null;

  /** Register an embedding provider. Null clears it. */
  setEmbeddingProvider(provider: EmbeddingProvider | null): void { this.provider = provider; }

  getEmbeddingProvider(): EmbeddingProvider | null { return this.provider; }

  /** Vector similarity search (cosine over stored embeddings). Requires a provider. */
  searchVector(query: string, opts: { topK?: number; type?: string } = {}): { node: NodeRecord; score: number }[] {
    const provider = this.provider;
    if (!provider) throw new Error('no embedding provider registered — call setEmbeddingProvider() first');
    const [qv] = provider.embed([query]);
    const topK = opts.topK ?? 10;
    const rows = (opts.type ? this.db.prepare('SELECT * FROM nodes WHERE deleted_at IS NULL AND type = ?').all(opts.type) : this.db.prepare('SELECT * FROM nodes WHERE deleted_at IS NULL').all()) as Record<string, unknown>[];
    const scored: { node: NodeRecord; score: number }[] = [];
    for (const row of rows) {
      const emb = decodeEmbedding(row.embedding as Uint8Array | null);
      if (!emb || emb.length !== qv.length) continue;
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < qv.length; i++) { dot += qv[i] * emb[i]; na += qv[i] * qv[i]; nb += emb[i] * emb[i]; }
      const cos = dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
      scored.push({ node: this.rowToNode(row), score: cos });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /** Batch-embed all nodes missing an embedding (deferred vector indexing). */
  embedAll(batchSize = 64): number {
    const provider = this.provider;
    if (!provider) throw new Error('no embedding provider registered');
    const missing = this.db.prepare('SELECT * FROM nodes WHERE deleted_at IS NULL AND embedding IS NULL').all() as Record<string, unknown>[];
    let done = 0;
    for (let i = 0; i < missing.length; i += batchSize) {
      const batch = missing.slice(i, i + batchSize);
      const texts = batch.map(r => String(r.title) + '\n' + String(r.content).slice(0, 2000));
      const vecs = provider.embed(texts);
      const stmt = this.db.prepare('UPDATE nodes SET embedding = ?, updated_at = ? WHERE id = ?');
      for (let j = 0; j < batch.length; j++) stmt.run(encodeEmbedding(vecs[j]), nowIso(), batch[j].id as string);
      done += batch.length;
    }
    return done;
  }

  // ---------- batch ops (LightRAG batch interface) ----------
  upsertNodesBatch(nodes: { id?: string; type?: string; title: string; content?: string; embedding?: Float32Array | null; meta?: Record<string, unknown> }[]): number {
    return this.withTx(() => {
      let n = 0;
      for (const node of nodes) { this.addNode(node); n++; }
      return n;
    });
  }

  upsertEdgesBatch(edges: { source: string; target: string; type?: string; weight?: number; confidence?: number; meta?: Record<string, unknown> }[]): number {
    return this.withTx(() => {
      let n = 0;
      for (const e of edges) { this.addEdge(e); n++; }
      return n;
    });
  }

  // ---------- subgraph extraction (LightRAG get_knowledge_graph) ----------
  subgraph(seed: string, maxDepth = 2, maxNodes = 50): { nodes: NodeRecord[]; edges: EdgeRecord[] } {
    const visited = new Set<string>([seed]);
    const queue: [string, number][] = [[seed, 0]];
    const edgeKeys = new Set<string>();
    const nodeList: NodeRecord[] = [];
    const edgeList: EdgeRecord[] = [];
    const seedNode = this.getNode(seed);
    if (seedNode) nodeList.push(seedNode);
    while (queue.length > 0 && nodeList.length < maxNodes) {
      const [cur, depth] = queue.shift()!;
      if (depth >= maxDepth) continue;
      for (const e of this.neighbors(cur, 'both')) {
        const other = e.source === cur ? e.target : e.source;
        const key = [e.source, e.target, e.type].join('|');
        if (!edgeKeys.has(key)) { edgeKeys.add(key); edgeList.push(e); }
        if (!visited.has(other) && nodeList.length < maxNodes) {
          visited.add(other);
          const n = this.getNode(other);
          if (n) nodeList.push(n);
          queue.push([other, depth + 1]);
        }
      }
    }
    return { nodes: nodeList, edges: edgeList };
  }

  // ---------- labels (LightRAG search_labels / get_popular_labels) ----------
  /**
   * Substring match over titles, in the SAME shape as {@link popularLabels}.
   *
   * It used to return bare strings while popularLabels returned `{title, degree}` records: one
   * tool, two output types. The declared schema can describe only one of them, so every non-empty
   * prefix failed output validation (`"value[0]" must be an object`) while the popular branch
   * passed. The match is a substring (`LIKE '%q%'`) — that is what the description now says. An
   * empty query still returns [] instead of scanning the table; callers who want "everything" ask
   * for the degree ranking, which is also what the tool's default call now does.
   */
  searchLabels(prefix: string, limit = 20): { title: string; degree: number }[] {
    const q = String(prefix).trim();
    if (!q) return [];
    const rows = this.db.prepare(
      'SELECT n.title AS title, MAX(COALESCE(d.degree, 0)) AS degree FROM nodes n LEFT JOIN degree_cache d ON d.node_id = n.id '
      + 'WHERE n.deleted_at IS NULL AND n.title LIKE ? GROUP BY n.title ORDER BY n.title LIMIT ?'
    ).all('%' + q + '%', limit) as { title: string; degree: number }[];
    return rows;
  }

  popularLabels(limit = 20): { title: string; degree: number }[] {
    const rows = this.db.prepare(
      'SELECT n.title, COALESCE(d.degree, 0) AS degree FROM nodes n LEFT JOIN degree_cache d ON d.node_id = n.id '
      + 'WHERE n.deleted_at IS NULL ORDER BY degree DESC, n.updated_at DESC LIMIT ?'
    ).all(limit) as { title: string; degree: number }[];
    return rows;
  }

  stats(): { nodes: number; edges: number; snapshots: number } {
    const n = this.db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE deleted_at IS NULL').get() as { c: number };
    const e = this.db.prepare('SELECT COUNT(*) AS c FROM edges WHERE deleted_at IS NULL AND invalid_at IS NULL').get() as { c: number };
    const s = this.db.prepare('SELECT COUNT(*) AS c FROM snapshots').get() as { c: number };
    return { nodes: n.c, edges: e.c, snapshots: s.c };
  }
}

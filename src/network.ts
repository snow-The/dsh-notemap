/**
 * dsh-notemap — the network builder (the relation layer).
 *
 * Layering decided by the owner: handoff COLLECTS and ORGANISES (session logs ->
 * checkpoints -> entities -> the authoritative graph + provenance), memory PROCESSES
 * and USES (seven layers), and notemap RELATES: it turns those linear structures into
 * a typed node network with weighted edges.
 *
 * Design rules:
 *  - read-only against BOTH source stores; notemap never writes to them;
 *  - every derived node/edge id is deterministic, so a rebuild is idempotent;
 *  - columns are discovered with PRAGMA table_info instead of being hard-coded: the
 *    three plugins evolve independently, and a schema change must degrade to "fewer
 *    fields", never to "silently zero results";
 *  - anything here can be dropped and rebuilt from the two stores at any time.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getStore } from './notemap.ts';
import { betaConfidence, recencyDecay } from './relations.ts';

const LAYERS = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules'] as const;

export function dshHome(): string {
  return process.env.DSH_DATA_DIR ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
}
export function acpGraphPath(): string { return join(dshHome(), 'graph', 'graph.db'); }
export function memoryDbPath(): string { return join(dshHome(), 'memory', 'memory.db'); }

/** Only the error path logs: an empty network must never look like a missing graph. */
function warn(what: string, err: unknown): void {
  console.warn('[dsh-notemap] ' + what + ':', err instanceof Error ? err.message : String(err));
}

function openReadOnly(path: string): DatabaseSync | null {
  try {
    if (!existsSync(path)) return null;                 // absent by design, not an error
    return new DatabaseSync(path, { readOnly: true });
  } catch (err) { warn('cannot open ' + path + ' read-only', err); return null; }
}
function tableExists(db: DatabaseSync, table: string): boolean {
  try { return db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(table) !== undefined; } catch (err) { warn('schema probe failed for table ' + table, err); return false; }
}
function columnsOf(db: DatabaseSync, table: string): Set<string> {
  try { return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name)); } catch { return new Set(); }
}
/** Build a SELECT list from the columns that actually exist. */
function pick(cols: Set<string>, wanted: readonly string[]): string[] {
  return wanted.filter((c) => cols.has(c));
}
function norm(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim();
}

export interface NetworkStats {
  built_at: string;
  entities: number; sources: number; checkpoints: number; memories: number;
  edges: number; memory_links: number; delegations: number;
  agents: { main: number; subagent: number };
  acp_available: boolean; memory_available: boolean;
  truncated_edges: boolean;
  /** Edges whose endpoint is missing from the node set (pruned checkpoints,
   *  entities deleted in the source graph). Dropped, never faked. */
  dropped_edges: number;
}

export interface BuildOptions {
  /** Skip the entity/edge half (handoff graph). */
  entities?: boolean;
  /** Skip the memory half. */
  memory?: boolean;
  /** Only import graph edges at or above this weight (default 1). */
  minWeight?: number;
  /** Hard cap on imported graph edges, highest weight first (default 200000). */
  maxEdges?: number;
  /** Cap on entities considered when linking memories (default 4000). */
  maxMemoryLinks?: number;
}

/**
 * Materialise the network from handoff (graph + provenance) and memory (layers).
 * Idempotent: every node/edge id is derived, so running it twice converges.
 */
export function buildNetwork(options: BuildOptions = {}): NetworkStats {
  const store = getStore();
  const built_at = new Date().toISOString();
  const stats: NetworkStats = {
    built_at, entities: 0, sources: 0, checkpoints: 0, memories: 0, edges: 0,
    memory_links: 0, delegations: 0, agents: { main: 0, subagent: 0 },
    acp_available: false, memory_available: false, truncated_edges: false, dropped_edges: 0,
  };
  const nodeRows: { id: string; type: string; title: string; content: string; meta: Record<string, unknown> }[] = [];
  const edgeRows: { source: string; target: string; type: string; weight: number; confidence: number; meta: Record<string, unknown> }[] = [];

  // ---------- half one: handoff's graph (collect / organise) ----------
  const acp = openReadOnly(acpGraphPath());
  if (acp !== null && tableExists(acp, 'nodes')) {
    stats.acp_available = true;
    try {
      const nodeCols = columnsOf(acp, 'nodes');
      const nodeSel = pick(nodeCols, ['id', 'kind', 'title', 'first_seen', 'last_seen']).join(', ');
      interface NodeRow { id: string; kind?: string; title?: string; first_seen?: number; last_seen?: number }
      const rawNodes = acp.prepare(`SELECT ${nodeSel} FROM nodes`).all() as unknown as NodeRow[];

      // provenance: mentions per node, and the distinct sources behind each node
      const mentionCount = new Map<string, number>();
      const sourcesOf = new Map<string, Set<number>>();
      const lastSeenOf = new Map<string, number>();
      let sourceIdToSession = new Map<number, { session_id: string; agent_kind: string; cwd: string | null }>();
      if (tableExists(acp, 'sources')) {
        const srcCols = columnsOf(acp, 'sources');
        const srcSel = pick(srcCols, ['id', 'session_id', 'parent_session', 'agent_kind', 'cwd', 'created_at', 'last_seen']).join(', ');
        interface SourceRow { id: number; session_id: string; parent_session?: string | null; agent_kind?: string; cwd?: string | null; created_at?: number; last_seen?: number }
        const srcRows = acp.prepare(`SELECT ${srcSel} FROM sources`).all() as unknown as SourceRow[];
        for (const s of srcRows) {
          sourceIdToSession.set(Number(s.id), { session_id: String(s.session_id), agent_kind: String(s.agent_kind ?? 'main'), cwd: s.cwd ?? null });
          const id = `src:${s.session_id}`;
          nodeRows.push({
            id, type: s.agent_kind === 'subagent' ? 'agent' : 'session', title: String(s.session_id),
            content: s.cwd === null || s.cwd === undefined ? '' : String(s.cwd),
            meta: { agent_kind: s.agent_kind ?? 'main', parent: s.parent_session ?? null, cwd: s.cwd ?? null, created_at: s.created_at ?? null },
          });
          if (s.agent_kind === 'subagent') stats.agents.subagent++; else stats.agents.main++;
          stats.sources++;
        }
      }
      if (tableExists(acp, 'mentions')) {
        interface MentionRow { source_id: number; node_id: string; count?: number; last_seen?: number }
        const mentionRows = acp.prepare('SELECT source_id, node_id, count, last_seen FROM mentions').all() as unknown as MentionRow[];
        for (const m of mentionRows) {
          const nid = String(m.node_id);
          mentionCount.set(nid, (mentionCount.get(nid) ?? 0) + Number(m.count ?? 1));
          let set = sourcesOf.get(nid);
          if (set === undefined) { set = new Set(); sourcesOf.set(nid, set); }
          set.add(Number(m.source_id));
          const seen = Number(m.last_seen ?? 0);
          if (seen > (lastSeenOf.get(nid) ?? 0)) lastSeenOf.set(nid, seen);
        }
      }
      if (tableExists(acp, 'delegations')) {
        interface DelegRow { parent_source: number; child_source: number }
        for (const d of acp.prepare('SELECT parent_source, child_source FROM delegations').all() as unknown as DelegRow[]) {
          const parent = sourceIdToSession.get(Number(d.parent_source));
          const child = sourceIdToSession.get(Number(d.child_source));
          if (parent === undefined || child === undefined) continue;
          edgeRows.push({
            source: `src:${parent.session_id}`, target: `src:${child.session_id}`, type: 'delegates',
            weight: 1, confidence: 1, meta: {},
          });
          stats.delegations++;
        }
      }
      for (const n of rawNodes) {
        const id = String(n.id);
        nodeRows.push({
          id: `acp:${id}`, type: `entity:${String(n.kind ?? 'term')}`, title: String(n.title ?? id),
          content: '', meta: {
            acp_id: id, kind: n.kind ?? null, mentions: mentionCount.get(id) ?? 0,
            sources: [...(sourcesOf.get(id) ?? new Set<number>())].length,
            last_seen: lastSeenOf.get(id) ?? null,
            confidence: betaConfidence(mentionCount.get(id) ?? 0),
            recency: recencyDecay(lastSeenOf.get(id) ?? 0),
          },
        });
        stats.entities++;
      }
      if (tableExists(acp, 'checkpoints')) {
        const cpCols = columnsOf(acp, 'checkpoints');
        const cpSel = pick(cpCols, ['session_id', 'seq_start', 'seq_end', 'summary', 'created_at']).join(', ');
        interface CpRow { session_id: string; seq_start: number; seq_end?: number; summary?: string; created_at?: number }
        for (const c of acp.prepare(`SELECT ${cpSel} FROM checkpoints`).all() as unknown as CpRow[]) {
          nodeRows.push({
            id: `cp:${c.session_id}:${c.seq_start}`, type: 'checkpoint',
            title: `${c.session_id} @${c.seq_start}`, content: String(c.summary ?? '').slice(0, 2000),
            meta: { session_id: c.session_id, seq_start: c.seq_start, seq_end: c.seq_end ?? null, created_at: c.created_at ?? null },
          });
          edgeRows.push({ source: `src:${c.session_id}`, target: `cp:${c.session_id}:${c.seq_start}`, type: 'contains', weight: 1, confidence: 1, meta: {} });
          stats.checkpoints++;
        }
      }
      if (tableExists(acp, 'checkpoint_nodes')) {
        interface CnRow { session_id: string; seq_start: number; node_id: string }
        for (const cn of acp.prepare('SELECT session_id, seq_start, node_id FROM checkpoint_nodes').all() as unknown as CnRow[]) {
          edgeRows.push({
            source: `cp:${cn.session_id}:${cn.seq_start}`, target: `acp:${cn.node_id}`, type: 'mentions',
            weight: 1, confidence: betaConfidence(mentionCount.get(String(cn.node_id)) ?? 0), meta: {},
          });
        }
      }
      if (tableExists(acp, 'edges')) {
        const eCols = columnsOf(acp, 'edges');
        const eSel = pick(eCols, ['source', 'target', 'relation', 'weight', 'confidence']).join(', ');
        const relationExpr = eCols.has('relation') ? 'relation' : "''";
        const weightExpr = eCols.has('weight') ? 'weight' : '1';
        interface EdgeRow { source: string; target: string; relation?: string; weight?: number; confidence?: number }
        const rows = acp.prepare(`SELECT ${eSel} FROM edges ORDER BY ${weightExpr} DESC LIMIT ?`).all(options.maxEdges ?? 200000) as unknown as EdgeRow[];
        const total = (acp.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n?: number } | undefined)?.n ?? rows.length;
        stats.truncated_edges = total > rows.length;
        for (const e of rows) {
          edgeRows.push({
            source: `acp:${e.source}`, target: `acp:${e.target}`, type: String(e.relation ?? 'related'),
            weight: Number(e.weight ?? 1), confidence: Number(e.confidence ?? 1), meta: {},
          });
          stats.edges++;
        }
      }
    } catch { /* degrade: keep whatever was collected */ } finally { try { acp.close(); } catch { /* */ } }
  }

  // ---------- half two: memory's layers (process / use) ----------
  const mem = openReadOnly(memoryDbPath());
  const entityTitles: { id: string; needle: string }[] = [];
  if (options.memory !== false) {
    for (const row of nodeRows) if (row.id.startsWith('acp:')) entityTitles.push({ id: row.id, needle: norm(row.title) });
  }
  if (mem !== null) {
    stats.memory_available = true;
    let links = 0;
    const cap = options.maxMemoryLinks ?? 4000;
    try {
      for (const layer of LAYERS) {
        if (!tableExists(mem, layer)) continue;
        const cols = columnsOf(mem, layer);
        const sel = pick(cols, ['id', 'content', 'name', 'title', 'goal', 'project', 'importance', 'status', 'keywords', 'created_at', 'updated_at']).join(', ');
        interface MemRow { id: string; content?: string; name?: string; title?: string; goal?: string; project?: string; importance?: number; status?: string; keywords?: string; created_at?: number }
        for (const m of mem.prepare(`SELECT ${sel} FROM ${layer}`).all() as unknown as MemRow[]) {
          const id = `mem:${layer}:${m.id}`;
          const title = String(m.title ?? m.name ?? String(m.content ?? '').slice(0, 60));
          const body = [m.content, m.goal, m.keywords].filter((v) => v !== undefined && v !== null).join(' \n ');
          nodeRows.push({
            id, type: `memory:${layer}`, title, content: String(body).slice(0, 4000),
            meta: { layer, project: m.project ?? null, importance: m.importance ?? 1, status: m.status ?? 'active', created_at: m.created_at ?? null },
          });
          stats.memories++;
          // link the memory to the entities it names: the memory side of the network
          if (links < cap * 12) {
            const hay = ' ' + norm(`${title} ${body}`) + ' ';
            let perMemory = 0;
            for (const entity of entityTitles) {
              if (entity.needle.length < 3) continue;
              if (hay.includes(' ' + entity.needle + ' ') === false) continue;
              edgeRows.push({ source: id, target: entity.id, type: 'mentions', weight: 1, confidence: 0.7, meta: { via: 'text' } });
              links++;
              if (++perMemory >= 12) break;
            }
          }
        }
      }
    } catch { /* degrade */ } finally { try { mem.close(); } catch { /* */ } }
    stats.memory_links = links;
  }

  // ---------- materialise ----------
  const nodes = options.entities === false ? nodeRows.filter((n) => n.id.startsWith('mem:')) : nodeRows;
  const allEdges = options.entities === false ? edgeRows.filter((e) => e.source.startsWith('mem:')) : edgeRows;
  // GraphStore enforces a foreign key on edges. The source graph can legitimately
  // reference things that no longer exist (checkpoints pruned away, entities deleted),
  // and a memory link can target an entity that was filtered out. Drop such edges and
  // report the count instead of inventing placeholder nodes.
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = allEdges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  stats.dropped_edges = allEdges.length - edges.length;
  const storeAny = store as unknown as {
    upsertNodesBatch?: (rows: unknown[]) => unknown;
    upsertEdgesBatch?: (rows: unknown[]) => unknown;
  };
  if (typeof storeAny.upsertNodesBatch === 'function') storeAny.upsertNodesBatch(nodes);
  else for (const n of nodes) store.addNode(n as never);
  if (typeof storeAny.upsertEdgesBatch === 'function') storeAny.upsertEdgesBatch(edges);
  else for (const e of edges) store.addEdge(e as never);
  return stats;
}

/** The agent/session tree with each agent's contribution - the multi-agent view. */
export function agentTree(): {
  session_id: string; agent_kind: string; cwd: string | null; parent: string | null;
  entities: number; mentions: number; checkpoints: number; children: string[];
}[] {
  const acp = openReadOnly(acpGraphPath());
  if (acp === null || !tableExists(acp, 'sources')) return [];
  try {
    interface Row { id: number; session_id: string; parent_session?: string | null; agent_kind?: string; cwd?: string | null; entities?: number; mentions?: number; checkpoints?: number }
    const rows = acp.prepare(`
      SELECT s.id, s.session_id, s.parent_session, s.agent_kind, s.cwd,
             (SELECT COUNT(DISTINCT m.node_id) FROM mentions m WHERE m.source_id = s.id) AS entities,
             (SELECT COALESCE(SUM(m.count), 0) FROM mentions m WHERE m.source_id = s.id) AS mentions,
             (SELECT COUNT(*) FROM checkpoints c WHERE c.session_id = s.session_id) AS checkpoints
      FROM sources s`).all() as unknown as Row[];
    const byId = new Map<string, ReturnType<typeof agentTree>[number]>();
    for (const r of rows) {
      byId.set(String(r.session_id), {
        session_id: String(r.session_id), agent_kind: String(r.agent_kind ?? 'main'), cwd: r.cwd ?? null,
        parent: r.parent_session === undefined || r.parent_session === null ? null : String(r.parent_session),
        entities: Number(r.entities ?? 0), mentions: Number(r.mentions ?? 0),
        checkpoints: Number(r.checkpoints ?? 0), children: [],
      });
    }
    for (const entry of byId.values()) {
      if (entry.parent === null) continue;
      byId.get(entry.parent)?.children.push(entry.session_id);
    }
    return [...byId.values()].sort((a, b) => b.entities - a.entities);
  } catch (err) { warn('agentTree query failed', err); return []; } finally { try { acp.close(); } catch { /* close is best effort */ } }
}

/**
 * Cross-source consensus recall: every session/agent that mentioned a matching
 * entity ranks its own list, the lists are fused (RRF), and the result carries the
 * provenance that makes "several agents agree" visible.
 */
export function consensusRecall(query: string, options: { limit?: number; k?: number; minSources?: number } = {}): {
  id: string; title: string; kind: string | null; score: number; sources: number;
  agent_kinds: string[]; sessions: string[]; mentions: number; confidence: number; recency: number; consensus: number;
}[] {
  const acp = openReadOnly(acpGraphPath());
  if (acp === null || !tableExists(acp, 'nodes') || !tableExists(acp, 'mentions')) return [];
  try {
    interface Row { node_id: string; source_id: number; title: string; kind?: string; count?: number; session_id?: string; agent_kind?: string; last_seen?: number }
    const rows = acp.prepare(`
      SELECT m.node_id, m.source_id, n.title, n.kind, m.count, m.last_seen, s.session_id, s.agent_kind
      FROM mentions m
      JOIN nodes n ON n.id = m.node_id
      LEFT JOIN sources s ON s.id = m.source_id
      WHERE n.title LIKE ?`).all(`%${query}%`) as unknown as Row[];
    const byId = new Map<string, Row[]>();
    for (const r of rows) {
      const list = byId.get(String(r.node_id));
      if (list === undefined) byId.set(String(r.node_id), [r]); else list.push(r);
    }
    // one ranked list per source: entity ids ordered by that source's mention count
    const perSource = new Map<number, Row[]>();
    for (const list of byId.values()) {
      for (const r of list) {
        const arr = perSource.get(Number(r.source_id));
        if (arr === undefined) perSource.set(Number(r.source_id), [r]); else arr.push(r);
      }
    }
    const lists = [...perSource.values()].map((arr) => arr.sort((a, b) => Number(b.count ?? 1) - Number(a.count ?? 1)).map((r) => String(r.node_id)));
    const fused = new Map<string, { score: number; sources: number[] }>();
    lists.forEach((list, index) => {
      list.forEach((id, rank) => {
        const entry = fused.get(id) ?? { score: 0, sources: [] };
        entry.score += 1 / ((options.k ?? 60) + rank + 1);
        entry.sources.push(index);
        fused.set(id, entry);
      });
    });
    const now = Date.now();
    const results = [...fused.entries()].map(([id, entry]) => {
      const list = byId.get(id) ?? [];
      const first = list[0];
      const distinct = new Set(entry.sources).size;
      const mentions = list.reduce((sum, r) => sum + Number(r.count ?? 1), 0);
      const lastSeen = Math.max(...list.map((r) => Number(r.last_seen ?? 0)));
      const confidence = betaConfidence(mentions);
      const recency = recencyDecay(lastSeen, now);
      const consensus = 1 + Math.log(1 + distinct);
      return {
        id, title: String(first?.title ?? id), kind: first?.kind === undefined ? null : String(first.kind),
        score: entry.score * consensus * confidence * recency, sources: distinct,
        agent_kinds: [...new Set(list.map((r) => String(r.agent_kind ?? 'main')))],
        sessions: [...new Set(list.map((r) => String(r.session_id ?? '?')))].slice(0, 5),
        mentions, confidence, recency, consensus,
      };
    });
    const minSources = options.minSources ?? 0;
    return results
      .filter((r) => r.sources >= minSources)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, options.limit ?? 15);
  } catch (err) { warn('consensus recall failed', err); return []; } finally { try { acp.close(); } catch { /* close is best effort */ } }
}

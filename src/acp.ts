/**
 * dsh-notemap — ACP graph compatibility layer (L2 融合层).
 *
 * dsh-session-handoff 的 acp_graph 是跨会话长期记忆的权威图
 * (~/.dsh/graph/graph.db, SQLite + FTS5)。notemap 不再重复解析 session
 * 文件建图，而是:
 *   1) 探测 ACP 图是否可用（graph.db 存在且有 checkpoints）
 *   2) 可用时：从 ACP 图批量导入（实体 + checkpoint 摘要 + 边）到 GraphStore
 *   3) 检索时融合 ACP 图的跨会话命中（node_fts / cp_fts）
 *   无 ACP 图时：完全降级为纯本地 notemap（不破坏现有功能）。
 *
 * 依赖方式：只读 ACP 图 SQLite 文件（数据层依赖），不 import session-handoff 代码。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { GraphStore } from './graph.ts';

function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}
function acpGraphPath(): string {
  return join(dshHome(), 'graph', 'graph.db');
}

/**
 * A fallback keeps working when the ACP graph is unavailable (by design), but it must
 * never be indistinguishable from "the graph is simply empty" - that is how a silent
 * week-long outage happened elsewhere in this stack. Only the error path logs.
 */
function warn(what: string, err: unknown): void {
  console.warn('[dsh-notemap] ' + what + ':', err instanceof Error ? err.message : String(err));
}

/** ACP 图可用性探测：graph.db 存在 且 checkpoints 表非空。 */
export function acpGraphAvailable(): boolean {
  try {
    if (!existsSync(acpGraphPath())) return false;
    const db = new DatabaseSync(acpGraphPath(), { readOnly: true });
    try {
      const row = db.prepare('SELECT COUNT(*) AS c FROM checkpoints').get() as { c: number };
      return (row?.c ?? 0) > 0;
    } finally { db.close(); }
  } catch (err) { warn('ACP graph probe failed', err); return false; }
}

/** 从 ACP 图批量导入到 notemap GraphStore。返回导入统计。 */
export function importFromAcpGraph(store: GraphStore, _force = false): { entities: number; checkpoints: number; edges: number } {
  const db = new DatabaseSync(acpGraphPath(), { readOnly: true });
  try {
    // ACP 实体节点 → notemap node (type=acp-entity)
    const entRows = db.prepare('SELECT id, kind, title, mention_count FROM nodes').all() as { id: string; kind: string; title: string; mention_count: number }[];
    const nodes: { id?: string; type?: string; title: string; content?: string; meta?: Record<string, unknown> }[] = [];
    for (const r of entRows) {
      nodes.push({
        id: 'acp:' + r.id,
        type: 'acp-entity',
        title: r.title || r.id,
        content: 'ACP 实体 [' + (r.kind ?? 'concept') + '] 提及 ' + (r.mention_count ?? 0) + ' 次',
        meta: { acpKind: r.kind, acpMentions: r.mention_count, source: 'acp_graph' },
      });
    }
    // ACP checkpoint 摘要 → notemap node (type=checkpoint)
    const cpRows = db.prepare('SELECT session_id, seq_start, seq_end, summary, created_at FROM checkpoints').all() as { session_id: string; seq_start: number; seq_end: number; summary: string; created_at: number }[];
    const cpNodes: { id?: string; type?: string; title: string; content?: string; meta?: Record<string, unknown> }[] = [];
    for (const c of cpRows) {
      cpNodes.push({
        id: 'acp-cp:' + c.session_id + ':' + c.seq_start,
        type: 'checkpoint',
        title: 'checkpoint s' + c.seq_start + '-' + c.seq_end,
        content: c.summary,
        meta: { session: c.session_id, seqStart: c.seq_start, seqEnd: c.seq_end, source: 'acp_graph' },
      });
    }
    nodes.push(...cpNodes);

    // ACP 边 → notemap edge（实体↔实体 co-occurs + 实体↔checkpoint）
    const edgeRows = db.prepare('SELECT source, target, relation, weight FROM edges').all() as { source: string; target: string; relation: string; weight: number }[];
    const edges: { source: string; target: string; type?: string; weight?: number; confidence?: number; meta?: Record<string, unknown> }[] = [];
    for (const e of edgeRows) {
      edges.push({ source: 'acp:' + e.source, target: 'acp:' + e.target, type: e.relation || 'co-occurs', weight: e.weight ?? 1, meta: { source: 'acp_graph' } });
    }
    // 实体 ↔ 其 checkpoint
    const cnRows = db.prepare('SELECT session_id, seq_start, node_id FROM checkpoint_nodes').all() as { session_id: string; seq_start: number; node_id: string }[];
    for (const cn of cnRows) {
      edges.push({ source: 'acp:' + cn.node_id, target: 'acp-cp:' + cn.session_id + ':' + cn.seq_start, type: 'appears-in', weight: 1, meta: { source: 'acp_graph' } });
    }

    const n1 = store.upsertNodesBatch(nodes);
    const n2 = store.upsertEdgesBatch(edges);
    return { entities: entRows.length, checkpoints: cpRows.length, edges: n2 };
  } finally { db.close(); }
}

/**
 * ACP 图检索融合：查询 ACP 图，返回跨会话 checkpoint 命中。
 * 供 notemap_recall / notemap_fusion 混入结果。
 */
export function acpGraphRecall(query: string, limit = 5): { node: string; summary: string; score: number }[] {
  try {
    if (!acpGraphAvailable()) return [];
    const db = new DatabaseSync(acpGraphPath(), { readOnly: true });
    try {
      const q = String(query ?? '').toLowerCase().trim();
      if (!q) return [];
      const matchQ = JSON.stringify(q) + '*';
      const out: { node: string; summary: string; score: number }[] = [];
      // 1) 实体 FTS 命中 → 带出 checkpoint
      try {
        const rows = db.prepare('SELECT id FROM node_fts WHERE node_fts MATCH ? LIMIT ?').all(matchQ, limit) as { id: string }[];
        for (const r of rows) {
          const cps = db.prepare('SELECT c.summary, c.seq_start FROM checkpoints c JOIN checkpoint_nodes cn ON cn.session_id=c.session_id AND cn.seq_start=c.seq_start WHERE cn.node_id=? ORDER BY c.created_at DESC LIMIT 1').all(r.id) as { summary: string; seq_start: number }[];
          if (cps.length) out.push({ node: r.id, summary: cps[0].summary, score: 1 });
        }
      } catch (err) { warn('entity FTS query failed (cross-session hits lost)', err); }
      // 2) checkpoint 摘要 FTS 命中
      try {
        const cps = db.prepare('SELECT session_id, seq_start, summary FROM cp_fts WHERE cp_fts MATCH ? LIMIT ?').all(matchQ, limit) as { session_id: string; seq_start: number; summary: string }[];
        for (const c of cps) {
          if (!out.some((o) => o.node === 'cp:' + c.session_id + ':' + c.seq_start)) {
            out.push({ node: 'cp:' + c.session_id + ':' + c.seq_start, summary: c.summary, score: 0.8 });
          }
        }
      } catch (err) { warn('checkpoint FTS query failed (cross-session hits lost)', err); }
      // 去重 + 截断
      const seen = new Set<string>();
      const dedup: { node: string; summary: string; score: number }[] = [];
      for (const o of out) { const key = o.node; if (!seen.has(key)) { seen.add(key); dedup.push(o); } }
      return dedup.slice(0, limit);
    } finally { db.close(); }
  } catch (err) { warn('ACP recall failed', err); return []; }
}

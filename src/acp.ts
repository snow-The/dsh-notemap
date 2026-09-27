/**
 * dsh-notemap — ACP graph compatibility layer (L2 融合层).
 *
 * dsh-session-handoff 的 acp_graph 是跨会话长期记忆的权威图
 * (~/.dsh/graph/graph.db, SQLite + FTS5)。notemap 不再重复解析 session
 * 文件建图，而是:
 *   1) 探测 ACP 图是否可用（见下方【可用性语义】）
 *   2) 可用时：从 ACP 图批量导入（实体 + checkpoint 摘要 + 边）到 GraphStore
 *   3) 检索时融合 ACP 图的跨会话命中（node_fts / cp_fts）
 *   无 ACP 图时：完全降级为纯本地 notemap（不破坏现有功能）。
 *
 * 依赖方式：通过【规范化只读契约】读取 ACP 图（见 src/acp-graph-contract.ts，
 * 由 dsh-acp-graph-contract 同步而来，顶部带源哈希，漂移会被 --check 抓到），
 * 不再裸 SQLite + 硬编码表名 + "失败即返回 []"。
 *
 * 为什么改成契约（历史教训）
 * --------------------------
 * 旧实现直接 `new DatabaseSync(acpGraphPath())` 并拼表名，"失败即返回 []"。
 * 于是三种完全不同的状况在调用方看来一模一样：
 *   - 本来就没数据（正常）
 *   - 库不存在 / 插件没装（正常降级）
 *   - schema 变了 / 库被锁 / 库比消费方新（故障——但静默返回 []）
 * 契约返回具名的 Result，因此"没有数据"与"读取失败"不再混淆；失败原因经
 * acpGraphDiagnostics() / acpGraphStatusLine() 暴露。
 *
 * 【可用性语义】acpGraphAvailable() 现在判的是"契约可读"（库存在 + 版本戳不
 * 高于本读取器 + v1 形状齐全），而不再是"checkpoints 表非空"。"库健康但没有
 * checkpoint"过去被报成"不可用"，调用方会打印"请安装 handoff"——那是误导。
 *
 * 边界：只读。图的结构与数据只能由生产者(handoff)变更——见契约文件头。
 */
import {
  acpGraphOr,
  acpGraphPath,
  acpGraphRecall as contractRecall,
  acpGraphStatus,
  ftsPhrase as contractFtsPhrase,
  type AcpGraphStatus,
  type AcpRecallHit,
} from './acp-graph-contract.ts';
import type { GraphStore } from './graph.ts';

export type { AcpGraphStatus, AcpRecallHit };
/** graph.db 的规范路径由契约拥有（不再在插件里各算一遍）。 */
export { acpGraphPath };

/** FTS5 phrase builder（规范化实现；原先 4 个插件各自逐字复制了一份）。 */
export const ftsPhrase = contractFtsPhrase;

/** 最近一次读取失败的原因（供诊断输出）；成功时为 null。 */
let lastProblem: { detail: string; status: AcpGraphStatus } | null = null;

/**
 * 记录失败原因。
 *
 * 只有 'no-db' 不打日志：图不存在是【预期内的降级】（没装 handoff 的机器上 notemap
 * 仍然要能用），公开状态由 acpGraphStatusLine() 负责表达。其余四种原因
 * (schema-mismatch / error / no-contract 下的读取错误) 都是真故障，必须出声——
 * 本项目就是被"schema 漂移静默返回 []"坑过一周的。
 * 无论是否打日志，原因都进 lastProblem，因此诊断永远是完整的。
 */
function note(detail: string, status: AcpGraphStatus): void {
  lastProblem = { detail, status };
  if (status.reason === 'no-db') return;
  console.warn('[dsh-notemap] ACP graph read failed:', detail, `(reason=${status.reason})`);
}

/** 诊断用：契约状态 + 最近一次失败原因。 */
export function acpGraphDiagnostics(): { status: AcpGraphStatus; lastProblem: { detail: string; status: AcpGraphStatus } | null } {
  return { status: acpGraphStatus(), lastProblem };
}

/**
 * 一行人类可读的状态，用于工具输出。
 * 刻意区分"没装"与"装了但读不了"——旧文案在图不可用时一律说
 * "(acp graph not available — install dsh-session-handoff)"，
 * 即使插件已装、只是 schema 不匹配，也会把人引向错误的方向。
 */
export function acpGraphStatusLine(): string {
  const s = acpGraphStatus();
  switch (s.reason) {
    case 'ok':
      return `available (contract v${s.contractVersion}, db v${s.stampedVersion})`;
    case 'no-contract':
      return `available (db has no version stamp; shape verified against contract v${s.contractVersion})`;
    case 'no-db':
      return `not available — ${s.path} does not exist (is dsh-session-handoff installed?)`;
    case 'schema-mismatch':
      return `NOT readable — ${s.detail}${s.missing ? ' missing: ' + JSON.stringify(s.missing) : ''}`;
    default:
      return `NOT readable — ${s.detail ?? 'unknown error'}`;
  }
}

/**
 * 图是否【可读】——语义见文件头【可用性语义】。
 * 注意调用方：若一段逻辑依赖"图里有 checkpoint"，请改为判断查询结果的规模，
 * 而不是依赖本函数；本函数只回答"能不能读"。
 */
export function acpGraphAvailable(): boolean {
  return acpGraphStatus().ok;
}

/**
 * 在【降级路径】上解释"为什么这次没用 ACP 图"。
 *
 * 调用方（如 notemap_import_session 回退到本地解析时）调用它，使"ACP 读不了 → 悄悄
 * 改走本地解析"这条最后的静默路径也留下原因。'no-db' 仍然安静（没装 handoff 是
 * 预期内的降级），其余原因都会出声。
 */
export function acpGraphFallbackNote(what: string): void {
  const s = acpGraphStatus();
  if (s.ok) return; // 图可读：没走 ACP 是调用方自己的数据判断，不是故障
  note(`${what}: falling back because the ACP graph is not readable (${s.detail ?? s.reason})`, s);
}

/** 从 ACP 图批量导入到 notemap GraphStore。返回导入统计；契约不可读时全 0 并记录原因。 */
export function importFromAcpGraph(store: GraphStore, _force = false): { entities: number; checkpoints: number; edges: number } {
  // 整体放进契约保护下：失败是【具名的】，而不是抛出或静默半途而废。
  return acpGraphOr({ entities: 0, checkpoints: 0, edges: 0 }, (db) => {
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

    store.upsertNodesBatch(nodes);
    const n2 = store.upsertEdgesBatch(edges);
    return { entities: entRows.length, checkpoints: cpRows.length, edges: n2 };
  }, note);
}

/**
 * ACP 图检索融合：查询 ACP 图，返回跨会话 checkpoint 命中。
 * 供 notemap_recall / notemap_fusion 混入结果。失败返回 [] 并记录原因（不再静默）。
 */
export function acpGraphRecall(query: string, limit = 5): AcpRecallHit[] {
  const r = contractRecall(query, limit);
  if (!r.ok) { note(r.detail, r.status); return []; }
  return r.value;
}

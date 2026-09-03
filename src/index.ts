import { defineTool as dshDefineTool } from '@deepseek-ai/dsh-tools';
// dsh-tools now requires options.output and the property-map parameters DSL;
// convert legacy JSON-Schema style parameters and default open JSON output.
const defineTool = (o: any) => {
  let parameters = o.parameters;
  const p = o.parameters;
  if (p && p.type === 'object' && p.properties) {
    const required = new Set(p.required ?? []);
    parameters = {};
    for (const [k, v] of Object.entries(p.properties)) {
      parameters[k] = { ...(v as any), ...(required.has(k) ? { required: true } : {}) };
    }
  }
  return dshDefineTool({ ...o, parameters, output: o.output ?? { schema: { type: 'json' }, render: () => [] } });
};
import { registerUi, disposeUi, type UiCtx } from './ui.ts';
import {
  addNote, linkNotes, searchNotes, searchWithContext, findPaths, findRelated, exportGraph,
  graphStats, snapshotNow, centrality, pagerank, neighborsOf, commonNeighbors, closeStore,
  removeNote, clearAll, subgraphOf, searchVector, setProvider, embedAll, labelsOf, getStore,
  searchFusedOf, filterNodesOf,
} from './notemap.ts';
import { acpGraphAvailable, importFromAcpGraph, acpGraphRecall } from './acp.ts';

export const name = 'dsh-notemap';

export const inject = ['tools', 'webServer'] as const;


// ---------- session import (knowledge extraction) ----------
// Scans ~/.dsh/sessions/**/session.jsonl.zstd and turns each session into a
// knowledge subgraph: session node -> checkpoint nodes (ACP-compacted summaries,
// the highest-density knowledge) + user event nodes (real questions, skipping
// runtime-context / system-reminder noise). Deterministic ids => idempotent re-import.
const RT_CTX = 'Current runtime context';
const CHECKPOINT = 'This is an automatically generated checkpoint';
const SKIP_PREFIXES = ['<system-reminder>', '<available_skills>', 'The available skill catalog changed'];

function extractSummary(text: string): string {
  const m = text.match(/<compacted-summary>([\s\S]*?)<\/compacted-summary>/);
  if (m && m[1] && m[1].trim().length > 10) return m[1].trim();
  // fallback: everything after the checkpoint banner (before runtime context if present)
  const rt = text.indexOf(RT_CTX);
  const body = rt >= 0 ? text.slice(0, rt) : text;
  const banner = body.indexOf('\n');
  return banner >= 0 ? body.slice(banner + 1).trim() : body.trim();
}

function extractTopic(summary: string): string {
  for (const line of summary.split('\n')) {
    const t = line.replace(/^#+\s*/, '').replace(/^\*\*/, '').trim();
    if (t && t.length <= 60) return t;
  }
  return summary.slice(0, 60).replace(/\s+/g, ' ').trim();
}

function cleanText(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

const IMPORT_VERSION = 2;

export async function importSessions(opts?: { limit?: number; maxLines?: number; force?: boolean; sessionsDir?: string }): Promise<{
  scanned: number; sessions: number; checkpoints: number; events: number; assistants: number; skipped: number; imported: string[];
}> {
  const { execFileSync } = await import('node:child_process');
  const { readdirSync, statSync, readFileSync } = await import('node:fs');
  const { zstdDecompressSync } = await import('node:zlib');
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');
  const { createHash } = await import('node:crypto');
  const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

  const root = opts?.sessionsDir ?? join(homedir(), '.dsh', 'sessions');
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries: string[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }).map((d) => d.name); } catch { return; }
    for (const name of entries) {
      const p = join(dir, name);
      try {
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.zstd')) files.push(p);
      } catch { /* skip */ }
    }
  };
  walk(root);

  const limit = opts?.limit ?? 30;
  const maxLines = opts?.maxLines ?? 2000;
  const force = opts?.force ?? false;
  const imported: string[] = [];
  let sessions = 0, checkpoints = 0, events = 0, assistants = 0, skipped = 0;

  for (const f of files.slice(0, limit)) {
    let text = '';
    try {
      text = execFileSync('zstd', ['-d', '-c', f], { timeout: 20000, encoding: 'utf8', windowsHide: true });
    } catch {
      try { text = zstdDecompressSync(readFileSync(f)).toString('utf8'); } catch { text = ''; }
    }
    const lines = text.split('\n').filter(Boolean).slice(0, maxLines);
    const base = f.split(/[\\/]/).pop() ?? f;
    const fileKey = hash(f);
    const sessId = 'sess:' + fileKey;
    const fileHash = hash(text);

    // ---- P2: dual watermark (file-level + event-level, idempotent rerun) ----
    // The session node records the file content hash + how many events were
    // imported last time. A rerun with an unchanged file and no new events is
    // skipped entirely (file-level anchor). A changed/appended file only
    // imports events beyond the previous watermark (event-level anchor).
    const existing = getStore().getNode(sessId);
    const prevMeta = (existing?.meta ?? {}) as Record<string, unknown>;
    const prevHash = String(prevMeta.import_hash ?? '');
    const prevEvents = Number(prevMeta.imported_events ?? 0);
    const prevAsst = Number(prevMeta.imported_asst ?? 0);
    const prevVersion = Number(prevMeta.import_version ?? 0);
    if (!force && prevHash === fileHash && prevEvents > 0 && prevVersion === IMPORT_VERSION) {
      skipped++;
      continue;
    }

    let sessTitle = '';
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (ev?.type === 'session/title' && ev?.data?.title) { sessTitle = String(ev.data.title).slice(0, 60); break; }
      } catch { /* skip */ }
    }
    const title = sessTitle || 'session: ' + base.replace(/\.zstd$/, '').slice(0, 40);

    // Episode provenance (P2): every extracted node records which file and
    // which event index it came from, so results are traceable and the
    // watermark can be verified against the source stream.
    const episode = { file: base, importVersion: IMPORT_VERSION };
    const chkNodes: string[] = [];
    const evtNodes: string[] = [];
    const asstNodes: string[] = [];
    let chkIdx = 0, evtIdx = 0, asstIdx = 0, lineIdx = 0;
    for (const line of lines) {
      lineIdx++;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      // DSH session stream: {"type":"user/message"|"assistant/message",data:{content:[{type:'text',text}]}}
      // also tolerate legacy {message:{content}} and plain-string message payloads
      const evType = ev?.type ?? '';
      const m = ev?.message;
      let c: string | undefined;
      if (typeof m === 'string') c = m;
      else if (m && typeof m.content === 'string') c = m.content;
      else {
        const d = ev?.data;
        if (d && Array.isArray(d.content)) {
          c = (d.content as any[]).filter((b) => b && typeof b.text === 'string').map((b) => b.text).join('\n');
        } else if (d && typeof d.text === 'string') {
          c = d.text;
        }
      }
      if (!c || c.length < 20) continue;
      if (c.startsWith(RT_CTX)) continue;
      if (SKIP_PREFIXES.some((p) => c.startsWith(p))) continue;

      if (c.startsWith(CHECKPOINT) || c.includes('compacted-summary')) {
        const summary = extractSummary(c);
        if (summary.length < 20) continue;
        const idx = chkIdx++;
        if (idx < prevEvents && !force) continue; // event-level watermark: already imported (force bypasses)
        const id = 'chk:' + fileKey + ':' + idx;
        const topic = extractTopic(summary);
        await addNote({ id, title: topic || 'checkpoint ' + (idx + 1), content: summary.slice(0, 800), type: 'checkpoint', meta: { file: base, episode: { ...episode, index: idx, line: lineIdx } } });
        chkNodes.push(id);
        checkpoints++;
      } else if (c.includes('system-reminder') || c.startsWith('<') && c.includes('>')) {
        continue;
      } else if (evType === 'assistant/message') {
        const clean = cleanText(c);
        if (clean.length < 8) continue;
        const aidx = asstIdx++;
        if (aidx < prevAsst && !force) continue; // event-level watermark
        const id = 'asst:' + fileKey + ':' + aidx;
        await addNote({ id, title: clean.slice(0, 60), content: clean.slice(0, 600), type: 'assistant-event', meta: { file: base, episode: { ...episode, index: aidx, line: lineIdx } } });
        asstNodes.push(id);
        assistants++;
      } else if (evType === 'user/message' || evType === '') {
        const clean = cleanText(c);
        if (clean.length < 8) continue;
        const idx = evtIdx++;
        if (idx < prevEvents && !force) continue; // event-level watermark: already imported (force bypasses)
        const id = 'evt:' + fileKey + ':' + idx;
        await addNote({ id, title: clean.slice(0, 60), content: clean.slice(0, 600), type: 'session-event', meta: { file: base, episode: { ...episode, index: idx, line: lineIdx } } });
        evtNodes.push(id);
        events++;
      }
    }
    if (chkNodes.length + evtNodes.length === 0 && !existing) continue;

    // Versioned session node: content hash + event watermark + import version.
    const totalImported = chkIdx + evtIdx;
    await addNote({
      id: sessId, title, type: 'session',
      content: (chkIdx + ' checkpoint(s), ' + evtIdx + ' event(s), ' + asstIdx + ' assistant(s) from ' + base),
      meta: { file: base, import_hash: fileHash, imported_events: totalImported, imported_asst: asstIdx, import_version: IMPORT_VERSION, episode },
    });
    for (const id of chkNodes) await linkNotes({ source: sessId, target: id, type: 'checkpoint', weight: 1, confidence: 1 });
    for (const id of evtNodes) await linkNotes({ source: sessId, target: id, type: 'follows', weight: 0.8, confidence: 1 });
    for (const id of asstNodes) await linkNotes({ source: sessId, target: id, type: 'follows', weight: 0.7, confidence: 1 });
    // chain: last checkpoint -> first event (what the compressed knowledge produced)
    if (chkNodes.length && evtNodes.length) {
      await linkNotes({ source: chkNodes[chkNodes.length - 1], target: evtNodes[0], type: 'produces', weight: 0.6, confidence: 0.7 });
    }
    sessions++;
    imported.push(sessId);
  }
  return { scanned: files.length, sessions, checkpoints, events, assistants, skipped, imported };
}

export function apply(ctx: { tools: { register: (def: unknown) => unknown } } & UiCtx): void {
  const reg = ctx.tools?.register?.bind(ctx.tools);
  if (!reg) return;
  void registerUi(ctx);

  reg(defineTool({
    name: 'notemap_add',
    description: 'Add a note node to the networked knowledge graph (dsh-notemap). Returns the created node.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Node title' },
        content: { type: 'string', description: 'Node body content (optional)' },
        type: { type: 'string', description: 'Node type, default note' },
        id: { type: 'string', description: 'Explicit node id (optional, default uuid)' },
      },
      required: ['title'],
    },
    execute: (args: { title: string; content?: string; type?: string; id?: string }) => addNote(args),
  }));

  reg(defineTool({
    name: 'notemap_context',
    description: 'Extract the subgraph around a seed node up to N hops (LightRAG get_knowledge_graph style). Returns nodes + edges, ready for downstream reasoning.',
    parameters: {
      type: 'object',
      properties: {
        seed: { type: 'string', description: 'Seed node id' },
        maxDepth: { type: 'number', description: 'Max hop depth (default 2)' },
        maxNodes: { type: 'number', description: 'Max nodes to collect (default 50)' },
      },
      required: ['seed'],
    },
    execute: (args: { seed: string; maxDepth?: number; maxNodes?: number }) => subgraphOf(args),
  }));

  reg(defineTool({
    name: 'notemap_labels',
    description: 'Search note titles (prefix/fuzzy) or list popular labels by degree. Quick way to discover what the graph knows.',
    parameters: {
      type: 'object',
      properties: {
        prefix: { type: 'string', description: 'Title prefix/fragment to match' },
        popular: { type: 'boolean', description: 'If true, return top labels by connection degree instead' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
    execute: (args: { prefix?: string; popular?: boolean; limit?: number }) => labelsOf(args),
  }));

  reg(defineTool({
    name: 'notemap_vector',
    description: 'Semantic vector search over stored embeddings (cosine). Requires an embedding provider registered via notemap_embed first.',
    parameters: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Natural-language query' },
        topK: { type: 'number', description: 'Max results (default 10)' },
        type: { type: 'string', description: 'Restrict to a node type' },
      },
      required: ['q'],
    },
    execute: (args: { q: string; topK?: number; type?: string }) => searchVector(args),
  }));

  reg(defineTool({
    name: 'notemap_embed',
    description: 'Register an embedding provider (dim) and backfill embeddings for all nodes missing them (deferred vector indexing). Pass dim and embedFn that maps texts to vectors.',
    parameters: {
      type: 'object',
      properties: {
        dim: { type: 'number', description: 'Embedding dimension' },
        embedFn: { type: 'string', description: 'JSON string of a function (texts: string[]) => number[][] — evaluated in the plugin process' },
        batchSize: { type: 'number', description: 'Embedding batch size (default 64)' },
      },
      required: ['dim', 'embedFn'],
    },
    execute: (args: { dim: number; embedFn: string; batchSize?: number }) => {
      const fn = new Function('return ' + args.embedFn)() as (texts: string[]) => number[][];
      setProvider({
        dim: args.dim,
        label: 'dynamic',
        embed: (texts) => fn(texts).map(v => Float32Array.from(v)),
      });
      return { providerDim: args.dim, embedded: embedAll(args.batchSize) };
    },
  }));

  reg(defineTool({
    name: 'notemap_link',
    description: 'Create/update a weighted, confidence-scored edge between two nodes. Relation strength is quantified.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source node id' },
        target: { type: 'string', description: 'Target node id' },
        type: { type: 'string', description: 'Relation type, default related' },
        weight: { type: 'number', description: 'Relation strength 0-1+ (default 1.0)' },
        confidence: { type: 'number', description: 'Confidence 0-1 (default 1.0)' },
      },
      required: ['source', 'target'],
    },
    execute: (args: { source: string; target: string; type?: string; weight?: number; confidence?: number }) => linkNotes(args),
  }));

  reg(defineTool({
    name: 'notemap_search',
    description: 'Full-text search over note titles and content. Returns matching nodes.',
    parameters: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: ['q'],
    },
    execute: (args: { q: string; limit?: number }) => searchNotes(args),
  }));

  reg(defineTool({
    name: 'notemap_paths',
    description: 'Shortest path (Dijkstra, weight-aware) between two nodes. Reveals hidden chains of association.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start node id' },
        to: { type: 'string', description: 'End node id' },
      },
      required: ['from', 'to'],
    },
    execute: (args: { from: string; to: string }) => findPaths(args),
  }));

  reg(defineTool({
    name: 'notemap_related',
    description: 'Rank nodes related to a node by edge weight*confidence plus shared-neighbor signal.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Node id' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['id'],
    },
    execute: (args: { id: string; limit?: number }) => findRelated(args),
  }));

  reg(defineTool({
    name: 'notemap_export',
    description: 'Export the whole graph as cytoscape.js-compatible elements JSON (for infinite-canvas UI rendering).',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: () => exportGraph(),
  }));

  reg(defineTool({
    name: 'notemap_stats',
    description: 'Graph statistics: node/edge/snapshot counts.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: () => graphStats(),
  }));

  reg(defineTool({
    name: 'notemap_snapshot',
    description: 'Commit a named snapshot (DuckLake-inspired) for time travel; changes() can diff snapshots.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: () => snapshotNow(),
  }));

  reg(defineTool({
    name: 'notemap_centrality',
    description: 'Degree centrality ranking — the most connected nodes in the graph.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Top N (default 20)' } },
      required: [],
    },
    execute: (args: { limit?: number }) => centrality(args?.limit),
  }));

  reg(defineTool({
    name: 'notemap_pagerank',
    description: 'PageRank approximation — authority/hub nodes by iterative propagation.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: () => pagerank(),
  }));

  reg(defineTool({
    name: 'notemap_neighbors',
    description: 'List direct neighbors (edges) of a node, direction-aware.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Node id' },
        dir: { type: 'string', enum: ['out', 'in', 'both'], description: 'Edge direction (default out)' },
        limit: { type: 'number', description: 'Max edges (default 50)' },
      },
      required: ['id'],
    },
    execute: (args: { id: string; dir?: 'out' | 'in' | 'both'; limit?: number }) => neighborsOf(args),
  }));

  reg(defineTool({
    name: 'notemap_common',
    description: 'Common neighbors of two nodes — shared context that may link otherwise distant notes.',
    parameters: {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a', 'b'],
    },
    execute: (args: { a: string; b: string }) => commonNeighbors(args),
  }));

  reg(defineTool({
    name: 'notemap_commit',
    description: 'Record the current conversation key point as a graph node (title/content/type) so the canvas accumulates the main-thread decision chain over time.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title of the key point' },
        content: { type: 'string', description: 'Facts / decisions / recovery pointers (compact)' },
        type: { type: 'string', description: 'Node type, default note' },
      },
      required: ['title'],
    },
    execute: (args: { title: string; content?: string; type?: string }) => addNote(args),
  }));

  reg(defineTool({
    name: 'notemap_recall',
    description: 'Query the graph and return matching node summaries — use instead of pasting full context; hits are compact and linked.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
    execute: (args: { query: string; limit?: number }) => {
      const local = searchWithContext({ q: args.query, limit: args.limit ?? 10 }).map((h: any) => ({
        id: h.node?.id,
        title: h.node?.title,
        type: h.node?.type,
        snippet: h.snippet,
        linked: (h.neighbors ?? []).map((nb: any) => nb.id + ' (' + nb.type + ' w' + nb.weight + ')').join(', '),
      }));
      // 兼容依赖：ACP 图可用时混入跨会话 checkpoint 命中
      const acp = acpGraphRecall(args.query, 3);
      const acpHits = acp.map((h) => ({
        id: h.node, title: h.node, type: 'acp-checkpoint',
        snippet: h.summary.slice(0, 120), linked: '[acp_graph 跨会话]',
      }));
      return [...acpHits, ...local].slice(0, args.limit ?? 10);
    },
  }));

  reg(defineTool({
    name: 'notemap_import_session',
    description: 'Scan ~/.dsh/sessions/**/session.jsonl.zstd and extract each session into the knowledge graph: session node + checkpoint nodes (ACP-compacted summaries, the real knowledge density) + user event nodes (skipping runtime-context/system noise). Dual watermark (file hash + event count) makes reruns idempotent; force re-imports everything. Uses zstd CLI when available.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max session files to import (default 30)' },
        force: { type: 'boolean', description: 'Re-import even when the file watermark matches (default false)' },
      },
      required: [],
    },
    execute: (args: { limit?: number; force?: boolean }) => {
      // 兼容依赖：ACP 图可用时从 ACP 图导入（避免重复解析 session），否则回退本地解析
      if (acpGraphAvailable()) {
        const store = getStore();
        const st = importFromAcpGraph(store, args?.force ?? false);
        return { source: 'acp_graph', entities: st.entities, checkpoints: st.checkpoints, edges: st.edges };
      }
      return importSessions({ limit: args?.limit, force: args?.force });
    },
  }));

  reg(defineTool({
    name: 'notemap_fusion',
    description: 'Multi-path retrieval with RRF fusion: FTS5 BM25 + LIKE + BFS graph expansion merged with Reciprocal Rank Fusion (k=60). Budget-capped for large graphs.',
    parameters: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 20)' },
        maxDepth: { type: 'number', description: 'BFS expansion depth (default 2)' },
        budget: { type: 'number', description: 'Per-path candidate budget (default 60)' },
      },
      required: ['q'],
    },
    execute: (args: { q: string; limit?: number; maxDepth?: number; budget?: number }) => searchFusedOf(args),
  }));

  reg(defineTool({
    name: 'notemap_filter',
    description: 'Filter nodes by a DSL over type + meta: {type: v, "meta.k": {eq|ne|gt|gte|lt|lte|in|exists}, AND/OR/NOT}. Meta matched via json_each.',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'object', description: 'Filter DSL object', additionalProperties: false, properties: {} },
        limit: { type: 'number', description: 'Max results (default 50)' },
      },
      required: ['filter'],
    },
    execute: (args: { filter: Record<string, unknown>; limit?: number }) => filterNodesOf(args),
  }));


  reg(defineTool({
    name: 'notemap_autolink',
    description: 'Auto-link nodes by lexical similarity (bigram Jaccard) so BFS retrieval can surface topically-related nodes without shared query terms. Pass ids to scope a subset.',
    parameters: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Optional subset of node ids to link' },
        minSim: { type: 'number', description: 'Min Jaccard similarity (default 0.22)' },
        maxPerNode: { type: 'number', description: 'Max semantic edges per node (default 4)' },
      },
      required: [],
    },
    execute: (args: { ids?: string[]; minSim?: number; maxPerNode?: number }) => getStore().autoLinkSemantic(args?.ids, { minSim: args?.minSim, maxPerNode: args?.maxPerNode }),
  }));

  reg(defineTool({
    name: 'notemap_remove',
    description: 'Remove a node (and its edges) from the knowledge graph.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Node id to remove' } },
      required: ['id'],
    },
    execute: (args: { id: string }) => ({ removed: removeNote(args.id) }),
  }));

  reg(defineTool({
    name: 'notemap_clear',
    description: 'Clear the whole knowledge graph (soft-delete all nodes+edges; snapshots/history kept). Requires confirm=true.',
    parameters: {
      type: 'object',
      properties: { confirm: { type: 'boolean', description: 'Must be true to actually clear' } },
      required: ['confirm'],
    },
    execute: (args: { confirm?: boolean }) => {
      if (args?.confirm !== true) return { cleared: false, reason: 'confirm=true required' };
      return { cleared: true, ...clearAll() };
    },
  }));
}

export function dispose(): void {
  try { disposeUi(); } catch { /* noop */ }
  closeStore();
}

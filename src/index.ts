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
  removeNote, clearAll,
} from './notemap.ts';

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

export async function importSessions(opts?: { limit?: number; maxLines?: number }): Promise<{
  scanned: number; sessions: number; checkpoints: number; events: number; imported: string[];
}> {
  const { execFileSync } = await import('node:child_process');
  const { readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');
  const { createHash } = await import('node:crypto');
  const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

  const root = join(homedir(), '.dsh', 'sessions');
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
  const imported: string[] = [];
  let sessions = 0, checkpoints = 0, events = 0;

  for (const f of files.slice(0, limit)) {
    let text = '';
    try {
      text = execFileSync('zstd', ['-d', '-c', f], { timeout: 20000, encoding: 'utf8', windowsHide: true });
    } catch {
      text = ''; // zstd CLI unavailable — still create the session node
    }
    const lines = text.split('\n').filter(Boolean).slice(0, maxLines);
    const base = f.split(/[\\/]/).pop() ?? f;
    const fileKey = hash(f);
    const sessId = 'sess:' + fileKey;
    let sessTitle = '';
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (ev?.type === 'session/title' && ev?.data?.title) { sessTitle = String(ev.data.title).slice(0, 60); break; }
      } catch { /* skip */ }
    }
    const title = sessTitle || 'session: ' + base.replace(/\.zstd$/, '').slice(0, 40);

    const chkNodes: string[] = [];
    const evtNodes: string[] = [];
    let chkIdx = 0, evtIdx = 0;
    for (const line of lines) {
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
        const id = 'chk:' + fileKey + ':' + chkIdx++;
        const topic = extractTopic(summary);
        await addNote({ id, title: topic || 'checkpoint ' + chkIdx, content: summary.slice(0, 800), type: 'checkpoint', meta: { file: base } });
        chkNodes.push(id);
        checkpoints++;
      } else if (c.includes('system-reminder') || c.startsWith('<') && c.includes('>')) {
        continue;
      } else if (evType === 'user/message' || evType === '') {
        const clean = cleanText(c);
        if (clean.length < 8) continue;
        const id = 'evt:' + fileKey + ':' + evtIdx++;
        await addNote({ id, title: clean.slice(0, 60), content: clean.slice(0, 600), type: 'session-event', meta: { file: base } });
        evtNodes.push(id);
        events++;
      }
    }
    if (chkNodes.length + evtNodes.length === 0) continue;

    await addNote({ id: sessId, title, content: (chkNodes.length + ' checkpoint(s), ' + evtNodes.length + ' event(s) from ' + base), type: 'session', meta: { file: base } });
    for (const id of chkNodes) await linkNotes({ source: sessId, target: id, type: 'checkpoint', weight: 1, confidence: 1 });
    for (const id of evtNodes) await linkNotes({ source: sessId, target: id, type: 'follows', weight: 0.8, confidence: 1 });
    // chain: last checkpoint -> first event (what the compressed knowledge produced)
    if (chkNodes.length && evtNodes.length) {
      await linkNotes({ source: chkNodes[chkNodes.length - 1], target: evtNodes[0], type: 'produces', weight: 0.6, confidence: 0.7 });
    }
    sessions++;
    imported.push(sessId);
  }
  return { scanned: files.length, sessions, checkpoints, events, imported };
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
    execute: (args: { query: string; limit?: number }) =>
      searchWithContext({ q: args.query, limit: args.limit ?? 10 }).map((h: any) => ({
        id: h.node?.id,
        title: h.node?.title,
        type: h.node?.type,
        snippet: h.snippet,
        linked: (h.neighbors ?? []).map((nb: any) => nb.id + ' (' + nb.type + ' w' + nb.weight + ')').join(', '),
      })),
  }));

  reg(defineTool({
    name: 'notemap_import_session',
    description: 'Scan ~/.dsh/sessions/**/session.jsonl.zstd and extract each session into the knowledge graph: session node + checkpoint nodes (ACP-compacted summaries, the real knowledge density) + user event nodes (skipping runtime-context/system noise). Deterministic ids: re-import is idempotent. Uses zstd CLI when available.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max session files to import (default 30)' },
      },
      required: [],
    },
    execute: (args: { limit?: number }) => importSessions({ limit: args?.limit }),
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

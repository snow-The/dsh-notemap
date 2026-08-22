import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  addNote, linkNotes, searchNotes, findPaths, findRelated, exportGraph,
  graphStats, snapshotNow, centrality, pagerank, neighborsOf, commonNeighbors, closeStore,
} from './notemap.ts';

export const name = 'dsh-notemap';

export function apply(ctx: { tools: { register: (def: unknown) => unknown } }): void {
  const reg = ctx.tools?.register?.bind(ctx.tools);
  if (!reg) return;

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
}

export function dispose(): void {
  closeStore();
}

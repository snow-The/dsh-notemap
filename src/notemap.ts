import { GraphStore, NodeRecord, EdgeRecord, nowIso } from './graph.ts';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------- store lifecycle ----------
let store: GraphStore | null = null;

export function getStore(dbPath?: string): GraphStore {
  if (!store) {
    const path = dbPath ?? (process.env.DSH_NOTEMAP_DB ?? join(process.env.DSH_DATA_DIR ?? join(process.env.USERPROFILE ?? '.', '.dsh'), 'notemap', 'graph.db'));
    mkdirSync(join(process.env.DSH_DATA_DIR ?? join(process.env.USERPROFILE ?? '.', '.dsh'), 'notemap'), { recursive: true });
    store = new GraphStore(path);
  }
  return store;
}

export function closeStore(): void {
  if (store) { store.close(); store = null; }
}

// ---------- tool implementations ----------
export function addNote(args: { title: string; content?: string; type?: string; id?: string; meta?: Record<string, unknown> }): NodeRecord {
  return getStore().addNode(args);
}

export function linkNotes(args: { source: string; target: string; type?: string; weight?: number; confidence?: number; meta?: Record<string, unknown> }): EdgeRecord {
  return getStore().addEdge(args);
}

export function removeNote(id: string): boolean {
  return getStore().removeNode(id);
}

export function unlinkNotes(args: { source: string; target: string; type?: string }): boolean {
  return getStore().removeEdge(args.source, args.target, args.type ?? 'related');
}

export function clearAll(): { nodes: number; edges: number } {
  return getStore().clearAll();
}

export function searchNotes(args: { q: string; limit?: number }): NodeRecord[] {
  return getStore().searchNodes(args.q, args.limit ?? 20);
}

export function searchWithContext(args: { q: string; limit?: number }) {
  return getStore().searchWithContext(args.q, args.limit ?? 10);
}

export function findPaths(args: { from: string; to: string }): string[] | null {
  return getStore().shortestPath(args.from, args.to);
}

export function findRelated(args: { id: string; limit?: number }): { node: NodeRecord; score: number }[] {
  return getStore().related(args.id, args.limit ?? 10);
}

export function exportGraph(): ReturnType<GraphStore['exportElements']> {
  return getStore().exportElements();
}

export function graphStats(): { nodes: number; edges: number; snapshots: number } {
  return getStore().stats();
}

export function snapshotNow(): { snapshot_id: number; schema_version: number; created_at: string } {
  return getStore().commitSnapshot();
}

export function centrality(limit?: number): Record<string, number> {
  return getStore().degreeCentrality(limit ?? 20);
}

export function pagerank(): Record<string, number> {
  return getStore().pageRank();
}

export function neighborsOf(args: { id: string; dir?: 'out' | 'in' | 'both'; limit?: number }): EdgeRecord[] {
  const all = getStore().neighbors(args.id, args.dir ?? 'out');
  return all.slice(0, args.limit ?? 50);
}

export function commonNeighbors(args: { a: string; b: string }): string[] {
  return getStore().commonNeighbors(args.a, args.b);
}

export function subgraphOf(args: { seed: string; maxDepth?: number; maxNodes?: number }) {
  return getStore().subgraph(args.seed, args.maxDepth ?? 2, args.maxNodes ?? 50);
}

export function searchVector(args: { q: string; topK?: number; type?: string }): { node: NodeRecord; score: number }[] {
  return getStore().searchVector(args.q, { topK: args.topK, type: args.type });
}

export function setProvider(provider: import('./graph.ts').EmbeddingProvider | null): void {
  getStore().setEmbeddingProvider(provider);
}

export function embedAll(batchSize?: number): number {
  return getStore().embedAll(batchSize ?? 64);
}

export function labelsOf(args: { prefix?: string; popular?: boolean; limit?: number }) {
  if (args.popular) return getStore().popularLabels(args.limit ?? 20);
  return getStore().searchLabels(args.prefix ?? '', args.limit ?? 20);
}

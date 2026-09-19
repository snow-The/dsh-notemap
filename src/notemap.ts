import { GraphStore, nowIso } from './graph.ts';
import type { NodeRecord, EdgeRecord } from './graph.ts';
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
/**
 * Where a node came from. PMPA (arXiv 2609.13889) showed that on a harness-based agent the WRITE path
 * is the only control point — a read-side filter cannot undo a poisoned memory (C-ASR 96.7 -> 96.7).
 * The vocabulary is deliberately small:
 *   agent_authored  — an explicit tool call (notemap_add / notemap_commit)
 *   session_derived — written by an automatic importer (session logs, ACP graph, handoff network)
 *   external_source — the caller DECLARES that the content came from outside the session (fetched
 *                     page, pasted document). This does not gate anything by itself; it makes the
 *                     channel visible and filterable, which is what a gate would need to key on.
 */
export type Provenance = 'agent_authored' | 'session_derived' | 'external_source';

export function addNote(args: { title: string; content?: string; type?: string; id?: string; meta?: Record<string, unknown>; provenance?: Provenance }): NodeRecord {
  const meta = { ...(args.meta ?? {}) };
  if (meta.provenance == null) meta.provenance = args.provenance ?? 'agent_authored';
  return getStore().addNode({ ...args, meta });
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

/**
 * The list envelope. A consumer must be able to tell \u300cnone\u300d from \u300cnot found\u300d from \u300ccut\u300d —
 * today all three are an empty or shortened array with nothing to say which (proposal G).
 */
export interface ListEnvelope<T> { items: T[]; total: number; returned: number; truncated: boolean; unknown_id: string | null }

/** Slice to the budget and report what was left out. `unknownId` names the handle that did not resolve. */
export function envelopeOf<T>(all: T[], limit: number, unknownId: string | null = null): ListEnvelope<T> {
  const items = all.slice(0, Math.max(0, Math.floor(limit)));
  return { items, total: all.length, returned: items.length, truncated: all.length > items.length, unknown_id: unknownId };
}

/** The id that does not resolve, or null when every handle exists. */
function missingId(...ids: string[]): string | null {
  for (const id of ids) if (getStore().getNode(id) == null) return id;
  return null;
}

/** Envelope cap: larger than any realistic full set here, so `total` is the true size. */
const TOTAL_CAP = 10000;

export function searchNotes(args: { q: string; limit?: number }): ListEnvelope<NodeRecord> {
  return envelopeOf(getStore().searchNodes(args.q, TOTAL_CAP), args.limit ?? 20);
}

export function searchWithContext(args: { q: string; limit?: number }) {
  return getStore().searchWithContext(args.q, args.limit ?? 10);
}

export function findPaths(args: { from: string; to: string }): ListEnvelope<string> {
  // Bitemporal shortest path, `[]` when no route exists; the envelope says whether an endpoint was
  // the reason (`unknown_id`), which an empty array never could.
  return envelopeOf(getStore().shortestPath(args.from, args.to) ?? [], TOTAL_CAP, missingId(args.from, args.to));
}

export function findRelated(args: { id: string; limit?: number }): ListEnvelope<{ node: NodeRecord; score: number }> {
  return envelopeOf(getStore().related(args.id, TOTAL_CAP), args.limit ?? 10, missingId(args.id));
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

export function neighborsOf(args: { id: string; dir?: 'out' | 'in' | 'both'; limit?: number }): ListEnvelope<EdgeRecord> {
  const all = getStore().neighbors(args.id, args.dir ?? 'out');
  // Rank BEFORE cutting: 'first 50' is an arbitrary slice, 'top 50 by weight*confidence' is a budget.
  all.sort((a, b) => (b.weight * b.confidence) - (a.weight * a.confidence));
  return envelopeOf(all, args.limit ?? 50, missingId(args.id));
}

export function commonNeighbors(args: { a: string; b: string }): ListEnvelope<string> {
  return envelopeOf(getStore().commonNeighbors(args.a, args.b), TOTAL_CAP, missingId(args.a, args.b));
}

export function subgraphOf(args: { seed: string; maxDepth?: number; maxNodes?: number }) {
  return getStore().subgraph(args.seed, args.maxDepth ?? 2, args.maxNodes ?? 50);
}

/**
 * Turn a handle (id OR title) into a node - or into an honest refusal plus the choices.
 * The traversal tools (neighbors/related/context/paths) take IDs only and report `unknown_id` for
 * anything else; this is the one place that also accepts a title, and it never guesses.
 */
export function resolveNode(args: { handle: string; limit?: number }) {
  return getStore().resolveHandle(args.handle, args.limit ?? 10);
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

/**
 * Which mode a labels call means. Pure, so the DEFAULT is a tested decision and not a side effect
 * of the argument parsing.
 *
 * No argument at all is the call that carries the tool's promise ("what does this graph know?"),
 * so it answers with the degree ranking. It used to fall through to `searchLabels('')`, which
 * returns [] by design — a confident "this graph knows nothing" on a 4,919-node graph, with
 * nothing in the result to say otherwise. The empty guard is right; the default was wrong.
 */
export function labelsPlan(args: { prefix?: string; popular?: boolean }): 'popular' | 'substring' {
  const askedNothing = args.prefix === undefined && args.popular === undefined;
  return args.popular || askedNothing ? 'popular' : 'substring';
}

export function labelsOf(args: { prefix?: string; popular?: boolean; limit?: number }): ListEnvelope<{ title: string; degree: number }> {
  const limit = args.limit ?? 20;
  const all = labelsPlan(args) === 'popular'
    ? getStore().popularLabels(TOTAL_CAP)
    : getStore().searchLabels(String(args.prefix ?? '').trim(), TOTAL_CAP);
  return envelopeOf(all, limit);
}

export function searchFusedOf(args: { q: string; limit?: number; maxDepth?: number; budget?: number }): ListEnvelope<{ node: NodeRecord; score: number }> {
  const all = getStore().searchFused(args.q, { limit: TOTAL_CAP, maxDepth: args.maxDepth, budget: args.budget });
  return envelopeOf(all, args.limit ?? 20);
}

export function filterNodesOf(args: { filter: Record<string, unknown>; limit?: number }): ListEnvelope<NodeRecord> {
  return envelopeOf(getStore().filterNodes(args.filter ?? {}, TOTAL_CAP), args.limit ?? 50);
}

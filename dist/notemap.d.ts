import { GraphStore } from './graph.ts';
import type { NodeRecord, EdgeRecord } from './graph.ts';
export declare function getStore(dbPath?: string): GraphStore;
export declare function closeStore(): void;
export declare function addNote(args: {
    title: string;
    content?: string;
    type?: string;
    id?: string;
    meta?: Record<string, unknown>;
}): NodeRecord;
export declare function linkNotes(args: {
    source: string;
    target: string;
    type?: string;
    weight?: number;
    confidence?: number;
    meta?: Record<string, unknown>;
}): EdgeRecord;
export declare function removeNote(id: string): boolean;
export declare function unlinkNotes(args: {
    source: string;
    target: string;
    type?: string;
}): boolean;
export declare function clearAll(): {
    nodes: number;
    edges: number;
};
export declare function searchNotes(args: {
    q: string;
    limit?: number;
}): NodeRecord[];
export declare function searchWithContext(args: {
    q: string;
    limit?: number;
}): {
    node: NodeRecord;
    neighbors: {
        id: string;
        type: string;
        weight: number;
    }[];
    snippet: string;
}[];
export declare function findPaths(args: {
    from: string;
    to: string;
}): string[];
export declare function findRelated(args: {
    id: string;
    limit?: number;
}): {
    node: NodeRecord;
    score: number;
}[];
export declare function exportGraph(): ReturnType<GraphStore['exportElements']>;
export declare function graphStats(): {
    nodes: number;
    edges: number;
    snapshots: number;
};
export declare function snapshotNow(): {
    snapshot_id: number;
    schema_version: number;
    created_at: string;
};
export declare function centrality(limit?: number): Record<string, number>;
export declare function pagerank(): Record<string, number>;
export declare function neighborsOf(args: {
    id: string;
    dir?: 'out' | 'in' | 'both';
    limit?: number;
}): EdgeRecord[];
export declare function commonNeighbors(args: {
    a: string;
    b: string;
}): string[];
export declare function subgraphOf(args: {
    seed: string;
    maxDepth?: number;
    maxNodes?: number;
}): {
    nodes: NodeRecord[];
    edges: EdgeRecord[];
    seedFound: boolean;
};
export declare function searchVector(args: {
    q: string;
    topK?: number;
    type?: string;
}): {
    node: NodeRecord;
    score: number;
}[];
export declare function setProvider(provider: import('./graph.ts').EmbeddingProvider | null): void;
export declare function embedAll(batchSize?: number): number;
/**
 * Which mode a labels call means. Pure, so the DEFAULT is a tested decision and not a side effect
 * of the argument parsing.
 *
 * No argument at all is the call that carries the tool's promise ("what does this graph know?"),
 * so it answers with the degree ranking. It used to fall through to `searchLabels('')`, which
 * returns [] by design — a confident "this graph knows nothing" on a 4,919-node graph, with
 * nothing in the result to say otherwise. The empty guard is right; the default was wrong.
 */
export declare function labelsPlan(args: {
    prefix?: string;
    popular?: boolean;
}): 'popular' | 'substring';
export declare function labelsOf(args: {
    prefix?: string;
    popular?: boolean;
    limit?: number;
}): {
    title: string;
    degree: number;
}[];
export declare function searchFusedOf(args: {
    q: string;
    limit?: number;
    maxDepth?: number;
    budget?: number;
}): {
    node: NodeRecord;
    score: number;
}[];
export declare function filterNodesOf(args: {
    filter: Record<string, unknown>;
    limit?: number;
}): NodeRecord[];

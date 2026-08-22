import { GraphStore, NodeRecord, EdgeRecord } from './graph.ts';
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
export declare function searchNotes(args: {
    q: string;
    limit?: number;
}): NodeRecord[];
export declare function findPaths(args: {
    from: string;
    to: string;
}): string[] | null;
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

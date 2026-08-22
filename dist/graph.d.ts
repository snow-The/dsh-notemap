export interface NodeRecord {
    id: string;
    type: string;
    title: string;
    content: string;
    embedding: Float32Array | null;
    meta: Record<string, unknown>;
    created_at: string;
    updated_at: string;
}
export interface EdgeRecord {
    source: string;
    target: string;
    type: string;
    weight: number;
    confidence: number;
    meta: Record<string, unknown>;
    created_at: string;
}
export interface SnapshotInfo {
    snapshot_id: number;
    schema_version: number;
    created_at: string;
}
export interface PathStep {
    node: string;
    via?: string;
    weight: number;
}
export declare function nowIso(): string;
/**
 * Networked knowledge graph backed by node:sqlite (WAL + withTx).
 * DuckLake-inspired: snapshot table + change stream for time travel & audit.
 */
export declare class GraphStore {
    private db;
    constructor(dbPath: string);
    private migrate;
    close(): void;
    /** Run fn inside an IMMEDIATE transaction; rollback on throw. */
    withTx<T>(fn: () => T): T;
    addNode(opts: {
        id?: string;
        type?: string;
        title: string;
        content?: string;
        embedding?: Float32Array | null;
        meta?: Record<string, unknown>;
    }): NodeRecord;
    getNode(id: string): NodeRecord | null;
    private rowToNode;
    updateNode(id: string, patch: {
        title?: string;
        content?: string;
        embedding?: Float32Array | null;
        meta?: Record<string, unknown>;
    }): NodeRecord | null;
    removeNode(id: string): boolean;
    listNodes(limit?: number, offset?: number): NodeRecord[];
    searchNodes(q: string, limit?: number): NodeRecord[];
    addEdge(opts: {
        source: string;
        target: string;
        type?: string;
        weight?: number;
        confidence?: number;
        meta?: Record<string, unknown>;
    }): EdgeRecord;
    getEdge(source: string, target: string, type?: string): EdgeRecord | null;
    private rowToEdge;
    removeEdge(source: string, target: string, type?: string): boolean;
    neighbors(id: string, dir?: 'out' | 'in' | 'both'): EdgeRecord[];
    /** Commit a snapshot capturing current graph state + change stream tail. */
    commitSnapshot(opts?: {
        note?: string;
    }): SnapshotInfo;
    listSnapshots(limit?: number): SnapshotInfo[];
    /** Changes between two snapshots (like DuckLake table_changes(from,to)). */
    tableChanges(from: number, to: number): {
        table_name: string;
        op: string;
        key: string;
        data: Record<string, unknown>;
        created_at: string;
    }[];
    /** BFS from a node; returns visited node ids in discovery order. */
    bfs(start: string, maxDepth?: number): string[];
    /** DFS from a node; returns visited node ids in discovery order. */
    dfs(start: string, maxDepth?: number): string[];
    /** Dijkstra shortest paths from start; returns map node -> { dist, prev }. */
    dijkstra(start: string): Record<string, {
        dist: number;
        prev: string | null;
    }>;
    /** Shortest path as ordered node list (via Dijkstra). */
    shortestPath(from: string, to: string): string[] | null;
    /** Common neighbors of two nodes (any direction). */
    commonNeighbors(a: string, b: string): string[];
    /** Degree centrality: normalized node count of connections (in+out). */
    degreeCentrality(limit?: number): Record<string, number>;
    /** PageRank approximation (power iteration, undirected edge weights as transitions). */
    pageRank(iterations?: number, damping?: number): Record<string, number>;
    /** Related nodes by weight + confidence + shared neighbors. */
    related(id: string, limit?: number): {
        node: NodeRecord;
        score: number;
    }[];
    /** cytoscape.js-compatible elements JSON. */
    exportElements(): {
        nodes: {
            data: {
                id: string;
                label: string;
                type: string;
            };
        }[];
        edges: {
            data: {
                id: string;
                source: string;
                target: string;
                label: string;
                weight: number;
            };
        }[];
    };
    stats(): {
        nodes: number;
        edges: number;
        snapshots: number;
    };
}

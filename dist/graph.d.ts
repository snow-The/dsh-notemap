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
    updated_at: string;
    /** Bitemporal (light, Graphiti-inspired): when the fact became valid / was invalidated. */
    valid_at: string;
    invalid_at: string | null;
}
/**
 * Optional semantic layer (LightRAG deferred vector indexing / mem0 EmbeddingBase).
 * Plug in any embedding provider; nothing else changes. When absent, keyword
 * (FTS5) retrieval still works — vectors are an optional upgrade.
 */
export interface EmbeddingProvider {
    readonly dim: number;
    /** Embed a batch of texts into float32 vectors (same order). */
    embed(texts: string[]): Float32Array[];
    /** Optional model label for stats/debug. */
    label?: string;
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
/** Normalization contract (LightRAG insert_custom_kg): trim + collapse whitespace + case fold. */
export declare function normalizeName(s: string): string;
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
    /** Soft-delete every node and edge — resets the working graph while keeping snapshots/changes history. */
    clearAll(): {
        nodes: number;
        edges: number;
    };
    listNodes(limit?: number, offset?: number): NodeRecord[];
    searchNodes(q: string, limit?: number): NodeRecord[];
    /** SQL-side processed recall: each hit comes back with its connected neighborhood
     *  aggregated in one query (JSON array of related nodes + edge weights) and a
     *  compact snippet around the best-matching term — a ready-to-read knowledge pack. */
    searchWithContext(q: string, limit?: number): {
        node: NodeRecord;
        neighbors: {
            id: string;
            type: string;
            weight: number;
        }[];
        snippet: string;
    }[];
    addEdge(opts: {
        source: string;
        target: string;
        type?: string;
        weight?: number;
        confidence?: number;
        meta?: Record<string, unknown>;
        version?: boolean;
    }): EdgeRecord;
    /** Full edge history for a pair (bitemporal timeline, newest first). */
    edgeHistory(source: string, target: string, type?: string): EdgeRecord[];
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
    /** Degree centrality from the degree cache (in+out, O(1) per node). */
    degreeCentrality(limit?: number): Record<string, number>;
    /** Cached degree of a node (falls back to a live count when uncached). */
    degreeOf(id: string): number;
    /** PageRank approximation (power iteration, undirected edge weights as transitions). */
    pageRank(iterations?: number, damping?: number): Record<string, number>;
    /** Related nodes by weight + confidence + degree signal (LightRAG rank=(edge_degree, weight)). */
    related(id: string, limit?: number): {
        node: NodeRecord;
        score: number;
    }[];
    /**
     * Multi-path retrieval with Reciprocal Rank Fusion (Graphiti-style):
     * candidates from FTS5 BM25, LIKE fallback, and graph BFS expansion are
     * merged with RRF (k=60). Budgets cap per-path candidates and BFS depth so
     * large graphs stay responsive.
     */
    searchFused(q: string, opts?: {
        limit?: number;
        maxDepth?: number;
        budget?: number;
        rrfK?: number;
    }): {
        node: NodeRecord;
        score: number;
    }[];
    /**
     * Filter nodes by a DSL over type + meta. Operators: eq, ne, gt, gte, lt,
     * lte, in, exists, and logical AND/OR/NOT. Meta values are matched with
     * json_each so nested keys like "meta.kind" work.
     */
    filterNodes(filter: Record<string, unknown>, limit?: number): NodeRecord[];
    /** cytoscape.js-compatible elements JSON. */
    autoLinkSemantic(ids?: string[], opts?: {
        minSim?: number;
        maxPerNode?: number;
        type?: string;
    }): {
        edges: number;
        pairs: number;
    };
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
    private provider;
    /** Register an embedding provider. Null clears it. */
    setEmbeddingProvider(provider: EmbeddingProvider | null): void;
    getEmbeddingProvider(): EmbeddingProvider | null;
    /** Vector similarity search (cosine over stored embeddings). Requires a provider. */
    searchVector(query: string, opts?: {
        topK?: number;
        type?: string;
    }): {
        node: NodeRecord;
        score: number;
    }[];
    /** Batch-embed all nodes missing an embedding (deferred vector indexing). */
    embedAll(batchSize?: number): number;
    upsertNodesBatch(nodes: {
        id?: string;
        type?: string;
        title: string;
        content?: string;
        embedding?: Float32Array | null;
        meta?: Record<string, unknown>;
    }[]): number;
    upsertEdgesBatch(edges: {
        source: string;
        target: string;
        type?: string;
        weight?: number;
        confidence?: number;
        meta?: Record<string, unknown>;
    }[]): number;
    /**
     * The subgraph around one seed, with {@link seedFound} saying whether the seed resolved.
     *
     * An unresolved seed used to be indistinguishable from a resolved one with no neighbours: both
     * returned `{ nodes: [], edges: [] }`. `seed` is an ID, and a caller who passes a TITLE — which
     * `notemap_search` will happily hand back, since it matches titles — got a confident empty answer
     * with nothing in it to say the lookup had failed. Both results are legitimate; only one of them
     * answers the question that was asked, and before this flag the caller could not tell which.
     *
     * A flag rather than an `error`: an unknown seed is a valid answer to "what is around this node",
     * not a failure, and reusing the error channel for it would make every caller's error handling
     * wrong in the same direction.
     */
    subgraph(seed: string, maxDepth?: number, maxNodes?: number): {
        nodes: NodeRecord[];
        edges: EdgeRecord[];
        seedFound: boolean;
    };
    /**
     * Substring match over titles, in the SAME shape as {@link popularLabels}.
     *
     * It used to return bare strings while popularLabels returned `{title, degree}` records: one
     * tool, two output types. The declared schema can describe only one of them, so every non-empty
     * prefix failed output validation (`"value[0]" must be an object`) while the popular branch
     * passed. The match is a substring (`LIKE '%q%'`) — that is what the description now says. An
     * empty query still returns [] instead of scanning the table; callers who want "everything" ask
     * for the degree ranking, which is also what the tool's default call now does.
     */
    searchLabels(prefix: string, limit?: number): {
        title: string;
        degree: number;
    }[];
    popularLabels(limit?: number): {
        title: string;
        degree: number;
    }[];
    stats(): {
        nodes: number;
        edges: number;
        snapshots: number;
    };
}

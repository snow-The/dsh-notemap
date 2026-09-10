/**
 * dsh-notemap — the shared graph-relation algorithm (relation layer).
 *
 * Owner of this layer: notemap. It consumes what handoff COLLECTS (the graph plus
 * provenance: sources / mentions / aliases / delegations) and what memory PROCESSES
 * (the seven layers), and turns those linear structures into a ranked network.
 *
 * Pipeline (see SHARED-GRAPH.md §3):
 *   1  candidates          - text search, done by the caller (FTS5 / like / vector)
 *   2  per-source ranking  - each session/agent ranks the candidates it knows
 *   3  fusion              - reciprocal rank fusion across those lists
 *   4  consensus boost     - x (1 + ln(1 + distinct sources)): agreement across agents
 *   5  confidence          - beta prior over mentions (samples = mentions)
 *   6  expansion           - weighted BFS with hop decay
 *   7  authority           - PageRank over the whole network
 *   8  agent scope         - handled by the caller via the delegation tree
 *   9  provenance          - every result carries the sources that voted for it
 *
 * Every function here is pure: no DB, no DSH, no I/O. That keeps the algorithm
 * testable and lets both plugins share one implementation instead of two opinions.
 */

/** Reciprocal rank fusion over per-source ranked id lists (rank-only, so scores need not be comparable). */
export function reciprocalRankFusion(
  lists: readonly (readonly string[])[],
  options: { k?: number; maxPerList?: number } = {},
): Map<string, { score: number; sources: number[]; ranks: number[] }> {
  const k = options.k ?? 60;
  const maxPerList = options.maxPerList ?? Infinity;
  const fused = new Map<string, { score: number; sources: number[]; ranks: number[] }>();
  lists.forEach((list, sourceIndex) => {
    const seen = new Set<string>();
    list.slice(0, maxPerList === Infinity ? undefined : maxPerList).forEach((id, rank) => {
      if (id === undefined || seen.has(id)) return;   // a source votes once per id
      seen.add(id);
      const entry = fused.get(id) ?? { score: 0, sources: [], ranks: [] };
      entry.score += 1 / (k + rank + 1);
      entry.sources.push(sourceIndex);
      entry.ranks.push(rank);
      fused.set(id, entry);
    });
  });
  return fused;
}

/** Consensus across distinct sources: agreement between agents is worth more than volume from one. */
export function consensusBoost(sourceCount: number): number {
  return 1 + Math.log(1 + Math.max(0, sourceCount));
}

/** Beta-prior confidence from a mention count (prior 0.5, pseudo-count weight 100 by default). */
export function betaConfidence(samples: number, prior = 0.5, weight = 100): number {
  if (!Number.isFinite(samples) || samples <= 0) return prior;
  return (prior * weight + samples) / (weight + samples);
}

/** Exponential recency decay: 1 at \`now\`, 0.5 after one half-life. */
export function recencyDecay(lastSeenMs: number, nowMs = Date.now(), halfLifeMs = 30 * 24 * 3600 * 1000): number {
  if (!Number.isFinite(lastSeenMs) || lastSeenMs <= 0) return 0.5;
  const age = Math.max(0, nowMs - lastSeenMs);
  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return 1;
  return Math.pow(0.5, age / halfLifeMs);
}

/**
 * Weighted BFS expansion from a set of seeds.
 * @returns id -> { score, hop, via } where score = seed weight x hopDecay^hop x edge weight.
 */
export function expandByBfs(
  seeds: Iterable<readonly [string, number]>,
  neighborsOf: (id: string) => readonly { id: string; weight?: number }[],
  options: { depth?: number; hopDecay?: number; limit?: number } = {},
): Map<string, { score: number; hop: number; via: string | null }> {
  const depth = options.depth ?? 2;
  const hopDecay = options.hopDecay ?? 0.5;
  const limit = options.limit ?? 500;
  const visited = new Map<string, { score: number; hop: number; via: string | null }>();
  let frontier: { id: string; score: number; hop: number; via: string | null }[] = [];
  for (const [id, score] of seeds) {
    if (visited.has(id)) continue;
    const entry = { score, hop: 0, via: null };
    visited.set(id, entry);
    frontier.push({ id, score, hop: 0, via: null });
  }
  while (frontier.length > 0 && visited.size < limit) {
    const next: typeof frontier = [];
    for (const node of frontier) {
      if (node.hop >= depth) continue;
      for (const edge of neighborsOf(node.id)) {
        if (edge?.id === undefined) continue;
        const weight = Number.isFinite(edge.weight) ? Number(edge.weight) : 1;
        const score = node.score * hopDecay * weight;
        const current = visited.get(edge.id);
        if (current !== undefined && current.score >= score) continue;
        const entry = { score, hop: node.hop + 1, via: node.id };
        visited.set(edge.id, entry);
        next.push({ id: edge.id, score, hop: node.hop + 1, via: node.id });
      }
    }
    frontier = next;
  }
  return visited;
}

/** PageRank over a weighted graph; returns a normalised authority score per node. */
export function pageRank(
  ids: readonly string[],
  outEdges: (id: string) => readonly { id: string; weight?: number }[],
  options: { damping?: number; iterations?: number; tolerance?: number } = {},
): Map<string, number> {
  const damping = options.damping ?? 0.85;
  const iterations = options.iterations ?? 30;
  const tolerance = options.tolerance ?? 1e-6;
  const n = ids.length;
  const rank = new Map<string, number>();
  if (n === 0) return rank;
  for (const id of ids) rank.set(id, 1 / n);
  for (let step = 0; step < iterations; step++) {
    const next = new Map<string, number>();
    for (const id of ids) next.set(id, (1 - damping) / n);
    let dangling = 0;
    for (const id of ids) {
      const outs = outEdges(id).filter((e) => e?.id !== undefined && ids.includes(e.id));
      const total = outs.reduce((sum, e) => sum + (Number.isFinite(e.weight) ? Number(e.weight) : 1), 0);
      const share = rank.get(id) ?? 0;
      if (total <= 0) { dangling += share; continue; }
      for (const edge of outs) {
        const weight = Number.isFinite(edge.weight) ? Number(edge.weight) : 1;
        next.set(edge.id, (next.get(edge.id) ?? 0) + damping * share * (weight / total));
      }
    }
    for (const id of ids) next.set(id, (next.get(id) ?? 0) + damping * dangling / n);
    let delta = 0;
    for (const id of ids) delta += Math.abs((next.get(id) ?? 0) - (rank.get(id) ?? 0));
    for (const id of ids) rank.set(id, next.get(id) ?? 0);
    if (delta < tolerance) break;
  }
  return rank;
}

/**
 * The composed ranking used by recall: fuse per-source lists, boost consensus,
 * multiply by confidence and recency. Pure - the caller supplies the numbers.
 */
export function rankAcrossSources(
  candidatesBySource: readonly (readonly string[])[],
  options: {
    k?: number;
    prior?: number;
    now?: number;
    halfLifeMs?: number;
    mentionsOf?: (id: string) => number;
    lastSeenOf?: (id: string) => number;
    limit?: number;
  } = {},
): { id: string; score: number; sources: number[]; confidence: number; recency: number; consensus: number }[] {
  const fused = reciprocalRankFusion(candidatesBySource, { k: options.k ?? 60 });
  const now = options.now ?? Date.now();
  const rows = [...fused.entries()].map(([id, entry]) => {
    const mentions = options.mentionsOf?.(id) ?? 0;
    const confidence = betaConfidence(mentions, options.prior ?? 0.5);
    const recency = recencyDecay(options.lastSeenOf?.(id) ?? 0, now, options.halfLifeMs ?? 30 * 24 * 3600 * 1000);
    const consensus = consensusBoost(new Set(entry.sources).size);
    return { id, score: entry.score * consensus * confidence * recency, sources: [...new Set(entry.sources)], confidence, recency, consensus };
  });
  rows.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return options.limit === undefined ? rows : rows.slice(0, options.limit);
}

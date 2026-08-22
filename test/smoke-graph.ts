import { GraphStore } from '../src/graph.ts';
import { strict as assert } from 'node:assert';

const store = new GraphStore(':memory:');

// node CRUD
const a = store.addNode({ title: 'DeepSeek', type: 'company', content: 'AI lab' });
const b = store.addNode({ title: 'Hugging Face', type: 'company', content: 'ML hub' });
const c = store.addNode({ title: 'Transformers', type: 'concept', content: 'model architecture' });
const d = store.addNode({ title: 'NotebookLM', type: 'product', content: 'Google notebook' });
assert.equal(store.getNode(a.id)!.title, 'DeepSeek');
assert.equal(store.listNodes().length, 4);

// edges with quantified relations
store.addEdge({ source: a.id, target: b.id, type: 'competes', weight: 0.8, confidence: 0.9 });
store.addEdge({ source: b.id, target: c.id, type: 'uses', weight: 0.7, confidence: 1.0 });
store.addEdge({ source: a.id, target: c.id, type: 'uses', weight: 0.9, confidence: 1.0 });
store.addEdge({ source: c.id, target: d.id, type: 'inspires', weight: 0.4, confidence: 0.6 });
assert.equal(store.getEdge(a.id, b.id, 'competes')!.weight, 0.8);

// BFS / DFS
const bfs = store.bfs(a.id);
assert.ok(bfs.includes(b.id) && bfs.includes(c.id));
const dfs = store.dfs(a.id);
assert.ok(dfs.includes(c.id));

// Dijkstra shortest path: a -> d via c
const path = store.shortestPath(a.id, d.id);
assert.ok(path, 'path exists');
assert.equal(path![0], a.id);
assert.equal(path![path!.length - 1], d.id);
assert.ok(path!.includes(c.id), 'goes through transformers');

// common neighbors
const common = store.commonNeighbors(a.id, b.id);
assert.ok(common.includes(c.id), 'a and b share c');

// centrality
const cent = store.degreeCentrality();
assert.equal(cent[c.id], 3, 'c has 3 connections (a,b,d)');

// pageRank
const pr = store.pageRank(10);
assert.ok(pr[a.id] > 0 && pr[c.id] > 0);

// related
const rel = store.related(b.id);
assert.equal(rel[0].node.id, a.id, 'b most related to a (0.72 > 0.70)');
assert.equal(rel[1].node.id, c.id, 'c second via uses edge');

// snapshots + changes
const s1 = store.commitSnapshot();
store.addNode({ title: 'New Note' });
const s2 = store.commitSnapshot();
const changes = store.tableChanges(s1.snapshot_id, s2.snapshot_id);
assert.ok(changes.some(ch => ch.table_name === 'nodes' && ch.op === 'upsert'), 'change stream captured new node');
assert.equal(store.listSnapshots().length, 2);

// export (cytoscape-compatible)
const els = store.exportElements();
assert.ok(els.nodes.length >= 5);
assert.ok(els.edges.length === 4);

// stats
const stats = store.stats();
assert.equal(stats.nodes, 5);
assert.equal(stats.edges, 4);

// search
const found = store.searchNodes('transformers');
assert.equal(found.length, 1);
assert.equal(found[0].id, c.id);

store.close();
console.log('ALL SMOKE TESTS PASSED');

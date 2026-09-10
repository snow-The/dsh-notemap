import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reciprocalRankFusion, consensusBoost, betaConfidence, recencyDecay, expandByBfs, pageRank, rankAcrossSources } from '../src/relations.ts';

test('RRF rewards agreement: two sources beat one', () => {
  const fused = reciprocalRankFusion([['a', 'b'], ['a', 'c']]);
  assert.ok(fused.get('a').score > fused.get('b').score);
  assert.equal(fused.get('a').sources.length, 2);
  assert.equal(fused.get('b').sources.length, 1);
});

test('a source votes once per id even if it repeats it', () => {
  const fused = reciprocalRankFusion([['a', 'a', 'a']]);
  assert.equal(fused.get('a').sources.length, 1);
  assert.equal(fused.get('a').score, 1 / 61);
});

test('consensus boost is monotone and grows with the log', () => {
  assert.equal(consensusBoost(0), 1);
  assert.ok(consensusBoost(2) > consensusBoost(1));
  assert.ok(consensusBoost(10) < 1 + Math.log(11) + 1e-9);
});

test('beta confidence starts at the prior and rises with samples', () => {
  assert.equal(betaConfidence(0), 0.5);
  const few = betaConfidence(10);
  const many = betaConfidence(1000);
  assert.ok(few > 0.5 && many > few && many < 1);
});

test('recency decay halves after one half-life', () => {
  const now = 1_000_000_000_000;
  const half = 30 * 24 * 3600 * 1000;
  assert.ok(Math.abs(recencyDecay(now, now, half) - 1) < 1e-9);
  assert.ok(Math.abs(recencyDecay(now - half, now, half) - 0.5) < 1e-9);
});

test('BFS decays per hop and keeps the strongest path', () => {
  const graph = new Map([['a', [{ id: 'b', weight: 1 }]], ['b', [{ id: 'c', weight: 1 }]], ['c', []]]);
  const out = expandByBfs([['a', 1]], (id) => graph.get(id) ?? [], { depth: 2, hopDecay: 0.5 });
  assert.equal(out.get('a').score, 1);
  assert.equal(out.get('b').score, 0.5);
  assert.equal(out.get('c').score, 0.25);
  assert.equal(out.get('c').via, 'b');
});

test('PageRank ranks a node with more inbound links higher', () => {
  const ids = ['a', 'b', 'c'];
  const edges = new Map([['a', [{ id: 'c' }]], ['b', [{ id: 'c' }]], ['c', [{ id: 'a' }]]]);
  const rank = pageRank(ids, (id) => edges.get(id) ?? []);
  assert.ok(rank.get('c') > rank.get('b'), JSON.stringify([...rank]));
});

test('the composed ranking applies consensus, confidence and recency', () => {
  const rows = rankAcrossSources([['x', 'y'], ['x', 'z']], {
    mentionsOf: (id) => (id === 'y' ? 500 : 5),
    lastSeenOf: () => Date.now(),
    now: Date.now(),
  });
  const x = rows.find((r) => r.id === 'x');
  const y = rows.find((r) => r.id === 'y');
  assert.ok(x.sources.length === 2 && y.sources.length === 1);
  assert.ok(x.score > 0 && y.score > 0);
  assert.ok(rows[0].id === 'x', 'cross-source consensus wins by default');
});

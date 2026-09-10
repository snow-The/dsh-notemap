import { buildNetwork, agentTree, consensusRecall } from '../src/network.ts';
const stats = buildNetwork();
const tree = agentTree();
const hits = consensusRecall('dsh', { limit: 8 });
console.log(JSON.stringify({
  stats,
  tree: { total: tree.length, top: tree.slice(0, 4).map((r) => ({ id: r.session_id.slice(0, 20), kind: r.agent_kind, entities: r.entities, mentions: r.mentions, children: r.children.length })) },
  consensus: hits.slice(0, 6).map((h) => ({ title: h.title.slice(0, 28), sources: h.sources, kinds: h.agent_kinds, mentions: h.mentions, score: Number(h.score.toFixed(4)) })),
}, null, 1));

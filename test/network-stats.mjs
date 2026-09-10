import { buildNetwork, agentTree } from '../src/network.ts';
const s = buildNetwork();
const t = agentTree();
console.log(JSON.stringify({ stats: s, tree_total: t.length, tree_top: t.slice(0, 3).map((r) => ({ id: r.session_id.slice(0, 24), kind: r.agent_kind, entities: r.entities, mentions: r.mentions, cp: r.checkpoints, kids: r.children.length })) }, null, 1));

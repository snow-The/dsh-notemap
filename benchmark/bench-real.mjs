// 真实数据跑分:THUCNews(星座/彩票/时尚,5725 条)
// 对比 searchNodes vs searchFused,autoLinkSemantic 建边前后
import { readFileSync } from 'node:fs';
import { GraphStore } from '../src/graph.ts';

const rows = readFileSync(new URL('./data/thucnews-real.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l));
console.log('rows:', rows.length, 'labels:', JSON.stringify([...new Set(rows.map(r => r.label))]));

let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const store = new GraphStore(':memory:');
const t0 = Date.now();
rows.forEach((r, i) => store.addNode({ id: 'n' + i, type: 'news', title: r.title, content: r.content, meta: { label: r.label } }));
console.log('build', rows.length, 'nodes:', (Date.now() - t0) + 'ms');

const byLabel = {};
for (const r of rows) (byLabel[r.label] ||= []).push(r);
const QUERIES = 240;
const queries = [];
for (let i = 0; i < QUERIES; i++) {
  const r = pick(rows);
  // 短查询:title 前 4-14 字(真实用户搜索形态),取中间段避免整 title 词面
  const t = r.title;
  const q = t.slice(Math.floor(rnd() * Math.max(0, t.length - 14)), Math.min(t.length, 4 + Math.floor(rnd() * 11)));
  const same = byLabel[r.label].filter(x => x !== r);
  const gts = [r];
  for (let k = 0; k < 9 && same.length; k++) gts.push(same.splice(Math.floor(rnd() * same.length), 1)[0]);
  queries.push({ q, gt: new Set(gts.map(x => x.title)) });
}
let overlap = 0;
for (const { q, gt } of queries) {
  const g = [...gt];
  if (g.some(t => [...q].some((_, i) => i + 4 <= q.length && t.includes(q.slice(i, i + 4))))) overlap++;
}
console.log('queries with >=1 4-char overlap into gt titles:', overlap + '/' + QUERIES);

function evalQ(mode, edges) {
  const hit = { at1: 0, at5: 0, at10: 0 }, times = [];
  let mrr = 0;
  for (const { q, gt } of queries) {
    const t = performance.now();
    const res = mode === 'fused'
      ? store.searchFused(q, { limit: 10, maxDepth: edges ? 2 : 0 })
      : store.searchNodes(q, 10);
    times.push(performance.now() - t);
    let rr = 0;
    const clean = res.map((x) => (x && x.node) ? x.node : x).filter(Boolean);
    for (let i = 0; i < clean.length; i++) {
      if (gt.has(clean[i].title)) {
        if (i === 0) hit.at1++;
        if (i < 5) hit.at5++;
        hit.at10++;
        if (rr === 0) rr = 1 / (i + 1);
      }
    }
    mrr += rr;
  }
  const n = queries.length;
  const s = times.slice().sort((a, b) => a - b);
  return {
    mode: mode + (edges ? '+edges' : ''),
    hitAt1: +(hit.at1 / n).toFixed(3),
    hitAt5: +(hit.at5 / n).toFixed(3),
    hitAt10: +(hit.at10 / n).toFixed(3),
    mrr: +(mrr / n).toFixed(3),
    avgMs: +(times.reduce((a, b) => a + b, 0) / n).toFixed(2),
    p95Ms: +s[Math.floor(n * 0.95)].toFixed(2),
  };
}

let linkRes;
for (const minSim of [0.22, 0.12]) {
  const t = Date.now();
  const r = store.autoLinkSemantic(undefined, { minSim, maxPerNode: 6 });
  console.log('autoLinkSemantic minSim=' + minSim + ':', JSON.stringify(r), (Date.now() - t) + 'ms');
  if (minSim === 0.12) linkRes = r;
}

const results = [
  evalQ('plain', false),
  evalQ('fused', false),
  evalQ('plain', true),
  evalQ('fused', true),
];
console.log('\n=== THUCNews real benchmark (5725 nodes / 240 queries) ===');
console.table(results);

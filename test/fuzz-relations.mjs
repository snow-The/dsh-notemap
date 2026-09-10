/**
 * Fuzz the relation algorithm with hostile NUMBERS.
 *
 * These are pure functions fed by values that come out of SQLite and JSON: NaN, Infinity,
 * negatives, zero, 1e308, strings that look numeric. A ranking that silently returns NaN
 * or loops forever is worse than one that throws, because it just ranks everything wrong.
 *
 * Invariants: no NaN/Infinity in any score, no hang, monotone behaviour where promised.
 *   node test/fuzz-relations.mjs [--iters=2000]
 */
import { reciprocalRankFusion, consensusBoost, betaConfidence, recencyDecay, expandByBfs, pageRank, rankAcrossSources } from '../src/relations.ts';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const ITERS = Number(args.iters ?? 2000);
let a = 987654321;
const rand = () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const WEIRD = [NaN, Infinity, -Infinity, -1, 0, 1, 1e308, -1e308, Number.MAX_SAFE_INTEGER, 0.5, Number.EPSILON, 1e-308];
const weird = () => WEIRD[Math.floor(rand() * WEIRD.length) % WEIRD.length];
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const inRange = (x) => finite(x) && x >= 0 && x <= 1 + 1e-9;

const problems = [];
const note = (fn, why) => problems.push({ fn, why });
for (let i = 0; i < ITERS; i++) {
  const ids = Array.from({ length: 1 + Math.floor(rand() * 8) }, (_, k) => 'n' + k);
  const lists = Array.from({ length: 1 + Math.floor(rand() * 4) }, () =>
    Array.from({ length: Math.floor(rand() * 6) }, () => ids[Math.floor(rand() * ids.length) % ids.length]));

  const fused = reciprocalRankFusion(lists, { k: rand() < 0.3 ? weird() : 60 });
  for (const [id, e] of fused) {
    if (!finite(e.score) || e.score < 0) note('reciprocalRankFusion', 'bad score ' + e.score + ' for ' + id);
  }
  const cb = consensusBoost(weird());
  if (!finite(cb) || cb < 1) note('consensusBoost', 'bad ' + cb);
  const bc = betaConfidence(weird(), rand(), weird());
  if (!inRange(bc)) note('betaConfidence', 'out of [0,1]: ' + bc);
  const rd = recencyDecay(weird(), weird(), weird());
  if (!finite(rd) || rd < 0 || rd > 1) note('recencyDecay', 'out of [0,1]: ' + rd);

  const graph = new Map(ids.map((id) => [id, ids.filter(() => rand() < 0.4).map((t) => ({ id: t, weight: weird() }))]));
  const bfs = expandByBfs([[ids[0], weird()]], (id) => graph.get(id) ?? [], { depth: Math.floor(rand() * 4), hopDecay: rand() });
  for (const [id, e] of bfs) if (!finite(e.score)) note('expandByBfs', 'NaN score for ' + id);

  const pr = pageRank(ids, (id) => graph.get(id) ?? [], { iterations: 1 + Math.floor(rand() * 5) });
  let sum = 0;
  for (const [id, v] of pr) { if (!finite(v) || v < 0) note('pageRank', 'bad rank ' + v + ' for ' + id); sum += v; }
  if (pr.size > 0 && !(sum > 0)) note('pageRank', 'all-zero ranks');

  const rows = rankAcrossSources(lists, {
    mentionsOf: weird, lastSeenOf: weird, now: weird(), halfLifeMs: weird(), prior: rand(), k: rand() < 0.3 ? weird() : 60,
  });
  for (const r of rows) if (!finite(r.score) || r.score < 0) note('rankAcrossSources', 'bad score ' + r.score + ' for ' + r.id);
  for (let k = 1; k < rows.length; k++) if (rows[k - 1].score < rows[k].score - 1e-12) { note('rankAcrossSources', 'not sorted'); break; }
}
const tally = (key) => { const acc = {}; for (const p of problems) { const k = key(p); acc[k] = (acc[k] ?? 0) + 1; } return acc; };
console.log(JSON.stringify({ iterations: ITERS, problems: problems.length, byFunction: tally((p) => p.fn), byReason: tally((p) => String(p.why).split(':')[0].slice(0, 40)), samples: problems.slice(0, 5) }, null, 1));
process.exit(problems.length ? 1 : 0);

// 语义场景跑分:主题簇图(簇内强连边) — BFS 语义扩展增益
// 验证:fused 能否召回"不含查询词但属于同一主题簇"的节点(plain 无法)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore } from '../src/graph.ts';

const THEMES = ['机器学习', '深度学习', '数据工程', '知识图谱', '推荐系统', '图像识别', '语音识别', '强化学习', '分布式训练', '模型压缩'];
const WORDS = ['算法', '系统', '框架', '实践', '入门', '进阶', '笔记', '总结', '案例', '优化', '评测', '部署', '原理', '应用', '调研', '综述', '对比', '实现', '调优', '杂谈'];
let seed = 7;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function pick(a) { return a[Math.floor(rnd() * a.length)]; }

function buildSemanticGraph(nClusters, perCluster, intraEdges, interEdges) {
  const dir = mkdtempSync(join(tmpdir(), 'notemap-sem-'));
  const s = new GraphStore(join(dir, 'g.db'));
  const nodes = [];
  let i = 0;
  for (let c = 0; c < nClusters; c++) {
    const theme = THEMES[c % THEMES.length];
    for (let j = 0; j < perCluster; j++) {
      const id = 'n' + i++;
      // 一半节点标题含主题词,一半不含(靠边连接表达语义)
      const hasTheme = rnd() < 0.5;
      s.addNode({ id, title: (hasTheme ? theme : pick(WORDS)) + pick(WORDS), content: pick(WORDS) + ' ' + pick(WORDS) + ' ' + pick(WORDS) });
      nodes.push({ id, theme, hasTheme });
    }
  }
  // 簇内连边
  for (let c = 0; c < nClusters; c++) {
    const mem = nodes.filter(n => n.theme === THEMES[c % THEMES.length]);
    for (let e = 0; e < intraEdges; e++) {
      const a = pick(mem).id, b = pick(mem).id;
      if (a !== b) s.addEdge({ source: a, target: b, weight: 2 + rnd(), confidence: 0.9 });
    }
  }
  // 跨簇少量边
  for (let e = 0; e < interEdges; e++) {
    const a = pick(nodes).id, b = pick(nodes).id;
    if (a !== b) s.addEdge({ source: a, target: b, weight: 0.3, confidence: 0.3 });
  }
  return { s, dir, nodes };
}

const out = [];
for (const [nClusters, perCluster] of [[6, 12], [10, 12]]) {
  const { s, dir, nodes } = buildSemanticGraph(nClusters, perCluster, perCluster * 4, perCluster);
  const row = { scale: nClusters * perCluster };
  let fHit = 0, pHit = 0, fRecall = 0, pRecall = 0, total = 0;
  let fMs = 0, pMs = 0;
  for (const theme of THEMES) {
    // ground truth = 该主题簇全部节点(含不含主题词的)
    const gt = new Set(nodes.filter(n => n.theme === theme).map(n => n.id));
    // plain 只能命中标题含主题词的(约一半)
    let t0 = performance.now();
    const plain = s.searchNodes(theme, 10);
    pMs += performance.now() - t0;
    t0 = performance.now();
    const fused = s.searchFused(theme, { limit: 10, maxDepth: 2 });
    fMs += performance.now() - t0;
    const fIds = fused.map(x => x.node.id), pIds = plain.map(n => n.id);
    fHit += fIds.filter(id => gt.has(id)).length;
    pHit += pIds.filter(id => gt.has(id)).length;
    fRecall += fIds.filter(id => gt.has(id)).length / Math.min(gt.size, 10);
    pRecall += pIds.filter(id => gt.has(id)).length / Math.min(gt.size, 10);
    total++;
  }
  row.fusedHit10 = +(fHit / total).toFixed(2);
  row.plainHit10 = +(pHit / total).toFixed(2);
  row.fusedRecall = +(fRecall / total).toFixed(2);
  row.plainRecall = +(pRecall / total).toFixed(2);
  row.fusedMs = +(fMs / total).toFixed(1);
  row.plainMs = +(pMs / total).toFixed(1);
  out.push(row);
  s.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(out, null, 2));

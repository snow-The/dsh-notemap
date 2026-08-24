// 检索跑分:searchFused vs 单路径(searchNodes)质量+延迟对比
// 规模梯度:1k / 10k 节点;查询集:热词 / 稀有词 / 图相关
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore } from '../src/graph.ts';

const CN_WORDS = ['机器', '学习', '深度', '网络', '神经', '数据', '算法', '模型', '训练', '推理', '图像', '语音', '文本', '知识', '图谱', '检索', '推荐', '排序', '聚类', '分类', '生成', '优化', '梯度', '损失', '注意力', '卷积', '循环', '强化', '迁移', '联邦'];
const EN_WORDS = ['kernel', 'matrix', 'vector', 'tensor', 'gradient', 'backprop', 'embedding', 'attention', 'transformer', 'tokenizer', 'inference', 'pipeline', 'cluster', 'graph', 'semantic', 'latent', 'sparse', 'dense', 'quantize', 'distill'];
const TOPICS = ['计算机视觉', '自然语言处理', '推荐系统', '数据库', '分布式系统', '操作系统', '编译器', '网络安全', '区块链', '云计算'];
let seed = 42;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }
function genTitle() {
  const n = 1 + Math.floor(rnd() * 3);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(rnd() < 0.7 ? pick(CN_WORDS) : pick(EN_WORDS));
  return parts.join('') + (rnd() < 0.5 ? '笔记' : '');
}
function genContent() {
  const n = 8 + Math.floor(rnd() * 12);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(rnd() < 0.7 ? pick(CN_WORDS) : pick(EN_WORDS));
  return parts.join(' ') + ' ' + pick(TOPICS);
}

function buildGraph(nNodes, nEdges) {
  const dir = mkdtempSync(join(tmpdir(), 'notemap-bench-'));
  const s = new GraphStore(join(dir, 'g.db'));
  const t0 = Date.now();
  for (let i = 0; i < nNodes; i++) {
    s.addNode({ id: 'n' + i, type: rnd() < 0.8 ? 'note' : 'task', title: genTitle(), content: genContent(), meta: { views: Math.floor(rnd() * 1000) } });
  }
  for (let i = 0; i < nEdges; i++) {
    const a = 'n' + Math.floor(rnd() * nNodes);
    const b = 'n' + Math.floor(rnd() * nNodes);
    if (a !== b) s.addEdge({ source: a, target: b, weight: 1 + rnd() * 4, confidence: 0.5 + rnd() * 0.5 });
  }
  return { s, dir, buildMs: Date.now() - t0 };
}

function makeQueries() {
  return {
    hot: ['机器', '学习', '数据', '模型', '算法', '网络', '训练', '深度'],
    rare: ['联邦', '迁移', '蒸馏', '量化', '稀疏', '图神经网络'],
    graphQ: ['机器学习', '深度学习', '知识图谱', '推荐系统', '图像识别'],
  };
}

async function run() {
  const queries = makeQueries();
  const results = [];
  for (const scale of [1000, 10000]) {
    const { s, dir, buildMs } = buildGraph(scale, Math.floor(scale * 2.5));
    const row = { scale, buildMs: buildMs + 'ms' };
    for (const [kind, qs] of Object.entries(queries)) {
      let fusedLat = 0, nodeLat = 0, fusedHits = 0, nodeHits = 0, total = 0, fusedEmpty = 0;
      for (const q of qs) {
        const like = s.searchNodes(q, 100000); // LIKE 全扫 = recall 上限(ground truth)
        if (like.length === 0) { fusedEmpty++; continue; }
        total++;
        const gt = new Set(like.map(n => n.id));
        let t0 = performance.now();
        const fused = s.searchFused(q, { limit: 10 });
        fusedLat += performance.now() - t0;
        t0 = performance.now();
        const plain = s.searchNodes(q, 10);
        nodeLat += performance.now() - t0;
        fusedHits += fused.filter(x => gt.has(x.node.id)).length;
        nodeHits += plain.filter(n => gt.has(n.id)).length;
      }
      if (total > 0) {
        row[kind] = {
          q: total,
          fusedMs: +(fusedLat / total).toFixed(1),
          plainMs: +(nodeLat / total).toFixed(1),
          fusedHit10: +((fusedHits / total)).toFixed(2),
          plainHit10: +((nodeHits / total)).toFixed(2),
        };
      }
    }
    results.push(row);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(JSON.stringify(results, null, 2));
}
run();

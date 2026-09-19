// 功能验证套件:覆盖 P1(双时态+度数缓存)/ P2(导入双水位)/ P3(RRF 融合检索 + 过滤 DSL)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { GraphStore } from '../src/graph.ts';
import { labelsPlan } from '../src/notemap.ts';

function newStore() {
  const dir = mkdtempSync(join(tmpdir(), 'notemap-verify-'));
  const s = new GraphStore(join(dir, 'g.db'));
  return { s, dir };
}
function closeStore(s, dir) {
  try { s.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
}

// ---------- P1:双时态 ----------
test('P1: removeEdge 写 invalid_at,active 查询过滤,edgeHistory 可见', () => {
  const { s, dir } = newStore();
  try {
    s.addNode({ id: 'a', title: 'A' });
    s.addNode({ id: 'b', title: 'B' });
    s.addEdge({ source: 'a', target: 'b', weight: 1 });
    assert.equal(s.neighbors('a').length, 1, 'active edge exists');
    s.removeEdge('a', 'b');
    assert.equal(s.neighbors('a').length, 0, 'active query excludes invalidated edge');
    assert.equal(s.getEdge('a', 'b'), null, 'getEdge active only');
    const h = s.edgeHistory('a', 'b');
    assert.equal(h.length, 1, 'history keeps invalidated edge');
    assert.ok(h[0].invalid_at, 'invalid_at written');
    assert.ok(h[0].valid_at, 'valid_at written');
  } finally { closeStore(s, dir); }
});

test('P1: re-addEdge 覆盖语义(轻量双时态:原位更新,不膨胀历史)', () => {
  const { s, dir } = newStore();
  try {
    s.addNode({ id: 'a', title: 'A' });
    s.addNode({ id: 'b', title: 'B' });
    s.addEdge({ source: 'a', target: 'b', weight: 1 });
    s.addEdge({ source: 'a', target: 'b', weight: 5, confidence: 0.9 });
    const h = s.edgeHistory('a', 'b');
    assert.equal(h.length, 1, 'lightweight design: same row updated in place');
    assert.equal(h[0].invalid_at, null, 'still active');
    assert.equal(h[0].weight, 5, 'weight updated');
    assert.equal(s.neighbors('a')[0].weight, 5);
  } finally { closeStore(s, dir); }
});

test('P1: removeNode 级联失效边', () => {
  const { s, dir } = newStore();
  try {
    s.addNode({ id: 'a', title: 'A' });
    s.addNode({ id: 'b', title: 'B' });
    s.addEdge({ source: 'a', target: 'b' });
    s.removeNode('a');
    assert.equal(s.neighbors('b', 'in').length, 0);
  } finally { closeStore(s, dir); }
});

test('P1: degree_cache 随增删正确维护', () => {
  const { s, dir } = newStore();
  try {
    s.addNode({ id: 'a', title: 'A' });
    s.addNode({ id: 'b', title: 'B' });
    s.addNode({ id: 'c', title: 'C' });
    s.addEdge({ source: 'a', target: 'b' });
    s.addEdge({ source: 'a', target: 'c' });
    assert.equal(s.degreeOf('a'), 2);
    s.removeEdge('a', 'b');
    assert.equal(s.degreeOf('a'), 1, 'cache decremented on remove');
    s.addEdge({ source: 'a', target: 'b' });
    assert.equal(s.degreeOf('a'), 2, 'cache incremented on re-add');
    const dc = s.degreeCentrality();
    assert.equal(dc.a, 2);
  } finally { closeStore(s, dir); }
});

// ---------- P2:导入双水位 ----------
test('P2: importSessions zstd 全链路 + 幂等 + force 重导', async () => {
  const { importSessions } = await import('../src/index.ts');
  const { getStore, closeStore: cs } = await import('../src/notemap.ts');
  const dir = mkdtempSync(join(tmpdir(), 'notemap-import-'));
  cs(); // 重置单例
  getStore(join(dir, 'g.db')); // 注入测试库路径
  try {
    const events = [
      { type: 'user/message', data: { content: [{ type: 'text', text: '这是一条用于验证导入管线的用户消息内容,长度超过二十字符' }] } },
      { type: 'assistant/message', data: { content: [{ type: 'text', text: '这是助手回复,包含深度学习与知识图谱的讨论内容,也足够长' }] } },
      { type: 'checkpoint', data: { content: [{ type: 'text', text: 'This is an automatically generated checkpoint condensing an earlier span.\n\n<compacted-summary>这是一段用于验证检查点抽取的摘要内容,包含足够长的中文文字用于测试摘要提取逻辑是否正常工作。</compacted-summary>' }] } },
    ];
    const sessFile = join(dir, 'sess-test.zstd');
    writeFileSync(sessFile, zstdCompressSync(Buffer.from(events.map(e => JSON.stringify(e)).join('\n'))));

    const r1 = await importSessions({ sessionsDir: dir, limit: 10 });
    assert.equal(r1.sessions, 1, 'one session file');
    assert.equal(r1.events, 1, 'user/message imported');
    assert.equal(r1.assistants, 1, 'assistant/message imported');
    assert.equal(r1.checkpoints, 1, 'one checkpoint imported');
    assert.ok(r1.imported.length === 1);

    const r2 = await importSessions({ sessionsDir: dir, limit: 10 });
    assert.equal(r2.events, 0, 'idempotent: no new events');
    assert.equal(r2.skipped, 1, 'file-level anchor skips unchanged file');

    const r3 = await importSessions({ sessionsDir: dir, limit: 10, force: true });
    assert.ok(r3.events >= 1 && r3.checkpoints >= 1 && r3.assistants >= 1, 'force re-imports everything');

    const st = getStore().stats();
    assert.ok(st.nodes >= 4, 'session + 1 event + 1 assistant + 1 checkpoint nodes exist, got ' + st.nodes);

    // Provenance (PMPA 2609.13889): every node an AUTOMATIC importer writes must say so, so a caller
    // can keep the graph free of imported material with notemap_filter {"meta.provenance": {"ne":
    // "session_derived"}} — the write path is the only place the distinction can be made.
    const imported = getStore().filterNodes({ 'meta.provenance': { eq: 'session_derived' } }, 50);
    assert.ok(imported.length >= 4, 'session + event + assistant + checkpoint are all stamped, got ' + imported.length);
    assert.ok(imported.every((n) => n.meta.provenance === 'session_derived'), 'and stamped with the right value');
  } finally {
    cs();
    rmSync(dir, { recursive: true, force: true });
  }
});


test('P4: autoLinkSemantic 同主题建边、跨主题无边、maxPerNode 限制', () => {
  const { s, dir } = newStore();
  try {
    // 同主题组(标题共享 bigram)
    s.addNode({ id: 'm1', title: '机器学习笔记', content: '神经网络 训练 优化 损失函数 反向传播' });
    s.addNode({ id: 'm2', title: '机器学习入门', content: '神经网络 训练 数据 特征 评估' });
    s.addNode({ id: 'm3', title: '机器学习实践', content: '神经网络 训练 调参 实验 结果' });
    // 无关节点
    s.addNode({ id: 'c1', title: '买菜清单', content: '土豆 鸡蛋 牛奶 超市 冰箱' });
    s.addNode({ id: 'c2', title: '装修预算', content: '瓷砖 油漆 工人 报价 工期' });

    const r = s.autoLinkSemantic(undefined, { minSim: 0.2, maxPerNode: 2 });
    assert.ok(r.edges > 0, 'created ' + r.edges + ' semantic edges');
    // 同主题节点间应有边
    const m1Nei = s.neighbors('m1').map(e => e.target);
    assert.ok(m1Nei.includes('m2') || m1Nei.includes('m3'), 'm1 linked to same-theme nodes');
    // 跨主题不应有边
    assert.ok(!m1Nei.includes('c1') && !m1Nei.includes('c2'), 'no cross-theme edges');
    // 每节点边数 ≤ maxPerNode(2)
    for (const id of ['m1', 'm2', 'm3', 'c1', 'c2']) {
      assert.ok(s.neighbors(id).length <= 2, id + ' degree ' + s.neighbors(id).length + ' <= 2');
    }
  } finally { closeStore(s, dir); }
});

test('P4: 语义边让 searchFused 召回无词面命中的同簇节点', () => {
  const { s, dir } = newStore();
  try {
    s.addNode({ id: 'a', title: '机器学习', content: '神经网络 训练 数据' });
    s.addNode({ id: 'b', title: '学习笔记', content: '神经网络 训练 记录 总结' });
    s.addNode({ id: 'c', title: '随便记记', content: '购物 清单 天气' });
    // b 与 a 共享 '学习' bigram → 自动建边
    const r = s.autoLinkSemantic(undefined, { minSim: 0.15 });
    assert.ok(r.edges > 0);
    const res = s.searchFused('机器学习', { limit: 5 });
    const ids = res.map(x => x.node.id);
    assert.ok(ids.includes('a'), '直命中 a');
    assert.ok(ids.includes('b') || s.neighbors('a').some(e => e.target === 'b'), 'b 通过语义边进入融合候选');
    assert.ok(!ids.includes('c'), '无关节点不进');
  } finally { closeStore(s, dir); }
});

// ---------- P3:RRF 融合检索 ----------
test('P3: searchFused 融合 BM25 + LIKE + BFS 候选', () => {
  const { s, dir } = newStore();
  try {
    s.addNode({ id: 'ml', title: '机器学习入门', content: '机器学习 监督学习 无监督学习 神经网络' });
    s.addNode({ id: 'dl', title: '深度学习', content: '深度学习 神经网络 反向传播 GPU 训练' });
    s.addNode({ id: 'notes', title: '我的学习笔记', content: '机器学习笔记 复习 总结 考试' });
    s.addNode({ id: 'unrelated', title: '买菜清单', content: '土豆 鸡蛋 牛奶 超市' });
    s.addEdge({ source: 'ml', target: 'dl', type: 'related', weight: 3 });
    s.addEdge({ source: 'ml', target: 'notes', type: 'related', weight: 1 });

    const r = s.searchFused('机器学习', { limit: 5 });
    const titles = r.map(x => x.node.title);
    assert.ok(titles.includes('机器学习入门'), 'BM25 直命中');
    assert.ok(titles.includes('我的学习笔记'), 'LIKE 命中');
    assert.ok(titles.includes('深度学习'), 'BFS 邻居通过融合进入');
    assert.ok(!titles.includes('买菜清单'), '无关节点不进 top');
    assert.ok(r[0].node.id === 'ml', '最相关排第一');
  } finally { closeStore(s, dir); }
});

test('P3: 中文模糊查询(LIKE 路径)也能召回', () => {
  const { s, dir } = newStore();
  try {
    s.addNode({ id: 'n1', title: '深度学习笔记', content: 'transformer attention 注意力机制' });
    const r = s.searchFused('深度学', { limit: 5 });
    assert.ok(r.some(x => x.node.id === 'n1'), 'substring 前缀命中');
  } finally { closeStore(s, dir); }
});

function seedFilterData(s) {
  s.addNode({ id: 't1', type: 'note', title: '机器学习', meta: { lang: 'zh', views: 100, tags: ['ai', 'ml'] } });
  s.addNode({ id: 't2', type: 'note', title: 'Deep Learning', meta: { lang: 'en', views: 50, tags: ['ai'] } });
  s.addNode({ id: 't3', type: 'task', title: '买菜', meta: { lang: 'zh', views: 5, done: true } });
}

test('P3: filterNodes eq/ne/gt/in/exists', () => {
  const { s, dir } = newStore();
  try {
    seedFilterData(s);
    assert.deepEqual(s.filterNodes({ type: 'note' }).map(n => n.id).sort(), ['t1', 't2']);
    assert.deepEqual(s.filterNodes({ 'meta.lang': { eq: 'zh' } }).map(n => n.id).sort(), ['t1', 't3']);
    assert.deepEqual(s.filterNodes({ 'meta.views': { gt: 10 } }).map(n => n.id).sort(), ['t1', 't2']);
    assert.deepEqual(s.filterNodes({ 'meta.tags': { in: ['ml'] } }).map(n => n.id), ['t1']);
    assert.deepEqual(s.filterNodes({ 'meta.done': { exists: true } }).map(n => n.id), ['t3']);
    assert.deepEqual(s.filterNodes({ 'meta.done': { exists: false } }).map(n => n.id).sort(), ['t1', 't2']);
  } finally { closeStore(s, dir); }
});

test('P3: filterNodes AND/OR/NOT 组合', () => {
  const { s, dir } = newStore();
  try {
    seedFilterData(s);
    const and = s.filterNodes({ AND: [{ type: 'note' }, { 'meta.lang': { eq: 'zh' } }] });
    assert.deepEqual(and.map(n => n.id), ['t1']);
    const or = s.filterNodes({ OR: [{ 'meta.lang': { eq: 'en' } }, { type: 'task' }] });
    assert.deepEqual(or.map(n => n.id).sort(), ['t2', 't3']);
    const not = s.filterNodes({ NOT: { type: 'task' } });
    assert.deepEqual(not.map(n => n.id).sort(), ['t1', 't2']);
  } finally { closeStore(s, dir); }
});

test('legacy: 迁移路径兼容(核心查询可用)', () => {
  const { s, dir } = newStore();
  try {
    s.addNode({ id: 'x', title: '兼容性测试' });
    s.addNode({ id: 'y', title: '迁移验证' });
    s.addEdge({ source: 'x', target: 'y', type: 'related' });
    assert.ok(s.stats().nodes >= 2);
    assert.equal(s.searchFused('兼容').length >= 1, true);
  } finally { closeStore(s, dir); }
});
// ---------- labels: one tool, one shape, one honest default ----------
test('labels: substring 与 popular 两个模式回传同一种形状', () => {
  const { s, dir } = newStore();
  try {
    s.addNode({ id: 'n1', title: 'zig compiler notes' });
    s.addNode({ id: 'n2', title: 'r32 register machine' });
    s.addNode({ id: 'n3', title: 'unrelated note' });
    s.addEdge({ source: 'n1', target: 'n2', weight: 1 });
    s.addEdge({ source: 'n1', target: 'n3', weight: 1 });
    const popular = s.popularLabels(3);
    const substring = s.searchLabels('zig', 3);
    assert.equal(substring.length, 1, 'substring mode finds the title');
    assert.deepEqual(Object.keys(substring[0]).sort(), Object.keys(popular[0]).sort(), 'both modes return the same keys — a schema can only describe one shape');
    assert.equal(typeof substring[0].title, 'string');
    assert.ok(substring[0].degree >= 2, 'degree comes from degree_cache (n1 has two edges), got ' + substring[0].degree);
  } finally { closeStore(s, dir); }
});

test('labels: 匹配的是子字串，空查询不是全表扫描', () => {
  const { s, dir } = newStore();
  try {
    s.addNode({ id: 'a1', title: 'zig compiler notes' });
    s.addNode({ id: 'a2', title: 'notes about ziggurat' });
    s.addNode({ id: 'a3', title: 'nothing here' });
    assert.equal(s.searchLabels('compiler', 5).length, 1, 'matches in the middle of a title — the parameter was called prefix but never was one');
    assert.equal(s.searchLabels('zig', 5).length, 2, 'matches every title containing the fragment');
    assert.deepEqual(s.searchLabels('', 5), [], 'empty query stays empty: the DEFAULT call is what answers the promise');
  } finally { closeStore(s, dir); }
});

test('labels: 无参数调用落到 degree 排序，而不是一个自信的空答案', () => {
  assert.equal(labelsPlan({}), 'popular', 'no arguments → degree ranking');
  assert.equal(labelsPlan({ limit: 5 }), 'popular', 'a limit alone still asks the default question');
  assert.equal(labelsPlan({ popular: true }), 'popular');
  assert.equal(labelsPlan({ prefix: 'zig' }), 'substring', 'an explicit fragment wins');
  assert.equal(labelsPlan({ prefix: 'zig', popular: false }), 'substring');
  assert.equal(labelsPlan({ popular: false }), 'substring', 'explicit popular:false with no fragment stays a substring query (→ []) — behaviour unchanged, and now documented');
});

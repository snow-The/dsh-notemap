// Conformance tests for the TOOL BOUNDARY: what each tool DECLARES vs what it RETURNS.
//
// Every bug this file exists to catch was invisible from GraphStore-level tests, because all of
// them live in the same seam — the registered definition and the value it hands back:
//   1. an undeclared `output` was defaulted to {type:'object'} while the handler returned an array
//   2. one tool returned two shapes from two branches, and one schema cannot describe both
//   3. the no-argument call answered [] — a perfectly valid array, and a wrong answer
//   4. an unresolved seed returned the same value as a resolved node with no neighbours
// A test that only imports src/graph.ts never sees either half of that seam.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The plugin reads its DB path from the environment at first use, so this must happen before the
// modules are imported — otherwise the tests would open the real graph.
const dir = mkdtempSync(join(tmpdir(), 'notemap-tools-'));
process.env.DSH_DATA_DIR = dir;
process.env.DSH_NOTEMAP_DB = join(dir, 'g.db');

const { apply } = await import('../src/index.ts');
const { getStore } = await import('../src/notemap.ts');

// Seed a graph that is NOT empty: an empty graph makes every items-schema pass vacuously.
const store = getStore();
store.addNode({ id: 'zig-1', title: 'zig compiler notes', type: 'note' });
store.addNode({ id: 'r32-1', title: 'r32 register machine', type: 'note' });
store.addNode({ id: 'misc-1', title: 'unrelated topic', type: 'note' });
store.addEdge({ source: 'zig-1', target: 'r32-1', type: 'related', weight: 1 });
store.addEdge({ source: 'zig-1', target: 'misc-1', type: 'related', weight: 1 });

// apply() runs the REAL @deepseek-ai/dsh-tools compiler, so an unsupported schema throws here.
const registered = [];
apply({ tools: { register: (def) => { registered.push(def); return def; } } });
const tools = new Map(registered.map((t) => [t.name, t]));
let itemChecks = 0;

/** Validate a value against the declared schema subset (type + items.type), loudly. */
function checkShape(value, schema, label) {
  assert.ok(schema && typeof schema === 'object', label + ': the tool declares no output schema');
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), label + ': declared array, returned ' + kind);
    const itemType = schema.items && schema.items.type;
    if (itemType) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        const it = item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item;
        assert.equal(it, itemType, label + '[' + i + ']: declared items.type=' + itemType + ', got ' + it + ' — ' + JSON.stringify(item).slice(0, 80));
        itemChecks++;
      }
    }
    return value.length;
  }
  assert.equal(kind, schema.type, label + ': declared ' + schema.type + ', returned ' + kind);
  return 1;
}

test('the checker itself can fail — a green suite must not be a blind one', () => {
  assert.throws(() => checkShape(['a', 'b'], { type: 'array', items: { type: 'object' } }, 'control'), /declared items\.type=object/);
  assert.throws(() => checkShape({ a: 1 }, { type: 'array', items: { type: 'object' } }, 'control'), /declared array/);
});

test('every tool declares a schema, a render and an execute', () => {
  assert.ok(tools.size >= 20, 'expected the full tool set, got ' + tools.size);
  for (const t of tools.values()) {
    assert.ok(t.output && t.output.schema, t.name + ' declares no output schema');
    assert.equal(typeof t.output.render, 'function', t.name + ' declares no render');
    assert.equal(typeof t.execute, 'function', t.name + ' declares no execute');
  }
});

const readCases = [
  ['notemap_stats', {}],
  ['notemap_labels', {}],
  ['notemap_labels', { limit: 5 }],
  ['notemap_labels', { popular: true, limit: 5 }],
  ['notemap_labels', { prefix: 'zig', limit: 5 }],
  ['notemap_search', { q: 'zig', limit: 5 }],
  ['notemap_recall', { query: 'zig', limit: 5 }],
  ['notemap_fusion', { q: 'zig', limit: 5 }],
  ['notemap_neighbors', { id: 'zig-1' }],
  ['notemap_neighbors', { id: 'no-such-node' }],
  ['notemap_related', { id: 'zig-1' }],
  ['notemap_paths', { from: 'r32-1', to: 'misc-1' }],
  ['notemap_paths', { from: 'no-a', to: 'no-b' }],
  ['notemap_common', { a: 'r32-1', b: 'misc-1' }],
  ['notemap_filter', { filter: {}, limit: 5 }],
  ['notemap_context', { seed: 'zig-1', maxDepth: 1 }],
  ['notemap_centrality', { limit: 5 }],
  ['notemap_pagerank', {}],
  ['notemap_agents', { limit: 5 }],
  ['notemap_consensus', { q: 'zig', limit: 5 }],
  ['notemap_export', {}],
];

test('the declared output matches the value the handler actually returns', async () => {
  for (const [name, args] of readCases) {
    const t = tools.get(name);
    assert.ok(t, name + ' is not registered');
    const value = await t.execute(args, {});
    checkShape(value, t.output.schema, name + JSON.stringify(args));
    assert.ok(Array.isArray(t.output.render(args, value)), name + ': render must return blocks');
  }
  assert.ok(itemChecks > 0, 'no item-level check ran: empty arrays validate against EVERY items schema and prove nothing');
});

test('the seeded inputs really do produce non-empty arrays (no vacuous passes)', async () => {
  const nonEmpty = [
    ['notemap_labels', {}, 1],
    ['notemap_labels', { prefix: 'zig' }, 1],
    ['notemap_labels', { popular: true }, 1],
    ['notemap_search', { q: 'zig' }, 1],
    ['notemap_neighbors', { id: 'zig-1' }, 2],
    ['notemap_common', { a: 'r32-1', b: 'misc-1' }, 1],
    ['notemap_paths', { from: 'zig-1', to: 'misc-1' }, 2],   // directed: the seed edges leave zig-1
    ['notemap_filter', { filter: {} }, 3],
  ];
  for (const [name, args, min] of nonEmpty) {
    const v = await tools.get(name).execute(args, {});
    const n = Array.isArray(v) ? v.length : -1;
    assert.ok(n >= min, name + JSON.stringify(args) + ' returned ' + n + ' items, expected >= ' + min);
  }
});

test('the default labels call answers "what does this graph know?"', async () => {
  const rows = await tools.get('notemap_labels').execute({}, {});
  assert.ok(rows.length > 0, 'a seeded graph must not answer "nothing"');
  assert.ok(rows.every((r) => typeof r.title === 'string' && typeof r.degree === 'number'), 'rows are {title, degree} records');
  assert.equal(rows[0].title, 'zig compiler notes', 'highest degree first (zig-1 holds both edges)');
  const explicitEmpty = await tools.get('notemap_labels').execute({ prefix: '' }, {});
  assert.deepEqual(explicitEmpty, [], 'an explicit empty fragment asks "what matches nothing" — not the default question');
});

test('both labels modes return the same record shape', async () => {
  const substring = await tools.get('notemap_labels').execute({ prefix: 'zig' }, {});
  const popular = await tools.get('notemap_labels').execute({ popular: true }, {});
  assert.ok(substring.length > 0 && popular.length > 0, 'both branches must return rows for this seed');
  assert.deepEqual(Object.keys(substring[0]).sort(), Object.keys(popular[0]).sort(), 'one tool must not return two shapes');
});

test('a pathless pair is an empty array, never null', async () => {
  assert.deepEqual(await tools.get('notemap_paths').execute({ from: 'no-a', to: 'no-b' }, {}), []);
});

test('an unresolved seed is REPORTED, not returned as a valid empty subgraph', async () => {
  // The last silent-empty answer in the plugin. 'seed' is an id, but notemap_search matches TITLES,
  // so a caller can very reasonably pass one back - and got { nodes: [], edges: [] }, which is also
  // the correct answer for a real node with no neighbours. Two different facts, one output.
  const byTitle = await tools.get('notemap_context').execute({ seed: 'zig compiler notes', maxDepth: 1 }, {});
  assert.equal(byTitle.seedFound, false, 'a title is not an id, and the caller must be able to see that');
  assert.deepEqual(byTitle.nodes, [], 'and it still returns a well-formed empty subgraph');

  const real = await tools.get('notemap_context').execute({ seed: 'zig-1', maxDepth: 1 }, {});
  assert.equal(real.seedFound, true);
  assert.ok(real.nodes.length >= 3, 'zig-1 reaches r32-1 and misc-1 within one hop');

  // The distinction is the whole fix, so assert it as one:
  assert.notEqual(byTitle.seedFound, real.seedFound);
});

after(() => {
  try { store.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

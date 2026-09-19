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
  if (schema.type === 'object' && schema.properties && schema.properties.items) {
    // The list envelope (proposal G): the shape must SAY whether anything was missing or cut.
    assert.equal(typeof value, 'object', label + ': expected the list envelope, got ' + kind);
    assert.ok(Array.isArray(value.items), label + ': envelope.items must be an array');
    assert.equal(value.returned, value.items.length, label + ': returned must equal items.length');
    assert.ok(value.total >= value.returned, label + ': total (' + value.total + ') >= returned (' + value.returned + ')');
    assert.equal(value.truncated, value.total > value.returned, label + ': truncated must match total > returned');
    assert.ok(value.unknown_id === null || typeof value.unknown_id === 'string', label + ': unknown_id must be a string or null');
    const envItemType = schema.properties.items.items && schema.properties.items.items.type;
    if (envItemType) {
      for (let i = 0; i < value.items.length; i++) {
        const item = value.items[i];
        const it = item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item;
        assert.equal(it, envItemType, label + '.items[' + i + ']: declared ' + envItemType + ', got ' + it + ' — ' + JSON.stringify(item).slice(0, 80));
        itemChecks++;
      }
    }
    return value.returned;
  }
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
  ['notemap_resolve', { handle: 'zig-1' }],
  ['notemap_resolve', { handle: 'zig compiler notes' }],
  ['notemap_resolve', { handle: 'no-such-node' }],
  ['notemap_resolve', { handle: 'zig', limit: 2 }],
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
    const n = v && Array.isArray(v.items) ? v.items.length : -1;
    assert.ok(n >= min, name + JSON.stringify(args) + ' returned ' + n + ' items, expected >= ' + min);
  }
});

test('the default labels call answers "what does this graph know?"', async () => {
  const env = await tools.get('notemap_labels').execute({}, {});
  const rows = env.items;
  assert.ok(env.total > 0, 'a seeded graph must not answer "nothing" (total, not just returned)');
  assert.ok(rows.length > 0, 'and the rows themselves must be delivered');
  assert.ok(rows.every((r) => typeof r.title === 'string' && typeof r.degree === 'number'), 'rows are {title, degree} records');
  assert.equal(rows[0].title, 'zig compiler notes', 'highest degree first (zig-1 holds both edges)');
  const explicitEmpty = await tools.get('notemap_labels').execute({ prefix: '' }, {});
  assert.deepEqual(explicitEmpty.items, [], 'an explicit empty fragment asks "what matches nothing" — not the default question');
  assert.equal(explicitEmpty.total, 0);
});

test('both labels modes return the same record shape', async () => {
  const substring = await tools.get('notemap_labels').execute({ prefix: 'zig' }, {});
  const popular = await tools.get('notemap_labels').execute({ popular: true }, {});
  assert.ok(substring.items.length > 0 && popular.items.length > 0, 'both branches must return rows for this seed');
  assert.deepEqual(Object.keys(substring.items[0]).sort(), Object.keys(popular.items[0]).sort(), 'one tool must not return two shapes');
});

test('the envelope tells "not found" from "cut" — the two lies an array cannot tell apart', async () => {
  const missing = await tools.get('notemap_neighbors').execute({ id: 'definitely-not-a-node' }, {});
  assert.deepEqual(missing.items, []);
  assert.equal(missing.unknown_id, 'definitely-not-a-node', 'an unresolved handle is NAMED, not silently empty');
  assert.equal(missing.total, 0);
  const cut = await tools.get('notemap_neighbors').execute({ id: 'zig-1', limit: 1 }, {});
  assert.equal(cut.returned, 1, 'the budget is honoured');
  assert.equal(cut.total, 2, 'zig-1 has two edges in the seed graph');
  assert.equal(cut.truncated, true, 'and the cut is admitted');
  assert.equal(cut.unknown_id, null, 'a resolved handle is not reported as missing');
});

test('provenance: explicit writes say so, and the filter can select on it', async () => {
  const add = tools.get('notemap_add');
  const declared = await add.execute({ title: 'provenance probe', provenance: 'external_source' }, {});
  assert.equal(declared.meta.provenance, 'external_source', 'a declared external source is recorded verbatim');
  const plain = await add.execute({ title: 'plain probe' }, {});
  assert.equal(plain.meta.provenance, 'agent_authored', 'an explicit tool call defaults to agent_authored');
  const filtered = await tools.get('notemap_filter').execute({ filter: { 'meta.provenance': { eq: 'external_source' } }, limit: 10 }, {});
  assert.equal(filtered.items.length, 1, 'the provenance DSL selects exactly the declared node');
  assert.equal(filtered.items[0].id, declared.id);
});

test('a pathless pair is an empty array, never null', async () => {
  const p = await tools.get('notemap_paths').execute({ from: 'no-a', to: 'no-b' }, {});
  assert.deepEqual(p.items, [], 'no route is an empty item list, never null');
  assert.equal(p.unknown_id, 'no-a', 'and the envelope names the handle that did not resolve');
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

test('resolve: a title is a valid handle, and an id still wins', async () => {
  const byTitle = await tools.get('notemap_resolve').execute({ handle: 'zig compiler notes' }, {});
  assert.equal(byTitle.resolved, true, 'an exact title resolves - that is the whole point of the tool');
  assert.equal(byTitle.id, 'zig-1');
  assert.equal(byTitle.matched_by, 'title');
  const byId = await tools.get('notemap_resolve').execute({ handle: 'zig-1' }, {});
  assert.equal(byId.matched_by, 'id', 'identity beats a title that merely looks like an id');
  assert.equal(byId.confidence, 1);
  for (const [k, t] of [['resolved', 'boolean'], ['candidates', 'object'], ['total_candidates', 'number'], ['confidence', 'number'], ['duplicates', 'object']]) {
    assert.equal(typeof byId[k], t, 'resolve always carries ' + k + ' (shape is part of the contract)');
  }
  assert.ok(byId.hash === null || typeof byId.hash === 'string', 'hash is a string or an explicit null');
  assert.ok(byId.hash && byId.hash.length === 16, 'and it is a content hash, not a placeholder: ' + byId.hash);
});

test('resolve: two nodes sharing a title come back as candidates, never as a pick', async () => {
  // addNode upserts on id, not on title, so one title under two ids is a real state of this graph.
  store.addNode({ id: 'dup-a', title: 'same title twice' });
  store.addNode({ id: 'dup-b', title: 'same title twice' });
  const r = await tools.get('notemap_resolve').execute({ handle: 'same title twice' }, {});
  assert.equal(r.resolved, false, 'a shared title must not resolve to whichever row came back first');
  assert.equal(r.matched_by, 'ambiguous');
  assert.equal(r.total_candidates, 2);
  assert.equal(r.candidates.length, 2);
  assert.deepEqual(r.candidates.map((c) => c.id).sort(), ['dup-a', 'dup-b']);
  assert.equal(r.id, null, 'nothing resolved, so there is no id to mistake for an answer');
  const capped = await tools.get('notemap_resolve').execute({ handle: 'same title twice', limit: 1 }, {});
  assert.equal(capped.candidates.length, 1);
  assert.equal(capped.total_candidates, 2, 'a capped candidate list still says how many there were');
});

test('resolve: a near miss SUGGESTS, it does not resolve', async () => {
  const r = await tools.get('notemap_resolve').execute({ handle: 'zig compiler' }, {});
  assert.equal(r.resolved, false, 'a substring is a suggestion, and a suggestion is not a resolution');
  assert.equal(r.matched_by, 'none');
  assert.equal(r.hash, null);
  assert.ok(r.total_candidates >= 1);
  assert.ok(r.candidates.some((c) => c.id === 'zig-1'), 'the suggestions name what the graph does have');
  const nothing = await tools.get('notemap_resolve').execute({ handle: 'no-such-thing-anywhere' }, {});
  assert.deepEqual(nothing.candidates, []);
  assert.equal(nothing.total_candidates, 0);
});

test('resolve: the hash is a content identity, so two ids read as one note', async () => {
  const a = await tools.get('notemap_resolve').execute({ handle: 'dup-a' }, {});
  const b = await tools.get('notemap_resolve').execute({ handle: 'dup-b' }, {});
  assert.equal(a.hash, b.hash, 'same title + same content = same knowledge, whatever the id');
  assert.deepEqual(a.duplicates, ['dup-b'], 'and the other id is reported as a duplicate');
  const added = await tools.get('notemap_add').execute({ title: 'hash probe', content: 'v1' }, {});
  const h1 = (await tools.get('notemap_resolve').execute({ handle: added.id }, {})).hash;
  await tools.get('notemap_add').execute({ id: added.id, title: 'hash probe', content: 'v2' }, {});
  const h2 = (await tools.get('notemap_resolve').execute({ handle: added.id }, {})).hash;
  assert.notEqual(h1, h2, 'a rewritten note must not keep its old content identity');
});

after(() => {
  try { store.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

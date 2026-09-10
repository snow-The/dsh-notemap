import { buildNetwork } from '../src/network.ts';
import { DatabaseSync } from 'node:sqlite';
const stats = buildNetwork();
const db = new DatabaseSync(process.env.DSH_NOTEMAP_DB, { readOnly: true });
const digest = db.prepare("SELECT title, meta FROM nodes WHERE type = 'consensus' ORDER BY json_extract(meta, '$.score') DESC LIMIT 6").all();
const total = db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE type = 'consensus'").get();
console.log(JSON.stringify({ digest_count: stats.digest, stored: total.n, top: digest.map((r) => ({ title: r.title, meta: JSON.parse(r.meta) })) }, null, 1));

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
const home = process.env.DSH_DATA_DIR;
const mem = new DatabaseSync(join(home, 'memory', 'memory.db'), { readOnly: true });
const layers = ['soul','user','project','fact','lesson','topic','rules'];
const counts = {};
for (const l of layers) { try { counts[l] = mem.prepare('SELECT COUNT(*) AS n FROM ' + l).get().n; } catch (e) { counts[l] = 'err'; } }
let sample = [];
try { sample = mem.prepare('SELECT id, substr(content,1,90) AS c FROM fact LIMIT 3').all(); } catch {}
let lessonSample = [];
try { lessonSample = mem.prepare('SELECT id, substr(content,1,90) AS c FROM lesson LIMIT 3').all(); } catch {}
console.log(JSON.stringify({ counts, sample, lessonSample }, null, 1));

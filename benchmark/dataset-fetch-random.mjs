// wiki random 补量(random extracts per language)
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
const QUOTA = {"zh":2500,"en":1800,"ja":600,"ru":400,"es":400,"pt":300,"ko":250,"fr":250};
const UA = 'dsh-notemap-dataset/1.0 research';
const OUT = 'C:/Users/snow/.dsh-starter/plugins/dsh-notemap/benchmark/data/raw';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function api(lang, params) {
  const u = 'https://' + lang + '.wikipedia.org/w/api.php?' + new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  for (let tries = 0; tries < 3; tries++) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': UA } });
      if (r.status === 429) { await sleep(2000); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (tries === 2) throw e; await sleep(1500); }
  }
}
async function main() {
  const seen = {};
  for (const [lang, quota] of Object.entries(QUOTA)) {
    const rows = [];
    const file = OUT + "/wiki-random-" + lang + ".jsonl";
    if (existsSync(file)) { try { const old = readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); rows.push(...old); } catch {} }
    let rounds = 0;
    while (rows.length < quota && rounds < 30) {
      rounds++;
      let j;
      try { j = await api(lang, { action: 'query', generator: 'random', grnnamespace: 0, grnlimit: 20, prop: 'extracts', exintro: 1, explaintext: 1, exchars: 500, redirects: 1 }); }
      catch (e) { console.log(lang, 'fail', String(e).slice(0, 100)); await sleep(3000); continue; }
      if (!j || !j.query) { await sleep(3000); continue; }
      for (const p of (j.query.pages ?? [])) {
        if (!p.title || p.missing) continue;
        const t = lang + ':' + p.title;
        if (seen[t] || !p.extract || p.extract.length < 120) continue;
        seen[t] = 1;
        rows.push({ lang, theme: null, title: p.title, content: (p.extract || "").slice(0, 500) });
      }
      await sleep(500);
    }
    writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n'));
    console.log(lang, 'random rows:', rows.length);
  }
  console.log("ALL DONE");
}
main().catch(e => { console.error("FATAL", e); process.exit(1); });
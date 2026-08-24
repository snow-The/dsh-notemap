// 多语语料整合:合并 wiki 主题/random + THUCNews -> corpus-v1.jsonl + manifest
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
const RAW = 'C:/Users/snow/.dsh-starter/plugins/dsh-notemap/benchmark/data/raw';
const OUT = 'C:/Users/snow/.dsh-starter/plugins/dsh-notemap/benchmark/data';
mkdirSync(OUT, { recursive: true });
const rows = [];
const seen = new Set();
function push(r, source) {
  const key = r.lang + ':' + r.title;
  if (seen.has(key) || !r.title || !r.content) return;
  seen.add(key);
NaN
}
// 1. wiki 主题文件
for (const f of readdirSync(RAW).filter(f => /^wiki-(zh|en|ja|ru|es|pt|ko|fr)\.jsonl$/.test(f))) {
  const lang = f.match(/^wiki-([a-z]+)\.jsonl$/)[1];
  for (const l of readFileSync(RAW + '/' + f, 'utf8').split('\n').filter(Boolean)) { try { const r = JSON.parse(l); push({ ...r, lang: r.lang || lang }, 'wiki-theme'); } catch {} }
}
// 2. wiki random 文件
for (const f of readdirSync(RAW).filter(f => f.startsWith('wiki-random-'))) {
  const lang = f.match(/^wiki-random-([a-z]+)\.jsonl$/)[1];
  for (const l of readFileSync(RAW + '/' + f, 'utf8').split('\n').filter(Boolean)) { try { const r = JSON.parse(l); push({ ...r, lang: r.lang || lang }, 'wiki-random'); } catch {} }
}
// 3. THUCNews(zh)
for (const l of readFileSync(OUT + '/thucnews-real.jsonl', 'utf8').split('\n').filter(Boolean)) {
  try { const r = JSON.parse(l); push({ lang: 'zh', title: r.title, content: r.content, theme: r.label }, 'thucnews'); } catch {}
}
// 4. 清洗:去重 + 长度过滤
const clean = rows.filter(r => r.content.length >= 80);
writeFileSync(OUT + "/corpus-v1.jsonl", clean.map(r => JSON.stringify(r)).join("\n"));
const byLang = {}; const bySrc = {}; const byTheme = {};
for (const r of clean) { byLang[r.lang] = (byLang[r.lang] || 0) + 1; bySrc[r.source] = (bySrc[r.source] || 0) + 1; if (r.theme) byTheme[r.theme] = (byTheme[r.theme] || 0) + 1; }
const manifest = { total: clean.length, byLang, bySrc, themedThemes: Object.keys(byTheme).length, generatedAt: new Date().toISOString() };
writeFileSync(OUT + "/corpus-v1.manifest.json", JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 1));
// Wikipedia themed multilingual corpus fetch v3
import { writeFileSync, mkdirSync } from 'node:fs';
const THEMES = ["人工智能","区块链","机器学习","量子计算","机器人","神经网络","卫星","火影忍者","进击的巨人","VOCALOID","初音未来","原神","电子游戏","动画","漫画","角色扮演","插画","声优","轻小说","机甲","赛博朋克","像素画","比特币","股票市场","通货膨胀","中央银行","茶","咖啡","围棋","书法","京剧","端午节","春节","汉字","足球","篮球","乒乓球","奥运会","马拉松","黑洞","基因编辑","气候变化","疫苗","国际空间站","核聚变","长城","丝绸之路","罗马帝国","蒙古帝国","维京人","浮世绘","水墨画","油画","摄影","雕塑","爱因斯坦","牛顿","莎士比亚","鲁迅","宫崎骏","莫扎特","糖尿病","针灸","极光","台风","地震","拉面","寿司","披萨","巧克力","火锅"];
const LANGS = ["en","ja","ru","es","pt","ko","fr"];
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
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120));
      return await r.json();
    } catch (e) { if (tries === 2) throw e; await sleep(1500); }
  }
}
async function main() {
  const zhTitles = {};
  for (let i = 0; i < THEMES.length; i += 20) {
    const batch = THEMES.slice(i, i + 20);
    const j = await api('zh', { action: 'query', titles: batch.join('|'), prop: 'extracts|langlinks', exintro: 1, explaintext: 1, exchars: 600, redirects: 1, lllimit: 200 });
    for (const p of (j.query?.pages ?? [])) {
      if (!p.title || p.missing) continue;
      zhTitles[p.title] = { extract: p.extract ?? '', ll: Object.fromEntries((p.langlinks ?? []).filter(l => LANGS.includes(l.lang)).map(l => [l.lang, l.title])) };
    }
    await sleep(400);
  }
  console.log('zh themes resolved:', Object.keys(zhTitles).length, '/', THEMES.length);
  const zhRows = Object.keys(zhTitles).filter(t => zhTitles[t].extract).map(t => ({ lang: 'zh', theme: t, title: t, content: zhTitles[t].extract.slice(0, 600) }));
  writeFileSync(OUT + '/wiki-zh.jsonl', zhRows.map(r => JSON.stringify(r)).join('\n'));
  console.log('zh rows:', zhRows.length);
  for (const lang of LANGS) {
    const rows = [];
    for (let i = 0; i < THEMES.length; i += 20) {
      const batch = THEMES.slice(i, i + 20);
      const titles = batch.map(t => zhTitles[t]?.ll?.[lang] ?? '').filter(Boolean);
      if (!titles.length) continue;
      let j;
      try { j = await api(lang, { action: 'query', titles: titles.join('|'), prop: 'extracts', exintro: 1, explaintext: 1, exchars: 600, redirects: 1 }); }
      catch (e) { console.log(lang, 'batch fail:', String(e).slice(0, 120)); continue; }
      if (!j || !j.query) { console.log(lang, 'bad response:', JSON.stringify(j).slice(0, 120)); continue; }
      for (const p of (j.query?.pages ?? [])) {
        if (!p.title || p.missing || !p.extract) continue;
        const theme = batch.find(t => zhTitles[t]?.ll?.[lang] === p.title) ?? batch[0];
        rows.push({ lang, theme, title: p.title, content: (p.extract || '').slice(0, 600) });
      }
      await sleep(400);
    }
    writeFileSync(OUT + '/wiki-' + lang + '.jsonl', rows.map(r => JSON.stringify(r)).join('\n'));
    console.log(lang, 'rows:', rows.length);
  }
}
main().catch(e => { console.error("FATAL", e); process.exit(1); });
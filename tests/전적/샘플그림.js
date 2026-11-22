// 실제 Data Dragon 아이콘으로 롤 이미지를 그려 tests/전적/out/lol-real.png 에 저장한다(눈으로 확인용, 네트워크 필요).
// 실행: node tests/전적/샘플그림.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const { createStatic } = require(path.join(root, 'handlers', '전적', '정적데이터.js'));
const { renderLol } = require(path.join(root, 'handlers', '전적', '롤그림.js'));
const { summarize } = require(path.join(root, 'handlers', '전적', '집계.js'));

(async () => {
  const statics = createStatic({
    fetchJson: async u => (await fetch(u)).json(),
    fetchBuffer: async u => { const r = await fetch(u); if (!r.ok) throw new Error(u + ' ' + r.status); return Buffer.from(await r.arrayBuffer()); },
    dir: path.join(root, 'assets', '전적'),
  });
  await statics.load();
  const champs = ['Yone', 'Azir', 'Ahri', 'Viego', 'Syndra'];
  const items = [3031, 3006, 3046, 3087, 3036, 3363, 6672];
  const ms = champs.map((champ, i) => ({
    id: 'KR_' + i, ts: Date.now() - (i + 1) * 5400000, dur: 1500 + i * 90, queue: i % 2 ? 440 : 420, win: i % 3 !== 1, champ, k: 8 - i, d: 3 + i, a: 6 + i, cs: 180 + i * 12,
    items: [items[i], items[1], items[2], items[3], i === 2 ? 0 : items[4], items[5], 3363], spells: [4, 14], keystone: 8010, subStyle: 8100, vision: i, pos: 'MIDDLE', multi: i === 1 ? 2 : 0, teamKills: 28 }));
  const icons = { profile: await statics.iconFile('profile', 29), solo: await statics.iconFile('emblem', 'master'), flex: await statics.iconFile('emblem', 'diamond'), champs: {}, items: {}, spells: { 4: await statics.iconFile('spell', 4), 14: await statics.iconFile('spell', 14) }, runes: { 8010: await statics.iconFile('rune', 8010) }, styles: { 8100: await statics.iconFile('style', 8100) } };
  icons.positions = { MIDDLE: path.join(root, 'assets', '티어', 'pos_lol_mid.png') };
  for (const c of champs) icons.champs[c] = await statics.iconFile('champion', c);
  for (const id of items) icons.items[id] = await statics.iconFile('item', id);
  const names = Object.fromEntries(champs.map(c => [c, statics.champName(c)]));
  const png = renderLol({ name: 'Mino', tag: 'KR1', level: 742, queue: 'all', solo: { tier: 'MASTER', rank: 'I', lp: 606, wins: 448, losses: 371 }, flex: { tier: 'DIAMOND', rank: 'II', lp: 40, wins: 52, losses: 48 }, summary: summarize(ms), matches: ms, icons, names });
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', 'lol-real.png'), png);
  console.log('저장:', path.join(__dirname, 'out', 'lol-real.png'));
})();

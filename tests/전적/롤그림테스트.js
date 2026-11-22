// 롤 이미지 테스트: node tests/전적/롤그림테스트.js  (확인용 그림 저장: --save → tests/전적/out/lol-*.png)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const { renderLol, createLolRenderer } = require(path.join(root, 'handlers', '전적', '롤그림.js'));
const { summarize } = require(path.join(root, 'handlers', '전적', '집계.js'));

const NOW = 1763800000000 + 3 * 3600 * 1000;
const match = (i, over = {}) => ({
  id: 'KR_' + i, ts: 1763800000000 - i * 5400000, dur: 1500 + i * 60, queue: i % 2 ? 440 : 420, win: i % 2 === 0,
  champ: ['Yone', 'Azir', 'Ahri', 'Viego', 'Syndra'][i % 5], champId: 777, k: 8 - i, d: 3 + i, a: 6, cs: 180 + i * 10, lvl: 16 + i,
  items: [3031, 3006, 3046, 3087, 0, 3036, 3363], spells: [4, 14], keystone: 8010, subStyle: 8100, vision: 2, pos: 'MIDDLE', multi: i === 1 ? 2 : 0, teamKills: 30,
  ...over,
});
const five = [0, 1, 2, 3, 4].map(i => match(i));
const view = (over = {}) => ({
  name: 'Mino', tag: 'KR1', level: 742, queue: 'all', now: NOW,
  solo: { tier: 'MASTER', rank: 'I', lp: 606, wins: 448, losses: 371 },
  flex: { tier: 'DIAMOND', rank: 'II', lp: 40, wins: 52, losses: 48 },
  summary: summarize(five), matches: five,
  icons: { profile: null, solo: null, flex: null, champs: {}, items: {}, spells: {}, runes: {}, styles: {} },
  ...over,
});
const isPng = b => Buffer.isBuffer(b) && b.subarray(0, 4).toString('hex') === '89504e47';
const save = process.argv.includes('--save');
const outDir = path.join(__dirname, 'out');
const keep = (name, png) => { if (save) { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, name), png); } };

const base = renderLol(view());
assert.ok(isPng(base), 'PNG 서명');
assert.ok(base.length < 600 * 1024, `600KB 미만이어야 함(${Math.round(base.length / 1024)}KB)`);
keep('lol-base.png', base);

// Review Focus 1: 랭크 기록이 없는 계정(언랭크)
assert.ok(isPng(renderLol(view({ solo: null, flex: null }))), '언랭크도 그려진다');
// Review Focus 2: 경기가 적은 새 계정, 기록이 아예 없는 계정
assert.ok(isPng(renderLol(view({ matches: five.slice(0, 2), summary: summarize(five.slice(0, 2)) }))), '2판만 있어도');
assert.ok(isPng(renderLol(view({ matches: [], summary: summarize([]) }))), '경기 0판도');
// Review Focus 3: 데스 0 → Perfect (NaN/Infinity 없이)
const perfect = [match(0, { d: 0 })];
assert.ok(isPng(renderLol(view({ matches: perfect, summary: summarize(perfect) }))), '데스 0도');
keep('lol-perfect.png', renderLol(view({ matches: perfect, summary: summarize(perfect) })));
// Review Focus 5: 모르는 큐 id
const odd = [match(0, { queue: 999 }), match(1, { queue: 1700, pos: '' })];
assert.ok(isPng(renderLol(view({ matches: odd, summary: summarize(odd) }))), '모르는 큐도');
for (const q of ['solo', 'flex', 'normal', 'aram', 'arena']) assert.ok(isPng(renderLol(view({ queue: q }))), `${q} 탭`);
const unrankedFile = path.join(root, 'assets', '이모지', 'rec_lol_unranked.png');
assert.ok(isPng(renderLol(view({ solo: null, flex: null, icons: { ...view().icons, unranked: unrankedFile } }))), '언랭크 엠블럼');
keep('lol-unranked.png', renderLol(view({ solo: null, flex: null, icons: { ...view().icons, unranked: unrankedFile } })));
const posIcons = Object.fromEntries([['MIDDLE', 'mid'], ['JUNGLE', 'jungle']].map(([k, f]) => [k, path.join(root, 'assets', '티어', `pos_lol_${f}.png`)]));
const withPos = renderLol(view({ icons: { ...view().icons, positions: posIcons } }));
assert.ok(isPng(withPos), '포지션 로고가 있어도');
assert.ok(!withPos.equals(renderLol(view())), '포지션 로고가 그림에 반영됨');
keep('lol-positions.png', withPos);
// 아주 긴 이름·큐 탭 표시
assert.ok(isPng(renderLol(view({ name: '가나다라마바사아자차카타파하가나', queue: 'solo' }))), '긴 이름');
keep('lol-solo.png', renderLol(view({ queue: 'solo' })));

// 미리 데우기: 샘플을 한 번 그려 엔진·글자 모양을 준비한다(결과는 버림). 폰트가 없으면 false
assert.strictEqual(createLolRenderer().warm(), true, '미리 데우기 성공');
assert.strictEqual(createLolRenderer({ fontDir: path.join(__dirname, 'no-such-dir') }).warm(), false, '폰트가 없으면 false');
// 폰트를 못 찾으면 null(호출부가 글자 화면으로 대신함)
assert.strictEqual(createLolRenderer({ fontDir: path.join(__dirname, 'no-such-dir') }).render(view()), null);

// 같은 그림을 20번 그려도 메모리가 늘지 않는다
renderLol(view());
const before = process.memoryUsage().rss;
for (let i = 0; i < 20; i++) renderLol(view());
const grew = (process.memoryUsage().rss - before) / 1048576;
assert.ok(grew < 30, `RSS 증가 30MB 미만이어야 함(${grew.toFixed(1)}MB)`);
console.log('롤 이미지 테스트 통과');

// 정적 데이터·아이콘 테스트: node tests/전적/아이콘테스트.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const { encodePng, loadIcon, drawIcon } = require(path.join(root, 'handlers', '전적', '아이콘.js'));
const { createStatic } = require(path.join(root, 'handlers', '전적', '정적데이터.js'));
const { decodePng } = require(path.join(root, 'handlers', '공통', '이모지그림.js'));
const { Painter } = require(path.join(root, 'handlers', '레이드', '그림판.js'));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'icon-'));
const solid = (w, h, rgba) => { const b = Buffer.alloc(w * h * 4); for (let i = 0; i < w * h; i++) b.set(rgba, i * 4); return b; };

(async () => {
  // (a) encodePng ↔ decodePng
  const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 10, 20, 30, 0]);
  const back = decodePng(encodePng(rgba, 2, 2));
  assert.strictEqual(back.w, 2); assert.strictEqual(back.h, 2);
  assert.deepStrictEqual([...back.data], [...rgba]);

  // (b) loadIcon: 크기·둥근 모서리, (c) 없는 파일
  const dir = tmp();
  const f64 = path.join(dir, 'a.png');
  fs.writeFileSync(f64, encodePng(solid(64, 64, [200, 100, 50, 255]), 64, 64));
  const sq = loadIcon(f64, 32);
  assert.strictEqual(sq.length, 32 * 32 * 4);
  assert.ok(sq[3] > 0.99, '네모는 모서리도 불투명');
  const round = loadIcon(f64, 32, { circle: true });
  assert.strictEqual(round[3], 0, '둥근 아이콘은 모서리가 투명');
  assert.ok(round[(16 * 32 + 16) * 4 + 3] > 0.99, '가운데는 불투명');
  assert.strictEqual(loadIcon(path.join(dir, 'none.png'), 32), null);
  assert.strictEqual(loadIcon(f64, 32), loadIcon(f64, 32), '같은 요청은 캐시');

  // drawIcon: 그림판에 찍힌다 / null 은 아무것도 안 그린다
  const p = new Painter(20, 20, 1);
  p.clear('#000000');
  drawIcon(p, sq, 10, 10, 8);
  const mid = (10 * 20 + 10) * 3;
  assert.ok(p.buf[mid] > 150, '가운데 픽셀이 아이콘 색(빨강 계열)');
  drawIcon(p, null, 3, 3, 4);

  // (d) 정적 데이터: 디스크 캐시와 실패
  let downloads = 0;
  const urls = [];
  const fetchJson = async url => {
    if (url.endsWith('versions.json')) return ['16.23.1', '16.22.1'];
    if (url.includes('champion.json')) return { data: { Yone: { id: 'Yone', key: '777', name: '요네' } } };
    if (url.includes('summoner.json')) return { data: { SummonerFlash: { key: '4', image: { full: 'SummonerFlash.png' } } } };
    if (url.includes('runesReforged.json')) return [{ id: 8000, icon: 'perk-images/Styles/7201_Precision.png', slots: [{ runes: [{ id: 8010, icon: 'perk-images/Styles/Precision/Conqueror/Conqueror.png' }] }] }];
    throw new Error('예상 못한 URL ' + url);
  };
  const fetchBuffer = async url => { downloads++; urls.push(url); return encodePng(solid(64, 64, [1, 2, 3, 255]), 64, 64); };
  const statics = createStatic({ fetchJson, fetchBuffer, dir: tmp() });
  await statics.load();
  assert.strictEqual(statics.champName('Yone'), '요네');
  assert.strictEqual(statics.champName('Unknown'), 'Unknown', '모르는 챔피언은 영문 그대로');
  const file = await statics.iconFile('item', 3031);
  assert.ok(file && fs.existsSync(file));
  assert.ok(urls[0].endsWith('/cdn/16.23.1/img/item/3031.png'));
  await statics.iconFile('item', 3031);
  assert.strictEqual(downloads, 1, '두 번째는 디스크 캐시');
  await statics.iconFile('spell', 4);
  assert.ok(urls.at(-1).endsWith('/img/spell/SummonerFlash.png'), '스펠 id → 파일명');
  await statics.iconFile('rune', 8010);
  assert.ok(urls.at(-1).endsWith('/cdn/img/perk-images/Styles/Precision/Conqueror/Conqueror.png'));
  await statics.iconFile('style', 8000);
  assert.ok(urls.at(-1).endsWith('/cdn/img/perk-images/Styles/7201_Precision.png'));

  // 옛 버전 아이콘 폴더는 지워지고, 엠블럼·발로란트 아이콘 폴더는 남는다
  const cdir = tmp();
  for (const sub of ['15.0.1/item', 'emblem', 'valorant-tier']) { fs.mkdirSync(path.join(cdir, sub), { recursive: true }); fs.writeFileSync(path.join(cdir, sub, 'x.png'), 'x'); }
  const cleaner = createStatic({ fetchJson, fetchBuffer, dir: cdir });
  await cleaner.load();
  await cleaner.iconFile('item', 3031);
  assert.ok(!fs.existsSync(path.join(cdir, '15.0.1')), '옛 버전 폴더 삭제');
  assert.ok(fs.existsSync(path.join(cdir, 'emblem', 'x.png')) && fs.existsSync(path.join(cdir, 'valorant-tier', 'x.png')), '버전과 무관한 폴더는 남김');
  assert.ok(fs.existsSync(path.join(cdir, '16.23.1', 'item', '3031.png')));

  const broken = createStatic({ fetchJson, fetchBuffer: async () => { throw new Error('network'); }, dir: tmp() });
  await broken.load();
  assert.strictEqual(await broken.iconFile('item', 1), null, '내려받기 실패는 null');

  // (e) 엠블럼은 줄여서 저장
  const big = solid(1280, 720, [0, 0, 0, 0]);
  for (let y = 260; y < 460; y++) for (let x = 540; x < 740; x++) big.set([220, 180, 40, 255], (y * 1280 + x) * 4);
  const emb = createStatic({ fetchJson, fetchBuffer: async () => encodePng(big, 1280, 720), dir: tmp() });
  await emb.load();
  const ef = await emb.iconFile('emblem', 'gold');
  const small = decodePng(fs.readFileSync(ef));
  assert.ok(small.w <= 128 && small.h <= 128, `엠블럼은 128 이하로 줄어야 함(${small.w}x${small.h})`);
  assert.ok(small.data[3] > 200, '줄인 뒤에도 그림이 남아 있음(여백 제거)');
  console.log('정적 데이터·아이콘 테스트 통과');
})();

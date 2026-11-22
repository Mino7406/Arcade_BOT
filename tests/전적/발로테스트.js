// 발로란트(HenrikDev) 조회·이미지 테스트: node tests/전적/발로테스트.js  (확인용 그림 저장: --save)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const { parseValorant, fetchValorant } = require(path.join(root, 'handlers', '전적', '헨릭.js'));
const { renderValorant, seasonLabel, tierKo } = require(path.join(root, 'handlers', '전적', '발로그림.js'));
const { createValorantService } = require(path.join(root, 'handlers', '전적', '발로.js'));
const { RiotError } = require(path.join(root, 'handlers', '전적', '리오트.js'));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'henrik-mmr.json'), 'utf8'));
const isPng = b => Buffer.isBuffer(b) && b.subarray(0, 4).toString('hex') === '89504e47';
const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const fake = (...responses) => { const calls = []; let i = 0; const fn = async (url, opt) => { calls.push({ url, opt }); return responses[Math.min(i++, responses.length - 1)]; }; fn.calls = calls; return fn; };

(async () => {
  // parseValorant
  const p = parseValorant(fixture);
  assert.strictEqual(p.name, 'Mino#KR1');
  assert.strictEqual(p.tier, 'Gold 2');
  assert.strictEqual(p.rr, 47);
  assert.strictEqual(p.peak, 'Platinum 1');
  assert.strictEqual(p.seasons.length, 4, '게임 수 0인 시즌은 뺀다');
  assert.deepStrictEqual(p.seasons[0], { season: 'e9a1', endTier: 'Silver 3', wins: 30, games: 58 });
  for (const bad of [{}, { data: {} }, null, 'x']) assert.throws(() => parseValorant(bad), e => e instanceof RiotError && e.kind === 'not_found');

  // fetchValorant: kr 404 → ap, 키 없음, 401 은 재시도 없이 denied, 429 는 rate
  let f = fake(res(404, {}), res(200, fixture));
  const got = await fetchValorant({ name: 'Mino', tag: 'KR1', key: 'HDEV-key', fetchFn: f });
  assert.strictEqual(got.tier, 'Gold 2');
  assert.ok(f.calls[0].url.endsWith('/valorant/v3/mmr/kr/pc/Mino/KR1'));
  assert.ok(f.calls[1].url.endsWith('/valorant/v3/mmr/ap/pc/Mino/KR1'));
  assert.strictEqual(f.calls[0].opt.headers.Authorization, 'HDEV-key');
  await assert.rejects(fetchValorant({ name: 'Mino', tag: 'KR1', key: '', fetchFn: fake(res(200, fixture)) }), e => e.kind === 'no_key');
  f = fake(res(401, {}), res(200, fixture));
  await assert.rejects(fetchValorant({ name: 'Mino', tag: 'KR1', key: 'k', fetchFn: f }), e => e.kind === 'denied');
  assert.strictEqual(f.calls.length, 1, 'denied 는 다른 지역을 시도하지 않음');
  await assert.rejects(fetchValorant({ name: 'Mino', tag: 'KR1', key: 'k', fetchFn: fake(res(429, {})) }), e => e.kind === 'rate');
  await assert.rejects(fetchValorant({ name: 'Mino', tag: 'KR1', key: 'k', fetchFn: fake(res(404, {}), res(404, {})) }), e => e.kind === 'not_found');

  // 이름 다듬기
  assert.strictEqual(seasonLabel('e10a2'), '에피소드 10 · 액트 2');
  assert.strictEqual(seasonLabel('weird'), 'weird');
  assert.strictEqual(tierKo('Gold 2'), '골드 2');
  assert.strictEqual(tierKo('Radiant'), '레디언트');
  assert.strictEqual(tierKo(''), '언랭크');

  // 이미지
  const save = process.argv.includes('--save');
  const png = renderValorant({ profile: p, tierIcons: {} });
  assert.ok(isPng(png) && png.length < 600 * 1024);
  if (save) { fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true }); fs.writeFileSync(path.join(__dirname, 'out', 'valorant.png'), png); }
  assert.ok(isPng(renderValorant({ profile: { name: 'A#B', tier: '', rr: null, peak: '', seasons: [] }, tierIcons: {} })), '시즌 0개·티어 없음');

  // 서비스
  const statics = { urlIcon: async () => null };
  const tierFetchJson = async () => ({ data: [{ tiers: [{ tierName: 'GOLD 2', smallIcon: 'https://example.test/g2.png' }] }] });
  const svc = createValorantService({ key: 'k', statics, fetchFn: fake(res(200, fixture)), fetchJson: tierFetchJson });
  const ok = await svc.lookup({ name: 'Mino', tag: 'KR1' });
  assert.strictEqual(ok.ok, true);
  assert.ok(isPng(ok.png));
  assert.ok(ok.text.includes('골드 2'));
  assert.strictEqual(ok.label, 'Mino#KR1');
  const noKey = await createValorantService({ key: '', statics, fetchFn: fake(res(200, fixture)), fetchJson: tierFetchJson }).lookup({ name: 'Mino', tag: 'KR1' });
  assert.strictEqual(noKey.ok, false);
  assert.ok(noKey.message.includes('키'));
  const nf = await createValorantService({ key: 'k', statics, fetchFn: fake(res(404, {})), fetchJson: tierFetchJson }).lookup({ name: 'Mino', tag: 'KR1' });
  assert.strictEqual(nf.ok, false);
  assert.ok(nf.message.includes('찾을 수 없'));
  console.log('발로란트 테스트 통과');
})();

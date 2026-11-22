// 발로란트(HenrikDev) 조회·집계·이미지 테스트: node tests/전적/발로테스트.js  (확인용 그림 저장: --save)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const { parseValorant, fetchValorant, parseStoredMatches, fetchValorantMatches } = require(path.join(root, 'handlers', '전적', '헨릭.js'));
const { summarizeValorant } = require(path.join(root, 'handlers', '전적', '발로집계.js'));
const { renderValorant, seasonLabel, tierKo } = require(path.join(root, 'handlers', '전적', '발로그림.js'));
const { createValorantService } = require(path.join(root, 'handlers', '전적', '발로.js'));
const { RiotError } = require(path.join(root, 'handlers', '전적', '리오트.js'));
const fx = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const fixture = fx('henrik-mmr.json');
const stored = fx('henrik-stored.json');
const isPng = b => Buffer.isBuffer(b) && b.subarray(0, 4).toString('hex') === '89504e47';
const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const fake = (...responses) => { const calls = []; let i = 0; const fn = async (url, opt) => { calls.push({ url, opt }); return responses[Math.min(i++, responses.length - 1)]; }; fn.calls = calls; return fn; };

(async () => {
  // ── 티어·RR (mmr) ──
  const p = parseValorant(fixture);
  assert.strictEqual(p.name, 'Mino#KR1');
  assert.strictEqual(p.tier, 'Gold 2');
  assert.strictEqual(p.rr, 47);
  assert.strictEqual(p.peak, 'Platinum 1');
  assert.strictEqual(p.seasons.length, 4, '게임 수 0인 시즌은 뺀다');
  assert.deepStrictEqual(p.seasons[0], { season: 'e9a1', endTier: 'Silver 3', wins: 30, games: 58 });
  const unrated = parseValorant({ data: { account: { name: 'Mino', tag: 'KR1' }, current: {}, peak: {}, seasonal: [] } });
  assert.strictEqual(unrated.name, 'Mino#KR1'); assert.strictEqual(unrated.tier, ''); assert.deepStrictEqual(unrated.seasons, []);
  for (const bad of [{}, { data: {} }, null, 'x']) assert.throws(() => parseValorant(bad), e => e instanceof RiotError && e.kind === 'not_found');

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

  // ── 경기 목록 (stored-matches) ──
  const ms = parseStoredMatches(stored);
  assert.strictEqual(ms.length, 6);
  assert.deepStrictEqual(ms[0], {
    id: '5cc97e03-24bd-4ff4-813a-a9cdb8174fef', ts: Date.parse('2026-11-15T20:56:55.244Z'), mode: 'Competitive',
    map: { id: '2c9d57ec-4431-9c5e-2939-8f9ef6dd5cba', name: 'Bind' }, agent: { id: '1dbf2edd-4729-0984-3115-daa5eed44993', name: 'Clove' },
    tier: 23, k: 11, d: 18, a: 8, score: 3317, head: 9, body: 29, leg: 2, dmg: 2184, rounds: [6, 13], result: 'loss',
  });
  assert.deepStrictEqual(ms.map(m => m.result), ['loss', 'win', 'win', 'loss', 'win', 'win'], '내 팀 라운드와 상대 라운드 비교');
  assert.ok(ms.every((m, i) => i === 0 || ms[i - 1].ts >= m.ts), '최근순');
  const draw = JSON.parse(JSON.stringify(stored)); draw.data[0].teams = { red: 13, blue: 13 };
  assert.strictEqual(parseStoredMatches(draw)[0].result, 'draw');
  assert.deepStrictEqual(parseStoredMatches({ data: [{}, null, { meta: {} }, { meta: { id: 'x' }, stats: {} }] }), [], '깨진 항목은 건너뜀');
  assert.deepStrictEqual(parseStoredMatches({}), []);

  f = fake(res(404, {}), res(200, stored));
  const fetched = await fetchValorantMatches({ name: 'Mino', tag: 'KR1', key: 'k', fetchFn: f });
  assert.strictEqual(fetched.length, 6);
  assert.ok(f.calls[0].url.endsWith('/valorant/v1/stored-matches/kr/Mino/KR1?mode=competitive&size=20'));
  assert.ok(f.calls[1].url.includes('/stored-matches/ap/Mino/KR1'));
  assert.strictEqual(f.calls[0].opt.headers.Authorization, 'k');
  assert.deepStrictEqual(await fetchValorantMatches({ name: 'Mino', tag: 'KR1', key: 'k', fetchFn: fake(res(200, { data: [] })) }), [], '경기가 없으면 빈 목록');
  await assert.rejects(fetchValorantMatches({ name: 'Mino', tag: 'KR1', key: 'k', fetchFn: fake(res(429, {})) }), e => e.kind === 'rate');
  await assert.rejects(fetchValorantMatches({ name: 'Mino', tag: 'KR1', key: '', fetchFn: fake(res(200, stored)) }), e => e.kind === 'no_key');

  // ── 집계 ──
  const s = summarizeValorant(ms);
  const sum = (arr, g) => arr.reduce((t, x) => t + g(x), 0);
  const rounds = sum(ms, m => m.rounds[0] + m.rounds[1]);
  assert.strictEqual(s.games, 6); assert.strictEqual(s.wins, 4); assert.strictEqual(s.losses, 2);
  assert.ok(Math.abs(s.acs - sum(ms, m => m.score) / rounds) < 1e-9, 'ACS = 점수 합 / 라운드 합');
  assert.ok(Math.abs(s.adr - sum(ms, m => m.dmg) / rounds) < 1e-9, 'ADR = 피해 합 / 라운드 합');
  assert.ok(Math.abs(s.kd - sum(ms, m => m.k) / sum(ms, m => m.d)) < 1e-9);
  assert.ok(Math.abs(s.hs - sum(ms, m => m.head) / sum(ms, m => m.head + m.body + m.leg)) < 1e-9);
  assert.strictEqual(s.agents[0].id, '1dbf2edd-4729-0984-3115-daa5eed44993'); assert.strictEqual(s.agents[0].games, 3); assert.strictEqual(s.agents[0].wins, 2);
  assert.ok(s.agents.length <= 3);
  const none = summarizeValorant([]);
  assert.deepStrictEqual([none.games, none.wins, none.losses, none.acs, none.adr, none.hs], [0, 0, 0, 0, 0, 0]);
  assert.strictEqual(none.kd, null); assert.deepStrictEqual(none.agents, []);
  assert.strictEqual(summarizeValorant([{ ...ms[0], d: 0 }]).kd, null, '데스 0 이면 K/D 없음(NaN·무한대 아님)');

  // ── 이름 다듬기 ──
  assert.strictEqual(seasonLabel('e10a2'), '에피소드 10 · 액트 2');
  assert.strictEqual(seasonLabel('weird'), 'weird');
  assert.strictEqual(tierKo('Gold 2'), '골드 2');
  assert.strictEqual(tierKo('Radiant'), '레디언트');
  assert.strictEqual(tierKo(''), '언랭크');

  // ── 이미지 ──
  const save = process.argv.includes('--save');
  const keep = (name, png) => { if (save) { fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true }); fs.writeFileSync(path.join(__dirname, 'out', name), png); } };
  const NOW = ms[0].ts + 3 * 3600 * 1000;
  const view = (over = {}) => ({
    profile: { ...p, name: 'OωO#1116' }, summary: summarizeValorant(ms), matches: ms.slice(0, 5), now: NOW,
    icons: { tier: null, tiers: {}, agents: {} }, names: { agents: { '1dbf2edd-4729-0984-3115-daa5eed44993': '클로브' }, maps: { '2c9d57ec-4431-9c5e-2939-8f9ef6dd5cba': '바인드' } }, ...over,
  });
  const png = renderValorant(view());
  assert.ok(isPng(png) && png.length < 600 * 1024, `600KB 미만(${png && Math.round(png.length / 1024)}KB)`);
  keep('valorant.png', png);
  assert.ok(isPng(renderValorant(view({ matches: [], summary: summarizeValorant([]) }))), '경기 0판도');
  assert.ok(isPng(renderValorant(view({ matches: ms.slice(0, 2), summary: summarizeValorant(ms.slice(0, 2)) }))), '2판만 있어도');
  assert.ok(isPng(renderValorant(view({ profile: { name: 'A#B', tier: '', rr: null, peak: '', seasons: [] } }))), '언랭크·티어 없음');
  const drawn = [{ ...ms[0], result: 'draw', rounds: [13, 13] }];
  assert.ok(isPng(renderValorant(view({ matches: drawn, summary: summarizeValorant(drawn) }))), '무승부도');
  const zeroDeath = [{ ...ms[0], d: 0 }];
  assert.ok(isPng(renderValorant(view({ matches: zeroDeath, summary: summarizeValorant(zeroDeath) }))), '데스 0도');

  // ── 서비스 ──
  const statics = { urlIcon: async () => null };
  const fetchJson = async url => {
    if (url.includes('/agents')) return { data: [{ uuid: '1dbf2edd-4729-0984-3115-daa5eed44993', displayName: '클로브', displayIconSmall: 'https://example.test/clove.png' }] };
    if (url.includes('/maps')) return { data: [{ uuid: '2c9d57ec-4431-9c5e-2939-8f9ef6dd5cba', displayName: '바인드' }] };
    return { data: [{ tiers: [{ tier: 23, tierName: 'ASCENDANT 3', smallIcon: 'https://example.test/a3.png' }, { tier: 12, tierName: 'GOLD 2', smallIcon: 'https://example.test/g2.png' }] }] };
  };
  const router = ({ mmr = res(200, fixture), matches = res(200, stored) } = {}) => async url => (url.includes('/mmr/') ? mmr : matches);
  const svc = createValorantService({ key: 'k', statics, fetchFn: router(), fetchJson });
  const ok = await svc.lookup({ name: 'Mino', tag: 'KR1' });
  assert.strictEqual(ok.ok, true);
  assert.ok(isPng(ok.png));
  assert.ok(ok.text.includes('골드 2') && ok.text.includes('클로브'));
  assert.strictEqual(ok.label, 'Mino#KR1');
  // 경기 목록을 못 찾아도(404) 티어 화면은 나온다. 한도(429)는 안내한다.
  const noMatches = await createValorantService({ key: 'k', statics, fetchFn: router({ matches: res(404, {}) }), fetchJson }).lookup({ name: 'Mino', tag: 'KR1' });
  assert.strictEqual(noMatches.ok, true);
  const limited = await createValorantService({ key: 'k', statics, fetchFn: router({ matches: res(429, {}) }), fetchJson }).lookup({ name: 'Mino', tag: 'KR1' });
  assert.strictEqual(limited.ok, false);
  const noKey = await createValorantService({ key: '', statics, fetchFn: router(), fetchJson }).lookup({ name: 'Mino', tag: 'KR1' });
  assert.strictEqual(noKey.ok, false);
  assert.ok(noKey.message.includes('키'));
  const nf = await createValorantService({ key: 'k', statics, fetchFn: router({ mmr: res(404, {}) }), fetchJson }).lookup({ name: 'Mino', tag: 'KR1' });
  assert.strictEqual(nf.ok, false);
  assert.ok(nf.message.includes('찾을 수 없'));
  // 같은 조회가 동시에 들어오면 한 번만 호출한다
  let calls = 0;
  const counting = createValorantService({ key: 'k', statics, fetchFn: async u => { calls++; return router()(u); }, fetchJson });
  await Promise.all([1, 2, 3].map(() => counting.lookup({ name: 'Mino', tag: 'KR1' })));
  assert.ok(calls <= 4, `동시 3번 조회가 mmr·경기 목록 호출을 합쳐 쓰는지(${calls}번)`);
  console.log('발로란트 테스트 통과');
})();

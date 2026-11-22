// Riot API 클라이언트 테스트: node tests/전적/리오트테스트.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const { createRiotClient, RiotError, riotErrorMessage } = require(path.join(root, 'handlers', '전적', '리오트.js'));
const fx = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

const KEY = 'RGAPI-secret-key-123';
const res = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => body, headers: { get: k => headers[k.toLowerCase()] ?? null } });
const fake = (...responses) => { const calls = []; let i = 0; const fn = async (url, opt) => { calls.push({ url, opt }); return responses[Math.min(i++, responses.length - 1)]; }; fn.calls = calls; return fn; };
const noLimit = () => { const penalties = []; return { schedule: f => f(), penalize: ms => penalties.push(ms), penalties }; };

(async () => {
  let f = fake(res(200, fx('riot-account.json')));
  let c = createRiotClient({ key: KEY, fetchFn: f, limiter: noLimit() });
  const acc = await c.accountByRiotId('Hide on bush', 'KR1');
  assert.strictEqual(acc.puuid, 'PUUID-ME');
  assert.strictEqual(f.calls[0].url, 'https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/Hide%20on%20bush/KR1');
  assert.strictEqual(f.calls[0].opt.headers['X-Riot-Token'], KEY);

  f = fake(res(200, fx('riot-league.json')));
  c = createRiotClient({ key: KEY, fetchFn: f, limiter: noLimit() });
  assert.strictEqual((await c.leagueEntries('P1')).length, 2);
  assert.strictEqual(f.calls[0].url, 'https://kr.api.riotgames.com/lol/league/v4/entries/by-puuid/P1');

  f = fake(res(200, { profileIconId: 29, summonerLevel: 742 }));
  c = createRiotClient({ key: KEY, fetchFn: f, limiter: noLimit() });
  assert.strictEqual((await c.summonerByPuuid('P1')).summonerLevel, 742);
  assert.strictEqual(f.calls[0].url, 'https://kr.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/P1');

  f = fake(res(200, ['KR_1', 'KR_2']));
  c = createRiotClient({ key: KEY, fetchFn: f, limiter: noLimit() });
  assert.deepStrictEqual(await c.matchIds('P1', { count: 20, queue: 420 }), ['KR_1', 'KR_2']);
  assert.strictEqual(f.calls[0].url, 'https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/P1/ids?start=0&count=20&queue=420');
  await c.matchIds('P1', { count: 20 });
  assert.ok(!f.calls[1].url.includes('queue='), '큐 없으면 queue 인자 생략');

  f = fake(res(200, fx('riot-match.json')));
  c = createRiotClient({ key: KEY, fetchFn: f, limiter: noLimit() });
  assert.strictEqual((await c.match('KR_1')).info.queueId, 420);
  assert.strictEqual(f.calls[0].url, 'https://asia.api.riotgames.com/lol/match/v5/matches/KR_1');

  // 오류 종류 + 키가 메시지에 안 들어감
  for (const [status, kind] of [[404, 'not_found'], [403, 'denied'], [401, 'denied'], [500, 'unavailable'], [503, 'unavailable']]) {
    c = createRiotClient({ key: KEY, fetchFn: fake(res(status, {})), limiter: noLimit() });
    await assert.rejects(c.accountByRiotId('a b c', 'KR1'), e => { assert.ok(e instanceof RiotError); assert.strictEqual(e.kind, kind); assert.ok(!e.message.includes(KEY)); return true; });
  }
  // 429: Retry-After 만큼 멈추고 한 번 재시도, 또 429면 rate
  const lim = noLimit();
  f = fake(res(429, {}, { 'retry-after': '2' }), res(200, fx('riot-account.json')));
  c = createRiotClient({ key: KEY, fetchFn: f, limiter: lim });
  assert.strictEqual((await c.accountByRiotId('a b c', 'KR1')).puuid, 'PUUID-ME');
  assert.deepStrictEqual(lim.penalties, [2000]);
  c = createRiotClient({ key: KEY, fetchFn: fake(res(429, {}, { 'retry-after': '1' })), limiter: noLimit() });
  await assert.rejects(c.accountByRiotId('a b c', 'KR1'), e => e.kind === 'rate');

  // 한국어 문구는 종류마다 다르다
  const msgs = ['not_found', 'denied', 'rate', 'unavailable'].map(kind => riotErrorMessage(new RiotError(kind, 0)));
  assert.strictEqual(new Set(msgs).size, 4);
  assert.ok(msgs[0].includes('찾을 수 없'));
  assert.ok(msgs[1].includes('키'));
  console.log('Riot 클라이언트 테스트 통과');
})();

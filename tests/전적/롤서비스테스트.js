// 롤 조회 서비스 테스트: node tests/전적/롤서비스테스트.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const { createLolService } = require(path.join(root, 'handlers', '전적', '롤.js'));
const { createMatchStore } = require(path.join(root, 'handlers', '전적', '경기저장.js'));
const { RiotError } = require(path.join(root, 'handlers', '전적', '리오트.js'));
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'riot-match.json'), 'utf8'));
const league = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'riot-league.json'), 'utf8'));

const rawMatch = (id, n, over = {}) => {
  const m = JSON.parse(JSON.stringify(raw));
  m.metadata.matchId = id;
  m.info.gameEndTimestamp = 1763800000000 - n * 3600000;
  Object.assign(m.info, over);
  return m;
};

function fakeRiot({ ids, matches = {}, fail } = {}) {
  const calls = { account: 0, summoner: 0, league: 0, ids: 0, match: 0, idsArgs: [] };
  const maybe = () => { if (fail) throw fail; };
  return {
    calls,
    accountByRiotId: async () => { calls.account++; maybe(); return { puuid: 'PUUID-ME', gameName: 'Mino', tagLine: 'KR1' }; },
    accountByPuuid: async () => { calls.account++; maybe(); return { puuid: 'PUUID-ME', gameName: 'Mino', tagLine: 'KR1' }; },
    summonerByPuuid: async () => { calls.summoner++; maybe(); return { profileIconId: 29, summonerLevel: 742 }; },
    leagueEntries: async () => { calls.league++; maybe(); return league; },
    matchIds: async (puuid, opt) => { calls.ids++; calls.idsArgs.push(opt); maybe(); return ids; },
    match: async id => { calls.match++; maybe(); return matches[id] ?? rawMatch(id, Number(id.split('_')[1])); },
  };
}
const statics = { load: async () => {}, champName: k => k, iconFile: async () => null };
const newStore = () => createMatchStore({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lol-')), 'm.json') });
const twenty = Array.from({ length: 20 }, (_, i) => 'KR_' + i);

(async () => {
  // (a) 첫 조회는 경기를 전부 받고, 같은 계정 두 번째 조회는 경기를 하나도 안 받는다
  let riot = fakeRiot({ ids: twenty });
  let seen = null;
  const svc = createLolService({ cacheMs: 0, riot, store: newStore(), statics, render: view => { seen = view; return Buffer.from('png'); } });
  let r = await svc.lookup({ name: 'Mino', tag: 'KR1' }, 'all');
  assert.strictEqual(r.ok, true);
  assert.ok(Buffer.isBuffer(r.png));
  assert.strictEqual(r.puuid, 'PUUID-ME');
  assert.strictEqual(riot.calls.match, 20, '첫 조회는 20경기');
  assert.strictEqual(seen.matches.length, 5, '목록은 5판');
  assert.strictEqual(seen.summary.games, 20, '통계는 20판');
  assert.strictEqual(seen.solo.tier, 'MASTER'); assert.strictEqual(seen.solo.lp, 606);
  assert.strictEqual(seen.flex.tier, 'DIAMOND');
  assert.strictEqual(seen.level, 742);
  await svc.lookup({ name: 'Mino', tag: 'KR1', puuid: 'PUUID-ME' }, 'all');
  assert.strictEqual(riot.calls.match, 20, '두 번째 조회는 match 호출 0번');
  assert.strictEqual(riot.calls.ids, 2);

  // (b) 새 경기 1개가 생기면 그 1개만 받는다
  riot.matchIds = async (puuid, opt) => { riot.calls.idsArgs.push(opt); return ['KR_NEW', ...twenty.slice(0, 19)]; };
  riot.calls.match = 0;
  await svc.lookup({ name: 'Mino', tag: 'KR1', puuid: 'PUUID-ME' }, 'all');
  assert.strictEqual(riot.calls.match, 1);

  // 큐 탭은 큐 id 로 목록을 요청한다
  const queuesOf = async tab => { const n = riot.calls.idsArgs.length; await svc.lookup({ name: 'Mino', tag: 'KR1', puuid: 'PUUID-ME' }, tab); return riot.calls.idsArgs.slice(n).map(a => a.queue).sort(); };
  assert.deepStrictEqual(await queuesOf('solo'), [420], '솔로랭크 탭');
  assert.deepStrictEqual(await queuesOf('flex'), [440], '자유랭크 탭');
  assert.deepStrictEqual(await queuesOf('arena'), [1700], '아레나 탭');
  assert.deepStrictEqual(await queuesOf('normal'), [400, 430, 490], '일반 탭: 일반 큐들');
  assert.deepStrictEqual(await queuesOf('aram'), [450], '칼바람 탭');
  assert.deepStrictEqual(await queuesOf('bogus'), [undefined], '모르는 탭은 전체');
  assert.ok(seen.icons.unranked && seen.icons.unranked.endsWith('rec_lol_unranked.png'), '언랭크 엠블럼 파일');
  assert.ok(seen.icons.positions?.MIDDLE?.endsWith('pos_lol_mid.png'), '선호 포지션 로고(미드)');

  // puuid 만 줘도(큐 탭 버튼) 이름은 계정 조회로 채워진다
  r = await svc.lookup({ puuid: 'PUUID-ME' }, 'all');
  assert.strictEqual(r.label, 'Mino#KR1');

  // 저장된 puuid 가 무효(키가 바뀜 → 400)면 이름으로 다시 찾아 성공한다
  riot = fakeRiot({ ids: [] });
  const realSummoner = riot.summonerByPuuid;
  riot.summonerByPuuid = async p => { if (p === 'STALE') throw new RiotError('unavailable', 400); return realSummoner(p); };
  const stale = await createLolService({ cacheMs: 0, riot, store: newStore(), statics, render: () => Buffer.from('png') }).lookup({ name: 'Mino', tag: 'KR1', puuid: 'STALE' }, 'all');
  assert.strictEqual(stale.ok, true);
  assert.strictEqual(stale.puuid, 'PUUID-ME', '새 puuid 로 바뀜');

  // 같은 조회가 동시에 들어오면 한 번만 호출한다(큐 탭 연타)
  riot = fakeRiot({ ids: twenty });
  const svcC = createLolService({ cacheMs: 0, riot, store: newStore(), statics, render: () => Buffer.from('png') });
  await Promise.all([1, 2, 3].map(() => svcC.lookup({ name: 'Mino', tag: 'KR1', puuid: 'PUUID-ME' }, 'aram')));
  assert.strictEqual(riot.calls.ids, 1, '동시에 같은 조회는 한 번만(칼바람 큐 1개)');
  assert.strictEqual(riot.calls.match, 20);

  // 계정 연결 확인: 롤 소환사가 없는(발로란트만 하는) Riot 계정은 연결 확인에서 걸러진다
  riot = fakeRiot({ ids: [] });
  const svcV = createLolService({ cacheMs: 0, riot, store: newStore(), statics, render: () => null });
  assert.deepStrictEqual(await svcV.verify('Mino', 'KR1'), { puuid: 'PUUID-ME', name: 'Mino', tag: 'KR1' });
  riot.summonerByPuuid = async () => { throw new RiotError('not_found', 404); };
  await assert.rejects(svcV.verify('Mino', 'KR1'), e => e.kind === 'not_found');

  // (c) 경기가 0개인 계정도 ok
  riot = fakeRiot({ ids: [] });
  r = await createLolService({ cacheMs: 0, riot, store: newStore(), statics, render: () => Buffer.from('png') }).lookup({ name: 'Mino', tag: 'KR1' }, 'all');
  assert.strictEqual(r.ok, true);

  // 다시하기(3분 미만)는 기록하지 않고, 다시 조회해도 다시 받지 않는다
  riot = fakeRiot({ ids: ['KR_0', 'KR_1'], matches: { KR_1: rawMatch('KR_1', 1, { gameDuration: 120 }) } });
  const svc2 = createLolService({ cacheMs: 0, riot, store: newStore(), statics, render: v => { seen = v; return Buffer.from('png'); } });
  await svc2.lookup({ name: 'Mino', tag: 'KR1' }, 'all');
  assert.strictEqual(seen.summary.games, 1, '다시하기는 통계에서 빠짐');
  await svc2.lookup({ name: 'Mino', tag: 'KR1', puuid: 'PUUID-ME' }, 'all');
  assert.strictEqual(riot.calls.match, 2, '다시하기 경기를 두 번 받지 않음');

  // (d) Riot 오류는 한국어 문구로, 예외는 밖으로 새지 않는다
  const messages = new Set();
  for (const kind of ['not_found', 'denied', 'rate', 'unavailable']) {
    const out = await createLolService({ cacheMs: 0, riot: fakeRiot({ ids: [], fail: new RiotError(kind, 0) }), store: newStore(), statics, render: () => null }).lookup({ name: 'Mino', tag: 'KR1' }, 'all');
    assert.strictEqual(out.ok, false);
    assert.ok(out.message.length > 5);
    messages.add(out.message);
  }
  assert.strictEqual(messages.size, 4, '오류 종류마다 다른 문구');
  const weird = await createLolService({ cacheMs: 0, riot: fakeRiot({ ids: [], fail: new TypeError('boom') }), store: newStore(), statics, render: () => null }).lookup({ name: 'Mino', tag: 'KR1' }, 'all');
  assert.strictEqual(weird.ok, false, '예상 못한 오류도 ok:false 로');

  // (e) 그림을 못 그리면 png 는 null, text 가 있다
  riot = fakeRiot({ ids: twenty });
  r = await createLolService({ cacheMs: 0, riot, store: newStore(), statics, render: () => null }).lookup({ name: 'Mino', tag: 'KR1' }, 'all');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.png, null);
  assert.ok(r.text.includes('마스터') && r.text.length > 20);
  // 미리 데우기: 정적 데이터(이름·아이콘 주소)를 미리 불러 둔다
  let loads = 0;
  await createLolService({ riot: fakeRiot({ ids: [] }), store: newStore(), statics: { ...statics, load: async () => { loads++; } }, render: () => null }).warm();
  assert.strictEqual(loads, 1, 'warm 이 정적 데이터를 불러온다');

  // 속도: 탭을 바꿔도 계정·랭크·경기 목록 호출을 다시 하지 않고, 같은 탭의 완성된 그림은 다시 그리지 않는다
  let clock = 5_000_000;
  riot = fakeRiot({ ids: twenty });
  const renders = [];
  const fast = createLolService({ riot, store: newStore(), statics, now: () => clock, cacheMs: 60000, render: v => { renders.push(v.queue); return Buffer.from('png'); } });
  const T = { puuid: 'PUUID-ME' }; // 탭 버튼은 puuid 만 들고 온다
  await fast.lookup(T, 'all');
  const first1 = { acc: riot.calls.account, summoner: riot.calls.summoner, league: riot.calls.league, ids: riot.calls.ids };
  await fast.lookup(T, 'all');
  assert.deepStrictEqual(renders, ['all'], '같은 탭을 다시 열면 그림을 다시 그리지 않는다');
  assert.strictEqual(riot.calls.ids, first1.ids, '같은 탭은 호출도 없다');
  await fast.lookup(T, 'aram');
  assert.strictEqual(riot.calls.account, first1.acc, '이름 조회는 다시 하지 않는다');
  assert.strictEqual(riot.calls.summoner, first1.summoner, '레벨은 다시 받지 않는다');
  assert.strictEqual(riot.calls.league, first1.league, '랭크는 다시 받지 않는다');
  assert.strictEqual(riot.calls.ids, first1.ids + 1, '다른 탭의 경기 목록만 새로 받는다');
  await fast.lookup(T, 'aram');
  assert.strictEqual(riot.calls.ids, first1.ids + 1, '그 탭도 두 번째부터는 호출 없음');
  assert.deepStrictEqual(renders, ['all', 'aram']);
  clock += 61000;
  await fast.lookup(T, 'all');
  assert.strictEqual(riot.calls.summoner, first1.summoner + 1, '시간이 지나면 새로 받는다');
  assert.deepStrictEqual(renders, ['all', 'aram', 'all']);
  // 실패는 캐시하지 않는다
  const flaky = fakeRiot({ ids: twenty, fail: new RiotError('rate', 429) });
  const f2 = createLolService({ riot: flaky, store: newStore(), statics, now: () => clock, cacheMs: 60000, render: () => Buffer.from('png') });
  assert.strictEqual((await f2.lookup(T, 'all')).ok, false);
  flaky.matchIds = async () => twenty;
  for (const k of ['accountByPuuid', 'summonerByPuuid', 'leagueEntries', 'match']) { const orig = fakeRiot({ ids: twenty })[k]; flaky[k] = orig; }
  assert.strictEqual((await f2.lookup(T, 'all')).ok, true, '실패 뒤에는 다시 시도해 성공');
  console.log('롤 서비스 테스트 통과');
})();

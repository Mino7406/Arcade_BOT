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
  const svc = createLolService({ riot, store: newStore(), statics, render: view => { seen = view; return Buffer.from('png'); } });
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
  await svc.lookup({ name: 'Mino', tag: 'KR1', puuid: 'PUUID-ME' }, 'solo');
  await svc.lookup({ name: 'Mino', tag: 'KR1', puuid: 'PUUID-ME' }, 'flex');
  assert.strictEqual(riot.calls.idsArgs.at(-2).queue, 420);
  assert.strictEqual(riot.calls.idsArgs.at(-1).queue, 440);

  // puuid 만 줘도(큐 탭 버튼) 이름은 계정 조회로 채워진다
  r = await svc.lookup({ puuid: 'PUUID-ME' }, 'all');
  assert.strictEqual(r.label, 'Mino#KR1');

  // (c) 경기가 0개인 계정도 ok
  riot = fakeRiot({ ids: [] });
  r = await createLolService({ riot, store: newStore(), statics, render: () => Buffer.from('png') }).lookup({ name: 'Mino', tag: 'KR1' }, 'all');
  assert.strictEqual(r.ok, true);

  // 다시하기(3분 미만)는 기록하지 않고, 다시 조회해도 다시 받지 않는다
  riot = fakeRiot({ ids: ['KR_0', 'KR_1'], matches: { KR_1: rawMatch('KR_1', 1, { gameDuration: 120 }) } });
  const svc2 = createLolService({ riot, store: newStore(), statics, render: v => { seen = v; return Buffer.from('png'); } });
  await svc2.lookup({ name: 'Mino', tag: 'KR1' }, 'all');
  assert.strictEqual(seen.summary.games, 1, '다시하기는 통계에서 빠짐');
  await svc2.lookup({ name: 'Mino', tag: 'KR1', puuid: 'PUUID-ME' }, 'all');
  assert.strictEqual(riot.calls.match, 2, '다시하기 경기를 두 번 받지 않음');

  // (d) Riot 오류는 한국어 문구로, 예외는 밖으로 새지 않는다
  const messages = new Set();
  for (const kind of ['not_found', 'denied', 'rate', 'unavailable']) {
    const out = await createLolService({ riot: fakeRiot({ ids: [], fail: new RiotError(kind, 0) }), store: newStore(), statics, render: () => null }).lookup({ name: 'Mino', tag: 'KR1' }, 'all');
    assert.strictEqual(out.ok, false);
    assert.ok(out.message.length > 5);
    messages.add(out.message);
  }
  assert.strictEqual(messages.size, 4, '오류 종류마다 다른 문구');
  const weird = await createLolService({ riot: fakeRiot({ ids: [], fail: new TypeError('boom') }), store: newStore(), statics, render: () => null }).lookup({ name: 'Mino', tag: 'KR1' }, 'all');
  assert.strictEqual(weird.ok, false, '예상 못한 오류도 ok:false 로');

  // (e) 그림을 못 그리면 png 는 null, text 가 있다
  riot = fakeRiot({ ids: twenty });
  r = await createLolService({ riot, store: newStore(), statics, render: () => null }).lookup({ name: 'Mino', tag: 'KR1' }, 'all');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.png, null);
  assert.ok(r.text.includes('마스터') && r.text.length > 20);
  console.log('롤 서비스 테스트 통과');
})();

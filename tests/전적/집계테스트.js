// 경기 추리기·저장소·집계 테스트: node tests/전적/집계테스트.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const { compactMatch, ratio, killParticipation, summarize, queueLabel } = require(path.join(root, 'handlers', '전적', '집계.js'));
const { createMatchStore } = require(path.join(root, 'handlers', '전적', '경기저장.js'));
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'riot-match.json'), 'utf8'));

// compactMatch
const m = compactMatch(raw, 'PUUID-ME');
assert.strictEqual(m.id, 'KR_1');
assert.strictEqual(m.queue, 420);
assert.strictEqual(m.win, true);
assert.strictEqual(m.champ, 'Yone');
assert.deepStrictEqual([m.k, m.d, m.a], [8, 3, 6]);
assert.strictEqual(m.cs, 192, '미니언 180 + 정글 12');
assert.deepStrictEqual(m.items, [3031, 3006, 3046, 3087, 0, 3036, 3363]);
assert.deepStrictEqual(m.spells, [4, 14]);
assert.strictEqual(m.keystone, 8010);
assert.strictEqual(m.subStyle, 8100);
assert.strictEqual(m.vision, 2);
assert.strictEqual(m.pos, 'MIDDLE');
assert.strictEqual(m.multi, 2, '더블킬 1회 → 2');
assert.strictEqual(m.teamKills, 16, '같은 팀 킬 합(8+2*4)');
assert.strictEqual(m.dur, 1685);
assert.strictEqual(compactMatch(raw, 'PUUID-NOBODY'), null, '없는 puuid');
const remake = JSON.parse(JSON.stringify(raw)); remake.info.gameDuration = 170;
assert.strictEqual(compactMatch(remake, 'PUUID-ME'), null, '3분 미만(다시하기)');

const early = JSON.parse(JSON.stringify(raw)); early.info.gameDuration = 200; early.info.participants.forEach(x => { x.gameEndedInEarlySurrender = true; });
assert.strictEqual(compactMatch(early, 'PUUID-ME'), null, '3분 넘게 걸린 다시하기(조기 항복)도 기록하지 않음');

// 평점·킬관여
assert.ok(Math.abs(ratio(8, 3, 6) - 14 / 3) < 1e-9);
assert.strictEqual(ratio(5, 0, 5), null, '데스 0 → 평점 없음(화면에서 Perfect)');
assert.ok(Math.abs(killParticipation(m) - 14 / 16) < 1e-9);
assert.strictEqual(killParticipation({ k: 0, a: 0, teamKills: 0 }), 0);

// summarize
const empty = summarize([]);
assert.deepStrictEqual([empty.games, empty.wins, empty.losses, empty.avgK, empty.avgD, empty.avgA], [0, 0, 0, 0, 0, 0]);
assert.strictEqual(empty.rating, null);
assert.deepStrictEqual(empty.champs, []);
assert.deepStrictEqual(empty.positions, []);
const mk = (champ, win, k, d, a, pos) => ({ champ, win, k, d, a, pos });
const s = summarize([mk('Yone', true, 8, 2, 6, 'MIDDLE'), mk('Yone', false, 2, 6, 2, 'MIDDLE'), mk('Azir', true, 5, 1, 9, 'MIDDLE'), mk('Viego', false, 1, 5, 4, 'JUNGLE'), mk('Ahri', true, 3, 3, 3, '')]);
assert.strictEqual(s.games, 5); assert.strictEqual(s.wins, 3); assert.strictEqual(s.losses, 2);
assert.ok(Math.abs(s.avgK - 19 / 5) < 1e-9);
assert.ok(Math.abs(s.rating - (19 + 24) / 17) < 1e-9, '평점 = 전체 (K+A)/D');
assert.strictEqual(s.champs[0].champ, 'Yone'); assert.strictEqual(s.champs[0].games, 2); assert.strictEqual(s.champs[0].wins, 1);
assert.ok(s.champs.length <= 3);
assert.deepStrictEqual(s.positions.map(p => [p.pos, p.games, p.wins]), [['MIDDLE', 3, 2], ['JUNGLE', 1, 0]], '포지션 빈 값 제외, 상위 2');
const perfect = summarize([mk('Yone', true, 5, 0, 5, 'TOP')]);
assert.strictEqual(perfect.rating, null, '데스 0이면 NaN/무한대 없이 null');

// 큐 이름
assert.strictEqual(queueLabel(420), '솔로랭크');
assert.strictEqual(queueLabel(440), '자유랭크');
assert.strictEqual(queueLabel(999), '일반 게임', '모르는 큐');

// 저장소
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rec-')), 'matches.json');
const store = createMatchStore({ file, keep: 100 });
for (let i = 0; i < 105; i++) store.add('P1', { id: 'KR_' + i, ts: 1000 + i, queue: i % 2 ? 420 : 440 });
assert.strictEqual(store.list('P1').length, 100);
assert.strictEqual(store.has('P1', 'KR_0'), false, '가장 오래된 5개가 사라짐');
assert.strictEqual(store.has('P1', 'KR_4'), false);
assert.strictEqual(store.has('P1', 'KR_5'), true);
assert.strictEqual(store.list('P1')[0].id, 'KR_104', '최근순');
store.add('P1', { id: 'KR_104', ts: 1104, queue: 440 });
assert.strictEqual(store.list('P1').length, 100, '같은 id 두 번 → 한 개');
assert.ok(store.list('P1', 420).every(x => x.queue === 420));
assert.deepStrictEqual(store.list('nobody'), []);
store.save();
const again = createMatchStore({ file, keep: 100 }); again.load();
assert.strictEqual(again.list('P1').length, 100, '저장 후 다시 읽기');
// 사람 수 상한: 가장 오래 안 쓴 사람부터 지운다
const capped = createMatchStore({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rec-')), 'c.json'), keep: 100, maxPlayers: 3 });
for (let n = 1; n <= 5; n++) capped.add('P' + n, { id: 'M' + n, ts: n * 1000, queue: 420 });
assert.deepStrictEqual([1, 2, 3, 4, 5].map(n => capped.list('P' + n).length), [0, 0, 1, 1, 1], '최근 3명만 남음');
// 바뀐 게 없으면 저장하지 않는다(30초마다 도는 자동 저장이 큰 JSON 을 매번 직렬화하지 않게)
const dirtyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rec-')), 'd.json');
const dirtyStore = createMatchStore({ file: dirtyFile, keep: 100 });
dirtyStore.save();
assert.ok(!fs.existsSync(dirtyFile), '아무것도 안 넣었으면 파일을 만들지 않음');
dirtyStore.add('P1', { id: 'M1', ts: 1, queue: 420 });
dirtyStore.save();
assert.ok(fs.existsSync(dirtyFile), '넣었으면 저장');
fs.unlinkSync(dirtyFile);
dirtyStore.save();
assert.ok(!fs.existsSync(dirtyFile), '그 뒤로 바뀐 게 없으면 다시 쓰지 않음');
dirtyStore.add('P1', { id: 'M2', ts: 2, queue: 420 });
dirtyStore.save();
assert.ok(fs.existsSync(dirtyFile), '다시 바뀌면 저장');
console.log('집계·저장소 테스트 통과');

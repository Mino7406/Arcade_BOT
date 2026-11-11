// 패치노트 감시 테스트: node tests/패치노트테스트.js
// 네트워크·디스코드 없이 파서와 "새 글만 공지" 규칙을 확인한다. 기록 파일은 임시 폴더에만 쓴다.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createWatcher, buildPatchNotePayload, parseRiotPatches, parseOverwatchPatches, parsePubgPatches,
  parseRiotMaintenances, POLL_MS, MAX_BACKOFF, describeFetchError,
} = require('../handlers/패치노트');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patchnote-'));
let n = 0;
const newStore = () => path.join(tmp, `s${n++}.json`);
const E = (key, at = 0) => ({ key, title: `글 ${key}`, url: `https://x/${key}`, at });

// ── 파서 ──
test('라이엇: "패치 노트" 제목 글만, 주소·시각 추출, 중복 제거', () => {
  const data = { a: { items: [
    { title: '리그 오브 레전드 26.22 패치 노트', action: { payload: { url: '/ko-kr/news/game-updates/p-26-22' } }, analytics: { publishDate: '2026-11-03T19:00:00.000Z' } },
    { title: '리그 오브 레전드 26.22 패치 노트', action: { payload: { url: '/ko-kr/news/game-updates/p-26-22' } } },
    { title: '신규 스킨 소개', action: { payload: { url: '/ko-kr/news/x' } } },
    { title: '26.21 패치 노트', action: { payload: { url: 'https://abs.example/p-26-21' } } },
  ] } };
  const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></html>`;
  const r = parseRiotPatches(html, 'https://base');
  assert.deepStrictEqual(r.map(e => e.key).sort(), ['https://abs.example/p-26-21', 'https://base/ko-kr/news/game-updates/p-26-22']);
  assert.strictEqual(r.find(e => e.url.endsWith('p-26-22')).at, Date.parse('2026-11-03T19:00:00.000Z'));
  assert.deepStrictEqual(parseRiotPatches('<html>no data</html>', 'https://base'), []);
  assert.deepStrictEqual(parseRiotPatches('<script id="__NEXT_DATA__">{broken</script>', 'https://base'), []);
});

test('오버워치: 날짜 제목 추출, 같은 날짜는 하나로', () => {
  const html = '<h2>오버워치 패치 노트 - 2026년 11월 6일</h2>..<h2>오버워치 패치 노트 - 2026년 11월 4일</h2>..<a>오버워치 패치 노트 - 2026년 11월 6일</a>';
  const r = parseOverwatchPatches(html, 'https://ow/page/');
  assert.deepStrictEqual(r.map(e => e.key), ['ow-2026-11-06', 'ow-2026-11-04']);
  assert.strictEqual(r[0].at, Date.UTC(2026, 10, 6) - 9 * 3600_000); // 한국 시간 자정
});

const pubgJson = posts => JSON.stringify({ _embedded: { post: posts } });
const post = (id, title, category, start, labels = ['label_pc', 'label_console']) => ({ postId: id, title, category, displayStartTime: start, labels });

test('배그: 패치노트 분류만, 예약 글 제외, PC/콘솔 표시, 주소', () => {
  const now = Date.parse('2026-11-03T12:00:00+09:00');
  const r = parsePubgPatches(pubgJson([
    post(1, '패치 노트 - 업데이트 44.1', 'patch_notes', '2026-11-03 06:00:00'),
    post(2, '패치 노트 - 업데이트 44.2', 'patch_notes', '2026-11-17 06:00:00'),
    post(3, '상점 안내', 'notice', '2026-11-03 06:00:00'),
  ]), now);
  assert.deepStrictEqual(r.map(e => e.key), ['pubg-1']);
  assert.strictEqual(r[0].url, 'https://www.pubg.com/ko/news/1');
  assert.strictEqual(r[0].note, 'PC · 콘솔');
});

test('배그 점검: 공지 중 제목에 "점검"이 든 글만', () => {
  const r = parsePubgPatches(pubgJson([
    post(10, '[점검] 11월 정기점검 안내', 'notice', '2026-11-03 06:00:00'),
    post(11, '2026년 11월 상점 안내', 'notice', '2026-11-03 06:00:00'),
    post(12, '패치 노트 - 업데이트 44.1 점검', 'patch_notes', '2026-11-03 06:00:00'),
  ]), Date.now(), { category: 'notice', titleHas: '점검' });
  assert.deepStrictEqual(r.map(e => e.key), ['pubg-10']);
});

test('배그: 깨진 응답은 빈 목록', () => {
  assert.deepStrictEqual(parsePubgPatches('nope'), []);
  assert.deepStrictEqual(parsePubgPatches('{}'), []);
});

test('라이엇 점검: 한국어 제목 우선, 없으면 영어, 둘 다 없으면 기본 문구', () => {
  const json = JSON.stringify({ maintenances: [
    { id: 7, created_at: '2026-11-11T01:00:00.000Z', titles: [{ locale: 'en_US', content: 'Maintenance' }, { locale: 'ko_KR', content: '정기 점검' }] },
    { id: 8, titles: [{ locale: 'en_US', content: 'Only English' }] },
    { id: 9, titles: [] },
  ], incidents: [{ id: 99, titles: [{ locale: 'ko_KR', content: '장애' }] }] });
  const r = parseRiotMaintenances(json, 'https://status');
  assert.deepStrictEqual(r.map(e => [e.key, e.title]), [['maint-7', '정기 점검'], ['maint-8', 'Only English'], ['maint-9', '점검 안내']]);
  assert.deepStrictEqual(parseRiotMaintenances('{"maintenances":[],"incidents":[]}', 'u'), []);
  assert.deepStrictEqual(parseRiotMaintenances('garbage', 'u'), []);
});

// ── 감시 규칙 ──
const mkWatcher = (list, extra = {}) => {
  const sent = [];
  const game = { id: 'g', kind: 'patch', name: 'G', load: async () => list.slice(), ...extra.game };
  const storePath = extra.storePath ?? newStore();
  const w = createWatcher({ games: [game], send: extra.send ?? (async (_g, e) => { sent.push(e.key); }), storePath, now: extra.now, logFail: extra.logFail, logInfo: extra.logInfo });
  return { w, game, sent, storePath };
};

test('처음 확인: 이미 올라와 있는 글은 기억만 하고 공지하지 않는다', async () => {
  const list = [E('a', 1), E('b', 2)];
  const { w, game, sent } = mkWatcher(list);
  assert.strictEqual(await w.checkGame(game), 0);
  assert.deepStrictEqual(sent, []);
});

test('그 뒤 새 글이 올라오면 한 번만 공지(재확인·재시작에도 다시 안 보냄)', async () => {
  const list = [E('a', 1)];
  const { w, game, sent, storePath } = mkWatcher(list);
  await w.checkGame(game);
  list.unshift(E('b', 2));
  assert.strictEqual(await w.checkGame(game), 1);
  await w.checkGame(game);
  assert.deepStrictEqual(sent, ['b']);
  // 봇 재시작(기록 파일에서 복원)
  const again = createWatcher({ games: [game], send: async (_g, e) => sent.push(e.key), storePath });
  await again.checkGame({ ...game, load: async () => list.slice() });
  assert.deepStrictEqual(sent, ['b']);
});

test('제목이 바뀌거나 순서가 달라져도 키가 같으면 다시 공지하지 않는다', async () => {
  const list = [E('a', 1), E('b', 2)];
  const { w, game, sent } = mkWatcher(list);
  await w.checkGame(game);
  list.reverse();
  list[0] = { ...list[0], title: '제목이 수정됨' };
  await w.checkGame(game);
  assert.deepStrictEqual(sent, []);
});

test('전송 실패하면 기록하지 않아 다음 확인 때 다시 시도', async () => {
  const list = [E('a', 1)];
  let fail = true;
  const sent = [];
  const { w, game } = mkWatcher(list, { send: async (_g, e) => { if (fail) throw new Error('디스코드 오류'); sent.push(e.key); } });
  await w.checkGame(game);
  list.push(E('b', 2));
  await assert.rejects(() => w.checkGame(game), /디스코드 오류/);
  fail = false;
  assert.strictEqual(await w.checkGame(game), 1);
  assert.deepStrictEqual(sent, ['b']);
});

test('새 글이 여러 개면 오래된 것부터 순서대로', async () => {
  const list = [E('a', 1)];
  const { w, game, sent } = mkWatcher(list);
  await w.checkGame(game);
  list.push(E('c', 30), E('b', 20));
  await w.checkGame(game);
  assert.deepStrictEqual(sent, ['b', 'c']);
});

test('한꺼번에 새 글이 4개 이상이면 구조 변경으로 보고 공지 없이 기억만', async () => {
  const list = [E('a', 1)];
  const infos = [];
  const { w, game, sent } = mkWatcher(list, { logInfo: m => infos.push(m) });
  await w.checkGame(game);
  list.push(E('b', 2), E('c', 3), E('d', 4), E('e', 5));
  assert.strictEqual(await w.checkGame(game), 0);
  assert.deepStrictEqual(sent, []);
  assert.strictEqual(infos.length, 1);
  await w.checkGame(game);
  assert.deepStrictEqual(sent, []); // 다음 확인 때도 안 보냄
});

test('목록이 비어 읽히면 실패(기억하지 않음) — 이후 정상 목록이 와도 도배하지 않는다', async () => {
  let list = [];
  const { w, game, sent } = mkWatcher(() => list);
  game.load = async () => list.slice();
  await assert.rejects(() => w.checkGame(game), /비어/);
  list = [E('a', 1), E('b', 2)];
  assert.strictEqual(await w.checkGame(game), 0); // 이제서야 처음 기억
  assert.deepStrictEqual(sent, []);
});

test('점검처럼 비어 있는 게 정상인 목록: 빈 채로 기억하고 이후 새 점검은 공지', async () => {
  const list = [];
  const { w, game, sent } = mkWatcher(list, { game: { allowEmpty: true } });
  assert.strictEqual(await w.checkGame(game), 0);
  list.push(E('maint-1', 5));
  assert.strictEqual(await w.checkGame(game), 1);
  await w.checkGame(game);
  assert.deepStrictEqual(sent, ['maint-1']);
});

test('기록 파일이 깨져 있어도 도배하지 않고 다시 기억만 한다', async () => {
  const storePath = newStore();
  fs.writeFileSync(storePath, '{깨진 json');
  const infos = [];
  const { w, game, sent } = mkWatcher([E('a', 1), E('b', 2)], { storePath, logInfo: m => infos.push(m) });
  assert.strictEqual(await w.checkGame(game), 0);
  assert.deepStrictEqual(sent, []);
  assert.strictEqual(infos.length, 1);
});

test('tick: 연속 실패하면 간격이 1→2→4배…최대 배수로 늘고, 성공하면 원래대로', async () => {
  let t = 1_000_000;
  let ok = false;
  let calls = 0;
  const game = { id: 'g', kind: 'patch', name: 'G', load: async () => { calls++; if (!ok) throw new Error('접속 실패'); return [E('a', 1)]; } };
  const w = createWatcher({ games: [game], send: async () => {}, storePath: newStore(), now: () => t });
  await w.tick(); // 실패 1회째 → 다음은 1배 뒤
  for (const mult of [1, 2, 4, MAX_BACKOFF, MAX_BACKOFF]) {
    const before = calls;
    t += mult * POLL_MS - 1;
    await w.tick();
    assert.strictEqual(calls, before, `${mult}배 간격 1ms 전에는 확인하지 않아야 한다`);
    t += 1;
    await w.tick();
    assert.strictEqual(calls, before + 1, `${mult}배 간격이 되면 확인해야 한다`);
  }
  ok = true;
  t += MAX_BACKOFF * POLL_MS;
  await w.tick(); // 성공 → 실패 횟수 초기화(다음은 1배 간격)
  const before = calls;
  t += POLL_MS - 1;
  await w.tick();
  assert.strictEqual(calls, before);
  t += 1;
  await w.tick();
  assert.strictEqual(calls, before + 1);
});

test('tick: 한 번 실패는 로그 없이 넘기고, 연달아 실패하면 남기고, 회복되면 알린다', async () => {
  let t = 1_000_000;
  let ok = false;
  const fails = [], infos = [];
  const game = { id: 'g', kind: 'maintenance', allowEmpty: true, name: 'G', load: async () => { if (!ok) throw new Error('fetch failed'); return []; } };
  const w = createWatcher({ games: [game], send: async () => {}, storePath: newStore(), now: () => t,
    logFail: (_g, _e, n) => fails.push(n), logInfo: m => infos.push(m) });
  await w.tick();
  assert.deepStrictEqual(fails, [], '1회 실패는 남기지 않음');
  t += POLL_MS; await w.tick();
  assert.deepStrictEqual(fails, [2], '2회 연속이면 남김(연속 횟수 함께)');
  ok = true;
  t += 2 * POLL_MS; await w.tick();
  assert.deepStrictEqual(infos, ['G 점검 공지 확인 다시 정상(연속 실패 2회 뒤)']);
  ok = false;
  t += POLL_MS; await w.tick();
  ok = true;
  t += POLL_MS; await w.tick();
  assert.deepStrictEqual(fails, [2], '한 번 실패 뒤 바로 회복하면 실패·회복 로그 둘 다 없음');
  assert.strictEqual(infos.length, 1);
});

test('fetch 실패 문구: cause 코드와 시간 초과를 보여준다', () => {
  const e = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }) });
  assert.strictEqual(describeFetchError(e, 'https://x'), 'fetch failed [ENOTFOUND] (https://x)');
  const to = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
  assert.strictEqual(describeFetchError(to, 'https://x'), '응답 시간 초과(15초) (https://x)');
});

// ── 카드 ──
test('카드: 컴포넌트 v2 컨테이너·썸네일 섹션·링크 버튼, 게임 색, 점검은 문구가 다름', () => {
  const game = { id: 'lol', kind: 'patch', name: '리그 오브 레전드', color: 0xc89b3c, emojiId: '1510933684750913626' };
  const p = buildPatchNotePayload(game, { key: 'k', title: '26.22 패치 노트', url: 'https://x/p', at: Date.parse('2026-11-12T03:00:00+09:00'), note: 'PC · 콘솔' });
  assert.ok(p.flags & (1 << 15), 'IsComponentsV2 플래그');
  assert.deepStrictEqual(p.allowedMentions, { parse: [] });
  const c = p.components[0].toJSON();
  assert.strictEqual(c.type, 17);
  assert.strictEqual(c.accent_color, 0xc89b3c);
  const section = c.components[0];
  assert.strictEqual(section.type, 9);
  assert.strictEqual(section.accessory.type, 11);
  assert.strictEqual(section.accessory.media.url, 'https://cdn.discordapp.com/emojis/1510933684750913626.png?size=128');
  const texts = section.components.map(x => x.content);
  assert.ok(texts[0].includes('리그 오브 레전드') && texts[0].includes('새 패치노트'));
  assert.ok(texts[1].includes('26.22 패치 노트'));
  assert.ok(texts[2].includes('11월 12일 게시') && texts[2].includes('PC · 콘솔'));
  const btn = c.components[1].components[0];
  assert.strictEqual(btn.style, 5);
  assert.strictEqual(btn.url, 'https://x/p');
  assert.strictEqual(btn.label, '내용 보기');

  const m = buildPatchNotePayload({ ...game, kind: 'maintenance' }, { key: 'k', title: '정기 점검', url: 'https://x/s', at: null }).components[0].toJSON();
  assert.ok(m.components[0].components[0].content.includes('점검 공지'));
  assert.strictEqual(m.components[1].components[0].label, '내용 보기');
  assert.strictEqual(m.components[0].components.length, 2); // 날짜·표시가 없으면 줄이 없다
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.stack?.split('\n').slice(0, 4).join('\n      ')}`); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed}/${tests.length} 통과${failed ? `, ${failed} 실패` : ''}`);
  process.exit(failed ? 1 : 0);
})();

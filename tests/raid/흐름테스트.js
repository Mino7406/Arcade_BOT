// 레이드 전체 흐름 통합 테스트: 실제 discord.js 빌더 + 가짜 채널/인터랙션, 타이머는 수동 실행.
// 직접 실행하지 말고 node tests/raid/실행.js 로 — 임시 폴더에 handlers 등을 복사해 그 안에서 돌린다(DB/를 건드리지 않게).
const path = require('path');
const fs = require('fs');
const root = __dirname;
const timers = [];
global.setTimeout = (fn, ms) => { const t = { fn, ms, cancelled: false, unref() { return t; } }; timers.push(t); return t; };
global.clearTimeout = (t) => { if (t) t.cancelled = true; };
const realSetInterval = setInterval;
const intervals = []; // 스케줄러 같은 주기 작업은 실행하지 않고 모아 두기만 한다(테스트에서 직접 부름)
global.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return { unref() {} }; };
// 화면 대기열 타이머(짧음)와 게임 타이머(모집 마감·턴, 김)를 구분해 실행한다.
async function flushRender() {
  for (let guard = 0; guard < 50; guard++) {
    const due = timers.filter(t => !t.cancelled && t.ms <= 1000);
    if (!due.length) { await new Promise(r => setImmediate(r)); if (!timers.some(t => !t.cancelled && t.ms <= 1000)) return; continue; }
    for (const t of due) { timers.splice(timers.indexOf(t), 1); await t.fn(); }
    await new Promise(r => setImmediate(r));
  }
}
const runTimers = async () => { const due = timers.filter(t => !t.cancelled && t.ms > 1000); for (const t of due) { timers.splice(timers.indexOf(t), 1); await t.fn(); } await flushRender(); };

const raidMod = require(path.join(root, 'handlers/레이드.js'));
const origHandle = raidMod.handleRaidButton, origEnd = raidMod.forceEndRaid, origSpawn = raidMod.forceSpawnRaid;
raidMod.handleRaidButton = async (it) => { await origHandle(it); await flushRender(); };
raidMod.forceEndRaid = async (g = 'gMain') => { const v = await origEnd(g); await flushRender(); return v; };
raidMod.forceSpawnRaid = async (...a) => { const v = await origSpawn(...a); await flushRender(); return v; };
const lv = require(path.join(root, 'handlers/레벨링.js'));
const assert = (c, m) => { if (!c) { console.error('❌', m); process.exitCode = 1; } else console.log('✅', m); };

const sent = [];
let current = null; // 레이드 메시지 최신 payload
let lastEdit = null; const editTurns = [];
const message = { id: 'msg1', channel: null, edit: async (p) => { current = p; lastEdit = p; if (p.files) images.push(p.files[0].attachment); const m = desc().match(/TURN (\d+)/); if (m) editTurns.push(+m[1]); return message; } };
const channel = { id: 'ch1', guildId: 'gMain', name: '놀이터', send: async (p) => { sent.push(p); if (!message.channel) { message.channel = channel; current = p; if (p.files) images.push(p.files[0].attachment); return message; } return { id: 'x' }; } };
const client = { channels: { fetch: async () => channel }, guilds: { cache: new Map() } };
const parts = () => current.components.map(c => c.toJSON()).flatMap(c => (c.type === 17 ? c.components : [c]));
const desc = () => parts().filter(c => c.type === 10).map(c => c.content).join('\n');
const buttons = () => parts().filter(c => c.type === 1).flatMap(r => r.components);
const hasImage = () => parts().some(c => c.type === 12);
const images = [];

function fakeInteraction(userId, customId) {
  const it = {
    customId, guildId: 'gMain', user: { id: userId, username: 'u' + userId }, member: { displayName: '유저' + userId },
    message, replied: null, updated: null,
    reply: async (p) => { it.replied = p; },
    deferUpdate: async () => { it.deferred = true; },
    update: async (p) => { it.updated = p; current = p; if (p.files) images.push(p.files[0].attachment); return { resource: { message: null } }; },
  };
  return it;
}

let ok4;
(async () => {
  lv.loadLevels();
  // 1) 출현 → XP 정지
  const err = await raidMod.forceSpawnRaid({ guildId: 'other', channel, client });
  assert(!err, '출현 성공');
  assert(lv.isRaidXpFrozen() && lv.isMinigameXpFrozen(), '출현 중 XP 정지(미니게임 포함)');
  assert(hasImage() && desc().includes('역할 버튼을 눌러 참가') && /## ⏳ \d\d:\d\d:\d\d/.test(desc()) && current.components[0].toJSON().type === 17, '모집 화면: 컨테이너 안에 그림 + 00:00:00 타이머');
  assert(buttons().filter(b => b.custom_id?.startsWith('raid:role:')).length === 4, '역할 버튼 4개');

  // 2) 모집: 중복 역할 거부, 역할 변경, 3명 참가
  let it = fakeInteraction('1', 'raid:role:sword'); await raidMod.handleRaidButton(it);
  it = fakeInteraction('2', 'raid:role:sword'); await raidMod.handleRaidButton(it);
  assert(it.replied?.content.includes('이미 다른 사람'), '같은 역할 중복 거부');
  it = fakeInteraction('1', 'raid:role:archer'); await raidMod.handleRaidButton(it);
  assert(buttons().some(b => b.label?.includes('궁수 · 유저1')), '참가 중 역할 변경');
  await raidMod.handleRaidButton(fakeInteraction('2', 'raid:role:sword'));
  await raidMod.handleRaidButton(fakeInteraction('3', 'raid:role:healer'));
  it = fakeInteraction('9', 'raid:act:attack'); await raidMod.handleRaidButton(it);
  assert(it.replied?.content.includes('모집 중'), '모집 중 행동 버튼 거부');

  // 3) 모집 마감(타이머) → 3인 전투 시작
  await runTimers();
  assert(desc().includes('TURN 1 · 행동을 고르세요') && buttons().some(b => b.custom_id === 'raid:act:skill'), '모집 마감 후 전투 화면(TURN 1)');
  it = fakeInteraction('9', 'raid:act:attack'); await raidMod.handleRaidButton(it);
  assert(it.replied?.content.includes('파티원만'), '파티원 아닌 사람 거부');

  // 4) 한 명만 고르면 화면에 ✅, 전원 고르면 같은 응답 안에서 턴 진행
  it = fakeInteraction('1', 'raid:act:skill'); await raidMod.handleRaidButton(it);
  assert(it.deferred && lastEdit.files && desc().includes('아직 고르지 않음') && !desc().split('아직 고르지 않음')[1].includes('유저1') && desc().includes('TURN 1'), '선택하면 카드 리본이 바뀐 그림으로 갱신, 대기 목록에서 빠짐');
  await raidMod.handleRaidButton(fakeInteraction('2', 'raid:act:attack'));
  it = fakeInteraction('3', 'raid:act:attack'); await raidMod.handleRaidButton(it);
  assert(it.deferred && lastEdit.files && desc().includes('TURN 1 종료') && buttons().filter(b => b.custom_id?.startsWith('raid:act:')).every(b => b.disabled), '마지막 선택 → 결과 화면(TURN 1 종료, 버튼 꺼짐)');
  { const t2 = fakeInteraction('2', 'raid:act:attack'); await raidMod.handleRaidButton(t2); assert(t2.replied?.content.includes('턴이 끝났어요'), '결과 화면 중 클릭은 안내만'); }
  await runTimers();
  assert(desc().includes('TURN 2 · 행동을 고르세요') && buttons().some(b => b.custom_id === 'raid:act:attack' && !b.disabled), '2.5초 뒤 다음 턴 선택 화면(TURN 2, 버튼 켜짐)');
  it = fakeInteraction('1', 'raid:act:skill'); await raidMod.handleRaidButton(it);
  assert(it.replied?.content.includes('턴 뒤에'), '스킬 쿨타임 거부');

  // 5) 타이머로 넘어가는 턴(아무도 안 고름 → 자동 공격)
  await runTimers();
  assert(desc().includes('TURN 2 종료') && lastEdit.files, '시간 초과 턴은 자동 공격으로 진행(결과 화면)');
  await runTimers();

  // 6) 끝까지 플레이(성공할 때까지 똑똑하게)
  let guard = 0;
  while (buttons().length && guard++ < 80) {
    if (desc().includes(' 종료\n')) { await runTimers(); continue; }
    const d = desc();
    const smash = d.includes('방어 추천');
    for (const uid of ['1', '2', '3']) {
      for (const act of smash ? ['guard'] : ['skill', 'potion', 'attack']) {
        if (act === 'potion' && !d.includes(`유저${uid}`)) continue;
        const t = fakeInteraction(uid, 'raid:act:' + act); await raidMod.handleRaidButton(t);
        if (!t.replied) break;
        if (t.replied.content.includes('쓰러진') || t.replied.content.includes('끝난')) break;
      }
      if (!buttons().length) break;
    }
  }
  const end = desc();
  console.log('--- 결과 글자 ---\n' + end.split('\n').slice(0, 4).join('\n'));
  assert(hasImage(), '결과 화면 그림');
  fs.writeFileSync(path.join(root, 'out_recruit.png'), images[0]);
  fs.writeFileSync(path.join(root, 'out_battle.png'), images[images.length - 2]);
  fs.writeFileSync(path.join(root, 'out_end.png'), images[images.length - 1]);
  assert(buttons().length === 0, '전투 종료 후 버튼 제거');
  assert(!lv.isRaidXpFrozen(), '종료 후 XP 정지 해제');
  assert(sent.some(p => p.content?.includes('XP 시스템이 다시 작동')), '복구 안내 메시지 전송');
  if (end.includes('RAID CLEAR')) {
    assert(lv.getXp('gMain', '1') >= 300 && lv.getXp('gMain', '2') >= 300, '토벌 보상 XP 지급');
  }
  const status = raidMod.getRaidStatus('gMain');
  assert(!status.active, '상태: 진행 중 아님');

  // 7) 무참가 → 도주
  await raidMod.forceSpawnRaid({ guildId: 'other', channel: { ...channel, send: async (p) => { current = p; return message; } }, client });
  await runTimers();
  assert(desc().includes('RAID FAILED') && desc().includes('도망쳤다') && !lv.isRaidXpFrozen(), '무참가 시 도주(RAID FAILED) + XP 해제');

  // 7.5) 바로 시작: 파티장·관리자만
  {
    const { ADMIN_IDS } = require(path.join(root, 'config.js'));
    await raidMod.forceSpawnRaid({ guildId: 'other', channel: { ...channel, send: async (p) => { current = p; return message; } }, client });
    let t = fakeInteraction('5', 'raid:start'); await raidMod.handleRaidButton(t);
    assert(t.replied?.content.includes('참가자가 없어요'), '참가자 없으면 바로 시작 거부');
    await raidMod.handleRaidButton(fakeInteraction('5', 'raid:role:tank'));
    await raidMod.handleRaidButton(fakeInteraction('6', 'raid:role:healer'));
    assert(desc().includes('첫 참가자가 방장이 되며'), '방장 안내 표시');
    t = fakeInteraction('6', 'raid:start'); await raidMod.handleRaidButton(t);
    assert(t.replied?.content.includes('방장 **유저5**'), '방장 아닌 참가자는 바로 시작 거부');
    t = fakeInteraction('5', 'raid:start'); await raidMod.handleRaidButton(t);
    assert(desc().includes('TURN 1'), '방장이 바로 시작');
    await raidMod.forceEndRaid();
    await raidMod.forceSpawnRaid({ guildId: 'other', channel: { ...channel, send: async (p) => { current = p; return message; } }, client });
    await raidMod.handleRaidButton(fakeInteraction('7', 'raid:role:sword'));
    t = fakeInteraction(ADMIN_IDS[0], 'raid:start'); await raidMod.handleRaidButton(t);
    assert(t.replied?.content.includes('1명뿐이에요') && !desc().includes('TURN 1'), '1명일 때 파티 밖 관리자가 바로 시작 → 본인에게만 확인 메시지');
    let t2 = fakeInteraction('7', 'raid:start'); await raidMod.handleRaidButton(t2);
    assert(t2.replied?.content.includes('혼자예요') && !desc().includes('TURN 1'), '혼자인 방장이 바로 시작 → 본인에게만 확인 메시지');
    const ephem = { id: 'ephemeral-1' };
    const mk = (id) => { const x = fakeInteraction(ADMIN_IDS[0], id); x.message = ephem; x.update = async (pl) => { x.updated = pl; }; x.deleteReply = async () => { x.deleted = true; }; return x; };
    t = mk('raid:solo:no'); await raidMod.handleRaidButton(t);
    assert(t.deleted && !t.updated && !desc().includes('TURN 1'), '확인 메시지에서 취소하면 확인 메시지 삭제 + 모집 계속');
    t = mk('raid:solo:yes'); await raidMod.handleRaidButton(t);
    assert(t.deleted && !t.updated && desc().includes('TURN 1'), '확인 메시지에서 혼자 시작하면 전투 시작 + 확인 메시지 삭제(관리자도 가능)');
    await raidMod.forceEndRaid();
  }

  // 7.8) 4명 동시 클릭: 중간에 화면 갱신 없이 연달아 눌러도 마지막에 최신 턴만, 턴 번호가 거꾸로 가지 않음
  {
    await origSpawn({ guildId: 'other', channel: { ...channel, send: async (p) => { current = p; return message; } }, client });
    for (const [u, r] of [['1', 'sword'], ['2', 'archer'], ['3', 'tank'], ['4', 'healer']]) await origHandle(fakeInteraction(u, 'raid:role:' + r));
    await flushRender();
    editTurns.length = 0;
    const edits0 = images.length;
    const clicks = ['1', '2', '3', '4'].map(u => fakeInteraction(u, 'raid:act:attack'));
    await Promise.all(clicks.map(c => origHandle(c)));   // 거의 동시에 4명
    ok4 = clicks.every(c => c.deferred);
    await flushRender();
    assert(ok4, '동시 클릭 4개 모두 즉시 ack');
    assert(desc().includes('TURN 1 종료'), '동시 클릭 후 최종 화면은 TURN 1 종료');
    assert(images.length - edits0 === 1, '턴 결과 그림은 한 번만 업로드');
    assert(editTurns.every((t, i) => i === 0 || t >= editTurns[i - 1]), '화면의 턴 번호가 거꾸로 가지 않음');
    await origEnd('gMain'); await flushRender();
  }

  // 8) 4명 차면 즉시 시작
  await raidMod.forceSpawnRaid({ guildId: 'other', channel: { ...channel, send: async (p) => { current = p; return message; } }, client });
  for (const [u, r] of [['1', 'sword'], ['2', 'archer'], ['3', 'tank'], ['4', 'healer']]) await raidMod.handleRaidButton(fakeInteraction(u, 'raid:role:' + r));
  assert(desc().includes('TURN 1'), '4명 모이면 바로 전투 시작');
  const ended = await raidMod.forceEndRaid();
  assert(ended && desc().includes('관리자가') && !lv.isRaidXpFrozen(), '관리자 강제 종료');

  // 9) 채팅에 묻히면 맨 아래로 다시 올리기
  {
    let mid = 100; const deleted = [];
    const ch2 = { id: 'ch2', guildId: 'gMain', name: '놀이터', lastMessageId: null };
    ch2.send = async (p) => {
      current = p;
      const m = { id: 'm' + (++mid), channel: ch2, edit: async (pp) => { current = pp; return m; }, delete: async () => { deleted.push(m.id); } };
      m.payload = p; ch2.lastMessageId = m.id; return m;
    };
    await raidMod.forceSpawnRaid({ guildId: 'other', channel: ch2, client });
    const first = ch2.lastMessageId;
    const chat = (author = 'u9') => raidMod.noteChannelMessage({ guildId: 'gMain', channelId: 'ch2', author: { id: author }, client: { user: { id: 'bot' } } });
    chat('bot'); // 봇 자신의 메시지는 무시
    assert(!timers.some(t => !t.cancelled && t.ms === 3000), '봇 메시지는 다시 올리기 대상 아님');
    ch2.lastMessageId = 'chat1'; chat(); chat(); chat();
    assert(timers.filter(t => !t.cancelled && t.ms === 3000).length === 1, '채팅 여러 개는 한 번으로 모음');
    for (const t of timers.filter(t => !t.cancelled && t.ms === 3000)) { timers.splice(timers.indexOf(t), 1); await t.fn(); }
    await flushRender();
    assert(ch2.lastMessageId !== first && ch2.lastMessageId !== 'chat1' && deleted.includes(first), '채팅에 묻히면 새 메시지로 맨 아래에 다시 올리고 예전 메시지 삭제');
    assert(current.files?.length === 1 && hasImage(), '다시 올린 메시지에 그림 첨부');
    const old = fakeInteraction('1', 'raid:role:sword'); old.message = { id: first };
    await raidMod.handleRaidButton(old);
    assert(old.replied?.content.includes('맨 아래로 옮겨졌어요'), '예전 메시지 버튼은 옮겨졌다고 안내');
    const now = fakeInteraction('1', 'raid:role:sword'); now.message = { id: ch2.lastMessageId };
    await raidMod.handleRaidButton(now);
    assert(now.deferred && ch2.lastMessageId === now.message.id, '안 묻혔으면 제자리 수정(새 메시지 안 보냄)');
    ch2.lastMessageId = 'chat2';
    const beforeId = now.message.id;
    await raidMod.handleRaidButton(Object.assign(fakeInteraction('2', 'raid:role:archer'), { message: { id: beforeId } }));
    assert(ch2.lastMessageId !== 'chat2' && deleted.includes(beforeId), '묻힌 상태에서 화면이 바뀌어도 맨 아래로 다시 올림');
    await raidMod.forceEndRaid();
  }

  // 10) 서버별 분리: 본서버·테스트 서버 레이드가 동시에, 서로 막지 않음
  {
    const TEST = '1282694117255548960';
    const mk = (g, id) => ({ id, guildId: g, name: id, send: async (p) => ({ id: id + 'm', channel: null, edit: async () => ({}) }) });
    assert(!(await origSpawn({ guildId: 'other', channel: mk('gMain', 'cMain'), client })), '본서버 레이드 출현');
    assert(!(await origSpawn({ guildId: 'other', channel: mk(TEST, 'cTest'), client })), '본서버 레이드 중에도 테스트 서버 레이드 출현');
    assert(raidMod.isPlaygroundPaused('gMain') && raidMod.isPlaygroundPaused(TEST) && !raidMod.isPlaygroundPaused('gOther'), '각 서버 놀이터만 멈춤');
    await origEnd(TEST); await flushRender();
    assert(raidMod.isPlaygroundPaused('gMain') && !raidMod.isPlaygroundPaused(TEST) && lv.isRaidXpFrozen(), '테스트 서버 레이드 끝나도 본서버 레이드·XP 정지는 그대로');
    assert(raidMod.getRaidStatus(TEST).active === false && raidMod.getRaidStatus('gMain').active, '상태도 서버별');
    await origEnd('gMain'); await flushRender();
    assert(!lv.isRaidXpFrozen() && !raidMod.isPlaygroundPaused('gMain'), '본서버 레이드 끝나면 XP 정지 해제');
  }

  // 14) 변수 상황: 메시지 수정 실패 종류별 처리 · 레이드 두 개의 XP 정지 · 레이드 중 자동 출현 시각
  {
    // 수정할 때 던질 오류를 바꿀 수 있는 가짜 채널
    const mkFlaky = (g, id) => {
      const ch = { id, guildId: g, name: id, lastMessageId: null, sent: 0, failWith: null };
      ch.send = async (p) => {
        ch.sent++;
        const m = { id: `${id}-m${ch.sent}`, channel: ch, delete: async () => {} };
        m.edit = async () => { if (ch.failWith) throw ch.failWith; return m; };
        ch.lastMessageId = m.id;
        return m;
      };
      return ch;
    };
    const err = (code) => Object.assign(new Error('discord ' + code), { code });
    const start = async (ch) => {
      await origSpawn({ guildId: 'other', channel: ch, client });
      await flushRender();
      const it = Object.assign(fakeInteraction('a1', 'raid:role:sword'), { guildId: ch.guildId, message: { id: ch.lastMessageId } });
      await raidMod.handleRaidButton(it);
      const st = Object.assign(fakeInteraction('a1', 'raid:start'), { guildId: ch.guildId, message: { id: ch.lastMessageId } });
      await raidMod.handleRaidButton(st);
      const yes = Object.assign(fakeInteraction('a1', 'raid:solo:yes'), { guildId: ch.guildId, deleteReply: async () => {} });
      await raidMod.handleRaidButton(yes);
      await flushRender();
    };
    const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { await fn(); } finally { console.error = e; } };

    // 일시적인 오류(네트워크·디스코드 5xx 등)로 수정이 한 번 실패해도 전투를 끝내지 않는다
    const c1 = mkFlaky('gMain', 'flaky1');
    await start(c1);
    assert(raidMod.getRaidStatus('gMain').phase === 'battle', '[변수] 전투 시작');
    c1.failWith = new Error('ECONNRESET');
    await quiet(async () => { await raidMod.handleRaidButton(Object.assign(fakeInteraction('a1', 'raid:act:guard'), { guildId: 'gMain', message: { id: c1.lastMessageId } })); await flushRender(); });
    assert(raidMod.getRaidStatus('gMain').phase === 'battle', '[변수] 일시적인 수정 실패로는 전투가 끝나지 않음');
    // 누가 레이드 메시지를 지우면(Unknown Message) 새 메시지로 다시 올려 이어 간다
    c1.failWith = err(10008);
    const sentBefore = c1.sent;
    await quiet(async () => { await runTimers(); });
    c1.failWith = null;
    assert(raidMod.getRaidStatus('gMain').active && c1.sent > sentBefore, '[변수] 레이드 메시지가 지워지면 새로 올려서 계속');
    await origEnd('gMain'); await flushRender();

    // 채널이 사라지거나 권한이 없으면(모집 중이라도) 바로 끝내 XP 정지가 1시간씩 남지 않게
    const c2 = mkFlaky('gMain', 'flaky2');
    await origSpawn({ guildId: 'other', channel: c2, client }); await flushRender();
    c2.failWith = err(10003);
    await quiet(async () => {
      const it = Object.assign(fakeInteraction('a1', 'raid:role:sword'), { guildId: 'gMain', message: { id: c2.lastMessageId } });
      await raidMod.handleRaidButton(it); await flushRender();
    });
    assert(!raidMod.getRaidStatus('gMain').active && !lv.isRaidXpFrozen(), '[변수] 채널이 없어지면 모집 중이어도 레이드 종료 + XP 정지 해제');

    // XP를 멈추는 레이드가 두 서버에서 동시에 돌 때, 하나가 끝나도 다른 하나가 남아 있으면 XP 정지 유지
    const cA = mkFlaky('gMain', 'xpA'), cB = mkFlaky('gOther', 'xpB');
    await origSpawn({ guildId: 'other', channel: cA, client });
    await origSpawn({ guildId: 'other', channel: cB, client });
    await origEnd('gOther'); await flushRender();
    assert(lv.isRaidXpFrozen(), '[변수] XP 멈춘 레이드가 하나라도 남아 있으면 XP 정지 유지');
    await origEnd('gMain'); await flushRender();
    assert(!lv.isRaidXpFrozen(), '[변수] 전부 끝나면 XP 정지 해제');

    // 자동 출현 시각이 레이드(수동 소환) 진행 중에 지나가면 건너뛰고 다음 일정으로 — 끝나자마자 또 뜨지 않게
    intervals.length = 0;
    raidMod.startRaidScheduler(client);
    const tick = intervals.find(x => x.ms === 60_000)?.fn;
    raidMod.setAutoSpawn(true);
    const { GUILD_ID } = require(path.join(root, 'config.js'));
    const due = raidMod.getRaidStatus(GUILD_ID).nextSpawnAt;
    const cS = mkFlaky(GUILD_ID, 'sched'); // 자동 출현은 본서버(GUILD_ID) 기준
    await origSpawn({ guildId: 'other', channel: cS, client });
    const realNow = Date.now;
    Date.now = () => due + 60_000;
    try { tick(); } finally { Date.now = realNow; }
    const next = raidMod.getRaidStatus(GUILD_ID).nextSpawnAt;
    assert(tick && raidMod.getRaidStatus(GUILD_ID).active && next > due + 60_000, '[변수] 레이드 중 지나간 자동 출현 시각은 다음 일정으로 미룸');
    await origEnd(GUILD_ID); await flushRender();
    raidMod.setAutoSpawn(false);
  }

  // 15) 플레이 방법(❔): 본인에게만 보이는 V2 컨테이너, 몬스터 전용 기술(점액·단단해지기·재생)은 넣지 않음
  {
    const it = { customId: 'raid:help', guildId: 'gNone', user: { id: '1' }, reply: async (p) => { it.p = p; } };
    await raidMod.handleRaidButton(it);
    const text = it.p.components.map(c => c.toJSON()).flatMap(c => (c.type === 17 ? c.components : [c])).filter(c => c.type === 10).map(c => c.content).join('\n');
    const { MessageFlags } = require('discord.js');
    assert((it.p.flags & MessageFlags.Ephemeral) && (it.p.flags & MessageFlags.IsComponentsV2), '도움말: 본인에게만 · V2 컨테이너');
    assert(text.includes('레이드 플레이 방법') && text.includes('행동 불가') && !/점액|단단해|재생/.test(text), '도움말: 공통 규칙만(점액·단단해지기·재생 없음)');

    // 모집 중에 연 가이드는 전투가 시작되면, 전투 중에 연 가이드는 레이드가 끝나면 자동으로 닫힌다
    const ch = { id: 'helpch', guildId: 'gMain', name: 'h', lastMessageId: null };
    ch.send = async () => { const m = { id: 'helpm', channel: ch, edit: async () => m, delete: async () => {} }; ch.lastMessageId = m.id; return m; };
    await origSpawn({ guildId: 'other', channel: ch, client }); await flushRender();
    const openHelp = async () => {
      const h = { customId: 'raid:help', guildId: 'gMain', user: { id: '1' }, closed: false, reply: async () => {}, deleteReply: async () => { h.closed = true; } };
      await raidMod.handleRaidButton(h);
      return h;
    };
    const h1 = await openHelp(), h2 = await openHelp();
    await raidMod.handleRaidButton(Object.assign(fakeInteraction('1', 'raid:role:sword'), { message: { id: 'helpm' } }));
    await raidMod.handleRaidButton(Object.assign(fakeInteraction('2', 'raid:role:archer'), { message: { id: 'helpm' } }));
    assert(!h1.closed && !h2.closed, '가이드: 모집 중에는 그대로');
    await raidMod.handleRaidButton(Object.assign(fakeInteraction('1', 'raid:start'), { message: { id: 'helpm' } }));
    await flushRender();
    assert(raidMod.getRaidStatus('gMain').phase === 'battle' && h1.closed && h2.closed, '가이드: 전투가 시작되면 자동으로 닫힘');
    const h3 = await openHelp();
    await origEnd('gMain'); await flushRender();
    assert(h3.closed, '가이드: 전투 중에 연 것은 레이드가 끝나면 닫힘');
  }

  // 11) 자동 출현 스위치: 기본 중지
  {
    assert(raidMod.getRaidStatus('gMain').autoSpawn === false, '자동 출현 기본값은 중지');
    let st = raidMod.setAutoSpawn(true);
    assert(st.autoSpawn && st.nextSpawnAt > Date.now() && st.nextSpawnAt < Date.now() + 4 * 86400_000, '가동하면 1~3일 뒤 첫 출현 일정');
    st = raidMod.setAutoSpawn(false);
    assert(!st.autoSpawn && st.nextSpawnAt === null, '중지하면 일정 삭제');
  }

  // 12) 몬스터 기술 효과: 점액·보호막·기절·재생 (전투 엔진만, 몬스터 행동을 직접 지정)
  {
    const E = require(path.join(root, 'handlers/레이드전투.js'));
    const party = [{ userId: 'x', name: 'X', role: 'sword' }, { userId: 'y', name: 'Y', role: 'healer' }];
    const fixed = () => 0.5;
    const turnWith = (b, intent, choices = {}) => {
      b.intent = intent;
      for (const [u, a] of Object.entries(choices)) E.choose(b, u, a);
      return E.resolveTurn(b, fixed);
    };
    let b = E.createBattle(E.MONSTERS[0], party, fixed);
    turnWith(b, 'sweep');
    assert(b.members.every(m => E.slowTurnsLeft(b, m) === 2), '점액 흩뿌리기 → 전원 점액 2턴');
    const hp0 = b.hp; turnWith(b, 'attack', { x: 'attack' });
    const slowHit = b.lastTurn.acts.x.value;
    assert(slowHit <= Math.round(110 * E.MONSTERS[0].moves.sweep.effectRate) && hp0 > b.hp, '점액 중 공격 피해 25% 감소');
    turnWith(b, 'attack', { y: 'skill' });
    assert(b.members.every(m => E.slowTurnsLeft(b, m) === 0), '치유사 스킬로 점액 제거');

    b = E.createBattle(E.MONSTERS[0], party, fixed);
    turnWith(b, 'charge');
    assert(E.isShielded(b), '단단해지기 → 다음 턴 보호막');
    turnWith(b, 'smash', { x: 'attack', y: 'guard' });
    assert(b.lastTurn.shielded && b.lastTurn.acts.x.value <= 55, '보호막 턴엔 받는 피해 절반');
    assert(!E.isShielded(b), '보호막은 한 턴만');
    const sx = E.getMember(b, 'x'), sy = E.getMember(b, 'y');
    assert(E.isStunned(b, sx) && !E.isStunned(b, sy), '필살 짓누르기: 방어 안 한 사람만 기절');
    assert(E.checkChoice(b, 'x', 'attack')?.includes('기절') && !E.allChosen(b), '기절하면 행동 선택 불가, 나머지는 골라야 진행');
    E.choose(b, 'y', 'attack');
    assert(E.allChosen(b), '기절한 사람은 빼고 전원 고르면 진행');
    E.resolveTurn(b, fixed);
    assert(b.lastTurn.acts.x.label === '기절' && !E.isStunned(b, sx), '기절 턴엔 행동 없이 넘어가고 다음 턴 풀림');

    b = E.createBattle(E.MONSTERS[0], party, fixed);
    b.hp = Math.round(b.maxHp * 0.5);
    turnWith(b, 'heal');
    assert(b.lastTurn.monsterHeal === Math.round(b.maxHp * E.MONSTERS[0].moves.heal.healRate), '재생으로 몬스터 HP 6% 회복');

    // 다른 몬스터: 상태이상 이름·세기·분노 조건을 데이터만으로 바꿀 수 있다
    const fire = JSON.parse(JSON.stringify(E.MONSTERS[0]));
    Object.assign(fire.moves.sweep, { effectRate: 0.5, effectTurns: 3, status: { name: '화상', emoji: '🔥' } });
    Object.assign(fire.moves.smash, { status: { name: '빙결', emoji: '❄️' } });
    fire.moves.charge.effectRate = 0.2;
    fire.rage = { hpRatio: 0.9, damageRate: 2 };
    b = E.createBattle(fire, party, fixed);
    turnWith(b, 'sweep');
    assert(b.members.every(m => E.slowTurnsLeft(b, m) === 3) && b.log.join().includes('🔥화상'), '다른 몬스터: 🔥화상 3턴(이름·지속 턴은 데이터대로)');
    b.hp = Math.floor(b.maxHp * 0.9) + 10; // 이번 턴 공격(약 50)으로 90% 아래로 떨어지게
    turnWith(b, 'charge', { x: 'attack' });
    assert(b.lastTurn.acts.x.value <= Math.round(110 * 0.5), '다른 몬스터: 화상 중 주는 피해 -50%');
    assert(b.rage, '다른 몬스터: HP 90% 이하에서 분노(분노 조건도 데이터대로)');
    turnWith(b, 'smash', { x: 'attack', y: 'guard' });
    assert(b.lastTurn.shielded && E.isStunned(b, E.getMember(b, 'x')) && E.checkChoice(b, 'x', 'attack')?.includes('빙결'), '다른 몬스터: 보호막 배율·❄️빙결 이름도 데이터대로');
  }

  // 13) 몬스터 파일(Monster 폴더): 슬라임.json을 읽고, 깨진 파일은 그 파일만 건너뛴다
  {
    const E = require(path.join(root, 'handlers/레이드전투.js'));
    assert(E.MONSTERS.length === 1 && E.MONSTERS[0].id === 'slime' && !('_메모' in E.MONSTERS[0]), 'Monster/슬라임.json 불러옴(_메모는 제외)');
    const dir = fs.mkdtempSync(path.join(root, 'monster-'));
    const slime = fs.readFileSync(path.join(root, 'Monster', '슬라임.json'), 'utf8');
    fs.writeFileSync(path.join(dir, '가.json'), slime);
    fs.writeFileSync(path.join(dir, '나.json'), '{ 깨진 파일');
    const bad = JSON.parse(slime); bad.id = 'bad'; bad.sprite.rows[0] = 'zz' + bad.sprite.rows[0]; delete bad.moves.heal;
    fs.writeFileSync(path.join(dir, '다.json'), JSON.stringify(bad));
    fs.writeFileSync(path.join(dir, '라.json'), slime); // id 중복
    const noDmg = JSON.parse(slime); noDmg.id = 'nodmg'; delete noDmg.moves.attack.damage; noDmg.intentWeights.rage = { attack: 0 };
    fs.writeFileSync(path.join(dir, '마.json'), JSON.stringify(noDmg)); // 피해 없음 + 가중치 합 0
    const origError = console.error; const errors = []; console.error = (...a) => errors.push(a.join(' '));
    const list = E.loadMonsters(dir);
    console.error = origError;
    assert(list.length === 1 && list[0].id === 'slime', '깨진 JSON · 칸 빠진 파일 · id 중복 파일은 건너뜀');
    assert(errors.some(e => e.includes('moves.attack.damage')) && errors.some(e => e.includes('합이 0보다')), '피해 수치 없음 · 가중치 합 0인 파일도 건너뜀(HP가 NaN이 되는 것 방지)');
    assert(errors.some(e => e.includes('palette에 없는 글자: z')) && errors.some(e => e.includes('moves.heal 없음')) && errors.some(e => e.includes('겹침')), '건너뛴 사유를 콘솔에 남김');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('그림 업로드 횟수:', images.length, '· RSS', Math.round(process.memoryUsage().rss/1048576), 'MB');
})().catch(e => { console.error('테스트 실패', e); process.exitCode = 1; });

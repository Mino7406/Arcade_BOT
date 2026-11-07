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
const channel = { id: 'ch1', guildId: 'gMain', name: '놀이터', send: async (p) => { sent.push(p); if (!message.channel || p.components) { message.channel = channel; current = p; if (p.files) images.push(p.files[0].attachment); return message; } return { id: 'x', delete: async () => {} }; } };
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
  // 0) /xp에서 몬스터를 골라 소환: 없는 몬스터는 거부(아무것도 안 뜸)
  assert((await raidMod.forceSpawnRaid({ guildId: 'other', channel, client }, 'nope'))?.includes('찾을 수 없어요') && !raidMod.getRaidStatus(channel.guildId).active, '없는 몬스터 id로 소환하면 거부');
  // 1) 출현 → XP 정지 (고른 몬스터로)
  const err = await raidMod.forceSpawnRaid({ guildId: 'other', channel, client }, 'slime');
  assert(raidMod.getRaidStatus(channel.guildId).monsterName === '슬라임', '고른 몬스터(슬라임)로 소환');
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
  // 테스트 전투는 가끔 지므로(무작위) 지면 복구 안내 대신 XP 손실 안내를 확인한다
  assert(end.includes('RAID CLEAR') ? sent.some(p => p.content?.includes('XP 시스템 복구 완료')) : sent.some(p => p.content?.includes('XP**를 잃어버렸습니다')), '종료 안내 메시지 전송(클리어면 복구 완료, 지면 XP 손실)');
  { const notice = sent.find(p => p.content?.includes('XP 시스템 복구 완료') || p.content?.includes('잃어버렸습니다'));
    assert(notice?.reply?.messageReference === message.id && notice.reply.failIfNotExists === false && notice.allowedMentions?.repliedUser === false, '종료 안내는 레이드 메시지에 답장(따로 보이게, 알림 없음)');
    assert(/\n-# 중단 시간 : \d.* \(\d\d:\d\d~\d\d:\d\d\)$/.test(notice?.content ?? ''), '종료 안내 마지막 줄 작은 글씨: 중단 시간 : N분 N초 (시각~시각)'); }
  if (end.includes('RAID CLEAR')) {
    assert(lv.getXp('gMain', '1') >= 300 && lv.getXp('gMain', '2') >= 300, '토벌 보상 XP 지급');
  }
  const status = raidMod.getRaidStatus('gMain');
  assert(!status.active, '상태: 진행 중 아님');

  // 7) 무참가 → 도주 + 모든 유저 -50~100 XP(무작위)
  lv.applyXp('gMain', 'n1', 180);
  const noshowBefore = lv.getXp('gMain', 'n1');
  await raidMod.forceSpawnRaid({ guildId: 'other', channel: { ...channel, send: async (p) => { current = p; return message; } }, client });
  await runTimers();
  assert(desc().includes('RAID FAILED') && desc().includes('도망쳤다') && !lv.isRaidXpFrozen(), '무참가 시 도주(RAID FAILED) + XP 해제');
  { const amt = Number(sent.map(p => p.content?.match(/^☠️ 모든 유저의 [*]{2}([0-9]+)XP[*]{2}를 잃어버렸습니다[.]{3}/)?.[1]).filter(Boolean).pop());
    assert(amt >= 50 && amt <= 100 && lv.getXp('gMain', 'n1') === noshowBefore - amt, `무참가 도주도 모든 유저 -${amt} XP(50~100) + 채널 안내(숫자만 굵게)`); }
  assert(!desc().includes('XP를 잃어') && !desc().includes('XP 시스템 복구됨'), '종료 화면 작은 글씨엔 벌칙·복구 문구 없음');

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

  // 16) 전투 시작 멘션: 시작을 누른 사람은 빼고 파티원을 한 번 부르고, 레이드 메시지는 그 아래로 다시 올라감
  {
    const mkCh = (id) => {
      const ch = { id, guildId: 'gMain', name: id, lastMessageId: null, log: [] };
      let n = 0;
      ch.send = async (p) => {
        const m = { id: `${id}-${++n}`, channel: ch, edit: async () => m, delete: async () => { ch.log.push(`삭제 ${m.id}`); } };
        ch.log.push(p.components ? `레이드 ${m.id}` : `멘션 ${m.id}`);
        if (!p.components) ch.mention = p;
        ch.lastMessageId = m.id;
        return m;
      };
      return ch;
    };
    const click = (ch, uid, id) => raidMod.handleRaidButton(Object.assign(fakeInteraction(uid, id), { message: { id: ch.lastMessageId }, deleteReply: async () => {} }));

    // 방장이 바로 시작 → 방장은 빼고 나머지만
    let ch = mkCh('men1');
    await origSpawn({ guildId: 'other', channel: ch, client }); await flushRender();
    await click(ch, 'p1', 'raid:role:sword'); await flushRender();
    await click(ch, 'p2', 'raid:role:archer'); await flushRender();
    await click(ch, 'p3', 'raid:role:tank'); await flushRender();
    await click(ch, 'p1', 'raid:start'); await flushRender();
    const m1 = ch.mention;
    assert(m1 && m1.content.includes('<@p2>') && m1.content.includes('<@p3>') && !m1.content.includes('<@p1>') && m1.allowedMentions.users.join() === 'p2,p3', '시작 멘션: 바로 시작을 누른 방장은 빼고 파티원만 부름');
    const iMention = ch.log.findIndex(x => x.startsWith('멘션'));
    assert(iMention > 0 && ch.log.slice(iMention + 1).some(x => x.startsWith('레이드')) && ch.lastMessageId.startsWith('men1') && ch.log.at(-1) !== `멘션 ${ch.lastMessageId}`, '시작 멘션: 멘션 다음에 레이드 메시지가 그 아래로 다시 올라감');
    assert(raidMod.getRaidStatus('gMain').phase === 'battle', '시작 멘션 뒤에도 전투 진행');
    const mentionId = ch.log[iMention].split(' ')[1];
    assert(!ch.log.includes(`삭제 ${mentionId}`), '시작 멘션: 1턴 동안은 남아 있음');
    await runTimers(); // 1턴 타이머 → 턴 진행
    assert(ch.log.includes(`삭제 ${mentionId}`), '시작 멘션: 1턴이 끝나면 자동으로 삭제');
    await origEnd('gMain'); await flushRender();

    // 모집 시간이 끝나 저절로 시작 → 전원
    ch = mkCh('men2');
    await origSpawn({ guildId: 'other', channel: ch, client }); await flushRender();
    await click(ch, 'q1', 'raid:role:sword'); await flushRender();
    await click(ch, 'q2', 'raid:role:healer'); await flushRender();
    await runTimers();
    assert(ch.mention && ch.mention.content.includes('<@q1>') && ch.mention.content.includes('<@q2>'), '시작 멘션: 모집 마감으로 시작하면 파티원 전원');
    await origEnd('gMain'); await flushRender();

    // 혼자 시작 → 부를 사람이 없으니 멘션 없음
    ch = mkCh('men3');
    await origSpawn({ guildId: 'other', channel: ch, client }); await flushRender();
    await click(ch, 's1', 'raid:role:sword'); await flushRender();
    await click(ch, 's1', 'raid:solo:yes'); await flushRender();
    assert(raidMod.getRaidStatus('gMain').phase === 'battle' && !ch.mention, '시작 멘션: 혼자 시작하면 멘션 없음');
    await origEnd('gMain'); await flushRender();
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
    assert(st.autoSpawn && st.nextSpawnAt > Date.now() && st.nextSpawnAt < Date.now() + 3 * 86400_000, '가동하면 1~2일 뒤 첫 출현 일정');
    const want = Date.now() + 5 * 3600_000;
    assert(raidMod.setNextSpawnAt(want) === null && raidMod.getRaidStatus('gMain').nextSpawnAt === want, '출현 시각 수동 변경');
    assert(raidMod.setNextSpawnAt(Date.now() - 1000) && raidMod.getRaidStatus('gMain').nextSpawnAt === want, '지난 시각은 거절(일정 그대로)');
    assert(raidMod.setNextSpawnAt(Date.now() + 40 * 86400_000) && raidMod.getRaidStatus('gMain').nextSpawnAt === want, '30일 넘는 시각은 거절');
    assert(raidMod.getRaidStatus('gMain').nextMonster?.id === 'slime', '가동하면 다음 출현 몬스터도 미리 정해짐(대기 화면에 표시)');
    assert(raidMod.setNextMonster('slime') === null && raidMod.setNextMonster('random') === null && raidMod.getRaidStatus('gMain').nextMonster, '다음 출현 몬스터 변경(고르기·무작위)');
    assert(raidMod.setNextMonster('nope') && raidMod.getRaidStatus('gMain').nextMonster?.id === 'slime', '없는 몬스터로는 못 바꿈(그대로)');
    st = raidMod.setAutoSpawn(false);
    assert(!st.autoSpawn && st.nextSpawnAt === null && st.nextMonster === null, '중지하면 일정·다음 몬스터 삭제');
    assert(raidMod.setNextMonster('slime') && raidMod.getRaidStatus('gMain').nextMonster === null, '중지 중엔 다음 몬스터를 못 정함');
    assert(raidMod.setNextSpawnAt(want) && raidMod.getRaidStatus('gMain').nextSpawnAt === null, '중지 중엔 출현 시각을 못 정함');
    const T = require(path.join(root, 'handlers/시간.js'));
    const now = Date.UTC(2026, 10, 4, 15, 39); // KST 2026-11-05 00:39
    assert(T.kstDateTimeString(T.parseKstDateTime('2026-11-07 12:58', now)) === '2026-11-07 12:58', '시각 입력: 전체 날짜');
    assert(T.kstDateTimeString(T.parseKstDateTime('11/7 20시 30분', now)) === '2026-11-07 20:30', '시각 입력: 월/일 + 시분');
    assert(T.kstDateTimeString(T.parseKstDateTime('00:10', now)) === '2026-11-06 00:10', '시각 입력: 시각만(지났으면 내일)');
    assert(T.parseKstDateTime('2026-02-30 10:00', now) === null && T.parseKstDateTime('25:00', now) === null, '시각 입력: 없는 날짜·시각 거절');
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

    // 기여도(MVP): 수호자가 도발로 대신 맞은 피해를 기록하고, 회복·막아 준 피해도 점수에 들어간다
    const four = E.ROLE_ORDER.map((role, i) => ({ userId: 'c' + i, name: 'C' + i, role }));
    b = E.createBattle(E.MONSTERS[0], four, fixed);
    turnWith(b, 'attack', { c0: 'attack', c1: 'attack', c2: 'skill', c3: 'attack' });
    const tankM = E.getMember(b, 'c2');
    assert(tankM.protected > 0 && b.lastTurn.hits.c2 > 0 && Object.keys(b.lastTurn.hits).length === 1, '기여도: 도발한 수호자가 대신 맞은 피해를 막아 준 피해로 기록');
    assert(tankM.blocked > 0 && E.getMember(b, 'c0').blocked === 0, '방어 칸: 도발로 줄인 피해 기록(맞지 않은 사람은 0)');
    assert(tankM.blocked === tankM.protected && tankM.blocked > b.lastTurn.hits.c2, '방어 칸: 수호자는 도발로 대신 맞아 준 원래 피해 전부(실제로 받은 피해보다 큼)');
    turnWith(b, 'sweep', { c0: 'guard', c1: 'attack', c2: 'attack', c3: 'attack' });
    assert(E.getMember(b, 'c0').blocked > 0 && E.getMember(b, 'c1').blocked === 0, '방어 칸: 방어한 사람만 줄인 피해가 쌓임');
    const [sw, , tk, hl] = b.members;
    Object.assign(sw, { damage: 3000, support: 0, revives: 0, protected: 0 });
    Object.assign(hl, { damage: 700, support: 520, revives: 0, protected: 0 });
    Object.assign(tk, { damage: 900, support: 0, revives: 0, protected: 120 });
    assert(E.contribution(b, hl) > E.contribution(b, sw) && E.contribution(b, tk) > E.contribution(b, sw), '기여도: 회복 많이 한 치유사·많이 막은 수호자가 피해 1위 검사보다 높을 수 있음');
    hl.support = 200;
    assert(E.contribution(b, sw) > E.contribution(b, hl), '기여도: 회복이 적으면 딜러가 높음');

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
    const bad = JSON.parse(slime); bad.id = 'bad'; bad.sprite.rows[0] = 'zz' + bad.sprite.rows[0]; delete bad.moves.smash;
    fs.writeFileSync(path.join(dir, '다.json'), JSON.stringify(bad));
    fs.writeFileSync(path.join(dir, '라.json'), slime); // id 중복
    const noDmg = JSON.parse(slime); noDmg.id = 'nodmg'; delete noDmg.moves.attack.damage; noDmg.intentWeights.rage = { attack: 0 };
    fs.writeFileSync(path.join(dir, '마.json'), JSON.stringify(noDmg)); // 피해 없음 + 가중치 합 0
    const origError = console.error; const errors = []; console.error = (...a) => errors.push(a.join(' '));
    const list = E.loadMonsters(dir);
    console.error = origError;
    assert(list.length === 1 && list[0].id === 'slime', '깨진 JSON · 칸 빠진 파일 · id 중복 파일은 건너뜀');
    assert(errors.some(e => e.includes('moves.attack.damage')) && errors.some(e => e.includes('합이 0보다')), '피해 수치 없음 · 가중치 합 0인 파일도 건너뜀(HP가 NaN이 되는 것 방지)');
    assert(errors.some(e => e.includes('palette에 없는 글자: z')) && errors.some(e => e.includes('moves.smash 없음')) && errors.some(e => e.includes('겹침')), '건너뛴 사유를 콘솔에 남김');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // 14) 독버섯(Monster-all): 독 중첩·환각·독기 흡수 / 테스트 서버 1인 HP
  {
    const E = require(path.join(root, 'handlers/레이드전투.js'));
    const origError = console.error; const errors = []; console.error = (...a) => errors.push(a.join(' '));
    const all = E.loadMonsters(path.join(root, 'Monster-all'));
    console.error = origError;
    const mush = all.find(m => m.id === 'mushroom');
    assert(mush && all.some(m => m.id === 'slime') && !errors.length, `Monster 폴더의 몬스터 전부 문제없이 불러옴(${all.map(m => m.name).join('·')})${errors.length ? ' — ' + errors.join(' / ') : ''}`);
    const party = [{ userId: 'x', name: 'X', role: 'sword' }, { userId: 'y', name: 'Y', role: 'healer' }];
    let roll = 0.5; const rng = () => roll;
    const turnWith = (b, intent, choices = {}) => { b.intent = intent; for (const [u, a] of Object.entries(choices)) E.choose(b, u, a); return E.resolveTurn(b, rng); };
    let b = E.createBattle(mush, party, rng);
    const x = () => E.getMember(b, 'x'), y = () => E.getMember(b, 'y');
    const sporeTurns = mush.moves.spore.effectTurns;
    turnWith(b, 'spore');
    assert(b.members.every(m => E.poisonStacks(b, m) === 1 && E.poisonTurnsLeft(b, m) === sporeTurns) && b.log.join().includes('☠️독'), `독 포자 → 전원 ☠️독 1중첩 ${sporeTurns}턴`);
    let hp = x().hp; const tick = E.poisonDamage(b, x());
    b.hp = Math.round(b.maxHp * 0.5);
    turnWith(b, 'spore', { x: 'guard', y: 'guard' }); // 독이 아직 남은 동안 다시 맞기
    assert(tick === Math.max(1, Math.round(mush.moves.spore.tickDamage * 1.07)) && b.lastTurn.poison.x === tick && x().hp < hp, '독: 다음 턴 아군 행동 뒤 중첩 × tickDamage × 인원 배율만큼 HP 감소');
    assert(E.poisonStacks(b, x()) === 2 && E.poisonTurnsLeft(b, x()) === sporeTurns, '독 다시 맞으면 중첩 +1, 남은 턴 새로');
    const before = b.hp; turnWith(b, 'absorb', { x: 'guard', y: 'guard' });
    const ab = mush.moves.absorb;
    assert(b.lastTurn.poison.x === Math.round(2 * mush.moves.spore.tickDamage * 1.07) && b.lastTurn.monsterHeal === Math.round(b.maxHp * (ab.healRate + ab.healPerStack * 4 * 4 / 2)) && b.hp === before + b.lastTurn.monsterHeal, '독기 흡수: 최대 HP × (healRate + healPerStack × 파티 독 중첩 4 × 4 ÷ 2인)');
    const yBefore = E.poisonStacks(b, y());
    turnWith(b, 'smash', { x: 'attack', y: 'guard' });
    assert(E.poisonStacks(b, x()) === Math.min(mush.moves.smash.maxStacks, mush.moves.smash.stacks) && E.poisonStacks(b, y()) <= yBefore, '필살 포자 대폭발: 방어 안 한 사람만 독 여러 중첩(방어하면 안 걸림)');
    turnWith(b, 'attack', { y: 'skill' });
    assert(b.members.every(m => E.poisonStacks(b, m) === 0) && b.log.join().includes('독 제거') && !b.lastTurn.poison.x, '치유사 스킬로 독 제거(그 턴 독 피해도 없음)');

    // 독기 흡수 → 공격력 증가: 다음 피해 기술 1회만 피해 × buffRate, 쓰면 사라짐(피해 없는 기술엔 남아 있음)
    b = E.createBattle(mush, party, rng);
    b.hp = Math.round(b.maxHp * 0.6 /* 분노(50%) 전 */);
    turnWith(b, 'spore', { x: 'guard', y: 'guard' });
    turnWith(b, 'absorb', { x: 'guard', y: 'guard' });
    assert(E.isPowered(b) && b.powerRate === mush.moves.absorb.buffRate && b.log.join().includes('공격력이 올랐다'), '독기 흡수 → 공격력 증가(다음 공격 피해 배율)');
    turnWith(b, 'absorb', { x: 'guard', y: 'guard' });
    assert(E.isPowered(b), '공격력 증가: 피해 없는 기술에는 쓰이지 않고 남음');
    turnWith(b, 'attack', { x: 'attack', y: 'attack' });
    const pw = b.lastTurn.powered, hitAmt = Object.values(b.lastTurn.hits)[0];
    assert(pw === mush.moves.absorb.buffRate && !E.isPowered(b) && hitAmt === Math.round(9 * 1.07 * pw), '공격력 증가: 다음 피해 기술 1회 피해 × buffRate 후 사라짐');

    // 회복 기술은 두 턴 연속 없음(슬라임 재생 3연속 방지)
    {
      const sl = all.find(m => m.id === 'slime');
      let healTwice = 0;
      for (let i = 0; i < 300; i++) {
        const bb = E.createBattle(sl, party, Math.random);
        bb.hp = Math.round(bb.maxHp * 0.3); bb.rage = true; bb.intent = 'heal';
        E.resolveTurn(bb, Math.random);
        if (sl.moves[bb.intent]?.target === 'self') healTwice++;
      }
      assert(healTwice === 0, '재생 다음 턴엔 회복 기술을 다시 고르지 않음');
    }

    // 독기 흡수 예고 뒤 치유사가 독을 다 지우면 실패: 회복 +0, 공격력 증가 없음
    b = E.createBattle(mush, party, rng);
    b.hp = Math.round(b.maxHp * 0.5);
    turnWith(b, 'spore', { x: 'guard', y: 'guard' });
    const hpBefore = b.hp;
    turnWith(b, 'absorb', { x: 'guard', y: 'skill' });
    assert(b.lastTurn.fizzled && b.lastTurn.monsterHeal === 0 && b.hp === hpBefore - (b.lastTurn.monsterDamage || 0) && !E.isPowered(b) && b.log.join().includes('빨아들일 독기가 없다'), '독을 다 지우면 독기 흡수 실패(회복 +0, 공격력 증가 없음)');

    // 독이 1턴 남았을 때 독기 흡수: 그 턴 독 피해 뒤 독이 끝나도, 끝나기 전 중첩으로 흡수한다(먼저 사라져 실패하던 버그)
    b = E.createBattle(mush, party, rng);
    b.hp = Math.round(b.maxHp * 0.6);
    turnWith(b, 'spore', { x: 'guard', y: 'guard' });
    for (let i = 1; i < sporeTurns; i++) turnWith(b, 'hypno', { x: 'guard', y: 'guard' });
    assert(b.members.every(m => E.poisonTurnsLeft(b, m) === 1), '독 마지막 1턴 준비');
    const hpLast = b.hp;
    turnWith(b, 'absorb', { x: 'guard', y: 'guard' });
    assert(!b.lastTurn.fizzled && b.lastTurn.poison.x > 0 && b.lastTurn.monsterHeal === Math.round(b.maxHp * (ab.healRate + ab.healPerStack * 2 * 4 / 2)) && b.hp === hpLast + b.lastTurn.monsterHeal && E.isPowered(b) && b.members.every(m => E.poisonStacks(b, m) === 0), '독 1턴 남았을 때 독기 흡수: 끝나기 전 중첩(2)으로 회복 + 공격력 증가, 그 뒤 독은 사라짐');

    // 독기 흡수는 파티에 독이 없으면 예고하지 않음 / 분노 중 독을 걸면 다음은 반드시 독기 흡수
    b = E.createBattle(mush, party, Math.random);
    let absorbNoPoison = 0;
    for (let i = 0; i < 300; i++) { b.intent = 'attack'; b.lastTurn = { effects: {} }; b.members.forEach(m => { m.poisonStacks = 0; }); b.hp = Math.round(b.maxHp * 0.3); b.rage = false; if (E.resolveTurn(b, Math.random)) break; if (b.intent === 'absorb' && E.partyPoisonStacks(b) === 0) absorbNoPoison++; }
    assert(absorbNoPoison === 0, '파티에 독이 없으면 독기 흡수를 예고하지 않음');
    b = E.createBattle(mush, party, rng);
    b.hp = Math.round(b.maxHp * 0.4); b.rage = true; b.sinceSmash = 6;
    turnWith(b, 'spore', { x: 'attack', y: 'attack' });
    assert(b.intent === 'absorb', '분노 중 독을 걸면 다음 행동은 독기 흡수(필살기 보장보다 먼저)');
    turnWith(b, 'hypno', { x: 'guard', y: 'guard' });
    assert(b.intent !== 'absorb' || !Object.values(b.lastTurn.effects).includes('poison'), '독을 안 건 턴은 연계 없음');

    // 회복약: 본인 독 해독(그 턴 독 피해 없음), HP가 가득해도 독이면 마실 수 있음
    b = E.createBattle(mush, party, rng);
    turnWith(b, 'spore', { x: 'guard', y: 'guard' });
    x().hp = 100;
    assert(!E.checkChoice(b, 'x', 'potion'), '독에 걸리면 HP가 가득해도 회복약을 마실 수 있음');
    const pots0 = x().potions;
    turnWith(b, 'attack', { x: 'potion', y: 'guard' });
    assert(E.poisonStacks(b, x()) === 0 && !b.lastTurn.poison.x && x().potions === pots0 - 1 && b.log.join().includes('☠️독 해독'), '회복약으로 본인 독 해독(그 턴 독 피해 없음)');
    assert(E.poisonStacks(b, y()) === 0 || b.lastTurn.poison.y > 0, '회복약은 마신 사람만 해독(다른 사람은 그대로 독 피해)');

    // 환각: 방어하면 안 걸림, 걸리면 다음 턴 확률로 헛손질(회복약 안 씀), 방어는 성공
    b = E.createBattle(mush, party, rng);
    turnWith(b, 'hypno', { x: 'guard', y: 'guard' });
    assert(!b.members.some(m => E.isConfused(b, m)), '최면술: 방어하면 안 걸림');
    turnWith(b, 'hypno', { x: 'attack', y: 'skill' });
    const cm = b.members.find(m => E.isConfused(b, m));
    assert(cm && b.lastTurn.effects[cm.userId] === 'confuse' && b.log.join().includes('🌀환각'), '최면술: 맞은 사람 다음 턴 🌀환각');
    cm.hp = 50; const pots = cm.potions; roll = 0.1;
    turnWith(b, 'attack', { [cm.userId]: 'potion' });
    assert(b.lastTurn.acts[cm.userId].label === '헛손질' && cm.potions === pots && b.log.join().includes('헛손질'), '환각: 확률에 걸리면 헛손질(회복약은 그대로)');
    roll = 0.5; b.intent = 'hypno';
    turnWith(b, 'hypno', { x: 'attack', y: 'attack' });
    const cm2 = b.members.find(m => E.isConfused(b, m)); roll = 0.1;
    turnWith(b, 'attack', { [cm2.userId]: 'guard' });
    assert(b.lastTurn.acts[cm2.userId].label === '방어', '환각: 방어는 빗나가지 않음');
    roll = 0.5;

    // 독으로 전원 쓰러지면 몬스터 행동 전에 전멸
    b = E.createBattle(mush, party, rng);
    turnWith(b, 'spore');
    for (const m of b.members) m.hp = 1;
    assert(turnWith(b, 'attack', { x: 'guard', y: 'guard' }) === 'wipe' && !b.lastTurn.monsterMove, '독으로 전원 쓰러지면 바로 전멸');

    // 테스트 서버: 혼자면 1인 HP(본서버는 2인 HP부터)
    const solo = [{ userId: 's', name: 'S', role: 'sword' }];
    assert(E.createBattle(mush, solo, rng, { minParty: 1 }).maxHp < E.createBattle(mush, solo, rng).maxHp, '테스트 서버(minParty 1)는 혼자일 때 1인 HP, 기본은 2인 HP');
  }
  // 14-2) 얼음 큐브(Monster-all): 냉기(몬스터 기술로만 쌓이고 녹지 않음 · 서리 숨결은 방어로 막음 · 3중첩 빙결) · 얼음 갑옷
  {
    const E = require(path.join(root, 'handlers/레이드전투.js'));
    const all = E.loadMonsters(path.join(root, 'Monster-all'));
    const ice = all.find(m => m.id === 'icecube');
    const slime = all.find(m => m.id === 'slime');
    assert(ice, '얼음 큐브를 Monster 폴더에서 불러옴');
    if (ice) {
      const party = [{ userId: 'x', name: 'X', role: 'sword' }, { userId: 'y', name: 'Y', role: 'healer' }];
      const rng = () => 0.5;
      const turnWith = (b, intent, choices = {}) => { b.intent = intent; for (const [u, a] of Object.entries(choices)) E.choose(b, u, a); return E.resolveTurn(b, rng); };
      let b;
      const x = () => E.getMember(b, 'x'), y = () => E.getMember(b, 'y');
      const fresh = (p = party) => { b = E.createBattle(ice, p, rng); return b; };

      fresh();
      x().chillStacks = 2;
      turnWith(b, 'attack', { x: 'attack', y: 'guard' });
      turnWith(b, 'attack', { x: 'skill', y: 'guard' });
      assert(E.chillStacks(b, x()) === 2 && E.chillStacks(b, y()) === 0, '냉기는 공격·스킬로 녹지 않고 방어로 쌓이지도 않음');

      fresh();
      turnWith(b, 'frost', { x: 'guard', y: 'attack' });
      const frostX = E.chillStacks(b, x()), frostY = E.chillStacks(b, y());
      b.rage = true; x().chillStacks = 0; y().chillStacks = 0;
      turnWith(b, 'frost', { x: 'attack', y: 'attack' });
      assert(frostX === 0 && frostY === 1 && E.chillStacks(b, x()) === 2 && E.chillStacks(b, y()) === 2 && b.lastTurn.effects.x === 'chill' && b.log.join().includes('❄️냉기'), '서리 숨결: 방어한 사람은 막고 나머지 냉기 +1, 분노 중 +2');

      fresh();
      x().chillStacks = 2;
      turnWith(b, 'frost', { x: 'attack', y: 'guard' });
      assert(E.isStunned(b, x()) && x().stunStatus.name === '빙결' && E.chillStacks(b, x()) === 0 && b.lastTurn.effects.x === 'freeze' && b.log.join().includes('🧊') && E.checkChoice(b, 'x', 'attack'), '3중첩이면(몬스터 기술 뒤) 빙결: 다음 턴 행동 불가, 냉기 0');
      x().chillStacks = 1;
      turnWith(b, 'attack', { y: 'attack' });
      assert(E.chillStacks(b, x()) === 1 && b.lastTurn.acts.x.label === '빙결', '빙결 중엔 냉기 그대로');

      fresh();
      x().chillStacks = 2;
      turnWith(b, 'frost', { x: 'attack', y: 'skill' });
      assert(E.chillStacks(b, x()) === 1 && !E.isStunned(b, x()) && b.log.join().includes('냉기 제거'), '치유사 스킬이 숨결 전에 냉기를 지우면 빙결 없음');

      fresh();
      x().chillStacks = 1;
      const pots = x().potions;
      const potionOk = E.checkChoice(b, 'x', 'potion') === null;
      turnWith(b, 'attack', { x: 'potion', y: 'attack' });
      assert(potionOk && E.chillStacks(b, x()) === 0 && x().potions === pots - 1 && b.log.join().includes('❄️냉기 제거'), '회복약: 본인 냉기 0, HP 가득해도 마실 수 있음');

      fresh();
      turnWith(b, 'armor', { x: 'attack', y: 'attack' });
      const armorLog = b.log.join();
      turnWith(b, 'attack', { x: 'attack', y: 'guard' });
      assert(armorLog.includes('때리면 ❄️냉기 +1') && E.chillStacks(b, x()) === 1 && E.chillStacks(b, y()) === 0 && b.lastTurn.acts.x.value === Math.round(100 * ice.moves.armor.effectRate), '얼음 갑옷: 다음 턴 때린 사람 냉기 +1, 방어한 사람은 그대로');

      fresh();
      turnWith(b, 'smash', { x: 'guard', y: 'attack' });
      assert(E.isStunned(b, y()) && y().stunStatus.name === '빙결' && !E.isStunned(b, x()), '필살 빙하 낙하: 방어 안 한 사람 🧊빙결');

      // Review Focus
      const bs = E.createBattle(slime, party, rng);
      bs.intent = 'attack'; E.choose(bs, 'x', 'guard'); E.choose(bs, 'y', 'guard'); E.resolveTurn(bs, rng);
      assert(bs.members.every(m => !m.chillStacks && E.chillStacks(bs, m) === 0), '슬라임은 방어해도 냉기 없음');

      fresh();
      delete x().chillStacks; delete y().chillStacks;
      const oldZero = E.chillStacks(b, x()) === 0;
      turnWith(b, 'frost', { x: 'attack', y: 'guard' });
      assert(oldZero && E.chillStacks(b, x()) === 1 && E.chillStacks(b, y()) === 0, '냉기 칸 없는 예전 기록은 0');

      fresh([...party, { userId: 'z', name: 'Z', role: 'tank' }]);
      y().hp = 0; x().hp = 1; x().chillStacks = 2;
      turnWith(b, 'frost', { x: 'attack', z: 'attack' });
      assert(x().hp === 0 && !x().chillStacks && !y().chillStacks && E.chillStacks(b, x()) === 0, '쓰러진 사람은 냉기 없음');

      fresh();
      turnWith(b, 'armor', { x: 'attack', y: 'attack' });
      x().chillStacks = 2;
      turnWith(b, 'smash', { x: 'attack', y: 'guard' });
      const frozenNow = E.isStunned(b, x()) && E.chillStacks(b, x()) === 0;
      turnWith(b, 'attack', { y: 'guard' });
      assert(frozenNow && !E.isStunned(b, x()), '필살기와 빙결이 겹쳐도 한 턴만');

      // 전투 화면 글자(effectLines)
      const lines = () => raidMod.effectLines(b).join('\n');
      fresh();
      x().chillStacks = 2; y().chillStacks = 1;
      assert(lines().includes('❄️ 냉기: X(×2), Y(×1) - **3중첩이면 🧊빙결(서리 숨결은 방어로 막음 · 치유사 스킬·회복약으로 제거)**'), '전투 화면: 냉기 중첩 줄');
      fresh();
      x().chillStacks = 2;
      turnWith(b, 'frost', { x: 'attack', y: 'guard' });
      assert(lines().includes('🧊 빙결: X - **이번 턴 행동 불가**') && !lines().includes('❄️ 냉기'), '전투 화면: 빙결 줄(냉기 0이면 냉기 줄 없음)');
      fresh();
      turnWith(b, 'armor', { x: 'attack', y: 'attack' });
      assert(lines().includes(`이번 턴 받는 피해 -${E.minusPct(ice.moves.armor.effectRate)}%** · 때리면 ❄️냉기 +1`), '전투 화면: 갑옷 턴 반격 안내');
    }
  }
  // 14-3) 유령(Monster-all): 표식(예고 때 대상 확정, 도발로 대신 맞기, 분노 2명) · 공포(스킬 봉인) · 투명화(일반 공격 무효)
  {
    const E = require(path.join(root, 'handlers/레이드전투.js'));
    const all = E.loadMonsters(path.join(root, 'Monster-all'));
    const ghost = all.find(m => m.id === 'ghost');
    assert(ghost, '유령을 Monster 폴더에서 불러옴');
    if (ghost) {
      const party = [{ userId: 'x', name: 'X', role: 'sword' }, { userId: 't', name: 'T', role: 'tank' }, { userId: 'y', name: 'Y', role: 'healer' }];
      let roll = 0.5; const rng = () => roll;
      let b;
      const M = (u) => E.getMember(b, u);
      const setIntent = (intent) => { b.intent = intent; E.assignMarks(b, rng); };
      const turnWith = (intent, choices = {}) => { if (intent) setIntent(intent); for (const [u, a] of Object.entries(choices)) E.choose(b, u, a); return E.resolveTurn(b, rng); };
      b = E.createBattle(ghost, party, rng);
      setIntent('mark');
      const marked = b.marks.slice();
      assert(marked.length === 1 && E.telegraphText(b).includes(M(marked[0]).name) && !E.telegraphText(b).includes('{target}'), '표식: 예고 때 대상 한 명이 정해지고 예고 문구에 이름');
      const hpBefore = Object.fromEntries(b.members.map(m => [m.userId, m.hp]));
      turnWith(null, { x: 'attack', t: 'attack', y: 'attack' });
      const hitIds = Object.keys(b.lastTurn.hits);
      assert(hitIds.length === 1 && hitIds[0] === marked[0] && M(marked[0]).hp < hpBefore[marked[0]], '영혼 사냥: 표식 대상만 맞음');

      b = E.createBattle(ghost, party, rng);
      setIntent('mark'); b.marks = ['x'];
      M('x').name = '철수'; const t1 = E.telegraphText(b);
      M('x').name = '민혁'; const t2 = E.telegraphText(b);
      M('x').name = 'X';
      assert(t1.includes('철수를') && t2.includes('민혁을') && E.telegraphText(b).includes('X을(를)'), '표식 예고: 이름 받침에 맞춰 을/를');
      turnWith(null, { t: 'skill', x: 'attack', y: 'attack' });
      assert(Object.keys(b.lastTurn.hits).join() === 't' && M('x').hp === 100, '표식: 수호자가 도발하면 대신 맞음');

      b = E.createBattle(ghost, party, rng); b.rage = true;
      setIntent('mark');
      assert(b.marks.length === 2 && new Set(b.marks).size === 2, '분노: 표식 두 명');
      b.marks = ['x', 'y'];
      turnWith(null, { t: 'skill', x: 'attack', y: 'attack' });
      assert(Object.keys(b.lastTurn.hits).sort().join() === 't,y', '분노 2인 표식: 도발은 한 명 몫만 대신 맞음');
      b = E.createBattle(ghost, party, rng); b.rage = true;
      setIntent('mark'); b.marks = ['x', 't'];
      const tHp = M('t').hp;
      turnWith(null, { t: 'skill', x: 'attack', y: 'attack' });
      assert(Object.keys(b.lastTurn.hits).join() === 't' && M('x').hp === 100 && tHp - M('t').hp === b.lastTurn.hits.t && b.log.join().split('T -').length === 3, '분노 표식에 수호자도 걸렸을 때 도발하면 다른 사람 몫까지 대신 맞음(두 번, 피해 합산)');

      b = E.createBattle(ghost, party, rng);
      setIntent('mark'); b.marks = ['x']; M('x').hp = 0;
      turnWith(null, { t: 'attack', y: 'attack' });
      assert(Object.keys(b.lastTurn.hits).length === 1 && !b.lastTurn.hits.x, '표식 대상이 쓰러지면 다른 사람에게 옮김');

      b = E.createBattle(ghost, party, rng);
      turnWith('wail', { x: 'guard', t: 'attack', y: 'attack' });
      assert(!E.isFeared(b, M('x')) && E.isFeared(b, M('t')) && E.checkChoice(b, 't', 'skill') && E.checkChoice(b, 't', 'attack') === null && b.log.join().includes('😱'), '울부짖기: 방어 안 한 사람 😱공포 — 다음 턴 스킬 못 씀');
      turnWith('attack', { x: 'attack', t: 'attack', y: 'attack' });
      assert(!E.isFeared(b, M('t')), '공포는 한 턴만');

      b = E.createBattle(ghost, party, rng);
      turnWith('phase', { x: 'attack', t: 'attack', y: 'attack' });
      const hp0 = b.hp;
      turnWith('attack', { x: 'attack', t: 'attack', y: 'skill' });
      assert(b.hp === hp0 && b.lastTurn.acts.x.label === '빗나감' && b.log.join().includes('빗나'), '투명화: 다음 턴 일반 공격은 빗나감');
      b = E.createBattle(ghost, party, rng);
      turnWith('phase', {});
      const hp1 = b.hp;
      turnWith('attack', { x: 'skill', t: 'attack', y: 'attack' });
      assert(hp1 - b.hp === b.lastTurn.acts.x.value && b.lastTurn.acts.x.value > 0, '투명화: 스킬은 맞음');

      b = E.createBattle(ghost, party, rng);
      turnWith('smash', { x: 'guard', t: 'attack', y: 'attack' });
      assert(!E.isFeared(b, M('x')) && E.isFeared(b, M('t')), '필살 원혼 폭풍: 방어 안 한 사람 공포');
    }
  }
  // 14-4) 꼬마 폭탄(Monster-all): 점화 카운트다운(불끄기 성공 → 기절, 실패 → 대폭발) · 화상 · 연막
  {
    const E = require(path.join(root, 'handlers/레이드전투.js'));
    const all = E.loadMonsters(path.join(root, 'Monster-all'));
    const bomb = all.find(m => m.id === 'bomb');
    assert(bomb, '꼬마 폭탄을 Monster 폴더에서 불러옴');
    if (bomb) {
      const party = [{ userId: 'x', name: 'X', role: 'sword' }, { userId: 'y', name: 'Y', role: 'healer' }];
      const rng = () => 0.5;
      let b;
      const M = (u) => E.getMember(b, u);
      const turnWith = (intent, choices = {}) => { if (intent) b.intent = intent; for (const [u, a] of Object.entries(choices)) E.choose(b, u, a); return E.resolveTurn(b, rng); };
      const fuse = bomb.moves.smash.fuse;
      b = E.createBattle(bomb, party, rng);
      turnWith('smash', { x: 'attack', y: 'attack' });
      assert(b.fuse && b.fuse.need === Math.round(b.maxHp * fuse.need) && b.fuse.dealt === 0 && !Object.keys(b.lastTurn.hits).length && b.log.join().includes('도화선'), '점화: 피해 없이 카운트다운 시작(기준 = 최대 HP × need)');
      const lit = b.turn - 1;
      let intents = [];
      for (let i = 1; i < fuse.turns; i++) { intents.push(b.intent); turnWith(null, { x: 'attack', y: 'attack' }); }
      assert(intents.every(k => k !== 'smash' && k !== fuse.boom) && b.intent === fuse.boom && E.isWarnIntent(b), `카운트다운 중엔 점화를 다시 안 쓰고, ${fuse.turns}턴째에 대폭발 예고(경고)`);
      assert(b.fuse.dealt > 0 && b.fuse.dealt < b.fuse.need, '불끄기: 파티 피해가 쌓임');
      const hpX = M('x').hp;
      turnWith(null, { x: 'guard', y: 'attack' });
      const boom = bomb.moves[fuse.boom];
      const mid = Math.floor(0.5 * (boom.damage[1] - boom.damage[0] + 1)) + boom.damage[0]; // rng 0.5일 때 피해
      assert(!b.fuse && b.lastTurn.monsterMoveKey === fuse.boom && b.lastTurn.hits.x === Math.max(1, Math.round(mid * 1.07 * boom.guardRate)) && hpX - M('x').hp === b.lastTurn.hits.x + (b.lastTurn.poison.x || 0) && M('y').hp < M('x').hp && b.turn - 1 === lit + fuse.turns, '대폭발: 방어해도 guardRate만큼만 막음, 카운트다운 끝');
      assert(['x', 'y'].every(u => M(u).hp <= 0 || (M(u).poisonStatus?.name === '화상' && E.poisonStacks(b, M(u)) >= boom.stacks)) && b.log.join().includes('🔥화상'), '대폭발: 맞은 사람 전원 🔥화상(방어해도 걸림)');

      b = E.createBattle(bomb, party, rng);
      turnWith('smash', {});
      b.fuse.need = 150;
      b.intent = 'attack';
      const hpY = M('y').hp, hpXX = M('x').hp;
      turnWith(null, { x: 'skill', y: 'attack' });
      assert(!b.fuse && b.lastTurn.defused && !Object.keys(b.lastTurn.hits).length && M('y').hp === hpY && M('x').hp === hpXX && b.log.join().includes('불이 꺼졌다'), '불끄기 성공: 그 턴 폭탄 행동 없음(기절)');
      b = E.createBattle(bomb, party, rng);
      turnWith('smash', {});
      b.fuse.need = 1e9;
      for (let i = 1; i < fuse.turns; i++) turnWith(null, { x: 'guard', y: 'guard' });
      assert(b.intent === fuse.boom, '마지막 턴: 대폭발 예고');
      b.fuse.need = b.fuse.dealt + 150;
      const hpY2 = M('y').hp, hpX2 = M('x').hp;
      turnWith(null, { x: 'skill', y: 'attack' });
      assert(!b.fuse && b.lastTurn.defused && b.lastTurn.monsterMoveKey !== fuse.boom && !Object.keys(b.lastTurn.hits).length && M('y').hp === hpY2 - (b.lastTurn.poison.y || 0) && M('x').hp === hpX2 - (b.lastTurn.poison.x || 0), '대폭발 예고 턴(1턴 남음)에 불을 끄면 대폭발 취소');

      b = E.createBattle(bomb, party, rng);
      turnWith('ember', { x: 'attack', y: 'attack' });
      assert(E.poisonStacks(b, M('x')) === 1 && M('x').poisonStatus.name === '화상' && b.log.join().includes('🔥화상'), '분진 흩날리기: 🔥화상(독 규칙)');

      b = E.createBattle(bomb, party, rng);
      turnWith('smoke', { x: 'attack', y: 'attack' });
      assert(E.isIntentHidden(b) && E.telegraphText(b).includes('연막') && !E.telegraphText(b).includes(bomb.moves[b.intent].telegraph), '연막탄: 다음 예고가 가려짐');
      turnWith(null, { x: 'attack', y: 'attack' });
      assert(!E.isIntentHidden(b), '연막은 한 턴만');
      b = E.createBattle(bomb, party, rng);
      turnWith('smoke', {}); b.intent = fuse.boom;
      assert(!E.isIntentHidden(b), '대폭발 예고는 연막으로 가리지 않음');

      // 카운트다운이 끝나면(대폭발·불끄기) 필살기 7턴 카운트를 새로 세고, 끝난 직후 2턴은 다시 점화하지 않음
      let early = 0, resetBoom = true, resetDefuse = true;
      for (let i = 0; i < 200; i++) {
        b = E.createBattle(bomb, party, Math.random);
        turnWith('smash', {}); b.fuse.need = 1e9;
        while (b.intent !== fuse.boom) { E.resolveTurn(b, Math.random); }
        E.resolveTurn(b, Math.random); // 대폭발
        if (b.sinceSmash > 1) resetBoom = false;
        const k1 = b.intent; E.resolveTurn(b, Math.random); const k2 = b.intent;
        if (k1 === 'smash' || k2 === 'smash') early++;
        b = E.createBattle(bomb, party, Math.random);
        turnWith('smash', {}); b.fuse.need = 1; b.intent = 'attack';
        E.resolveTurn(b, Math.random); // 불끄기
        if (b.fuse || b.sinceSmash > 1 || b.intent === 'smash') resetDefuse = false;
      }
      assert(resetBoom && resetDefuse && early === 0, '카운트다운이 끝나면 필살기 카운트를 새로 세고 바로 다시 점화하지 않음');
    }
  }
  // 17) 재시작 후 이어가기: 저장된 모집·전투, 예전 기록, 기록 없는 메시지 / 전멸 벌칙
  {
    const E = require(path.join(root, 'handlers/레이드전투.js'));
    const cfg = require(path.join(root, 'config.js'));
    const { ContainerBuilder, TextDisplayBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    const statePath = path.join(root, 'DB/raid.json');
    const modPath = require.resolve(path.join(root, 'handlers/레이드.js'));
    const settle = async () => { for (let i = 0; i < 20; i++) { await new Promise(r => setImmediate(r)); await flushRender(); } };
    // 재시작 흉내: raid.json을 써 두고 레이드 모듈을 새로 불러 스케줄러를 켠다
    const restart = async (active) => {
      fs.writeFileSync(statePath, JSON.stringify({ autoSpawn: false, nextSpawnAt: null, active }));
      delete require.cache[modPath];
      const mod = require(modPath);
      mod.startRaidScheduler(rclient);
      await settle();
      return mod;
    };
    const channels = {};
    const mkChannel = (id, guildId) => {
      const msgs = new Map();
      const ch = {
        id, guildId, name: id, msgs, lastMessageId: null,
        messages: { fetch: async (q) => (typeof q === 'string' ? msgs.get(q) ?? Promise.reject(new Error('없음')) : new Map(msgs)) },
        send: async (p) => mkMsg(ch, 'new' + msgs.size, p),
      };
      channels[id] = ch;
      return ch;
    };
    const mkMsg = (ch, id, p, extra = {}) => {
      const m = {
        id, guildId: ch.guildId, channelId: ch.id, channel: ch, author: { id: 'bot' },
        createdTimestamp: Date.now(), editedTimestamp: null, components: p.components, last: p,
        edit: async (np) => { m.components = np.components; m.last = np; return m; },
        delete: async () => { ch.msgs.delete(id); },
        ...extra,
      };
      ch.msgs.set(id, m);
      ch.lastMessageId = id;
      return m;
    };
    const rclient = { user: { id: 'bot' }, channels: { fetch: async (id) => channels[id] ?? null }, guilds: { cache: new Map() } };
    const textOf = (m) => m.last.components.map(c => c.toJSON?.() ?? c).flatMap(c => (c.type === 17 ? c.components : [c])).filter(c => c.type === 10).map(c => c.content).join('\n');
    const btnsOf = (m) => m.last.components.map(c => c.toJSON?.() ?? c).flatMap(c => (c.type === 17 ? c.components : [c])).filter(c => c.type === 1).flatMap(r => r.components);
    const press = (mod, m, userId, customId) => {
      const it = fakeInteraction(userId, customId);
      it.message = m; it.guildId = m.guildId;
      return mod.handleRaidButton(it).then(() => flushRender()).then(() => it);
    };
    const legacyPayload = (text, customId) => ({ components: [new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
      .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(customId).setLabel('x').setStyle(ButtonStyle.Primary)))] });

    // (가) 새 형식으로 저장된 모집(1명 참가)을 이어간다
    const chA = mkChannel('chA', 'gMain');
    const mA = mkMsg(chA, 'mA', legacyPayload('옛 화면', 'raid:role:sword'));
    let mod = await restart({ gMain: { channelId: 'chA', messageId: 'mA', monsterId: 'slime', phase: 'recruit', recruitEndsAt: Date.now() + 20 * 60_000, party: [{ userId: '7', name: '유저7', role: 'sword' }] } });
    assert(mod.isPlaygroundPaused('gMain') && lv.isRaidXpFrozen(), '재시작 후 모집 이어가기: 놀이터·XP 정지 유지');
    assert(/## ⏳ 00:(19|20):\d\d/.test(textOf(mA)) && textOf(mA).includes('파티 1 / 4') && btnsOf(mA).some(b => b.label?.includes('검사 · 유저7')), '같은 메시지에 남은 시간·참가자 그대로');
    await press(mod, mA, '8', 'raid:role:archer');
    assert(textOf(mA).includes('파티 2 / 4') && JSON.parse(fs.readFileSync(statePath, 'utf8')).active.gMain.party.length === 2, '이어간 레이드에 참가 가능 + 참가자 저장');
    await mod.forceEndRaid('gMain'); await flushRender();
    assert(!lv.isRaidXpFrozen() && !JSON.parse(fs.readFileSync(statePath, 'utf8')).active.gMain, '끝나면 기록·XP 정지 정리');

    // (나) 기록이 없어도 놀이터에 남은 예전 모집 메시지(⏳ 00:41:48, 10초 전에 고침)를 찾아 이어간다
    const chP = mkChannel(cfg.PLAYGROUND_CHANNEL_ID, cfg.GUILD_ID);
    const mP = mkMsg(chP, 'mP', legacyPayload('슬라임이 XP 시스템을 망가뜨려\n## ⏳ 00:41:48\n**파티 0 / 4**', 'raid:role:sword'), { editedTimestamp: Date.now() - 10_000 });
    mod = await restart({});
    assert(mod.isPlaygroundPaused(cfg.GUILD_ID) && lv.isRaidXpFrozen(), '기록 없이 남은 레이드 메시지도 찾아서 이어감');
    assert(/## ⏳ 00:41:(3\d|4\d)/.test(textOf(mP)) && textOf(mP).includes('파티 0 / 4'), '예전 화면의 남은 시간으로 마감 시각 복구');
    await press(mod, mP, '9', 'raid:role:healer');
    assert(textOf(mP).includes('파티 1 / 4'), '복구한 예전 모집에 참가 가능');
    await mod.forceEndRaid(cfg.GUILD_ID); await flushRender();

    // (다) 예전 형식 기록인데 전투 중이던 메시지 → 이어갈 수 없어 점검 중단으로 정리
    const chB = mkChannel('chB', 'gMain');
    const mB = mkMsg(chB, 'mB', legacyPayload('## ⚔️ TURN 3 · 행동을 고르세요', 'raid:act:attack'));
    mod = await restart({ gMain: { channelId: 'chB', messageId: 'mB' } });
    assert(!mod.isPlaygroundPaused('gMain') && !lv.isRaidXpFrozen() && textOf(mB).includes('봇 점검'), '예전 버전의 전투 메시지는 점검 중단으로 정리');

    // (라) 저장된 전투를 이어가고, 전멸하면 서버 모든 유저 -50~100 XP(무작위) + 문구
    lv.applyXp('gMain', 'p1', 200); lv.applyXp('gMain', 'p2', 60);
    const before = { p1: lv.getXp('gMain', 'p1'), p2: lv.getXp('gMain', 'p2') };
    const { monster, ...battle } = E.createBattle(E.MONSTERS[0], [{ userId: '5', name: '유저5', role: 'sword' }]);
    battle.members[0].hp = 1; battle.intent = 'sweep';
    const chC = mkChannel('chC', 'gMain');
    const mC = mkMsg(chC, 'mC', legacyPayload('옛 화면', 'raid:act:attack'));
    mod = await restart({ gMain: { channelId: 'chC', messageId: 'mC', monsterId: 'slime', phase: 'battle', recruitEndsAt: 0, party: [{ userId: '5', name: '유저5', role: 'sword' }], battle, battleStartedAt: Date.now() - 60_000, battleEndsAt: Date.now() - 1000 } });
    assert(mod.isPlaygroundPaused('gMain') && textOf(mC).includes('TURN 1 · 행동을 고르세요'), '재시작 후 전투 이어가기(전투 시간이 지났어도 한 턴은 줌)');
    const allBefore = lv.getLeaderboard('gMain', 1e9).map(x => x.xp).filter(xp => xp > 0);
    await press(mod, mC, '5', 'raid:act:attack');
    console.log('--- 전멸 결과 글자 ---\n' + textOf(mC));
    const chNotes = [...chC.msgs.values()].map(m => m.last?.content).filter(Boolean);
    assert(!textOf(mC).includes('XP를 잃어') && !textOf(mC).includes('XP 시스템 복구됨'), '전멸 화면 작은 글씨엔 벌칙·복구 문구 없음');
    const amt = Number(chNotes.map(c => c.match(/^☠️ 모든 유저의 [*]{2}([0-9]+)XP[*]{2}를 잃어버렸습니다[.]{3}/)?.[1]).find(Boolean));
    assert(amt >= 50 && amt <= 100 && !chNotes.some(c => c.includes('복구 완료')), `전멸 시 채널 안내: 복구 완료 대신 XP 손실(${amt}, 50~100)`);
    assert(lv.getXp('gMain', 'p1') === before.p1 - amt && lv.getXp('gMain', 'p2') === Math.max(0, before.p2 - amt), `전멸하면 서버 모든 유저 -${amt} XP(0 밑으로는 안 내려감)`);
    { // 안내의 인원·합계는 실제로 깎인 값이어야 한다(0에서 잘린 만큼은 합계에서 빠짐)
      const note = chNotes.find(c => c.includes('잃어버렸습니다')) ?? '';
      const m = note.match(/\n-# ([\d,]+)명 · 합계 : -([\d,]+) XP\n-# 중단 시간 : .+ \(\d\d:\d\d~\d\d:\d\d\)$/);
      const num = s => Number(s.replace(/,/g, ''));
      const wantTotal = allBefore.reduce((s, xp) => s + Math.min(xp, amt), 0);
      console.log('--- 전멸 채널 안내 ---\n' + note);
      assert(m && num(m[1]) === allBefore.length && num(m[2]) === wantTotal, `전멸 안내 작은 글씨: N명 · 합계 : -N XP / 다음 줄에 중단 시간 : … (실제 깎인 값 ${allBefore.length}명/${wantTotal})`);
    }
    assert(!lv.isRaidXpFrozen() && !mod.isPlaygroundPaused('gMain'), '전멸 후 XP 정지 해제');
  }
  console.log('그림 업로드 횟수:', images.length, '· RSS', Math.round(process.memoryUsage().rss/1048576), 'MB');
})().catch(e => { console.error('테스트 실패', e); process.exitCode = 1; });

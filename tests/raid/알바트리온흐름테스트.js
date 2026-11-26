// 알바트리온(속성 직업 모집·전투·재회전) 흐름 테스트: 실제 discord.js 빌더 + 가짜 채널/인터랙션, 타이머는 수동 실행.
// 직접 실행하지 말고 node tests/raid/알바트리온실행.js 로 — 임시 폴더에서 돌린다.
const path = require('path');
const root = __dirname;
const timers = [];
global.setTimeout = (fn, ms) => { const t = { fn, ms, cancelled: false, unref() { return t; } }; timers.push(t); return t; };
global.clearTimeout = (t) => { if (t) t.cancelled = true; };
global.setInterval = () => ({ unref() {} });
async function flushRender() {
  for (let guard = 0; guard < 50; guard++) {
    const due = timers.filter(t => !t.cancelled && t.ms <= 1000);
    if (!due.length) { await new Promise(r => setImmediate(r)); if (!timers.some(t => !t.cancelled && t.ms <= 1000)) return; continue; }
    for (const t of due) { timers.splice(timers.indexOf(t), 1); await t.fn(); }
    await new Promise(r => setImmediate(r));
  }
}
const runTimers = async () => { const due = timers.filter(t => !t.cancelled && t.ms > 1000); for (const t of due) { timers.splice(timers.indexOf(t), 1); await t.fn(); } await flushRender(); };

const raidMod = require(path.join(root, 'handlers/레이드/index.js'));
const battleMod = require(path.join(root, 'handlers/레이드/전투.js'));
const origHandle = raidMod.handleRaidButton, origSpawn = raidMod.forceSpawnRaid;
raidMod.handleRaidButton = async (it) => { await origHandle(it); await flushRender(); };
raidMod.forceSpawnRaid = async (...a) => { const v = await origSpawn(...a); await flushRender(); return v; };
const lv = require(path.join(root, 'handlers/레벨/레벨링.js'));
const assert = (c, m) => { if (!c) { console.error('❌', m); process.exitCode = 1; } else console.log('✅', m); };

let current = null; const images = [];
const message = { id: 'msg1', channel: null, edit: async (p) => { current = p; if (p.files) images.push(p.files[0].attachment); return message; } };
const channel = { id: 'ch1', guildId: 'gMain', name: '놀이터', send: async (p) => { if (!message.channel || (p.components && !p.reply)) { message.channel = channel; current = p; if (p.files) images.push(p.files[0].attachment); return message; } return { id: 'x', delete: async () => {} }; } };
const client = { channels: { fetch: async () => channel }, guilds: { cache: new Map() } };
const parts = () => current.components.map(c => c.toJSON()).flatMap(c => (c.type === 17 ? c.components : [c]));
const desc = () => parts().filter(c => c.type === 10).map(c => c.content).join('\n');
const buttons = () => parts().filter(c => c.type === 1).flatMap(r => r.components);
function fakeInteraction(userId, customId) {
  const it = {
    customId, guildId: channel.guildId, user: { id: userId, username: 'u' + userId }, member: { displayName: '유저' + userId },
    message, replied: null,
    reply: async (p) => { it.replied = p; }, deleteReply: async () => {}, deferUpdate: async () => { it.deferred = true; },
    update: async (p) => { current = p; if (p.files) images.push(p.files[0].attachment); return { resource: { message: null } }; },
  };
  return it;
}

const pText = (p) => {
  const out = [p?.content || ''];
  const walk = (list) => { for (const c of list || []) { const j = c?.toJSON?.() ?? c; if (j.type === 10) out.push(j.content); walk(j.components); } };
  walk(p?.components);
  return out.join('\n');
};
const MAIN = 'gMain', TEST = '1282694117255548960';
const press = async (uid, id) => { const it = fakeInteraction(uid, id); await raidMod.handleRaidButton(it); return it; };
const phase = () => raidMod.raidForTest(channel.guildId)?.phase;

(async () => {
  lv.loadLevels();
  // ── 테스트 서버 전용(testOnly): 본서버에서는 소환이 거절된다 ──
  const alatMon = battleMod.ALL_MONSTERS.find(m => m.id === 'alatreon');
  assert(alatMon.testOnly === true, '알바트리온은 testOnly(테스트 서버 전용)');
  { const refused = await raidMod.forceSpawnRaid({ guildId: 'other', channel, client }, 'alatreon'); assert(/테스트 서버/.test(String(refused)) && !raidMod.getRaidStatus(MAIN).active, '본서버 소환은 거절됨'); }
  alatMon.testOnly = false; // 아래 본서버 흐름 검증은 공개 상태를 가정(테스트 서버 구간 앞에서 다시 켠다)
  // ── 모집(본서버) ──
  let err = await raidMod.forceSpawnRaid({ guildId: 'other', channel, client }, 'alatreon');
  assert(!err && raidMod.getRaidStatus(MAIN).active, '알바트리온 소환 성공');
  const roleIds = () => buttons().filter(b => b.custom_id?.startsWith('raid:role:')).map(b => b.custom_id.slice(10));
  assert(JSON.stringify(roleIds()) === JSON.stringify(['fire', 'water', 'thunder', 'ice']), '모집 버튼은 fire/water/thunder/ice 4개(sword 없음)');
  const btnText = JSON.stringify(buttons()) + desc();
  assert(!/화염기사|수정술사|뇌창사|빙결기사|검사|궁수|수호자|치유사/.test(btnText), '모집 화면에 직업 이름이 나오지 않음');
  if (process.env.DUMP_DIR) require('fs').writeFileSync(process.env.DUMP_DIR + '/alat-recruit.png', images[images.length - 1]);
  assert(['🔥', '💧', '⚡', '❄️'].every(e => buttons().some(b => b.emoji?.name === e)), '버튼에 🔥💧⚡❄️ 이모지');
  assert(buttons().find(b => b.custom_id === 'raid:start').disabled === true, '아무도 없으면 시작 버튼 비활성');

  await press('1', 'raid:role:fire');
  let it = await press('2', 'raid:role:fire');
  assert(pText(it.replied).includes('이미 다른 사람이 고른 역할이에요.'), '같은 속성 중복 선택 거부');
  await press('1', 'raid:role:water');
  let party = raidMod.raidForTest(MAIN).party;
  assert(party.length === 1 && party[0].role === 'water', '참가자가 속성을 바꾸면 자리만 옮김');
  await press('2', 'raid:role:fire');
  await press('3', 'raid:role:thunder');
  assert(raidMod.raidForTest(MAIN).party.length === 3 && phase() === 'recruit', '3명 모집 중');
  assert(buttons().find(b => b.custom_id === 'raid:start').disabled === false, '3명이어도 시작 버튼 활성(전원 필수 아님)');
  it = await press('1', 'raid:start');
  assert(phase() === 'battle', '3명으로 바로 시작');
  await raidMod.forceEndRaid(MAIN);

  // ── 4명 → 자동 시작 ──
  err = await raidMod.forceSpawnRaid({ guildId: 'other', channel, client }, 'alatreon');
  for (const [uid, role] of [['1', 'fire'], ['2', 'water'], ['3', 'thunder'], ['4', 'ice']]) await press(uid, 'raid:role:' + role);
  assert(phase() === 'battle', '4속성이 모이면 자동으로 전투 시작');
  assert(desc().includes('TURN 1') && !desc().includes('에스카톤'), '전투 화면에 TURN 1 (속성 현황은 그림 안 왼쪽 위로 옮겨 글자에는 없음)');
  if (process.env.DUMP_DIR) require('fs').writeFileSync(process.env.DUMP_DIR + '/alat-battle.png', images[images.length - 1]); // 눈으로 확인용
  assert(!/화염기사|수정술사|뇌창사|빙결기사|검사|궁수|수호자|치유사/.test(desc()), '전투 화면에도 직업 이름 없음');
  await raidMod.forceEndRaid(MAIN);

  // ── 클리어 보상: MVP 한 명만 역린, 나머지는 해킹 툴 ──
  err = await raidMod.forceSpawnRaid({ guildId: 'other', channel, client }, 'alatreon');
  for (const [uid, role] of [['1', 'fire'], ['2', 'water'], ['3', 'thunder'], ['4', 'ice']]) await press(uid, 'raid:role:' + role);
  assert(phase() === 'battle', '보상 시나리오: 전투 시작');
  const rr = require(path.join(root, 'handlers/게임/역린.js'));
  const ht = require(path.join(root, 'handlers/게임/해킹툴.js'));
  raidMod.raidForTest(MAIN).battle.hp = 1;
  // 앞 순서(화·수·뇌)가 먼저 쓰러뜨리면 뒤 순서는 행동하지 못해 보상이 없으므로, 셋은 방어하고 마지막 순서(빙)가 쓰러뜨린다.
  for (const uid of ['1', '2', '3']) await press(uid, 'raid:act:guard');
  await press('4', 'raid:act:attack');
  await runTimers();
  assert(!raidMod.getRaidStatus(MAIN).active, '보상 시나리오: 클리어로 종료');
  const rerolls = ['1', '2', '3', '4'].map(u => rr.getRerolls(MAIN, u));
  assert(rerolls.reduce((a, b) => a + b, 0) === 1 && rerolls[3] === 1, `클리어 보상: MVP(피해를 준 빙 직업) 한 명만 역린 1개 (${rerolls.join(',')})`);
  assert(['1', '2', '3'].every(u => ht.getHackTools(MAIN, u) === 1) && ht.getHackTools(MAIN, '4') === 0, '클리어 보상: 나머지는 해킹 툴 1개, MVP는 해킹 툴 대신 역린');

  // ── 전체 흐름 1: 상성 직업이 게이지를 채워 에스카톤을 억제하고 몬스터를 쓰러뜨린다 ──
  const joinAll = async (ids) => {
    await raidMod.forceSpawnRaid({ guildId: 'other', channel, client }, 'alatreon');
    for (const [uid, role] of ids) await press(uid, 'raid:role:' + role);
  };
  const ROLE_BY = { fire: 'water', water: 'thunder', thunder: 'ice', ice: 'fire' }; // 속성 → 억제 직업(알바트리온.js 와 같은 고리)
  await joinAll([['11', 'fire'], ['12', 'water'], ['13', 'thunder'], ['14', 'ice']]);
  assert(phase() === 'battle', '전체 흐름 1: 전투 시작');
  const rr1 = raidMod.raidForTest(MAIN);
  rr1.battle.hp = 1500; // 에스카톤 전에 쓰러지지 않을 만큼(600이면 치명타가 몰리면 에스카톤 전에 끝나 흔들렸다), 몇 턴 안에 끝날 만큼
  rr1.battle.alat.cycleTurn = rr1.battle.alat.cycleLen - 1; // 다음 턴이 에스카톤
  let sawEscaton = false, suppressedAll = true, g1 = 0;
  while (phase() === 'battle' && g1++ < 12) {
    const b = raidMod.raidForTest(MAIN).battle;
    const escaton = b.intent === 'smash';
    for (const mm of b.members) mm.hp = Math.max(mm.hp, 100); // 속성 무관 무작위 공격과 약점 피해로 파티가 쓰러져 전멸하면 클리어 화면이 아니라서 흔들렸다 — 이 흐름은 클리어 경로를 보는 테스트라 체력을 채워 둔다
    if (escaton) b.alat.gauge = 100; // 상성 직업이 채웠다고 보고(억제 성공 경로)
    for (const [uid, role] of [['11', 'fire'], ['12', 'water'], ['13', 'thunder'], ['14', 'ice']]) {
      const alive = b.members.find(m => m.userId === uid)?.hp > 0;
      if (!alive) continue;
      const act = escaton ? (role === 'fire' || role === 'thunder' ? 'attack' : 'guard') : 'attack';
      await press(uid, 'raid:act:' + act);
    }
    if (b.lastTurn?.escaton) { sawEscaton = true; if (!b.lastTurn.escaton.suppressed) suppressedAll = false; }
    await runTimers();
  }
  assert(sawEscaton && suppressedAll, '전체 흐름 1: 에스카톤이 한 번 이상 오고 모두 억제됨');
  assert(!raidMod.getRaidStatus(MAIN).active, '전체 흐름 1: 몬스터를 쓰러뜨려 종료');
  if (process.env.DUMP_DIR) require('fs').writeFileSync(process.env.DUMP_DIR + '/alat-clear.png', images[images.length - 1]); // 종료 화면 확인용
  assert(/CLEAR|토벌/.test(desc()) && desc().includes('역린'), '전체 흐름 1: 종료 화면에 클리어와 역린 보상 문구');

  // ── 전체 흐름 2: 아무도 게이지를 안 채우면 에스카톤에 전멸한다 ──
  await joinAll([['21', 'fire'], ['22', 'water'], ['23', 'thunder'], ['24', 'ice']]);
  raidMod.raidForTest(MAIN).battle.alat.cycleTurn = raidMod.raidForTest(MAIN).battle.alat.cycleLen - 1;
  let g2 = 0, escatonLog = false;
  while (phase() === 'battle' && g2++ < 12) {
    const b = raidMod.raidForTest(MAIN).battle;
    for (const [uid] of [['21'], ['22'], ['23'], ['24']]) await press(uid, 'raid:act:guard'); // 방어만 — 게이지는 오르지 않는다
    if (b.log?.some(l => l.includes('에스카톤'))) escatonLog = true;
    await runTimers();
  }
  assert(escatonLog, '전체 흐름 2: 에스카톤 로그(억제 실패)가 남음');
  const r2 = raidMod.raidForTest(MAIN); // 알바트리온은 지속형(raid.persistent)이라 전멸해도 도망치지 않고 모집 상태로 돌아간다
  assert(raidMod.getRaidStatus(MAIN).active && r2.phase === 'recruit', `전체 흐름 2: 전멸해도 종료되지 않고 모집 상태로 복귀 (phase ${r2?.phase})`);
  assert(r2.defeatStacks === 1 && r2.party.length === 0 && !r2.battle, '전체 흐름 2: 패배 1회 누적, 파티·전투 초기화');

  // ── 테스트 서버: 1명이어도 시작 ──
  channel.guildId = TEST; message.channel = null;
  err = await raidMod.forceSpawnRaid({ guildId: 'other', channel, client }, 'alatreon');
  assert(!err, '테스트 서버에서 소환');
  await press('1', 'raid:role:fire');
  assert(buttons().find(b => b.custom_id === 'raid:start').disabled === false, '테스트 서버는 1명이어도 시작 버튼 활성');
  it = await press('1', 'raid:start');
  const solo = JSON.stringify(it.replied ?? {}).includes('raid:solo:yes');
  if (solo) await press('1', 'raid:solo:yes');
  assert(phase() === 'battle' && desc().includes('TURN 1'), '테스트 서버: 1명으로 전투 시작');
  await raidMod.forceEndRaid(TEST);
  channel.guildId = MAIN;
  console.log('그림 업로드', images.length);
})().catch(e => { console.error('테스트 실패', e); process.exitCode = 1; });

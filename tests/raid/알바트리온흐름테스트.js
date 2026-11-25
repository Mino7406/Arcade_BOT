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
  assert(buttons().find(b => b.custom_id === 'raid:start').disabled === true, '3명이면 시작 버튼 비활성');
  it = await press('1', 'raid:start');
  assert(pText(it.replied).includes('모든 속성이 모여야') && phase() === 'recruit', '3명 시작 시도: 안내 문구, 전투 시작 안 됨');
  await runTimers(); // 모집 마감
  assert(!raidMod.getRaidStatus(MAIN).active, '3명으로 모집이 끝나면 noshow로 종료');

  // ── 4명 → 자동 시작 ──
  err = await raidMod.forceSpawnRaid({ guildId: 'other', channel, client }, 'alatreon');
  for (const [uid, role] of [['1', 'fire'], ['2', 'water'], ['3', 'thunder'], ['4', 'ice']]) await press(uid, 'raid:role:' + role);
  assert(phase() === 'battle', '4속성이 모이면 자동으로 전투 시작');
  assert(desc().includes('TURN 1') && desc().includes('에스카톤'), '전투 화면에 TURN 1과 속성 상태 문구(에스카톤)');
  if (process.env.DUMP_DIR) require('fs').writeFileSync(process.env.DUMP_DIR + '/alat-battle.png', images[images.length - 1]); // 눈으로 확인용
  assert(!/화염기사|수정술사|뇌창사|빙결기사|검사|궁수|수호자|치유사/.test(desc()), '전투 화면에도 직업 이름 없음');
  await raidMod.forceEndRaid(MAIN);

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

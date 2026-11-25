// 흉성(위장 → 습격 → 돌덩이 쉬는 턴) 흐름 테스트: 실제 discord.js 빌더 + 가짜 채널/인터랙션, 타이머는 수동 실행.
// 직접 실행하지 말고 node tests/raid/흉성실행.js 로 — 임시 폴더에서 돌린다.
const path = require('path');
const root = __dirname;
const timers = [];
if (process.env.SEED) { let a = Number(process.env.SEED) >>> 0; Math.random = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; } // SEED=숫자 로 같은 난수를 다시 재현
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
const runTimers = async () => { const due = timers.filter(t => !t.cancelled && t.ms > 1000).sort((x, y) => x.ms - y.ms); for (const t of due) { timers.splice(timers.indexOf(t), 1); await t.fn(); await flushRender(); } await flushRender(); }; // 타이머마다 그림을 그려 본다(실제로는 몇 초씩 떨어져 있어 그림이 합쳐지지 않는다)

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
    customId, guildId: 'gMain', user: { id: userId, username: 'u' + userId }, member: { displayName: '유저' + userId },
    message, replied: null,
    reply: async (p) => { it.replied = p; }, deferUpdate: async () => { it.deferred = true; },
    update: async (p) => { current = p; if (p.files) images.push(p.files[0].attachment); return { resource: { message: null } }; },
  };
  return it;
}

(async () => {
  lv.loadLevels();
  const normalNames = battleMod.MONSTERS.map(m => m.name);
  const err = await raidMod.forceSpawnRaid({ guildId: 'other', channel, client }, 'heungseong');
  assert(!err, '흉성 소환 성공(관리자가 고난이도를 직접 고름)');
  const st = raidMod.getRaidStatus(channel.guildId);
  assert(st.active && normalNames.includes(st.monsterName) && st.monsterName !== '흉성', `모집 화면은 일반 몬스터(${st.monsterName})로 위장 — 흉성 이름이 보이지 않음`);
  assert(!desc().includes('흉성'), '모집 글자에 흉성이 나오지 않음');
  for (const [uid, role] of [['1', 'sword'], ['2', 'archer'], ['3', 'healer']]) await raidMod.handleRaidButton(fakeInteraction(uid, 'raid:role:' + role));
  await runTimers();
  assert(desc().includes('TURN 1') && buttons().some(b => b.custom_id === 'raid:act:attack'), '전투 시작(TURN 1)');

  // 예고 문구는 그림 안에 있어 글자로는 안 보인다 → 몬스터 이름이 흉성으로 바뀌는 순간(착지)으로 습격을 잡는다.
  let landedAt = 0, turnGuard = 0, imagesBefore = 0;
  while (buttons().length && turnGuard++ < 120) {
    if (desc().includes(' 종료\n')) { await runTimers(); continue; }
    const d = desc();
    const turn = +(d.match(/TURN (\d+)/)?.[1] ?? 0);
    const before = raidMod.getRaidStatus(channel.guildId).monsterName;
    if (!landedAt) for (const m of raidMod.raidForTest(channel.guildId).battle.members) { m.stunTurn = 0; m.stunStatus = null; m.poisonStacks = 0; m.poisonUntil = 0; if (m.hp < 60) m.hp = 60; } // 위장 몬스터가 건 기절·독·화상은 풀고 쓰러진 사람은 살려 둔다(기절하면 방어를 못 하고, 위장 몬스터의 화상이 남으면 습격 화상 검사와 섞여 난수에 따라 깨졌다)
    imagesBefore = images.length;
    for (const uid of ['1', '2', '3']) {
      // 습격 전엔 유저1만 방어하고 나머지는 약하게 공격한다(위장 몬스터가 먼저 쓰러지지 않게 — 먼저 쓰러지는 경우는 엔진 시뮬로 확인).
      // 습격 턴에 방어하지 못한 사람(유저2·3)에게 기절·화상이 걸리는지 보기 위해서다.
      const acts = !landedAt ? (uid === '1' ? ['guard'] : ['attack']) : (d.includes('방어 추천') ? ['guard'] : ['skill', 'potion', 'attack']);
      for (const act of acts) {
        if (act === 'potion' && !d.includes(`유저${uid}`)) continue;
        const t = fakeInteraction(uid, 'raid:act:' + act); await raidMod.handleRaidButton(t);
        if (!t.replied) break;
        if (/쓰러진|끝난/.test(JSON.stringify(t.replied))) break;
      }
      if (!buttons().length) break;
    }
    const after = raidMod.getRaidStatus(channel.guildId).monsterName;
    if (!landedAt && before !== '흉성' && after === '흉성') {
      landedAt = turn;
      assert(turn >= 4 && turn <= 6, `습격 착지는 4~6턴 중(${turn}턴, 위장 몬스터: ${before})`);
      assert(desc().includes('TURN ' + turn + ' 종료'), '습격 착지 결과 화면');
      if (process.env.DUMP_DIR) { // 단계별 그림을 하나씩 저장(눈으로 확인용)
        require('fs').writeFileSync(process.env.DUMP_DIR + '/st0.png', images[images.length - 1]);
        const st = timers.filter(t => !t.cancelled && [5500].includes(t.ms)).sort((a, b) => a.ms - b.ms);
        let n = 1; for (const t of st) { timers.splice(timers.indexOf(t), 1); await t.fn(); await flushRender(); require('fs').writeFileSync(process.env.DUMP_DIR + '/st' + (n++) + '.png', images[images.length - 1]); }
      }
      const imagesBeforeTimers = images.length;
      await runTimers(); // 단계 타이머(2·3단계)와 결과 타이머 실행 → 다음 턴(쉬는 턴) 선택 화면
      assert(images.length - imagesBeforeTimers >= 2, `착지 결과가 단계별로 다시 그려짐(타이머 뒤 그림 ${images.length - imagesBeforeTimers}장, 남은 타이머 ${timers.filter(t => !t.cancelled).map(t => t.ms).join(',')}, 화면 ${desc().split('\n')[0]})`);
      if (process.env.DUMP_DIR) { require('fs').writeFileSync(process.env.DUMP_DIR + '/stage_last.png', images[images.length - 1]); require('fs').writeFileSync(process.env.DUMP_DIR + '/stage_first.png', images[imagesBefore + 1] ?? images[images.length - 1]); }
      const burnLine = desc().split('\n').find(l => l.includes('화상:')) ?? '';
      assert(burnLine.includes('유저2') && burnLine.includes('유저3') && !burnLine.includes('유저1'), `방어하지 못한 사람(유저2·3)에게만 화상, 방어한 유저1은 없음 (화상줄: ${burnLine}, 화면: ${desc().split('\n').join(' / ').slice(0, 300)})`);
      const stunned = fakeInteraction('2', 'raid:act:attack'); await raidMod.handleRaidButton(stunned);
      assert(JSON.stringify(stunned.replied ?? {}).includes('기절'), '방어하지 못한 유저2는 다음 턴 기절(행동 불가)');
      const guarded = fakeInteraction('1', 'raid:act:attack'); await raidMod.handleRaidButton(guarded);
      assert(!JSON.stringify(guarded.replied ?? {}).includes('기절'), '방어한 유저1은 기절하지 않음');
    }
  }
  assert(landedAt >= 4, '습격이 전투 중에 한 번 일어남');
  console.log('--- 결과 글자 ---\n' + desc().split('\n').slice(0, 3).join('\n'));
  assert(!buttons().length, '전투가 끝까지 진행되어 종료');

  // ── 시나리오 2: 파티원이 모두 기절한 채로 습격 예고 턴을 맞는 경우 — 예고 화면이 건너뛰어지지 않고, 5초 뒤 착지해야 한다 ──
  await raidMod.forceSpawnRaid({ guildId: 'other', channel, client }, 'heungseong');
  for (const [uid, role] of [['1', 'sword'], ['2', 'archer'], ['3', 'healer']]) await raidMod.handleRaidButton(fakeInteraction(uid, 'raid:role:' + role));
  await runTimers();
  let stunTested = false;
  for (let guard = 0; guard < 80 && !stunTested; guard++) {
    const rr = raidMod.raidForTest(channel.guildId);
    if (!rr || rr.phase !== 'battle') break;
    if (rr.showingResult) {
      if (rr.battle.intent === 'ambush') {
        for (const m of rr.battle.members) { m.stunTurn = rr.battle.turn; m.stunStatus = { name: '기절', emoji: '💫' }; } // 이번(다음) 턴에 모두 기절
        await runTimers(); // 결과 화면이 끝나고 선택 화면으로 넘어가는 순간
        const name1 = raidMod.getRaidStatus(channel.guildId).monsterName;
        assert(name1 !== '흉성', `모두 기절이어도 습격 예고 화면부터 보임(아직 위장: ${name1})`);
        assert(timers.some(t => !t.cancelled && t.ms === 5000), '예고 화면을 5초 보여 준 뒤 진행하는 타이머가 걸림');
        await runTimers(); // 예고 화면 끝 → 턴 진행
        const name2 = raidMod.getRaidStatus(channel.guildId).monsterName;
        assert(name2 === '흉성', `예고가 끝나면 습격이 착지함(${name2})`);
        stunTested = true;
      } else await runTimers();
    } else if (buttons().length) {
      for (const uid of ['1', '2', '3']) { const t = fakeInteraction(uid, 'raid:act:guard'); await raidMod.handleRaidButton(t); }
    } else await runTimers();
  }
  assert(stunTested, '모두 기절 시나리오까지 도달함');
  process.exit(process.exitCode || 0);
})().catch(e => { console.error('❌ 예외', e); process.exit(1); });

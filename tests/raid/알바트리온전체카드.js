// 알바트리온이 낼 수 있는 모든 화면을 그려 폴더에 저장한다(중간 점검용): node tests/raid/알바트리온전체카드.js <저장폴더>
// 모집(0·2·4명) · 전투 선택(속성 5가지, 분노) · 기술 결과 6가지(속성 5가지 포함) · 필살 준비/억제 성공/억제 실패 · 종료(클리어·전멸·시간초과·도주)
// 임시 폴더에 복사해서 돌리므로 DB를 건드리지 않는다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = path.join(__dirname, '..', '..');
const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'alat-all'));
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alatall-'));
const runner = `
const path = require('path');
const fs = require('fs');
const raidMod = require('./handlers/레이드/index.js');
const B = require('./handlers/레이드/전투.js');
const mon = B.loadMonsters().find(m => m.id === 'alatreon');
const OUT = ${JSON.stringify(out)};
const roles = ['fire', 'water', 'thunder', 'ice'];
const party = (n) => roles.slice(0, n).map((role, i) => ({ userId: String(100 + i), name: '유저' + (i + 1), role }));
const save = (name, v) => { fs.writeFileSync(path.join(OUT, name + '.png'), v.files[0].attachment); console.log('saved', name); };
const base = (n = 4) => ({ client: null, monster: mon, guildId: '1', channelId: '2', phase: 'battle', party: party(n), recruitEndsAt: Date.now() + 9e5, battleEndsAt: Date.now() + 9e5, turnEndsAt: Date.now() + 25e3, freezesXp: true, hasImage: false });
const mk = (el, intent, n = 4) => { const rr = base(n); rr.battle = B.createBattle(mon, rr.party, Math.random, { minParty: 1 }); rr.battle.alat.element = el; rr.battle.intent = intent; return rr; };
const play = (rr, rng = 0.5, gauge = null, guard = false) => { for (const m of rr.battle.members) B.choose(rr.battle, m.userId, guard || m.role === 'fire' ? 'guard' : 'attack'); if (gauge !== null) rr.battle.alat.gauge = gauge; const el = rr.battle.alat.element; B.resolveTurn(rr.battle, () => rng); rr.battle.alat.element = el; rr.showingResult = true; };
(async () => {
  // ── 모집 ──
  for (const n of [0, 2, 4]) { const rr = base(n); rr.phase = 'recruit'; save('01_모집_' + n + '명', await raidMod.recruitView(rr)); }
  // ── 전투 선택 화면: 속성 5가지 ──
  for (const el of ['fire', 'water', 'thunder', 'ice', 'dragon']) save('02_선택_' + el, await raidMod.battleView(mk(el, 'attack')));
  // 선택 일부 완료 + 분노
  { const rr = mk('fire', 'attack'); rr.battle.members[0].choice = 'attack'; rr.battle.members[1].choice = 'guard'; save('03_선택_일부선택', await raidMod.battleView(rr)); }
  { const rr = mk('thunder', 'attack'); rr.battle.rage = true; rr.battle.hp = Math.round(rr.battle.maxHp * 0.3); save('04_선택_분노', await raidMod.battleView(rr)); }
  // ── 기술 결과 ──
  for (const [key, el] of [['flame', 'fire'], ['torrent', 'water'], ['bolt', 'thunder'], ['frost', 'ice'], ['dragonbreath', 'dragon'], ['attack', 'fire']]) { const rr = mk(el, key); play(rr); save('05_결과_' + key, await raidMod.battleView(rr)); }
  // 분노 중 기술 결과
  { const rr = mk('ice', 'frost'); rr.battle.rage = true; rr.battle.hp = Math.round(rr.battle.maxHp * 0.3); play(rr); save('06_결과_분노_frost', await raidMod.battleView(rr)); }
  // ── 필살(에스카톤) ──
  save('07_필살_준비', await raidMod.battleView(mk('water', 'smash')));
  { const rr = mk('ice', 'smash'); play(rr, 0.5, 100, true); save('08_필살_억제성공', await raidMod.battleView(rr)); }
  { const rr = mk('fire', 'smash'); play(rr, 0.5, 0, false); save('09_필살_억제실패', await raidMod.battleView(rr)); }
  // ── 쓰러진 파티원이 있는 전투 ──
  { const rr = mk('thunder', 'bolt'); rr.battle.members[1].hp = 0; rr.battle.members[2].hp = 18; play(rr); save('10_결과_쓰러짐', await raidMod.battleView(rr)); }
  // ── 종료 ──
  const rewards = party(4).map((m, i) => ({ userId: m.userId, xp: i ? 300 : 400, mvp: i === 0, hackTool: i > 0, reroll: i === 0 }));
  for (const outcome of ['clear', 'wipe', 'timeout', 'noshow']) { const rr = mk('fire', 'attack'); if (outcome === 'clear') rr.battle.hp = 0; play(rr); save('11_종료_' + outcome, await raidMod.endView(rr, outcome, outcome === 'clear' ? rewards : [])); }
})().catch(e => { console.error(e); process.exit(1); });
`;
try {
  for (const dir of ['handlers', 'commands', 'assets', 'Monster']) fs.cpSync(path.join(repo, dir), path.join(tmp, dir), { recursive: true });
  fs.copyFileSync(path.join(repo, 'config.js'), path.join(tmp, 'config.js'));
  fs.writeFileSync(path.join(tmp, 'run.js'), runner);
  const r = spawnSync(process.execPath, [path.join(tmp, 'run.js')], { encoding: 'utf8', env: { ...process.env, NODE_PATH: path.join(repo, 'node_modules') } });
  console.log(((r.stdout || '') + (r.stderr || '')).split('\n').filter(l => !l.startsWith('🎨')).join('\n'));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 알바트리온 기술 연출을 그림 파일로 저장해 눈으로 확인한다: node tests/raid/알바트리온연출덤프.js <저장폴더>
// 임시 폴더에 복사해서 돌리므로 DB를 건드리지 않는다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = path.join(__dirname, '..', '..');
const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'alat-fx'));
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alatfx-'));
const runner = `
const path = require('path');
const raidMod = require('./handlers/레이드/index.js');
const B = require('./handlers/레이드/전투.js');
const mon = B.loadMonsters().find(m => m.id === 'alatreon');
const party = ['fire', 'water', 'thunder', 'ice'].map((role, i) => ({ userId: String(100 + i), name: '유저' + (i + 1), role }));
(async () => {
  for (const [key, el] of [['flame', 'fire'], ['torrent', 'water'], ['bolt', 'thunder'], ['frost', 'ice'], ['dragonbreath', 'dragon']]) {
    const rr = { client: null, monster: mon, guildId: '1', channelId: '2', phase: 'battle', party, recruitEndsAt: 0, battleEndsAt: Date.now() + 9e5, turnEndsAt: Date.now() + 25e3, freezesXp: true, hasImage: false };
    rr.battle = B.createBattle(mon, party, Math.random, { minParty: 1 });
    rr.battle.alat.element = el; rr.battle.intent = key;
    for (const m of rr.battle.members) B.choose(rr.battle, m.userId, m.role === 'fire' ? 'guard' : 'attack');
    B.resolveTurn(rr.battle, () => Number(process.env.ALAT_RNG || 0.5)); rr.battle.alat.element = el; rr.showingResult = true; // 다음 턴 속성으로 바뀐 걸 되돌려 그 기술 속성 색으로 본다
    const v = await raidMod.battleView(rr);
    require('fs').writeFileSync(path.join(${JSON.stringify(out)}, key + '.png'), v.files[0].attachment);
    console.log('saved', key);
  }
  // 필살기 준비 화면(선택 화면)과 에스카톤 결과, 발톱 공격 결과
  for (const [key, intent, showing] of [['smash_charge', 'smash', false], ['smash_hit', 'smash', true], ['claw', 'attack', true]]) {
    const rr = { client: null, monster: mon, guildId: '1', channelId: '2', phase: 'battle', party, recruitEndsAt: 0, battleEndsAt: Date.now() + 9e5, turnEndsAt: Date.now() + 25e3, freezesXp: true, hasImage: false };
    rr.battle = B.createBattle(mon, party, Math.random, { minParty: 1 });
    rr.battle.intent = intent;
    if (showing) { for (const m of rr.battle.members) B.choose(rr.battle, m.userId, 'guard'); rr.battle.alat.gauge = 100; B.resolveTurn(rr.battle, () => 0.5); rr.showingResult = true; }
    const v = await raidMod.battleView(rr);
    require('fs').writeFileSync(path.join(${JSON.stringify(out)}, key + '.png'), v.files[0].attachment);
    console.log('saved', key);
  }
})().catch(e => { console.error(e); process.exit(1); });
`;
try {
  for (const dir of ['handlers', 'commands', 'assets', 'Monster']) fs.cpSync(path.join(repo, dir), path.join(tmp, dir), { recursive: true });
  fs.copyFileSync(path.join(repo, 'config.js'), path.join(tmp, 'config.js'));
  fs.writeFileSync(path.join(tmp, 'run.js'), runner);
  const r = spawnSync(process.execPath, [path.join(tmp, 'run.js')], { encoding: 'utf8', env: { ...process.env, ALAT_MODE: process.env.ALAT_MODE || '', ALAT_RNG: process.env.ALAT_RNG || '', NODE_PATH: path.join(repo, 'node_modules') } });
  console.log((r.stdout || '') + (r.stderr || ''));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

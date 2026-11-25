// 알바트리온 흐름 테스트 실행기: node tests/raid/알바트리온실행.js
// 실행.js 와 같은 방식(임시 폴더에 복사해 DB를 건드리지 않음)이지만 Monster 폴더를 통째로 복사한다(위장 몬스터로 다른 몬스터가 필요해서).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = path.join(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alatreon-'));
try {
  for (const dir of ['handlers', 'commands', 'assets', 'Monster']) fs.cpSync(path.join(repo, dir), path.join(tmp, dir), { recursive: true });
  fs.copyFileSync(path.join(repo, 'config.js'), path.join(tmp, 'config.js'));
  fs.copyFileSync(path.join(__dirname, '알바트리온흐름테스트.js'), path.join(tmp, 'run.js'));
  const result = spawnSync(process.execPath, [path.join(tmp, 'run.js')], { encoding: 'utf8', env: { ...process.env, NODE_PATH: path.join(repo, 'node_modules') } });
  const out = (result.stdout || '') + (result.stderr || '');
  const lines = out.split('\n');
  for (const line of lines) if (!line.startsWith('✅') && !line.startsWith('🎨')) console.log(line);
  const ok = lines.filter(l => l.startsWith('✅')).length;
  const fail = lines.filter(l => l.startsWith('❌')).length;
  console.log(`\n통과 ${ok} · 실패 ${fail}`);
  process.exitCode = fail || result.status ? 1 : 0;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

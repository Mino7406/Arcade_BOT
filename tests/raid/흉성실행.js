// 흉성(위장·습격) 흐름 테스트 실행기: node tests/raid/흉성실행.js
// 실행.js 와 같은 방식(임시 폴더에 복사해 DB를 건드리지 않음)이지만 Monster 폴더를 통째로 복사한다(위장 몬스터로 다른 몬스터가 필요해서).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = path.join(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'heungseong-'));
try {
  for (const dir of ['handlers', 'commands', 'assets', 'Monster']) fs.cpSync(path.join(repo, dir), path.join(tmp, dir), { recursive: true });
  // 흉성은 테스트 서버에서만 소환되게(testOnly) 막아 둘 수 있어도, 이 테스트는 본서버 설정(gMain)으로 돌리므로 임시 폴더의 파일에서만 푼다.
  const jf = path.join(tmp, 'Monster', '흉성.json');
  const d = JSON.parse(fs.readFileSync(jf, 'utf8')); delete d.enabled; delete d.testOnly; fs.writeFileSync(jf, JSON.stringify(d));
  fs.copyFileSync(path.join(repo, 'config.js'), path.join(tmp, 'config.js'));
  fs.copyFileSync(path.join(__dirname, '흉성테스트.js'), path.join(tmp, 'run.js'));
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

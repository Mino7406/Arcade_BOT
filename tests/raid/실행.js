// 레이드 흐름 테스트 실행기: node tests/raid/실행.js
// 테스트가 DB/ 아래 파일(레벨·raid.json)을 쓰기 때문에, 진짜 DB를 건드리지 않도록 임시 폴더에
// handlers·commands·assets·Monster(슬라임만, 전체는 Monster-all)·config.js를 복사해 그 안에서 흐름테스트.js를 돌리고 끝나면 지운다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = path.join(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'raidtest-'));
try {
  for (const dir of ['handlers', 'commands', 'assets']) fs.cpSync(path.join(repo, dir), path.join(tmp, dir), { recursive: true });
  // 흐름 테스트는 문구(슬라임)를 확인하므로 Monster에는 슬라임만 두고, 전체 몬스터는 Monster-all에 따로 둔다(몬스터별 테스트용).
  fs.cpSync(path.join(repo, 'Monster'), path.join(tmp, 'Monster-all'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'Monster'));
  fs.copyFileSync(path.join(repo, 'Monster', '슬라임.json'), path.join(tmp, 'Monster', '슬라임.json'));
  fs.copyFileSync(path.join(repo, 'config.js'), path.join(tmp, 'config.js'));
  fs.copyFileSync(path.join(__dirname, '흐름테스트.js'), path.join(tmp, 'run.js'));
  const result = spawnSync(process.execPath, [path.join(tmp, 'run.js')], {
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: path.join(repo, 'node_modules') },
  });
  const out = (result.stdout || '') + (result.stderr || '');
  const lines = out.split('\n');
  // 통과 줄은 개수만, 실패·오류는 그대로 보여준다
  for (const line of lines) if (!line.startsWith('✅') && !line.startsWith('🎨')) console.log(line);
  const ok = lines.filter(l => l.startsWith('✅')).length;
  const fail = lines.filter(l => l.startsWith('❌')).length;
  console.log(`\n통과 ${ok} · 실패 ${fail}`);
  process.exitCode = fail || result.status ? 1 : 0;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

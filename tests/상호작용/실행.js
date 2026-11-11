// 상호작용 흐름 테스트 실행기: node tests/상호작용/실행.js
// 레벨·내전 저장 파일(DB/)을 건드리지 않도록 임시 폴더에 handlers·commands·forms·assets·config.js 를 복사해
// 그 안에서 흐름.js 를 돌리고 끝나면 지운다(레이드 테스트와 같은 방식).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = path.join(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowtest-'));
try {
  for (const dir of ['handlers', 'commands', 'forms', 'assets']) fs.cpSync(path.join(repo, dir), path.join(tmp, dir), { recursive: true });
  fs.cpSync(path.join(repo, 'Monster'), path.join(tmp, 'Monster'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'config.js'), path.join(tmp, 'config.js'));
  fs.copyFileSync(path.join(__dirname, '흐름.js'), path.join(tmp, 'run.js'));
  const result = spawnSync(process.execPath, [path.join(tmp, 'run.js')], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, NODE_PATH: path.join(repo, 'node_modules') },
  });
  process.stdout.write((result.stdout || '') + (result.stderr || ''));
  process.exitCode = result.status ? 1 : 0;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

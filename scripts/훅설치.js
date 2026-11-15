// 이 저장소의 git 훅 폴더를 .githooks 로 지정한다(컴퓨터마다 한 번 필요한 설정).
// npm install(package.json 의 prepare)과 테스트 실행(tests/상호작용/실행.js) 때 자동으로 부른다 — 이미 설정돼 있으면 아무것도 안 한다.
// .git 이 없는 곳(호스팅)이나 git 이 없는 곳에서는 조용히 넘어간다.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function installHooks() {
  if (!fs.existsSync(path.join(root, '.git'))) return false;
  const opts = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true };
  try {
    if (execFileSync('git', ['config', 'core.hooksPath'], opts).trim() === '.githooks') return true;
  } catch { /* 설정 없음 */ }
  try {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], opts);
    return true;
  } catch {
    return false;
  }
}

module.exports = { installHooks };
if (require.main === module) installHooks();

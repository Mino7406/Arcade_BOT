// post-commit 훅이 부른다: 방금 한 커밋의 제목·시각을 루트의 version.json 에 쓴다.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const info = {
  subject: git(['log', '-1', '--format=%s']),
  date: git(['log', '-1', '--format=%cd', '--date=format:%m/%d %H:%M']),
  committedAt: git(['log', '-1', '--format=%cI']),
};
fs.writeFileSync(path.join(root, 'version.json'), JSON.stringify(info, null, 2) + '\n');

// 버전.js — 지금 실행 중인 코드가 어느 커밋인지 알아낸다(봇 시작 때 콘솔에 한 줄로 보여 주려고).
// 호스팅에서 최신 푸시를 제대로 불러왔는지 확인하는 용도.
// 1) git 명령이 있으면 짧은 해시·제목·커밋 시각까지, 2) 없으면 .git 폴더 파일을 직접 읽어 해시만, 3) 둘 다 안 되면 null.
//
// 이 모듈은 다른 핸들러를 require 하지 않는다(fs·child_process만 사용).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

function fromGitCommand() {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%h%x1f%s%x1f%cd', '--date=format:%m/%d %H:%M'], {
      cwd: ROOT, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
    if (!out) return null;
    const [hash, subject, date] = out.split('\x1f');
    return { hash, subject, date };
  } catch {
    return null;
  }
}

// git 명령이 없는 호스팅용: .git/HEAD → 브랜치 ref 파일(또는 packed-refs)에서 해시를 읽는다.
function fromGitFiles() {
  try {
    const gitDir = path.join(ROOT, '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    let full = head;
    const ref = /^ref: (.+)$/.exec(head)?.[1];
    if (ref) {
      const refFile = path.join(gitDir, ref);
      if (fs.existsSync(refFile)) full = fs.readFileSync(refFile, 'utf8').trim();
      else {
        const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
        full = packed.split('\n').find(l => l.endsWith(` ${ref}`))?.split(' ')[0] ?? '';
      }
    }
    return /^[0-9a-f]{7,}$/.test(full) ? { hash: full.slice(0, 7), subject: null, date: null } : null;
  } catch {
    return null;
  }
}

function getCommitInfo() {
  return fromGitCommand() ?? fromGitFiles();
}

// 콘솔에 찍을 한 줄. 예: "📦 실행 중인 커밋: 1961ab2 — 해킹 툴 사용 이모지 테두리를… (11/15 18:40)"
function commitLine() {
  const c = getCommitInfo();
  if (!c) return '📦 실행 중인 커밋: 알 수 없음(.git 정보를 찾지 못함)';
  const subject = c.subject ? ` — ${c.subject.length > 60 ? `${c.subject.slice(0, 60)}…` : c.subject}` : '';
  return `📦 실행 중인 커밋: ${c.hash}${subject}${c.date ? ` (${c.date})` : ''}`;
}

module.exports = { getCommitInfo, commitLine };

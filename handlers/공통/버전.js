// 버전.js — 지금 실행 중인 코드가 어느 커밋인지 알아낸다(봇 시작 때 콘솔에 한 줄로 보여 주려고).
// 호스팅에서 최신 푸시를 제대로 불러왔는지 확인하는 용도.
// 1) git 명령이 있으면 그걸로, 2) 없으면(호스팅) .git 폴더의 커밋 데이터를 직접 읽어서 — 둘 다 짧은 해시·제목·커밋 시각.
// 3) .git 이 없으면(파일만 받는 호스팅) 커밋 때 훅이 같이 올려 둔 version.json(.githooks/post-commit)에서 제목·시각. 4) 그것도 없으면 null.
//
// 이 모듈은 다른 핸들러를 require 하지 않는다(fs·zlib·child_process만 사용).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
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

// ── git 명령이 없는 호스팅용: .git 폴더를 직접 읽는다 ─────────────────────────
const GIT_DIR = path.join(ROOT, '.git');

// HEAD → 브랜치 ref 파일(또는 packed-refs)에서 40자 해시
function headHash() {
  const head = fs.readFileSync(path.join(GIT_DIR, 'HEAD'), 'utf8').trim();
  const ref = /^ref: (.+)$/.exec(head)?.[1];
  if (!ref) return head;
  const refFile = path.join(GIT_DIR, ref);
  if (fs.existsSync(refFile)) return fs.readFileSync(refFile, 'utf8').trim();
  const packed = fs.readFileSync(path.join(GIT_DIR, 'packed-refs'), 'utf8');
  return packed.split('\n').find(l => l.endsWith(` ${ref}`))?.split(' ')[0] ?? '';
}

// 델타(차이) 적용: base 에 delta 명령을 적용해 원래 객체를 만든다
function applyDelta(base, delta) {
  let i = 0;
  const varint = () => { let v = 0, sh = 0, b; do { b = delta[i++]; v |= (b & 0x7f) << sh; sh += 7; } while (b & 0x80); return v; };
  varint(); const size = varint();
  const out = Buffer.alloc(size); let o = 0;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let off = 0, len = 0;
      for (let k = 0; k < 4; k++) if (op & (1 << k)) off |= delta[i++] << (8 * k);
      for (let k = 0; k < 3; k++) if (op & (0x10 << k)) len |= delta[i++] << (8 * k);
      if (len === 0) len = 0x10000;
      base.copy(out, o, off, off + len); o += len;
    } else { delta.copy(out, o, i, i + op); i += op; o += op; }
  }
  return out;
}

// 팩 파일 안 offset 위치의 객체 내용(델타면 풀어서)
function readPackObject(pack, offset, packs) {
  let i = offset, c = pack[i++];
  const type = (c >> 4) & 7;
  while (c & 0x80) c = pack[i++]; // 크기(varint)는 inflate 가 알아서 처리하므로 건너뛴다
  if (type === 6) { // OFS_DELTA: 앞쪽 객체 기준
    c = pack[i++]; let back = c & 0x7f;
    while (c & 0x80) { c = pack[i++]; back = ((back + 1) << 7) | (c & 0x7f); }
    return applyDelta(readPackObject(pack, offset - back, packs), zlib.inflateSync(pack.subarray(i)));
  }
  if (type === 7) { // REF_DELTA: 해시로 찾은 객체 기준
    const baseHash = pack.subarray(i, i + 20).toString('hex');
    return applyDelta(readObject(baseHash, packs), zlib.inflateSync(pack.subarray(i + 20)));
  }
  return zlib.inflateSync(pack.subarray(i));
}

// 팩 인덱스(v2)에서 해시의 offset 을 찾는다
function findInIdx(idx, hash) {
  if (idx.readUInt32BE(0) !== 0xff744f63) return -1;
  const target = Buffer.from(hash, 'hex');
  const first = target[0];
  const lo0 = first ? idx.readUInt32BE(8 + (first - 1) * 4) : 0, hi0 = idx.readUInt32BE(8 + first * 4);
  const n = idx.readUInt32BE(8 + 255 * 4);
  let lo = lo0, hi = hi0 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, cmp = idx.compare(target, 0, 20, 8 + 1024 + mid * 20, 8 + 1024 + mid * 20 + 20);
    if (cmp === 0) {
      const ofsBase = 8 + 1024 + n * 20 + n * 4;
      let off = idx.readUInt32BE(ofsBase + mid * 4);
      if (off & 0x80000000) { const big = ofsBase + n * 4 + (off & 0x7fffffff) * 8; off = Number(idx.readBigUInt64BE(big)); }
      return off;
    }
    if (cmp < 0) lo = mid + 1; else hi = mid - 1; // cmp = (인덱스의 해시) - (찾는 해시)
  }
  return -1;
}

// 객체 하나 읽기: 낱개 파일(objects/xx/…) 먼저, 없으면 팩에서
function readObject(hash, packs) {
  const loose = path.join(GIT_DIR, 'objects', hash.slice(0, 2), hash.slice(2));
  if (fs.existsSync(loose)) {
    const raw = zlib.inflateSync(fs.readFileSync(loose));
    return raw.subarray(raw.indexOf(0) + 1);
  }
  for (const pk of packs) {
    const off = findInIdx(pk.idx(), hash);
    if (off >= 0) return readPackObject(pk.pack(), off, packs);
  }
  throw new Error(`객체를 찾지 못함: ${hash}`);
}

function listPacks() {
  const dir = path.join(GIT_DIR, 'objects', 'pack');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.idx')).map(f => {
    let idx, pack;
    return {
      idx: () => idx ??= fs.readFileSync(path.join(dir, f)),
      pack: () => pack ??= fs.readFileSync(path.join(dir, f.replace(/\.idx$/, '.pack'))),
    };
  });
}

// 커밋 시각을 커밋한 사람의 시간대 기준 "MM/DD HH:mm" 으로
function formatCommitTime(sec, tz) {
  const m = /^([+-])(\d\d)(\d\d)$/.exec(tz || '+0000');
  const offMin = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  const d = new Date((Number(sec) + offMin * 60) * 1000);
  const p2 = (v) => String(v).padStart(2, '0');
  return `${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

function fromGitFiles() {
  try {
    const full = headHash();
    if (!/^[0-9a-f]{40}$/.test(full)) return null;
    const info = { hash: full.slice(0, 7), subject: null, date: null };
    try {
      const text = readObject(full, listPacks()).toString('utf8');
      const sep = text.indexOf('\n\n');
      info.subject = text.slice(sep + 2).split('\n')[0].trim() || null;
      const committer = /^committer .* (\d+) ([+-]\d{4})$/m.exec(text.slice(0, sep));
      if (committer) info.date = formatCommitTime(committer[1], committer[2]);
    } catch { /* 해시만이라도 보여 준다 */ }
    return info;
  } catch {
    return null;
  }
}

// 호스팅용: 커밋할 때 .githooks/post-commit 이 같이 넣어 둔 version.json(해시는 없음 — 넣는 순간 해시가 바뀌므로)
function fromVersionFile() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));
    return v?.subject ? { hash: null, subject: v.subject, date: v.date ?? null } : null;
  } catch {
    return null;
  }
}

function getCommitInfo() {
  return fromGitCommand() ?? fromGitFiles() ?? fromVersionFile();
}

// 콘솔에 찍을 한 줄. 예: "📦 실행 중인 커밋: 1961ab2 — 해킹 툴 사용 이모지 테두리를… (11/15 18:40)"
function commitLine() {
  const c = getCommitInfo();
  if (!c) return '📦 실행 중인 커밋: 알 수 없음(.git·version.json 을 찾지 못함)';
  const subject = c.subject ? ` — ${c.subject.length > 60 ? `${c.subject.slice(0, 60)}…` : c.subject}` : '';
  return `📦 실행 중인 커밋: ${c.hash ?? ''}${c.hash ? subject : subject.replace(/^ — /, '')}${c.date ? ` (${c.date})` : ''}`;
}

module.exports = { getCommitInfo, commitLine };

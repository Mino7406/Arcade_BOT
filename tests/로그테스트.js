// 날짜별 로그 저장 테스트: node tests/로그테스트.js
// 로그 모듈은 DB/를 handlers 옆 폴더로 잡으므로, 임시 폴더에 handlers·config.js를 복사해 그 안에서 돌린다.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const repo = path.join(__dirname, '..');
process.env.NODE_PATH = path.join(repo, 'node_modules');
require('module').Module._initPaths(); // 임시 폴더에서도 discord.js 등을 찾게
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'logtest-'));
fs.cpSync(path.join(repo, 'handlers'), path.join(tmp, 'handlers'), { recursive: true });
fs.cpSync(path.join(repo, 'config.js'), path.join(tmp, 'config.js'));
fs.mkdirSync(path.join(tmp, 'DB'));
const KST = 9 * 3600e3;
const at = (s) => Date.parse(s.replace(' ', 'T') + 'Z') - KST; // KST 문자열 → epoch
// 예전 단일 파일: 20일치(11/01~11/20) 하루 3개 + 11/20은 9000개, 최신이 위
const legacy = [];
for (let d = 1; d <= 20; d++) {
  const n = d === 20 ? 9000 : 3;
  for (let i = 0; i < n; i++) {
    const sec = i % 60, min = Math.floor(i / 60) % 60, hr = Math.floor(i / 3600);
    legacy.push({ 시각: `2026-11-${String(d).padStart(2, '0')} ${String(hr).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`, 유형: 't', 유저: '-', 채널: '-', 내용: `d${d}-${i}` });
  }
}
legacy.reverse();
fs.writeFileSync(path.join(tmp, 'DB', 'log.json'), JSON.stringify(legacy, null, 2));

let now = at('2026-11-20 23:59:58');
Date.now = () => now;
const L = require(path.join(tmp, 'handlers', '로그.js'));
const dir = path.join(tmp, 'DB', 'log');
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

L.logSystem({ 유형: 't', 내용: 'new-1120' });
assert.ok(!fs.existsSync(path.join(tmp, 'DB', 'log.json')), '옛 파일 삭제');
let files = fs.readdirSync(dir).sort();
assert.ok(!files.includes('2026-11-06.json'), '14일보다 오래된 날 정리: ' + files);
assert.ok(files.includes('2026-11-07.json'), '14일째는 남음');
assert.deepStrictEqual(read('2026-11-07.json').map(e => e.내용), ['d7-2', 'd7-1', 'd7-0']);
assert.strictEqual(read('2026-11-20.json').length, 8000);
assert.strictEqual(read('2026-11-20.json')[0].내용, 'd20-7999'); // 1번 파일은 오래된 8000개, 최신이 위
assert.strictEqual(read('2026-11-20.json')[7999].내용, 'd20-0');

now = at('2026-11-21 00:00:01'); // 날짜 바뀜
L.logSystem({ 유형: 't', 내용: 'new-1121' });
L.flushLogsSync();
files = fs.readdirSync(dir).sort();
const p2 = read('2026-11-20_2.json');
assert.strictEqual(p2[0].내용, 'new-1120'); // 이전 날짜 파일도 저장됨
assert.strictEqual(p2.length, 1001);
assert.deepStrictEqual(read('2026-11-21.json').map(e => e.내용), ['new-1121']);
assert.ok(!files.includes('2026-11-07.json'), '날짜가 바뀌면 14일 지난 파일 정리: ' + files);
assert.ok(files.includes('2026-11-08.json'));
assert.ok(!files.some(f => f.includes('tmp')), '임시 파일 없음: ' + files);
for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size < 2 * 1024 * 1024, f + ' 2MB 미만');
console.log('파일:', files.join(', '));
console.log('11-20 크기:', fs.statSync(path.join(dir, '2026-11-20.json')).size, 'B');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('통과');

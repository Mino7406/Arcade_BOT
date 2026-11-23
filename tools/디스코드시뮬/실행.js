// 디스코드 시뮬레이터 실행기: node tools/디스코드시뮬/실행.js [포트]
// 저장 파일(DB/)·로그를 건드리지 않도록 임시 폴더에 봇 코드(index.js·handlers·commands·forms·assets·config.js …)를
// 복사해 그 안에서 서버.js 를 돌린다(tests/상호작용 과 같은 방식). 끝낼 때(Ctrl+C) 임시 폴더는 지워진다.
//
// 고친 것을 바로 확인하는 법
//  - 화면(화면.html)·서버 화면 코드: 저장만 하면 열려 있는 브라우저가 자동 새로고침된다(원본 파일을 직접 읽음).
//  - 봇 코드(handlers/ 등): 화면 왼쪽 아래 "🔄 봇 코드 다시 불러오기" 버튼 → 새로 복사해서 재시작(환경 설정은 상황 저장으로 보존).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const repo = path.join(__dirname, '..', '..');
const port = process.argv[2] || process.env.SIM_PORT || '5173';
const RESTART_CODE = 75;
let tmp = null, child = null, stopping = false;

function copyAll() {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'discordsim-'));
  for (const dir of ['handlers', 'commands', 'forms', 'assets', 'Monster', 'scripts']) {
    const src = path.join(repo, dir);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(tmp, dir), { recursive: true });
  }
  for (const f of ['index.js', 'migrate.js', 'config.js', 'version.json', 'package.json']) {
    if (fs.existsSync(path.join(repo, f))) fs.copyFileSync(path.join(repo, f), path.join(tmp, f));
  }
  fs.copyFileSync(path.join(__dirname, '서버.js'), path.join(tmp, '서버.js')); // 화면.html 은 복사하지 않고 원본을 직접 읽는다
}

function start() {
  copyAll();
  child = spawn(process.execPath, [path.join(tmp, '서버.js')], {
    stdio: 'inherit', cwd: tmp,
    env: {
      ...process.env, SIM_PORT: port, NODE_PATH: path.join(repo, 'node_modules'), TOKEN: 'simulator',
      SIM_UI: path.join(__dirname, '화면.html'),            // 원본 화면 파일(고치면 바로 반영)
      SIM_PRESETS: path.join(__dirname, '상황저장.json'),   // "상황 저장"은 임시 폴더가 아니라 여기에 남는다
    },
  });
  child.on('exit', (code) => {
    if (stopping) return;
    if (code === RESTART_CODE) { console.log('\n🔄 봇 코드를 다시 불러와 재시작합니다…'); start(); return; }
    cleanup(); process.exit(code ?? 0);
  });
}
function cleanup() { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
function stop() { stopping = true; try { child?.kill(); } catch {} cleanup(); process.exit(0); }
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, stop);
start();

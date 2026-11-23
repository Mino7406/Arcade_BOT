// 디스코드 시뮬레이터 실행기: node tools/디스코드시뮬/실행.js [포트]
// 저장 파일(DB/)·로그를 건드리지 않도록 임시 폴더에 봇 코드(index.js·handlers·commands·forms·assets·config.js …)를
// 복사해 그 안에서 서버.js 를 돌린다(tests/상호작용 과 같은 방식). 끝낼 때(Ctrl+C) 임시 폴더는 지워진다.
//
// 고친 것을 바로 확인하는 법
//  - 화면(화면.html)·서버 화면 코드: 저장만 하면 열려 있는 브라우저가 자동 새로고침된다(원본 파일을 직접 읽음).
//  - 봇 코드(index.js·handlers/·commands/·forms/·config.js·assets/): 저장하면 자동으로 새로 복사해 재시작한다(환경 설정은 유지).
//    커밋·푸시 전의 작업 폴더를 그대로 복사하므로, 고친 직후 바로 확인할 수 있다. 자동 재시작이 싫으면 --수동 (화면의 🔄 버튼으로만).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const repo = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const manual = args.includes('--수동');
const noOpen = args.includes('--열지않음') || !!process.env.SIM_NO_OPEN;
const port = args.find(a => /^[0-9]+$/.test(a)) || process.env.SIM_PORT || '5173';
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
// 봇 코드 저장 감시 → 서버에 재시작 요청(서버가 환경 설정을 보존한 채 75로 종료 → 위에서 새로 복사해 다시 띄움)
if (!manual) {
  let timer = null;
  const WATCH = ['handlers', 'commands', 'forms', 'assets', 'Monster', 'index.js', 'config.js'];
  const onChange = (_ev, name) => {
    if (name && /(^|[\/])(\.git|node_modules)([\/]|$)|\.(tmp|swp)$|~$/.test(String(name))) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      console.log(`
✏️  봇 코드 변경 감지${name ? ` (${name})` : ''} — 다시 불러옵니다`);
      fetch(`http://127.0.0.1:${port}/api/restart`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
    }, 700);
  };
  for (const w of WATCH) {
    const p = path.join(repo, w);
    if (!fs.existsSync(p)) continue;
    try { fs.watch(p, { recursive: fs.statSync(p).isDirectory() }, onChange); } catch (e) { console.warn(`변경 감시 실패(${w}):`, e.message); }
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, stop);
start();

// 서버가 뜨면 브라우저를 자동으로 연다(처음 한 번만)
if (!noOpen) {
  const url = `http://localhost:${port}`;
  (async () => {
    for (let i = 0; i < 80; i++) {
      await new Promise(r => setTimeout(r, 500));
      try { await fetch(`${url}/api/presets`); break; } catch { if (i === 79) return; }
    }
    const [cmd, cmdArgs] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try { spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).unref(); } catch {}
  })();
}

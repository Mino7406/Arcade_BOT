// migrate-db.js — 예전 위치(프로젝트 루트)에 흩어져 있던 JSON 저장 파일들을 새 위치(DB/ 폴더,
// 일부는 새 이름)로 옮긴다. 내용은 전혀 읽거나 다시 쓰지 않고 fs.renameSync(파일시스템 레벨
// 이동)만 하므로 손상될 일이 없다. 이미 옮겨진 파일은 건너뛰므로 여러 번 실행해도 안전하다
// (idempotent) — 그래서 index.js가 봇을 켤 때마다 자동으로 호출한다. 콘솔에 명령어를 직접
// 입력할 수 없는 호스팅(버튼으로만 시작/재시작하는 디스호스트류)에서도 별도 조작 없이
// 알아서 옮겨지고, 옮길 파일이 없으면 그냥 조용히 넘어간다.
//
// 셸에 접근할 수 있다면 `node migrate-db.js`로 직접 실행해 결과를 바로 확인할 수도 있다.
//
//   data.json           → DB/N-M.json        (내전 N / 모집 M 매치)
//   data.json.tmp       → DB/N-M.json.tmp
//   levels.json         → DB/levels.json
//   roulette.json       → DB/roulette.json
//   command-log.json    → DB/log.json         (버튼·선택메뉴·모달까지 남기도록 개편됨)
//   voiceRooms.json     → DB/voiceRooms.json
//   quiz.json           → DB/quiz.json
//   botmatch-xp.json    → DB/botmatch-xp.json

const fs = require('fs');
const path = require('path');

const MOVES = [
  ['data.json', 'N-M.json'],
  ['data.json.tmp', 'N-M.json.tmp'],
  ['levels.json', 'levels.json'],
  ['roulette.json', 'roulette.json'],
  ['command-log.json', 'log.json'],
  ['voiceRooms.json', 'voiceRooms.json'],
  ['quiz.json', 'quiz.json'],
  ['botmatch-xp.json', 'botmatch-xp.json'],
];

// 옮긴(또는 충돌로 건너뛴) 결과를 배열로 돌려준다. 호출부(index.js)가 조용히 쓸 수도,
// 이 파일을 직접 실행했을 때처럼 콘솔에 찍을 수도 있게 로그 출력과 로직을 분리했다.
function migrateOldDbFiles(baseDir = __dirname) {
  const dbDir = path.join(baseDir, 'DB');
  fs.mkdirSync(dbDir, { recursive: true });

  const results = [];
  for (const [oldName, newName] of MOVES) {
    const oldPath = path.join(baseDir, oldName);
    const newPath = path.join(dbDir, newName);

    if (!fs.existsSync(oldPath)) continue; // 이미 옮겨졌거나, 애초에 생긴 적 없는 파일

    if (fs.existsSync(newPath)) {
      results.push({ status: 'conflict', oldName, newName });
      continue;
    }

    fs.renameSync(oldPath, newPath);
    results.push({ status: 'moved', oldName, newName });
  }
  return results;
}

function logResults(results) {
  for (const r of results) {
    if (r.status === 'moved') {
      console.log(`✅ ${r.oldName} → DB/${r.newName}`);
    } else {
      console.log(`⚠️  건너뜀: DB/${r.newName}이(가) 이미 있어 ${r.oldName}을(를) 덮어쓰지 않았습니다. 두 파일을 직접 비교해보세요.`);
    }
  }
  const moved = results.filter(r => r.status === 'moved').length;
  const skipped = results.length - moved;
  if (results.length === 0) {
    console.log('옮길 파일이 없습니다 — 이미 마이그레이션되었거나 새로 설치한 환경입니다.');
  } else {
    console.log(`\n총 ${moved}개 파일을 옮겼습니다.${skipped > 0 ? ` (${skipped}개는 충돌로 건너뜀 — 위 안내 확인)` : ''}`);
  }
}

// `node migrate-db.js`로 직접 실행했을 때만 콘솔에 찍는다 — index.js가 require해서 자동
// 호출할 때는 조용히(로그 없이) 처리한다.
if (require.main === module) {
  logResults(migrateOldDbFiles());
}

module.exports = { migrateOldDbFiles };

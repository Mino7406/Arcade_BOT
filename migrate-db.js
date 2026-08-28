// migrate-db.js — 일회성 마이그레이션 스크립트.
// 예전 위치(프로젝트 루트)에 흩어져 있던 JSON 저장 파일들을 새 위치(DB/ 폴더, 일부는 새 이름)로
// 옮긴다. 내용은 전혀 읽거나 다시 쓰지 않고 fs.renameSync(파일시스템 레벨 이동)만 하므로
// 손상될 일이 없다. 이미 옮겨진 파일은 건너뛰므로 여러 번 실행해도 안전하다(idempotent).
//
// 사용법: 실제로 봇을 돌리던 서버에서, 이 커밋으로 코드를 갱신한 뒤 봇을 다시 켜기 전에
// 프로젝트 루트에서 한 번만 실행한다.
//
//   node migrate-db.js
//
// 새로 설치하는 경우(옮길 파일이 원래 없는 경우)에는 실행하지 않아도 무방하다 — 봇이 처음
// 켜질 때 DB/ 폴더와 파일들을 알아서 새로 만든다.
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

const DB_DIR = path.join(__dirname, 'DB');
fs.mkdirSync(DB_DIR, { recursive: true });

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

let moved = 0;
let skipped = 0;

for (const [oldName, newName] of MOVES) {
  const oldPath = path.join(__dirname, oldName);
  const newPath = path.join(DB_DIR, newName);

  if (!fs.existsSync(oldPath)) continue; // 이미 옮겨졌거나, 애초에 생긴 적 없는 파일

  if (fs.existsSync(newPath)) {
    console.log(`⚠️  건너뜀: DB/${newName}이(가) 이미 있어 ${oldName}을(를) 덮어쓰지 않았습니다. 두 파일을 직접 비교해보세요.`);
    skipped++;
    continue;
  }

  fs.renameSync(oldPath, newPath);
  console.log(`✅ ${oldName} → DB/${newName}`);
  moved++;
}

if (moved === 0 && skipped === 0) {
  console.log('옮길 파일이 없습니다 — 이미 마이그레이션되었거나 새로 설치한 환경입니다.');
} else {
  console.log(`\n총 ${moved}개 파일을 옮겼습니다.${skipped > 0 ? ` (${skipped}개는 충돌로 건너뜀 — 위 안내 확인)` : ''}`);
}

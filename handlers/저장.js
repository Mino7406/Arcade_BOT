// 저장.js — JSON 저장 파일을 안전하고 낭비 없이 쓰기 위한 공통 헬퍼.
//
// 예전엔 각 모듈이 fs.writeFileSync(경로, JSON.stringify(값))을 직접 호출했는데 두 가지 문제가
// 있었다.
//
// 1) index.js의 30초 자동 저장이 변경 여부와 무관하게 매번 4개 파일을 다시 썼다. 아무도
//    접속하지 않은 새벽에도 계속 쓴다 — 하루 약 11,500회의 의미 없는 디스크 쓰기.
// 2) 대상 파일에 곧바로 써서, 쓰는 도중 프로세스가 죽으면 파일이 반쪽으로 깨졌다. 그러면
//    다음 실행에서 load가 실패해 데이터가 통째로 초기화된다(그 실패는 이제 로그로 남는다).
//
// 그래서 (1) 직전에 쓴 내용과 같으면 건너뛰고, (2) 쓸 때는 임시 파일에 다 쓴 뒤 rename으로
// 교체한다. rename은 같은 볼륨 안에서 원자적이라 중간에 죽어도 기존 파일이 그대로 남는다.
//
// 이 모듈은 다른 핸들러를 require 하지 않는다(fs만 사용) — 순환참조 방지.

const fs = require('fs');

// 경로 → 마지막으로 디스크에 성공적으로 쓴 문자열. 봇이 뜬 뒤 첫 저장은 항상 실제로 쓴다
// (파일이 이미 같은 내용이어도 한 번은 쓰게 되지만, 시작 시 1회뿐이라 무시할 수준).
const lastWritten = new Map();

// 값을 JSON으로 저장한다. 내용이 직전 저장과 같으면 아무것도 하지 않고 false를 반환한다.
// 실제로 파일을 썼으면 true. 실패는 예외로 그대로 던진다 — 호출부가 이미 try/catch로
// 감싸고 "무엇을 저장하다 실패했는지"를 자기 문구로 남기고 있기 때문.
function writeJsonIfChanged(filePath, value) {
  const text = JSON.stringify(value);
  // 내용이 같더라도 파일이 실제로 있는지는 확인한다. lastWritten은 메모리에만 있어서,
  // 누가 파일을 지우거나 갈아엎으면 "이미 저장했다"고 착각해 영영 다시 쓰지 않게 된다.
  // 예전의 무조건 30초 저장은 그런 상황을 자동 복구해줬으므로 그 성질만 남긴다.
  // (existsSync는 수 마이크로초라 30초에 6번 도는 비용으로는 무시할 수준)
  if (lastWritten.get(filePath) === text && fs.existsSync(filePath)) return false;

  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, text, 'utf8');
  fs.renameSync(tmpPath, filePath);
  lastWritten.set(filePath, text);
  return true;
}

module.exports = { writeJsonIfChanged };

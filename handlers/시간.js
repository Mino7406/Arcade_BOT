// 시간.js — KST(한국 표준시) 관련 공용 유틸.
// 여러 모듈(룰렛·봇전한도·퀴즈·공용·로그)에 흩어져 중복 정의돼 있던 KST 오프셋과
// 날짜/자정까지 남은 시간 계산을 한곳에 모은다. 순수 함수만 두고 다른 모듈을 require 하지 않는다.

// UTC 기준 +9시간(밀리초). new Date(epoch + KST_OFFSET_MS)의 getUTC* 값이 KST 벽시계 값이 된다.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// epoch ms → "YYYY-MM-DD"(KST 달력 날짜). 룰렛·봇전한도의 일일 기록 키로 쓰인다.
function kstDateString(epochMs = Date.now()) {
  const kst = new Date(epochMs + KST_OFFSET_MS);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`;
}

// 다음 KST 자정까지 남은 시간을 "N시간 M분" 형태로 반환(일일 한도 초기화 안내용).
function timeUntilKstMidnight(epochMs = Date.now()) {
  const kst = new Date(epochMs + KST_OFFSET_MS);
  const nextMidnightKst = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() + 1) - KST_OFFSET_MS;
  const remainingMs = nextMidnightKst - epochMs;
  const hours = Math.floor(remainingMs / (60 * 60 * 1000));
  const minutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000));
  return `${hours}시간 ${minutes}분`;
}

module.exports = { KST_OFFSET_MS, kstDateString, timeUntilKstMidnight };

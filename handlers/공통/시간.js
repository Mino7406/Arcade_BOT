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

// epoch ms → "YYYY-MM-DD HH:MM"(KST). 관리자 입력창에 현재 값을 미리 채워 둘 때 쓴다.
function kstDateTimeString(epochMs = Date.now()) {
  const kst = new Date(epochMs + KST_OFFSET_MS);
  return `${kstDateString(epochMs)} ${String(kst.getUTCHours()).padStart(2, '0')}:${String(kst.getUTCMinutes()).padStart(2, '0')}`;
}

// 관리자가 적은 KST 날짜·시각 → epoch ms. 알아볼 수 없거나 없는 날짜(2월 30일 등)면 null.
// 받는 꼴: "2026-11-07 15:30" / "11-07 15:30"(올해) / "15:30"(오늘, 이미 지났으면 내일).
// 날짜 구분은 - . / 아무거나, 시각은 "15:30" 또는 "15시 30분"·"15시".
function parseKstDateTime(text, now = Date.now()) {
  const m = String(text).trim()
    .match(/^(?:(?:(\d{4})\s*[-./]\s*)?(\d{1,2})\s*[-./]\s*(\d{1,2})\.?\s+)?(\d{1,2})\s*(?::|시)\s*(?:(\d{1,2})\s*분?)?$/);
  if (!m) return null;
  const today = new Date(now + KST_OFFSET_MS);
  const hasDate = m[2] !== undefined;
  const y = m[1] !== undefined ? Number(m[1]) : today.getUTCFullYear();
  const mo = hasDate ? Number(m[2]) - 1 : today.getUTCMonth();
  const d = hasDate ? Number(m[3]) : today.getUTCDate();
  const h = Number(m[4]);
  const mi = m[5] !== undefined ? Number(m[5]) : 0;
  if (h > 23 || mi > 59) return null;
  const check = new Date(Date.UTC(y, mo, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo || check.getUTCDate() !== d) return null;
  let ms = Date.UTC(y, mo, d, h, mi) - KST_OFFSET_MS;
  if (!hasDate && ms <= now) ms += 24 * 60 * 60 * 1000;
  return ms;
}

module.exports = { KST_OFFSET_MS, kstDateString, kstDateTimeString, timeUntilKstMidnight, parseKstDateTime };

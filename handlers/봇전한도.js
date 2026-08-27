// 봇전한도.js — 끝말잇기·틱택토 "봇전"에서 하루에 얻을 수 있는 보상 XP 총량을 제한한다.
// 게임별 쿨다운(xpSettleCooldowns)이 "연타 방지"라면, 이 모듈은 "하루 총량 방지"다.
// 봇을 상대로 계속 이겨도 하루에 받을 수 있는 보상 XP에 상한을 두고, 끝말잇기와 틱택토가
// 같은 예산을 공유하게 해서 게임을 바꿔가며 우회하는 것도 막는다.
// (KST 자정에 초기화 — 룰렛의 일일 플레이 기록과 같은 방식)

const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', 'botmatch-xp.json');
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 유저 한 명이 하루에 봇전(끝말잇기 + 틱택토 합산)으로 받을 수 있는 최대 보상 XP.
const DAILY_BOT_MATCH_XP_CAP = 100;

let store = {}; // { [guildId]: { [userId]: { date: "YYYY-MM-DD"(KST), earned: number } } }

function loadBotMatchXp() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    }
  } catch {
    store = {};
  }
}

function saveBotMatchXp() {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store), 'utf8');
}

function kstDateString(epochMs = Date.now()) {
  const kst = new Date(epochMs + KST_OFFSET_MS);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`;
}

// 다음 KST 자정까지 남은 시간을 "N시간 M분" 형태로 반환 (한도 초기화 안내용).
function timeUntilKstMidnight(epochMs = Date.now()) {
  const kst = new Date(epochMs + KST_OFFSET_MS);
  const nextMidnightKst = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() + 1) - KST_OFFSET_MS;
  const remainingMs = nextMidnightKst - epochMs;
  const hours = Math.floor(remainingMs / (60 * 60 * 1000));
  const minutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000));
  return `${hours}시간 ${minutes}분`;
}

// 오늘(KST) 이 유저가 이미 받은 봇전 보상 XP. 날짜가 바뀌었으면 0으로 본다.
function getEarnedToday(guildId, userId) {
  const rec = store[guildId]?.[userId];
  if (!rec || rec.date !== kstDateString()) return 0;
  return rec.earned || 0;
}

// 오늘 이 유저가 봇전으로 더 받을 수 있는 XP(0 이상). 상한에 도달했으면 0.
function getRemainingBotXp(guildId, userId) {
  return Math.max(0, DAILY_BOT_MATCH_XP_CAP - getEarnedToday(guildId, userId));
}

// 실제 지급이 확정된 XP를 오늘 사용량에 더한다. 호출부에서 getRemainingBotXp로 미리
// 상한을 걸어 넘긴다는 전제라 여기서 다시 자르지는 않는다.
function addBotMatchXp(guildId, userId, amount) {
  if (amount <= 0) return;
  if (!store[guildId]) store[guildId] = {};
  const today = kstDateString();
  const rec = store[guildId][userId];
  if (!rec || rec.date !== today) {
    store[guildId][userId] = { date: today, earned: amount };
  } else {
    rec.earned += amount;
  }
}

module.exports = {
  DAILY_BOT_MATCH_XP_CAP,
  loadBotMatchXp,
  saveBotMatchXp,
  getRemainingBotXp,
  getEarnedToday,
  addBotMatchXp,
  timeUntilKstMidnight,
};

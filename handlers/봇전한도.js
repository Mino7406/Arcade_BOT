// 봇전한도.js — 끝말잇기·틱택토 "봇전"에서 하루에 얻을 수 있는 보상 XP 총량을 제한한다.
// 게임별 쿨다운(xpSettleCooldowns)이 "연타 방지"라면, 이 모듈은 "하루 총량 방지"다.
// 봇을 상대로 계속 이겨도 하루에 받을 수 있는 보상 XP에 상한을 두고, 끝말잇기와 틱택토가
// 같은 예산을 공유하게 해서 게임을 바꿔가며 우회하는 것도 막는다.
// (KST 자정에 초기화 — 룰렛의 일일 플레이 기록과 같은 방식)

const fs = require('fs');
const path = require('path');
const { kstDateString, timeUntilKstMidnight } = require('./시간');
const { logSystem } = require('./로그');
const { writeJsonIfChanged } = require('./저장');

const STORE_PATH = path.join(__dirname, '..', 'DB', 'botmatch-xp.json');
fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });

// 유저 한 명이 하루에 봇전(끝말잇기 + 틱택토 합산)으로 받을 수 있는 최대 보상 XP.
const DAILY_BOT_MATCH_XP_CAP = 100;

// 끝말잇기·틱택토 봇전 공용 보상 상수(예전엔 두 파일에 같은 값이 복붙돼 있었다).
// 사람끼리 대결 시 자동으로 거는 내기 XP(진 사람의 현재 레벨 안 XP로 상한을 걸어 레벨은 안 떨어짐).
const WAGER_XP = 100;
// 봇을 이겼을 때 지급하는 보상 XP 범위(고정값 아님, 매 판 무작위).
const BOT_WIN_XP_MIN = 10;
const BOT_WIN_XP_MAX = 30;
function rollBotWinXp() {
  return BOT_WIN_XP_MIN + Math.floor(Math.random() * (BOT_WIN_XP_MAX - BOT_WIN_XP_MIN + 1));
}

let store = {}; // { [guildId]: { [userId]: { date: "YYYY-MM-DD"(KST), earned: number } } }

function loadBotMatchXp() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    }
  } catch (err) {
    // 초기화되면 오늘치 봇전 보상 한도가 풀려 XP를 상한 없이 더 받을 수 있게 된다.
    console.error('봇전 XP 한도 기록 읽기 실패(오늘치 한도가 초기화됨):', err);
    logSystem({ 유형: '저장 오류', 내용: `botMatchXp.json 읽기 실패 — 오늘치 봇전 보상 한도 초기화됨: ${err?.message ?? err}` });
    store = {};
  }
}

function saveBotMatchXp() {
  writeJsonIfChanged(STORE_PATH, store);
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
  WAGER_XP,
  BOT_WIN_XP_MIN,
  BOT_WIN_XP_MAX,
  rollBotWinXp,
  loadBotMatchXp,
  saveBotMatchXp,
  getRemainingBotXp,
  getEarnedToday,
  addBotMatchXp,
  timeUntilKstMidnight,
};

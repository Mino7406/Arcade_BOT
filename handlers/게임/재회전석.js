// 재회전석.js — 알바트리온 레이드 MVP 보상 아이템 "속성 재회전석" 보유량 관리.
// 룰렛 결과가 나온 직후 쓰면 릴 한 칸만 골라 다시 돌린다(룰렛.js). 블랙월게이트웨이.js 와 같은 구조 — 서버(길드)별로 따로 센다.
// 지급·사용이 드물어 바뀔 때마다 바로 저장한다. 이름·이모지는 임시(나중에 바꾸기 쉽게 이 파일 위쪽 상수에만 둔다).

const fs = require('fs');
const path = require('path');
const { writeJsonIfChanged } = require('../공통/저장');
const { logSystem } = require('../공통/로그');

const REROLL_NAME = '속성 재회전석';
const REROLL_EMOJI = '🔁';
const REROLL_MAX = 1; // 최대 보유량
// 글자 안에 넣는 이모지 / 버튼 setEmoji 용 값(앱 이모지를 등록하기 전까지는 같은 폴백)
const rerollEmoji = () => REROLL_EMOJI;
const rerollButtonEmoji = () => REROLL_EMOJI;

const REROLL_PATH = path.join(__dirname, '..', '..', 'DB', 'reroll.json');
let items = {}; // { [guildId]: { [userId]: 보유 개수 } }

function loadRerolls() {
  try {
    if (fs.existsSync(REROLL_PATH)) items = JSON.parse(fs.readFileSync(REROLL_PATH, 'utf8')) || {};
  } catch (err) {
    console.error('속성 재회전석 기록 읽기 실패(보유량이 초기화됨):', err);
    logSystem({ 유형: '저장 오류', 내용: `reroll.json 읽기 실패 — ${REROLL_NAME} 보유량 초기화됨: ${err?.message ?? err}` });
    items = {};
  }
}
function saveRerolls() {
  try {
    fs.mkdirSync(path.dirname(REROLL_PATH), { recursive: true });
    writeJsonIfChanged(REROLL_PATH, items);
  } catch (err) {
    console.error('속성 재회전석 저장 실패:', err);
    logSystem({ 유형: '저장 오류', 내용: `reroll.json 저장 실패: ${err?.message ?? err}` });
  }
}
const getRerolls = (guildId, userId) => items[guildId]?.[userId] ?? 0;
function setCount(guildId, userId, n) {
  if (!items[guildId]) items[guildId] = {};
  if (n > 0) items[guildId][userId] = n; else delete items[guildId][userId];
}
function grantReroll(guildId, userId) {
  const have = getRerolls(guildId, userId);
  if (have >= REROLL_MAX) return false; // 최대 보유면 못 받음
  setCount(guildId, userId, have + 1);
  saveRerolls();
  return true;
}
// 1개 사용. 썼으면 true, 없으면 false.
function useReroll(guildId, userId) {
  const have = getRerolls(guildId, userId);
  if (have <= 0) return false;
  setCount(guildId, userId, have - 1);
  saveRerolls();
  return true;
}

module.exports = { REROLL_NAME, REROLL_MAX, rerollEmoji, rerollButtonEmoji, loadRerolls, saveRerolls, getRerolls, grantReroll, useReroll };

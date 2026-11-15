// 해킹툴.js — 레이드 클리어 보상 아이템 "해킹 툴" 보유량 관리.
// 해킹 툴 1장으로 룰렛에서 꽝이 나왔을 때 결과를 번복하고 같은 베팅으로 한 번 더 돌릴 수 있다(룰렛.js).
// 받는 곳: 레이드 토벌 성공 시 XP 보상을 받는 파티원(직접 행동한 사람)에게 1장씩(레이드/index.js).
// 서버(길드)별로 따로 센다. 지급·사용이 드물어 바뀔 때마다 바로 저장한다(30초 자동 저장에 넣지 않음).
//
// 이 모듈은 저장·로그 도구만 require 한다(순환참조 방지).

const fs = require('fs');
const path = require('path');
const { writeJsonIfChanged } = require('../공통/저장');
const { logSystem } = require('../공통/로그');

// 아이템 이름은 아직 미정이라 한곳에서만 바꾸면 되게 상수로 둔다.
const HACK_TOOL_NAME = '해킹 툴';
const HACK_TOOL_EMOJI = '🛠️';
const HACK_TOOL_MAX = 3; // 최대 보유 장수. 꽉 찬 상태에서 받으면 그 장은 버려진다

const HACK_TOOL_PATH = path.join(__dirname, '..', '..', 'DB', 'hacktool.json');

let tools = {}; // { [guildId]: { [userId]: 보유 장수 } }

function loadHackTools() {
  try {
    if (fs.existsSync(HACK_TOOL_PATH)) tools = JSON.parse(fs.readFileSync(HACK_TOOL_PATH, 'utf8')) || {};
  } catch (err) {
    console.error('해킹 툴 기록 읽기 실패(보유량이 초기화됨):', err);
    logSystem({ 유형: '저장 오류', 내용: `hacktool.json 읽기 실패 — 해킹 툴 보유량 초기화됨: ${err?.message ?? err}` });
    tools = {};
  }
}

function saveHackTools() {
  try {
    fs.mkdirSync(path.dirname(HACK_TOOL_PATH), { recursive: true });
    writeJsonIfChanged(HACK_TOOL_PATH, tools);
  } catch (err) {
    console.error('해킹 툴 저장 실패:', err);
    logSystem({ 유형: '저장 오류', 내용: `hacktool.json 저장 실패: ${err?.message ?? err}` });
  }
}

function getHackTools(guildId, userId) {
  return tools[guildId]?.[userId] ?? 0;
}

function setCount(guildId, userId, n) {
  if (!tools[guildId]) tools[guildId] = {};
  if (n > 0) tools[guildId][userId] = n;
  else delete tools[guildId][userId];
}

// 1장 지급. 받았으면 true, 이미 최대 보유라 못 받았으면 false.
function grantHackTool(guildId, userId) {
  const have = getHackTools(guildId, userId);
  if (have >= HACK_TOOL_MAX) return false;
  setCount(guildId, userId, have + 1);
  saveHackTools();
  return true;
}

// 1장 사용. 썼으면 true, 없으면 false.
function useHackTool(guildId, userId) {
  const have = getHackTools(guildId, userId);
  if (have <= 0) return false;
  setCount(guildId, userId, have - 1);
  saveHackTools();
  return true;
}

module.exports = { HACK_TOOL_NAME, HACK_TOOL_EMOJI, HACK_TOOL_MAX, loadHackTools, saveHackTools, getHackTools, grantHackTool, useHackTool };

// 역린.js — 알바트리온 레이드 MVP 보상 아이템 "역린" 보유량 관리.
// 룰렛 결과가 나온 직후 쓰면 릴 한 칸만 골라 다시 돌린다(룰렛.js). 블랙월게이트웨이.js 와 같은 구조 — 서버(길드)별로 따로 센다.
// 지급·사용이 드물어 바뀔 때마다 바로 저장한다. 이름·이모지는 이 파일 위쪽 상수에만 둔다.

const fs = require('fs');
const path = require('path');
const { writeJsonIfChanged } = require('../공통/저장');
const { logSystem } = require('../공통/로그');

const REROLL_NAME = '역린';
// 이모지는 assets/이모지/reroll.png 를 봇의 앱 이모지로 등록해 쓴다(봇이 켜질 때 ensureRerollEmoji). 파일이 없거나 등록 전이면 🐲로 보인다.
// 그림을 바꾸면 name 의 _v 숫자를 올려 새로 등록되게 한다.
const EMOJI = { name: 'reroll_v2', file: 'reroll.png', fallback: '🐲', id: null };
const EMOJI_DIR = path.join(__dirname, '..', '..', 'assets', '이모지');
const REROLL_MAX = 1; // 최대 보유량
const REROLL_DESC = '룰렛 결과가 나온 직후 릴 **한 칸**만 골라 다시 돌려요'; // 로비 보상 안내·사용 확인 창이 같이 쓰는 한 줄 설명
async function ensureRerollEmoji(client) {
  const manager = client.application?.emojis;
  if (!manager) return false;
  try {
    const file = path.join(EMOJI_DIR, EMOJI.file);
    if (!fs.existsSync(file)) return false; // 그림이 아직 없으면 폴백 이모지로 둔다
    const list = await manager.fetch();
    let emoji = list.find(x => x.name === EMOJI.name);
    if (!emoji) {
      emoji = await manager.create({ attachment: file, name: EMOJI.name });
      logSystem({ 유형: '봇 상태', 내용: `${REROLL_NAME} 앱 이모지 등록 (${EMOJI.name})` });
    }
    EMOJI.id = emoji.id;
    return true;
  } catch (err) {
    console.error(`${REROLL_NAME} 이모지 준비 실패(대신 ${EMOJI.fallback}로 표시):`, err);
    return false;
  }
}
// 글자 안에 넣는 이모지(<:이름:id>) / 버튼 setEmoji 용 값 — 등록 전이면 폴백
const rerollEmoji = () => (EMOJI.id ? `<:${EMOJI.name}:${EMOJI.id}>` : EMOJI.fallback);
const rerollButtonEmoji = () => (EMOJI.id ? { id: EMOJI.id, name: EMOJI.name } : EMOJI.fallback);
// 화면 모음(tests/카드화면.js)처럼 봇 없이 그릴 때 이모지 자리를 채우는 용도
const setRerollEmojiId = (id) => { EMOJI.id = id; };

const REROLL_PATH = path.join(__dirname, '..', '..', 'DB', 'reroll.json');
let items = {}; // { [guildId]: { [userId]: 보유 개수 } }

function loadRerolls() {
  try {
    if (fs.existsSync(REROLL_PATH)) items = JSON.parse(fs.readFileSync(REROLL_PATH, 'utf8')) || {};
  } catch (err) {
    console.error('역린 기록 읽기 실패(보유량이 초기화됨):', err);
    logSystem({ 유형: '저장 오류', 내용: `reroll.json 읽기 실패 — ${REROLL_NAME} 보유량 초기화됨: ${err?.message ?? err}` });
    items = {};
  }
}
function saveRerolls() {
  try {
    fs.mkdirSync(path.dirname(REROLL_PATH), { recursive: true });
    writeJsonIfChanged(REROLL_PATH, items);
  } catch (err) {
    console.error('역린 저장 실패:', err);
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

module.exports = { REROLL_NAME, REROLL_MAX, REROLL_DESC, REROLL_EMOJI: EMOJI, EMOJI_DIR, ensureRerollEmoji, setRerollEmojiId, rerollEmoji, rerollButtonEmoji, loadRerolls, saveRerolls, getRerolls, grantReroll, useReroll };

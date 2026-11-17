// 블랙월게이트웨이.js — ??? 레이드 MVP 보상 아이템 "블랙월 게이트웨이" 보유량 관리.
// 룰렛 로비에서 발동해 두고 돌리면 그 판이 100% 잭팟(7️⃣ 트리플)이 된다(룰렛.js '사전 해킹'). 해킹 툴(꽝 이후 번복)과 달리 돌리기 전에 쓴다.
// 서버(길드)별로 따로 센다. 지급·사용이 드물어 바뀔 때마다 바로 저장한다.

const fs = require('fs');
const path = require('path');
const { writeJsonIfChanged } = require('../공통/저장');
const { logSystem } = require('../공통/로그');

const GATEWAY_NAME = '블랙월 게이트웨이';
// 이모지는 assets/이모지/blackwall.png 를 봇의 앱 이모지로 등록해 쓴다(봇이 켜질 때 ensureGatewayEmoji). 등록 전이거나 실패하면 🌐로 보인다.
// 그림을 바꾸면 name 의 _v 숫자를 올려 새로 등록되게 한다.
const EMOJI = { name: 'blackwall_v1', file: 'blackwall.png', fallback: '🌐', id: null };
const EMOJI_DIR = path.join(__dirname, '..', '..', 'assets', '이모지');
async function ensureGatewayEmoji(client) {
  const manager = client.application?.emojis;
  if (!manager) return false;
  try {
    const list = await manager.fetch();
    let emoji = list.find(x => x.name === EMOJI.name);
    if (!emoji) {
      emoji = await manager.create({ attachment: path.join(EMOJI_DIR, EMOJI.file), name: EMOJI.name });
      logSystem({ 유형: '봇 상태', 내용: `${GATEWAY_NAME} 앱 이모지 등록 (${EMOJI.name})` });
    }
    EMOJI.id = emoji.id;
    return true;
  } catch (err) {
    console.error(`${GATEWAY_NAME} 이모지 준비 실패(대신 🌐로 표시):`, err);
    return false;
  }
}
// 글자 안에 넣는 이모지(<:이름:id>) — 등록 전이면 🌐
const gatewayEmoji = () => (EMOJI.id ? `<:${EMOJI.name}:${EMOJI.id}>` : EMOJI.fallback);
// 버튼 setEmoji 용 값
const gatewayButtonEmoji = () => (EMOJI.id ? { id: EMOJI.id, name: EMOJI.name } : EMOJI.fallback);
// 화면 모음(tests/카드화면.js)처럼 봇 없이 그릴 때 이모지 자리를 채우는 용도
const setGatewayEmojiId = (id) => { EMOJI.id = id; };

const GATEWAY_PATH = path.join(__dirname, '..', '..', 'DB', 'gateway.json');
let items = {}; // { [guildId]: { [userId]: 보유 개수 } }

function loadGateways() {
  try {
    if (fs.existsSync(GATEWAY_PATH)) items = JSON.parse(fs.readFileSync(GATEWAY_PATH, 'utf8')) || {};
  } catch (err) {
    console.error('블랙월 게이트웨이 기록 읽기 실패(보유량이 초기화됨):', err);
    logSystem({ 유형: '저장 오류', 내용: `gateway.json 읽기 실패 — 블랙월 게이트웨이 보유량 초기화됨: ${err?.message ?? err}` });
    items = {};
  }
}
function saveGateways() {
  try {
    fs.mkdirSync(path.dirname(GATEWAY_PATH), { recursive: true });
    writeJsonIfChanged(GATEWAY_PATH, items);
  } catch (err) {
    console.error('블랙월 게이트웨이 저장 실패:', err);
    logSystem({ 유형: '저장 오류', 내용: `gateway.json 저장 실패: ${err?.message ?? err}` });
  }
}
const getGateways = (guildId, userId) => items[guildId]?.[userId] ?? 0;
function setCount(guildId, userId, n) {
  if (!items[guildId]) items[guildId] = {};
  if (n > 0) items[guildId][userId] = n; else delete items[guildId][userId];
}
const GATEWAY_MAX = 1; // 최대 보유량(해킹 툴은 3개, 게이트웨이는 1개)
function grantGateway(guildId, userId) {
  const have = getGateways(guildId, userId);
  if (have >= GATEWAY_MAX) return false; // 최대 보유면 못 받음
  setCount(guildId, userId, have + 1);
  saveGateways();
  return true;
}
// 1개 사용. 썼으면 true, 없으면 false.
function useGateway(guildId, userId) {
  const have = getGateways(guildId, userId);
  if (have <= 0) return false;
  setCount(guildId, userId, have - 1);
  saveGateways();
  return true;
}

module.exports = { GATEWAY_MAX, GATEWAY_EMOJI: EMOJI, EMOJI_DIR, GATEWAY_NAME, gatewayEmoji, gatewayButtonEmoji, ensureGatewayEmoji, setGatewayEmojiId, loadGateways, saveGateways, getGateways, grantGateway, useGateway };

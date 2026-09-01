// 마크.js — 마인크래프트 렐름 승인 명단 저장/조회.
// 승인/거절 자체는 검토 임베드(commands/마크.js)가 메시지 상태만으로 처리하지만, "지금까지
// 승인된 사람이 누구인지"는 개별 메시지를 다 뒤지지 않고도 바로 볼 수 있어야 하므로 별도로
// 가볍게 저장한다. 룰렛(roulette.json)과 같은 단일 JSON 파일 방식.
//
// rosterMessageId는 검토 채널에 올려둔 "명단" 메시지 하나의 ID다 — 승인/거절이 있을 때마다
// 그 메시지를 지우고 새로 올려 항상 채널에 명단 메시지가 딱 하나만 존재하게 한다(재시작해도
// 어느 메시지를 지워야 할지 알 수 있도록 여기 같이 저장).

const fs = require('fs');
const path = require('path');
const { writeJsonIfChanged } = require('./저장');
const { logSystem } = require('./로그');

const REALM_ROSTER_PATH = path.join(__dirname, '..', 'DB', 'realm_roster.json');
fs.mkdirSync(path.dirname(REALM_ROSTER_PATH), { recursive: true });

// { [guildId]: { members: { [userId]: { nickname, discordName, approvedAt(epoch ms), approvedById } }, rosterMessageId: string|null } }
let roster = {};

function ensureGuild(guildId) {
  if (!roster[guildId]) roster[guildId] = { members: {}, rosterMessageId: null };
  return roster[guildId];
}

function loadRealmRoster() {
  try {
    if (fs.existsSync(REALM_ROSTER_PATH)) {
      roster = JSON.parse(fs.readFileSync(REALM_ROSTER_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('렐름 승인 명단 읽기 실패(명단이 초기화됨):', err);
    logSystem({ 유형: '저장 오류', 내용: `realm_roster.json 읽기 실패 — 명단 초기화됨: ${err?.message ?? err}` });
    roster = {};
  }
}

function saveRealmRoster() {
  writeJsonIfChanged(REALM_ROSTER_PATH, roster);
}

function addApprovedMember(guildId, userId, entry) {
  ensureGuild(guildId).members[userId] = entry;
}

// 승인 취소(거절로 재처리 등) 시 명단에서 뺀다. 없어도 조용히 무시.
function removeApprovedMember(guildId, userId) {
  delete ensureGuild(guildId).members[userId];
}

// 승인 시각(approvedAt) 오름차순(먼저 승인된 순)으로 정렬해 반환.
function getApprovedRoster(guildId) {
  const members = roster[guildId]?.members || {};
  return Object.entries(members)
    .map(([userId, entry]) => ({ userId, ...entry }))
    .sort((a, b) => a.approvedAt - b.approvedAt);
}

function getRosterMessageId(guildId) {
  return roster[guildId]?.rosterMessageId ?? null;
}

function setRosterMessageId(guildId, messageId) {
  ensureGuild(guildId).rosterMessageId = messageId;
}

module.exports = {
  loadRealmRoster,
  saveRealmRoster,
  addApprovedMember,
  removeApprovedMember,
  getApprovedRoster,
  getRosterMessageId,
  setRosterMessageId,
};

// forms/마크/명단.js — 마인크래프트 렐름 승인 명단 저장/조회 ("마크" 신청서 전용 저장소).
// 승인/거절 자체는 검토 임베드(forms/마크/index.js)가 메시지 상태만으로 처리하지만, "지금까지
// 승인된 사람이 누구인지"는 개별 메시지를 다 뒤지지 않고도 바로 볼 수 있어야 하므로 별도로
// 가볍게 저장한다. 룰렛(roulette.json)과 같은 단일 JSON 파일 방식.
//
// rosterMessageId는 검토 채널에 올려둔 "명단" 메시지 하나의 ID다 — 승인/거절이 있을 때마다
// 그 메시지를 지우고 새로 올려 항상 채널에 명단 메시지가 딱 하나만 존재하게 한다(재시작해도
// 어느 메시지를 지워야 할지 알 수 있도록 여기 같이 저장).

const fs = require('fs');
const path = require('path');
const { writeJsonIfChanged } = require('../../handlers/저장');
const { logSystem } = require('../../handlers/로그');

const REALM_ROSTER_PATH = path.join(__dirname, '..', '..', 'DB', 'realm_roster.json');
fs.mkdirSync(path.dirname(REALM_ROSTER_PATH), { recursive: true });

// { [guildId]: {
//   members: { [userId]: { nickname, discordName, approvedAt(epoch ms), approvedById, order } },
//   pending: { [userId]: { nickname, appliedAt(epoch ms) } },
//   rosterMessageId: string|null,
// } }
// order는 명단 표시 순서를 결정하는 값이다. 기본은 승인 시각이지만 moveApprovedMember로 인접
// 항목과 값을 맞바꿔 수동으로 순서를 바꿀 수 있다(값 자체의 의미보다 상대적 크기 비교만 사용).
// pending은 검토 대기중인 신청서를 추적해 같은 사람이 중복으로 신청서를 내는 것을 막는 데 쓴다
// (승인/거절 처리가 끝나면 지운다 — 승인은 members로 넘어가고, 거절은 재신청할 수 있어야 하므로).
let roster = {};

function ensureGuild(guildId) {
  if (!roster[guildId]) roster[guildId] = { members: {}, pending: {}, rosterMessageId: null };
  if (!roster[guildId].pending) roster[guildId].pending = {}; // 이 필드가 추가되기 전 데이터 호환
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

// 이미 명단에 있는 유저를 다시 추가(재승인 등)하면 표시 순서(order)는 유지한 채 나머지 정보만
// 갱신한다 — 그래야 재승인했다고 명단 맨 끝으로 밀려나지 않는다. 새 유저는 맨 뒤에 붙는다.
function addApprovedMember(guildId, userId, entry) {
  const guild = ensureGuild(guildId);
  const existingOrder = guild.members[userId]?.order;
  guild.members[userId] = { ...entry, order: existingOrder ?? entry.approvedAt ?? Date.now() };
}

// 승인 취소(거절로 재처리 등) 시 명단에서 뺀다. 없어도 조용히 무시.
function removeApprovedMember(guildId, userId) {
  delete ensureGuild(guildId).members[userId];
}

// 이미 승인된 멤버인지 — "🏰 신청하기" 클릭 시 재신청을 막는 데 사용.
function isApprovedMember(guildId, userId) {
  return !!roster[guildId]?.members?.[userId];
}

// 신청서 제출 시 대기중으로 등록한다(중복 신청 방지용).
function addPendingApplication(guildId, userId, entry) {
  ensureGuild(guildId).pending[userId] = entry;
}

// 승인/거절 처리가 끝나면 대기 목록에서 뺀다. 없어도 조용히 무시.
function removePendingApplication(guildId, userId) {
  delete ensureGuild(guildId).pending[userId];
}

// 이미 검토 대기중인 신청서가 있는지 — "🏰 신청하기" 클릭 시 중복 신청을 막는 데 사용.
function hasPendingApplication(guildId, userId) {
  return !!roster[guildId]?.pending?.[userId];
}

function updateApprovedMemberNickname(guildId, userId, nickname) {
  const member = roster[guildId]?.members?.[userId];
  if (!member) return false;
  member.nickname = nickname;
  return true;
}

// position은 1부터 시작하는, 사람이 보는 순번이다. 범위를 벗어나면 맨 앞/맨 뒤로 clamp한다.
// 이동 후 정렬된 배열 순서 그대로 order를 0,1,2...로 다시 매겨서(order 값 자체의 크기는
// 의미 없고 상대적 순서만 쓰므로) 드리프트 없이 항상 깔끔한 정수로 유지한다.
function setApprovedMemberPosition(guildId, userId, position) {
  const sorted = getApprovedRoster(guildId);
  const idx = sorted.findIndex(e => e.userId === userId);
  if (idx === -1) return false;

  const [moved] = sorted.splice(idx, 1);
  const targetIdx = Math.max(0, Math.min(position - 1, sorted.length));
  sorted.splice(targetIdx, 0, moved);

  const members = ensureGuild(guildId).members;
  sorted.forEach((entry, i) => {
    members[entry.userId].order = i;
  });
  return true;
}

// 표시 순서(order) 오름차순으로 정렬해 반환 — order가 없는 옛 데이터는 승인 시각으로 대신한다.
function getApprovedRoster(guildId) {
  const members = roster[guildId]?.members || {};
  return Object.entries(members)
    .map(([userId, entry]) => ({ userId, ...entry }))
    .sort((a, b) => (a.order ?? a.approvedAt) - (b.order ?? b.approvedAt));
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
  isApprovedMember,
  addPendingApplication,
  removePendingApplication,
  hasPendingApplication,
  updateApprovedMemberNickname,
  setApprovedMemberPosition,
  getApprovedRoster,
  getRosterMessageId,
  setRosterMessageId,
};

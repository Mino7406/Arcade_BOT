// levels.js — MEE6과 동일한 방식의 레벨/XP 시스템
// 메시지 1개당 15~25 XP 랜덤 지급, 유저당 60초 쿨다운, 레벨업 요구치 공식도 MEE6와 동일.

const fs = require('fs');
const path = require('path');

const LEVELS_PATH = path.join(__dirname, '..', 'levels.json');

const COOLDOWN_MS = 60 * 1000;
const XP_MIN = 15;
const XP_MAX = 25;

// 테스트 서버 등 레벨 시스템을 적용하지 않을 길드
const EXCLUDED_GUILD_IDS = ['1282694117255548960'];

// XP 지급을 감지할 채널 (이 채널의 메시지만 XP로 인정)
const XP_CHANNEL_ID = '1340523443413844048';

// 내전/모집 완료 보너스 XP를 적용할 채널과 배율
const MATCH_BONUS_CHANNEL_ID = '1343818387519963216';
const ORGANIZER_XP_MULTIPLIER = 1.3;
const PARTICIPANT_XP_MULTIPLIER = 1.1;

let levels = {}; // { [guildId]: { [userId]: xp } }
const cooldowns = new Map(); // `${guildId}:${userId}` → 마지막 XP 지급 시각

function loadLevels() {
  try {
    if (fs.existsSync(LEVELS_PATH)) {
      levels = JSON.parse(fs.readFileSync(LEVELS_PATH, 'utf8'));
    }
  } catch {
    levels = {};
  }
}

function saveLevels() {
  fs.writeFileSync(LEVELS_PATH, JSON.stringify(levels), 'utf8');
}

function getGuildLevels(guildId) {
  if (!levels[guildId]) levels[guildId] = {};
  return levels[guildId];
}

// MEE6 공식: level → level+1로 올라가는 데 필요한 XP
function xpNeededForLevel(level) {
  return 5 * level * level + 50 * level + 100;
}

// 누적 XP → 현재 레벨, 그 레벨 안에서의 XP, 다음 레벨까지 필요한 XP
function levelFromXp(xp) {
  let level = 0;
  let remaining = xp;
  while (remaining >= xpNeededForLevel(level)) {
    remaining -= xpNeededForLevel(level);
    level++;
  }
  return { level, currentLevelXp: remaining, neededXp: xpNeededForLevel(level) };
}

function getXp(guildId, userId) {
  return getGuildLevels(guildId)[userId] || 0;
}

// XP를 더하고 레벨업 여부를 반환하는 공통 로직.
function applyXp(guildId, userId, amount) {
  const guildLevels = getGuildLevels(guildId);
  const oldXp = guildLevels[userId] || 0;
  const oldLevel = levelFromXp(oldXp).level;
  const newXp = oldXp + amount;
  guildLevels[userId] = newXp;
  const newLevel = levelFromXp(newXp).level;

  if (newLevel > oldLevel) return { leveledUp: true, newLevel };
  return { leveledUp: false };
}

function randomBaseXp() {
  return Math.floor(Math.random() * (XP_MAX - XP_MIN + 1)) + XP_MIN;
}

// 메시지 하나에 대해 쿨다운을 확인하고 XP를 지급. 레벨업 여부를 반환.
function handleMessageXp(message) {
  if (message.author.bot || !message.guild) return null;
  if (message.channelId !== XP_CHANNEL_ID) return null;
  const guildId = message.guildId;
  if (EXCLUDED_GUILD_IDS.includes(guildId)) return null;
  const userId = message.author.id;
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  const last = cooldowns.get(key) || 0;
  if (now - last < COOLDOWN_MS) return null;
  cooldowns.set(key, now);

  return applyXp(guildId, userId, randomBaseXp());
}

// 내전/모집이 성공적으로 마감됐을 때 주최자/참가자에게 1회성 보너스 XP를 지급한다.
// match.xpAwardedUserIds(유저별 지급 이력)로 재마감돼도 이미 받은 사람은 또 받지 않게 막는다.
// 레벨업한 사람만 배열로 반환(호출부에서 축하 메시지를 보낼 수 있도록).
function awardMatchCompletionXp(match) {
  if (!match) return [];
  if (!match.message || match.message.channelId !== MATCH_BONUS_CHANNEL_ID) return [];

  const guildId = match.guildId;
  if (!guildId || EXCLUDED_GUILD_IDS.includes(guildId)) return [];

  if (!match.xpAwardedUserIds) match.xpAwardedUserIds = new Set();

  const results = [];
  const organizerId = match.data?.organizer?.id;
  if (organizerId && !match.xpAwardedUserIds.has(organizerId)) {
    match.xpAwardedUserIds.add(organizerId);
    const gained = Math.round(randomBaseXp() * ORGANIZER_XP_MULTIPLIER);
    results.push({ userId: organizerId, ...applyXp(guildId, organizerId, gained) });
  }

  for (const participant of match.participants || []) {
    if (participant.id === organizerId) continue; // 주최자 중복 지급 방지
    if (match.xpAwardedUserIds.has(participant.id)) continue; // 이미 지급받음
    match.xpAwardedUserIds.add(participant.id);
    const gained = Math.round(randomBaseXp() * PARTICIPANT_XP_MULTIPLIER);
    results.push({ userId: participant.id, ...applyXp(guildId, participant.id, gained) });
  }

  return results.filter(r => r.leveledUp);
}

function getLeaderboard(guildId, limit = 10) {
  return Object.entries(getGuildLevels(guildId))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([userId, xp], i) => ({ rank: i + 1, userId, xp, ...levelFromXp(xp) }));
}

// 진행바를 이모지/유니코드 블록으로 표현 (예: ■■■■■■□□□□)
function buildProgressBar(current, needed, length = 20) {
  const ratio = needed > 0 ? Math.min(1, current / needed) : 0;
  const filled = Math.round(ratio * length);
  return '■'.repeat(filled) + '□'.repeat(length - filled);
}

module.exports = {
  loadLevels,
  saveLevels,
  handleMessageXp,
  awardMatchCompletionXp,
  levelFromXp,
  getXp,
  getLeaderboard,
  XP_CHANNEL_ID,
  buildProgressBar,
};

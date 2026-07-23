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

  const guildLevels = getGuildLevels(guildId);
  const oldXp = guildLevels[userId] || 0;
  const oldLevel = levelFromXp(oldXp).level;
  const gained = Math.floor(Math.random() * (XP_MAX - XP_MIN + 1)) + XP_MIN;
  const newXp = oldXp + gained;
  guildLevels[userId] = newXp;
  const newLevel = levelFromXp(newXp).level;

  if (newLevel > oldLevel) return { leveledUp: true, newLevel };
  return { leveledUp: false };
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
  levelFromXp,
  getXp,
  getLeaderboard,
  buildProgressBar,
};

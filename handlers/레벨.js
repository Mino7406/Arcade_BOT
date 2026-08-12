// 레벨.js — MEE6과 동일한 방식의 레벨/XP 시스템
// 메시지 1개당 15~25 XP 랜덤 지급, 유저당 60초 쿨다운, 레벨업 요구치 공식도 MEE6와 동일.

const fs = require('fs');
const path = require('path');

const LEVELS_PATH = path.join(__dirname, '..', 'levels.json');

const COOLDOWN_MS = 60 * 1000;
// TTS 채널(XP_CHANNEL_MULTIPLIERS 대상)은 음소거/미접속 상태로 텍스트만 계속 쳐도
// 배율만으로는 파밍을 못 막으므로, 기본 쿨다운보다 훨씬 길게 따로 적용한다.
const TTS_CHANNEL_COOLDOWN_MS = 3 * 60 * 1000;
const XP_MIN = 15;
const XP_MAX = 25;

// 테스트 서버 등 레벨 시스템을 적용하지 않을 길드
const EXCLUDED_GUILD_IDS = ['1282694117255548960'];

// XP 지급을 감지할 채널 (이 채널의 메시지만 XP로 인정)
const XP_CHANNEL_ID = '1340523443413844048';

// 레벨업 축하 메시지를 보낼 채널
const LEVEL_UP_ANNOUNCE_CHANNEL_ID = '1522174367075663872';

// 기본 배율(1배)이 아닌 XP 배율을 적용할 채널
// TTS 채널 0.06배 = 통화방 체류(수동) 시간당 평균(~24 XP)과 1:1로 맞춘 값.
// 3분 쿨다운(TTS_CHANNEL_COOLDOWN_MS)을 딱딱 맞춰 쳐도 시간당 20회 × 평균 20 XP × 0.06 ≈ 24 XP로,
// 아무리 열심히 타이핑해도 통화방에 그냥 앉아있는 것 이상으로 벌 수 없게 맞췄다.
const XP_CHANNEL_MULTIPLIERS = {
  '1374679502394884178': 0.06,
  '1522575222589620254': 0.06,
};

// 내전/모집 완료 보너스 XP를 적용할 채널과 배율
const MATCH_BONUS_CHANNEL_ID = '1535971639660122262';
const ORGANIZER_XP_MULTIPLIER = 1.5;
const PARTICIPANT_XP_MULTIPLIER = 1.3;

// 통화방(음성 채널) 체류 XP: 봇이 음성에 직접 참가하지 않고도
// voiceStateUpdate 게이트웨이 이벤트만으로 1분마다 활동 중인 유저에게 XP를 지급한다.
// 마이크만 켜놓으면 노력 없이 쌓이는 방치형 XP라 텍스트 채팅보다 낮은 배율을 사용.
// 배율이 낮아 매 틱 계산값이 1 미만일 때가 많은데, 그냥 반올림하면 소수점이 버려져
// 손실이 생기므로 남은 소수점을 다음 틱으로 이월(voiceXpCarry)해 손실 없이 누적한다
// (15~25 XP * 1분 * 0.02 = 시간당 평균 ~24 XP, 이월 덕분에 정확히 지급됨).
const VOICE_XP_TICK_MINUTES = 1;
const VOICE_XP_TICK_MS = VOICE_XP_TICK_MINUTES * 60 * 1000;
const VOICE_XP_MULTIPLIER = 0.02;

let levels = {}; // { [guildId]: { [userId]: xp } }
const cooldowns = new Map(); // `${guildId}:${userId}` → 마지막 XP 지급 시각
const voiceXpCarry = new Map(); // `${guildId}:${userId}` → 반올림 후 남은 소수점 이월분 (다음 틱에 더해짐)
const activeVoiceUsers = new Set(); // `${guildId}:${userId}` — 현재 음성 채널에서 음소거/헤드셋오프가 아닌 상태로 활동 중

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
  const isMainChannel = message.channelId === XP_CHANNEL_ID;
  const multiplier = XP_CHANNEL_MULTIPLIERS[message.channelId];
  if (!isMainChannel && multiplier === undefined) return null;
  const guildId = message.guildId;
  if (EXCLUDED_GUILD_IDS.includes(guildId)) return null;
  const userId = message.author.id;
  const key = `${guildId}:${userId}`;

  // TTS 채널(0.06배 채널)은 음성 통화방과 짝지어 쓰이는 채널이라,
  // 음소거 없이 음성 틱 XP를 이미 받고 있는 유저에게는 텍스트 XP를 중복 지급하지 않는다.
  if (multiplier !== undefined && activeVoiceUsers.has(key)) return null;

  const now = Date.now();
  const last = cooldowns.get(key) || 0;
  const cooldownMs = multiplier !== undefined ? TTS_CHANNEL_COOLDOWN_MS : COOLDOWN_MS;
  if (now - last < cooldownMs) return null;
  cooldowns.set(key, now);

  const baseXp = randomBaseXp();
  const gained = multiplier !== undefined ? Math.round(baseXp * multiplier) : baseXp;
  return applyXp(guildId, userId, gained);
}

// 내전/모집이 성공적으로 마감됐을 때 주최자/참가자에게 1회성 보너스 XP를 지급한다.
// match.xpAwardedUserIds(유저별 지급 이력, 일반 객체 - JSON 저장/복원 가능)로
// 재마감돼도 이미 받은 사람은 또 받지 않게 막는다.
// 레벨업한 사람만 배열로 반환(호출부에서 축하 메시지를 보낼 수 있도록).
function awardMatchCompletionXp(match) {
  if (!match) return [];
  if (!match.message || match.message.channelId !== MATCH_BONUS_CHANNEL_ID) return [];

  const guildId = match.guildId;
  if (!guildId || EXCLUDED_GUILD_IDS.includes(guildId)) return [];

  if (!match.xpAwardedUserIds) match.xpAwardedUserIds = {};

  const results = [];
  const organizerId = match.data?.organizer?.id;
  if (organizerId && !match.xpAwardedUserIds[organizerId]) {
    match.xpAwardedUserIds[organizerId] = true;
    const gained = Math.round(randomBaseXp() * ORGANIZER_XP_MULTIPLIER);
    results.push({ userId: organizerId, ...applyXp(guildId, organizerId, gained) });
  }

  for (const participant of match.participants || []) {
    if (participant.id === organizerId) continue; // 주최자 중복 지급 방지
    if (match.xpAwardedUserIds[participant.id]) continue; // 이미 지급받음
    match.xpAwardedUserIds[participant.id] = true;
    const gained = Math.round(randomBaseXp() * PARTICIPANT_XP_MULTIPLIER);
    results.push({ userId: participant.id, ...applyXp(guildId, participant.id, gained) });
  }

  return results.filter(r => r.leveledUp);
}

// 음성 상태가 "XP 지급 대상"인지 판단 (봇 제외, 채널에 있어야 하고, 음소거/헤드셋오프면 제외)
function isVoiceStateActive(state) {
  if (!state?.channelId) return false;
  if (state.member?.user?.bot) return false;
  if (state.selfMute || state.selfDeaf) return false;
  return true;
}

// voiceStateUpdate 이벤트에서 호출: 유저의 활동 상태(입장/퇴장/음소거 전환)를 갱신한다.
function trackVoiceStateUpdate(oldState, newState) {
  const guildId = newState.guild?.id;
  if (!guildId || EXCLUDED_GUILD_IDS.includes(guildId)) return;
  const key = `${guildId}:${newState.id}`;
  if (isVoiceStateActive(newState)) {
    activeVoiceUsers.add(key);
  } else {
    activeVoiceUsers.delete(key);
  }
}

// 봇 재시작 시 이미 음성 채널에 있던 유저들을 추적 대상에 다시 등록한다.
function initVoiceStates(client) {
  for (const guild of client.guilds.cache.values()) {
    if (EXCLUDED_GUILD_IDS.includes(guild.id)) continue;
    for (const state of guild.voiceStates.cache.values()) {
      const key = `${guild.id}:${state.id}`;
      if (isVoiceStateActive(state)) {
        activeVoiceUsers.add(key);
      } else {
        activeVoiceUsers.delete(key);
      }
    }
  }
}

// 1분마다 그 시점에 활동 중인 유저들에게 통화방 체류 XP를 지급한다.
// 레벨업한 유저는 메인 XP 채널에 축하 메시지를 보낸다.
function startVoiceXpTicker(client) {
  setInterval(async () => {
    for (const key of activeVoiceUsers) {
      const [guildId, userId] = key.split(':');
      const raw = randomBaseXp() * VOICE_XP_TICK_MINUTES * VOICE_XP_MULTIPLIER + (voiceXpCarry.get(key) || 0);
      const gained = Math.floor(raw);
      voiceXpCarry.set(key, raw - gained);
      if (gained <= 0) continue;
      const result = applyXp(guildId, userId, gained);
      if (!result.leveledUp) continue;
      try {
        const channel = await client.channels.fetch(LEVEL_UP_ANNOUNCE_CHANNEL_ID);
        if (channel?.guildId === guildId) {
          await channel.send({
            content: `<@${userId}>님이 ${result.newLevel}레벨을 달성했어요. 🎉`,
            allowedMentions: { users: [userId] },
          });
        }
      } catch (error) {
        console.error('통화방 레벨업 메시지 전송 실패:', error);
      }
    }
  }, VOICE_XP_TICK_MS);
}

function getLeaderboard(guildId, limit = 10, offset = 0) {
  return Object.entries(getGuildLevels(guildId))
    .sort((a, b) => b[1] - a[1])
    .slice(offset, offset + limit)
    .map(([userId, xp], i) => ({ rank: offset + i + 1, userId, xp, ...levelFromXp(xp) }));
}

function getLeaderboardSize(guildId) {
  return Object.keys(getGuildLevels(guildId)).length;
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
  applyXp,
  trackVoiceStateUpdate,
  initVoiceStates,
  startVoiceXpTicker,
  levelFromXp,
  getXp,
  getLeaderboard,
  getLeaderboardSize,
  XP_CHANNEL_ID,
  LEVEL_UP_ANNOUNCE_CHANNEL_ID,
  MATCH_BONUS_CHANNEL_ID,
  EXCLUDED_GUILD_IDS,
  buildProgressBar,
};

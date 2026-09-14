// 레벨링.js — MEE6과 동일한 방식의 레벨/XP 시스템
// 메시지 1개당 15~25 XP 랜덤 지급(배율 없음), 유저당 30분 쿨다운. 레벨업 요구치 공식은 MEE6와 동일.

const fs = require('fs');
const path = require('path');
const { logSystem } = require('./로그');
const { writeJsonIfChanged } = require('./저장');

const {
  EXCLUDED_GUILD_IDS,
  isExcludedGuild,
  XP_CHANNEL_ID,
  LEVEL_UP_ANNOUNCE_CHANNEL_ID,
  XP_TTS_CHANNEL_IDS,
  MATCH_BONUS_CHANNEL_ID,
  NEWBIE_BOOST_ROLE_ID,
} = require('../config');

const LEVELS_PATH = path.join(__dirname, '..', 'DB', 'levels.json');
fs.mkdirSync(path.dirname(LEVELS_PATH), { recursive: true });

// 메인 채널과 TTS 채널의 메시지 XP를 완전히 통합한다 — 배율 없이 기본치를 그대로 지급하고,
// 쿨다운도 채널 구분 없이 동일하게 적용한다(예전엔 메인 60초 / TTS 180초로 갈렸었다).
// 1회 지급량(15~25)은 원래 MEE6 기본값 그대로 둬서 체감을 안 건드리고, 대신 쿨다운을
// 30분으로 크게 늘려 "진짜 문제였던" 시간당 상한만 잡는다 — 원래 60초 쿨다운일 때는
// 시간당 최대 ~1,200 XP까지 가능해 통화방 체류(시간당 24~48 XP)를 압도적으로 앞질렀는데,
// 30분 쿨다운이면 시간당 최대 40~80 XP로 통화방 체류의 약 1.67배 수준까지 눌린다
// (1회당 숫자는 그대로라 "덜 준다"는 체감 없이, 도배해서 얻는 총량만 억제).
// (메시지 기본치는 통화방 체류와 더는 공유하지 않는다 — 아래 VOICE_XP_MIN/MAX 참고.)
const COOLDOWN_MS = 30 * 60 * 1000;
const MESSAGE_XP_MIN = 15;
const MESSAGE_XP_MAX = 25;
function randomMessageXp() {
  return Math.floor(Math.random() * (MESSAGE_XP_MAX - MESSAGE_XP_MIN + 1)) + MESSAGE_XP_MIN;
}

// EXCLUDED_GUILD_IDS(레벨 시스템 미적용 길드), XP_CHANNEL_ID(XP 인정 채널),
// LEVEL_UP_ANNOUNCE_CHANNEL_ID(레벨업 축하 채널), MATCH_BONUS_CHANNEL_ID(완료 보너스 채널),
// XP_TTS_CHANNEL_IDS(TTS 채널 목록, 메인 채널과 완전히 동일하게 취급)는 config.js에 모아뒀다.

// 내전/모집 완료 보너스 XP: 메시지·통화방과 별개의 전용 기본치를 쓴다(예전엔 공용 기본치를
// 같이 썼는데, 세션 내내 그 기본치가 여러 번 바뀌면서 매치 완료 보상도 같이 계속 흔들렸다 —
// 실제 매치 하나를 다 치르는 건 메시지 한 번 보내는 것과는 무게감이 다른 일회성 이벤트라
// 메시지/통화방 튜닝에 더는 휩쓸리지 않게 분리했다. 메시지·통화방도 기본치(15~25)는 같지만
// 배율이 달라 서로 별개 수치다).
// 참가자는 30~50(평균 40, 시간당 최대치 기준 메시지 약 0.5~1시간·통화방 약 1~1.7시간에 맞먹는
// 일회성 보상), 주최자는 그 1.3배(39~65, 평균 52)로 조금 더 얹어준다.
const MATCH_BONUS_XP_MIN = 30;
const MATCH_BONUS_XP_MAX = 50;
const ORGANIZER_XP_MULTIPLIER = 1.3;
function randomMatchBonusXp() {
  return Math.floor(Math.random() * (MATCH_BONUS_XP_MAX - MATCH_BONUS_XP_MIN + 1)) + MATCH_BONUS_XP_MIN;
}

// ── XP 런타임 스위치 ────────────────────────────────────────────
// 관리자가 /xp → "XP 관리"에서 토글한다. xp-state.json에 저장돼 재시작해도 유지된다
// (긴급정지는 봇이 재시작돼도 조용히 풀리면 안 되므로 반드시 디스크에 남긴다).
const XP_STATE_PATH = path.join(__dirname, '..', 'DB', 'xp-state.json');
const xpState = {
  farmFrozen: false,        // 일반 파밍(메시지·TTS·통화방 체류·내전/모집 완료 보너스) XP 지급 정지
  minigameFrozen: false,    // 미니게임(오목·룰렛·틱택토·끝말잇기·퀴즈) XP 정산 정지
  newbieBoostEnabled: true, // 뉴비부스트 역할 2배 적용 여부
  frozenUsers: {},          // { [guildId]: { [userId]: true } } — /xp에서 개별 유저 XP 지급 정지
};

function loadXpState() {
  try {
    if (fs.existsSync(XP_STATE_PATH)) {
      const saved = JSON.parse(fs.readFileSync(XP_STATE_PATH, 'utf8'));
      for (const k of Object.keys(xpState)) {
        if (typeof saved?.[k] === 'boolean') xpState[k] = saved[k];
      }
      // frozenUsers는 불리언이 아니라 객체라 위 루프로는 복원되지 않는다 — 따로 처리.
      if (saved?.frozenUsers && typeof saved.frozenUsers === 'object') {
        xpState.frozenUsers = saved.frozenUsers;
      }
    }
  } catch (err) {
    // 못 읽으면 기본값(전부 정상 작동)으로 시작한다 — 긴급정지가 안 걸린 쪽이 더 안전한 기본값.
    console.error('xp-state.json 읽기 실패(기본값으로 시작):', err);
  }
}

function saveXpState() {
  try {
    writeJsonIfChanged(XP_STATE_PATH, xpState);
  } catch (err) {
    console.error('xp-state.json 저장 실패:', err);
  }
}

function getXpState() {
  return { ...xpState };
}

// key: 'farmFrozen' | 'minigameFrozen' | 'newbieBoostEnabled'. 값을 바꿔 즉시 저장하고 갱신된 전체 상태를 반환.
function setXpSwitch(key, value) {
  if (key in xpState) {
    xpState[key] = !!value;
    saveXpState();
  }
  return getXpState();
}

// 특정 유저가 XP 지급 정지 대상인지. /xp → XP 조정에서 유저별로 켜고 끈다.
// farmFrozen/minigameFrozen(전체 정지)과 달리 이 유저 한 명에게만 적용된다.
function isUserXpFrozen(guildId, userId) {
  return !!xpState.frozenUsers[guildId]?.[userId];
}

// 유저별 XP 지급 정지를 켜고 끈다(즉시 저장). applyXp() 한 곳에서만 걸러내므로
// 메시지·통화방·내전완료·미니게임·퀴즈·룰렛 등 자동 지급 경로 전부에 적용되고,
// /xp의 ➕➖🔄(adjustXp/setXp)는 applyXp를 거치지 않아 정지 중에도 관리자가 수동 조정 가능하다.
function setUserXpFrozen(guildId, userId, frozen) {
  if (frozen) {
    if (!xpState.frozenUsers[guildId]) xpState.frozenUsers[guildId] = {};
    xpState.frozenUsers[guildId][userId] = true;
  } else if (xpState.frozenUsers[guildId]) {
    delete xpState.frozenUsers[guildId][userId];
    if (Object.keys(xpState.frozenUsers[guildId]).length === 0) delete xpState.frozenUsers[guildId];
  }
  saveXpState();
}

function isFarmXpFrozen() { return xpState.farmFrozen; }
function isMinigameXpFrozen() { return xpState.minigameFrozen; }
function isNewbieBoostEnabled() { return xpState.newbieBoostEnabled; }

// "뉴비부스트" 역할 보유자에게 곱해줄 배율. 메인/TTS 채널 메시지 XP와 통화방 체류 XP에만 적용하고,
// 미니게임(룰렛·끝말잇기·틱택토·오목·퀴즈)과 내전/모집 완료 보너스에는 적용하지 않는다.
const NEWBIE_BOOST_XP_MULTIPLIER = 2;

// 멤버가 뉴비부스트 역할을 가지고 있는지. 역할 ID가 비었거나·부스트가 꺼져 있거나·멤버 정보가 없으면 false.
function hasNewbieBoost(member) {
  if (!NEWBIE_BOOST_ROLE_ID || !xpState.newbieBoostEnabled) return false;
  return !!member?.roles?.cache?.has(NEWBIE_BOOST_ROLE_ID);
}

// 통화방(음성 채널) 체류 XP: 봇이 음성에 직접 참가하지 않고도
// voiceStateUpdate 게이트웨이 이벤트만으로 1분마다 활동 중인 유저에게 XP를 지급한다.
// 마이크만 켜놓으면 노력 없이 쌓이는 방치형 XP라 텍스트 채팅보다 낮은 배율을 사용.
// 배율이 낮아 매 틱 계산값이 1 미만일 때가 많은데, 그냥 반올림하면 소수점이 버려져
// 손실이 생기므로 남은 소수점을 다음 틱으로 이월(voiceXpCarry)해 손실 없이 누적한다.
// 기본치는 메시지(15~25, MEE6 기본값)와 똑같이 맞추고(통화방만 따로 어중간한 범위를 쓸
// 이유가 없다), 배율만 원래 값(0.02)으로 낮춰 방치형 XP답게 차등을 둔다
// (15~25 XP * 1분 * 0.02 = 시간당 평균 ~24 XP, 이월 덕분에 정확히 지급됨 —
// 메시지(시간당 40~80)의 약 1.67배 낮은 수준으로 균형).
const VOICE_XP_TICK_MINUTES = 1;
const VOICE_XP_TICK_MS = VOICE_XP_TICK_MINUTES * 60 * 1000;
const VOICE_XP_MULTIPLIER = 0.02;
const VOICE_XP_MIN = 15;
const VOICE_XP_MAX = 25;
function randomVoiceXp() {
  return Math.floor(Math.random() * (VOICE_XP_MAX - VOICE_XP_MIN + 1)) + VOICE_XP_MIN;
}

let levels = {}; // { [guildId]: { [userId]: xp } }
// loadLevels()가 아직 안 돌았으면 levels는 빈 객체다. 이 상태로 saveLevels()가 나가면
// 디스크의 levels.json을 통째로 비워버린다(모든 서버 XP 소실). 그래서 복원 완료 전에는
// 저장을 막고, /xp처럼 즉시 저장하는 경로는 isLevelsLoaded()로 미리 걸러낸다.
let loaded = false;
const cooldowns = new Map(); // `${guildId}:${userId}` → 마지막 XP 지급 시각
const voiceXpCarry = new Map(); // `${guildId}:${userId}` → 반올림 후 남은 소수점 이월분 (다음 틱에 더해짐)
const activeVoiceUsers = new Set(); // `${guildId}:${userId}` — 현재 음성 채널에서 음소거/헤드셋오프가 아닌 상태로 활동 중

function loadLevels() {
  try {
    if (fs.existsSync(LEVELS_PATH)) {
      levels = JSON.parse(fs.readFileSync(LEVELS_PATH, 'utf8'));
    }
    loaded = true; // 파일이 없어서 빈 채로 시작하는 것도 "복원 완료"로 본다
  } catch (err) {
    // 파일이 깨져 읽지 못한 경우. 여기서 loaded를 켜면 빈 levels가 '복원 완료'로 취급돼,
    // 다음 saveLevels() 한 번에 levels.json이 통째로 비워진다(전 서버 XP 영구 소실).
    // 그래서 loaded는 false로 남겨 저장 자체를 막는다 — 깨진 파일을 그대로 보존하는 편이
    // 빈 값으로 덮어쓰는 것보다 낫다(그동안 쌓인 XP는 저장되지 않는다).
    // 조용히 넘어가면 원인을 알 수 없으므로 콘솔과 파일 로그 양쪽에 남긴다.
    console.error('레벨 데이터 읽기 실패(XP 저장이 중지됨 — levels.json을 복구해야 함):', err);
    logSystem({ 유형: '저장 오류', 내용: `levels.json 읽기 실패 — 덮어쓰기 방지를 위해 XP 저장 중지됨(파일 복구 필요): ${err?.message ?? err}` });
    levels = {};
  }
}

function isLevelsLoaded() {
  return loaded;
}

function saveLevels() {
  if (!loaded) return; // 복원 전에는 저장하지 않는다 — 빈 메모리로 파일을 덮어써 전체가 날아간다
  writeJsonIfChanged(LEVELS_PATH, levels);
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

// XP를 더하고 레벨업 여부를 반환하는 공통 로직. 메시지·통화방·내전완료·미니게임·퀴즈·룰렛 등
// "자동" 지급 경로가 전부 이 함수를 거치므로, 여기서 한 번만 유저별 XP 지급 정지를 걸러낸다
// (관리자의 수동 조정인 adjustXp/setXp는 이 함수를 거치지 않아 정지 중에도 그대로 동작한다).
// 양수(지급)만 막고 음수(차감)는 그대로 통과시킨다 — 오목/틱택토/끝말잇기의 내기 정산은
// 패자에게 applyXp(-금액), 승자에게 applyXp(+금액)을 따로 호출하는데, 부호를 안 가리고
// 전부 막으면 정지된 패자가 내기에 져도 XP를 안 잃는 채로 승자만 그대로 받아가
// 제로섬이 깨지고 XP가 허공에서 생겨난다.
function applyXp(guildId, userId, amount) {
  if (amount > 0 && isUserXpFrozen(guildId, userId)) return { leveledUp: false };
  const guildLevels = getGuildLevels(guildId);
  const oldXp = guildLevels[userId] || 0;
  const oldLevel = levelFromXp(oldXp).level;
  const newXp = oldXp + amount;
  guildLevels[userId] = newXp;
  const newLevel = levelFromXp(newXp).level;

  if (newLevel > oldLevel) return { leveledUp: true, newLevel };
  return { leveledUp: false };
}

// 관리자가 /xp로 직접 XP를 가감할 때 쓴다. 음수로 빼도 최종 XP가 0 밑으로는 내려가지 않게
// 막는다(음수 XP는 levelFromXp/진행바 계산을 깨뜨린다). 적용 전후 값과 레벨 변화를 함께 돌려준다.
function adjustXp(guildId, userId, delta) {
  const guildLevels = getGuildLevels(guildId);
  const oldXp = guildLevels[userId] || 0;
  return writeXp(guildLevels, userId, oldXp, Math.max(0, oldXp + delta), delta);
}

// /xp의 "레벨 조정"용 — 누적 XP를 지정한 값으로 덮어쓴다(0 미만·소수점은 정리). 반환 모양은 adjustXp와 동일.
function setXp(guildId, userId, targetXp) {
  const guildLevels = getGuildLevels(guildId);
  const oldXp = guildLevels[userId] || 0;
  const newXp = Math.max(0, Math.floor(targetXp));
  return writeXp(guildLevels, userId, oldXp, newXp, newXp - oldXp);
}

function writeXp(guildLevels, userId, oldXp, newXp, requestedDelta) {
  const oldLevel = levelFromXp(oldXp).level;
  guildLevels[userId] = newXp;
  const newLevel = levelFromXp(newXp).level;
  return {
    oldXp,
    newXp,
    requestedDelta,
    appliedDelta: newXp - oldXp, // 0에서 잘렸으면 요청값과 다를 수 있음
    oldLevel,
    newLevel,
    leveledUp: newLevel > oldLevel,
    leveledDown: newLevel < oldLevel,
  };
}

// 레벨 L의 시작 지점(그 레벨에 갓 도달한 상태)의 누적 XP.
function xpForLevelStart(level) {
  let total = 0;
  for (let l = 0; l < level; l++) total += xpNeededForLevel(l);
  return total;
}

// 메시지 하나에 대해 쿨다운을 확인하고 XP를 지급. 레벨업 여부를 반환.
function handleMessageXp(message) {
  if (message.author.bot || !message.guild) return null;
  if (isFarmXpFrozen()) return null; // 관리자 긴급정지: 일반 파밍 XP 지급 중단
  const isMainChannel = message.channelId === XP_CHANNEL_ID;
  const isTtsChannel = XP_TTS_CHANNEL_IDS.includes(message.channelId);
  if (!isMainChannel && !isTtsChannel) return null;
  const guildId = message.guildId;
  if (isExcludedGuild(guildId)) return null;
  const userId = message.author.id;
  const key = `${guildId}:${userId}`;

  // TTS 채널은 음성 통화방과 짝지어 쓰이는 채널이라,
  // 음소거 없이 음성 틱 XP를 이미 받고 있는 유저에게는 텍스트 XP를 중복 지급하지 않는다.
  if (isTtsChannel && activeVoiceUsers.has(key)) return null;

  const now = Date.now();
  const last = cooldowns.get(key) || 0;
  if (now - last < COOLDOWN_MS) return null;
  cooldowns.set(key, now);

  const baseXp = randomMessageXp();
  const boost = hasNewbieBoost(message.member) ? NEWBIE_BOOST_XP_MULTIPLIER : 1;
  const gained = Math.round(baseXp * boost);
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
  if (!guildId || isExcludedGuild(guildId)) return [];
  if (isFarmXpFrozen()) return []; // 관리자 긴급정지: 완료 보너스도 일반 파밍으로 취급해 중단

  if (!match.xpAwardedUserIds) match.xpAwardedUserIds = {};

  const results = [];
  const organizerId = match.data?.organizer?.id;
  if (organizerId && !match.xpAwardedUserIds[organizerId]) {
    match.xpAwardedUserIds[organizerId] = true;
    const gained = Math.round(randomMatchBonusXp() * ORGANIZER_XP_MULTIPLIER);
    results.push({ userId: organizerId, ...applyXp(guildId, organizerId, gained) });
  }

  for (const participant of match.participants || []) {
    if (participant.id === organizerId) continue; // 주최자 중복 지급 방지
    if (match.xpAwardedUserIds[participant.id]) continue; // 이미 지급받음
    match.xpAwardedUserIds[participant.id] = true;
    const gained = randomMatchBonusXp();
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
  if (!guildId || isExcludedGuild(guildId)) return;
  const key = `${guildId}:${newState.id}`;
  if (isVoiceStateActive(newState)) {
    activeVoiceUsers.add(key);
  } else {
    activeVoiceUsers.delete(key);
    voiceXpCarry.delete(key); // 통화방을 나갔으면 이월분(1 XP 미만)은 버리고 맵도 비운다 — 무한 누적 방지
  }
}

// 봇 재시작 시 이미 음성 채널에 있던 유저들을 추적 대상에 다시 등록한다.
function initVoiceStates(client) {
  for (const guild of client.guilds.cache.values()) {
    if (isExcludedGuild(guild.id)) continue;
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

// 레벨업 축하 메시지를 놀이터(레벨업 안내) 채널에 보낸다. 메시지 XP·통화방 XP·내전/모집 완료
// 보너스·룰렛·끝말잇기·틱택토가 모두 이 함수를 공유한다(예전엔 각자 복붙한 사본이 흩어져 있었다).
// 안내 채널이 대상 길드에 속하지 않으면(다른 서버에서 레벨업) 보내지 않는다. 전송 실패는 무시.
async function announceLevelUp(client, guildId, userId, newLevel) {
  try {
    const channel = await client.channels.fetch(LEVEL_UP_ANNOUNCE_CHANNEL_ID).catch(() => null);
    if (channel?.guildId !== guildId) return;
    await channel.send({
      content: `<@${userId}>님이 ${newLevel}레벨을 달성했어요. 🎉`,
      allowedMentions: { users: [userId] },
    });
  } catch (err) {
    console.error('레벨업 축하 메시지 전송 실패:', err);
  }
}

// 지난 XP 지급 시각 맵(cooldowns)에서 쿨다운이 끝난 지 오래된 항목을 청소한다. 이 맵은
// 메시지를 보낸 적 있는 모든 유저가 영구히 쌓이므로, 1분 틱마다 쓸모없어진 항목을 비운다.
const COOLDOWN_STALE_MS = COOLDOWN_MS;
function sweepCooldowns(now = Date.now()) {
  for (const [key, last] of cooldowns) {
    if (now - last > COOLDOWN_STALE_MS) cooldowns.delete(key);
  }
}

// 1분마다 그 시점에 활동 중인 유저들에게 통화방 체류 XP를 지급한다.
// 레벨업한 유저는 레벨업 안내 채널에 축하 메시지를 보낸다.
function startVoiceXpTicker(client) {
  setInterval(async () => {
    sweepCooldowns();
    if (isFarmXpFrozen()) return; // 관리자 긴급정지: 통화방 체류 XP 지급 중단
    for (const key of activeVoiceUsers) {
      const [guildId, userId] = key.split(':');
      const guild = client.guilds.cache.get(guildId);
      const member = guild?.members.cache.get(userId)
        || await guild?.members.fetch(userId).catch(() => null);
      const boost = hasNewbieBoost(member) ? NEWBIE_BOOST_XP_MULTIPLIER : 1;
      const raw = randomVoiceXp() * VOICE_XP_TICK_MINUTES * VOICE_XP_MULTIPLIER * boost + (voiceXpCarry.get(key) || 0);
      const gained = Math.floor(raw);
      voiceXpCarry.set(key, raw - gained);
      if (gained <= 0) continue;
      const result = applyXp(guildId, userId, gained);
      if (!result.leveledUp) continue;
      await announceLevelUp(client, guildId, userId, result.newLevel);
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
  isLevelsLoaded,
  loadXpState,
  getXpState,
  setXpSwitch,
  isFarmXpFrozen,
  isMinigameXpFrozen,
  isNewbieBoostEnabled,
  isUserXpFrozen,
  setUserXpFrozen,
  handleMessageXp,
  awardMatchCompletionXp,
  applyXp,
  adjustXp,
  setXp,
  xpForLevelStart,
  trackVoiceStateUpdate,
  initVoiceStates,
  startVoiceXpTicker,
  announceLevelUp,
  levelFromXp,
  getXp,
  getLeaderboard,
  getLeaderboardSize,
  XP_CHANNEL_ID,
  LEVEL_UP_ANNOUNCE_CHANNEL_ID,
  MATCH_BONUS_CHANNEL_ID,
  EXCLUDED_GUILD_IDS,
  isExcludedGuild,
  buildProgressBar,
};

// 공용.js — 내전/모집/팀 핸들러가 공통으로 쓰는 상수·유틸·임베드 빌더
// 여러 파일에 흩어져 있던 동일 로직을 한 곳에 모아, 한쪽만 고치고
// 다른 쪽은 안 고쳐서 동작이 갈라지는 것을 방지합니다.

const fs = require('fs');
const path = require('path');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ContainerBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
} = require('discord.js');
const { awardMatchCompletionXp, announceLevelUp } = require('./레벨링');
const { KST_OFFSET_MS } = require('./시간');
const { ADMIN_IDS, STEAM_EMOJI_ID } = require('../config');

// 내전(naejeon)/모집(mojip) 두 시스템이 공유하는 게임 → 역할 이름 매핑.
// (역할 멘션 대상 채널이 있으면 해당 역할을 핑한다.)
const ROLE_NAMES = {
  lol: '롤', valorant: '발로란트', overwatch: '오버워치', pubg: '배그',
};

// client에 lazy 생성하는 Map을 돌려주는 공통 헬퍼. 예전엔 내전/모집/취소·삭제 예약마다
// 같은 "없으면 new Map()" 패턴이 파일마다 복붙돼 있었다.
function getClientMap(client, prop) {
  if (!client[prop]) client[prop] = new Map();
  return client[prop];
}

function getNaejeonMatches(client) {
  return getClientMap(client, 'naejeonMatches');
}

function getMojipMatches(client) {
  return getClientMap(client, 'mojipMatches');
}

function shuffleIntoTeams(participants) {
  const shuffled = [...participants];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const half = Math.ceil(shuffled.length / 2);
  return { team1: shuffled.slice(0, half), team2: shuffled.slice(half) };
}

// 직접 입력(custom)일 때는 제목에 게임 아이콘을 붙이지 않는다.
function titleHeader(game, gameInfo, title) {
  return game === 'custom' ? `## ${title}` : `## ${gameInfo.emoji}  ${title}`;
}

// DM을 보낼 수 없는 정상적인 상황(수신자가 DM 차단 / 봇과 공통 서버 없음)의 디스코드 에러 코드.
// 실패해도 봇 잘못이 아니므로 스택 트레이스 대신 한 줄 경고만 남긴다.
const DM_UNREACHABLE_CODES = new Set([50007, 50278]);

const AUTO_CLOSE_DELAY_MS = 8 * 60 * 60 * 1000;
const CANCELLED_DELETE_DELAY_MS = 3 * 60 * 60 * 1000;

function clearAutoEndTimer(match) {
  if (match._autoEndTimer) {
    clearTimeout(match._autoEndTimer);
    match._autoEndTimer = null;
  }
}

// "📣 참가자 멘션" 버튼으로 보낸 멘션 메시지를 삭제한다. 멘션을 보낸 적 없으면 아무것도 안 함.
// 이미 지워졌거나 채널 접근이 불가한 경우도 조용히 무시한다(본 임베드 삭제를 막으면 안 되므로).
async function deleteMentionMessage(client, match) {
  if (!match.mentionMessageId) return;
  try {
    const channel = client.channels.cache.get(match.message.channelId)
      || await client.channels.fetch(match.message.channelId).catch(() => null);
    const mentionMsg = channel && await channel.messages.fetch(match.mentionMessageId).catch(() => null);
    if (mentionMsg) await mentionMsg.delete();
  } catch (err) {
    console.error('멘션 메시지 자동 삭제 중 오류:', err);
  }
}

// 알림 예약 시각: "M/D HH:mm"(KST, 24시간제) 또는 "M/D 오전/오후 h:mm"(12시간제) 형식만 허용한다.
// 사람마다 제각각인 "일시" 자유 텍스트로는 setTimeout에 넘길 정확한 시각을 뽑아낼 수 없어서,
// 알림을 원하는 사람만 채우는 별도 필드에 이 두 고정 포맷만 강제한다 — 오전/오후를 붙이면
// 12시간제로, 안 붙이면 24시간제로 해석해 "저녁 8시"를 "8:00"으로 잘못 입력하는 실수를 줄인다.
const NOTIFY_TIME_REGEX = /^(\d{1,2})\/(\d{1,2})\s+(오전|오후)?\s*(\d{1,2}):(\d{2})$/;

// "M/D HH:mm" 또는 "M/D 오전/오후 h:mm"(KST) → epoch ms. 형식이 안 맞거나(시:분 범위 초과 포함)
// 존재하지 않는 날짜(예: 2/30)면 null. 연도 입력이 없으므로 올해 기준으로 계산하고,
// 이미 지난 시각이면 내년으로 보정한다.
function parseNotifyTime(input) {
  const m = NOTIFY_TIME_REGEX.exec((input || '').trim());
  if (!m) return null;
  const month = Number(m[1]), day = Number(m[2]);
  const period = m[3]; // '오전' | '오후' | undefined(24시간제)
  const minute = Number(m[5]);
  let hour = Number(m[4]);
  if (month < 1 || month > 12 || minute > 59) return null;

  if (period) {
    if (hour < 1 || hour > 12) return null;
    if (period === '오전') hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  } else if (hour > 23) {
    return null;
  }

  const nowKstYear = new Date(Date.now() + KST_OFFSET_MS).getUTCFullYear();
  const build = (year) => Date.UTC(year, month - 1, day, hour, minute) - KST_OFFSET_MS;

  let epoch = build(nowKstYear);
  if (epoch <= Date.now()) epoch = build(nowKstYear + 1);

  // 존재하지 않는 날짜(2/30 등)는 Date가 다음 달로 밀어버리므로, 되돌려서 월/일이 그대로인지 검증.
  const check = new Date(epoch + KST_OFFSET_MS);
  if (check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return null;

  return epoch;
}

// epoch ms → "M/D HH:mm"(KST). 모달 재입력 시 기존 값(파싱 가능한 24시간제 원본)을 채우는 용도.
function formatNotifyTime(epochMs) {
  const kst = new Date(epochMs + KST_OFFSET_MS);
  const hh = String(kst.getUTCHours()).padStart(2, '0');
  const mm = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${kst.getUTCMonth() + 1}/${kst.getUTCDate()} ${hh}:${mm}`;
}

// epoch ms → "M/D 오전/오후 h:mm"(KST). 24시간제 입력을 오전/오후로 병기해서, "저녁 8시"를 "8:00"으로
// 잘못 입력해도(오전 8시로 파싱됨) 버튼/확인 메시지에서 바로 눈에 띄게 보여주기 위한 표시 전용 포맷.
function formatNotifyTimeKorean(epochMs) {
  const kst = new Date(epochMs + KST_OFFSET_MS);
  const hour24 = kst.getUTCHours();
  const mm = String(kst.getUTCMinutes()).padStart(2, '0');
  const period = hour24 < 12 ? '오전' : '오후';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${kst.getUTCMonth() + 1}/${kst.getUTCDate()} ${period} ${hour12}:${mm}`;
}

// 입력 문자열이 12시간제(오전/오후 포함)였는지 판별한다. 이미 parseNotifyTime으로 형식 검증을
// 마친 뒤 호출되는 게 전제라 별도 유효성 검사 없이 오전/오후 포함 여부만 본다.
function isNotify12HourInput(input) {
  return /오전|오후/.test((input || '').trim());
}

// 주최자가 입력한 형식(24시간제/12시간제) 그대로 표시한다. notifyAt만 있고 is12h 정보가 없는
// 옛 데이터는 기존 기본값(12시간제)으로 표시한다.
function formatNotifyTimeSmart(epochMs, is12h) {
  return is12h ? formatNotifyTimeKorean(epochMs) : formatNotifyTime(epochMs);
}

// 알림 시각 입력 모달(내전/모집 공용). 비워서 제출하면 예약을 취소하는 용도로도 쓰인다.
// is12h를 넘기면 기존 예약을 수정할 때 원래 입력했던 형식 그대로 재입력창에 채워준다.
function buildNotifyModal(type, matchMsgId, notifyAt, is12h) {
  const input = new TextInputBuilder()
    .setCustomId('notify_time')
    .setLabel('알림 시각 (24시간제 또는 오전/오후)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('예: 6/5 20:00 또는 6/5 오후 8:00 · 비우면 알림 취소')
    .setRequired(false)
    .setMaxLength(20);
  if (notifyAt) input.setValue(formatNotifyTimeSmart(notifyAt, is12h));

  return new ModalBuilder()
    .setCustomId(`${type}:notify_modal:${matchMsgId}`)
    .setTitle('🔔 시작 시간 알림 예약')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function clearNotifyTimer(match) {
  if (match._notifyTimer) {
    clearTimeout(match._notifyTimer);
    match._notifyTimer = null;
  }
}

// setTimeout에 넘길 수 있는 지연시간의 사실상 한계(약 24.8일, 32비트 오버플로).
// 이보다 먼 시각은 예약하지 않는다(내전/모집 알림이 그렇게 먼 미래일 일은 없다고 가정).
const MAX_TIMEOUT_DELAY_MS = 2 ** 31 - 1;

// armNotifyReminder는 이 한계를 넘으면 타이머를 걸지 않고 조용히 아무 일도 안 하므로, 모달
// 제출 시점에 미리 걸러서 "예약했다"는 확인 메시지가 거짓말이 되는 상황을 막는다.
function isNotifyTooFar(notifyAt) {
  return notifyAt - Date.now() > MAX_TIMEOUT_DELAY_MS;
}

// notifyAt 시각에 마감(closed) 상태면 DM을 보내고 notifySent를 표시한다. 이미 보냈거나 아직
// 마감 전이면 아무것도 하지 않는다 — 마감 전이라 건너뛴 경우엔 나중에 markClosed가 호출될 때
// (그 시점에 이미 예약 시각이 지나 있으면) 다시 시도하므로, 여기서 놓쳐도 유실되지 않는다.
// armNotifyReminder의 타이머가 매치가 살아있는 동안(matchesMap에 남아 있는 동안)에만 이 함수를
// 호출하므로, 취소/종료/삭제된 매치는 자연히 발송 대상에서 빠진다(fire() 안 matchesMap.get(msgId)
// 조회 실패 시 조용히 건너뜀).
async function trySendNotify(match, label) {
  if (!match.data?.notifyAt || match.notifySent || !match.closed) return;
  if (match.data.notifyAt > Date.now()) return; // 예약 시각이 아직 안 지났으면 armNotifyReminder의 타이머가 그때 처리
  match.notifySent = true;
  await sendMatchStartDm(match, label);
}

// data.notifyAt(epoch ms) 시각에 trySendNotify를 시도한다. notifyAt이 그 사이 바뀌었거나
// 매치 자체가 취소/종료/삭제로 matchesMap에서 사라졌으면 옛 예약이므로 발송하지 않는다.
// 이미 지난 시각으로 예약(호출)되면 타이머 없이 바로 시도한다(마감 상태면 즉시 발송, 아니면
// 마감 시점까지 기다림).
function armNotifyReminder(matchesMap, msgId, match, label) {
  clearNotifyTimer(match);
  const notifyAt = match.data?.notifyAt;
  if (!notifyAt || match.notifySent) return;
  const delayMs = notifyAt - Date.now();
  if (delayMs > MAX_TIMEOUT_DELAY_MS) return;

  const fire = () => {
    match._notifyTimer = null;
    const current = matchesMap.get(msgId);
    if (!current || current.data?.notifyAt !== notifyAt) return;
    trySendNotify(current, label).catch(err => console.error('시작 시간 알림 DM 발송 중 오류:', err));
  };

  if (delayMs <= 0) {
    fire();
    return;
  }
  match._notifyTimer = setTimeout(fire, delayMs);
}

// 참가자 전원에게 시작 알림 DM을 보낸다(주최자는 제외, 중복 유저는 1회만). DM 차단 등 실패는 무시.
async function sendMatchStartDm(match, label) {
  const client = match.message?.client;
  if (!client) return;
  const organizerId = match.data?.organizer?.id;
  const recipients = match.participants.filter(u => u?.id && u.id !== organizerId);
  const seen = new Set();
  for (const user of recipients) {
    if (seen.has(user.id)) continue;
    seen.add(user.id);
    try {
      const target = await client.users.fetch(user.id);
      const container = new ContainerBuilder()
        .addTextDisplayComponents(td => td.setContent('# ⏰ 시작 알림'))
        .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
        .addTextDisplayComponents(td => td.setContent(`**${match.data.title}** ${label} 시작 시간이에요!\n\n지금 바로 확인해 보세요.`))
        .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
        .addTextDisplayComponents(td => td.setContent(`### 🔗 **바로가기**\n[__누르면 바로 이동됩니다.__](${match.message.url})`))
        .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
        .addTextDisplayComponents(td => td.setContent('-# 📬 예약된 알림 시각이 되어 참가자에게 자동으로 전송되었습니다.'));
      await target.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
    } catch {
      // DM 차단 등으로 실패해도 다른 수신자 발송에는 영향 없음
    }
  }
}

// 마감(closed)된 시점부터 delayMs(기본 8시간) 후 자동으로 메시지를 삭제한다.
// autoClose 옵션이 꺼져있으면 아무것도 하지 않는다. 봇 재시작 후 복원할 때는
// 이미 지난 시간만큼 뺀 delayMs를 넘겨 원래 마감 시각 기준을 유지한다.
function armAutoEnd(matchesMap, msgId, match, label, delayMs = AUTO_CLOSE_DELAY_MS) {
  clearAutoEndTimer(match);
  if (!match.data?.autoClose) return;
  match._autoEndTimer = setTimeout(async () => {
    match._autoEndTimer = null;
    const current = matchesMap.get(msgId);
    if (!current || !current.closed) return;
    try {
      clearNotifyTimer(current); // 삭제된 매치는 알림을 보내지 않으므로 남은 예약 타이머를 취소한다.
      await announceMatchCompletionXp(current);
      matchesMap.delete(msgId);
      await deleteMentionMessage(current.message.client, current);
      await current.message.delete();
    } catch (err) {
      console.error('자동 삭제 처리 중 오류:', err);
    }
  }, delayMs);
}

// 마감이 해제될 때 예약된 자동 종료 타이머를 취소한다.
function disarmAutoEnd(match) {
  clearAutoEndTimer(match);
  match.closedAt = null;
}

function getCancelledDeletions(client) {
  return getClientMap(client, 'cancelledDeletions');
}

// 취소된(🔴 취소됨) 임베드를 취소 시각(cancelledAt) 기준 3시간 후 자동 삭제한다.
// 취소는 마감(closed)과 달리 재개(마감 해제) 개념이 없는 종결 상태이므로,
// autoClose 토글과 무관하게 항상 예약한다. naejeonMatches/mojipMatches에는
// 이미 취소 시점에 매치가 제거되어 있어(활성 매치 관리 로직과 뒤섞이지 않도록)
// 별도의 client.cancelledDeletions에 채널/취소 시각만 기록해 추적한다.
// deleteAt이 아닌 cancelledAt을 원본으로 저장해두면, 지연시간(CANCELLED_DELETE_DELAY_MS)이
// 나중에 또 바뀌더라도 재시작 시 항상 최신 지연시간 기준으로 다시 계산된다.
function scheduleCancelledDelete(client, msgId, channelId, cancelledAt = Date.now()) {
  const map = getCancelledDeletions(client);
  const deleteAt = cancelledAt + CANCELLED_DELETE_DELAY_MS;
  map.set(msgId, { channelId, cancelledAt, deleteAt });
  const delayMs = Math.max(0, deleteAt - Date.now());
  setTimeout(async () => {
    if (!getCancelledDeletions(client).has(msgId)) return;
    getCancelledDeletions(client).delete(msgId);
    try {
      const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
      const message = channel && await channel.messages.fetch(msgId).catch(() => null);
      if (message) await message.delete();
    } catch (err) {
      console.error('취소된 임베드 자동 삭제 중 오류:', err);
    }
  }, delayMs);
}

function getPendingMessageDeletions(client) {
  return getClientMap(client, 'pendingMessageDeletions');
}

// 특정 채널에 올라온 일반 메시지(내전/모집과 무관한 유저 채팅 등)를 deleteAt(기본 8시간 후)
// 시점에 자동 삭제한다. scheduleCancelledDelete와 달리 내전/모집 매치 상태와는 전혀 무관하게,
// 순전히 "이 메시지를 이 시각에 지운다"만 기록·추적한다(client.pendingMessageDeletions).
function scheduleMessageDelete(client, msgId, channelId, deleteAt = Date.now() + AUTO_CLOSE_DELAY_MS) {
  const map = getPendingMessageDeletions(client);
  map.set(msgId, { channelId, deleteAt });
  const delayMs = Math.max(0, deleteAt - Date.now());
  setTimeout(async () => {
    if (!getPendingMessageDeletions(client).has(msgId)) return;
    getPendingMessageDeletions(client).delete(msgId);
    try {
      const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
      const message = channel && await channel.messages.fetch(msgId).catch(() => null);
      if (message) await message.delete();
    } catch (err) {
      console.error('메시지 자동 삭제 중 오류:', err);
    }
  }, delayMs);
}

// 마감 시 주최자에게 DM으로 알린다. 인원 초과/미달과 무관하게 markClosed를
// 거치는 모든 경로(정원 자동 마감, 주최자 수동 마감, 강제 추가로 인한 마감)에 공통 적용.
// DM 차단 등으로 실패해도 마감 처리 자체에는 영향을 주지 않는다.
async function notifyOrganizerOnClose(match, label) {
  const organizer = match?.data?.organizer;
  const client = match?.message?.client;
  if (!organizer?.id || !client) return;
  try {
    const user = await client.users.fetch(organizer.id);
    const { title } = match.data;
    const container = new ContainerBuilder()
      .addTextDisplayComponents(td => td.setContent('# 🔒 마감 알림'))
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
      .addTextDisplayComponents(td => td.setContent(`**${title}** 이(가) 방금 마감됐어요!\n\n지금 바로 확인해 보세요.`))
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
      .addTextDisplayComponents(td => td.setContent(`### 🔗 **바로가기**\n[__누르면 바로 이동됩니다.__](${match.message.url})`))
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
      .addTextDisplayComponents(td => td.setContent('-# 📬 자동 마감 처리되어 주최자에게 알림이 전송되었습니다.'));
    await user.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
  } catch (err) {
    // 상대가 DM을 막아뒀거나(50007) 봇과 공통 서버가 없는(50278) 경우는 흔히 있는 일이라
    // 스택 트레이스까지 남길 필요가 없다. 그 외의 예상 못 한 오류만 전체를 기록한다.
    if (DM_UNREACHABLE_CODES.has(err?.code)) {
      console.warn(`${label} 마감 DM 전송 생략(수신 불가): ${organizer.id}`);
    } else {
      console.error(`${label} 마감 DM 전송 실패:`, err);
    }
  }
}

// 마감(🔒 마감됨) 상태로 전환하면서 8시간 후 자동 삭제 타이머를 건다.
// notify=false를 넘기면 주최자 DM을 보내지 않는다 — 주최자 본인이 직접
// "마감하기" 버튼을 눌러 마감한 경우(이미 알고 있으므로 불필요)에 사용.
function markClosed(matchesMap, msgId, match, label, notify = true) {
  match.closed = true;
  match.closedAt = Date.now();
  armAutoEnd(matchesMap, msgId, match, label);
  if (notify) notifyOrganizerOnClose(match, label).catch(() => {});
  // 알림 예약 시각이 이미 지나 있는데(마감 전이라 건너뛰었던 경우) 지금 막 마감됐다면 바로 발송.
  // 아직 시각이 안 지났으면 armNotifyReminder로 걸어둔 타이머가 그때 가서 처리하므로 여기선 아무것도 안 함.
  trySendNotify(match, label).catch(err => console.error('시작 시간 알림 DM 발송 중 오류:', err));
}

// 마감 해제(🔓) 상태로 전환하면서 예약돼 있던 자동 종료 타이머를 취소한다.
function markReopened(match) {
  match.closed = false;
  disarmAutoEnd(match);
}

// 관리 메뉴의 "자동 삭제" 토글을 눌렀을 때 사용한다(마감 전/후 모두 호출 가능).
// 아직 마감 전이면 설정값만 바꿔두고 끝(마감 시 markClosed가 이 값을 보고 타이머를 건다).
// 이미 마감된 상태라면 markReopened와 달리 closedAt(원래 마감 시각)은 그대로 두고,
// 꺼져 있으면 타이머만 취소, 켜면 원래 마감 시각 기준 남은 시간으로 다시 예약한다
// (남은 시간이 이미 다 지났다면 즉시 삭제). autoClose가 꺼진 채로 마감된 매치는
// 애초에 타이머가 걸려있지 않으므로, 이 함수가 유일하게 마감 후 자동 삭제를 붙이는 경로다.
async function toggleAutoCloseWhileClosed(matchesMap, msgId, match, label, enabled) {
  match.data.autoClose = enabled;
  if (!match.closed) return;
  if (!enabled) {
    clearAutoEndTimer(match);
    return;
  }
  const remaining = match.closedAt ? AUTO_CLOSE_DELAY_MS - (Date.now() - match.closedAt) : AUTO_CLOSE_DELAY_MS;
  if (remaining <= 0) {
    clearAutoEndTimer(match);
    try {
      clearNotifyTimer(match); // 삭제된 매치는 알림을 보내지 않으므로 남은 예약 타이머를 취소한다.
      await announceMatchCompletionXp(match);
      matchesMap.delete(msgId);
      await deleteMentionMessage(match.message.client, match);
      await match.message.delete();
    } catch (err) {
      console.error('자동 삭제 처리 중 오류:', err);
    }
    return;
  }
  armAutoEnd(matchesMap, msgId, match, label, remaining);
}

// 내전/모집이 마감될 때마다 호출. 보너스 XP 지급 후 레벨업한 사람이 있으면 레벨업 안내 채널에 알린다.
async function announceMatchCompletionXp(match) {
  const leveledUp = awardMatchCompletionXp(match);
  if (leveledUp.length === 0) return;
  const client = match?.message?.client;
  if (!client) return;
  for (const { userId, newLevel } of leveledUp) {
    await announceLevelUp(client, match.guildId, userId, newLevel);
  }
}

function buildTeamResultEmbed(data, teams) {
  const { game, gameInfo, title, datetime, organizer } = data;
  const lines = [
    `🎮 **게임**　　${gameInfo.name}`,
    `📅 **일시**　　${datetime}`,
    `👑 **주최자**　**\`${organizer.displayName}\`**`,
    `📊 **상태**　　🔒 마감됨`,
  ];
  const embed = new EmbedBuilder()
    .setColor(gameInfo.color)
    .setDescription(`${titleHeader(game, gameInfo, title)} - 팀 배정\n${lines.join('\n')}`);
  return embed
    .addFields(
      {
        name: `🔵 팀 1 - ${teams.team1.length}명`,
        value: teams.team1.length > 0 ? `\`\`\`\n${teams.team1.map((u, i) => `${i + 1}. ${u.displayName}`).join('\n')}\n\`\`\`` : '없음',
        inline: true,
      },
      {
        name: `🔴 팀 2 - ${teams.team2.length}명`,
        value: teams.team2.length > 0 ? `\`\`\`\n${teams.team2.map((u, i) => `${i + 1}. ${u.displayName}`).join('\n')}\n\`\`\`` : '없음',
        inline: true,
      },
    )
    .setFooter({ text: '✅ 팀이 배정되었습니다.' })
    .setTimestamp();
}

// ─── 내전(naejeon) / 모집(mojip) 공통 빌더 ──────────────────────
// 두 시스템의 UI가 customId 접두사(type: 'naejeon' | 'mojip')와
// 라벨 문구(label: '내전' | '모집')만 다르고 로직은 완전히 동일한
// 부분만 여기로 모았다. 팀 배정/역할 멘션 유지처럼 실제 동작이
// 다른 부분(buildPublicEmbed 등)은 각 핸들러 파일에 그대로 둔다.

function buildPreviewEmbed({ game, gameInfo, title, datetime, players, description, organizer }) {
  const max = parseInt(players) || 0;

  const lines = [
    `🎮 **게임**　　${gameInfo.name}`,
    `📅 **일시**　　${datetime}`,
    `👑 **주최자**　**\`${organizer.displayName}\`**`,
    `📊 **상태**　　⏳ 게시 전`,
  ];

  const embed = new EmbedBuilder()
    .setColor(gameInfo.color)
    .setDescription(`${titleHeader(game, gameInfo, title)}\n${lines.join('\n')}`);

  if (description) embed.addFields({ name: '📝 메모', value: description });

  return embed
    .addFields({ name: `👥 참가자  0 / ${max}명`, value: '*아직 참가자가 없습니다.*' })
    .setFooter({ text: '🔎 게시하기 전에 내용을 다시 확인해 주세요.' })
    .setTimestamp();
}

function buildModal(type, label, GAMES, game, data = {}) {
  const gameInfo = GAMES[game];
  const isCustom = game === 'custom';

  const modal = new ModalBuilder()
    .setCustomId(`${type}:modal:${game}`)
    .setTitle(`${gameInfo.emoji} ${gameInfo.name} ${label} 생성`);

  const titleInput = new TextInputBuilder()
    .setCustomId('title')
    .setLabel('제목 (비워두면 기본값 사용)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(isCustom ? `${label} 제목을 입력하세요 (선택사항)` : `${gameInfo.name} ${label}`)
    .setRequired(false)
    .setMaxLength(50);

  const datetimeInput = new TextInputBuilder()
    .setCustomId('datetime')
    .setLabel('일시')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('예: 6월 5일 오후 8시')
    .setRequired(true)
    .setMaxLength(50);

  const playersInput = new TextInputBuilder()
    .setCustomId('players')
    .setLabel(type === 'naejeon' ? '모집 인원 (명)' : '모집 인원 (숫자만 입력)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('예: 10')
    .setRequired(true)
    .setMaxLength(10);

  const descInput = new TextInputBuilder()
    .setCustomId('description')
    .setLabel('메모 / 설명 (선택사항)')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('추가 안내사항이 있으면 입력하세요.')
    .setRequired(false)
    .setMaxLength(300);

  if (data.title)       titleInput.setValue(data.title);
  if (data.datetime)    datetimeInput.setValue(data.datetime);
  if (data.players)     playersInput.setValue(data.players);
  else if (gameInfo.defaultPlayers) playersInput.setValue(String(gameInfo.defaultPlayers));
  if (data.description) descInput.setValue(data.description);

  if (isCustom) {
    const gameNameInput = new TextInputBuilder()
      .setCustomId('game_name')
      .setLabel('게임 이름')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('예: 마인크래프트, 철권 8 ...')
      .setRequired(true)
      .setMaxLength(50);
    if (data.gameInfo && data.gameInfo.name !== '직접 입력') {
      gameNameInput.setValue(data.gameInfo.name);
    }
    modal.addComponents(
      new ActionRowBuilder().addComponents(gameNameInput),
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(datetimeInput),
      new ActionRowBuilder().addComponents(playersInput),
      new ActionRowBuilder().addComponents(descInput),
    );
  } else {
    modal.addComponents(
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(datetimeInput),
      new ActionRowBuilder().addComponents(playersInput),
      new ActionRowBuilder().addComponents(descInput),
    );
  }

  return modal;
}

function buildLeaveButton(type, msgId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${type}:leave:${msgId}`)
      .setLabel('❌ 참가 취소')
      .setStyle(ButtonStyle.Danger),
  );
}

function buildPreviewComponents(type, data = null) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${type}:publish`).setLabel('📢 채널에 공개 게시').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${type}:edit`).setLabel('✏️ 수정').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${type}:cancel`).setLabel('❌ 취소').setStyle(ButtonStyle.Danger),
  );
  const autoCloseToggle = new ButtonBuilder()
    .setCustomId(`${type}:toggle_autoclose`)
    .setEmoji('⏰')
    .setLabel(data && data.autoClose ? '자동 종료: ON' : '자동 종료: OFF')
    .setStyle(data && data.autoClose ? ButtonStyle.Success : ButtonStyle.Secondary);
  const notifyAt = data?.notifyAt;
  const notifyButton = new ButtonBuilder()
    .setCustomId(`${type}:notify_set_preview`)
    .setLabel(notifyAt ? `🔔 알림 예약: ${formatNotifyTimeSmart(notifyAt, data?.notify12h)}` : '🔔 알림 예약')
    .setStyle(notifyAt ? ButtonStyle.Success : ButtonStyle.Secondary);

  if (data && data.game === 'custom') {
    const steamToggle = new ButtonBuilder()
      .setCustomId(`${type}:toggle_steam`)
      .setEmoji({ id: STEAM_EMOJI_ID, name: 'Steam' })
      .setLabel(data.mentionSteam ? '멘션 ON' : '멘션 OFF')
      .setStyle(data.mentionSteam ? ButtonStyle.Success : ButtonStyle.Secondary);
    return [row1, new ActionRowBuilder().addComponents(autoCloseToggle, notifyButton, steamToggle)];
  }
  return [row1, new ActionRowBuilder().addComponents(autoCloseToggle, notifyButton)];
}

function buildCancelComponents(type) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${type}:cancel_confirm`).setLabel('✅ 확인').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${type}:cancel_back`).setLabel('↩️ 돌아가기').setStyle(ButtonStyle.Secondary),
  );
}

// ─── 내전/모집 매치 저장·복원 ────────────────────────────────────
// 내전(naejeon)/모집(mojip) 둘 다 저장 대상이라 어느 한쪽 파일(내전.js/모집.js)에도
// 속하지 않아 이 공용 파일에 둔다(예전엔 프로젝트 루트의 db.js였음). better-sqlite3
// 대신 Node.js 내장 fs를 사용해 별도 설치 없이 동작한다.

// 흩어져 있던 JSON 저장 파일들을 DB/ 폴더 하나로 모아둔다(다른 모듈들도 동일).
// 파일명 N-M.json은 이 파일이 담는 두 매치 타입, 내전(N)/모집(M)의 앞글자를 딴 것.
const DB_DIR  = path.join(__dirname, '..', 'DB');
const DB_PATH = path.join(DB_DIR, 'N-M.json');
const TMP_PATH = DB_PATH + '.tmp';

fs.mkdirSync(DB_DIR, { recursive: true });

// match 객체 안의 직렬화 불가 객체(Discord 객체)를 제거하고 JSON 문자열로 변환
function matchToJSON(match) {
  const { message, data, _autoEndTimer, _notifyTimer, ...rest } = match;
  const { _previewInteraction, ...cleanData } = data || {};
  return JSON.stringify({ ...rest, data: cleanData });
}

// 현재 메모리의 모든 내전/모집을 N-M.json에 저장
function saveAll(client) {
  const rows = [];
  const dump = (map, type) => {
    if (!map) return;
    for (const [messageId, match] of map) {
      if (!match.message) continue;
      rows.push({
        message_id: messageId,
        channel_id: match.message.channelId,
        type,
        data: matchToJSON(match),
      });
    }
  };
  dump(client.naejeonMatches, 'naejeon');
  dump(client.mojipMatches,   'mojip');
  if (client.cancelledDeletions) {
    for (const [messageId, entry] of client.cancelledDeletions) {
      rows.push({
        message_id: messageId,
        channel_id: entry.channelId,
        type: 'cancelled_delete',
        data: JSON.stringify({ cancelledAt: entry.cancelledAt }),
      });
    }
  }
  if (client.pendingMessageDeletions) {
    for (const [messageId, entry] of client.pendingMessageDeletions) {
      rows.push({
        message_id: messageId,
        channel_id: entry.channelId,
        type: 'pending_msg_delete',
        data: JSON.stringify({ deleteAt: entry.deleteAt }),
      });
    }
  }
  // 30초마다 파일 전체를 덮어쓰기 때문에, 쓰는 도중에 죽으면 N-M.json이 잘린 채 남아
  // 다음 재시작 때 loadRows()가 파싱에 실패(→ [] 반환)하며 전체 데이터가 날아간다.
  // 임시 파일에 먼저 다 쓰고 rename으로 교체해, 실패해도 기존 파일이 그대로 남게 한다.
  fs.writeFileSync(TMP_PATH, JSON.stringify(rows), 'utf8');
  fs.renameSync(TMP_PATH, DB_PATH);
}

// 저장된 모든 행을 읽어옴 (봇 시작 시 복원할 때 사용)
function loadRows() {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return [];
  }
}

module.exports = {
  ADMIN_IDS,
  AUTO_CLOSE_DELAY_MS,
  ROLE_NAMES,
  getClientMap,
  getNaejeonMatches,
  getMojipMatches,
  getCancelledDeletions,
  scheduleCancelledDelete,
  scheduleMessageDelete,
  deleteMentionMessage,
  shuffleIntoTeams,
  buildTeamResultEmbed,
  buildPreviewEmbed,
  buildModal,
  buildLeaveButton,
  buildPreviewComponents,
  buildCancelComponents,
  buildNotifyModal,
  titleHeader,
  armAutoEnd,
  disarmAutoEnd,
  markClosed,
  markReopened,
  toggleAutoCloseWhileClosed,
  announceMatchCompletionXp,
  parseNotifyTime,
  formatNotifyTime,
  formatNotifyTimeKorean,
  formatNotifyTimeSmart,
  isNotify12HourInput,
  armNotifyReminder,
  clearNotifyTimer,
  isNotifyTooFar,
  saveAll,
  loadRows,
};

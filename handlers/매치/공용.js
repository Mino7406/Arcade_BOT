// 공용.js — 내전/모집/팀 핸들러가 공통으로 쓰는 상수·유틸·임베드 빌더
// 여러 파일에 흩어져 있던 동일 로직을 한 곳에 모아, 한쪽만 고치고
// 다른 쪽은 안 고쳐서 동작이 갈라지는 것을 방지합니다.

const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { awardMatchCompletionXp, announceLevelUp } = require('../레벨/레벨링');
const { KST_OFFSET_MS } = require('../공통/시간');
const { ADMIN_IDS, STEAM_EMOJI_ID } = require('../../config');
const { logSystem, logError } = require('../공통/로그');
const { writeJsonIfChanged } = require('../공통/저장');
const { isDmEnabled } = require('./DM설정');
const { card, payload, text, messageText, footerSide, COLORS, clipLines, emojiUrl, customEmojiId } = require('../공통/카드');

// 내전(naejeon)/모집(mojip) 두 시스템이 공유하는 게임 → 역할 이름 매핑.
// (역할 멘션 대상 채널이 있으면 해당 역할을 핑한다.)
const ROLE_NAMES = {
  lol: '롤', valorant: '발로란트', overwatch: '오버워치', pubg: '배그',
  cobblemon: '마크', // 코블몬 토너먼트(내전 전용) 게시 시 @마크 역할을 핑한다.
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

// 모달 제목/입력 라벨은 순수 텍스트라 <:이름:id> 형태의 커스텀 이모지가 태그 그대로 노출된다.
// 커스텀 이모지 태그와 유니코드 이모지를 모두 걷어내 글자만 남긴다.
function stripEmoji(text) {
  return String(text)
    .replace(/<a?:\w+:\d+>/g, '')                       // <:이름:id> / <a:이름:id>
    .replace(/\p{Extended_Pictographic}/gu, '')            // 🎮 같은 유니코드 이모지
    .replace(/[\u200d\ufe0f\u20e3]/g, '')                  // ZWJ·이모지 변형 선택자·키캡 결합 문자
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// DM을 보낼 수 없는 정상적인 상황(수신자가 DM 차단 / 봇과 공통 서버 없음)의 디스코드 에러 코드.
// 실패해도 봇 잘못이 아니므로 스택 트레이스 대신 한 줄 경고만 남긴다.
const DM_UNREACHABLE_CODES = new Set([50007, 50278]);

// 위 두 코드를 사람이 읽을 수 있는 사유로 바꾼다. 콘솔·로그 양쪽에서 같은 문구를 쓴다.
const DM_FAIL_REASONS = {
  50007: 'DM 차단(개인정보 설정 또는 봇 차단)',
  50278: '공통 서버 없음(서버를 나감)',
};

// DM 발송 실패를 콘솔과 DB/log/(날짜별 로그)에 함께 남긴다. 콘솔은 봇이 꺼지면 사라지므로,
// "언제 · 누구한테 · 왜 실패했는지"를 나중에도 되짚을 수 있게 파일 로그에도 기록한다.
// 흔한 수신 불가(DM_UNREACHABLE_CODES)는 봇 잘못이 아니라 한 줄 경고, 그 외는 스택까지 남긴다.
function logDmFailure(err, { 종류, label, target, match }) {
  const 유저 = `${target?.displayName || '알 수 없는 유저'}(${target?.id})`;
  const 채널 = match?.message?.channel?.name ? `#${match.message.channel.name}` : '-';
  const 제목 = match?.data?.title ? ` — '${match.data.title}'` : '';
  if (DM_UNREACHABLE_CODES.has(err?.code)) {
    const 사유 = DM_FAIL_REASONS[err.code];
    console.warn(`${label} ${종류} DM 전송 생략(${사유}, ${err.code}): ${유저}`);
    logSystem({ 유형: 'DM 실패', 유저, 채널, 내용: `${label} ${종류} DM 미발송${제목} — ${사유}(${err.code})` });
  } else {
    console.error(`${label} ${종류} DM 전송 실패:`, err);
    logSystem({ 유형: 'DM 실패', 유저, 채널, 내용: `${label} ${종류} DM 발송 오류${제목} — ${err?.code ?? '알 수 없음'}: ${err?.message ?? err}` });
  }
}

// 로그 한 줄에서 어떤 내전/모집인지 알아보기 위한 표기: "내전 '제목'(메시지ID)"
function matchTag(match, label) {
  return `${label ?? '내전/모집'} '${match?.data?.title ?? '?'}'(${match?.message?.id ?? '?'})`;
}
function matchChannelName(match) {
  return match?.message?.channel?.name ? `#${match.message.channel.name}` : '-';
}

const AUTO_CLOSE_DELAY_MS = 6 * 60 * 60 * 1000;
const CANCELLED_DELETE_DELAY_MS = 2 * 60 * 60 * 1000;
const GENERAL_MESSAGE_DELETE_DELAY_MS = 1 * 60 * 60 * 1000;

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
    logError('자동 삭제 실패', `${matchTag(match)} 참가자 멘션 메시지 삭제 실패`, err, { 채널: matchChannelName(match) });
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

// ── 모달 일시 기본값 / 알림 자동 인식 ──────────────────────────────
// 생성 모달의 "일시"는 지금 시각("11/12 20:00")이 미리 채워져 있다. 이 형식(또는 "11월 12일 오후 8시"
// 같은 흔한 한글 표기)이면 알림 버튼을 눌렀을 때 일시를 그대로 알림 시각으로 인식한다.
function defaultDatetimeText(now = Date.now()) {
  return formatNotifyTime(now);
}

// 날짜(11/12 · 11월 12일 · 오늘/내일/모레) + 시간대 말(오전·오후·아침·낮·저녁·밤·새벽) + 시각(8시 · 8시 30분 · 8시 반 · 8:30)
const DATETIME_REGEX = /^(?:(\d{1,2})\s*(?:\/|월)\s*(\d{1,2})\s*일?|(오늘|내일|모레))?\s*(오전|오후|아침|낮|저녁|밤|새벽)?\s*(\d{1,2})\s*(시|:)\s*(?:(\d{1,2})\s*분?|(반))?$/;
const DAY_SHIFT = { 오늘: 0, 내일: 1, 모레: 2 };
const DAY_MS = 24 * 60 * 60 * 1000;

// 일시 글자 → epoch ms(KST). 못 읽거나 AM/PM 이 애매하면 null("8시"만 적으면 아침인지 저녁인지 알 수 없으므로 읽지 않는다).
// 연도가 없으므로 올해로 보되, 날짜를 적었는데 3시간 넘게 지났으면 내년으로 본다(모달을 연 직후 "지금 시각"이 몇 분
// 지나도 올해로 유지되게). 날짜 없이 시간대 말만 있으면(저녁 8시) 오늘, 이미 지났으면 내일로 본다.
function parseDatetimeText(input, now = Date.now()) {
  const m = DATETIME_REGEX.exec((input || '').trim());
  if (!m) return null;
  const hasDate = !!m[1] || !!m[3];
  const word = m[4];
  if (!hasDate && !word) return null;
  let hour = Number(m[5]);
  if (m[6] === ':' && m[7] === undefined) return null;
  const minute = m[8] ? 30 : Number(m[7] || 0);
  if (minute > 59) return null;
  let dayPlus = 0;
  if (word && hour <= 12) {
    if (hour < 1) return null;
    if (word === '오전' || word === '아침' || word === '새벽') hour = hour === 12 ? 0 : hour;
    else if (word === '낮') hour = hour === 12 ? 12 : hour + 12;
    else if (word === '밤') {
      if (hour === 12) { hour = 0; dayPlus = 1; } else if (hour >= 6) hour += 12;
    } else hour = hour === 12 ? 12 : hour + 12; // 오후·저녁
  } else if (hour > 23) {
    return null;
  } else if (!word && m[6] === '시' && hour <= 12) {
    return null;
  }

  const kstNow = new Date(now + KST_OFFSET_MS);
  const fromUtc = (y, mo, d) => Date.UTC(y, mo, d, hour, minute) - KST_OFFSET_MS;
  let epoch;
  if (m[1]) {
    const month = Number(m[1]), day = Number(m[2]);
    if (month < 1 || month > 12) return null;
    const year = kstNow.getUTCFullYear();
    epoch = fromUtc(year, month - 1, day) + dayPlus * DAY_MS;
    if (epoch < now - 3 * 60 * 60 * 1000) epoch = fromUtc(year + 1, month - 1, day) + dayPlus * DAY_MS;
    const check = new Date(epoch - dayPlus * DAY_MS + KST_OFFSET_MS);
    if (check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return null; // 2/30 같은 날짜
  } else {
    epoch = fromUtc(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate()) + (DAY_SHIFT[m[3]] ?? 0) * DAY_MS + dayPlus * DAY_MS;
    if (!m[3] && epoch < now - 3 * 60 * 60 * 1000) epoch += DAY_MS;
  }
  return epoch;
}

// 일시 글자에서 알림 시각을 뽑는다. 읽을 수 없거나 너무 먼 미래면 null.
// base 는 "그 일시를 적은 때"(data.createdAt): 연도·지난 시각 판단을 이 시각 기준으로 해서, 모달에 미리 채워진
// 지금 시각이 몇 시간 뒤 알림을 켜는 때에도 내년으로 넘어가지 않는다.
// 이미 지난 시각이면 알림 시각도 지난 채로 두고, 마감되는 순간 바로 DM 이 나간다(trySendNotify).
function deriveNotifyFromDatetime(datetime, { base } = {}) {
  const notifyAt = parseDatetimeText(datetime, base || Date.now());
  if (!notifyAt) return null;
  if (isNotifyTooFar(notifyAt)) return null;
  // 일시가 "지금"이거나 이미 지난 시각(모달에 미리 채워진 지금 시각을 그대로 둔 경우)이면 마감되는 순간 바로 보낸다.
  const notifyOnClose = notifyAt <= (base || Date.now()) + 2 * 60 * 1000;
  return { notifyAt, notify12h: isNotify12HourInput(datetime), notifyOnClose };
}

// 일시로 자동 설정된 알림(notifyAuto)이면, 일시가 바뀐 만큼 알림 시각도 따라 바꾼다. 못 읽게 되면 알림을 끈다.
function syncAutoNotify(data) {
  if (!data?.notifyAuto) return null;
  if (data.datetime === data.notifyAutoSrc) return null; // 일시가 그대로면(메모·인원만 고친 경우) 알림을 건드리지 않는다
  const auto = deriveNotifyFromDatetime(data.datetime, { base: data.createdAt });
  if (auto) { Object.assign(data, auto, { notifyAutoSrc: data.datetime }); return 'changed'; }
  Object.assign(data, { notifyAt: null, notify12h: false, notifyAuto: false, notifyAutoSrc: null, notifyOnClose: false });
  return 'off';
}

// 알림 시각 입력 모달(내전/모집 공용). 비워서 제출하면 예약을 취소하는 용도로도 쓰인다.
// is12h를 넘기면 기존 예약을 수정할 때 원래 입력했던 형식 그대로 재입력창에 채워준다.
function buildNotifyModal(type, matchMsgId, notifyAt, is12h, onClose = false) {
  const input = new TextInputBuilder()
    .setCustomId('notify_time')
    .setLabel('알림 시각 (24시간제 또는 오전/오후)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('예: 6/5 20:00 또는 6/5 오후 8:00 · 비우면 알림 취소')
    .setRequired(false)
    .setMaxLength(20);
  if (notifyAt && !onClose) input.setValue(formatNotifyTimeSmart(notifyAt, is12h)); // 마감 시 바로 보내는 알림은 비워 둔다(시각을 적으면 그 시각에 발송)

  return new ModalBuilder()
    .setCustomId(`${type}:notify_modal:${matchMsgId}`)
    .setTitle('🔔 시작 시간 알림 예약')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

// 카드·버튼에 보여 줄 알림 시점: 일시를 안 고치고 켠 알림(마감 때 바로 발송)은 시각 대신 "자동 발송".
function notifyWhenText(data) {
  return data?.notifyOnClose ? '자동 발송' : formatNotifyTimeSmart(data.notifyAt, data.notify12h);
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

// 알림 발송 규칙(참가자 전원에게 시작 알림 DM, 한 번만).
//  - 시각을 직접 정한 알림(notifyOnClose=false): 그 시각이 되면 마감 여부와 상관없이 그 시점의 참가자에게 보낸다.
//  - "마감 시 바로" 알림(notifyOnClose=true, 일시를 안 고치고 🔔를 누른 경우): 마감되는 순간 보낸다.
// 시각이 됐는데 매치가 이미 사라졌다면(취소·삭제) armNotifyReminder 의 fire() 가 조회에 실패해 보내지 않는다.
// markClosed 도 이 함수를 불러서, 마감 전이라 못 보낸 "마감 시 바로" 알림이 마감 순간에 나간다.
async function trySendNotify(match, label) {
  if (!match.data?.notifyAt || match.notifySent) return;
  if (match.data.notifyOnClose && !match.closed) return;
  if (match.data.notifyAt > Date.now()) return; // 예약 시각이 아직 안 됐으면 armNotifyReminder 의 타이머가 그때 처리
  match.notifySent = true;
  await sendMatchStartDm(match, label);
}

// data.notifyAt(epoch ms) 시각에 trySendNotify를 시도한다. notifyAt이 그 사이 바뀌었거나
// 매치 자체가 취소/종료/삭제로 matchesMap에서 사라졌으면 옛 예약이므로 발송하지 않는다.
// 이미 지난 시각으로 예약(호출)되면 타이머 없이 바로 시도한다("마감 시 바로" 알림은 마감 때까지 기다림).
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
    trySendNotify(current, label).catch(err => {
      console.error('시작 시간 알림 DM 발송 중 오류:', err);
      logError('매치 알림', `${matchTag(current, label)} 시작 알림 처리 중 오류`, err, { 채널: matchChannelName(current) });
    });
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
  // DM 알림을 꺼 둔 유저(🔔 DM 알림 설정)는 보내지 않는다.
  const recipients = match.participants.filter(u => u?.id && u.id !== organizerId && isDmEnabled(u.id));
  const seen = new Set();
  let sent = 0;
  let failed = 0;
  for (const user of recipients) {
    if (seen.has(user.id)) continue;
    seen.add(user.id);
    try {
      const target = await client.users.fetch(user.id);
      await target.send(buildMatchDmPayload({ kind: 'start', match, label }));
      sent++;
    } catch (err) {
      // DM 차단 등으로 실패해도 다른 수신자 발송에는 영향 없음 — 기록만 남기고 다음 사람으로 넘어간다.
      failed++;
      logDmFailure(err, { 종류: '시작 알림', label, target: user, match });
    }
  }
  // 개별 실패는 위에서 한 줄씩 남기므로, 여기서는 "알림이 실제로 나갔다"는 요약만 남긴다.
  logSystem({
    유형: '매치 알림',
    채널: matchChannelName(match),
    내용: `${matchTag(match, label)} 시작 알림 DM 발송 — 성공 ${sent}명${failed ? `, 실패 ${failed}명` : ''}`,
  });
}

// 마감(closed)된 시점부터 delayMs(기본 AUTO_CLOSE_DELAY_MS) 후 자동으로 메시지를 삭제한다.
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
      logSystem({ 유형: '자동 삭제', 채널: matchChannelName(current), 내용: `${matchTag(current, label)} 마감 후 자동 삭제` });
    } catch (err) {
      console.error('자동 삭제 처리 중 오류:', err);
      logError('자동 삭제 실패', `${matchTag(current, label)} 마감 후 자동 삭제 실패`, err, { 채널: matchChannelName(current) });
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

// 취소된(🔴 취소됨) 임베드를 취소 시각(cancelledAt) 기준 CANCELLED_DELETE_DELAY_MS 후 자동 삭제한다.
// 취소는 마감(closed)과 달리 재개(마감 해제) 개념이 없는 종결 상태이므로,
// autoClose 토글과 무관하게 항상 예약한다. naejeonMatches/mojipMatches에는
// 이미 취소 시점에 매치가 제거되어 있어(활성 매치 관리 로직과 뒤섞이지 않도록)
// 별도의 client.cancelledDeletions에 채널/취소 시각만 기록해 추적한다.
// deleteAt이 아닌 cancelledAt을 원본으로 저장해두면, 지연시간(CANCELLED_DELETE_DELAY_MS)이
// 나중에 또 바뀌더라도 재시작 시 항상 최신 지연시간 기준으로 다시 계산된다.
function scheduleCancelledDelete(client, msgId, channelId, cancelledAt = Date.now(), title = null) {
  const map = getCancelledDeletions(client);
  const deleteAt = cancelledAt + CANCELLED_DELETE_DELAY_MS;
  map.set(msgId, { channelId, cancelledAt, deleteAt, title });
  const delayMs = Math.max(0, deleteAt - Date.now());
  setTimeout(async () => {
    if (!getCancelledDeletions(client).has(msgId)) return;
    getCancelledDeletions(client).delete(msgId);
    try {
      const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
      const message = channel && await channel.messages.fetch(msgId).catch(() => null);
      if (message) {
        await message.delete();
        logSystem({ 유형: '자동 삭제', 채널: channel?.name ? `#${channel.name}` : '-', 내용: `취소된 '${title ?? '?'}'(${msgId}) 임베드 자동 삭제` });
      }
    } catch (err) {
      console.error('취소된 임베드 자동 삭제 중 오류:', err);
      logError('자동 삭제 실패', `취소된 '${title ?? '?'}'(${msgId}) 임베드 자동 삭제 실패`, err);
    }
  }, delayMs);
  saveNow(client);
}

// 저장 파일에서 빠진 취소 임베드(강제종료 직전 취소분, 자동 삭제 도중 실패분 등)를 메시지 기록에서
// 직접 찾아 삭제 예약을 다시 건다. 이렇게 하면 관리 메뉴 삭제 목록에도 다시 나타나고, 이미 지연시간이
// 지난 임베드는 바로 삭제된다. 취소 시각은 취소할 때 임베드에 찍어둔 타임스탬프를 쓴다.
// 내전/모집은 메시지가 많지 않은 채널에서만 올라오므로 채널당 최근 500개까지만 훑는다.
async function recoverCancelledEmbeds(client, channelIds) {
  const tracked = getCancelledDeletions(client);
  let recovered = 0;

  for (const channelId of channelIds) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) continue;

    let before;
    for (let page = 0; page < 5; page++) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
      if (!batch || batch.size === 0) break;

      for (const msg of batch.values()) {
        if (msg.author.id !== client.user.id || tracked.has(msg.id)) continue;
        const body = messageText(msg);
        if (!body.includes('🔴 취소됨')) continue;
        const cancelledAt = Date.parse(msg.embeds[0]?.timestamp) || msg.editedTimestamp || msg.createdTimestamp;
        const headLine = body.split('\n').find(l => /^#{1,2}\s/.test(l)) || '';
        const title = headLine.replace(/^#{1,2}\s+(<a?:\w+:\d+>\s+)?/, '');
        scheduleCancelledDelete(client, msg.id, msg.channelId, cancelledAt, title);
        recovered++;
      }

      const oldest = batch.last();
      if (batch.size < 100 || !oldest) break;
      before = oldest.id;
    }
  }
  if (recovered > 0) {
    console.log(`♻️  취소된 임베드 삭제 예약 복구: ${recovered}건`);
    logSystem({ 유형: '자동 삭제', 내용: `추적이 끊긴 취소 임베드 ${recovered}건 삭제 예약 복구 (봇 재시작 후)` });
  }
}

function getPendingMessageDeletions(client) {
  return getClientMap(client, 'pendingMessageDeletions');
}

// 특정 채널에 올라온 일반 메시지(내전/모집과 무관한 유저 채팅 등)를 deleteAt(기본
// GENERAL_MESSAGE_DELETE_DELAY_MS 후)에 자동 삭제한다. scheduleCancelledDelete와 달리
// 내전/모집 매치 상태와는 전혀 무관하게, 순전히 "이 메시지를 이 시각에 지운다"만
// 기록·추적한다(client.pendingMessageDeletions).
function scheduleMessageDelete(client, msgId, channelId, deleteAt = Date.now() + GENERAL_MESSAGE_DELETE_DELAY_MS) {
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
      logError('자동 삭제 실패', `인증 채널 일반 메시지(${msgId}) 자동 삭제 실패`, err);
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
  if (!isDmEnabled(organizer.id)) return; // DM 알림을 꺼 둔 주최자
  try {
    const user = await client.users.fetch(organizer.id);
    const { title } = match.data;
    await user.send(buildMatchDmPayload({ kind: 'close', match, label }));
  } catch (err) {
    // 상대가 DM을 막아뒀거나(50007) 봇과 공통 서버가 없는(50278) 경우는 흔히 있는 일이라
    // 스택 트레이스까지 남길 필요가 없다. 그 외의 예상 못 한 오류만 전체를 기록한다.
    logDmFailure(err, { 종류: '마감', label, target: organizer, match });
  }
}

// 마감(🔒 마감됨) 상태로 전환하면서 자동 삭제 타이머를 건다(AUTO_CLOSE_DELAY_MS 후).
// notify=false를 넘기면 주최자 DM을 보내지 않는다 — 주최자 본인이 직접
// "마감하기" 버튼을 눌러 마감한 경우(이미 알고 있으므로 불필요)에 사용.
function markClosed(matchesMap, msgId, match, label, notify = true) {
  match.closed = true;
  match.closedAt = Date.now();
  logSystem({
    유형: '매치 마감',
    채널: matchChannelName(match),
    내용: `${matchTag(match, label)} 마감 (참가자 ${match.participants?.length ?? '?'}명${match.data?.autoClose ? ', 자동 삭제 예약' : ''})`,
  });
  armAutoEnd(matchesMap, msgId, match, label);
  if (notify) notifyOrganizerOnClose(match, label).catch(() => {});
  // 알림 예약 시각이 이미 지나 있는데(마감 전이라 건너뛰었던 경우) 지금 막 마감됐다면 바로 발송.
  // 아직 시각이 안 지났으면 armNotifyReminder로 걸어둔 타이머가 그때 가서 처리하므로 여기선 아무것도 안 함.
  trySendNotify(match, label).catch(err => {
    console.error('시작 시간 알림 DM 발송 중 오류:', err);
    logError('매치 알림', `${matchTag(match, label)} 시작 알림 처리 중 오류`, err, { 채널: matchChannelName(match) });
  });
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
      logSystem({ 유형: '자동 삭제', 채널: matchChannelName(match), 내용: `${matchTag(match, label)} 마감 후 자동 삭제(자동 삭제 켠 시점에 이미 시간 경과)` });
    } catch (err) {
      console.error('자동 삭제 처리 중 오류:', err);
      logError('자동 삭제 실패', `${matchTag(match, label)} 마감 후 자동 삭제 실패`, err, { 채널: matchChannelName(match) });
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

// ─── 내전/모집 카드(컴포넌트 v2) ─────────────────────────────────
// 예전 EmbedBuilder 대신 카드(컨테이너) 한 장으로 그린다. 공개 게시·미리보기·취소·팀 결과가
// 같은 뼈대(제목 → 정보 → 메모 → 참가자 → 안내 문구 → 버튼)를 써서 어디서 봐도 같은 모양이다.
// label: '내전' | '모집'

// 게임 로고는 카드 오른쪽 위 썸네일로 보여 주므로 제목에는 이모지를 붙이지 않는다.
function gameHeader(game, gameInfo, title) {
  return title;
}

// 게임 이모지가 커스텀 이모지면 카드 오른쪽 위 작은 그림으로 쓴다(직접 입력은 그림 없음).
function gameThumb(gameInfo) {
  const id = customEmojiId(gameInfo?.emoji);
  return id ? emojiUrl(id) : undefined;
}

function numberedBlock(users) {
  const lines = users.map((u, i) => `${i + 1}. ${u.displayName}`);
  return `\`\`\`\n${clipLines(lines, 900)}\n\`\`\``;
}

function matchInfoBlock(data) {
  const { datetime, organizer, gameInfo } = data;
  const lines = [
    `🎮 **게임**　${gameInfo.name}`,
    `📅 **일시**　${datetime}`,
    `👑 **주최자**　**\`${organizer.displayName}\`**`,
  ];
  return lines.join('\n');
}

function matchMemoBlock(description) {
  return description ? `### 📝 메모\n${description}` : null;
}

function matchParticipantsBlock(participants, max) {
  const head = `### 👥 참가자　${participants.length} / ${max}명`;
  const body = participants.length > 0 ? numberedBlock(participants) : '*아직 참가자가 없습니다.*';
  return `${head}\n${body}`;
}

function teamBlock(icon, no, list) {
  return `### ${icon} 팀 ${no}　${list.length}명\n${list.length > 0 ? numberedBlock(list) : '없음'}`;
}

function matchTeamBlocks(participants, teams, { withUnassigned = true } = {}) {
  const assignedIds = new Set([...teams.team1.map(u => u.id), ...teams.team2.map(u => u.id)]);
  const unassigned = withUnassigned ? participants.filter(u => !assignedIds.has(u.id)) : [];
  return [
    unassigned.length > 0 ? `### 👤 미배정　${unassigned.length}명\n${numberedBlock(unassigned)}` : null,
    teamBlock('🔵', 1, teams.team1),
    teamBlock('🔴', 2, teams.team2),
  ];
}

// 공개 게시 카드. teams가 있으면 참가자 목록 대신 팀 구성을 보여 준다(내전 전용).
function buildMatchCard({ label, data, participants, closed = false, teams = null, rows = [] }) {
  const { game, gameInfo, title, players, description } = data;
  const max = parseInt(players) || 0;
  const isFull = participants.length >= max;
  // 정원이 차면 자동으로 마감되므로 상태는 둘뿐이다: 마감됨 / 모집 중. (마감을 해제해 정원이 찬 채 열려 있으면 모집 중에 표시만 덧붙인다)
  const statusText = closed ? '🔒 마감됨' : isFull ? '🟢 모집 중 (정원 가득)' : '🟢 모집 중';
  const color = closed ? COLORS.ok : gameInfo.color;
  return card({
    color,
    header: gameHeader(game, gameInfo, title),
    sub: [label, statusText],
    thumb: gameThumb(gameInfo),
    thumbAlt: gameInfo.name,
    blocks: [
      matchInfoBlock(data),
      matchMemoBlock(description),
      ...(teams ? matchTeamBlocks(participants, teams) : [matchParticipantsBlock(participants, max)]),
    ],
    footer: closed ? (isFull ? `👥 인원이 모두 모여 마감됐어요.` : `🔒 마감된 ${label}입니다.`) : isFull ? '👥 정원이 가득 찼어요.' : '✅ 버튼을 눌러 참가하세요!',
    ...footerSide(rows, /:manage$/), // ⚙️ 관리는 안내 줄 오른쪽으로, 참가하기는 아래 줄에 단독
  });
}

// 게시 전 미리보기(작성자에게만 보이는 임시 메시지). 버튼 줄은 카드 안에 넣는다.
function buildPreviewCard({ data, rows = [] }) {
  const { game, gameInfo, title, players, description } = data;
  const max = parseInt(players) || 0;
  return card({
    color: gameInfo.color,
    header: gameHeader(game, gameInfo, title),
    sub: ['미리보기', '⏳ 게시 전'],
    thumb: gameThumb(gameInfo),
    thumbAlt: gameInfo.name,
    blocks: [
      matchInfoBlock(data),
      matchMemoBlock(description),
      matchParticipantsBlock([], max),
    ],
    footer: '🔎 게시하기 전에 내용을 다시 확인해 주세요. 이 내용이 채널에 게시됩니다.',
    rows,
  });
}

// 취소된 내전/모집 카드. "🔴 취소됨" 문구는 recoverCancelledEmbeds가 찾는 표식이다.
function buildCancelledCard({ label, data, byOrganizer }) {
  const { game, gameInfo, title } = data;
  return card({
    color: COLORS.err,
    header: gameHeader(game, gameInfo, title),
    sub: [label, '🔴 취소됨'],
    thumb: gameThumb(gameInfo),
    thumbAlt: gameInfo.name,
    blocks: [matchInfoBlock(data)],
    footer: byOrganizer ? `❌ 주최자에 의해 ${label}이 취소되었습니다.` : `⚙️ 관리자에 의해 ${label}이 취소 처리되었습니다.`,
  });
}

// 참가자·주최자에게 DM으로 가는 알림 카드. 게임 색 띠 + 게임 아이콘 + 바로가기 링크 버튼(줄 오른쪽).
// kind: 'start'(예약한 시작 알림, 참가자에게) | 'close'(마감 알림, 주최자에게)
function buildMatchDmPayload({ kind, match, label }) {
  const { gameInfo, title } = match.data;
  const isStart = kind === 'start';
  const link = new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(match.message.url).setLabel('바로가기').setEmoji('🔗');
  return payload(card({
    color: gameInfo.color,
    header: isStart ? '⏰ 시작 알림' : '🔒 마감 알림',
    sub: [label, title],
    thumb: gameThumb(gameInfo),
    thumbAlt: gameInfo.name,
    blocks: [
      isStart ? `**${title}** ${label} 시작 시간이에요!\n지금 바로 확인해 보세요.` : `**${title}** 이(가) 방금 마감됐어요!\n지금 바로 확인해 보세요.`,
      { text: '### 🔗 바로가기\n누르면 해당 게시글로 이동해요.', button: link },
    ],
    footer: isStart ? '📬 예약된 알림 시각이 되어 참가자에게 자동으로 전송되었습니다.' : '📬 자동 마감 처리되어 주최자에게 알림이 전송되었습니다.',
  }));
}

// 팀이 배정됐다고 채널에 알리는 카드(내전).
function buildTeamResultCard(data, teams) {
  const { game, gameInfo, title } = data;
  return card({
    color: gameInfo.color,
    header: gameHeader(game, gameInfo, title),
    sub: ['내전', '⚔️ 팀 배정'],
    thumb: gameThumb(gameInfo),
    thumbAlt: gameInfo.name,
    blocks: [
      matchInfoBlock(data),
      ...matchTeamBlocks([], teams, { withUnassigned: false }),
    ],
    footer: '✅ 팀이 배정되었습니다.',
  });
}

// ─── 내전(naejeon) / 모집(mojip) 공통 빌더 ──────────────────────
// 두 시스템의 UI가 customId 접두사(type: 'naejeon' | 'mojip')와
// 라벨 문구(label: '내전' | '모집')만 다르고 로직은 완전히 동일한
// 부분만 여기로 모았다. 팀 배정/역할 멘션 유지처럼 실제 동작이
// 다른 부분(buildPublicEmbed 등)은 각 핸들러 파일에 그대로 둔다.

function buildModal(type, label, GAMES, game, data = {}) {
  const gameInfo = GAMES[game];
  const isCustom = game === 'custom';

  const modal = new ModalBuilder()
    .setCustomId(`${type}:modal:${game}`)
    .setTitle(stripEmoji(`${gameInfo.emoji} ${gameInfo.name} ${label} 생성`));

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
    .setPlaceholder('예: 11/12 20:00 또는 11월 12일 오후 8시')
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
  datetimeInput.setValue(data.datetime || defaultDatetimeText()); // 처음 열면 지금 시각이 미리 채워진다
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
    .setLabel(data && data.autoClose ? '자동 삭제: ON' : '자동 삭제: OFF')
    .setStyle(data && data.autoClose ? ButtonStyle.Success : ButtonStyle.Secondary);
  const notifyAt = data?.notifyAt;
  const notifyButton = new ButtonBuilder()
    .setCustomId(`${type}:notify_set_preview`)
    .setLabel(notifyAt ? `🔔 알림 예약: ${notifyWhenText(data)}` : '🔔 알림 예약')
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

// 미리보기 메시지 전체(카드 + 버튼 줄)를 한 번에 만든다. 작성자에게만 보이는 임시 메시지(ephemeral)로 쓴다.
function buildPreviewPayload(type, data, extra = {}) {
  return payload(buildPreviewCard({ data, rows: buildPreviewComponents(type, data) }), extra);
}

// 공개 게시 메시지(카드 + 필요하면 역할 멘션 줄). v2는 content를 못 쓰므로 멘션은 카드 위 글자로 올린다.
function buildMatchMessagePayload({ label, match, rows }) {
  const cardMsg = buildMatchCard({ label, data: match.data, participants: match.participants, closed: match.closed, teams: match.teams, rows });
  const components = match.roleContent ? [text(match.roleContent), cardMsg] : [cardMsg];
  return payload(components, { allowedMentions: { parse: [] } });
}

// 주최자 관리 메뉴(나만 보이는 임시 메시지). 게임 색 띠 + 제목/상태 + 방금 한 조작 결과 + 버튼.
// 중요한 버튼은 따로 뺀다: 마감하기/마감 해제는 상태 줄 오른쪽, 취소는 맨 아래 위험 줄 오른쪽.
// 나머지 버튼은 가운데 버튼 줄에 그대로 둔다.
function buildManagePayload({ label, match, note, rows, ephemeral }) {
  const { gameInfo, title, players } = match.data;
  const max = parseInt(players) || 0;
  const isFull = match.participants.length >= max;
  const status = match.closed ? '🔒 마감됨' : isFull ? '🟢 모집 중 (정원 가득)' : '🟢 모집 중';

  const pulled = { toggle: null, cancel: null };
  const restRows = [];
  for (const row of [].concat(rows || [])) {
    const keep = [];
    for (const btn of row.components) {
      const id = btn.data?.custom_id || '';
      if (/:match_(close|reopen):/.test(id)) pulled.toggle = btn;
      else if (/:match_cancel:/.test(id)) pulled.cancel = btn;
      else keep.push(btn);
    }
    if (keep.length > 0) restRows.push(new ActionRowBuilder().addComponents(...keep));
  }

  return payload(card({
    color: gameInfo.color,
    header: '⚙️ 주최자 관리 메뉴',
    sub: [`${label} · ${title}`],
    thumb: gameThumb(gameInfo),
    thumbAlt: gameInfo.name,
    blocks: [
      note || null,
      { text: `**${label} 상태**　${status}\n-# 참가 ${match.participants.length} / ${max}명`, ...(pulled.toggle ? { button: pulled.toggle } : {}) },
      { rows: restRows },
      pulled.cancel ? { text: `**${label} 취소**\n-# 취소하면 게시글이 취소 처리돼요`, button: pulled.cancel } : null,
    ],
  }), { ephemeral });
}

// 참가자 전원을 부르는 공개 안내(수동 멘션 버튼). v2 글자 속 멘션은 allowedMentions 로 알림이 간다.
function buildMentionPayload({ title, mentionText, headline, tail }) {
  return payload(card({
    color: COLORS.info,
    header: headline ?? `📣 ${title}`,
    blocks: [mentionText, tail || null],
  }), { allowedMentions: { parse: ['users'] } });
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
const DB_DIR  = path.join(__dirname, '..', '..', 'DB');
const DB_PATH = path.join(DB_DIR, 'N-M.json');

fs.mkdirSync(DB_DIR, { recursive: true });

// match 객체 안의 직렬화 불가 객체(Discord 객체)를 제거하고 JSON 문자열로 변환
function matchToJSON(match) {
  const { message, data, _autoEndTimer, _notifyTimer, ...rest } = match;
  return JSON.stringify({ ...rest, data: data || {} });
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
        data: JSON.stringify({ cancelledAt: entry.cancelledAt, title: entry.title }),
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
  // 임시 파일 교체(원자적 쓰기)와 "직전 저장과 같으면 건너뛰기"는 저장.js가 함께 처리한다.
  writeJsonIfChanged(DB_PATH, rows);
}

// 복원이 끝나기 전에 저장하면 아직 못 불러온 매치가 파일에서 지워지므로, index.js가 복원을 마친 뒤
// enableSaveNow()를 호출해야 saveNow가 실제로 저장한다.
let saveNowEnabled = false;
function enableSaveNow() {
  saveNowEnabled = true;
}

// 30초 자동 저장을 기다리면 안 되는 변경(게시/재게시/취소) 직후 바로 저장한다. 그 사이 강제종료되면
// 임베드만 채널에 남고 파일에는 기록이 없어 관리 메뉴에도 안 뜨고 자동 삭제도 되지 않는다.
function saveNow(client) {
  if (!saveNowEnabled) return;
  try {
    saveAll(client);
  } catch (err) {
    console.error('즉시 저장 실패:', err);
    logError('저장 오류', '내전/모집 즉시 저장 실패', err);
  }
}

// 저장된 모든 행을 읽어옴 (봇 시작 시 복원할 때 사용)
function loadRows() {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (err) {
    // 진행 중이던 내전/모집이 전부 복원되지 않은 채 시작된다(메시지는 남아있지만 버튼이 죽음).
    console.error('내전/모집 저장 파일 읽기 실패(복원 없이 시작):', err);
    logSystem({ 유형: '저장 오류', 내용: `내전/모집 저장 파일 읽기 실패 — 진행 중이던 매치가 복원되지 않음: ${err?.message ?? err}` });
    return [];
  }
}

module.exports = {
  ADMIN_IDS,
  AUTO_CLOSE_DELAY_MS,
  CANCELLED_DELETE_DELAY_MS,
  GENERAL_MESSAGE_DELETE_DELAY_MS,
  ROLE_NAMES,
  getClientMap,
  getNaejeonMatches,
  getMojipMatches,
  getCancelledDeletions,
  scheduleCancelledDelete,
  recoverCancelledEmbeds,
  scheduleMessageDelete,
  deleteMentionMessage,
  shuffleIntoTeams,
  buildMatchCard,
  buildPreviewCard,
  buildPreviewPayload,
  buildMatchDmPayload,
  buildManagePayload,
  buildMentionPayload,
  buildMatchMessagePayload,
  buildCancelledCard,
  buildTeamResultCard,
  gameHeader,
  buildModal,
  buildLeaveButton,
  buildPreviewComponents,
  buildCancelComponents,
  buildNotifyModal,
  stripEmoji,
  armAutoEnd,
  disarmAutoEnd,
  markClosed,
  markReopened,
  toggleAutoCloseWhileClosed,
  announceMatchCompletionXp,
  parseNotifyTime,
  defaultDatetimeText,
  parseDatetimeText,
  deriveNotifyFromDatetime,
  notifyWhenText,
  syncAutoNotify,
  formatNotifyTime,
  formatNotifyTimeKorean,
  formatNotifyTimeSmart,
  isNotify12HourInput,
  armNotifyReminder,
  clearNotifyTimer,
  isNotifyTooFar,
  saveAll,
  saveNow,
  enableSaveNow,
  loadRows,
};

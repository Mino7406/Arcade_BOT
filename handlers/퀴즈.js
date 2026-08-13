// 퀴즈.js — 놀이터 채널에 하루 한 번, 초성퀴즈/상식퀴즈를 번갈아가며 자동 출제한다.
// 문제는 하드코딩된 목록이 아니라 국립국어원 한국어기초사전 API(끝말잇기와 동일 API)에서
// 그때그때 무작위로 가져오므로, 오래 운영해도 문제가 고정/반복되지 않는다.
// - 초성퀴즈: 초성 + 뜻풀이 힌트를 보여줌 (쉬운 난이도 위주)
// - 상식퀴즈: 초성 없이 뜻풀이만 보여줌 (어려운 난이도 위주)
// 제한시간은 따로 없고, 다음 문제가 출제될 때까지 계속 열려있다. 다음 날 새 문제가 나갈 때
// 그 전날 문제를 아직 아무도 못 맞혔다면 그 문제는 그대로 무효 처리(보상 없이 마감)한다 —
// 그래야 두 문제가 동시에 유효해서 생기는 중복/혼선을 막을 수 있다.
// API를 못 쓰는 경우(키 없음/장애)에만 아주 작은 비상용 목록으로 대체한다.

const { EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { applyXp, EXCLUDED_GUILD_IDS } = require('./레벨');

const QUIZ_CHANNEL_ID = '1522174367075663872'; // 놀이터 채널 (index.js의 WORDCHAIN_RANKING_CHANNEL_ID와 동일)
// KST 기준 출제 가능 시간대: 낮 12시 ~ 다음날 새벽 5시(=29시). 유저들이 새벽 시간대에 몰려있는
// 경우가 많아 자정을 넘겨서까지 출제되도록 잡음. 이 시각(다음날 05:00) 넘어서까지 봇이 안 켜져
// 있었다면 그날 사이클은 건너뜀.
const WINDOW_START_HOUR = 12;
const WINDOW_END_HOUR = 29;
// WINDOW_END_HOUR이 24시를 넘기므로(자정 이후로 이어짐), 자정~이 컷오프 사이는 아직 "전날
// 사이클"이 진행 중인 것으로 취급해야 한다(그래야 새벽에 하트비트가 돌 때 아직 안 끝난 어제
// 예약이 오늘 걸로 잘못 리셋되지 않음) — cycleDateString()에서 사용.
const OVERNIGHT_CUTOFF_HOUR = WINDOW_END_HOUR > 24 ? WINDOW_END_HOUR - 24 : 0;
const RECENT_WORD_MEMORY = 30; // 최근 이만큼은(초성/상식 합쳐서) 다시 출제하지 않음
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const STATE_PATH = path.join(__dirname, '..', '퀴즈.json');

const CHOSUNG = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const KOREAN_ONLY = /^[가-힣]+$/;

// 단어를 검색할 때 사용할 시작 음절 시드(끝말잇기 봇 단어 선택과 같은 방식) — 매번 이 중 일부를 무작위로 골라 검색한다.
const SEED_SYLLABLES = [
  '가', '나', '다', '라', '마', '바', '사', '아', '자', '차', '카', '타', '파', '하',
  '거', '너', '더', '러', '머', '버', '서', '어', '저', '처', '커', '터', '퍼', '허',
  '고', '노', '도', '로', '모', '보', '소', '오', '조', '초', '코', '토', '포', '호',
];

// API를 아예 못 쓸 때만 쓰는 최소한의 비상용 목록(다양성의 주 출처가 아님).
const FALLBACK_WORDS = [
  ['사과', '빨갛고 동그란 과일'],
  ['바나나', '노랗고 길쭉한 과일'],
  ['컴퓨터', '문서 작업이나 게임을 할 때 쓰는 전자기기'],
  ['고양이', '야옹 하고 우는 반려동물'],
  ['우산', '비 올 때 머리 위에 쓰는 물건'],
  ['냉장고', '음식을 차갑게 보관하는 가전제품'],
  ['도서관', '책을 빌리거나 읽을 수 있는 공공시설'],
  ['자전거', '두 바퀴로 페달을 밟아 타는 탈것'],
  ['피아노', '건반을 눌러 소리를 내는 악기'],
  ['운동화', '걷거나 뛸 때 신는 신발'],
];

// 두 모드가 XP뿐 아니라 단어 난이도도 똑같이 뽑히게 통일한다 — 상식퀴즈는 초성 힌트가
// 없다는 것만으로 이미 체감 난이도가 더 높다. 고급 단어도 후보에 포함해 난이도를 올린다.
const GRADE_PREFERENCE = ['초급', '중급', '고급'];

// 보상은 고정값이 아니라 매 문제마다 100~300 XP 사이에서 무작위로 정해진다(정답자에게는
// 실제로 지급된 금액을 채팅에 그대로 알려줌 — handleQuizMessage 참고).
const XP_REWARD_MIN = 100;
const XP_REWARD_MAX = 300;
function rollXpReward() {
  return XP_REWARD_MIN + Math.floor(Math.random() * (XP_REWARD_MAX - XP_REWARD_MIN + 1));
}

const MODES = {
  chosung: {
    label: '초성퀴즈',
    title: '📖 오늘의 퀴즈!',
    gradePreference: GRADE_PREFERENCE,
    buildEmbed({ word, hint }) {
      return new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle(this.title)
        .setDescription(
          `초성 : \`${getChosung(word)}\`\n` +
          `> ${hint}`,
        )
        .setFooter({ text: '✏️ 채팅으로 정답을 입력하면 자동으로 채점됩니다.' })
        .setTimestamp();
    },
  },
  sangsik: {
    label: '상식퀴즈',
    title: '📖 오늘의 퀴즈!',
    gradePreference: GRADE_PREFERENCE,
    buildEmbed({ word, hint }) {
      return new EmbedBuilder()
        .setColor(0xEB459E)
        .setTitle(this.title)
        .setDescription(
          `다음 뜻풀이에 해당하는 단어는? -# (${word.length}글자)\n` +
          `> ${hint}`,
        )
        .setFooter({ text: '✏️ 채팅으로 정답을 입력하면 자동으로 채점됩니다.' })
        .setTimestamp();
    },
  },
};

function getChosung(word) {
  return [...word].map(ch => {
    const code = ch.charCodeAt(0) - 0xAC00;
    if (code < 0 || code > 11171) return ch;
    return CHOSUNG[Math.floor(code / 588)];
  }).join('');
}

// 순수 달력 날짜가 아니라 "이 시각이 어느 출제 사이클에 속하는지"를 반환한다. 출제 가능
// 시간대가 자정을 넘겨 다음날 새벽까지 이어지므로, 자정~OVERNIGHT_CUTOFF_HOUR 사이는
// 아직 전날 사이클로 취급한다(예: 새벽 2시는 어제 낮 12시에 시작된 사이클의 연장).
function cycleDateString(epochMs = Date.now()) {
  const kst = new Date(epochMs + KST_OFFSET_MS);
  if (kst.getUTCHours() < OVERNIGHT_CUTOFF_HOUR) kst.setUTCDate(kst.getUTCDate() - 1);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`;
}

// 주어진 사이클 날짜(dayStr, cycleDateString이 반환하는 형식)의 출제 가능 시간대 시작/끝을
// epoch ms로 반환. WINDOW_END_HOUR이 24를 넘으므로 end는 자동으로 다음날 시각이 된다.
function windowBoundsForDay(dayStr) {
  const [y, m, d] = dayStr.split('-').map(Number);
  const start = Date.UTC(y, m - 1, d, WINDOW_START_HOUR, 0, 0) - KST_OFFSET_MS;
  const end = Date.UTC(y, m - 1, d, WINDOW_END_HOUR, 0, 0) - KST_OFFSET_MS;
  return { start, end };
}

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch { /* 무시하고 새 상태로 시작 */ }
  return null;
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state), 'utf8');
}

// ── 한국어기초사전 API에서 문제 후보 조회 ───────────────────────────
async function fetchCandidates(prefix) {
  const apiKey = process.env.KRDICT_API_KEY;
  if (!apiKey) return [];

  try {
    const url = `https://krdict.korean.go.kr/api/search?key=${apiKey}&q=${encodeURIComponent(prefix)}&method=start&pos=1&num=100&sort=popular&part=word&advanced=y&target=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return [];

    const xml = await res.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
    return items
      .map(item => ({
        word: item.match(/<word>([^<]+)<\/word>/)?.[1]?.trim(),
        grade: item.match(/<word_grade>([^<]*)<\/word_grade>/)?.[1]?.trim(),
        definition: item.match(/<definition>([^<]+)<\/definition>/)?.[1]?.trim(),
      }))
      .filter(w =>
        w.word && KOREAN_ONLY.test(w.word) && w.word[0] === prefix &&
        w.word.length >= 2 && w.word.length <= 6 && w.definition,
      );
  } catch {
    return [];
  }
}

async function pickDynamicWord(recentWords, gradePreference) {
  const seeds = [...SEED_SYLLABLES].sort(() => Math.random() - 0.5).slice(0, 6);
  for (const seed of seeds) {
    const candidates = await fetchCandidates(seed);
    const preferred = candidates.filter(c => gradePreference.includes(c.grade) && !recentWords.includes(c.word));
    const pool = preferred.length ? preferred : candidates.filter(c => !recentWords.includes(c.word));
    if (pool.length) {
      const pick = pool[Math.floor(Math.random() * pool.length)];
      const hint = pick.definition.length > 100 ? `${pick.definition.slice(0, 100)}…` : pick.definition;
      return { word: pick.word, hint };
    }
  }
  return null;
}

async function pickWord(recentWords, gradePreference) {
  const dynamic = await pickDynamicWord(recentWords, gradePreference);
  if (dynamic) return dynamic;

  const pool = FALLBACK_WORDS.filter(([w]) => !recentWords.includes(w));
  const bank = pool.length ? pool : FALLBACK_WORDS;
  const [word, hint] = bank[Math.floor(Math.random() * bank.length)];
  return { word, hint };
}

// 자동 출제(activeQuiz)와 관리자 수동 출제(activeManualQuiz)는 완전히 별개 슬롯으로 관리한다
// — 자동으로 걸려있는 문제가 있어도 관리자가 문제를 만들면 그건 별도로 새로 열리고, 둘 다
// 동시에 채점 대상이 된다(자동이 수동을 밀어내거나 그 반대의 일은 없음). 각 슬롯 안에서는
// 여전히 "그 전 문제를 아무도 못 맞힌 채 새 문제가 그 슬롯에 또 올라오면 무효 처리"가 적용된다.
async function voidQuiz(client, state, slotKey) {
  const quiz = client[slotKey];
  if (!quiz) return;
  if (quiz.timeoutId) clearTimeout(quiz.timeoutId);
  client[slotKey] = null;
  state[slotKey] = null;
  try {
    const channel = await client.channels.fetch(quiz.channelId).catch(() => null);
    await channel?.send(`⌛ **지난 ${MODES[quiz.mode]?.label ?? '퀴즈'} 정답은 ${quiz.word} 였습니다.** 아무도 맞히지 못해 보상 없이 마감되었습니다.`);
  } catch (err) {
    console.error('퀴즈 무효 처리 중 오류:', err);
  }
}

// 실제로 채널에 문제를 올리는 부분(같은 슬롯의 이전 미해결 문제 무효 처리 + 문제 확정 + 게시)만
// 떼어낸 함수. fireQuiz(예약 경로, slotKey='activeQuiz')와 postCustomQuiz(관리자 직접 출제
// 경로, slotKey='activeManualQuiz')가 공유한다. picked를 안 주면 API에서 무작위로 고르고,
// 주면(관리자 직접 출제) 그걸 그대로 쓴다.
async function postQuiz(client, state, modeKey, picked, slotKey = 'activeQuiz', extraFields = {}) {
  const mode = MODES[modeKey];
  await voidQuiz(client, state, slotKey); // state[slotKey]를 정리할 수 있으므로 아래 saveState보다 먼저 실행
  saveState(state);

  try {
    const channel = await client.channels.fetch(QUIZ_CHANNEL_ID).catch(() => null);
    if (!channel) return false;

    picked = picked || await pickWord(state.recentWords || [], mode.gradePreference);
    state.recentWords = [picked.word, ...(state.recentWords || [])].slice(0, RECENT_WORD_MEMORY);

    const quiz = { channelId: QUIZ_CHANNEL_ID, guildId: channel.guildId, word: picked.word, mode: modeKey, xpReward: rollXpReward(), ...extraFields };
    client[slotKey] = quiz;
    state[slotKey] = quiz;
    saveState(state);

    await channel.send({ embeds: [mode.buildEmbed(picked)] });
    return true;
  } catch (err) {
    console.error('퀴즈 출제 중 오류:', err);
    return false;
  }
}

async function fireQuiz(client, modeKey) {
  const state = loadState();
  if (!state || state.posted) return; // 이미 다른 경로로 처리됨 (안전장치)
  state.posted = true;
  // posted를 먼저 저장해둬야, postQuiz 안의 await(채널 fetch 등)가 걸려있는 사이에 10분
  // 하트비트(checkAndSchedule)가 끼어들어도 "아직 posted=false"로 잘못 읽고 fireQuiz를
  // 한 번 더 예약하는 경합(중복 출제)을 막을 수 있다.
  saveState(state);

  await postQuiz(client, state, modeKey); // slotKey 기본값 'activeQuiz'
}

let armedTimer = null;
let armedScheduledAt = null;

function disarmTimer() {
  if (armedTimer) clearTimeout(armedTimer);
  armedTimer = null;
  armedScheduledAt = null;
}

// 하루 한 번, 이 사이클(cycleDateString, 자정을 넘겨도 05:00 전까지는 전날 사이클로 취급)에
// 아직 스케줄이 없으면 출제 가능 시간대(WINDOW_START~END, 낮 12시~다음날 새벽 5시) 안에서
// 무작위 시각을 골라 setTimeout을 건다. 모드는 어제 출제된 모드의 반대로 자동 결정(첫 실행은
// 초성퀴즈부터). scheduledAt(고정
// 시각)을 파일에 저장해두므로, 봇이 재시작돼도 같은 시각·같은 모드로 다시 예약되고(이미 지났으면 즉시
// 출제) 하루에 두 번 출제되지 않는다. 아직 안 풀린 문제(activeQuiz/activeManualQuiz)도 파일에
// 저장해두므로, 봇이 재시작돼도 채점이 끊기지 않고 이어진다(다음 문제가 같은 슬롯에 나갈 때
// voidQuiz가 정리). /퀴즈 중지로 paused 상태가 되면 예약을 걸지 않고(이미 나간 문제 채점은 계속
// 동작), /퀴즈 재개 시 다시 정상적으로 예약을 재개한다. paused는 자동 출제에만 영향을 주며,
// 관리자 수동 출제(activeManualQuiz)는 이 스케줄러와 무관하게 언제든 별도로 동작한다.
function checkAndSchedule(client) {
  const now = Date.now();
  const today = cycleDateString(now);
  let state = loadState();

  if (state?.activeQuiz && !client.activeQuiz) client.activeQuiz = state.activeQuiz;

  // 관리자 출제(activeManualQuiz)는 1시간 제한시간이 있는데, 그 타이머는 메모리에만 있어서
  // 재시작하면 사라진다. expiresAt(고정 만료 시각)을 기준으로 남은 시간을 다시 계산해 이어
  // 걸거나, 이미 지났으면 그 자리에서 바로 마감 처리한다.
  if (state?.activeManualQuiz && !client.activeManualQuiz) {
    client.activeManualQuiz = state.activeManualQuiz;
    const remaining = (state.activeManualQuiz.expiresAt ?? 0) - now;
    if (remaining <= 0) {
      voidQuiz(client, state, 'activeManualQuiz').catch(() => {});
      saveState(state);
    } else {
      armManualQuizTimeout(client, client.activeManualQuiz, remaining);
    }
  }

  if (state?.paused) {
    disarmTimer();
    return;
  }

  if (!state || state.day !== today) {
    const { start, end } = windowBoundsForDay(today);
    const base = Math.max(start, now);
    const scheduledAt = base >= end ? null : Math.round(base + Math.random() * (end - base));
    const prevMode = state?.mode;
    const mode = prevMode === 'chosung' ? 'sangsik' : 'chosung';
    state = {
      day: today, mode, scheduledAt, posted: scheduledAt === null, paused: false,
      recentWords: state?.recentWords || [], activeQuiz: state?.activeQuiz || null,
      activeManualQuiz: state?.activeManualQuiz || null,
    };
    saveState(state);
  }

  if (state.posted) return;
  if (armedTimer && armedScheduledAt === state.scheduledAt) return; // 이미 예약돼 있음

  if (armedTimer) clearTimeout(armedTimer);
  armedScheduledAt = state.scheduledAt;
  const delay = Math.max(0, state.scheduledAt - Date.now());
  armedTimer = setTimeout(() => {
    armedTimer = null;
    fireQuiz(client, state.mode);
  }, delay);
}

function startQuizScheduler(client) {
  checkAndSchedule(client);
  setInterval(() => checkAndSchedule(client), 10 * 60 * 1000); // 날짜 변경/재시작 복구 확인용 10분 하트비트
}

// ── 관리자 명령어(/퀴즈)에서 사용하는 제어 함수 ────────────────────────
function pauseQuiz() {
  const state = loadState() || {
    day: cycleDateString(), mode: 'chosung', scheduledAt: null, posted: true,
    recentWords: [], activeQuiz: null, activeManualQuiz: null,
  };
  state.paused = true;
  saveState(state);
  disarmTimer();
}

function resumeQuiz(client) {
  const state = loadState();
  if (state) {
    state.paused = false;
    saveState(state);
  }
  checkAndSchedule(client);
}

// 관리자가 직접 낸 문제는 자동 출제 스케줄과 완전히 무관하게 별도 슬롯(activeManualQuiz)에서
// 돌기 때문에, 자동 출제처럼 "다음 문제가 나갈 때까지 무기한 대기"로 두면 계속 열린 채 잊혀질
// 수 있다. 그래서 자동 출제와 달리 1시간 제한시간을 둬서, 그 안에 못 맞히면 정답 공개와 함께
// 자동으로 마감한다.
const MANUAL_QUIZ_TIME_LIMIT_MS = 60 * 60 * 1000;

// delayMs를 따로 주면 그 시간 뒤에 마감(재시작 후 남은 시간만큼만 다시 예약할 때 사용),
// 안 주면 기본 1시간 뒤 마감.
function armManualQuizTimeout(client, quiz, delayMs = MANUAL_QUIZ_TIME_LIMIT_MS) {
  quiz.timeoutId = setTimeout(async () => {
    if (client.activeManualQuiz !== quiz) return; // 이미 정답 처리됐거나 다른 문제로 교체됨
    client.activeManualQuiz = null;
    const state = loadState();
    if (state) {
      state.activeManualQuiz = null;
      saveState(state);
    }
    try {
      const channel = await client.channels.fetch(quiz.channelId).catch(() => null);
      await channel?.send(`⌛ **1시간이 지나 관리자가 낸 ${MODES[quiz.mode]?.label ?? '퀴즈'}가 마감되었습니다.** 정답은 **${quiz.word}** 였습니다.`);
    } catch (err) {
      console.error('관리자 출제 문제 시간 초과 처리 중 오류:', err);
    }
  }, Math.max(0, delayMs));
}

// 관리자가 /퀴즈에서 직접 입력한 단어·힌트로 문제를 출제한다(API로 무작위로 고르지 않음).
// 자동 출제(activeQuiz)의 예약/오늘 출제 여부와는 전혀 무관하게 별도 슬롯(activeManualQuiz)에
// 독립적으로 열리며, 1시간 안에 못 맞히면 자동으로 마감된다.
async function postCustomQuiz(client, modeOverride, word, hint) {
  const modeKey = modeOverride && MODES[modeOverride] ? modeOverride : 'chosung';
  const state = loadState() || {
    day: cycleDateString(), mode: 'chosung', scheduledAt: null, posted: false, paused: false,
    recentWords: [], activeQuiz: null, activeManualQuiz: null,
  };

  // expiresAt(고정 만료 시각)을 quiz에 함께 저장해두면, 봇이 재시작돼도 남은 시간을 다시
  // 계산해 타이머를 정확히 이어서 걸 수 있다(재시작 시 checkAndSchedule에서 복원).
  const expiresAt = Date.now() + MANUAL_QUIZ_TIME_LIMIT_MS;
  const ok = await postQuiz(client, state, modeKey, { word, hint }, 'activeManualQuiz', { expiresAt });
  if (ok && client.activeManualQuiz) armManualQuizTimeout(client, client.activeManualQuiz, MANUAL_QUIZ_TIME_LIMIT_MS);
  return { ok, mode: modeKey };
}

function getQuizStatus() {
  return loadState();
}

// 자동 출제(activeQuiz)와 관리자 수동 출제(activeManualQuiz) 두 슬롯을 모두 확인해서, 채팅
// 메시지가 둘 중 하나의 정답과 일치하면 그 슬롯만 채점한다(다른 슬롯은 그대로 계속 열려있음).
async function handleQuizMessage(message) {
  if (message.author.bot) return;

  const client = message.client;
  const normalize = s => s.replace(/\s+/g, '');
  const guess = normalize(message.content);

  for (const slotKey of ['activeQuiz', 'activeManualQuiz']) {
    const quiz = client[slotKey];
    if (!quiz || message.channelId !== quiz.channelId) continue;
    if (normalize(quiz.word) !== guess) continue;
    if (EXCLUDED_GUILD_IDS.includes(quiz.guildId)) return; // 레벨 시스템 제외 서버(테스트 서버 등)는 채점하지 않음

    if (quiz.timeoutId) clearTimeout(quiz.timeoutId);
    client[slotKey] = null;
    const state = loadState();
    if (state) {
      state[slotKey] = null;
      saveState(state);
    }

    const result = applyXp(quiz.guildId, message.author.id, quiz.xpReward);
    const levelUpLine = result.leveledUp ? `\n🎊 ${message.author}님이 **${result.newLevel}레벨**을 달성했어요!` : '';
    await message.reply({
      content: `🎉 정답입니다! **${quiz.word}** (+${quiz.xpReward} XP)${levelUpLine}`,
      allowedMentions: { repliedUser: false, users: result.leveledUp ? [message.author.id] : [] },
    }).catch(() => {});
    return; // 한 메시지는 한 슬롯만 채점
  }
}

module.exports = {
  startQuizScheduler, handleQuizMessage, QUIZ_CHANNEL_ID,
  pauseQuiz, resumeQuiz, postCustomQuiz, getQuizStatus,
};

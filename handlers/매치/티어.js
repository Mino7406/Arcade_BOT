// 티어.js — 롤·발로란트 티어를 사람마다(게임마다) 저장하고, 점수·이름표·이모지로 바꿔 준다.
//
// 내전에 거의 같은 사람들이 계속 오니까 한 번 저장한 티어를 다음 내전에도 그대로 쓴다.
// 저장은 두 가지로 들어온다: 팀 짜기 카드의 🏅 내 티어 설정(직접 고르기), 팀 입력에 "승훈 불2"처럼 적은 것(자동 갱신).
// 이모지는 assets/티어/*.png(각 게임 공식 티어 그림을 128px로 줄인 것)를 봇이 켜질 때 앱 이모지로 등록해 쓴다.
// 롤·오버워치는 티어마다 그림 하나(단계는 숫자로 붙임), 발로란트·배그는 단계마다 그림이 따로 있다. 오버워치 상위 500은 그림 없음.

const fs = require('fs');
const path = require('path');
const { writeJsonIfChanged } = require('../공통/저장');
const { logSystem, logError } = require('../공통/로그');

// divs: 단계 수(0이면 단계 없음). 롤·오버워치·배그는 숫자가 작을수록 높고(롤 4→1, 오버워치 5→1, 배그 4→1), 발로란트는 1(낮음)→3(높음).
// scored: 단계 대신 점수(LP·RR·RP)로 순위를 매기는 최상위 티어. 고를 때 점수를 적을 수 있다(선택).
// aliases: 팀 입력에서 알아듣는 글자. 한 글자 줄임말(다·불…)은 숫자가 붙을 때만 티어로 본다(이름과 헷갈리지 않게).
const LADDERS = {
  lol: {
    name: '리그 오브 레전드',
    divOrder: 'desc',
    tiers: [
      { key: 'iron',        name: '아이언',       short: '아',   divs: 4, aliases: ['아', '아이언'] },
      { key: 'bronze',      name: '브론즈',       short: '브',   divs: 4, aliases: ['브', '브론즈'] },
      { key: 'silver',      name: '실버',         short: '실',   divs: 4, aliases: ['실', '실버'] },
      { key: 'gold',        name: '골드',         short: '골',   divs: 4, aliases: ['골', '골드'] },
      { key: 'platinum',    name: '플래티넘',     short: '플',   divs: 4, aliases: ['플', '플래', '플레', '플래티넘', '플레티넘'] },
      { key: 'emerald',     name: '에메랄드',     short: '에',   divs: 4, aliases: ['에', '에메', '에메랄드'] },
      { key: 'diamond',     name: '다이아몬드',   short: '다',   divs: 4, aliases: ['다', '다야', '다이아', '다이아몬드'] },
      { key: 'master',      name: '마스터',       short: '마',   divs: 0, scored: true, aliases: ['마스터'] },
      { key: 'grandmaster', name: '그랜드마스터', short: '그마', divs: 0, scored: true, aliases: ['그마', '그랜드마스터'] },
      { key: 'challenger',  name: '챌린저',       short: '챌',   divs: 0, scored: true, aliases: ['챌', '챌린저'] },
    ],
    scoreUnit: 'LP',
  },
  valorant: {
    name: '발로란트',
    divOrder: 'asc',
    tiers: [
      { key: 'iron',    name: '아이언',     short: '아', divs: 3, aliases: ['아', '아이언'] },
      { key: 'bronze',  name: '브론즈',     short: '브', divs: 3, aliases: ['브', '브론즈'] },
      { key: 'silver',  name: '실버',       short: '실', divs: 3, aliases: ['실', '실버'] },
      { key: 'gold',    name: '골드',       short: '골', divs: 3, aliases: ['골', '골드'] },
      { key: 'plat',    name: '플래티넘',   short: '플', divs: 3, aliases: ['플', '플래', '플레', '플래티넘', '플레티넘'] },
      { key: 'dia',     name: '다이아몬드', short: '다', divs: 3, aliases: ['다', '다야', '다이아', '다이아몬드'] },
      { key: 'asc',     name: '초월자',     short: '초', divs: 3, aliases: ['초', '초월', '초월자'] },
      { key: 'imm',     name: '불멸',       short: '불', divs: 3, aliases: ['불', '불멸'] },
      { key: 'radiant', name: '레디언트',   short: '레디', divs: 0, scored: true, aliases: ['레디', '레디언트', '래디언트'] },
    ],
    scoreUnit: 'RR',
  },
  // 오버워치: 브론즈~챔피언 모두 5단계(5 낮음 → 1 높음), 2026년 8월에 플래티넘과 다이아 사이에 에메랄드가 생겼다. 상위 500은 순위표.
  overwatch: {
    name: '오버워치',
    divOrder: 'desc',
    tiers: [
      { key: 'bronze',      name: '브론즈',       short: '브',   divs: 5, aliases: ['브', '브론즈'] },
      { key: 'silver',      name: '실버',         short: '실',   divs: 5, aliases: ['실', '실버'] },
      { key: 'gold',        name: '골드',         short: '골',   divs: 5, aliases: ['골', '골드'] },
      { key: 'platinum',    name: '플래티넘',     short: '플',   divs: 5, aliases: ['플', '플래', '플레', '플래티넘', '플레티넘'] },
      { key: 'emerald',     name: '에메랄드',     short: '에',   divs: 5, aliases: ['에', '에메', '에메랄드'] },
      { key: 'diamond',     name: '다이아몬드',   short: '다',   divs: 5, aliases: ['다', '다야', '다이아', '다이아몬드'] },
      { key: 'master',      name: '마스터',       short: '마',   divs: 5, aliases: ['마', '마스터'] },
      { key: 'grandmaster', name: '그랜드마스터', short: '그마', divs: 5, aliases: ['그', '그마', '그랜드마스터'] },
      { key: 'champion',    name: '챔피언',       short: '챔',   divs: 5, aliases: ['챔', '챔피언'] },
      { key: 'top500',      name: '상위 500',     short: '탑500', divs: 0, aliases: ['탑오백', '상위오백'] },
    ],
  },
  // 배그(PC): 브론즈~다이아 4단계(4 낮음 → 1 높음), 마스터·서바이버는 RP 점수제.
  pubg: {
    name: '배틀그라운드',
    divOrder: 'desc',
    tiers: [
      { key: 'bronze',   name: '브론즈',     short: '브',   divs: 4, aliases: ['브', '브론즈'] },
      { key: 'silver',   name: '실버',       short: '실',   divs: 4, aliases: ['실', '실버'] },
      { key: 'gold',     name: '골드',       short: '골',   divs: 4, aliases: ['골', '골드'] },
      { key: 'platinum', name: '플래티넘',   short: '플',   divs: 4, aliases: ['플', '플래', '플레', '플래티넘', '플레티넘'] },
      { key: 'crystal',  name: '크리스탈',   short: '크',   divs: 4, aliases: ['크', '크리', '크리스탈'] },
      { key: 'diamond',  name: '다이아몬드', short: '다',   divs: 4, aliases: ['다', '다야', '다이아', '다이아몬드'] },
      { key: 'master',   name: '마스터',     short: '마',   divs: 0, scored: true, aliases: ['마스터'] },
      { key: 'survivor', name: '서바이버',   short: '서바', divs: 0, scored: true, aliases: ['서바', '서바이버'] },
    ],
    scoreUnit: 'RP',
  },
};

// 점수제 티어의 점수를 밸런스 점수에 얹는 비율: 200점마다 한 단계, 최대 3000점까지만 친다.
const SCORE_PER_STEP = 200;
const SCORE_CAP = 3000;

function hasTiers(game) {
  return !!LADDERS[game];
}

function findTier(game, key) {
  return LADDERS[game]?.tiers.find(t => t.key === key) ?? null;
}

// 낮은 칸부터 0, 1, 2 … 로 센 점수. 롤 아이언4 = 0, 골드1 = 15 / 발로 아이언1 = 0, 레디언트 = 24
function tierScore(game, tier) {
  const ladder = LADDERS[game];
  if (!ladder || !tier) return null;
  let score = 0;
  for (const t of ladder.tiers) {
    if (t.key === tier.tier) {
      if (!t.divs) return score + (t.scored && tier.score ? Math.min(Number(tier.score) || 0, SCORE_CAP) / SCORE_PER_STEP : 0);
      const div = Math.min(Math.max(Number(tier.div) || 1, 1), t.divs);
      return score + (ladder.divOrder === 'desc' ? t.divs - div : div - 1);
    }
    score += t.divs || 1;
  }
  return null;
}

// 점수 → { tier, div } (평균 티어 표시용)
function tierFromScore(game, score) {
  const ladder = LADDERS[game];
  if (!ladder || score === null || score === undefined) return null;
  let s = Math.max(0, Math.round(score));
  for (const t of ladder.tiers) {
    const span = t.divs || 1;
    if (s < span) return t.divs ? { tier: t.key, div: ladder.divOrder === 'desc' ? t.divs - s : s + 1 } : { tier: t.key };
    s -= span;
  }
  const top = ladder.tiers.at(-1);
  return top.divs ? { tier: top.key, div: ladder.divOrder === 'desc' ? 1 : top.divs } : { tier: top.key };
}

function tierLabel(game, tier, { short = false } = {}) {
  const t = findTier(game, tier?.tier);
  if (!t) return '';
  const unit = LADDERS[game].scoreUnit || '점';
  return `${short ? t.short : t.name}${t.divs && tier.div ? tier.div : ''}${t.scored && tier.score ? ` ${tier.score}${unit}` : ''}`;
}

// 팀 입력의 낱말 하나를 티어로 읽는다. "다3" "다이아3" "불멸1" "마스터" "챌" "레디" → { tier, div } / 아니면 null
function parseTierToken(game, token) {
  const ladder = LADDERS[game];
  if (!ladder) return null;
  const m = /^([가-힣]+)([1-5])?$/.exec(String(token).trim());
  if (!m) return null;
  const [, word, digit] = m;
  for (const t of ladder.tiers) {
    if (!t.aliases.includes(word)) continue;
    if (t.divs) {
      // 숫자 없이 "다이아"처럼 두 글자 이상으로 적으면 가운데 단계로 친다. 한 글자(다·불…)만 있으면 이름일 수 있어 무시.
      if (!digit) return word.length >= 2 ? { tier: t.key, div: Math.ceil(t.divs / 2) } : null;
      const div = Number(digit);
      return div >= 1 && div <= t.divs ? { tier: t.key, div } : null;
    }
    return digit ? null : { tier: t.key };
  }
  return null;
}

// ── 저장 ────────────────────────────────────────────────────
// DB/티어.json: { 유저ID: { lol: { tier, div, at }, valorant: { ... } } }

const DB_DIR = path.join(__dirname, '..', '..', 'DB');
const DB_PATH = path.join(DB_DIR, '티어.json');
fs.mkdirSync(DB_DIR, { recursive: true });

let store = {};
try {
  if (fs.existsSync(DB_PATH)) store = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) || {};
} catch (err) {
  console.error('티어 저장 파일 읽기 실패(빈 상태로 시작):', err);
  logSystem({ 유형: '저장 오류', 내용: `티어 저장 파일 읽기 실패 — 빈 상태로 시작: ${err?.message ?? err}` });
  store = {};
}

function save() {
  try {
    writeJsonIfChanged(DB_PATH, store);
  } catch (err) {
    console.error('티어 저장 실패:', err);
    logError('저장 오류', '티어 저장 실패', err);
  }
}

// /관리 티어 초기화용: 저장된 사람 수·티어 개수, 테스트 서버 가짜 인원(test_ 로 시작) 수
function tierStats() {
  const ids = Object.keys(store).filter(id => Object.keys(store[id] || {}).length > 0);
  const entries = ids.reduce((n, id) => n + Object.keys(store[id]).length, 0);
  return { users: ids.length, entries, testUsers: ids.filter(id => id.startsWith('test_')).length };
}

// onlyTest: 테스트 서버 가짜 인원만 지운다. 지운 사람 수를 돌려준다.
function clearTiers({ onlyTest = false } = {}) {
  const ids = Object.keys(store).filter(id => !onlyTest || id.startsWith('test_'));
  for (const id of ids) delete store[id];
  save();
  return ids.length;
}

function getTier(userId, game) {
  const tier = store[userId]?.[game] ?? null;
  return tier && findTier(game, tier.tier) ? tier : null; // 티어 목록이 바뀌어 없어진 값은 없는 것으로
}

function setTier(userId, game, tier) {
  if (!hasTiers(game)) return;
  if (!store[userId]) store[userId] = {};
  if (tier) store[userId][game] = { tier: tier.tier, ...(tier.div ? { div: tier.div } : {}), ...(tier.score ? { score: tier.score } : {}), at: Date.now() };
  else delete store[userId][game];
  save();
}

// ── 이모지 ──────────────────────────────────────────────────

const EMOJI_DIR = path.join(__dirname, '..', '..', 'assets', '티어');
const emojiIds = new Map(); // 파일 이름(lol_gold, val_imm2 …) → 앱 이모지 ID

function emojiFileName(game, tier) {
  if (game === 'lol') return `lol_${tier.tier}`;
  if (game === 'overwatch') return `ow_${tier.tier}`;
  if (game === 'valorant' || game === 'pubg') { // 발로·배그는 단계마다 그림이 따로 있다
    const t = findTier(game, tier.tier);
    const prefix = game === 'pubg' ? 'pubg' : 'val';
    return t?.divs ? `${prefix}_${tier.tier}${tier.div || 1}` : `${prefix}_${tier.tier}`;
  }
  return null;
}

function allEmojiFiles() {
  try {
    return fs.readdirSync(EMOJI_DIR).filter(f => f.endsWith('.png')).map(f => f.slice(0, -4));
  } catch {
    return [];
  }
}

// 봇이 켜질 때 한 번: 없는 티어 이모지만 등록한다(이미 있으면 목록 조회 1번뿐).
async function ensureTierEmojis(client) {
  const manager = client.application?.emojis;
  if (!manager) return 0;
  const list = await manager.fetch();
  let created = 0;
  for (const file of allEmojiFiles()) {
    const name = `tier_${file}`;
    let emoji = list.find(e => e.name === name);
    if (!emoji) {
      emoji = await manager.create({ attachment: path.join(EMOJI_DIR, `${file}.png`), name }).catch(err => {
        logError('처리 오류', `티어 이모지 등록 실패 (${name})`, err);
        return null;
      });
      if (emoji) created++;
    }
    if (emoji) emojiIds.set(file, emoji.id);
  }
  if (created) logSystem({ 유형: '봇 상태', 내용: `티어 앱 이모지 ${created}개 등록` });
  return emojiIds.size;
}

function tierEmojiId(game, tier) {
  const file = tier && emojiFileName(game, tier);
  return file ? emojiIds.get(file) ?? null : null;
}

// 이름 앞에 붙일 글자. 이모지가 준비됐으면 이모지(롤은 단계 숫자를 뒤에), 아니면 "[다2]" 같은 글자.
function tierBadge(game, tier) {
  if (!tier || !findTier(game, tier.tier)) return '';
  const id = tierEmojiId(game, tier);
  if (!id) return `\`${tierLabel(game, tier, { short: true })}\``;
  const t = findTier(game, tier.tier);
  const tail = (game === 'lol' || game === 'overwatch') && t.divs && tier.div ? `${tier.div}` : ''; // 티어마다 그림 하나인 게임은 단계 숫자를 뒤에
  return `<:t:${id}>${tail}`;
}

module.exports = {
  LADDERS,
  hasTiers,
  findTier,
  tierScore,
  tierFromScore,
  tierLabel,
  parseTierToken,
  getTier,
  setTier,
  tierStats,
  clearTiers,
  ensureTierEmojis,
  tierEmojiId,
  tierBadge,
};

// 티어.js — 롤·발로란트 티어를 사람마다(게임마다) 저장하고, 점수·이름표·이모지로 바꿔 준다.
//
// 내전에 거의 같은 사람들이 계속 오니까 한 번 저장한 티어를 다음 내전에도 그대로 쓴다.
// 저장은 두 가지로 들어온다: 팀 짜기 카드의 🏅 내 티어 설정(직접 고르기), 팀 입력에 "승훈 불2"처럼 적은 것(자동 갱신).
// 이모지는 assets/티어/*.png(각 게임 공식 티어 그림을 128px로 줄인 것)를 봇이 켜질 때 앱 이모지로 등록해 쓴다.
// 롤·오버워치는 티어마다 그림 하나(단계는 숫자로 붙임), 발로란트·배그는 단계마다 그림이 따로 있다.

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
  // 오버워치: 브론즈~챔피언 모두 5단계(5 낮음 → 1 높음), 2026년 8월에 플래티넘과 다이아 사이에 에메랄드가 생겼다.
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

// 게임 키: 'lol' 처럼 게임 이름만, 또는 오버워치 롤별 티어는 'overwatch.tank' 처럼 점 뒤에 롤을 붙인다.
function splitKey(gk) {
  const [game, role = null] = String(gk ?? '').split('.');
  return { game, role };
}
const baseGame = gk => splitKey(gk).game;
const ladderOf = gk => LADDERS[baseGame(gk)] ?? null;

function hasTiers(game) {
  return !!ladderOf(game);
}

function findTier(game, key) {
  return ladderOf(game)?.tiers.find(t => t.key === key) ?? null;
}

// ── 포지션 ──────────────────────────────────────────────────
// 롤: 주/부 포지션을 저장해 두면 팀마다 탑~서포터를 겹치지 않게 맡긴다(밸런스에도 반영).
// 발로: 주/부 역할은 카드에 보여 주기만 한다(역할이 롤만큼 고정되지 않아서 밸런스엔 안 넣음).
// 오버워치: 포지션별로 랭크가 따로라 돌격·공격·지원 티어를 각각 저장하고, 팀마다 돌격1·공격2·지원2(6vs6이면 돌격2·공격2·지원2)로 맡겨 그 롤 티어로 계산한다.
// aliases: ✏️ 직접 입력에서 줄 맨 앞에 적으면 그 역할로 알아듣는 글자(이름과 헷갈리지 않게 두 글자 이상만)
const POSITIONS = {
  lol: [
    { key: 'top', name: '탑', aliases: ['탑', '탑솔'] },
    { key: 'jungle', name: '정글', aliases: ['정글', '정글러'] },
    { key: 'mid', name: '미드', aliases: ['미드'] },
    { key: 'adc', name: '바텀', aliases: ['바텀', '원딜', '봇듀', '에이디'] },
    { key: 'support', name: '서포터', aliases: ['서포터', '서폿', '서포트'] },
  ],
  valorant: [
    { key: 'duelist', name: '타격대', aliases: ['타격대', '타격'] },
    { key: 'initiator', name: '척후대', aliases: ['척후대', '척후'] },
    { key: 'controller', name: '전략가', aliases: ['전략가', '전략'] },
    { key: 'sentinel', name: '감시자', aliases: ['감시자', '감시'] },
  ],
};
const POSITION_WORD = { lol: '포지션', valorant: '역할' };
const OW_ROLES = [
  { key: 'tank', name: '돌격', icon: '🛡️', slots: 1, aliases: ['돌격', '탱', '탱커'] },
  { key: 'damage', name: '공격', icon: '⚔️', slots: 2, aliases: ['공격', '딜', '딜러'] },
  { key: 'support', name: '지원', icon: '💉', slots: 2, aliases: ['지원', '힐', '힐러', '서폿'] },
  // 자유(오픈 큐): 6vs6 은 역할 제한이 없어서 이 티어로 계산한다. 자리가 아니라 직접 입력의 역할 글자로는 안 받는다. 아이콘은 오버워치 플렉스 아이콘(pos_ow_open)
  { key: 'open', name: '자유', icon: '🔓', slots: 0, aliases: [], open: true },
];

function positionName(game, key) {
  if (baseGame(game) === 'overwatch') return owRole(key)?.name ?? '';
  return POSITIONS[game]?.find(p => p.key === key)?.name ?? '';
}

function owRole(key) {
  return OW_ROLES.find(r => r.key === key) ?? null;
}

// 역할을 적을 수 있는 게임(롤·발로·오버워치)
function hasPositions(game) {
  return !!POSITIONS[game] || game === 'overwatch';
}

// 직접 입력의 낱말 하나 → 역할 키(없으면 null). 오버워치는 한 글자 줄임말(탱·딜·힐)도 받는다.
function parsePositionToken(game, token) {
  const list = game === 'overwatch' ? OW_ROLES : POSITIONS[game];
  const word = String(token).trim();
  return list?.find(p => p.aliases.includes(word))?.key ?? null;
}

// 낮은 칸부터 0, 1, 2 … 로 센 점수. 롤 아이언4 = 0, 골드1 = 15 / 발로 아이언1 = 0, 레디언트 = 24
function tierScore(game, tier) {
  const ladder = ladderOf(game);
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
  const ladder = ladderOf(game);
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
  const unit = ladderOf(game).scoreUnit || '점';
  return `${short ? t.short : t.name}${t.divs && tier.div ? tier.div : ''}${t.scored && tier.score ? ` ${tier.score}${unit}` : ''}`;
}

// 팀 입력의 낱말 하나를 티어로 읽는다. "다3" "다이아3" "불멸1" "마스터" "챌" "레디" → { tier, div } / 아니면 null
function parseTierToken(game, token) {
  const ladder = ladderOf(game);
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
// DB/tier.json(가짜 인원 test_… 은 DB/test.tier.json): { 유저ID: { lol: { tier, div, at, pos: ['mid', 'jungle'] }, overwatch: { roles: { tank: { tier, div } … }, at }, … } }
// pos 는 [주, 부] 순서. 오버워치 맨 위의 tier 는 롤을 모르는 티어(팀 입력에 "승훈 다2"처럼 적은 것)다.

const DB_DIR = path.join(__dirname, '..', '..', 'DB');
const DB_PATH = path.join(DB_DIR, 'tier.json');
fs.mkdirSync(DB_DIR, { recursive: true });

// 예전 이름(DB/티어.json)으로 저장돼 있으면 새 이름으로 옮긴다
const OLD_DB_PATH = path.join(DB_DIR, '티어.json');
try {
  if (!fs.existsSync(DB_PATH) && fs.existsSync(OLD_DB_PATH)) fs.renameSync(OLD_DB_PATH, DB_PATH);
} catch (err) {
  console.error('티어 저장 파일 이름 바꾸기 실패:', err);
}

// 테스트 서버의 🧪 가짜 인원(ID가 test_ 로 시작)은 DB/test.tier.json 에 따로 저장한다.
// 진짜 유저 티어 파일(tier.json)에 테스트 데이터가 섞이지 않게 하고, 테스트가 끝나면 test.tier.json 만 지우면 된다.
const TEST_DB_PATH = path.join(DB_DIR, 'test.tier.json');
const isTestUser = userId => String(userId).startsWith('test_');

function loadStore(file, label) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) || {} : {};
  } catch (err) {
    console.error(`${label} 읽기 실패(빈 상태로 시작):`, err);
    logSystem({ 유형: '저장 오류', 내용: `${label} 읽기 실패 — 빈 상태로 시작: ${err?.message ?? err}` });
    return {};
  }
}

// 사람이 파일을 열어 봐도 알아보게 넣는 글자(봇은 안 쓰고, 읽을 때 떼어 냈다가 저장할 때마다 다시 만든다):
//   "이름": 서버 별명(마지막으로 티어를 저장했을 때) / 게임마다 "보기": "롤 다이아몬드2 · 미드 / 정글(부)"
const names = new Map(); // 유저ID → 이름
const VIEW_KEY = '보기';
const NAME_KEY = '이름';
const GAME_SHORT = { lol: '롤', valorant: '발로', overwatch: '옵치', pubg: '배그' };

function stripView(store) {
  for (const [id, entry] of Object.entries(store)) {
    if (!entry || typeof entry !== 'object') { delete store[id]; continue; }
    if (entry[NAME_KEY]) names.set(id, String(entry[NAME_KEY]));
    delete entry[NAME_KEY];
    for (const g of Object.values(entry)) if (g && typeof g === 'object') delete g[VIEW_KEY];
  }
  return store;
}

const realStore = stripView(loadStore(DB_PATH, '티어 저장 파일'));
const testStore = stripView(loadStore(TEST_DB_PATH, '테스트 티어 저장 파일'));

// 게임 하나의 "보기" 글자
function viewText(game, e) {
  const parts = [];
  if (game === 'overwatch') {
    for (const r of OW_ROLES) {
      const t = e.roles?.[r.key];
      if (t && findTier(game, t.tier)) parts.push(`${r.name} ${tierLabel(game, t)}`);
    }
    if (e.tier && findTier(game, e.tier)) parts.push(`${tierLabel(game, e)}(역할 모름)`);
  } else {
    if (e.tier && findTier(game, e.tier)) parts.push(tierLabel(game, e));
    const [main, sub] = Array.isArray(e.pos) ? e.pos : [];
    if (main) parts.push(`${positionName(game, main)}${sub ? ` / ${positionName(game, sub)}(부)` : ''}`);
  }
  return `${GAME_SHORT[game] ?? game} ${parts.length ? parts.join(' · ') : '없음'}`;
}

// 파일에 쓸 모양: 이름 → 게임마다 { 보기, 실제 값… }. 줄 바꿈·들여쓰기로 보기 좋게.
function fileView(store) {
  const out = {};
  for (const [id, entry] of Object.entries(store)) {
    const user = {};
    if (names.has(id)) user[NAME_KEY] = names.get(id);
    for (const [game, e] of Object.entries(entry)) user[game] = LADDERS[game] ? { [VIEW_KEY]: viewText(game, e), ...e } : e;
    out[id] = user;
  }
  return out;
}

// 사람마다 한 덩어리, 게임마다 한 줄:
// {
//   "457…": {
//     "이름": "김민호",
//     "lol": {"보기":"롤 다이아몬드2 · 미드","tier":"diamond","div":2,…}
//   }
// }
function prettyFile(view) {
  const users = Object.entries(view).map(([id, user]) => {
    const lines = Object.entries(user).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
    return `  ${JSON.stringify(id)}: {\n${lines.join(',\n')}\n  }`;
  });
  return users.length ? `{\n${users.join(',\n')}\n}\n` : '{}\n';
}

function save(userId) {
  const test = isTestUser(userId);
  try {
    writeJsonIfChanged(test ? TEST_DB_PATH : DB_PATH, fileView(test ? testStore : realStore), { stringify: prettyFile });
  } catch (err) {
    console.error('티어 저장 실패:', err);
    logError('저장 오류', `${test ? '테스트 ' : ''}티어 저장 실패`, err);
  }
}

// 예전에 tier.json 에 섞여 들어간 test_ 항목은 test.tier.json 으로 옮긴다
{
  const moved = Object.keys(realStore).filter(isTestUser);
  if (moved.length) {
    for (const id of moved) { testStore[id] = realStore[id]; delete realStore[id]; }
    save('test_'); save('');
  }
}

const storeOf = userId => (isTestUser(userId) ? testStore : realStore);

const tierOnly = t => ({ tier: t.tier, ...(t.div ? { div: t.div } : {}), ...(t.score ? { score: t.score } : {}) });

// 저장된 티어. 'overwatch.tank' 는 그 롤 티어, 'overwatch' 는 롤 티어 중 가장 높은 것(없으면 롤 모르는 티어).
function getTier(userId, gk) {
  const { game, role } = splitKey(gk);
  const entry = storeOf(userId)[userId]?.[game];
  if (!entry || !LADDERS[game]) return null;
  const valid = t => (t && findTier(game, t.tier) ? t : null); // 티어 목록이 바뀌어 없어진 값은 없는 것으로
  if (role) return valid(entry.roles?.[role]);
  if (game === 'overwatch') {
    const best = OW_ROLES.map(r => valid(entry.roles?.[r.key])).filter(Boolean)
      .sort((a, b) => tierScore(game, b) - tierScore(game, a))[0];
    if (best) return best;
  }
  return valid(entry);
}

function getRoleTiers(userId) {
  return Object.fromEntries(OW_ROLES.map(r => [r.key, getTier(userId, `overwatch.${r.key}`)]));
}

// 역할 고정(5vs5) 티어를 하나라도 저장했는지(자유 티어는 빼고)
function hasRoleQueueTier(userId) {
  return OW_ROLES.some(r => !r.open && getTier(userId, `overwatch.${r.key}`));
}

// 6vs6(자유) 계산용 티어: 자유 티어 → 없으면 역할 티어 중 가장 높은 것
function openTier(userId) {
  return getTier(userId, 'overwatch.open') ?? getTier(userId, 'overwatch');
}

function getPositions(userId, game) {
  const list = storeOf(userId)[userId]?.[game]?.pos;
  return Array.isArray(list) ? list.filter(k => positionName(game, k)) : [];
}

function cleanEntry(userId, game) {
  const e = storeOf(userId)[userId]?.[game];
  if (!e) return;
  if (e.roles && !Object.keys(e.roles).length) delete e.roles;
  if (e.pos && !e.pos.length) delete e.pos;
  if (!e.tier && !e.roles && !e.pos) delete storeOf(userId)[userId][game];
  if (storeOf(userId)[userId] && !Object.keys(storeOf(userId)[userId]).length) delete storeOf(userId)[userId];
}

// 티어·포지션이 바뀌면 알려 달라고 등록해 두는 곳(팀 짜기 카드가 바로 고쳐지도록). 어느 경로로 바뀌든(내 티어 설정·/티어·초기화) 여기서 한 번에 알린다.
const changeListeners = [];
function onChange(fn) {
  changeListeners.push(fn);
}
function notifyChange(userId) {
  for (const fn of changeListeners) {
    try { fn(userId); } catch (err) { console.error('티어 변경 알림 처리 중 오류:', err); }
  }
}

// 티어를 저장한다(null 이면 지운다). 포지션·다른 롤 티어는 그대로 둔다.
function setTier(userId, gk, tier) {
  const { game, role } = splitKey(gk);
  if (!LADDERS[game] || (role && (game !== 'overwatch' || !owRole(role)))) return;
  if (!storeOf(userId)[userId]) storeOf(userId)[userId] = {};
  const e = (storeOf(userId)[userId][game] = storeOf(userId)[userId][game] || {});
  if (role) {
    e.roles = { ...(e.roles || {}) };
    if (tier) e.roles[role] = tierOnly(tier); else delete e.roles[role];
  } else {
    delete e.tier; delete e.div; delete e.score;
    if (tier) Object.assign(e, tierOnly(tier));
  }
  e.at = Date.now();
  cleanEntry(userId, game);
  save(userId);
  notifyChange(userId);
}

// 봇이 켜질 때 한 번: 이름이 없는 사람은 서버 멤버 목록에서 별명을 찾아 채우고, 파일을 지금 모양(이름·보기)으로 다시 쓴다.
// 예전 모양(한 줄짜리)으로 저장돼 있던 파일도 이때 바뀐다. 못 찾은 사람(서버를 나감 등)은 이름 없이 그대로.
async function refreshFileNames(client) {
  const missing = Object.keys(realStore).filter(id => !names.has(id));
  let filled = 0;
  for (const id of missing) {
    for (const guild of client.guilds?.cache?.values?.() ?? []) {
      const member = guild.members.cache.get(id) || await guild.members.fetch(id).catch(() => null);
      if (member) { names.set(id, member.displayName); filled++; break; }
    }
  }
  save('');
  save('test_');
  return filled;
}

// 파일에 같이 적어 둘 이름(서버 별명). 바뀌었을 때만 저장한다. 저장된 티어가 없는 사람은 파일에 안 나온다.
function setName(userId, name) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean || names.get(userId) === clean) return;
  names.set(userId, clean);
  if (storeOf(userId)[userId]) save(userId);
}

// 🗑️ 전체 초기화: 이 사람의 모든 게임 티어·역할을 지운다. 지운 게 있었으면 true.
function resetAll(userId) {
  const store = storeOf(userId);
  if (!store[userId]) return false;
  delete store[userId];
  save(userId);
  notifyChange(userId);
  return true;
}

// 포지션 저장: [주, 부] (빈 배열이면 지움)
function setPositions(userId, game, list) {
  if (!POSITIONS[game]) return;
  const clean = [...new Set((list || []).filter(k => positionName(game, k)))].slice(0, 2);
  if (!storeOf(userId)[userId]) storeOf(userId)[userId] = {};
  const e = (storeOf(userId)[userId][game] = storeOf(userId)[userId][game] || {});
  e.pos = clean;
  e.at = Date.now();
  cleanEntry(userId, game);
  save(userId);
  notifyChange(userId);
}

// ── 이모지 ──────────────────────────────────────────────────

const EMOJI_DIR = path.join(__dirname, '..', '..', 'assets', '티어');
const emojiIds = new Map(); // 파일 이름(lol_gold, val_imm2 …) → 앱 이모지 ID

function emojiFileName(gk, tier) {
  const game = baseGame(gk);
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

// 티어 이모지 글자: <:lol_diamond:ID>. 마우스를 올리면 :lol_diamond: 처럼 이름이 보인다(이모지가 없으면 빈 글자).
function tierEmojiTag(game, tier) {
  const file = tier && emojiFileName(game, tier);
  const id = file && emojiIds.get(file);
  return id ? `<:${file}:${id}>` : '';
}

function tierEmojiId(game, tier) {
  const file = tier && emojiFileName(game, tier);
  return file ? emojiIds.get(file) ?? null : null;
}

// 포지션 아이콘: assets/티어/pos_<lol|val|ow>_<자리>.png (롤은 라이엇 클라이언트, 발로는 공식 역할 아이콘, 오버워치는 블리자드 롤 아이콘)
// 라이트·다크 테마 둘 다 보이게 발로는 빨강, 오버워치는 주황으로 칠해 두었다.
const POS_PREFIX = { lol: 'lol', valorant: 'val', overwatch: 'ow' };
const posFile = (game, key) => (POS_PREFIX[baseGame(game)] && key ? `pos_${POS_PREFIX[baseGame(game)]}_${key}` : null);
function positionEmojiId(game, key) {
  const file = posFile(game, key);
  return file ? emojiIds.get(file) ?? null : null;
}

// 선택 메뉴·버튼에 넣을 이모지 객체(없으면 undefined). 이름은 파일 이름(화면 모음이 그림을 찾을 때 씀).
function positionEmoji(game, key) {
  const id = positionEmojiId(game, key);
  return id ? { id, name: posFile(game, key) } : undefined;
}

// 자리 이름 앞에 붙일 아이콘 글자. 이모지가 없으면 오버워치는 🛡️⚔️💉, 나머지는 빈칸.
function positionIcon(game, key) {
  const id = positionEmojiId(game, key);
  if (id) return `<:${posFile(game, key)}:${id}>`;
  return baseGame(game) === 'overwatch' ? owRole(key)?.icon ?? '' : '';
}

// 역할이 없는 사람 자리에 넣는 투명 아이콘(pos_blank.png). 역할 아이콘 칸을 세로로 맞추려고 쓴다. 없으면 ''.
function blankIcon() {
  const id = emojiIds.get('pos_blank');
  return id ? `<:pos_blank:${id}>` : '';
}

// 이름 앞에 붙일 글자. 이모지가 준비됐으면 이모지(롤은 단계 숫자를 뒤에), 아니면 "[다2]" 같은 글자.
function tierBadge(gk, tier) {
  const game = baseGame(gk);
  if (!tier || !findTier(game, tier.tier)) return '';
  const id = tierEmojiId(game, tier);
  if (!id) return `\`${tierLabel(game, tier, { short: true })}\``;
  const t = findTier(game, tier.tier);
  const tail = (game === 'lol' || game === 'overwatch') && t.divs && tier.div ? `${tier.div}` : ''; // 티어마다 그림 하나인 게임은 단계 숫자를 뒤에
  return `<:${emojiFileName(game, tier)}:${id}>${tail}`; // 마우스를 올렸을 때 :lol_diamond: 처럼 티어 이름이 보이게(예전엔 :t:)
}

module.exports = {
  LADDERS,
  POSITIONS,
  POSITION_WORD,
  OW_ROLES,
  splitKey,
  ladderOf,
  positionName,
  hasPositions,
  parsePositionToken,
  owRole,
  hasTiers,
  findTier,
  tierScore,
  tierFromScore,
  tierLabel,
  parseTierToken,
  getTier,
  getRoleTiers,
  hasRoleQueueTier,
  openTier,
  getPositions,
  setTier,
  setPositions,
  resetAll,
  onChange,
  setName,
  refreshFileNames,
  ensureTierEmojis,
  tierEmojiId,
  tierEmojiTag,
  positionEmojiId,
  positionEmoji,
  positionIcon,
  blankIcon,
  // 화면 모음 전용: 봇 없이 포지션 아이콘을 그릴 수 있게 자리표시 ID를 넣는다
  usePreviewPositionEmojis: () => allEmojiFiles().filter(f => f.startsWith('pos_')).forEach(f => emojiIds.set(f, '0')),
  EMOJI_DIR,
  tierBadge,
};

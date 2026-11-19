// 맵.js — 내전 팀 카드의 🗺️ 맵 뽑기: 게임별 맵 목록(전체 균등 확률)·추첨·연출 프레임 계산.
// 이미지는 assets/맵/<게임>/<키>.jpg (원본), assets/맵/결과/<게임>/<키>.jpg (이름이 박힌 결과 — scripts/맵결과이미지.py 로 만든다).
// 스타디움 전용 맵(Place Lacroix·Arena Victoriae·Gogadoro·Wuxing University·Redwood Dam)은 일반 내전용이 아니라서 뺐다.
const path = require('path');

const m = (key, name) => ({ key, name });
const MAP_POOLS = {
  valorant: [
    m('abyss', '어비스'), m('ascent', '어센트'), m('bind', '바인드'), m('breeze', '브리즈'), m('corrode', '코로드'),
    m('fracture', '프랙처'), m('haven', '헤이븐'), m('icebox', '아이스박스'), m('lotus', '로터스'), m('pearl', '펄'),
    m('split', '스플릿'), m('summit', '서밋'), m('sunset', '선셋'),
  ],
  overwatch: [
    // 호위
    m('circuit-royal', '서킷 로얄'), m('dorado', '도라도'), m('grimsvotn', '감시 기지: 그림스뵈튼'), m('havana', '하바나'),
    m('junkertown', '쓰레기촌'), m('rialto', '리알토'), m('route-66', '66번 국도'), m('shambali-monastery', '샴발리 수도원'),
    m('watchpoint-gibraltar', '감시 기지: 지브롤터'),
    // 혼합
    m('blizzard-world', '블리자드 월드'), m('eichenwalde', '아이헨발데'), m('hollywood', '할리우드'), m('kings-row', '왕의 길'),
    m('midtown', '미드타운'), m('neon-junction', '네온 교차로'), m('numbani', '눔바니'), m('paraiso', '파라이수'),
    // 밀기
    m('colosseo', '콜로세오'), m('esperanca', '이스페란사'), m('new-queen-street', '뉴 퀸 스트리트'), m('runasapi', '루나사피'),
    // 쟁탈
    m('antarctic-peninsula', '남극 반도'), m('busan', '부산'), m('ilios', '일리오스'), m('lijiang-tower', '리장 타워'),
    m('nepal', '네팔'), m('oasis', '오아시스'), m('samoa', '사모아'),
    // 플래시포인트
    m('aatlis', '아틀리스'), m('new-junk-city', '뉴 정크 시티'), m('suravasa', '수라바사'),
  ],
};

// 연출: 돌아가는 프레임 사이의 간격(ms). 합 7초, 뒤로 갈수록 느려진다. 이 뒤에 이름이 박힌 확정 프레임이 한 번 더 나온다.
const SPIN_DELAYS_MS = [450, 500, 550, 650, 800, 1000, 1300, 1750];

const ASSET_DIR = path.join(__dirname, '..', '..', 'assets', '맵');

const hasMapPool = (game) => !!MAP_POOLS[game];

// 맵마다 같은 확률. 풀이 없는 게임이면 null.
function pickMap(game, rnd = Math.random) {
  const pool = MAP_POOLS[game];
  if (!pool) return null;
  return pool[Math.min(pool.length - 1, Math.floor(rnd() * pool.length))];
}

const mapName = (game, key) => MAP_POOLS[game]?.find(x => x.key === key)?.name ?? '';
const mapImageFile = (game, key) => path.join(ASSET_DIR, game, `${key}.jpg`);
const mapResultFile = (game, key) => path.join(ASSET_DIR, '결과', game, `${key}.jpg`);

// 맵 투표 화면 연출: 카드 3장이 나란히 놓이고 하이라이트가 칸 사이를 옮겨 다니다 당첨 맵의 칸에서 멈춘다.
// 프레임 그림은 assets/맵/연출/<게임>/<당첨키>_<칸>.jpg (scripts/맵연출이미지.py). 카드 구성 규칙은 그 스크립트와 같아야 한다:
// 당첨 맵은 (풀 순번 % 3) 번째 칸, 나머지 두 칸은 풀의 순번+1·순번+5 번째 맵.
const VOTE_SLOTS = 3;
const mapSpinFile = (game, key, slot) => path.join(ASSET_DIR, '연출', game, `${key}_${slot}.jpg`);
function voteCards(game, key) {
  const pool = MAP_POOLS[game] ?? [];
  const idx = pool.findIndex(x => x.key === key);
  if (idx < 0) return [];
  const others = [(idx + 1) % pool.length, (idx + 5) % pool.length];
  const p = idx % VOTE_SLOTS;
  let o = 0;
  return Array.from({ length: VOTE_SLOTS }, (_, s) => pool[s === p ? idx : others[o++]].key);
}
// 하이라이트가 켜질 칸(SPIN_DELAYS_MS 와 같은 길이). 이웃한 칸은 항상 다르고, 마지막은 당첨 맵의 칸이다.
function spinFrames(game, finalKey) {
  const pool = MAP_POOLS[game] ?? [];
  const p = Math.max(0, pool.findIndex(x => x.key === finalKey)) % VOTE_SLOTS;
  const last = SPIN_DELAYS_MS.length - 1;
  return SPIN_DELAYS_MS.map((_, i) => (((p - (last - i)) % VOTE_SLOTS) + VOTE_SLOTS) % VOTE_SLOTS);
}

module.exports = { MAP_POOLS, SPIN_DELAYS_MS, hasMapPool, pickMap, mapName, mapImageFile, mapSpinFile, mapResultFile, voteCards, spinFrames };

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

// 연출: 돌아가는 프레임 사이의 간격(ms). 합 5초, 뒤로 갈수록 느려진다. 이 뒤에 이름이 박힌 확정 프레임이 한 번 더 나온다.
const SPIN_DELAYS_MS = [600, 700, 900, 1200, 1600];

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

// 돌아가는 동안 보여 줄 맵 key 들(SPIN_DELAYS_MS 와 같은 길이). 이웃한 프레임은 서로 다르고,
// 마지막 프레임은 당첨 맵이 아니다(바로 뒤에 당첨 맵의 확정 프레임이 오므로 같은 그림이 연달아 보이지 않게).
function spinFrames(game, finalKey, rnd = Math.random) {
  const pool = MAP_POOLS[game] ?? [];
  const frames = [];
  for (let i = 0; i < SPIN_DELAYS_MS.length; i++) {
    const last = i === SPIN_DELAYS_MS.length - 1;
    const choices = pool.filter(x => x.key !== frames[i - 1] && !(last && x.key === finalKey));
    frames.push(choices[Math.min(choices.length - 1, Math.floor(rnd() * choices.length))].key);
  }
  return frames;
}

module.exports = { MAP_POOLS, SPIN_DELAYS_MS, hasMapPool, pickMap, mapName, mapImageFile, mapResultFile, spinFrames };

// 알바트리온(가칭) 속성 기믹: 속성 순환·억제 게이지·에스카톤 전멸기. 순수 함수 모듈(DB·디스코드 의존 없음).
// 상태(AlatState)는 JSON 직렬화 가능한 평범한 객체라 battle.alat 로 그대로 저장·복원된다.

const ELEMENTS = ['fire', 'water', 'thunder', 'ice', 'dragon'];
// 몬스터 속성 → 그 속성을 억제하는 직업 키 (화←수←뇌←빙←화)
const COUNTER = { fire: 'water', water: 'thunder', thunder: 'ice', ice: 'fire' };
const ELEMENT_EMOJI = { none: '⚪', fire: '🔥', water: '💧', thunder: '⚡', ice: '❄️', dragon: '🐉' };
const ELEMENT_NAME = { none: '무', fire: '화', water: '수', thunder: '뇌', ice: '빙', dragon: '용' };

const K = {
  PHASE_MIN: 1, PHASE_MAX: 3,
  CYCLE_MIN: 9, CYCLE_MAX: 11,
  GAUGE_MAX: 100,
  ATTACK_GAIN: 10, SKILL_GAIN: 29,
  DRAGON_EFF: 1 / 3,
  ESCATON_HIT_RATE: 0.5, GUARD_RATE: 0.3, FROST_RATE: 0.6,
  RESIST_RATE: 0.7, WEAK_RATE: 1.3, // 기술 속성 대 유저 속성: 반감·약점 피해 배율
};

const randInt = (rng, a, b) => a + Math.floor(rng() * (b - a + 1));

function initState(rng) {
  return {
    element: 'none', // 전투 시작은 무속성(억제 게이지도 안 오른다) — 첫 속성 변화 때 다섯 속성 중 하나로 바뀐다
    prev: null,
    shifted: false, // 방금 턴 끝에 속성이 바뀌었으면 true(다음 advanceTurn 때까지) — 화면이 '속성 전환' 연출을 띄운다
    phaseLeft: randInt(rng, K.PHASE_MIN, K.PHASE_MAX),
    cycleTurn: 1,
    cycleLen: randInt(rng, K.CYCLE_MIN, K.CYCLE_MAX),
    gauge: 0,
    escatons: 0,
  };
}

function gaugeGain(state, roleKey, action) {
  const base = action === 'skill' ? K.SKILL_GAIN : action === 'attack' ? K.ATTACK_GAIN : 0;
  if (!base) return 0;
  if (state.element === 'dragon') return base * K.DRAGON_EFF;
  return COUNTER[state.element] === roleKey ? base : 0;
}

function addGauge(state, amount) {
  // 용 속성의 1/3 효율(5/3 등)이 쌓이며 99.99999…가 되어 '100/100인데 억제 실패'가 나지 않게 소수 둘째 자리로 맞춘다
  state.gauge = Math.max(0, Math.min(K.GAUGE_MAX, Math.round((state.gauge + amount) * 100) / 100));
}

// 턴이 끝날 때 한 번 호출
function advanceTurn(state, rng) {
  state.shifted = false;
  state.phaseLeft--;
  if (state.phaseLeft <= 0) {
    const choices = ELEMENTS.filter(e => e !== state.element);
    state.prev = state.element;
    state.shifted = true;
    state.element = choices[Math.floor(rng() * choices.length)];
    state.phaseLeft = randInt(rng, K.PHASE_MIN, K.PHASE_MAX);
  }
  state.cycleTurn++;
}

function isEscatonTurn(state) {
  return state.cycleTurn === state.cycleLen;
}

function resolveEscaton(state, members, opts, rng) {
  const suppressed = state.gauge >= K.GAUGE_MAX;
  const damage = members.map(m => {
    if (!m.hp || m.hp <= 0) return 0;
    if (!suppressed) return m.hp;
    const raw = opts.maxHp * K.ESCATON_HIT_RATE * (m.guarding ? K.GUARD_RATE : 1) * (opts.frost ? K.FROST_RATE : 1);
    return Math.max(1, Math.round(raw));
  });
  state.gauge = 0;
  state.cycleTurn = 0;
  state.cycleLen = randInt(rng, K.CYCLE_MIN, K.CYCLE_MAX);
  state.escatons++;
  // 에스카톤 직후엔 무속성으로 돌아간다 — 이 턴 끝의 advanceTurn 이 한 번, 다음 턴 끝이 한 번 더 깎으므로 무속성은 다음 1턴 동안 유지된다.
  state.prev = state.element;
  state.element = 'none';
  state.shifted = false;
  state.phaseLeft = 2;
  return { suppressed, damage };
}

// 공격은 지금 속성과 상관없이 몬스터 데이터의 alat.attacks = { 기술키: 가중치 } 에서 가중 무작위.
// (지금 속성은 방어 상성 — 어느 직업이 억제 게이지를 올리는지 — 에만 쓰인다)
function pickIntent(state, monster, rng) {
  if (isEscatonTurn(state)) return 'smash';
  const table = monster.alat.attacks;
  const keys = Object.keys(table);
  const total = keys.reduce((s, k) => s + table[k], 0);
  let r = rng() * total;
  for (const k of keys) { r -= table[k]; if (r < 0) return k; }
  return keys[keys.length - 1];
}

// 기술 속성(attackEl) → 그 기술에 맞은 유저(role)가 받는 피해 배율.
// 그 속성을 억제하는 직업(COUNTER[속성])은 반감, 그 직업의 속성을 이기는 속성(COUNTER[직업])에 맞으면 약점. 용·무속성은 1
function elementRate(attackEl, role) {
  if (!COUNTER[attackEl]) return 1;
  if (COUNTER[attackEl] === role) return K.RESIST_RATE;
  if (COUNTER[role] === attackEl) return K.WEAK_RATE;
  return 1;
}

function statusLine(state) {
  const filled = Math.round(state.gauge / K.GAUGE_MAX * 8);
  const bar = '▰'.repeat(filled) + '▱'.repeat(8 - filled);
  const left = state.cycleLen - state.cycleTurn;
  const esc = left <= 0 ? '에스카톤 지금!' : `에스카톤 ${left}턴 뒤`;
  return `${ELEMENT_EMOJI[state.element]} ${ELEMENT_NAME[state.element]} 속성 · 억제 ${bar} ${Math.round(state.gauge)}/${K.GAUGE_MAX} · ${esc}`;
}

module.exports = {
  ELEMENTS, COUNTER, ELEMENT_EMOJI, ELEMENT_NAME, K,
  initState, gaugeGain, addGauge, advanceTurn, isEscatonTurn, resolveEscaton, pickIntent, elementRate, statusLine,
};

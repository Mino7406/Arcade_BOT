// 알바트리온 속성 기믹 순수 엔진 테스트. 직접 실행: node tests/raid/알바트리온테스트.js
const path = require('path');
const A = require(path.join(__dirname, '../../handlers/레이드/알바트리온.js'));
const { ELEMENTS, ELEMENT_EMOJI, K } = A;
const assert = (c, m) => { if (!c) { console.error('❌', m); process.exitCode = 1; } else console.log('✅', m); };

function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rng = makeRng(12345);
const inRange = (v, a, b) => v >= a && v <= b;
const stateOf = (element, extra = {}) => ({ element, prev: null, phaseLeft: 2, cycleTurn: 1, cycleLen: 10, gauge: 0, escatons: 0, ...extra });

// initState
{
  const s = A.initState(rng);
  assert(ELEMENTS.includes(s.element), 'initState: 속성이 유효');
  assert(inRange(s.phaseLeft, 1, 3), 'initState: phaseLeft 1~3');
  assert(inRange(s.cycleLen, 10, 12), 'initState: cycleLen 10~12');
  assert(s.gauge === 0 && s.cycleTurn === 1 && s.escatons === 0 && s.prev === null, 'initState: 초기값');
  assert(JSON.stringify(JSON.parse(JSON.stringify(s))) === JSON.stringify(s), 'initState: JSON 직렬화 왕복 동일');
}

// gaugeGain
{
  const fire = stateOf('fire');
  assert(A.gaugeGain(fire, 'water', 'attack') === K.ATTACK_GAIN, 'gaugeGain: 화 ← 수 공격');
  assert(A.gaugeGain(fire, 'water', 'skill') === K.SKILL_GAIN, 'gaugeGain: 화 ← 수 스킬');
  assert(A.gaugeGain(fire, 'fire', 'attack') === 0, 'gaugeGain: 화 ← 화 0');
  assert(A.gaugeGain(fire, 'thunder', 'skill') === 0, 'gaugeGain: 화 ← 뇌 0');
  assert(A.gaugeGain(stateOf('ice'), 'fire', 'attack') === K.ATTACK_GAIN, 'gaugeGain: 빙 ← 화');
  const dragon = stateOf('dragon');
  assert(['fire', 'water', 'thunder', 'ice'].every(r => A.gaugeGain(dragon, r, 'attack') === K.ATTACK_GAIN * K.DRAGON_EFF), 'gaugeGain: 용은 전 직업 1/3');
}

// addGauge
{
  const s = stateOf('fire', { gauge: 95 });
  A.addGauge(s, 20);
  assert(s.gauge === K.GAUGE_MAX, 'addGauge: 상한 100');
  A.addGauge(s, -500);
  assert(s.gauge === 0, 'addGauge: 하한 0');
}

// advanceTurn
{
  const s = A.initState(rng);
  const seen = new Set([s.element]);
  let sameConsecutive = false, badPhase = false, runLen = s.phaseLeft, sawRun = 0;
  let cur = s.element;
  for (let i = 0; i < 5000; i++) {
    const before = s.element;
    A.advanceTurn(s, rng);
    if (s.element !== before) {
      if (s.element === before) sameConsecutive = true;
      seen.add(s.element);
      if (!inRange(s.phaseLeft, 1, 3)) badPhase = true;
    }
    s.cycleTurn = 1; // 에스카톤 판정과 무관하게 순환만 검사
  }
  assert(!sameConsecutive, 'advanceTurn: 같은 속성 연속 없음');
  assert(!badPhase, 'advanceTurn: 구간 길이 1~3');
  assert(seen.has('dragon'), 'advanceTurn: dragon 등장');
  assert(ELEMENTS.every(e => seen.has(e)), 'advanceTurn: 다섯 속성 모두 등장');

  // 속성이 바뀔 때마다 직전과 달라야 하고, 구간 길이가 1~3인지 따로 측정
  const t = A.initState(rng);
  let prevEl = t.element, len = 0, ok = true, runs = 0;
  for (let i = 0; i < 5000; i++) {
    A.advanceTurn(t, rng);
    len++;
    if (t.element !== prevEl) { if (!inRange(len, 1, 3)) ok = false; len = 0; prevEl = t.element; runs++; }
  }
  assert(ok && runs > 100, 'advanceTurn: 실제 구간 길이가 1~3');
  const u = A.initState(rng);
  const before = u.cycleTurn;
  A.advanceTurn(u, rng);
  assert(u.cycleTurn === before + 1, 'advanceTurn: cycleTurn 증가');
}

// isEscatonTurn
{
  const s = stateOf('fire', { cycleLen: 11, cycleTurn: 1 });
  const hits = [];
  for (let t = 1; t <= 11; t++) { s.cycleTurn = t; if (A.isEscatonTurn(s)) hits.push(t); }
  assert(hits.length === 1 && hits[0] === 11, 'isEscatonTurn: cycleLen에서만 true');
}

// resolveEscaton
{
  const members = [{ hp: 100, guarding: false }, { hp: 100, guarding: true }, { hp: 0, guarding: false }];
  const s = stateOf('fire', { gauge: 100, cycleTurn: 11, cycleLen: 11 });
  const r = A.resolveEscaton(s, members, { maxHp: 100, frost: false }, rng);
  assert(r.suppressed === true, 'resolveEscaton: 100이면 억제 성공');
  assert(r.damage[0] === 60, 'resolveEscaton: 기본 피해 60');
  assert(r.damage[1] === 18, 'resolveEscaton: 방어 피해 18');
  assert(r.damage[2] === 0, 'resolveEscaton: hp 0인 사람 피해 0');
  assert(s.gauge === 0 && s.cycleTurn === 0 && s.escatons === 1 && inRange(s.cycleLen, 10, 12), 'resolveEscaton: 새 사이클');

  const s2 = stateOf('fire', { gauge: 100 });
  const r2 = A.resolveEscaton(s2, [{ hp: 100, guarding: false }], { maxHp: 100, frost: true }, rng);
  assert(r2.damage[0] === 36, 'resolveEscaton: 프로스트 월 36');

  const s3 = stateOf('fire', { gauge: 99 });
  const r3 = A.resolveEscaton(s3, [{ hp: 77, guarding: false }, { hp: 12, guarding: true }, { hp: 0, guarding: false }], { maxHp: 100, frost: false }, rng);
  assert(r3.suppressed === false, 'resolveEscaton: 99는 실패');
  assert(r3.damage[0] === 77 && r3.damage[1] === 12 && r3.damage[2] === 0, 'resolveEscaton: 실패 시 각자 hp만큼(즉사)');
}

// pickIntent
{
  const monster = { alat: { moves: { fire: { attack: 3, flame: 1 }, water: { attack: 1 }, thunder: { attack: 1 }, ice: { attack: 1 }, dragon: { attack: 1, roar: 2 } } } };
  const esc = stateOf('fire', { cycleTurn: 10, cycleLen: 10 });
  assert(A.pickIntent(esc, monster, rng) === 'smash', 'pickIntent: 에스카톤 턴은 smash');
  const normal = stateOf('fire', { cycleTurn: 3, cycleLen: 10 });
  let always = true;
  for (let i = 0; i < 500; i++) if (!Object.keys(monster.alat.moves.fire).includes(A.pickIntent(normal, monster, rng))) always = false;
  assert(always, 'pickIntent: 속성별 기술 중에서만 고름');
}

// statusLine
{
  const line = A.statusLine(stateOf('fire', { gauge: 34, cycleTurn: 6, cycleLen: 10 }));
  assert(line.includes(ELEMENT_EMOJI.fire) && line.includes('에스카톤') && line.includes('/100'), 'statusLine: 이모지·에스카톤·/100 포함');
  assert(A.statusLine(stateOf('ice', { cycleTurn: 10, cycleLen: 10 })).includes('에스카톤 지금'), 'statusLine: 에스카톤 턴 문구');
}

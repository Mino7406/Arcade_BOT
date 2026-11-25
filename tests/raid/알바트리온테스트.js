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

// ── Task 2: 직업 세트 일반화 ──
const E = require(path.join(__dirname, '../../handlers/레이드/전투.js'));
{
  assert(JSON.stringify(E.rolesOfMonster({})) === JSON.stringify(['sword', 'archer', 'tank', 'healer']), 'rolesOfMonster: 기본 세트');
  assert(JSON.stringify(E.rolesOfMonster({ partyClasses: 'elemental' })) === JSON.stringify(['fire', 'water', 'thunder', 'ice']), 'rolesOfMonster: elemental 세트');
  assert(E.roleTitle('fire') === '🔥', 'roleTitle: 속성 직업은 이모지만');
  assert(E.roleTitle('sword') === '⚔️ **검사**', 'roleTitle: 기존 직업');

  const slime = E.MONSTERS[0];
  const party = ['sword', 'archer', 'tank', 'healer'].map((role, i) => ({ userId: 'u' + i, name: 'P' + i, role }));
  const b = E.createBattle(slime, party, makeRng(1));
  assert(JSON.stringify(b.roleOrder) === JSON.stringify(E.ROLE_ORDER), 'createBattle: 슬라임 roleOrder 기본');
  for (const m of b.members) E.choose(b, m.userId, 'attack');
  let threw = false, res;
  try { res = E.resolveTurn(b, makeRng(2)); } catch (e) { threw = true; console.error(e); }
  assert(!threw && (res === null || typeof res === 'string'), 'resolveTurn: 기존 4직업 한 턴 정상');
}
{
  const fake = { ...JSON.parse(JSON.stringify(E.MONSTERS[0])), partyClasses: 'elemental' };
  const party = ['fire', 'water', 'thunder', 'ice'].map((role, i) => ({ userId: 'e' + i, name: 'E' + i, role }));
  const fresh = (seed) => E.createBattle(fake, party, makeRng(seed));
  const skillAll = (b, who) => { for (const m of b.members) { m.cooldown = 0; E.choose(b, m.userId, who.includes(m.role) ? 'skill' : 'guard'); } };

  // fire 스킬 피해 범위
  let ok = true;
  for (let i = 0; i < 100; i++) {
    const b = fresh(100 + i); b.shieldTurn = 0;
    for (const m of b.members) { m.cooldown = 0; E.choose(b, m.userId, m.role === 'fire' ? 'skill' : 'guard'); }
    E.resolveTurn(b, makeRng(200 + i));
    const v = b.lastTurn.acts.e0?.value;
    if (!(v >= 270 && v <= 320)) ok = false;
  }
  assert(ok, 'fire 스킬 피해 270~320 (100회)');

  // water 스킬: 회복·부활
  {
    const b = fresh(7);
    const dead = b.members.find(m => m.role === 'thunder'); dead.hp = 0;
    const hurt = b.members.find(m => m.role === 'fire'); hurt.hp = 50;
    skillAll(b, ['water']);
    E.resolveTurn(b, makeRng(8));
    assert(dead.hp > 0 && hurt.hp > 50, 'water 스킬: 회복·부활');
  }

  // thunder 스킬 치명타 가능
  {
    let crit = false;
    for (let i = 0; i < 200 && !crit; i++) {
      const b = fresh(300 + i); skillAll(b, ['thunder']);
      E.resolveTurn(b, makeRng(400 + i));
      if (b.lastTurn.acts.e2?.crit) crit = true;
    }
    assert(crit, 'thunder 스킬: 치명타 발생');
  }

  // ice 스킬: 같은 시드 대비 받는 피해 0.6배
  {
    let worst = 0, checked = 0;
    for (let i = 0; i < 40; i++) {
      const a = fresh(500 + i), c = fresh(500 + i);
      a.intent = c.intent = 'attack';
      for (const b of [a, c]) for (const m of b.members) { m.cooldown = 0; E.choose(b, m.userId, 'potion'); } // 회복약은 난수를 쓰지 않아 두 전투의 몬스터 굴림이 같다
      c.members.find(m => m.role === 'ice').choice = 'skill';
      E.resolveTurn(a, makeRng(600 + i)); E.resolveTurn(c, makeRng(600 + i));
      for (const m of a.members.filter(x => x.role !== 'ice')) {
        const dA = 100 - m.hp, dC = 100 - c.members.find(x => x.userId === m.userId).hp;
        if (dA > 5) { checked++; worst = Math.max(worst, Math.abs(Math.round(dA * 0.6) - dC)); }
      }
    }
    assert(checked > 0 && worst <= 1, `ice 스킬: 받는 피해 ×0.6 (표본 ${checked}, 최대 오차 ${worst})`);
  }
}

// ── Task 3: 몬스터 데이터와 전투 훅 ──
{
  const mon = E.loadMonsters().find(m => m.id === 'alatreon');
  assert(!!mon, '알바트리온 몬스터 로드(꺼진 몬스터도 loadMonsters에는 있음)');
  assert(mon && E.monsterProblems(mon).length === 0, 'monsterProblems: 알바트리온 검증 통과');
  assert(!E.MONSTERS.some(m => m.id === 'alatreon') && !E.HARD_MONSTERS.some(m => m.id === 'alatreon'), 'enabled:false라 출현 후보에는 없음');
  const clone = () => JSON.parse(JSON.stringify(mon));
  const bad1 = clone(); bad1.partyClasses = 'default';
  assert(E.monsterProblems(bad1).some(p => p.includes('alat')), 'monsterProblems: partyClasses가 elemental이 아니면 alat 문제');
  const bad2 = clone(); bad2.alat.moves.fire = { nothing: 1 };
  assert(E.monsterProblems(bad2).some(p => p.startsWith('alat')), 'monsterProblems: alat 기술이 moves에 없으면 문제');
  const bad3 = clone(); bad3.partyClasses = 'zzz';
  assert(E.monsterProblems(bad3).some(p => p.includes('partyClasses')), 'monsterProblems: 모르는 partyClasses');

  const KEYS = ['fire', 'water', 'thunder', 'ice'];
  const mk = (keys = KEYS, seed = 1) => E.createBattle(mon, keys.map((role, i) => ({ userId: role, name: role + i, role })), makeRng(seed), { minParty: 4 });
  const act = (b, map, def = 'guard') => { for (const m of b.members) { m.cooldown = 0; E.choose(b, m.userId, map[m.role] ?? def); } };
  const calm = (b, el = 'fire') => { b.alat.element = el; b.alat.phaseLeft = 3; b.intent = 'attack'; };

  { // 생성
    const b = mk();
    assert(!!b.alat && Object.keys(mon.moves).includes(b.intent), 'createBattle: battle.alat 있고 intent가 moves의 키');
    assert(!E.createBattle(E.MONSTERS[0], [{ userId: 'a', name: 'a', role: 'sword' }], makeRng(1)).alat, 'createBattle: 일반 몬스터엔 alat 없음');
  }

  { // 사이클: 에스카톤 턴에 smash, 처리 뒤 새 사이클
    const b = mk(KEYS, 3); const rng2 = makeRng(9);
    let guard = 0, sawEscaton = false, escIntent = false, cycleAfter = null;
    while (guard++ < 40 && !sawEscaton) {
      const atEsc = b.alat.cycleTurn === b.alat.cycleLen;
      if (atEsc) { escIntent = b.intent === 'smash'; b.alat.gauge = 100; }
      act(b, {}, 'attack');
      const r = E.resolveTurn(b, rng2);
      if (atEsc) { sawEscaton = !!b.lastTurn.escaton; cycleAfter = b.alat.cycleTurn; }
      if (r) break;
    }
    assert(escIntent, '사이클: 에스카톤 턴의 intent는 smash');
    assert(sawEscaton && cycleAfter <= 2, `사이클: last.escaton 생성, 새 사이클로 복귀(cycleTurn=${cycleAfter})`);
  }

  { // 게이지 가득 → 억제 성공
    const b = mk(); b.alat.cycleTurn = b.alat.cycleLen; b.intent = 'smash'; b.alat.gauge = 100;
    act(b, {}, 'attack');
    const r = E.resolveTurn(b, makeRng(5));
    assert(r === null && b.lastTurn.escaton?.suppressed === true, '에스카톤: 게이지 100이면 억제 성공·계속');
    assert(b.members.every(m => m.hp === E.PLAYER_MAX_HP - 60), '에스카톤: 방어 안 하면 전원 HP -60');
  }
  { // 방어·프로스트 월
    const b = mk(); b.alat.cycleTurn = b.alat.cycleLen; b.intent = 'smash'; b.alat.gauge = 100;
    act(b, { ice: 'skill' }, 'guard');
    E.resolveTurn(b, makeRng(5));
    assert(b.members.every(m => m.hp === E.PLAYER_MAX_HP - (m.role === 'ice' ? 36 : 11)), '에스카톤: 방어+프로스트 월 중첩(HP -11), 시전자는 방어 안 해 -36');
  }
  { // 게이지 0 → 전멸
    const b = mk(); b.alat.cycleTurn = b.alat.cycleLen; b.intent = 'smash'; b.alat.gauge = 0;
    act(b, {}, 'guard');
    const r = E.resolveTurn(b, makeRng(5));
    assert(r === 'wipe' && b.log.some(l => l.includes('에스카톤')), '에스카톤: 게이지 0이면 wipe, 로그에 에스카톤');
  }
  { // 쓰러진 상성 직업
    const b = mk(); calm(b, 'fire');
    b.members.find(m => m.role === 'water').hp = 0;
    act(b, {}, 'attack');
    E.resolveTurn(b, makeRng(5));
    assert(b.alat.gauge === 0, '쓰러진 상성 직업은 게이지를 올리지 못함');
    const c = mk(); c.alat.cycleTurn = c.alat.cycleLen; c.intent = 'smash'; c.alat.gauge = 100;
    const dead = c.members.find(m => m.role === 'thunder'); dead.hp = 0;
    act(c, {}, 'attack');
    E.resolveTurn(c, makeRng(5));
    assert(dead.hp === 0 && c.members.filter(m => m !== dead).every(m => m.hp === E.PLAYER_MAX_HP - 60), '에스카톤: 살아 있는 사람만 피해');
  }
  { // 3인 파티, 속성 담당 없음
    const b = mk(['fire', 'water', 'thunder'], 4); const rng2 = makeRng(11);
    let ok = true;
    for (let i = 0; i < 60; i++) {
      calm(b, ['fire', 'water', 'thunder', 'ice', 'dragon'][i % 5]);
      for (const m of b.members) m.hp = Math.max(m.hp, 50);
      act(b, {}, 'attack');
      const r = E.resolveTurn(b, rng2);
      if (!Number.isFinite(b.alat.gauge)) ok = false;
      if (r) break;
    }
    assert(ok, '3인 파티: 담당 없는 속성에서도 게이지가 유한');
    const c = mk(['fire', 'water', 'thunder'], 4); calm(c, 'ice'); act(c, {}, 'attack'); E.resolveTurn(c, makeRng(1));
    assert(c.alat.gauge === K.ATTACK_GAIN, '3인 파티: 빙 속성엔 화 직업이 올림');
    const d = mk(['fire', 'water', 'thunder'], 4); calm(d, 'thunder'); act(d, {}, 'attack'); E.resolveTurn(d, makeRng(1));
    assert(d.alat.gauge === 0, '3인 파티: 뇌 속성은 담당(빙)이 없어 0');
  }
  { // 직렬화
    const b = mk(); const rng2 = makeRng(21);
    for (let i = 0; i < 3; i++) { calm(b, 'fire'); act(b, {}, 'attack'); E.resolveTurn(b, rng2); }
    const restored = JSON.parse(JSON.stringify(b));
    const before = restored.alat.cycleTurn;
    let threw = false;
    try { act(restored, {}, 'attack'); E.resolveTurn(restored, makeRng(22)); } catch (e) { threw = true; console.error(e); }
    assert(!threw && restored.alat.cycleTurn === before + 1, '직렬화 복원 뒤에도 resolveTurn 진행');
  }
  { // 공격·스킬당 게이지
    const a = mk(); calm(a, 'fire'); act(a, { water: 'attack' }, 'guard'); E.resolveTurn(a, makeRng(2));
    assert(a.alat.gauge === K.ATTACK_GAIN, '게이지: 상성 직업 공격 +ATTACK_GAIN');
    const s = mk(); calm(s, 'fire'); act(s, { water: 'skill' }, 'guard'); E.resolveTurn(s, makeRng(2));
    assert(s.alat.gauge === K.SKILL_GAIN, '게이지: 상성 직업 스킬 +SKILL_GAIN');
    const n = mk(); calm(n, 'fire'); act(n, { thunder: 'attack' }, 'guard'); E.resolveTurn(n, makeRng(2));
    assert(n.alat.gauge === 0, '게이지: 비상성 직업은 0');
  }
}

// 레이드전투.js — 레이드의 턴제 전투 규칙과 몬스터 데이터.
// 디스코드 객체를 전혀 모르는 순수 로직이라, 화면·버튼·타이머(handlers/레이드.js)와 떨어져서
// 시뮬레이션으로 밸런스를 따로 돌려볼 수 있다.
//
// 한 턴의 흐름: 살아있는 파티원이 각자 행동을 고른다(못 고르면 자동 공격) → 아군 행동 처리
// → 몬스터가 지난 턴에 예고한 행동 실행 → 다음 행동 예고. 몬스터 HP가 절반 밑이면 분노해 더 세진다.

const fs = require('fs');
const path = require('path');

const PLAYER_MAX_HP = 100;
const POTIONS_PER_BATTLE = 2;
const POTION_HEAL = 45;
const GUARD_DAMAGE_RATE = 0.3;   // 방어: 받는 피해 70% 감소
const TAUNT_DAMAGE_RATE = 0.3;   // 도발 중인 수호자: 받는 피해 70% 감소
// 분노 조건(rage.hpRatio · rage.damageRate)과 기술 효과의 세기(effectRate · effectTurns · useBelowHp),
// 상태이상의 이름·이모지(status — 슬라임은 💧점액·💫기절, 다른 몬스터는 🔥화상·❄️빙결처럼 전용으로)는
// 몬스터마다 다르게 줄 수 있게 몬스터 파일(Monster/*.json)이 정한다. 효과 종류의 규칙만 여기 있다.
//   slow: 맞은 사람이 effectTurns턴 동안 주는 피해 × effectRate (치유사 스킬로 해제)
//   stun: 방어하지 않은 사람은 다음 턴 행동 불가
//   shield: 다음 턴 동안 몬스터가 받는 피해 × effectRate
//   poison: 맞은 사람에게 독 stacks중첩(최대 maxStacks)을 쌓고 남은 턴을 effectTurns로 새로 맞춘다.
//           다음 턴부터 아군 행동이 끝날 때마다 중첩 × tickDamage × 인원별 피해 배율만큼 HP가 준다(쓰러질 수 있음).
//           치유사 스킬(전원)이나 회복약(본인)으로 해제.
//   confuse: 다음 턴 고른 행동이 effectRate 확률로 빗나간다(헛손질 — 회복약·쿨타임은 쓰지 않음). 방어는 빗나가지 않는다.
//           치유사 스킬로 해제.
//   guardBlocks: true면 방어한 사람에게는 그 기술의 상태이상이 걸리지 않는다(stun은 원래 그렇다).
//   healPerStack(재생 기술): 파티에 쌓인 독 중첩 하나당 최대 HP × healPerStack을 더 회복한다(중첩 합 × 4 ÷ 인원으로 4인 기준 환산).
//   buffRate: 이 기술을 쓰면 공격력 증가 — 다음 피해 기술 1회의 피해 × buffRate(쓰면 사라짐, 화면에 '공격력 증가' 배지).
//   냉기(몬스터 파일 최상위 chill 블록이 있을 때만 — 얼음 큐브): 파티원마다 냉기 중첩(chillStacks).
//           행동하는 즉시 방어 +guardStacks · 공격·스킬 -melt(0 밑으로 안 감) · 치유사 스킬은 전원 0 · 회복약은 본인 0.
//           아군 행동이 다 끝난 뒤와 몬스터 기술로 쌓인 뒤 freezeAt 이상이면 빙결(freezeStatus — 다음 턴 행동 불가, 기절 규칙), 냉기 0.
//   chill(효과): 맞은 사람 냉기 +stacks(분노 중 rageStacks). 방어해도 걸린다.
//   chillOnHit(보호막 기술): 그 보호막이 켜진 턴에 몬스터에게 피해를 준 사람은 녹는 대신 냉기 +chillOnHit(가시 얼음 갑옷).
// 인원별 몬스터 피해 배율. 보통 플레이 승률이 인원과 상관없이 80~90%가 되게 맞춘 값(치유사·수호자가 다 있는 4인은 훨씬 버티므로 크게).
const PARTY_DAMAGE_RATE = { 1: 1.35, 2: 1.07, 3: 1.28, 4: 2.0 }; // 3인은 궁수 차지 샷을 올리면서 1.25 → 1.28
const PARTY_BASE_SIZE = 4;       // 몬스터 baseHp가 기준으로 삼는 인원(역할 4종 한 명씩).
// 인원수별 HP 보정. 목표는 2~4인 모두 약 24턴(실측 턴당 혼자 5~7초, 여럿이면 더 걸려 3~5분).
// (몬스터 재생·보호막과 파티 점액·기절까지 넣은 상태로 맞춘 값 — tests/raid/밸런스시뮬.js)
// 수호자·치유사는 피해가 적어 인원이 줄어도 턴 수가 크게 안 줄기 때문에 2·3인은 HP를 오히려 늘린다.
// 1인은 테스트 서버 전용(혼자 시작해도 끝까지 시험해 볼 수 있게 — createBattle의 minParty 1)이라 짧게 둔다.
const SMALL_PARTY_HP_RATE = { 1: 0.75, 2: 1.25, 3: 1.1 };
// HP를 맞출 때 기준으로 삼는 최소 인원. 정식 개시 설정으로 2 — 혼자 시작해도 2인 기준 HP(빈 자리는 평균 가중치 1.0으로 채움).
// 테스트 서버만 레이드.js가 minParty 1을 넘겨 혼자일 때 1인 기준 HP(짧음)로 시험한다.
const HP_MIN_PARTY = 2;

// 역할은 파티당 한 명씩만 고를 수 있다. 공격력이 낮은 역할일수록 팀을 지키는 스킬을 가진다.
// hpWeight: 몬스터 HP를 인원에 맞출 때 그 역할 한 명이 늘리는 몫(4종 합 4.0). 딜러가 빠지면 HP도 더 줄어든다.
const ROLES = {
  sword: {
    // 딜러 둘은 3턴 주기 기대 피해를 같게(검사 약 475 · 궁수 약 475, 치명타 포함). HP 가중치도 같게 1.15.
    // 궁수가 약 455로 조금 낮을 때는 기여도 MVP를 검사가 3배 더 자주 가져가서 차지 샷을 200~240 → 220~260으로 올림.
    name: '검사', emoji: '⚔️', attack: [90, 110], hpWeight: 1.15,
    skill: { name: '회전베기', cooldown: 3, damage: [250, 300], desc: '250~300 피해' },
  },
  archer: {
    name: '궁수', emoji: '🏹', attack: [80, 100], critChance: 0.25, critMultiplier: 1.5, hpWeight: 1.15,
    skill: { name: '차지 샷', cooldown: 3, damage: [220, 260], critChance: 0.3, desc: '220~260 피해, 치명타 확률 30%' },
  },
  tank: {
    name: '수호자', emoji: '🛡️', attack: [60, 80], hpWeight: 0.85,
    skill: { name: '도발', cooldown: 2, desc: '이번 턴 단일 공격을 대신 맞고, 받는 피해 70% 감소' },
  },
  healer: {
    name: '치유사', emoji: '💚', attack: [40, 60], hpWeight: 0.9,
    skill: { name: '치유의 빛', cooldown: 3, desc: '아군 전원 HP +30, 쓰러진 아군은 HP 25로 부활' },
  },
};
const ROLE_ORDER = ['sword', 'archer', 'tank', 'healer'];

const ACTIONS = {
  attack: { name: '공격', emoji: '⚔️' },
  skill:  { name: '스킬', emoji: '✨' },
  guard:  { name: '방어', emoji: '🛡️' },
  potion: { name: '회복약', emoji: '🍖' },
};

// ── 몬스터 ──────────────────────────────────────────────────────
// 몬스터 데이터는 프로젝트 맨 위 Monster 폴더에 몬스터 하나당 JSON 파일 하나로 둔다(예: Monster/슬라임.json).
// 봇이 켜질 때 폴더의 .json을 이름순으로 전부 읽어 출현 후보로 쓰고, 출현할 때 무작위로 고른다.
// 새 몬스터는 슬라임.json을 복사해 고치면 된다 — 파일 안 "_메모"에 각 칸 설명이 있다("_"로 시작하는 키는 무시).
// moves의 키는 몬스터마다 자유롭게 짓는다. 단 attack(기본 공격 — 재생을 못 쓸 때 대신 쓰는 기술)과
// smash(필살기 — 7턴 동안 없으면 반드시, 연속 없음, 첫 턴 없음)는 공통 규칙이 쓰므로 꼭 있어야 한다.
// - target: 'single'(한 명) | 'all'(전원) | 'none'(피해 없음, 효과만) | 'self'(자기 회복)
// - fx: 턴 결과 화면 연출 종류(MOVE_FX). 없으면 기술 키와 같은 이름을 쓴다(슬라임은 키 = 연출).
// - smash.readyPose: 필살기를 예고하는 동안 보여 줄 자세(sprite.poses 키). 없으면 평상시 모습.
// - sprite: 레이드 패널 그림(handlers/레이드그림.js)에 그릴 픽셀 아트. rows의 각 글자가 palette 색 한 칸('.'은 투명),
//   rageColors는 분노 시 바꿔 칠할 색, poses는 기술별 자세(키는 moves와 같음).
const MONSTER_DIR = path.join(__dirname, '..', 'Monster');
const REQUIRED_MOVES = ['attack', 'smash'];
// 그림(레이드그림.js)이 아는 연출 종류. 새 연출은 레이드그림.js의 monsterFx·hitFx에 그리고 여기에 이름을 더한다.
const MOVE_FX = ['attack', 'sweep', 'charge', 'smash', 'heal', 'spore', 'hypno', 'absorb', 'burst', 'frost', 'icefall',
  'curse', 'wail', 'phase', 'storm', 'ember', 'smoke', 'ignite', 'boom'];
const EFFECTS = ['slow', 'stun', 'shield', 'poison', 'confuse', 'chill', 'fear', 'phase', 'smoke'];
const moveFx = (key, move) => move?.fx || key;

// 고칠 때 자주 틀리는 것만 확인한다. 문제가 있으면 사유 목록, 없으면 빈 배열.
function monsterProblems(m) {
  const problems = [];
  for (const key of ['id', 'name', 'emoji', 'rageName', 'lore']) if (typeof m[key] !== 'string' || !m[key]) problems.push(`${key} 없음`);
  if (!(m.baseHp > 0)) problems.push('baseHp는 0보다 큰 숫자');
  const s = m.sprite;
  if (!Array.isArray(s?.rows) || !s.rows.length || !s.palette) problems.push('sprite.rows/palette 없음');
  else {
    const used = new Set([s.rows, ...Object.values(s.poses ?? {})].flat().join('').replace(/\./g, ''));
    const missing = [...used].filter(ch => !s.palette[ch]);
    if (missing.length) problems.push(`palette에 없는 글자: ${missing.join(' ')}`);
  }
  if (s?.scale !== undefined && !(s.scale >= 0.5 && s.scale <= 1.3)) problems.push('sprite.scale은 0.5~1.3');
  for (const key of REQUIRED_MOVES) if (!m.moves?.[key]) problems.push(`moves.${key} 없음`);
  for (const [key, mv] of Object.entries(m.moves ?? {})) {
    if (mv.readyPose && !s?.poses?.[mv.readyPose]) problems.push(`moves.${key}.readyPose "${mv.readyPose}"가 sprite.poses에 없음`);
  }
  const rate = (v) => typeof v === 'number' && v > 0 && v <= 1; // 0 초과 1 이하 비율
  if (!rate(m.rage?.hpRatio) || !(m.rage?.damageRate > 0)) problems.push('rage.hpRatio(0~1)·rage.damageRate 필요');
  if (m.rage?.afterPoison !== undefined && !m.moves?.[m.rage.afterPoison]) problems.push(`rage.afterPoison "${m.rage.afterPoison}"이 moves에 없음`);
  const int = (v, min) => Number.isInteger(v) && v >= min;
  const named = (st) => !!(st?.name && st?.emoji);
  if (m.chill !== undefined) {
    const c = m.chill;
    if (!int(c?.freezeAt, 2)) problems.push('chill.freezeAt는 2 이상 정수');
    for (const k of ['guardStacks', 'melt']) if (!int(c?.[k], 0)) problems.push(`chill.${k}는 0 이상 정수`);
    if (!named(c?.status) || !named(c?.freezeStatus)) problems.push('chill.status·freezeStatus의 name·emoji 필요');
  }
  const TARGETS = ['single', 'all', 'none', 'self'];
  const range = (v) => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite) && v[0] >= 0 && v[0] <= v[1];
  for (const [key, move] of Object.entries(m.moves ?? {})) {
    if (typeof move.name !== 'string' || !move.name) problems.push(`moves.${key}.name 없음`);
    if (!MOVE_FX.includes(moveFx(key, move))) problems.push(`moves.${key}.fx는 ${MOVE_FX.join('/')} 중 하나`);
    if (move.effect && !EFFECTS.includes(move.effect)) problems.push(`moves.${key}.effect는 ${EFFECTS.join('/')} 중 하나`);
    if (!TARGETS.includes(move.target)) problems.push(`moves.${key}.target은 single/all/none/self 중 하나`);
    if (typeof move.telegraph !== 'string' || !move.telegraph) problems.push(`moves.${key}.telegraph 없음`);
    if ((move.target === 'single' || move.target === 'all') && !range(move.damage)) problems.push(`moves.${key}.damage는 [최소, 최대] 숫자`);
    if ((move.effect === 'slow' || move.effect === 'shield') && !rate(move.effectRate)) problems.push(`moves.${key}.effectRate(0~1) 필요`);
    if (move.effect === 'slow' && !(Number.isInteger(move.effectTurns) && move.effectTurns >= 1)) problems.push(`moves.${key}.effectTurns(1 이상 정수) 필요`);
    if (['slow', 'stun', 'poison', 'confuse'].includes(move.effect) && !(move.status?.name && move.status?.emoji)) problems.push(`moves.${key}.status.name·emoji 필요`);
    if (move.effect === 'poison') {
      if (!(Number.isInteger(move.effectTurns) && move.effectTurns >= 1)) problems.push(`moves.${key}.effectTurns(1 이상 정수) 필요`);
      if (!(move.tickDamage > 0)) problems.push(`moves.${key}.tickDamage(0보다 큰 숫자) 필요`);
      for (const k of ['stacks', 'maxStacks']) if (move[k] !== undefined && !(Number.isInteger(move[k]) && move[k] >= 1)) problems.push(`moves.${key}.${k}는 1 이상 정수`);
    }
    if (move.effect === 'confuse' && !rate(move.effectRate)) problems.push(`moves.${key}.effectRate(빗나갈 확률 0~1) 필요`);
    if (move.effect === 'poison' || move.effect === 'confuse') {
      if (move.target !== 'single' && move.target !== 'all') problems.push(`moves.${key}: ${move.effect}는 target이 single/all인 기술에만`);
    }
    if (move.effect === 'chill') {
      if (!m.chill) problems.push(`moves.${key}: chill 효과는 몬스터에 chill 블록이 있어야 함`);
      if (move.target !== 'single' && move.target !== 'all') problems.push(`moves.${key}: chill은 target이 single/all인 기술에만`);
      if (!int(move.stacks, 1)) problems.push(`moves.${key}.stacks는 1 이상 정수`);
      if (move.rageStacks !== undefined && !int(move.rageStacks, 1)) problems.push(`moves.${key}.rageStacks는 1 이상 정수`);
    }
    if (move.effect === 'fear' && !named(move.status)) problems.push(`moves.${key}.status.name·emoji 필요`);
    if (move.mark && move.target !== 'single') problems.push(`moves.${key}: mark(표식)는 target single 기술에만`);
    if (move.rageTargets !== undefined && !int(move.rageTargets, 1)) problems.push(`moves.${key}.rageTargets는 1 이상 정수`);
    if (move.guardRate !== undefined && !rate(move.guardRate)) problems.push(`moves.${key}.guardRate(0~1) 필요`);
    if (move.fuse !== undefined) {
      const f = move.fuse;
      if (!int(f?.turns, 1) || (f.rageTurns !== undefined && !int(f.rageTurns, 1)) || !rate(f?.need)) problems.push(`moves.${key}.fuse는 turns(1 이상)·need(0~1) 필요`);
      if (m.moves?.[f?.boom]?.target !== 'all') problems.push(`moves.${key}.fuse.boom "${f?.boom}"은 target all 기술이어야 함`);
    }
    if (move.chillOnHit !== undefined) {
      if (move.effect !== 'shield' || !m.chill || !int(move.chillOnHit, 1)) problems.push(`moves.${key}.chillOnHit은 shield 기술에만, 1 이상 정수, chill 블록 필요`);
    }
    if (move.target === 'self' && (!rate(move.healRate) || !rate(move.useBelowHp))) problems.push(`moves.${key}.healRate·useBelowHp(0~1) 필요`);
    if (move.healPerStack !== undefined && !rate(move.healPerStack)) problems.push(`moves.${key}.healPerStack(0~1) 필요`);
    if (move.buffRate !== undefined && !(move.buffRate > 1 && move.buffRate <= 3)) problems.push(`moves.${key}.buffRate는 1 초과 3 이하(다음 공격 피해 배율)`);
  }
  for (const mode of ['normal', 'rage']) {
    const w = m.intentWeights?.[mode];
    if (!w || !Object.keys(w).length) problems.push(`intentWeights.${mode} 없음`);
    else {
      for (const key of Object.keys(w)) if (!m.moves?.[key]) problems.push(`intentWeights.${mode}에 모르는 기술: ${key}`);
      if (!Object.values(w).every(v => Number.isFinite(v) && v >= 0) || !(Object.values(w).reduce((a, b) => a + b, 0) > 0)) problems.push(`intentWeights.${mode}는 0 이상 숫자, 합이 0보다 커야 함`);
    }
  }
  return problems;
}

// 파일 하나가 깨져도 봇 전체가 멈추지 않게, 그 파일만 빼고 콘솔에 사유를 남긴다.
function loadMonsters(dir = MONSTER_DIR) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch (err) {
    console.error(`👾 몬스터 폴더를 읽지 못함(${dir}) — 레이드가 출현하지 않습니다:`, err.message);
    return [];
  }
  const list = [];
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const monster = Object.fromEntries(Object.entries(data).filter(([key]) => !key.startsWith('_')));
      const problems = monsterProblems(monster);
      if (problems.length) throw new Error(problems.join(', '));
      if (list.some(m => m.id === monster.id)) throw new Error(`id "${monster.id}"가 다른 파일과 겹침`);
      list.push(monster);
    } catch (err) {
      console.error(`👾 몬스터 파일 ${file}을 건너뜀 — ${err.message}`);
    }
  }
  if (!list.length) console.error('👾 쓸 수 있는 몬스터가 없습니다 — 레이드가 출현하지 않습니다.');
  return list;
}
const MONSTERS = loadMonsters();

// 몬스터 데이터에 intentWeights가 없을 때 쓰는 기본 가중치.
const INTENT_WEIGHTS = {
  normal: { attack: 5, sweep: 3, charge: 2, smash: 2 },
  rage:   { attack: 4, sweep: 3, charge: 2, smash: 3 },
};

function randInt([min, max], rng) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function pickWeighted(weights, rng) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (const [key, w] of Object.entries(weights)) {
    if ((r -= w) < 0) return key;
  }
  return Object.keys(weights)[0];
}

const SMASH_PITY_TURNS = 7; // 이만큼 큰 한 방(smash)이 없었으면 다음엔 반드시 예고 — 짧은 판에서도 필살기를 보게
function pickNextIntent(battle, rng) {
  battle.sinceSmash = (battle.sinceSmash || 0) + 1;
  // 분노 연계(rage.afterPoison): 분노 중 이번 턴에 독을 걸었으면 다음 행동은 반드시 그 기술(독버섯: 독기 흡수).
  // 필살기 보장(7턴)보다 먼저 — 필살기는 그다음 턴으로 밀린다.
  const combo = battle.rage && battle.monster.rage?.afterPoison;
  if (combo && battle.monster.moves[combo] && Object.values(battle.lastTurn?.effects ?? {}).includes('poison')) return combo;
  // 점화 카운트다운(꼬마 폭탄): 마지막 턴엔 대폭발, 그 전엔 점화를 다시 고르지 않는다(필살기 보장도 쉼)
  const fz = battle.fuse;
  if (fz && battle.turn + 1 >= fz.until && battle.monster.moves[fz.boom]) return fz.boom;
  if (!fz && battle.sinceSmash >= SMASH_PITY_TURNS && battle.monster.moves.smash && battle.intent !== 'smash') { battle.sinceSmash = 0; return 'smash'; }
  const weights = battle.monster.intentWeights || INTENT_WEIGHTS;
  let pool = battle.rage ? weights.rage : weights.normal;
  if (fz) {
    const withoutSmash = Object.fromEntries(Object.entries(pool).filter(([key]) => key !== 'smash'));
    if (Object.values(withoutSmash).some(w => w > 0)) pool = withoutSmash;
  }
  // 독기 흡수(healPerStack)는 파티에 독이 하나도 없으면 고르지 않는다 — 그 기술을 빼고 나머지 비중으로 다시 고른다
  if (partyPoisonStacks(battle) === 0) {
    const withoutAbsorb = Object.fromEntries(Object.entries(pool).filter(([key]) => !battle.monster.moves[key]?.healPerStack));
    if (Object.values(withoutAbsorb).some(w => w > 0)) pool = withoutAbsorb;
  }
  // 회복 기술(target self — 재생·독기 흡수)은 두 턴 연속 쓰지 않는다(슬라임이 재생을 3연속 쓴 일이 있어 사용자 결정)
  if (battle.monster.moves[battle.intent]?.target === 'self') {
    const withoutHeal = Object.fromEntries(Object.entries(pool).filter(([key]) => battle.monster.moves[key]?.target !== 'self'));
    if (Object.values(withoutHeal).some(w => w > 0)) pool = withoutHeal;
  }
  let next = pickWeighted(pool, rng);
  // 재생은 HP가 useBelowHp 이하일 때만, 그보다 많으면 대신 공격
  const nextMove = battle.monster.moves[next];
  if (nextMove?.target === 'self' && battle.hp > battle.maxHp * nextMove.useBelowHp) next = 'attack';
  if (next === 'smash' && battle.intent === 'smash') next = 'attack'; // 필살기 두 번 연속은 없게
  if (next === 'smash') battle.sinceSmash = 0;
  return next;
}

// party: [{ userId, name, role }]
// minParty: HP를 맞출 최소 인원(기본 HP_MIN_PARTY). 테스트 서버는 1을 넘겨 혼자서도 1인 HP로 끝까지 시험할 수 있게 한다.
function createBattle(monster, party, rng = Math.random, { minParty = HP_MIN_PARTY } = {}) {
  const counted = Math.max(party.length, minParty);
  const weight = party.reduce((sum, p) => sum + ROLES[p.role].hpWeight, 0) + (counted - party.length) * 1.0;
  const smallPartyRate = SMALL_PARTY_HP_RATE[counted] ?? 1;
  const maxHp = Math.max(500, Math.round((monster.baseHp * weight * smallPartyRate) / PARTY_BASE_SIZE / 10) * 10);
  const battle = {
    monster,
    maxHp,
    hp: maxHp,
    rage: false,
    turn: 1,
    intent: null,
    shieldTurn: 0,   // 이 턴 동안 몬스터 보호막(받는 피해 감소)
    shieldRate: 1,   // 보호막 중 몬스터가 받는 피해 배율(보호막 기술의 effectRate)
    powerRate: 0,    // 공격력 증가(buffRate 기술): 다음 피해 기술 1회의 피해 배율(0이면 없음)
    shieldChill: 0,  // 보호막 턴에 몬스터를 때린 사람에게 쌓을 냉기(chillOnHit, 0이면 없음)
    marks: [],       // 표식 대상 userId(예고할 때 정함 — 유령 영혼 사냥)
    phaseTurn: 0,    // 이 턴 동안 투명화(일반 공격 빗나감)
    hiddenTurn: 0,   // 이 턴 동안 다음 행동 예고가 연막으로 가려짐
    fuse: null,      // 점화 카운트다운 { until, need, dealt, boom }(꼬마 폭탄)
    incoming: 0,     // 몬스터가 파티에게 날린 피해 합(방어·도발로 줄이기 전) — 기여도용
    log: [],
    members: party.map(p => ({
      userId: p.userId,
      name: p.name,
      role: p.role,
      hp: PLAYER_MAX_HP,
      cooldown: 0,
      potions: POTIONS_PER_BATTLE,
      choice: null,
      damage: 0,
      healing: 0,
      support: 0,    // 치유사 스킬로 아군을 회복한 양(회복약 자기 회복은 빼고) — 기여도용
      revives: 0,    // 치유사 스킬로 일으킨 아군 수 — 기여도용
      protected: 0,  // 수호자가 도발로 아군 대신 맞아 준 공격의 원래 피해 — 기여도용
      blocked: 0,    // 방어로 줄인 피해 + 도발로 대신 맞아 준 공격의 원래 피해 — 종료 화면 '방어' 칸
      manualActions: 0,
      slowUntil: 0,  // 이 턴까지 점액
      slowRate: 1,   // 점액 중 주는 피해 배율(점액 기술의 effectRate)
      slowStatus: null, // 걸린 slow 상태이상의 이름·이모지(기술의 status, 예: 💧점액)
      stunTurn: 0,   // 이 턴에 기절(행동 불가)
      stunStatus: null, // 걸린 stun 상태이상의 이름·이모지(예: 💫기절)
      poisonStacks: 0,  // 독 중첩
      poisonUntil: 0,   // 이 턴까지 독 피해
      poisonTick: 0,    // 중첩 하나당 턴마다 받는 피해(인원별 배율 적용 전, 독 기술의 tickDamage)
      poisonStatus: null, // 걸린 poison 상태이상의 이름·이모지(예: ☠️독)
      confuseTurn: 0,   // 이 턴에 환각(행동이 빗나갈 수 있음)
      confuseRate: 0,   // 빗나갈 확률
      confuseStatus: null, // 걸린 confuse 상태이상의 이름·이모지(예: 🌀환각)
      chillStacks: 0,   // 냉기 중첩(chill 블록이 있는 몬스터만)
      fearTurn: 0,      // 이 턴에 공포(스킬 못 씀)
      fearStatus: null, // 걸린 fear 상태이상의 이름·이모지(예: 😱공포)
    })),
  };
  battle.intent = pickNextIntent(battle, rng);
  if (battle.intent === 'smash') battle.intent = 'attack'; // 첫 턴부터 필살기는 없게(시작하자마자 전원 기절 방지)
  assignMarks(battle, rng);
  return battle;
}

function getMember(battle, userId) {
  return battle.members.find(m => m.userId === userId) || null;
}

function aliveMembers(battle) {
  return battle.members.filter(m => m.hp > 0);
}

// 지금 턴 기준 상태 효과. 점액 남은 턴은 이번 턴 포함.
function isStunned(battle, m) { return m.stunTurn === battle.turn; }
function slowTurnsLeft(battle, m) { return Math.max(0, m.slowUntil - battle.turn + 1); }
function isShielded(battle) { return battle.shieldTurn === battle.turn; }
function isPowered(battle) { return battle.powerRate > 1; }
// 독: 남은 턴(이번 턴 포함)이 있을 때만 중첩을 센다. 재시작 전 기록엔 칸이 없을 수 있어 0으로 본다.
function poisonTurnsLeft(battle, m) { return m.poisonStacks > 0 ? Math.max(0, (m.poisonUntil || 0) - battle.turn + 1) : 0; }
function poisonStacks(battle, m) { return poisonTurnsLeft(battle, m) > 0 ? m.poisonStacks : 0; }
// 이번 턴 독 피해(인원별 몬스터 피해 배율 적용). 화면 안내와 실제 피해가 같은 식을 쓴다.
function poisonDamage(battle, m) {
  const n = poisonStacks(battle, m);
  return n ? Math.max(1, Math.round(n * m.poisonTick * (PARTY_DAMAGE_RATE[battle.members.length] ?? 1))) : 0;
}
function isConfused(battle, m) { return m.confuseTurn === battle.turn; }
function isFeared(battle, m) { return m.fearTurn === battle.turn; }
function isPhased(battle) { return battle.phaseTurn === battle.turn; }
// 연막(꼬마 폭탄): 이번 턴 예고가 가려졌는지. 경고 기술(대폭발 등 warn)은 가리지 않는다.
function isIntentHidden(battle) { return battle.hiddenTurn === battle.turn && !battle.monster.moves[battle.intent]?.warn; }
// 다음 행동이 '방어하세요' 경고(빨간 예고 상자)인지: 기술의 warn, 없으면 smash면 경고
function isWarnIntent(battle) {
  if (isIntentHidden(battle)) return false;
  const move = battle.monster.moves[battle.intent];
  return move?.warn ?? battle.intent === 'smash';
}
// 화면에 보일 예고 문구: 연막이면 가림, 표식 기술이면 {target}에 대상 이름
function telegraphText(battle) {
  if (isIntentHidden(battle)) return '💨 연막 때문에 다음 행동이 보이지 않는다...';
  const move = battle.monster.moves[battle.intent];
  const names = (battle.marks ?? []).map(id => getMember(battle, id)?.name).filter(Boolean).join(', ') || '누군가';
  // '{target}을(를)'은 마지막 이름의 받침에 맞춰 을/를로(한글이 아니면 그대로 '을(를)')
  return move.telegraph.replace('{target}을(를)', names + objectJosa(names)).replace('{target}', names);
}
function objectJosa(name) {
  const code = String(name).trim().slice(-1).charCodeAt(0) - 0xAC00;
  if (code < 0 || code > 11171) return '을(를)';
  return code % 28 ? '을' : '를';
}
// 표식 기술(mark)을 예고하면 대상을 지금 정한다(분노 중 rageTargets명). 표식 기술이 아니면 비운다.
function assignMarks(battle, rng = Math.random) {
  const move = battle.monster.moves[battle.intent];
  if (!move?.mark) { battle.marks = []; return; }
  const pool = aliveMembers(battle).slice();
  const n = Math.min(battle.rage ? (move.rageTargets ?? 1) : 1, pool.length);
  const out = [];
  while (out.length < n) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0].userId);
  battle.marks = out;
}
// 표식 공격을 맞을 사람: 표식 대상(쓰러졌으면 표식 없는 다른 사람에게 옮김). 수호자가 도발하면 한 명 몫을 대신 맞는다.
function markTargets(battle, taunter, rng) {
  const alive = aliveMembers(battle);
  const marks = battle.marks ?? [];
  const list = [];
  for (const id of marks) {
    let t = getMember(battle, id);
    if (!t || t.hp <= 0 || list.includes(t)) {
      const rest = alive.filter(m => !list.includes(m) && !marks.includes(m.userId));
      t = rest.length ? rest[Math.floor(rng() * rest.length)] : null;
    }
    if (t && !list.includes(t)) list.push(t);
  }
  if (!list.length && alive.length) list.push(alive[Math.floor(rng() * alive.length)]);
  if (taunter && taunter.hp > 0 && !list.includes(taunter)) list[0] = taunter;
  return list;
}
// 지금 파티에 쌓인 독 중첩 합(살아 있는 사람만). 독기 흡수(healPerStack) 회복량에 쓴다.
function partyPoisonStacks(battle) { return aliveMembers(battle).reduce((sum, m) => sum + poisonStacks(battle, m), 0); }
// 냉기 중첩(쓰러진 사람은 0). 재시작 전 기록엔 칸이 없을 수 있어 0으로 본다.
function chillStacks(battle, m) { return m.hp > 0 ? m.chillStacks || 0 : 0; }
function partyChillStacks(battle) { return aliveMembers(battle).reduce((sum, m) => sum + chillStacks(battle, m), 0); }

// 기여도(MVP를 고르는 점수). 피해만 보면 딜러만 MVP가 돼서, 치유사의 회복·부활과 수호자가 도발로 대신 맞아 준
// 피해를 피해와 같은 단위로 바꿔 더한다. 회복·막아 준 피해는 몬스터가 세게 때릴수록(인원별 몬스터 피해 배율)
// 커지므로 그 배율로 나누고, 회복은 인원이 적을수록 작게 나와서 (4 ÷ 인원)의 네제곱근만큼 보정했다.
// 가중치는 시뮬레이션(보통 플레이)으로 맞춘 값 — 목표는 4인에서 네 역할이 25%씩:
// 4인 검사 24%·궁수 25%·수호자 25%·치유사 26%, 3인 구성은 역할마다 26~38%, 딜러+치유사 2인은 약 69:31.
const CONTRIB_HEAL = 9.75;   // 아군 회복 + 부활 × CONTRIB_REVIVE 에 곱함
const CONTRIB_REVIVE = 25;   // 부활 1번을 회복 몇으로 칠지(부활로 채운 HP 25와 별도로 더함)
const CONTRIB_PROTECT = 39;  // 막아 준 피해에 곱함
function contribution(battle, m) {
  const n = battle.members.length;
  const rate = PARTY_DAMAGE_RATE[n] ?? 1;
  const heal = CONTRIB_HEAL * (m.support + m.revives * CONTRIB_REVIVE) * Math.pow(PARTY_BASE_SIZE / n, 0.25);
  return m.damage + (heal + CONTRIB_PROTECT * m.protected) / rate;
}
// 피해 배율 → 줄어드는 퍼센트(0.75 → 25). 화면 문구용.
function minusPct(rate) { return Math.round((1 - rate) * 100); }
// 몬스터가 가진 기술 중 이 효과(slow·shield·stun)나 대상(self)을 가진 첫 기술. 도움말 문구용.
function findMove(monster, { effect, target }) {
  return Object.values(monster?.moves ?? {}).find(mv => (effect ? mv.effect === effect : mv.target === target)) || null;
}

// 이 행동을 지금 고를 수 있는지. 안 되면 사유 문구, 되면 null.
function checkChoice(battle, userId, action) {
  const m = getMember(battle, userId);
  if (!m) return '이번 토벌 파티원만 행동할 수 있어요.';
  if (m.hp <= 0) return '쓰러진 상태라 행동할 수 없어요. 치유사의 부활을 기다리세요!';
  if (isStunned(battle, m)) return `${m.stunStatus.emoji} ${m.stunStatus.name} 상태라 이번 턴엔 움직일 수 없어요.`;
  if (!ACTIONS[action]) return '알 수 없는 행동이에요.';
  if (action === 'skill' && isFeared(battle, m)) return `${m.fearStatus.emoji} ${m.fearStatus.name} 상태라 이번 턴엔 스킬을 쓸 수 없어요.`;
  if (action === 'skill' && m.cooldown > 0) return `스킬은 ${m.cooldown}턴 뒤에 다시 쓸 수 있어요.`;
  if (action === 'potion' && m.potions <= 0) return '회복약을 다 썼어요.';
  // HP가 가득해도 독에 걸렸으면 해독하려고 마실 수 있다
  if (action === 'potion' && m.hp >= PLAYER_MAX_HP && !poisonStacks(battle, m) && !chillStacks(battle, m)) return '이미 HP가 가득 차 있어요.';
  return null;
}

function choose(battle, userId, action) {
  getMember(battle, userId).choice = action;
}

// 기절한 사람은 고를 수 없으니 빼고 센다(모두 기절이면 바로 true).
function allChosen(battle) {
  return aliveMembers(battle).every(m => m.choice || isStunned(battle, m));
}

function heal(member, amount) {
  const before = member.hp;
  member.hp = Math.min(PLAYER_MAX_HP, member.hp + amount);
  return member.hp - before;
}

// 한 턴을 처리한다. battle.log를 이번 턴 기록으로 바꾸고 결과를 돌려준다:
// 'clear'(토벌) | 'wipe'(전멸) | null(계속).
// battle.lastTurn에는 같은 내용을 그림용 데이터로 남긴다(카드 위 행동 말풍선·받은 피해 숫자 등):
//   { turn, acts: { userId: { label, value, crit, heal, auto } }, hits: { userId: 피해 }, effects: { userId: 'slow'|'stun' },
//     monsterDamage, monsterMove, monsterMoveKey, shielded(이번 턴 보호막으로 피해가 줄었는지) }
function resolveTurn(battle, rng = Math.random) {
  const log = [];
  const last = { turn: battle.turn, acts: {}, hits: {}, effects: {}, poison: {}, monsterDamage: 0, monsterMove: null, shielded: isShielded(battle) };
  battle.lastTurn = last;
  const ordered = ROLE_ORDER.map(r => battle.members.find(m => m.role === r)).filter(Boolean);
  const acting = ordered.filter(m => m.hp > 0);
  // 냉기(chill 블록이 있는 몬스터만): 행동하는 즉시 늘거나 줄고, 빙결은 아군 행동 뒤·몬스터 기술 뒤에 판정한다
  const chill = battle.monster.chill;
  const addChill = (m, n) => { if (chill) m.chillStacks = Math.max(0, (m.chillStacks || 0) + n); };
  const melt = -(chill?.melt ?? 0);
  // 몬스터를 때린 행동: 보통은 녹고, 가시 얼음 갑옷(보호막 + chillOnHit) 턴이면 오히려 냉기가 쌓인다
  const hitChill = () => (last.shielded && battle.shieldChill ? battle.shieldChill : melt);
  const freezeCheck = () => {
    if (!chill) return;
    for (const m of ordered) {
      if (m.hp <= 0) { m.chillStacks = 0; continue; }
      if ((m.chillStacks || 0) < chill.freezeAt) continue;
      m.chillStacks = 0;
      if (m.stunTurn === battle.turn + 1) continue; // 이미 다음 턴 행동 불가(같은 턴 필살기 기절 등)
      m.stunTurn = battle.turn + 1;
      m.stunStatus = chill.freezeStatus;
      last.effects[m.userId] = 'freeze';
      log.push(`${chill.freezeStatus.emoji} **${m.name}** ${chill.freezeStatus.name}! 다음 턴 행동 불가`);
    }
  };
  // 파티가 몬스터에게 주는 피해: 점액(본인)·보호막(몬스터) 보정
  const dealt = (m, dmg) => {
    if (slowTurnsLeft(battle, m) > 0) dmg *= m.slowRate;
    if (last.shielded) dmg *= battle.shieldRate;
    return Math.max(1, Math.round(dmg));
  };
  if (last.shielded) log.push(`🛡️ **${battle.monster.name}**의 몸이 단단해 ${battle.shieldRate === 0.5 ? '피해가 절반만 들어간다' : `주는 피해 -${minusPct(battle.shieldRate)}%`}!`);

  // 1) 아군 행동
  let taunter = null;
  for (const m of acting) {
    const role = ROLES[m.role];
    if (isStunned(battle, m)) {
      m.choice = null;
      m.guarding = false;
      last.acts[m.userId] = { label: m.stunStatus.name };
      log.push(`${role.emoji} **${m.name}** ${m.stunStatus.emoji}${m.stunStatus.name} 상태라 움직이지 못했다`);
      continue;
    }
    const auto = !m.choice;
    // 공포 중 스킬은 고를 수 없다(checkChoice) — 혹시 들어오면 공격으로
    const action = (m.choice === 'skill' && isFeared(battle, m) ? 'attack' : m.choice) || 'attack';
    if (!auto) m.manualActions++;
    m.guarding = action === 'guard';
    const tag = auto ? ' *(자동)*' : '';
    // 환각: 방어가 아닌 행동은 확률로 빗나간다(회복약·쿨타임은 쓰지 않음)
    if (action !== 'guard' && isConfused(battle, m) && rng() < m.confuseRate) {
      m.guarding = false;
      last.acts[m.userId] = { label: '헛손질', auto };
      log.push(`${role.emoji} **${m.name}** ${m.confuseStatus.emoji}${m.confuseStatus.name} 때문에 헛손질했다${tag}`);
      continue;
    }

    if (action === 'attack' && isPhased(battle)) {
      // 투명화(유령): 일반 공격은 빗나간다(스킬은 맞음)
      last.acts[m.userId] = { label: '빗나감', auto };
      log.push(`${role.emoji} **${m.name}** 공격${tag} → 투명한 몸을 그대로 빗나갔다`);
    } else if (action === 'attack') {
      let dmg = randInt(role.attack, rng);
      const crit = role.critChance && rng() < role.critChance;
      if (crit) dmg *= role.critMultiplier;
      dmg = dealt(m, dmg);
      battle.hp -= dmg;
      m.damage += dmg;
      addChill(m, hitChill());
      last.acts[m.userId] = { label: '공격', value: dmg, crit, auto };
      last.monsterDamage += dmg;
      log.push(`${role.emoji} **${m.name}** 공격${tag} → **${dmg}**${crit ? ' 💥치명타!' : ''}`);
    } else if (action === 'skill') {
      m.cooldown = role.skill.cooldown;
      if (m.role === 'sword') {
        const dmg = dealt(m, randInt(role.skill.damage, rng));
        battle.hp -= dmg;
        m.damage += dmg;
        addChill(m, hitChill());
        last.acts[m.userId] = { label: role.skill.name, value: dmg };
        last.monsterDamage += dmg;
        log.push(`${role.emoji} **${m.name}** ✨${role.skill.name} → **${dmg}**`);
      } else if (m.role === 'archer') {
        let dmg = randInt(role.skill.damage, rng);
        const crit = rng() < role.skill.critChance;
        if (crit) dmg *= role.critMultiplier;
        dmg = dealt(m, dmg);
        battle.hp -= dmg;
        m.damage += dmg;
        addChill(m, hitChill());
        last.acts[m.userId] = { label: role.skill.name, value: dmg, crit };
        last.monsterDamage += dmg;
        log.push(`${role.emoji} **${m.name}** ✨${role.skill.name} → **${dmg}**${crit ? ' 💥치명타!' : ''}`);
      } else if (m.role === 'tank') {
        taunter = m;
        addChill(m, melt);
        last.acts[m.userId] = { label: role.skill.name };
        log.push(`${role.emoji} **${m.name}** ✨${role.skill.name}! 몬스터의 시선을 끈다`);
      } else if (m.role === 'healer') {
        let healed = 0;
        const revived = [];
        const cleansed = new Set(); // 씻어낸 상태이상 이름(점액 등)
        for (const t of battle.members) {
          if (t.hp > 0) healed += heal(t, 30);
          else { t.hp = 25; healed += 25; revived.push(t.name); }
          if (slowTurnsLeft(battle, t) > 0) { t.slowUntil = 0; cleansed.add(t.slowStatus.name); } // 점액(slow)도 씻어낸다
          if (poisonStacks(battle, t) > 0) { t.poisonStacks = 0; t.poisonUntil = 0; cleansed.add(t.poisonStatus.name); } // 독도 씻어낸다
          if (chill && (t.chillStacks || 0) > 0) { t.chillStacks = 0; cleansed.add(chill.status.name); } // 냉기도 녹인다
        }
        m.healing += healed;
        m.support += healed;
        m.revives += revived.length;
        last.acts[m.userId] = { label: role.skill.name, value: healed, heal: true };
        log.push(`${role.emoji} **${m.name}** ✨${role.skill.name} → 아군 회복${cleansed.size ? ` · ${[...cleansed].join('·')} 제거` : ''}${revived.length ? ` · **${revived.join(', ')}** 부활!` : ''}`);
      }
    } else if (action === 'guard') {
      addChill(m, chill?.guardStacks ?? 0); // 웅크리면 얼어붙는다
      last.acts[m.userId] = { label: '방어' };
      log.push(`${role.emoji} **${m.name}** 방어 태세`);
    } else if (action === 'potion') {
      m.potions--;
      const healed = heal(m, POTION_HEAL);
      m.healing += healed;
      // 회복약은 독도 푼다(이번 턴 독 피해 전에 마시므로 그 턴 독 피해도 없음)
      const cured = poisonStacks(battle, m) > 0 ? m.poisonStatus : null;
      if (cured) { m.poisonStacks = 0; m.poisonUntil = 0; }
      const thawed = chill && (m.chillStacks || 0) > 0; // 회복약은 본인 냉기도 녹인다
      if (thawed) m.chillStacks = 0;
      last.acts[m.userId] = { label: '회복약', value: healed, heal: true };
      log.push(`${role.emoji} **${m.name}** 🍖회복약 → HP +${healed}${cured ? ` · ${cured.emoji}${cured.name} 해독` : ''}${thawed ? ` · ${chill.status.emoji}${chill.status.name} 제거` : ''}`);
    }

    if (battle.hp <= 0) {
      battle.hp = 0;
      log.push(`🎉 **${battle.monster.name}**을(를) 쓰러뜨렸다!`);
      battle.log = log;
      return 'clear';
    }
  }

  // 1-2) 독: 아군 행동이 끝날 때 중첩만큼 피해(이번 턴 치유사가 씻어냈으면 없음). 마지막 턴이 지나면 사라진다.
  const poisonLog = [];
  // 독기 흡수가 셀 중첩: 이번 턴이 마지막인 독도 몬스터 행동 전엔 아직 몸에 있으니 지우기 전에 센다(살아 있는 사람만)
  let absorbStacks = 0;
  for (const m of ordered) {
    if (m.hp > 0) {
      const dmg = poisonDamage(battle, m);
      if (dmg) {
        m.hp = Math.max(0, m.hp - dmg);
        last.poison[m.userId] = dmg;
        poisonLog.push(`${m.poisonStatus.emoji}${m.poisonStatus.name}: ${m.name} -${dmg}${m.hp <= 0 ? ' 💀' : ''}`);
      }
      if (m.hp > 0) absorbStacks += poisonStacks(battle, m);
    }
    if (m.poisonStacks && (m.hp <= 0 || (m.poisonUntil || 0) <= battle.turn)) m.poisonStacks = 0;
  }
  if (poisonLog.length) log.push(poisonLog.join(' · '));
  if (aliveMembers(battle).length === 0) {
    for (const m of battle.members) { m.choice = null; m.guarding = false; }
    log.push('☠️ 파티가 전멸했다…');
    battle.log = log;
    return 'wipe';
  }

  freezeCheck();

  // 1-3) 점화 카운트다운(꼬마 폭탄): 이번 턴 파티 피해를 쌓고, 기준을 넘으면 불이 꺼져 이번 턴 폭탄은 행동하지 못한다(기절)
  let defused = false;
  if (battle.fuse) {
    battle.fuse.dealt += last.monsterDamage;
    if (battle.fuse.dealt >= battle.fuse.need) {
      defused = true;
      last.defused = true;
      battle.fuse = null;
      log.push(`😵 불이 꺼졌다! **${battle.monster.name}**이(가) 어지러워 이번 턴 행동하지 못한다`);
    }
  }

  // 2) 몬스터 행동 (지난 턴에 예고한 것)
  const move = defused ? null : battle.monster.moves[battle.intent];
  if (move) {
    // 공격력 증가(buffRate 기술을 쓴 뒤 첫 피해 기술 1회): 이번 공격 피해 × powerRate, 쓰고 나면 사라진다
    const powered = (move.target === 'single' || move.target === 'all') && battle.powerRate > 1 ? battle.powerRate : 0;
    const mult = (battle.rage ? battle.monster.rage.damageRate : 1) * (PARTY_DAMAGE_RATE[battle.members.length] ?? 1) * (powered || 1);
    const hit = (target) => {
      let dmg = randInt(move.damage, rng) * mult;
      battle.incoming += Math.round(dmg);
      // 도발로 아군 대신 맞은 한 명 공격은 줄이기 전 피해를 수호자의 기여(막아 준 피해)로 센다
      if (target === taunter && move.target === 'single') target.protected += Math.round(dmg);
      const rawDmg = Math.round(dmg);
      if (target.guarding) dmg *= move.guardRate ?? GUARD_DAMAGE_RATE; // 대폭발처럼 방어가 덜 먹히는 기술은 guardRate
      if (target === taunter) dmg *= TAUNT_DAMAGE_RATE;
      dmg = Math.max(1, Math.round(dmg));
      // 종료 화면 '방어' 칸: 도발로 대신 맞아 준 공격은 원래 피해 전부(아군이 맞을 걸 대신 받음), 방어는 줄인 만큼
      target.blocked += target === taunter && move.target === 'single' ? rawDmg : Math.max(0, rawDmg - dmg);
      target.hp = Math.max(0, target.hp - dmg);
      return dmg;
    };
    const monsterName = battle.rage ? battle.monster.rageName : battle.monster.name;
    last.monsterMove = move.name;
    last.monsterMoveKey = battle.intent; // 그림이 기술별 자세(sprite.poses)를 고를 때 쓴다
    last.monsterFx = moveFx(battle.intent, move); // 그림이 연출(monsterFx·hitFx)을 고를 때 쓴다
    if (move.target === 'self') {
      const before = battle.hp;
      const stacks = absorbStacks;
      // 독기 흡수(healPerStack): 예고 뒤 파티가 독을 다 지웠으면 빨아들일 독기가 없어 실패 — 회복 0, 공격력 증가도 없음
      last.fizzled = !!move.healPerStack && stacks === 0;
      // 중첩은 4인 기준으로 환산(합 × 4 ÷ 인원) — 인원이 적으면 쌓일 독 자체가 적어 1~2인에서 회복이 너무 작았다
      const rate = last.fizzled ? 0 : (move.healRate || 0) + (move.healPerStack || 0) * stacks * PARTY_BASE_SIZE / battle.members.length;
      battle.hp = Math.min(battle.maxHp, battle.hp + Math.round(battle.maxHp * rate));
      last.monsterHeal = battle.hp - before;
      log.push(last.fizzled
        ? `${battle.monster.emoji} **${monsterName}**의 **${move.name}**! 빨아들일 독기가 없다… HP **+0**`
        : `${battle.monster.emoji} **${monsterName}**의 **${move.name}**! HP **+${last.monsterHeal.toLocaleString()}**`);
    } else if (move.target === 'none') {
      log.push(`${battle.monster.emoji} **${monsterName}**의 **${move.name}**!`);
    } else {
      const targets = move.target === 'all'
        ? aliveMembers(battle)
        : move.mark
          ? markTargets(battle, taunter, rng)
          : [taunter && taunter.hp > 0 ? taunter : aliveMembers(battle)[Math.floor(rng() * aliveMembers(battle).length)]];
      const parts = targets.map(t => {
        const dmg = hit(t);
        last.hits[t.userId] = dmg;
        let tag = '';
        // 기술 효과: 점액·독은 맞은 사람 전원(guardBlocks면 방어한 사람 제외), 기절은 방어하지 않은 사람만(쓰러진 사람 제외)
        const blocked = !!move.guardBlocks && t.guarding;
        if (t.hp > 0 && move.effect === 'poison' && !blocked) {
          t.poisonStacks = Math.min(move.maxStacks ?? 3, poisonStacks(battle, t) + (move.stacks ?? 1));
          t.poisonUntil = battle.turn + move.effectTurns;
          t.poisonTick = move.tickDamage;
          t.poisonStatus = move.status;
          last.effects[t.userId] = 'poison';
          tag = ` ${move.status.emoji}${move.status.name}${t.poisonStacks > 1 ? `×${t.poisonStacks}` : ''}`;
        }
        if (t.hp > 0 && move.effect === 'confuse' && !blocked) { t.confuseTurn = battle.turn + 1; t.confuseRate = move.effectRate; t.confuseStatus = move.status; last.effects[t.userId] = 'confuse'; tag = ` ${move.status.emoji}${move.status.name}`; }
        if (t.hp > 0 && move.effect === 'slow' && !blocked) { t.slowUntil = battle.turn + move.effectTurns; t.slowRate = move.effectRate; t.slowStatus = move.status; last.effects[t.userId] = 'slow'; tag = ` ${move.status.emoji}${move.status.name}`; }
        if (t.hp > 0 && move.effect === 'chill') {
          addChill(t, battle.rage ? (move.rageStacks ?? move.stacks) : move.stacks);
          const st = move.status ?? chill.status;
          last.effects[t.userId] = 'chill';
          tag = ` ${st.emoji}${st.name}×${t.chillStacks}`;
        }
        if (t.hp > 0 && move.effect === 'fear' && !blocked) { t.fearTurn = battle.turn + 1; t.fearStatus = move.status; last.effects[t.userId] = 'fear'; tag = ` ${move.status.emoji}${move.status.name}`; }
        if (t.hp > 0 && move.effect === 'stun' && !t.guarding) { t.stunTurn = battle.turn + 1; t.stunStatus = move.status; last.effects[t.userId] = 'stun'; tag = ` ${move.status.emoji}${move.status.name}`; }
        return `${t.name} -${dmg}${t.hp <= 0 ? ' 💀' : tag}`;
      });
      log.push(`${battle.monster.emoji} **${monsterName}**의 **${move.name}**!${powered ? ` ⚔️피해 +${Math.round((powered - 1) * 100)}%` : ''} → ${parts.join(' · ')}`);
      if (powered) { last.powered = powered; battle.powerRate = 0; }
    }
    if (move.buffRate > 1 && !last.fizzled) {
      battle.powerRate = move.buffRate;
      log.push(`⚔️ **${monsterName}**의 공격력이 올랐다! 다음 공격 피해 **+${Math.round((move.buffRate - 1) * 100)}%**`);
    }
    if (move.effect === 'shield') {
      battle.shieldTurn = battle.turn + 1;
      battle.shieldRate = move.effectRate;
      battle.shieldChill = move.chillOnHit ?? 0;
      const spikes = battle.shieldChill ? ` · 때리면 ${chill.status.emoji}${chill.status.name} +${battle.shieldChill}` : '';
      log.push(`🛡️ **${monsterName}**의 몸이 단단해졌다! 다음 턴 받는 피해 **-${minusPct(move.effectRate)}%**${spikes}`);
    }
    if (move.effect === 'phase') {
      battle.phaseTurn = battle.turn + 1;
      log.push(`👻 **${monsterName}**의 몸이 투명해졌다! 다음 턴 일반 공격은 빗나간다(스킬은 맞음)`);
    }
    if (move.effect === 'smoke') {
      battle.hiddenTurn = battle.turn + 1;
      log.push(`💨 연막이 퍼졌다! 다음 행동이 보이지 않는다`);
    }
    if (battle.fuse && battle.intent === battle.fuse.boom) battle.fuse = null; // 대폭발로 카운트다운 끝
    if (move.fuse) {
      const turns = battle.rage ? (move.fuse.rageTurns ?? move.fuse.turns) : move.fuse.turns;
      battle.fuse = { until: battle.turn + turns, need: Math.round(battle.maxHp * move.fuse.need), dealt: 0, boom: move.fuse.boom };
      log.push(`🔥 도화선에 불이 붙었다! **${turns}턴** 안에 **${battle.fuse.need.toLocaleString()}** 피해를 넣어 불을 꺼라!`);
    }
  }
  freezeCheck();

  for (const m of battle.members) { m.choice = null; m.guarding = false; }

  if (aliveMembers(battle).length === 0) {
    log.push('☠️ 파티가 전멸했다…');
    battle.log = log;
    return 'wipe';
  }

  // 3) 분노 전환 · 다음 행동 예고 · 턴 넘김
  if (!battle.rage && battle.hp <= battle.maxHp * battle.monster.rage.hpRatio) {
    battle.rage = true;
    log.push(`🔥 **${battle.monster.rageName}**(으)로 변했다! 공격이 더 강해진다!`);
  }
  battle.intent = pickNextIntent(battle, rng);
  assignMarks(battle, rng);
  for (const m of battle.members) if (m.cooldown > 0) m.cooldown--;
  battle.turn++;
  battle.log = log;
  return null;
}

module.exports = {
  PLAYER_MAX_HP,
  POTIONS_PER_BATTLE,
  POTION_HEAL,
  GUARD_DAMAGE_RATE,
  ROLES,
  ROLE_ORDER,
  ACTIONS,
  MONSTERS,
  loadMonsters,
  createBattle,
  getMember,
  aliveMembers,
  checkChoice,
  choose,
  allChosen,
  isStunned,
  slowTurnsLeft,
  isShielded,
  isPowered,
  poisonTurnsLeft,
  poisonStacks,
  poisonDamage,
  isConfused,
  isFeared,
  isPhased,
  isIntentHidden,
  isWarnIntent,
  telegraphText,
  assignMarks,
  partyPoisonStacks,
  chillStacks,
  partyChillStacks,
  moveFx,
  MOVE_FX,
  minusPct,
  findMove,
  contribution,
  resolveTurn,
};

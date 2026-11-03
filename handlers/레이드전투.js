// 레이드전투.js — 긴급 퀘스트(레이드)의 턴제 전투 규칙과 몬스터 데이터.
// 디스코드 객체를 전혀 모르는 순수 로직이라, 화면·버튼·타이머(handlers/레이드.js)와 떨어져서
// 시뮬레이션으로 밸런스를 따로 돌려볼 수 있다.
//
// 한 턴의 흐름: 살아있는 파티원이 각자 행동을 고른다(못 고르면 자동 공격) → 아군 행동 처리
// → 몬스터가 지난 턴에 예고한 행동 실행 → 다음 행동 예고. 몬스터 HP가 절반 밑이면 분노해 더 세진다.

const PLAYER_MAX_HP = 100;
const POTIONS_PER_BATTLE = 2;
const POTION_HEAL = 45;
const GUARD_DAMAGE_RATE = 0.3;   // 방어: 받는 피해 70% 감소
const TAUNT_DAMAGE_RATE = 0.4;   // 도발 중인 수호자: 받는 피해 60% 감소
const RAGE_HP_RATIO = 0.5;
const RAGE_DAMAGE_MULTIPLIER = 1.5;
const PARTY_BASE_SIZE = 4;       // 몬스터 baseHp가 기준으로 삼는 인원(역할 4종 한 명씩).
// 인원이 적으면 서로 지켜줄 수단(도발·회복)도 빠져 같은 HP 비율로는 훨씬 어렵다(시뮬레이션 기준
// 혼자면 승률 20% 안팎). 그래서 인원수별로 HP를 한 번 더 깎는다.
const SMALL_PARTY_HP_RATE = { 1: 0.75, 2: 0.9, 3: 0.95 };

// 역할은 파티당 한 명씩만 고를 수 있다. 공격력이 낮은 역할일수록 팀을 지키는 스킬을 가진다.
// hpWeight: 몬스터 HP를 인원에 맞출 때 그 역할 한 명이 늘리는 몫(4종 합 4.0). 딜러가 빠지면 HP도 더 줄어든다.
const ROLES = {
  sword: {
    name: '검사', emoji: '⚔️', attack: [90, 110], hpWeight: 1.15,
    skill: { name: '회전베기', cooldown: 3, desc: '250~300 피해' },
  },
  archer: {
    name: '궁수', emoji: '🏹', attack: [80, 100], critChance: 0.25, critMultiplier: 1.8, hpWeight: 1.1,
    skill: { name: '차지 샷', cooldown: 3, desc: '230~270 피해, 치명타 확률 2배' },
  },
  tank: {
    name: '수호자', emoji: '🛡️', attack: [50, 70], hpWeight: 0.85,
    skill: { name: '도발', cooldown: 2, desc: '이번 턴 단일 공격을 대신 맞고, 받는 피해 60% 감소' },
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
// 지금은 임시 몬스터 하나뿐. 새 몬스터는 같은 모양으로 배열에 추가하면 출현 시 무작위로 고른다.
// moves의 키(attack/sweep/charge/smash)는 전투 규칙이 쓰는 행동 종류라 그대로 두고 이름·대사만 바꾼다.
// - target: 'single'(한 명) | 'all'(전원) | 'none'(피해 없음, charge 전용 — 다음 턴 smash 예고)
// - sprite: 레이드 패널 그림(handlers/레이드그림.js)에 그릴 픽셀 아트. rows의 각 글자가 palette 색 한 칸('.'은 투명),
//   glitchRows에 적은 줄은 옆으로 살짝 밀어 그린다. rageColors는 분노 시 바꿔 칠할 색.
//   (그림 파일 몬스터는 아직 지원하지 않는다 — 넣을 때 handlers/그림판.js에 PNG 해석을 추가)
const MONSTERS = [
  {
    id: 'glitch',
    name: '글리치 슬라임',
    emoji: '👾',
    rageName: '폭주한 글리치 슬라임',
    lore: 'XP 서버에 침입한 버그 덩어리. 이 녀석이 날뛰는 동안 XP가 쌓이지 않는다!',
    sprite: {
      rows: [
        '......aaaaaa......',
        '....aabbbbbbaa....',
        '...abbbbbbbbbba...',
        '..abbbbbbbbbbbba..',
        '..abbwwbbbbwwbba..',
        '.abbbwkbbbbwkbbba.',
        '.abbbkkbbbbkkbbba.',
        'abbbbbbbbbbbbbbbba',
        'abbccbbbmmbbbccbba',
        'abbbbbbbbbbbbbbbba',
        'agggbbbbbbbbbbggga',
        '.abbbbgggggbbbbba.',
        '..aaabbbbbbbbaaa..',
        '.....aaaaaaaa.....',
      ],
      palette: { a: '#2b1b4a', b: '#7c4dff', c: '#ff5c8a', w: '#ffffff', k: '#111111', m: '#1a1033', g: '#36f2c8' },
      rageColors: { a: '#4a1010', b: '#e5383b', g: '#ffb703' },
      glitchRows: [3, 9],
    },
    baseHp: 4400,
    moves: {
      attack: { name: '몸통 박치기', telegraph: '몸을 잔뜩 웅크린다', target: 'single', damage: [20, 26] },
      sweep:  { name: '오류 파동',   telegraph: '몸이 지직거리기 시작한다', target: 'all', damage: [12, 17] },
      charge: { name: '데이터 압축', telegraph: '주변 데이터를 빨아들인다…', target: 'none' },
      smash:  { name: '메모리 폭발', telegraph: '💥 폭발 직전! 방어하세요!', target: 'all', damage: [38, 46] },
    },
  },
];

// 평상시/분노 시 다음 행동 가중치. charge 다음 턴은 무조건 smash.
const INTENT_WEIGHTS = {
  normal: { attack: 5, sweep: 3, charge: 2 },
  rage:   { attack: 4, sweep: 3, charge: 3 },
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

function pickNextIntent(battle, rng) {
  if (battle.intent === 'charge') return 'smash';
  return pickWeighted(battle.rage ? INTENT_WEIGHTS.rage : INTENT_WEIGHTS.normal, rng);
}

// party: [{ userId, name, role }]
function createBattle(monster, party, rng = Math.random) {
  const weight = party.reduce((sum, p) => sum + ROLES[p.role].hpWeight, 0);
  const smallPartyRate = SMALL_PARTY_HP_RATE[party.length] ?? 1;
  const maxHp = Math.max(500, Math.round((monster.baseHp * weight * smallPartyRate) / PARTY_BASE_SIZE / 10) * 10);
  const battle = {
    monster,
    maxHp,
    hp: maxHp,
    rage: false,
    turn: 1,
    intent: null,
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
      manualActions: 0,
    })),
  };
  battle.intent = pickWeighted(INTENT_WEIGHTS.normal, rng);
  return battle;
}

function getMember(battle, userId) {
  return battle.members.find(m => m.userId === userId) || null;
}

function aliveMembers(battle) {
  return battle.members.filter(m => m.hp > 0);
}

// 이 행동을 지금 고를 수 있는지. 안 되면 사유 문구, 되면 null.
function checkChoice(battle, userId, action) {
  const m = getMember(battle, userId);
  if (!m) return '이번 토벌 파티원만 행동할 수 있어요.';
  if (m.hp <= 0) return '쓰러진 상태라 행동할 수 없어요. 치유사의 부활을 기다리세요!';
  if (!ACTIONS[action]) return '알 수 없는 행동이에요.';
  if (action === 'skill' && m.cooldown > 0) return `스킬은 ${m.cooldown}턴 뒤에 다시 쓸 수 있어요.`;
  if (action === 'potion' && m.potions <= 0) return '회복약을 다 썼어요.';
  if (action === 'potion' && m.hp >= PLAYER_MAX_HP) return '이미 HP가 가득 차 있어요.';
  return null;
}

function choose(battle, userId, action) {
  getMember(battle, userId).choice = action;
}

function allChosen(battle) {
  return aliveMembers(battle).every(m => m.choice);
}

function heal(member, amount) {
  const before = member.hp;
  member.hp = Math.min(PLAYER_MAX_HP, member.hp + amount);
  return member.hp - before;
}

// 한 턴을 처리한다. battle.log를 이번 턴 기록으로 바꾸고 결과를 돌려준다:
// 'clear'(토벌) | 'wipe'(전멸) | null(계속).
// battle.lastTurn에는 같은 내용을 그림용 데이터로 남긴다(카드 위 행동 말풍선·받은 피해 숫자 등):
//   { turn, acts: { userId: { label, value, crit, heal, auto } }, hits: { userId: 피해 }, monsterDamage, monsterMove }
function resolveTurn(battle, rng = Math.random) {
  const log = [];
  const last = { turn: battle.turn, acts: {}, hits: {}, monsterDamage: 0, monsterMove: null };
  battle.lastTurn = last;
  const ordered = ROLE_ORDER.map(r => battle.members.find(m => m.role === r)).filter(Boolean);
  const acting = ordered.filter(m => m.hp > 0);

  // 1) 아군 행동
  let taunter = null;
  for (const m of acting) {
    const role = ROLES[m.role];
    const auto = !m.choice;
    const action = m.choice || 'attack';
    if (!auto) m.manualActions++;
    m.guarding = action === 'guard';
    const tag = auto ? ' *(자동)*' : '';

    if (action === 'attack') {
      let dmg = randInt(role.attack, rng);
      const crit = role.critChance && rng() < role.critChance;
      if (crit) dmg = Math.round(dmg * role.critMultiplier);
      battle.hp -= dmg;
      m.damage += dmg;
      last.acts[m.userId] = { label: '공격', value: dmg, crit, auto };
      last.monsterDamage += dmg;
      log.push(`${role.emoji} **${m.name}** 공격${tag} → **${dmg}**${crit ? ' 💥치명타!' : ''}`);
    } else if (action === 'skill') {
      m.cooldown = role.skill.cooldown;
      if (m.role === 'sword') {
        const dmg = randInt([250, 300], rng);
        battle.hp -= dmg;
        m.damage += dmg;
        last.acts[m.userId] = { label: role.skill.name, value: dmg };
        last.monsterDamage += dmg;
        log.push(`${role.emoji} **${m.name}** ✨${role.skill.name} → **${dmg}**`);
      } else if (m.role === 'archer') {
        let dmg = randInt([230, 270], rng);
        const crit = rng() < role.critChance * 2;
        if (crit) dmg = Math.round(dmg * role.critMultiplier);
        battle.hp -= dmg;
        m.damage += dmg;
        last.acts[m.userId] = { label: role.skill.name, value: dmg, crit };
        last.monsterDamage += dmg;
        log.push(`${role.emoji} **${m.name}** ✨${role.skill.name} → **${dmg}**${crit ? ' 💥치명타!' : ''}`);
      } else if (m.role === 'tank') {
        taunter = m;
        last.acts[m.userId] = { label: role.skill.name };
        log.push(`${role.emoji} **${m.name}** ✨${role.skill.name}! 몬스터의 시선을 끈다`);
      } else if (m.role === 'healer') {
        let healed = 0;
        const revived = [];
        for (const t of battle.members) {
          if (t.hp > 0) healed += heal(t, 30);
          else { t.hp = 25; healed += 25; revived.push(t.name); }
        }
        m.healing += healed;
        last.acts[m.userId] = { label: role.skill.name, value: healed, heal: true };
        log.push(`${role.emoji} **${m.name}** ✨${role.skill.name} → 아군 회복${revived.length ? ` · **${revived.join(', ')}** 부활!` : ''}`);
      }
    } else if (action === 'guard') {
      last.acts[m.userId] = { label: '방어' };
      log.push(`${role.emoji} **${m.name}** 방어 태세`);
    } else if (action === 'potion') {
      m.potions--;
      const healed = heal(m, POTION_HEAL);
      m.healing += healed;
      last.acts[m.userId] = { label: '회복약', value: healed, heal: true };
      log.push(`${role.emoji} **${m.name}** 🍖회복약 → HP +${healed}`);
    }

    if (battle.hp <= 0) {
      battle.hp = 0;
      log.push(`🎉 **${battle.monster.name}**을(를) 쓰러뜨렸다!`);
      battle.log = log;
      return 'clear';
    }
  }

  // 2) 몬스터 행동 (지난 턴에 예고한 것)
  const move = battle.monster.moves[battle.intent];
  const mult = battle.rage ? RAGE_DAMAGE_MULTIPLIER : 1;
  const hit = (target) => {
    let dmg = randInt(move.damage, rng) * mult;
    if (target.guarding) dmg *= GUARD_DAMAGE_RATE;
    if (target === taunter) dmg *= TAUNT_DAMAGE_RATE;
    dmg = Math.max(1, Math.round(dmg));
    target.hp = Math.max(0, target.hp - dmg);
    return dmg;
  };
  const monsterName = battle.rage ? battle.monster.rageName : battle.monster.name;
  last.monsterMove = move.name;
  if (move.target === 'none') {
    log.push(`${battle.monster.emoji} **${monsterName}**의 **${move.name}**! 다음 턴에 큰 공격이 온다…`);
  } else {
    const targets = move.target === 'all'
      ? aliveMembers(battle)
      : [taunter && taunter.hp > 0 ? taunter : aliveMembers(battle)[Math.floor(rng() * aliveMembers(battle).length)]];
    const parts = targets.map(t => {
      const dmg = hit(t);
      last.hits[t.userId] = dmg;
      return `${t.name} -${dmg}${t.hp <= 0 ? ' 💀' : ''}`;
    });
    log.push(`${battle.monster.emoji} **${monsterName}**의 **${move.name}**! → ${parts.join(' · ')}`);
  }

  for (const m of battle.members) { m.choice = null; m.guarding = false; }

  if (aliveMembers(battle).length === 0) {
    log.push('☠️ 파티가 전멸했다…');
    battle.log = log;
    return 'wipe';
  }

  // 3) 분노 전환 · 다음 행동 예고 · 턴 넘김
  if (!battle.rage && battle.hp <= battle.maxHp * RAGE_HP_RATIO) {
    battle.rage = true;
    log.push(`🔥 **${battle.monster.rageName}**(으)로 변했다! 공격이 더 강해진다!`);
  }
  battle.intent = pickNextIntent(battle, rng);
  for (const m of battle.members) if (m.cooldown > 0) m.cooldown--;
  battle.turn++;
  battle.log = log;
  return null;
}

module.exports = {
  PLAYER_MAX_HP,
  POTIONS_PER_BATTLE,
  ROLES,
  ROLE_ORDER,
  ACTIONS,
  MONSTERS,
  createBattle,
  getMember,
  aliveMembers,
  checkChoice,
  choose,
  allChosen,
  resolveTurn,
};

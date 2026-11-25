// 알바트리온 밸런스 시뮬레이션: 🔥💧⚡❄️ 4인 파티, 플레이 방식(smart·dumb)별 승률·평균 턴·에스카톤 횟수·억제 성공률.
//   node tests/raid/알바트리온시뮬.js [판수=2000]
// 목표: 서툰(dumb) 승률 10% 미만, 보통(smart) 승률 35~50%, 평균 25~35턴, 에스카톤 평균 2~3회, smart 억제 성공률 65~75%.
const path = require('path');
const E = require(path.join(__dirname, '..', '..', 'handlers', '레이드', '전투.js'));
const A = require(path.join(__dirname, '..', '..', 'handlers', '레이드', '알바트리온.js'));
const MONSTER = E.loadMonsters().find(m => m.id === 'alatreon');
if (!MONSTER) throw new Error('알바트리온 몬스터 없음');
const TRIALS = Number(process.argv[2]) || 2000;
const TURN_CAP = 80;
const ROLES4 = E.ROLE_SETS.elemental;

const canSkill = (b, m) => !E.checkChoice(b, m.userId, 'skill');
const canPotion = (b, m) => !E.checkChoice(b, m.userId, 'potion');
// 이 직업이 지금 속성의 상성 직업인가(용 속성이면 모두 낮은 효율로 해당)
const counters = (b, m) => A.gaugeGain(b.alat, m.role, 'attack') > 0;

// 보통 플레이어: 상성 직업은 게이지를 우선 올리고, 에스카톤 턴엔 게이지가 모자랄 때만 올리고 나머지는 방어한다.
function smart(b, m) {
  const escaton = b.intent === 'smash';
  const full = b.alat.gauge >= A.K.GAUGE_MAX;
  const anyLow = E.aliveMembers(b).some(x => x.hp < 55) || b.members.some(x => x.hp <= 0);
  if (escaton) {
    if (!full && counters(b, m)) return canSkill(b, m) ? 'skill' : 'attack'; // 마지막 게이지를 채운다
    if (m.role === 'ice' && canSkill(b, m)) return 'skill'; // 프로스트 월: 에스카톤 피해 -40%
    return 'guard';
  }
  if (m.hp < 35 && canPotion(b, m)) return 'potion';
  if (m.role === 'water' && anyLow && canSkill(b, m)) return 'skill'; // 회복·부활
  if (E.isWarnIntent(b) && b.monster.moves[b.intent]?.target !== 'none') return 'guard';
  if (counters(b, m) && !full) return canSkill(b, m) ? 'skill' : 'attack';
  if (m.role !== 'water' && m.role !== 'ice' && canSkill(b, m)) return 'skill';
  return 'attack';
}
// 서툰 플레이어: 속성도 기믹도 모르고 늘 공격만 한다.
function dumb() { return 'attack'; }

function run(policy) {
  let win = 0, wipe = 0, timeout = 0, turns = 0, escatons = 0, success = 0, escatonRuns = 0;
  for (let t = 0; t < TRIALS; t++) {
    const party = ROLES4.map((role, i) => ({ userId: 'u' + i, name: 'P' + i, role }));
    const b = E.createBattle(MONSTER, party, Math.random, { minParty: 4 });
    let out = null;
    while (!out && b.turn <= TURN_CAP) {
      for (const m of E.aliveMembers(b)) { const a = policy(b, m); if (a) E.choose(b, m.userId, a); }
      out = E.resolveTurn(b);
      if (b.lastTurn?.escaton) { escatons++; if (b.lastTurn.escaton.suppressed) success++; }
    }
    escatonRuns++;
    if (out === 'clear') { win++; turns += b.turn; } else if (out === 'wipe') wipe++; else timeout++;
  }
  const pct = (n, d) => (d ? Math.round(n / d * 100) : 0);
  return `${policy.name.padEnd(5)} 인원 4 · 승률 ${String(pct(win, TRIALS)).padStart(3)}% · 평균 ${(turns / Math.max(1, win)).toFixed(0)}턴(승리 기준) · 에스카톤 평균 ${(escatons / escatonRuns).toFixed(1)}회 · 억제 성공률 ${pct(success, escatons)}% · 전멸 ${pct(wipe, TRIALS)}% 시간초과 ${pct(timeout, TRIALS)}%`;
}
console.log(`몬스터: ${MONSTER.name} (HP 기준 baseHp ${MONSTER.baseHp}, 판수 ${TRIALS})`);
for (const p of [smart, dumb]) console.log(run(p));

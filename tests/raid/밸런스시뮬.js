// 레이드 밸런스 시뮬레이션: 인원(1~4)·플레이 방식별 승률·평균 턴.
//   node tests/raid/밸런스시뮬.js            → 슬라임
//   node tests/raid/밸런스시뮬.js mushroom   → 몬스터 id(또는 이름)로 고르기
// .js로 끝나는 인자는 다른 전투 엔진 파일(비교용)로 쓴다.
const args = process.argv.slice(2);
const E = require(args.find(a => a.endsWith('.js')) || require('path').join(__dirname, '..', '..', 'handlers', '레이드', '전투.js'));
const pick = args.find(a => !a.endsWith('.js')) || 'slime';
const MONSTER = E.MONSTERS.find(m => m.id === pick || m.name === pick);
if (!MONSTER) throw new Error(`몬스터 없음: ${pick} (있는 것: ${E.MONSTERS.map(m => m.id).join(', ')})`);
console.log(`몬스터: ${MONSTER.name}`);
const TURN_CAP = 60; // 20분 제한 넉넉히
const aliveCount = (b) => E.aliveMembers(b).length;
function smart(b, m) {
  const mv = b.intent;
  const low = E.aliveMembers(b).some(x => x.hp < 50) || b.members.some(x => x.hp <= 0) || E.partyPoisonStacks(b) >= 4;
  if (m.role === 'healer' && low && !E.checkChoice(b, m.userId, 'skill')) return 'skill';
  // 냉기 몬스터(얼음 큐브)만: 치유사가 냉기가 많이 쌓이면 씻어 내고, 필살기 앞에서 방어하면 빙결될 사람은 회복약으로 녹인다.
  // (빙결 직전에 방어를 아예 포기하게 해 봤더니 더 많이 맞아 승률이 오히려 10%p 넘게 떨어졌다 — 빙결 1턴보다 피해가 크다)
  const chill = b.monster.chill;
  if (chill) {
    if (m.role === 'healer' && E.partyChillStacks(b) >= 2 * aliveCount(b) && !E.checkChoice(b, m.userId, 'skill')) return 'skill';
    if (mv === 'smash' && chill.guardStacks && E.chillStacks(b, m) >= chill.freezeAt - chill.guardStacks && !E.checkChoice(b, m.userId, 'potion')) return 'potion';
    // 서리 숨결(방어로 막는 냉기 기술): 이번에 맞으면 얼 사람은 방어
    const cm = b.monster.moves[mv];
    if (cm?.effect === 'chill' && cm.guardBlocks && E.chillStacks(b, m) + (b.rage ? (cm.rageStacks ?? cm.stacks) : cm.stacks) >= chill.freezeAt) return 'guard';
  }
  if (E.isWarnIntent(b)) return 'guard'; // 필살기·대폭발 경고(꼬마 폭탄의 점화는 경고 아님)
  // 표식(유령 영혼 사냥): 수호자는 도발로 대신 맞고, 표식 대상은 방어(수호자가 못 막을 때만 — 분노 2인이면 한 명은 직접)
  const markMove = b.monster.moves[mv]?.mark;
  if (markMove && m.role === 'tank' && !E.checkChoice(b, m.userId, 'skill')) return 'skill';
  if (markMove && b.marks?.includes(m.userId)) {
    const tank = b.members.find(x => x.role === 'tank' && x.hp > 0);
    const tankCovers = tank && !E.checkChoice(b, tank.userId, 'skill') && b.marks[0] === m.userId;
    if (!tankCovers) return 'guard';
  }
  if (E.poisonStacks(b, m) >= 2 && m.hp < 75 && !E.checkChoice(b, m.userId, 'potion')) return 'potion'; // 독이 쌓이면 회복약으로 해독
  if (m.hp < 35 && !E.checkChoice(b, m.userId, 'potion')) return 'potion';
  if (m.role === 'tank' && mv === 'attack' && !E.checkChoice(b, m.userId, 'skill')) return 'skill';
  if ((m.role === 'sword' || m.role === 'archer') && !E.checkChoice(b, m.userId, 'skill')) return 'skill';
  return 'attack';
}
function mash(b, m) { return !E.checkChoice(b, m.userId, 'skill') && m.role !== 'healer' && m.role !== 'tank' ? 'skill' : 'attack'; }
function afk() { return null; }
function normal(b, m) { if (Math.random() < 0.3) return mash(b, m); const a = smart(b, m); return a; }
function run(n, policy, trials = 4000) {
  let win = 0, wipe = 0, timeout = 0, turns = 0;
  for (let t = 0; t < trials; t++) {
    const party = E.ROLE_ORDER.slice(0, n).map((role, i) => ({ userId: 'u' + i, name: 'P' + i, role }));
    const b = E.createBattle(MONSTER, party, Math.random, { minParty: n === 1 ? 1 : undefined });
    let out = null;
    while (!out && b.turn <= TURN_CAP) {
      for (const m of E.aliveMembers(b)) { const a = policy(b, m); if (a) E.choose(b, m.userId, a); }
      out = E.resolveTurn(b);
    }
    if (out === 'clear') { win++; turns += b.turn; } else if (out === 'wipe') wipe++; else timeout++;
  }
  return `${n}인 ${policy.name.padEnd(5)} 승 ${(win / trials * 100).toFixed(0).padStart(3)}% 전멸 ${(wipe / trials * 100).toFixed(0).padStart(3)}% 시간초과 ${(timeout / trials * 100).toFixed(0).padStart(3)}% 평균턴 ${(turns / Math.max(1, win)).toFixed(1)}`;
}
for (const p of [smart, normal, mash]) for (const n of [1, 2, 3, 4]) console.log(run(n, p));

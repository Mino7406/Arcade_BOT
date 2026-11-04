// 레이드 밸런스 시뮬레이션: 인원(1~4)·플레이 방식별 승률·평균 턴. node tests/raid/밸런스시뮬.js
const E = require(process.argv[2] || require('path').join(__dirname, '..', '..', 'handlers', '레이드전투.js'));
const TURN_CAP = 60; // 15분 제한 넉넉히
function smart(b, m) {
  const mv = b.intent;
  const low = E.aliveMembers(b).some(x => x.hp < 50) || b.members.some(x => x.hp <= 0);
  if (m.role === 'healer' && low && !E.checkChoice(b, m.userId, 'skill')) return 'skill';
  if (mv === 'smash') return 'guard';
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
    const b = E.createBattle(E.MONSTERS[0], party);
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

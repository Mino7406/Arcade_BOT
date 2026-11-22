// 발로집계.js — 발로란트 경기 목록(헨릭.js의 parseStoredMatches)의 최근 N판 통계(순수 계산).
const sum = (list, get) => list.reduce((t, x) => t + get(x), 0);

function groupBy(list, keyOf) {
  const map = new Map();
  for (const m of list) {
    const k = keyOf(m);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(m);
  }
  return map;
}

const winsOf = list => list.filter(m => m.result === 'win').length;
const ratio = (a, b) => (b > 0 ? a / b : null);

// → { games, wins, losses, avgK, avgD, avgA, kd, acs, adr, hs, agents: [{id, name, games, wins, kd}] (상위 3) }
// 승패는 팀 모드만(개인전은 승패 없음). ACS·ADR 은 라운드당 평균(점수 합 / 라운드 합)이라 라운드가 있는 모드만 계산한다. hs 는 헤드샷 비율(0~1). 데스가 0 이면 kd 는 null.
function summarizeValorant(matches) {
  const games = matches.length;
  const roundMatches = matches.filter(m => m.hasRounds);
  const rounds = sum(roundMatches, m => m.rounds[0] + m.rounds[1]);
  const shots = sum(matches, m => m.head + m.body + m.leg);
  const n = games || 1;
  const agents = [...groupBy(matches, m => m.agent.id)].map(([id, list]) => ({
    id, name: list[0].agent.name, games: list.length, wins: winsOf(list), kd: ratio(sum(list, m => m.k), sum(list, m => m.d)),
  })).sort((x, y) => y.games - x.games || y.wins - x.wins).slice(0, 3);
  return {
    games,
    wins: winsOf(matches),
    losses: matches.filter(m => m.result === 'loss').length,
    avgK: sum(matches, m => m.k) / n, avgD: sum(matches, m => m.d) / n, avgA: sum(matches, m => m.a) / n,
    kd: ratio(sum(matches, m => m.k), sum(matches, m => m.d)),
    acs: rounds ? sum(roundMatches, m => m.score) / rounds : 0,
    adr: rounds ? sum(roundMatches, m => m.dmg) / rounds : 0,
    hs: shots ? sum(matches, m => m.head) / shots : 0,
    agents,
  };
}

module.exports = { summarizeValorant };

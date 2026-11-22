// 집계.js — match-v5 원본에서 한 사람의 값만 추려 저장용으로 줄이고, 최근 경기들의 통계를 낸다(순수 계산).
const MIN_DURATION_SEC = 180; // 3분 미만은 다시하기라 기록하지 않는다

const QUEUE_NAMES = { 420: '솔로랭크', 440: '자유랭크', 450: '칼바람', 400: '일반', 430: '일반', 490: '빠른 대전', 1700: '아레나' };
function queueLabel(id) {
  return QUEUE_NAMES[id] ?? '일반 게임';
}

// 원본 경기에서 puuid 참가자의 값만 추린다. 그 사람이 없거나 다시하기면 null.
function compactMatch(raw, puuid) {
  const info = raw?.info;
  const p = info?.participants?.find(x => x.puuid === puuid);
  if (!p || !(info.gameDuration >= MIN_DURATION_SEC)) return null;
  const multi = p.pentaKills ? 5 : p.quadraKills ? 4 : p.tripleKills ? 3 : p.doubleKills ? 2 : 0;
  const teamKills = info.participants.filter(x => x.teamId === p.teamId).reduce((sum, x) => sum + (x.kills || 0), 0);
  return {
    id: raw.metadata?.matchId ?? String(info.gameId),
    ts: info.gameEndTimestamp ?? info.gameCreation ?? 0,
    dur: info.gameDuration,
    queue: info.queueId,
    win: !!p.win,
    champ: p.championName,
    champId: p.championId,
    k: p.kills || 0, d: p.deaths || 0, a: p.assists || 0,
    cs: (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0),
    lvl: p.champLevel || 0,
    items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6].map(x => x || 0),
    spells: [p.summoner1Id, p.summoner2Id],
    keystone: p.perks?.styles?.[0]?.selections?.[0]?.perk ?? 0,
    subStyle: p.perks?.styles?.[1]?.style ?? 0,
    vision: p.visionWardsBoughtInGame || 0,
    pos: p.teamPosition || '',
    multi,
    teamKills,
  };
}

// (K+A)/D. 데스가 0이면 null — 화면에서 "Perfect"로 보여 준다.
function ratio(k, d, a) {
  return d > 0 ? (k + a) / d : null;
}

function killParticipation(m) {
  return m.teamKills > 0 ? (m.k + m.a) / m.teamKills : 0;
}

function tally(list) {
  const t = { games: list.length, wins: 0, k: 0, d: 0, a: 0 };
  for (const m of list) { if (m.win) t.wins++; t.k += m.k; t.d += m.d; t.a += m.a; }
  return t;
}

function summarize(matches) {
  const t = tally(matches);
  const n = t.games || 1;
  const byChamp = new Map();
  const byPos = new Map();
  for (const m of matches) {
    if (!byChamp.has(m.champ)) byChamp.set(m.champ, []);
    byChamp.get(m.champ).push(m);
    if (m.pos) {
      if (!byPos.has(m.pos)) byPos.set(m.pos, []);
      byPos.get(m.pos).push(m);
    }
  }
  const champs = [...byChamp].map(([champ, list]) => {
    const c = tally(list);
    return { champ, games: c.games, wins: c.wins, rating: ratio(c.k, c.d, c.a) };
  }).sort((x, y) => y.games - x.games || y.wins - x.wins).slice(0, 3);
  const positions = [...byPos].map(([pos, list]) => ({ pos, games: list.length, wins: list.filter(m => m.win).length }))
    .sort((x, y) => y.games - x.games).slice(0, 2);
  return {
    games: t.games, wins: t.wins, losses: t.games - t.wins,
    avgK: t.k / n, avgD: t.d / n, avgA: t.a / n,
    rating: ratio(t.k, t.d, t.a),
    champs, positions,
  };
}

module.exports = { compactMatch, ratio, killParticipation, summarize, queueLabel, QUEUE_NAMES };

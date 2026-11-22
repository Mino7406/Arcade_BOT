// 헨릭.js — 발로란트 전적(HenrikDev 비공식 API). 윤수봇(bot/games/gameprofiles.py)과 같은 주소·같은 읽기 규칙이다.
// 현재 티어·RR·최고 티어·시즌별 요약을 가져온다. Riot 공식 API 는 개인 키로 발로란트 전적을 못 받아서 이 API 를 쓴다.
const { RiotError } = require('./리오트');

const BASE = 'https://api.henrikdev.xyz';

const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);

// HenrikDev v3 mmr 응답 → { name, tier, rr, peak, seasons: [{ season, endTier, wins, games }] }. 읽을 게 없으면 not_found.
function parseValorant(data) {
  if (!isObj(data) || !isObj(data.data)) throw new RiotError('not_found', 0);
  const d = data.data;
  const acc = isObj(d.account) ? d.account : {};
  const cur = isObj(d.current) ? d.current : {};
  const peak = isObj(d.peak) ? d.peak : {};
  const tierName = x => (isObj(x) && isObj(x.tier) ? String(x.tier.name ?? '') : '');
  const profile = {
    name: `${acc.name ?? ''}#${acc.tag ?? ''}`.replace(/^#|#$/g, ''),
    tier: tierName(cur),
    rr: Number.isInteger(cur.rr) ? cur.rr : null,
    peak: tierName(peak),
    seasons: [],
  };
  for (const s of Array.isArray(d.seasonal) ? d.seasonal : []) {
    if (!isObj(s) || !Number.isInteger(s.games) || !s.games) continue;
    profile.seasons.push({
      season: isObj(s.season) ? String(s.season.short ?? '?') : '?',
      endTier: isObj(s.end_tier) ? String(s.end_tier.name ?? '') : '',
      wins: Number(s.wins) || 0,
      games: s.games,
    });
  }
  // 계정은 있는데 경쟁전 기록이 없으면(언랭크) 오류가 아니라 빈 기록으로 보여 준다
  if (!profile.tier && !profile.seasons.length && !profile.peak && !profile.name) throw new RiotError('not_found', 0);
  return profile;
}

function kindOf(status) {
  if (status === 404) return 'not_found';
  if (status === 401 || status === 403) return 'denied';
  if (status === 429) return 'rate';
  return 'unavailable';
}

// kr 에서 못 찾으면 ap 를 시도한다. 키 거부·한도·서버 오류는 다른 지역을 시도해도 같으므로 바로 던진다.
async function fetchValorant({ name, tag, key, fetchFn = fetch, regions = ['kr', 'ap'] }) {
  if (!key) throw new RiotError('no_key', 0);
  let last = new RiotError('not_found', 404);
  for (const region of regions) {
    let res;
    try {
      res = await fetchFn(`${BASE}/valorant/v3/mmr/${region}/pc/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`, { headers: { Authorization: key } });
    } catch {
      throw new RiotError('unavailable', 0);
    }
    if (!res.ok) {
      last = new RiotError(kindOf(res.status), res.status);
      if (last.kind !== 'not_found') throw last;
      continue;
    }
    try {
      return parseValorant(await res.json());
    } catch (err) {
      if (!(err instanceof RiotError)) throw new RiotError('unavailable', 0);
      last = err;
    }
  }
  throw last;
}

module.exports = { parseValorant, fetchValorant };

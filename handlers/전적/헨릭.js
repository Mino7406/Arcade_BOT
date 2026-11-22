// 헨릭.js — 발로란트 전적(HenrikDev 비공식 API). Riot 공식 API 는 개인 키로 발로란트 전적을 못 받아서 이 API 를 쓴다.
//  - v3 mmr: 현재 티어·RR·최고 티어·시즌별 요약 (윤수봇과 같은 주소)
//  - v1 stored-matches: 최근 경쟁전 경기 목록(맵·요원·K/D/A·점수·피해·라운드 스코어). 20판이 13KB 정도라 가볍다.
const { RiotError } = require('./리오트');

const BASE = 'https://api.henrikdev.xyz';
const MATCH_COUNT = 100; // 한 번에 100판(약 65KB)을 받아 모드 탭은 화면에서 거른다 → 탭을 바꿔도 호출이 늘지 않는다

// HenrikDev 의 모드 이름 → [탭 분류, 한글 이름, 라운드가 있는 모드인가]. 탭: comp 경쟁전 · unrated 일반 · swift 빠른 대전 · etc 나머지.
const MODES = {
  Competitive: ['comp', '경쟁전', true], Unrated: ['unrated', '일반', true], Swiftplay: ['swift', '빠른 대전', true],
  'Spike Rush': ['etc', '스파이크 러시', true], Premier: ['etc', '프리미어', true], 'Custom Game': ['etc', '사용자 지정', true], 'All Random One Site': ['etc', '랜덤 원 사이트', true],
  Deathmatch: ['etc', '데스매치', false], 'Team Deathmatch': ['etc', '팀 데스매치', false], Escalation: ['etc', '에스컬레이션', false], Replication: ['etc', '복제', false], 'Snowball Fight': ['etc', '눈싸움', false],
};
function modeInfo(raw) {
  return MODES[raw] ?? ['etc', !raw || raw === 'unknown' ? '기타 모드' : raw, true];
}

const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);

// HenrikDev v3 mmr 응답 → { name, tier, rr, peak, seasons: [{ season, endTier, wins, games }] }. 계정 정보조차 없으면 not_found.
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

// stored-matches 응답 → 최근순 경기 목록. 깨진 항목은 건너뛴다.
// Match = { id, ts, mode, modeKey, modeLabel, hasRounds, map: {id, name}, agent: {id, name}, tier(번호), k, d, a, score, head, body, leg, dmg,
//           rounds: [내 팀, 상대 팀](개인전은 [0, 0]), result: 'win'|'loss'|'draw'|'none'(개인전이라 승패 없음) }
// hasRounds 가 false 인 모드(데스매치류)는 점수가 "킬 수"라서 ACS·ADR 을 계산하지 않는다.
function parseStoredMatches(data) {
  const out = [];
  for (const m of isObj(data) && Array.isArray(data.data) ? data.data : []) {
    if (!isObj(m) || !isObj(m.meta) || !isObj(m.stats) || !isObj(m.teams) || !m.meta.id) continue;
    const st = m.stats;
    const team = String(st.team ?? '').toLowerCase();
    const teamMode = team === 'red' || team === 'blue'; // 개인전(데스매치)은 team 이 내 id 라서 승패가 없다
    const mine = teamMode ? Number(m.teams[team]) : 0, theirs = teamMode ? Number(m.teams[team === 'red' ? 'blue' : 'red']) : 0;
    if (!Number.isFinite(mine) || !Number.isFinite(theirs) || !isObj(st.character)) continue;
    const shots = isObj(st.shots) ? st.shots : {};
    const [modeKey, modeLabel, hasRounds] = modeInfo(String(m.meta.mode ?? ''));
    out.push({
      id: String(m.meta.id),
      ts: Date.parse(m.meta.started_at) || 0,
      mode: String(m.meta.mode ?? ''), modeKey, modeLabel, hasRounds,
      map: { id: String(m.meta.map?.id ?? ''), name: String(m.meta.map?.name ?? '') },
      agent: { id: String(st.character.id ?? ''), name: String(st.character.name ?? '') },
      tier: Number(st.tier) || 0,
      k: Number(st.kills) || 0, d: Number(st.deaths) || 0, a: Number(st.assists) || 0,
      score: Number(st.score) || 0,
      head: Number(shots.head) || 0, body: Number(shots.body) || 0, leg: Number(shots.leg) || 0,
      dmg: Number(st.damage?.made) || 0,
      rounds: [mine, theirs],
      result: !teamMode ? 'none' : mine > theirs ? 'win' : mine < theirs ? 'loss' : 'draw',
    });
  }
  return out.sort((x, y) => y.ts - x.ts);
}

function kindOf(status) {
  if (status === 404) return 'not_found';
  if (status === 401 || status === 403) return 'denied';
  if (status === 429) return 'rate';
  return 'unavailable';
}

// kr 에서 못 찾으면 ap 를 시도한다. 키 거부·한도·서버 오류는 다른 지역을 시도해도 같으므로 바로 던진다.
async function fetchRegions({ key, fetchFn, regions, urlOf, parse }) {
  if (!key) throw new RiotError('no_key', 0);
  let last = new RiotError('not_found', 404);
  for (const region of regions) {
    let res;
    try {
      res = await fetchFn(urlOf(region), { headers: { Authorization: key } });
    } catch {
      throw new RiotError('unavailable', 0);
    }
    if (!res.ok) {
      last = new RiotError(kindOf(res.status), res.status);
      if (last.kind !== 'not_found') throw last;
      continue;
    }
    try {
      return parse(await res.json());
    } catch (err) {
      if (!(err instanceof RiotError)) throw new RiotError('unavailable', 0);
      last = err;
    }
  }
  throw last;
}

const enc = encodeURIComponent;

function fetchValorant({ name, tag, key, fetchFn = fetch, regions = ['kr', 'ap'] }) {
  return fetchRegions({ key, fetchFn, regions, urlOf: r => `${BASE}/valorant/v3/mmr/${r}/pc/${enc(name)}/${enc(tag)}`, parse: parseValorant });
}

// 최근 경기(모든 모드, 기본 100판). mode 를 주면 그 모드만. 경기가 없으면 빈 목록.
function fetchValorantMatches({ name, tag, key, fetchFn = fetch, regions = ['kr', 'ap'], size = MATCH_COUNT, mode }) {
  return fetchRegions({
    key, fetchFn, regions, parse: parseStoredMatches,
    urlOf: r => `${BASE}/valorant/v1/stored-matches/${r}/${enc(name)}/${enc(tag)}?${mode ? `mode=${mode}&` : ''}size=${size}`,
  });
}

module.exports = { parseValorant, fetchValorant, parseStoredMatches, fetchValorantMatches };

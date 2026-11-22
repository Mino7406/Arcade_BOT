// 리오트.js — Riot 공식 API(롤) 호출. 호출은 전부 요청 대기열(limiter)을 거친다.
// account-v1·match-v5 는 asia, summoner-v4·league-v4 는 kr 서버로 보낸다. 키는 헤더에만 쓰고 메시지·로그에 남기지 않는다.
const ASIA = 'https://asia.api.riotgames.com';
const KR = 'https://kr.api.riotgames.com';
const MAX_RETRY_WAIT_MS = 10000;

class RiotError extends Error {
  constructor(kind, status) {
    super(`Riot API 오류(${kind}, ${status})`);
    this.kind = kind;   // 'not_found' | 'denied' | 'rate' | 'unavailable'
    this.status = status;
  }
}

function kindOf(status) {
  if (status === 404) return 'not_found';
  if (status === 401 || status === 403) return 'denied';
  if (status === 429) return 'rate';
  return 'unavailable';
}

const MESSAGES = {
  not_found: '그 닉네임의 계정을 찾을 수 없어요. 이름#태그를 다시 확인해 주세요.',
  denied: 'Riot API 키가 만료됐거나 거부됐어요. 관리자에게 알려 주세요.',
  rate: '요청이 몰려 있어요. 잠시 후 다시 해 주세요.',
  unavailable: 'Riot 서버가 응답하지 않아요. 잠시 후 다시 해 주세요.',
  no_key: '발로란트 전적 키가 설정되지 않았어요. 관리자에게 알려 주세요.',
};

function riotErrorMessage(err) {
  return MESSAGES[err?.kind] ?? MESSAGES.unavailable;
}

function createRiotClient({ key, fetchFn = fetch, limiter }) {
  async function get(url) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await limiter.schedule(() => fetchFn(url, { headers: { 'X-Riot-Token': key } }));
      } catch {
        throw new RiotError('unavailable', 0);
      }
      if (res.ok) return res.json();
      if (res.status === 429 && attempt === 0) {
        const wait = Math.min(MAX_RETRY_WAIT_MS, (Number(res.headers.get('retry-after')) || 1) * 1000);
        limiter.penalize(wait);
        continue;
      }
      throw new RiotError(kindOf(res.status), res.status);
    }
  }

  const enc = encodeURIComponent;
  return {
    accountByRiotId: (name, tag) => get(`${ASIA}/riot/account/v1/accounts/by-riot-id/${enc(name)}/${enc(tag)}`),
    summonerByPuuid: puuid => get(`${KR}/lol/summoner/v4/summoners/by-puuid/${enc(puuid)}`),
    leagueEntries: puuid => get(`${KR}/lol/league/v4/entries/by-puuid/${enc(puuid)}`),
    matchIds: (puuid, { count = 20, queue } = {}) =>
      get(`${ASIA}/lol/match/v5/matches/by-puuid/${enc(puuid)}/ids?start=0&count=${count}${queue ? `&queue=${queue}` : ''}`),
    match: id => get(`${ASIA}/lol/match/v5/matches/${enc(id)}`),
  };
}

module.exports = { createRiotClient, RiotError, riotErrorMessage };

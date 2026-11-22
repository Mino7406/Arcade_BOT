// 발로.js — 발로란트 전적 조회 한 번의 흐름: HenrikDev(티어·RR + 최근 100판) → 모드 탭으로 거르기 → 요원·맵·티어 이름과 아이콘(valorant-api.com) → 통계 → 그림.
// 롤 서비스(롤.js)와 같은 결과 모양을 돌려준다.
// 호출 한도(HenrikDev 는 키당 분당 30회)를 아끼려고: ① 티어·경기 목록을 잠시(기본 2분) 두고 쓰고 ② 탭은 받아 둔 100판에서 거르며 ③ 같은 조회는 합치고 ④ 호출은 분당 25회 대기열로 보낸다.
const { RiotError, riotErrorMessage } = require('./리오트');
const { createLimiter } = require('./요청대기열');
const { fetchValorant, fetchValorantMatches } = require('./헨릭');
const { summarizeValorant } = require('./발로집계');
const { renderValorant, tierKo } = require('./발로그림');

const API = 'https://valorant-api.com/v1';
const TABLE_TTL_MS = 6 * 3600 * 1000;
const CACHE_MS = 2 * 60 * 1000;
const CACHE_PLAYERS = 50;
const STATS_GAMES = 20;
const LIST_GAMES = 5;
const ICON_SIZE = 128; // 요원 아이콘 원본이 1024×1024 라 줄여서 저장한다
const TAB_LABEL = { all: '전체', comp: '경쟁전', unrated: '일반전', swift: '신속 플레이', spike: '스파이크 돌격', tdm: '팀 데스매치', dm: '데스매치' };
const LAST_RESORT_MESSAGE = '전적을 불러오지 못했어요. 잠시 후 다시 해 주세요.';

function plainText(profile, summary, rows, names, tab) {
  const lines = [`**${profile.name}** (${tab})`, `현재: ${tierKo(profile.tier)}${profile.rr !== null ? ` ${profile.rr} RR` : ''}`, `최고: ${profile.peak ? tierKo(profile.peak) : '-'}`];
  if (summary.games) lines.push(`최근 ${summary.games}판: ${summary.wins}승 ${summary.losses}패`);
  const label = { win: '승', loss: '패', draw: '무', none: '-' };
  for (const m of rows) lines.push(`${label[m.result]} ${m.modeLabel} ${m.rounds[0]}:${m.rounds[1]} ${names.maps[m.map.id] ?? m.map.name} ${names.agents[m.agent.id] ?? m.agent.name} ${m.k}/${m.d}/${m.a}`);
  return lines.join('\n');
}

function createValorantService({
  key, statics, fetchFn = fetch, fetchJson = async u => (await fetch(u)).json(), render = renderValorant,
  now = Date.now, cacheMs = CACHE_MS, limiter = createLimiter({ perSecond: 2, perWindow: 25, windowMs: 60000 }),
}) {
  const limitedFetch = (url, opt) => limiter.schedule(() => fetchFn(url, opt));
  let table = null, tableAt = 0;

  // 요원(한글 이름·아이콘 주소)·맵(한글 이름)·티어(번호·이름 → 아이콘 주소) 표. 6시간 캐시, 못 받으면 빈 표(영문 이름·빈 아이콘으로 그림).
  async function getTable() {
    if (table && Date.now() - tableAt <= TABLE_TTL_MS) return table;
    const next = { agents: {}, maps: {}, tiersByNumber: {}, tiersByName: {} };
    try {
      const [agents, maps, tiers] = await Promise.all([
        fetchJson(`${API}/agents?language=ko-KR&isPlayableCharacter=true`),
        fetchJson(`${API}/maps?language=ko-KR`),
        fetchJson(`${API}/competitivetiers`),
      ]);
      for (const a of agents.data) next.agents[a.uuid] = { name: a.displayName, icon: a.displayIconSmall ?? a.displayIcon };
      for (const m of maps.data) next.maps[m.uuid] = m.displayName;
      for (const t of tiers.data.at(-1).tiers) {
        if (!t.smallIcon) continue;
        next.tiersByNumber[t.tier] = t.smallIcon;
        if (t.tierName) next.tiersByName[t.tierName.trim().toLowerCase()] = t.smallIcon;
      }
      table = next;
      tableAt = Date.now();
    } catch (err) {
      console.error('valorant-api 표를 불러오지 못했어요(영문 이름·아이콘 없이 표시):', err?.message ?? err);
      return table ?? next;
    }
    return table;
  }

  // ── 티어·경기 목록: 잠시 두고 쓰고(탭을 바꿔도 호출 0번), 같은 요청은 합친다. 실패는 두지 않는다. ──
  const cache = new Map();    // 'name#tag' → { at, profile, matches }
  const loading = new Map();  // 'name#tag' → 진행 중인 요청
  async function load({ name, tag }) {
    const id = `${name}#${tag}`;
    const hit = cache.get(id);
    if (hit && now() - hit.at <= cacheMs) return hit;
    if (!loading.has(id)) {
      loading.set(id, (async () => {
        const [profile, matches] = await Promise.all([
          fetchValorant({ name, tag, key, fetchFn: limitedFetch }),
          // 경기 목록이 없어도(404) 티어 화면은 보여 준다. 한도·키 오류는 그대로 안내한다.
          fetchValorantMatches({ name, tag, key, fetchFn: limitedFetch }).catch(err => { if (err instanceof RiotError && err.kind === 'not_found') return []; throw err; }),
        ]);
        const entry = { at: now(), profile, matches };
        cache.delete(id);
        cache.set(id, entry);
        if (cache.size > CACHE_PLAYERS) cache.delete(cache.keys().next().value); // 가장 오래된 사람부터 버린다
        return entry;
      })().finally(() => loading.delete(id)));
    }
    return loading.get(id);
  }

  async function run({ name, tag }, tab) {
    const { profile, matches: all } = await load({ name, tag });
    const t = await getTable();
    const picked = (tab === 'all' ? all : all.filter(m => m.modeKey === tab)).slice(0, STATS_GAMES);
    const summary = summarizeValorant(picked);
    const rows = picked.slice(0, LIST_GAMES);

    const icons = { tier: null, tiers: {}, agents: {} };
    const jobs = [];
    const tierUrl = profile.tier ? t.tiersByName[profile.tier.trim().toLowerCase()] : null;
    if (tierUrl) jobs.push(statics.urlIcon('valorant-tier', profile.tier, tierUrl).then(f => { icons.tier = f; }));
    for (const num of new Set(rows.map(m => m.tier))) {
      if (num > 0 && t.tiersByNumber[num]) jobs.push(statics.urlIcon('valorant-tier', `n${num}`, t.tiersByNumber[num]).then(f => { icons.tiers[num] = f; }));
    }
    for (const id of new Set([...rows.map(m => m.agent.id), ...summary.agents.map(a => a.id)])) {
      if (t.agents[id]?.icon) jobs.push(statics.urlIcon('valorant-agent', id, t.agents[id].icon, { size: ICON_SIZE }).then(f => { icons.agents[id] = f; }));
    }
    await Promise.all(jobs);

    const names = { agents: Object.fromEntries(Object.entries(t.agents).map(([id, a]) => [id, a.name])), maps: t.maps };
    const label = TAB_LABEL[tab] ?? TAB_LABEL.all;
    const png = render({ profile, summary, matches: rows, icons, names, tab: label, now: now() });
    return { ok: true, png: png ?? null, text: plainText(profile, summary, rows, names, label), label: profile.name || `${name}#${tag}`, id: `${name}#${tag}`, tab };
  }

  // lookup({ name, tag }, tab) — tab: all | comp | unrated | swift | etc. 같은 조회가 동시에 들어오면 한 번만 만든다.
  const inflight = new Map();
  function lookup(target, tab = 'all') {
    if (!TAB_LABEL[tab]) tab = 'all';
    const id = `${target.name}#${target.tag}|${tab}`;
    if (!inflight.has(id)) {
      inflight.set(id, run(target, tab).catch(err => {
        if (err instanceof RiotError) return { ok: false, message: riotErrorMessage(err) };
        console.error('발로란트 전적 조회 실패:', err);
        return { ok: false, message: LAST_RESORT_MESSAGE };
      }).finally(() => inflight.delete(id)));
    }
    return inflight.get(id);
  }

  return { lookup };
}

module.exports = { createValorantService, TAB_LABEL };

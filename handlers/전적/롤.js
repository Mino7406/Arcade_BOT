// 롤.js — 롤 전적 조회 한 번의 흐름: 계정 확인 → 랭크·레벨 → 경기 목록 → 새 경기만 받아 저장 → 통계 → 그림.
// 호출 수를 아끼는 것이 핵심이다: 끝난 경기는 저장소에 있으면 다시 받지 않는다(같은 계정 재조회는 경기 호출 0번).
const fs = require('fs');
const path = require('path');
const { RiotError, riotErrorMessage } = require('./리오트');
const { compactMatch, summarize, ratio, queueLabel } = require('./집계');
const { renderLol, tierText } = require('./롤그림');

// 탭 → 큐 번호들('all' 은 제한 없음). 솔로랭크 420, 자유랭크 440, 일반은 일반 선택(400)·팀 선택(430)·빠른 대전(490), 아레나는 1700.
const QUEUES = { solo: [420], flex: [440], normal: [400, 430, 490], aram: [450], arena: [1700] };
const UNRANKED_EMBLEM = path.join(__dirname, '..', '..', 'assets', '이모지', 'rec_lol_unranked.png');
// 선호 포지션 로고(팀 설정에서 쓰는 롤 포지션 아이콘): 라이엇 포지션 이름 → 파일
const POSITION_FILES = { TOP: 'top', JUNGLE: 'jungle', MIDDLE: 'mid', BOTTOM: 'adc', UTILITY: 'support' };
const POSITION_DIR = path.join(__dirname, '..', '..', 'assets', '티어');
const STATS_GAMES = 20;
const LIST_GAMES = 5;
const CACHE_MS = 60 * 1000;   // 계정·랭크·경기 목록·완성된 그림을 잠시 두고 쓴다(탭을 바꿔도 호출이 늘지 않게)
const CACHE_ENTRIES = 30;      // 종류별로 최대 30개(그림 한 장이 100~200KB 라 서버 메모리 보호)
const LAST_RESORT_MESSAGE = '전적을 불러오지 못했어요. 잠시 후 다시 해 주세요.';

function rankOf(entries, queueType) {
  const e = entries.find(x => x.queueType === queueType);
  return e ? { tier: e.tier, rank: e.rank, lp: e.leaguePoints, wins: e.wins, losses: e.losses } : null;
}

function plainText(v) {
  const tier = r => (r ? `${tierText(r)} ${r.lp} LP, ${r.wins}승 ${r.losses}패` : '언랭크');
  const lines = [`**${v.name}#${v.tag}** (레벨 ${v.level ?? '?'})`, `솔로랭크: ${tier(v.solo)}`, `자유랭크: ${tier(v.flex)}`, `최근 ${v.summary.games}판: ${v.summary.wins}승 ${v.summary.losses}패`];
  for (const m of v.matches) {
    const r = ratio(m.k, m.d, m.a);
    lines.push(`${m.win ? '승' : '패'} ${v.names[m.champ] ?? m.champ} ${m.k}/${m.d}/${m.a} (${r === null ? 'Perfect' : r.toFixed(2)}) · ${queueLabel(m.queue)}`);
  }
  return lines.join('\n');
}

function createLolService({ riot, store, statics, render = renderLol, now = Date.now, cacheMs = CACHE_MS }) {
  const profiles = new Map(); // puuid → { at, puuid, summoner, entries, name, tag }
  const idLists = new Map();  // 'puuid|탭' → { at, ids }
  const results = new Map();  // 'puuid|탭' → { at, value }  (완성된 결과: 그림 포함)
  const fresh = (map, key) => { const e = map.get(key); return e && now() - e.at < cacheMs ? e : null; };
  const remember = (map, key, value) => {
    map.delete(key);
    map.set(key, { at: now(), ...value });
    while (map.size > CACHE_ENTRIES) map.delete(map.keys().next().value); // 가장 오래된 것부터 버린다
  };

  // 그림에 필요한 아이콘 파일 경로를 모은다(없는 건 null → 그림이 빈 칸으로 그림).
  async function collectIcons(profileIconId, solo, flex, matches, champKeys) {
    const icons = { profile: null, solo: null, flex: null, champs: {}, items: {}, spells: {}, runes: {}, styles: {} };
    const jobs = [];
    const add = (bucket, key, kind, id) => { if (id && !(key in bucket)) { bucket[key] = null; jobs.push(statics.iconFile(kind, id).then(f => { bucket[key] = f; })); } };
    jobs.push(statics.iconFile('profile', profileIconId).then(f => { icons.profile = f; }));
    if (solo) jobs.push(statics.iconFile('emblem', solo.tier).then(f => { icons.solo = f; }));
    if (flex) jobs.push(statics.iconFile('emblem', flex.tier).then(f => { icons.flex = f; }));
    for (const c of champKeys) add(icons.champs, c, 'champion', c);
    for (const m of matches) {
      for (const id of m.items) add(icons.items, id, 'item', id);
      for (const id of m.spells) add(icons.spells, id, 'spell', id);
      add(icons.runes, m.keystone, 'rune', m.keystone);
      add(icons.styles, m.subStyle, 'style', m.subStyle);
    }
    await Promise.all(jobs);
    return icons;
  }

  async function fetchNewMatches(puuid, queue) {
    const key = `${puuid}|${queue}`;
    let ids = fresh(idLists, key)?.ids;
    if (!ids) {
      const qs = QUEUES[queue] ?? [];
      const lists = qs.length
        ? await Promise.all(qs.map(q => riot.matchIds(puuid, { count: qs.length > 1 ? 10 : STATS_GAMES, queue: q })))
        : [await riot.matchIds(puuid, { count: STATS_GAMES })];
      ids = [...new Set(lists.flat())];
      remember(idLists, key, { ids });
    }
    const missing = ids.filter(id => !store.has(puuid, id));
    await Promise.all(missing.map(async id => {
      const compact = compactMatch(await riot.match(id), puuid);
      store.add(puuid, compact ?? { id, ts: 0, queue: 0, skip: true }); // 다시하기 등은 표시만 해 두고 다시 받지 않는다
    }));
    if (missing.length) store.save();
  }

  // 계정(이름)·레벨·랭크. 잠시 두고 쓴다 — 탭 버튼은 puuid 만 들고 오므로 이름 조회도 한 번만 한다.
  async function loadProfile({ name, tag, puuid }) {
    const hit = puuid && fresh(profiles, puuid);
    if (hit) return hit;
    let shownName = name, shownTag = tag;
    if (!puuid || !name) {
      const acc = puuid ? await riot.accountByPuuid(puuid) : await riot.accountByRiotId(name, tag);
      puuid = acc.puuid ?? puuid; shownName = acc.gameName ?? name; shownTag = acc.tagLine ?? tag;
    }
    const [summoner, entries] = await Promise.all([riot.summonerByPuuid(puuid), riot.leagueEntries(puuid)]);
    remember(profiles, puuid, { puuid, summoner, entries, name: shownName, tag: shownTag });
    return profiles.get(puuid);
  }

  async function run(target, queue) {
    const { puuid, summoner, entries, name: shownName, tag: shownTag } = await loadProfile(target);
    await statics.load();
    await fetchNewMatches(puuid, queue);
    const recent = store.list(puuid, QUEUES[queue]).slice(0, STATS_GAMES);
    const summary = summarize(recent);
    const rows = recent.slice(0, LIST_GAMES);
    const solo = rankOf(entries, 'RANKED_SOLO_5x5');
    const flex = rankOf(entries, 'RANKED_FLEX_SR');
    const champKeys = [...new Set([...rows.map(m => m.champ), ...summary.champs.map(c => c.champ)])];
    const icons = await collectIcons(summoner.profileIconId, solo, flex, rows, champKeys);
    if (fs.existsSync(UNRANKED_EMBLEM)) icons.unranked = UNRANKED_EMBLEM; // 랭크 기록이 없으면 이 엠블럼을 그린다
    icons.positions = {};
    for (const p of summary.positions) {
      const file = POSITION_FILES[p.pos] && path.join(POSITION_DIR, `pos_lol_${POSITION_FILES[p.pos]}.png`);
      if (file && fs.existsSync(file)) icons.positions[p.pos] = file;
    }
    const view = { name: shownName, tag: shownTag, level: summoner.summonerLevel, queue, solo, flex, summary, matches: rows, icons, names: Object.fromEntries(champKeys.map(c => [c, statics.champName(c)])) };
    const png = render(view);
    return { ok: true, png: png ?? null, text: plainText(view), puuid, label: `${shownName}#${shownTag}` };
  }

  async function lookupOnce(target, queue) {
    try {
      try {
        return await run(target, queue);
      } catch (err) {
        // 저장해 둔 puuid 가 무효(Riot puuid 는 API 키마다 달라서 키를 바꾸면 400)면 이름으로 다시 찾아 한 번 더 시도한다
        if (err instanceof RiotError && err.status === 400 && target.puuid && target.name && target.tag) return await run({ name: target.name, tag: target.tag }, queue);
        throw err;
      }
    } catch (err) {
      if (err instanceof RiotError) return { ok: false, message: riotErrorMessage(err) };
      console.error('롤 전적 조회 실패:', err);
      return { ok: false, message: LAST_RESORT_MESSAGE };
    }
  }

  // { name, tag, puuid? } → { ok: true, png, text, puuid, label } | { ok: false, message }
  // 같은 조회가 동시에 들어오면(큐 탭 연타) 한 번만 호출하고 결과를 나눠 쓴다.
  const inflight = new Map();
  function lookup(target, queue = 'all') {
    const done = target.puuid && fresh(results, `${target.puuid}|${queue}`); // 같은 탭을 다시 열면 그림까지 그대로
    if (done) return Promise.resolve(done.value);
    const key = `${target.puuid ?? `${target.name}#${target.tag}`}|${queue}`;
    if (!inflight.has(key)) {
      inflight.set(key, lookupOnce(target, queue).then(res => {
        if (res.ok) remember(results, `${res.puuid}|${queue}`, { value: res }); // 실패는 두지 않는다
        return res;
      }).finally(() => inflight.delete(key)));
    }
    return inflight.get(key);
  }

  // 미리 데우기: 정적 데이터(챔피언·아이템 이름과 아이콘 주소)를 봇이 켜질 때 받아 둔다.
  const warm = () => statics.load();

  // 계정 연결 확인: Riot ID 가 있고, 롤 소환사도 있어야 한다(발로란트만 하는 계정은 롤 연결에서 걸러낸다). 오류는 RiotError 로 던진다.
  async function verify(name, tag) {
    const acc = await riot.accountByRiotId(name, tag);
    await riot.summonerByPuuid(acc.puuid);
    return { puuid: acc.puuid, name: acc.gameName ?? name, tag: acc.tagLine ?? tag };
  }

  return { lookup, verify, warm };
}

module.exports = { createLolService };

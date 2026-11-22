// 롤.js — 롤 전적 조회 한 번의 흐름: 계정 확인 → 랭크·레벨 → 경기 목록 → 새 경기만 받아 저장 → 통계 → 그림.
// 호출 수를 아끼는 것이 핵심이다: 끝난 경기는 저장소에 있으면 다시 받지 않는다(같은 계정 재조회는 경기 호출 0번).
const { RiotError, riotErrorMessage } = require('./리오트');
const { compactMatch, summarize, ratio, queueLabel } = require('./집계');
const { renderLol, tierText } = require('./롤그림');

const QUEUE_ID = { solo: 420, flex: 440 }; // 'all' 은 큐 제한 없음
const STATS_GAMES = 20;
const LIST_GAMES = 5;
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

function createLolService({ riot, store, statics, render = renderLol }) {
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
    const ids = await riot.matchIds(puuid, { count: STATS_GAMES, queue: QUEUE_ID[queue] });
    const missing = ids.filter(id => !store.has(puuid, id));
    await Promise.all(missing.map(async id => {
      const compact = compactMatch(await riot.match(id), puuid);
      store.add(puuid, compact ?? { id, ts: 0, queue: 0, skip: true }); // 다시하기 등은 표시만 해 두고 다시 받지 않는다
    }));
    if (missing.length) store.save();
  }

  // { name, tag, puuid? } → { ok: true, png, text, puuid, label } | { ok: false, message }
  async function lookup({ name, tag, puuid }, queue = 'all') {
    try {
      let shownName = name, shownTag = tag;
      if (!puuid) {
        const acc = await riot.accountByRiotId(name, tag);
        puuid = acc.puuid; shownName = acc.gameName ?? name; shownTag = acc.tagLine ?? tag;
      }
      const [summoner, entries] = await Promise.all([riot.summonerByPuuid(puuid), riot.leagueEntries(puuid), statics.load()]);
      await fetchNewMatches(puuid, queue);
      const recent = store.list(puuid, QUEUE_ID[queue]).slice(0, STATS_GAMES);
      const summary = summarize(recent);
      const rows = recent.slice(0, LIST_GAMES);
      const solo = rankOf(entries, 'RANKED_SOLO_5x5');
      const flex = rankOf(entries, 'RANKED_FLEX_SR');
      const champKeys = [...new Set([...rows.map(m => m.champ), ...summary.champs.map(c => c.champ)])];
      const icons = await collectIcons(summoner.profileIconId, solo, flex, rows, champKeys);
      const view = { name: shownName, tag: shownTag, level: summoner.summonerLevel, queue, solo, flex, summary, matches: rows, icons, names: Object.fromEntries(champKeys.map(c => [c, statics.champName(c)])) };
      const png = render(view);
      return { ok: true, png: png ?? null, text: plainText(view), puuid, label: `${shownName}#${shownTag}` };
    } catch (err) {
      if (err instanceof RiotError) return { ok: false, message: riotErrorMessage(err) };
      console.error('롤 전적 조회 실패:', err);
      return { ok: false, message: LAST_RESORT_MESSAGE };
    }
  }

  return { lookup };
}

module.exports = { createLolService };

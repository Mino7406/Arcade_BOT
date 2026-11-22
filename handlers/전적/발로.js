// 발로.js — 발로란트 전적 조회 한 번의 흐름: HenrikDev 조회 → 티어 아이콘 → 그림. 롤 서비스(롤.js)와 같은 결과 모양을 돌려준다.
const { RiotError, riotErrorMessage } = require('./리오트');
const { fetchValorant } = require('./헨릭');
const { renderValorant, tierKo } = require('./발로그림');

const TIERS_URL = 'https://valorant-api.com/v1/competitivetiers';
const TIERS_TTL_MS = 6 * 3600 * 1000;
const LAST_RESORT_MESSAGE = '전적을 불러오지 못했어요. 잠시 후 다시 해 주세요.';

function plainText(p) {
  const lines = [`**${p.name}** (경쟁전)`, `현재: ${tierKo(p.tier)}${p.rr !== null ? ` ${p.rr} RR` : ''}`, `최고: ${p.peak ? tierKo(p.peak) : '-'}`];
  for (const s of p.seasons.slice(-5).reverse()) lines.push(`${s.season}: ${tierKo(s.endTier)} · ${s.games}판 ${s.wins}승`);
  return lines.join('\n');
}

function createValorantService({ key, statics, fetchFn = fetch, fetchJson = async u => (await fetch(u)).json(), render = renderValorant }) {
  let tierUrls = null, tierUrlsAt = 0;

  // "gold 2" → 그 티어 아이콘 주소(valorant-api.com, 가장 최근 에피소드의 티어 표)
  async function tierTable() {
    if (!tierUrls || Date.now() - tierUrlsAt > TIERS_TTL_MS) {
      const tiers = (await fetchJson(TIERS_URL)).data.at(-1).tiers;
      tierUrls = Object.fromEntries(tiers.filter(t => t.tierName && t.smallIcon).map(t => [t.tierName.trim().toLowerCase(), t.smallIcon]));
      tierUrlsAt = Date.now();
    }
    return tierUrls;
  }

  async function lookup({ name, tag }) {
    try {
      const profile = await fetchValorant({ name, tag, key, fetchFn });
      let table = {};
      try { table = await tierTable(); } catch { /* 아이콘 없이 그린다 */ }
      const wanted = [...new Set([profile.tier, ...profile.seasons.slice(-5).map(s => s.endTier)].map(t => t.trim().toLowerCase()).filter(Boolean))];
      const tierIcons = {};
      await Promise.all(wanted.filter(t => table[t]).map(async t => { tierIcons[t] = await statics.urlIcon('valorant-tier', t, table[t]); }));
      const png = render({ profile, tierIcons });
      return { ok: true, png: png ?? null, text: plainText(profile), label: profile.name || `${name}#${tag}` };
    } catch (err) {
      if (err instanceof RiotError) return { ok: false, message: riotErrorMessage(err) };
      console.error('발로란트 전적 조회 실패:', err);
      return { ok: false, message: LAST_RESORT_MESSAGE };
    }
  }

  return { lookup };
}

module.exports = { createValorantService };

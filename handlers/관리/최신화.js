// 최신화.js — 이미 채널에 올라가 있는 봇 메시지(안내 패널·렐름 패널·명단·코블몬 패널·진행 중 내전/모집)를
// 지금 코드의 디자인으로 다시 그린다. 봇이 켜질 때 자동으로 돌고, /관리 → "게시물 최신화"로 수동으로도 돌릴 수 있다.
//
// 원칙: 새 메시지를 올리거나 지우지 않고 "그 자리에서 고쳐 쓴다"(알림·순서 변화 없음).
// 호스팅 부담을 줄이려고 기억해 둔 메시지만 직접 가져와 고친다 — 채널 전체 훑기는 저장 목록이 비어 있을 때 딱 한 번만.

const fs = require('fs');
const path = require('path');
const { GUILD_ID } = require('../../config');
const { writeJsonIfChanged } = require('../공통/저장');
const { logSystem, logError } = require('../공통/로그');
const { messageText } = require('../공통/카드');

const PANELS_PATH = path.join(__dirname, '..', '..', 'DB', 'panels.json');
// 게임모집 안내 패널의 제목 줄(카드는 `# 제목`, 옛 임베드는 title)
const RECRUIT_TITLE = '게임모집 채널에 오신 걸 환영합니다!';

function load() {
  try {
    if (fs.existsSync(PANELS_PATH)) return JSON.parse(fs.readFileSync(PANELS_PATH, 'utf8')) || {};
  } catch (err) {
    console.error('panels.json 읽기 실패:', err);
    logSystem({ 유형: '저장 오류', 내용: `panels.json 읽기 실패: ${err?.message ?? err}` });
  }
  return {};
}

function save(data) {
  try { writeJsonIfChanged(PANELS_PATH, data); } catch (err) {
    console.error('panels.json 저장 실패:', err);
    logSystem({ 유형: '저장 오류', 내용: `panels.json 저장 실패: ${err?.message ?? err}` });
  }
}

// /패널 → 게임모집 패널을 게시한 직후 호출 — 나중에 최신화할 수 있게 메시지 위치를 기억한다.
function rememberRecruitPanel(message) {
  const data = load();
  const list = (data.recruit ?? []).filter(p => p.messageId !== message.id);
  list.push({ channelId: message.channelId, messageId: message.id });
  data.recruit = list;
  save(data);
}

function isRecruitPanelMessage(m, botId) {
  if (m.author?.id !== botId) return false;
  if (m.embeds?.[0]?.title === RECRUIT_TITLE) return true;
  return messageText(m).split('\n').includes(`# ${RECRUIT_TITLE}`);
}

// 저장 목록이 비어 있을 때(기능 이전에 게시했거나 DB를 옮긴 경우) 봇이 올린 패널을 채널에서 찾아 기억한다.
// 대상 길드의 글 채널 최근 메시지 100개 안에서 찾는다. 한 번 찾으면 저장하므로 다음부터는 훑지 않는다.
async function discoverRecruitPanels(client) {
  const found = [];
  const guild = client.guilds.cache.get(String(GUILD_ID).split(',')[0].trim()) ?? client.guilds.cache.first();
  if (!guild) return found;
  const channels = await guild.channels.fetch().catch(() => null);
  if (!channels) return found;
  for (const channel of channels.values()) {
    if (!channel?.isTextBased?.() || !channel.messages) continue;
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!messages) continue;
    for (const m of messages.values()) {
      if (isRecruitPanelMessage(m, client.user.id)) found.push({ channelId: m.channelId, messageId: m.id });
    }
  }
  return found;
}

async function refreshRecruitPanels(client) {
  const { buildSetupPanelPayload } = require('../../commands/패널');
  const data = load();
  let list = data.recruit ?? [];
  if (!list.length) {
    list = await discoverRecruitPanels(client);
    if (list.length) { data.recruit = list; save(data); }
  }
  const kept = [];
  let done = 0;
  for (const p of list) {
    const channel = await client.channels.fetch(p.channelId).catch(() => null);
    const message = channel && await channel.messages.fetch(p.messageId).catch(() => null);
    if (!message) continue; // 지워진 메시지는 목록에서 뺀다
    kept.push(p);
    // 안내 패널 버튼('놀이터 바로가기' 링크)에 서버 ID가 필요하므로 메시지가 속한 길드를 넘긴다.
    const ok = await message.edit(buildSetupPanelPayload({ client, guild: message.guild })).then(() => true).catch(err => {
      logError('처리 오류', `게임모집 안내 패널 최신화 실패 (${p.channelId}/${p.messageId})`, err);
      return false;
    });
    if (ok) done++;
  }
  if (kept.length !== list.length) { data.recruit = kept; save(data); }
  return done;
}

// 진행 중인 내전/모집 게시글을 최신 디자인으로 다시 그린다(봇을 켤 때는 복원 과정에서 이미 하므로 수동 최신화에서 쓴다).
async function refreshMatches(client) {
  const { buildPublicMessagePayload } = require('../매치/내전');
  const { buildMojipMessagePayload } = require('../매치/모집');
  let done = 0;
  for (const [map, build] of [[client.naejeonMatches, buildPublicMessagePayload], [client.mojipMatches, buildMojipMessagePayload]]) {
    for (const match of map?.values?.() ?? []) {
      if (!match.message) continue;
      const ok = await match.message.edit(build(match)).then(() => true).catch(() => false);
      if (ok) done++;
    }
  }
  return done;
}

/**
 * 올라가 있는 메시지를 한꺼번에 최신화한다.
 * @param {object} [o]
 * @param {boolean} [o.includeCobblemon]  코블몬 패널도 다시 그릴지(봇 시작 때는 코블몬 쪽이 따로 하므로 false)
 * @param {boolean} [o.includeMatches]    진행 중 내전/모집도 다시 그릴지(봇 시작 때는 복원 과정에서 이미 함)
 * @returns {{ summary: string, counts: object }}
 */
async function refreshPostedMessages(client, { includeCobblemon = false, includeMatches = true } = {}) {
  const counts = {};
  const notes = [];

  counts.recruit = await refreshRecruitPanels(client).catch(err => { notes.push(`안내 패널 오류: ${err?.message ?? err}`); return 0; });

  try {
    const { refreshRealmPanelMessage, updateRealmRosterInPlace } = require('../../forms/마크');
    const realmErr = await refreshRealmPanelMessage(client);
    counts.realmPanel = realmErr ? 0 : 1;
    if (realmErr) notes.push(`렐름 패널: ${realmErr}`);
    counts.roster = await updateRealmRosterInPlace(client).catch(err => { notes.push(`렐름 명단 오류: ${err?.message ?? err}`); return 0; });
  } catch (err) {
    notes.push(`렐름 오류: ${err?.message ?? err}`);
  }

  if (includeCobblemon) {
    const { refreshCobblemonPanels } = require('../../forms/코블몬');
    counts.cobblemon = await refreshCobblemonPanels(client).catch(err => { notes.push(`코블몬 패널 오류: ${err?.message ?? err}`); return 0; });
  }
  if (includeMatches) counts.matches = await refreshMatches(client).catch(err => { notes.push(`내전/모집 오류: ${err?.message ?? err}`); return 0; });

  const parts = [
    counts.recruit != null && `안내 패널 ${counts.recruit}개`,
    counts.realmPanel != null && `렐름 패널 ${counts.realmPanel}개`,
    counts.roster != null && `명단 ${counts.roster}개`,
    counts.cobblemon != null && `코블몬 패널 ${counts.cobblemon}개`,
    counts.matches != null && `내전/모집 ${counts.matches}건`,
  ].filter(Boolean);
  const summary = parts.join(' · ') + (notes.length ? ` — ${notes.join(' / ')}` : '');
  return { summary, counts };
}

module.exports = { refreshPostedMessages, rememberRecruitPanel, RECRUIT_TITLE };

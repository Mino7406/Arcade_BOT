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
const { hasHeaderLine, relayoutCardJson, V2_FLAG } = require('../공통/카드');
const { upgradeThumbUrl } = require('../공통/썸네일');

const PANELS_PATH = path.join(__dirname, '..', '..', 'DB', 'panels.json');
// 게임모집 안내 패널의 제목 줄(카드는 `## 제목`, 예전 카드는 `# 제목`, 옛 임베드는 title)
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
  return hasHeaderLine(m, RECRUIT_TITLE);
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
  const { buildSetupPanelPayload } = require('./패널');
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
  const { ensureMatchRole } = require('../매치/공용');
  let done = 0;
  for (const [map, build] of [[client.naejeonMatches, buildPublicMessagePayload], [client.mojipMatches, buildMojipMessagePayload]]) {
    for (const match of map?.values?.() ?? []) {
      if (!match.message) continue;
      ensureMatchRole(match, client.guilds?.cache?.get(match.guildId)); // 멘션 줄이 없던 옛 카드에 역할 줄을 채운다
      const ok = await match.message.edit(build(match)).then(() => true).catch(() => false);
      if (ok) done++;
    }
  }
  return done;
}

// 채널마다 최근 메시지 perChannel 개 안에서 봇이 올린 카드를 지금 배치 규칙으로 고친다(relayoutCardJson).
// 상태가 남아 있는 게시물(진행 중 내전/모집·패널)은 데이터로 다시 그리고, 여기서는 그 밖의 카드
// (지난 결과·팀 배정·취소된 카드 등)를 글자·버튼은 그대로 두고 배치만 맞춘다. 바뀔 게 없으면 수정하지 않는다.
// 채널당 메시지 조회 1번이라 호스팅 부담이 작다.
// 상태 데이터 없이 메시지 글자만으로 지금 디자인을 다시 만들 수 있는 카드. 해당 없으면 null.
async function rebuildFromMessage(m) {
  const { rebuildCorrectCard } = require('../게임/퀴즈');
  return rebuildCorrectCard(m);
}

async function refreshRecentBotCards(client, { perChannel = 10 } = {}) {
  let done = 0, scanned = 0;
  // 썸네일용 앱 이모지가 아직 준비 안 됐으면(봇 시작 때 실패 등) 여기서 한 번 더 시도한다.
  const { ensureThumbEmojis, thumbStatus } = require('../공통/썸네일');
  if (thumbStatus().ready < thumbStatus().total) await ensureThumbEmojis(client).catch(() => {});
  for (const guild of client.guilds?.cache?.values?.() ?? []) {
    const channels = await guild.channels.fetch().catch(() => null);
    if (!channels) continue;
    for (const channel of channels.values()) {
      if (!channel?.isTextBased?.() || !channel.messages) continue;
      const messages = await channel.messages.fetch({ limit: perChannel }).catch(() => null);
      if (!messages) continue; // 볼 권한이 없는 채널 등
      for (const m of messages.values()) {
        if (m.author?.id !== client.user.id) continue;
        const isV2 = typeof m.flags?.has === 'function' ? m.flags.has(V2_FLAG) : !!(Number(m.flags) & V2_FLAG);
        if (!isV2) continue; // 옛 임베드 메시지는 배치를 알 수 없어 그대로 둔다
        scanned++;
        // 글자에서 다시 만들 수 있는 카드(옛 퀴즈 정답 카드 등)는 지금 코드로 새로 그린다.
        const rebuilt = await rebuildFromMessage(m).catch(() => null);
        if (rebuilt) {
          const ok = await m.edit(rebuilt).then(() => true).catch(err => { logError('처리 오류', `최근 카드 다시 그리기 실패 (${m.channelId}/${m.id})`, err); return false; });
          if (ok) done++;
          continue;
        }
        const next = relayoutCardJson(m.components, { mapThumbUrl: upgradeThumbUrl }); // 배치 + 여백 넣은 게임 썸네일
        if (!next) continue;
        // 첨부(그림)는 그대로 두고(attachments 생략) 배치만 고친다. 수정은 알림이 가지 않지만 멘션 해석도 막아 둔다.
        const ok = await m.edit({ components: next, flags: V2_FLAG, allowedMentions: { parse: [] } }).then(() => true).catch(err => {
          logError('처리 오류', `최근 카드 최신화 실패 (${m.channelId}/${m.id})`, err);
          return false;
        });
        if (ok) done++;
      }
    }
  }
  return { done, scanned };
}

/**
 * 올라가 있는 메시지를 한꺼번에 최신화한다.
 * @param {object} [o]
 * @param {boolean} [o.includeCobblemon]  코블몬 패널도 다시 그릴지(봇 시작 때는 코블몬 쪽이 따로 하므로 false)
 * @param {boolean} [o.includeMatches]    진행 중 내전/모집도 다시 그릴지(봇 시작 때는 복원 과정에서 이미 함)
 * @param {boolean} [o.includeRecent]     채널마다 최근 10개 봇 카드의 배치도 맞출지(/관리 새로고침)
 * @returns {{ summary: string, counts: object }}
 */
async function refreshPostedMessages(client, { includeCobblemon = false, includeMatches = true, includeRecent = false } = {}) {
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
  // 데이터로 다시 그린 뒤에 훑어야 같은 메시지를 두 번 고치지 않는다(이미 새 배치면 건너뜀).
  if (includeRecent) {
    const r = await refreshRecentBotCards(client).catch(err => { notes.push(`최근 카드 오류: ${err?.message ?? err}`); return { done: 0, scanned: 0 }; });
    counts.recent = r.done;
    counts.recentScanned = r.scanned;
    const t = require('../공통/썸네일').thumbStatus();
    counts.thumbs = `${t.ready}/${t.total}`;
    if (t.error) notes.push(`썸네일 이모지: ${t.error}`);
  }

  const parts = [
    counts.recruit != null && `안내 패널 ${counts.recruit}개`,
    counts.realmPanel != null && `렐름 패널 ${counts.realmPanel}개`,
    counts.roster != null && `명단 ${counts.roster}개`,
    counts.cobblemon != null && `코블몬 패널 ${counts.cobblemon}개`,
    counts.matches != null && `내전/모집 ${counts.matches}건`,
    counts.recent != null && `최근 카드 ${counts.recentScanned}개 중 ${counts.recent}개 수정`,
    counts.thumbs != null && `작은 썸네일 ${counts.thumbs} 준비`,
  ].filter(Boolean);
  const summary = parts.join(' · ') + (notes.length ? ` — ${notes.join(' / ')}` : '');
  return { summary, counts };
}

module.exports = { refreshPostedMessages, refreshRecentBotCards, rememberRecruitPanel, isRecruitPanelMessage, RECRUIT_TITLE };

// 팀.js — 내전 "팀 짜기" 카드(팀표).
//
// 사람들은 내전이 마감되면 내전채팅으로 넘어가 메모장에 팀을 짜서 붙여넣는다(윤진-승훈-시형-연우-강현 / ...).
// 승패나 판 번호는 귀찮아서 안 쓰니, 카드는 "지금 팀" 하나와 작게 보이는 "이전 팀표"만 둔다.
//  - 📝 팀 입력: 칸 하나짜리 입력창. 지금 팀(처음엔 마감 때 자동으로 나눈 팀)이 채워져 있어 바꿀 사람만 고치면 된다.
//  - ⚖️ 밸런스: 저장된 티어로 두 팀 점수 차가 가장 작게 나눈다(롤·발로만).
//  - 🎲 랜덤: 무작위로 두 팀.
//  - 🏅 내 티어 설정: 내 티어를 골라 저장한다(롤·발로만). 팀 입력에 "승훈 불2"처럼 적어도 자동으로 저장된다.
// 팀이 바뀔 때마다 카드는 지우고 맨 아래에 다시 올린다(채팅에 묻히지 않게). 티어만 바뀌면 그 자리에서 고친다.
//
// 카드는 내전이 마감되면 자동으로 올라가고(공용.js markClosed → setCloseHook), 주최자 관리 메뉴의 📌 팀 불러오기로 끌어올릴 수 있다.
// 기록: match.board = { channelId, messageId, current: { teams, at, by, how } | null, history: [같은 모양 …] }
// 팀원은 사람이 적은 이름 글자 그대로 두고, 그릴 때 참가자 이름과 맞춰 보며 티어를 붙인다.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const {
  ADMIN_IDS,
  getNaejeonMatches: getMatches,
  gameThumb,
  setCloseHook,
  saveNow,
} = require('./공용');
const { card, notice, payload, emojiUrl } = require('../공통/카드');
const { logError } = require('../공통/로그');
const { NAEJEON_CHAT_CHANNEL_IDS = {}, GAME_EMOJIS = {} } = require('../../config');
const tiers = require('./티어');

const MAX_TEAMS = 10;
const MAX_MEMBERS = 15;
const HISTORY_KEPT = 10;
const HISTORY_SHOWN = 3;
const TEAM_ICONS = ['🔵', '🔴', '🟢', '🟡', '🟣', '🟠', '⚪', '🟤', '⚫', '🩷'];
const OLD_UI_NOTE = '⚠️ **팀 짜기 방식이 바뀌었어요.** 내전이 마감되면 내전채팅에 팀 짜기 카드가 자동으로 올라가요.';
const HOW_TEXT = { input: '📝 입력', balance: '⚖️ 밸런스', random: '🎲 랜덤' };

// ── 이름 ────────────────────────────────────────────────────

// 이름을 입력창에 넣을 때 구분 기호(띄어쓰기·- 등)와 겹치지 않게 지운다: "코리안갱씥 이경민" → "코리안갱씥이경민"
function nameToken(name) {
  return String(name).replace(/[\s,，\-·|/]+/g, '') || '?';
}

// 적힌 이름 → 참가자. 정확히 같거나, 아니면 그 글자를 포함하는 참가자가 딱 한 명일 때(강현 → 강현숭이).
function resolveMember(name, participants) {
  const key = nameToken(name).replace(/\(.*\)$/, '');
  const exact = participants.filter(u => nameToken(u.displayName) === key);
  if (exact.length === 1) return exact[0];
  if (key.length < 2) return null;
  const partial = participants.filter(u => nameToken(u.displayName).includes(key));
  return partial.length === 1 ? partial[0] : null;
}

// ── 붙여넣은 글 읽기 ─────────────────────────────────────────

// 롤·발로가 아닌 게임에서 티어처럼 생긴 글자(불2·다3 …)는 이름이 아니라 바로 앞 사람에게 글자로 붙인다: "승훈(불2)"
const GENERIC_TIER_RE = /^(아|브|실|골|플|에|다|초|불|레|마|그|챌)[1-5]$/;
// 줄 맨 앞의 팀 이름: [공수] / 1팀 / 팀1 / 1팀: / A팀 - 같은 것
const BRACKET_NAME_RE = /^\[([^\]]{1,20})\]\s*/;
const NUMBERED_NAME_RE = /^(\d{1,2}\s*팀|팀\s*\d{1,2}|[A-Za-z]\s*팀)\s*[:：\-]?\s*/;
const COLON_NAME_RE = /^([^\s:：]{1,10})\s*[:：]\s*/;
// "1." "2)" 처럼 번호만 있는 줄(로비 구분)은 건너뛴다
const LOBBY_LINE_RE = /^\d{1,2}\s*[.)]?$/;

function parseTeamLine(line, game, hints) {
  let rest = line;
  let name = null;
  let m;
  if ((m = BRACKET_NAME_RE.exec(rest))) { name = m[1].trim(); rest = rest.slice(m[0].length); }
  else if ((m = NUMBERED_NAME_RE.exec(rest))) { rest = rest.slice(m[0].length); }
  else if ((m = COLON_NAME_RE.exec(rest))) { name = m[1].trim(); rest = rest.slice(m[0].length); }

  const members = [];
  for (const token of rest.split(/[\s,，\-·|]+/).filter(Boolean)) {
    const tier = tiers.parseTierToken(game, token);
    if (tier && members.length > 0) { hints.push({ name: members[members.length - 1], tier }); continue; }
    if (!tiers.hasTiers(game) && GENERIC_TIER_RE.test(token) && members.length > 0) { members[members.length - 1] += `(${token})`; continue; }
    // "승훈(불2)"처럼 이름에 붙여 쓴 티어
    const glued = /^(.+?)\(([^()]+)\)$/.exec(token);
    const gluedTier = glued && tiers.parseTierToken(game, glued[2]);
    if (gluedTier) { members.push(glued[1]); hints.push({ name: glued[1], tier: gluedTier }); continue; }
    members.push(token);
  }
  return { name, members };
}

// 성공: { teams: [{ name, members }], hints: [{ name, tier }] } / 실패: { error: '안내 문구' }
function parseTeamsText(raw, { game } = {}) {
  const segments = String(raw || '')
    .split(/\r?\n/)
    .flatMap(line => line.split(/\s*\/\s*|\s+vs\s+/i))
    .map(s => s.trim())
    .filter(s => s && !LOBBY_LINE_RE.test(s));

  const hints = [];
  let teams = segments.map(s => parseTeamLine(s, game, hints)).filter(t => t.members.length > 0);

  // 줄을 안 나누고 한 줄에 전원을 적었으면 앞에서부터 반씩 두 팀으로 나눈다(홀수면 앞 팀이 한 명 더).
  if (teams.length === 1 && teams[0].members.length >= 2) {
    const all = teams[0].members;
    const half = Math.ceil(all.length / 2);
    teams = [{ name: null, members: all.slice(0, half) }, { name: null, members: all.slice(half) }];
  }

  if (teams.length < 2) return { error: '팀을 나누려면 이름이 **두 명 이상** 있어야 해요.\n예)\n```\n윤진-승훈-시형-연우-강현\n현호-찬영-찬우-승민-채원\n```' };
  if (teams.length > MAX_TEAMS) return { error: `팀은 최대 ${MAX_TEAMS}개까지 적을 수 있어요.` };
  const big = teams.find(t => t.members.length > MAX_MEMBERS);
  if (big) return { error: `한 팀은 최대 ${MAX_MEMBERS}명까지예요. (\`${big.members.slice(0, 3).join(' ')} …\` 줄 확인)` };

  const seen = new Set();
  const dups = new Set();
  for (const t of teams) for (const n of t.members) {
    const key = n.replace(/\(.*?\)$/, '');
    if (seen.has(key)) dups.add(key);
    seen.add(key);
  }
  if (dups.size > 0) return { error: `두 번 적힌 이름이 있어요: **${[...dups].join(', ')}**` };

  return { teams, hints };
}

// 입력창에 채워 줄 글(한 줄에 한 팀).
function teamsToText(teams) {
  return teams.map(t => `${t.name ? `[${t.name}] ` : ''}${t.members.join('-')}`).join('\n');
}

// ── 팀 나누기 ───────────────────────────────────────────────

function splitHalf(names) {
  const half = Math.ceil(names.length / 2);
  return [{ name: null, members: names.slice(0, half) }, { name: null, members: names.slice(half) }];
}

// 첫 초안: 마감된 참가자를 참가 순서대로 앞에서부터 반씩.
function draftTeams(participants) {
  return splitHalf(participants.map(u => nameToken(u.displayName)));
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomTeams(participants) {
  return splitHalf(shuffle(participants).map(u => nameToken(u.displayName)));
}

// 참가자마다 점수. 티어를 모르는 사람은 아는 사람들의 중간값(아무도 모르면 0)으로 친다.
function participantScores(participants, game) {
  const known = participants.map(u => tiers.tierScore(game, tiers.getTier(u.id, game)));
  const sorted = known.filter(s => s !== null).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  return known.map(s => (s === null ? median : s));
}

// 두 팀 점수 합 차이가 가장 작은 조합(같은 차이가 여럿이면 그중 무작위). 20명까지는 전부 비교한다.
function balanceTeams(participants, game) {
  const n = participants.length;
  const order = shuffle(participants.map((u, i) => i)); // 같은 차이 중 고를 때 매번 다르게
  const users = order.map(i => participants[i]);
  const scores = participantScores(users, game);
  const total = scores.reduce((a, b) => a + b, 0);
  const size = Math.ceil(n / 2);

  let best = [];
  let bestDiff = Infinity;
  if (n <= 20) {
    const pick = [];
    const walk = (start, sum) => {
      if (pick.length === size) {
        const diff = Math.abs(total - 2 * sum);
        if (diff < bestDiff) { bestDiff = diff; best = [[...pick]]; }
        else if (diff === bestDiff && best.length < 50) best.push([...pick]);
        return;
      }
      for (let i = start; i <= n - (size - pick.length); i++) {
        if (pick.length === 0 && i > 0 && n % 2 === 0) break; // 짝수면 첫 사람을 늘 팀 1에 둬서 거울 조합을 건너뛴다
        pick.push(i);
        walk(i + 1, sum + scores[i]);
        pick.pop();
      }
    };
    walk(0, 0);
  } else {
    // 많으면 점수 높은 순으로 합이 작은 팀에 넣는다
    const a = []; const b = []; let sa = 0; let sb = 0;
    for (const i of users.map((u, i) => i).sort((x, y) => scores[y] - scores[x])) {
      if ((sa <= sb && a.length < size) || b.length >= n - size) { a.push(i); sa += scores[i]; } else { b.push(i); sb += scores[i]; }
    }
    best = [a];
  }
  const chosen = new Set(best[Math.floor(Math.random() * best.length)]);
  const t1 = users.filter((u, i) => chosen.has(i));
  const t2 = users.filter((u, i) => !chosen.has(i));
  return [{ name: null, members: t1.map(u => nameToken(u.displayName)) }, { name: null, members: t2.map(u => nameToken(u.displayName)) }];
}

// ── 카드 ────────────────────────────────────────────────────

function normalizeBoard(match) {
  if (!match.board) match.board = { channelId: null, messageId: null, current: null, history: [] };
  const b = match.board;
  if (Array.isArray(b.rounds)) { // 판 번호를 쓰던 첫 버전에서 옮겨 오기
    b.current = b.rounds.at(-1) ?? null;
    b.history = b.rounds.slice(0, -1).reverse();
    delete b.rounds;
  }
  if (!Array.isArray(b.history)) b.history = [];
  if (b.current === undefined) b.current = null;
  // 아직 아무도 팀을 안 정했으면 초안을 만들어 둔다(한 번 만들면 그대로, 참가자가 바뀌었으면 다시).
  if (!b.current || (b.current.draft && !sameMembers(b.current.teams, match.participants))) b.current = makeDraft(match);
  return b;
}

function sameMembers(teams, participants) {
  const a = teams.flatMap(t => t.members).sort().join('|');
  const b = participants.map(u => nameToken(u.displayName)).sort().join('|');
  return a === b;
}

// 초안: 티어가 절반 이상 저장돼 있으면 ⚖️ 밸런스, 아니면(또는 티어 없는 게임이면) 🎲 랜덤.
function makeDraft(match) {
  const game = match.data.game;
  const ps = match.participants;
  const known = tiers.hasTiers(game) ? ps.filter(u => tiers.getTier(u.id, game)).length : 0;
  const canBalance = tiers.hasTiers(game) && ps.length >= 2 && known >= Math.ceil(ps.length / 2);
  const teams = ps.length < 2 ? draftTeams(ps) : canBalance ? balanceTeams(ps, game) : randomTeams(ps);
  return { teams, how: canBalance ? 'balance' : 'random', at: Date.now(), draft: true };
}

// 팀 하나 = 카드 한 칸. 큰 팀 제목 → 평균 티어 → 한 명씩 한 줄(티어 이모지 + 굵은 이름 + 티어 칩).
// 팀이 많으면(5팀 이상) 카드 부품 수 제한에 걸리지 않게 한 칸에 몰아 짧게 쓴다.
function teamBlocks(teams, match) {
  const game = match.data.game;
  const withTiers = tiers.hasTiers(game);
  const compact = teams.length > 4;
  const tick = '`';
  const texts = teams.map((t, i) => {
    const resolved = t.members.map(n => resolveMember(n, match.participants));
    const memberTiers = resolved.map(u => (withTiers && u ? tiers.getTier(u.id, game) : null));
    const scores = memberTiers.map(tr => tiers.tierScore(game, tr)).filter(x => x !== null && x !== undefined);
    const avgTier = scores.length ? tiers.tierFromScore(game, scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    const avgEmoji = avgTier && tiers.tierEmojiId(game, avgTier);
    const avg = avgTier ? `${avgEmoji ? `<:t:${avgEmoji}> ` : ''}${tiers.tierLabel(game, avgTier)}` : ''; // [평균 <이모지> 다이아몬드4]
    const title = `${TEAM_ICONS[i] ?? '▫️'} ${t.name ?? `${i + 1} 팀`}`;
    if (compact) {
      const names = t.members.map((n, k) => `${memberTiers[k] ? `${tiers.tierBadge(game, memberTiers[k])} ` : ''}${n}`);
      return `**${title}**${avg ? ` · 평균 ${avg}` : ''}\n${names.join(' · ')}`;
    }
    const lines = t.members.map((n, k) => {
      const tr = memberTiers[k];
      if (!withTiers) return `▸ **${n}**`;
      if (!tr) return `❓ **${n}**`;
      const id = tiers.tierEmojiId(game, tr);
      return `${id ? `<:t:${id}>` : '▸'} **${n}**　${tick}${tiers.tierLabel(game, tr)}${tick}`;
    });
    return `### ${title}${avg ? `\n**[평균 ${avg}]**` : ''}\n${lines.join('\n')}`;
  });
  return compact ? [texts.join('\n\n')] : texts;
}

function buildBoardRows(match, matchMsgId) {
  const game = match.data.game;
  const buttons = [new ButtonBuilder().setCustomId(`team:input:${matchMsgId}`).setLabel('📝 팀 입력').setStyle(ButtonStyle.Primary)];
  if (tiers.hasTiers(game)) buttons.push(new ButtonBuilder().setCustomId(`team:balance:${matchMsgId}`).setLabel('⚖️ 밸런스').setStyle(ButtonStyle.Secondary));
  buttons.push(new ButtonBuilder().setCustomId(`team:random:${matchMsgId}`).setLabel('🎲 랜덤').setStyle(ButtonStyle.Secondary));
  if (tiers.hasTiers(game)) buttons.push(new ButtonBuilder().setCustomId(`team:tier:${game}:${matchMsgId}`).setLabel('🏅 내 티어 설정').setStyle(ButtonStyle.Success));
  return [new ActionRowBuilder().addComponents(...buttons)];
}

function buildBoardPayload(match, matchMsgId) {
  const { gameInfo, title, game } = match.data;
  const board = normalizeBoard(match);
  const cur = board.current;
  const blocks = [];

  // 마감 때 자동으로 나눈 팀(draft)도 따로 이름 붙이지 않고 그대로 팀 현황으로 보여 준다.
  // 티어가 부족해 랜덤으로 나눈 경우만 이유를 한 줄 덧붙인다.
  const when = cur.at ? ` · <t:${Math.floor(cur.at / 1000)}:t>` : '';
  const fallback = cur.draft && cur.how === 'random' && tiers.hasTiers(game) ? '\n-# 티어가 저장된 사람이 적어서 무작위로 나눴어요. 🏅 내 티어 설정 후 ⚖️ 밸런스를 눌러 보세요.' : '';
  blocks.push(`## 🔍 팀 현황\n-# ${cur.no ? `#${cur.no} · ` : ''}${HOW_TEXT[cur.how] ?? HOW_TEXT.input}${when}${fallback}`);
  blocks.push(...teamBlocks(cur.teams, match));

  if (tiers.hasTiers(game)) {
    const unknown = match.participants.filter(u => !tiers.getTier(u.id, game)).map(u => u.displayName);
    if (unknown.length) blocks.push({ text: `-# 티어 미지정 : ${unknown.join(', ')} (티어를 저장하면 밸런스가 정확해져요)`, noDivider: true });
  }

  // 내전 내역: 순번(#3)·직전 표시·시각(몇 분 전)·방식 한 줄 + 팀별 인용 줄. 내역마다 칸을 띄워 구분한다.
  const shown = board.history.slice(0, HISTORY_SHOWN);
  if (shown.length) {
    blocks.push(`### 📜 내전 내역\n-# 위가 가장 최근이에요`);
    shown.forEach((h, k) => {
      const no = h.no ? `#${h.no}` : '이전';
      const tag = k === 0 ? ' · 직전 팀' : '';
      const sec = h.at ? Math.floor(h.at / 1000) : null;
      const when = sec ? ` · <t:${sec}:t> (<t:${sec}:R>)` : '';
      const how = HOW_TEXT[h.how] ? ` · ${HOW_TEXT[h.how]}` : '';
      const teams = h.teams.map((t, i) => `> ${TEAM_ICONS[i] ?? '▫️'} ${t.members.join(' · ')}`).join('\n');
      blocks.push({ text: `**${no}${tag}**${when}${how}\n${teams}`, noDivider: true });
    });
  }

  return payload(card({
    color: gameInfo.color,
    header: title,
    sub: [gameInfo.name, '⚔️ 팀 설정'],
    thumb: gameThumb(gameInfo),
    thumbAlt: gameInfo.name,
    blocks,
    footer: '📝 팀 입력에 지금 팀이 채워져 있어요 · 바꿀 사람만 고치면 돼요',
    rows: buildBoardRows(match, matchMsgId),
  }));
}

// ── 카드 올리기 ─────────────────────────────────────────────

async function fetchChannel(client, id) {
  return client.channels.cache.get(id) || await client.channels.fetch(id).catch(() => null);
}

async function resolveBoardChannel(client, match) {
  const configured = NAEJEON_CHAT_CHANNEL_IDS[match.guildId];
  if (configured) {
    const ch = await fetchChannel(client, configured);
    if (ch?.isTextBased?.()) return ch;
  }
  const guild = client.guilds?.cache?.get(match.guildId);
  const byName = guild?.channels?.cache?.find?.(c => c.isTextBased?.() && c.name?.includes('내전채팅'));
  if (byName) return byName;
  return match.message?.channel ?? null;
}

// 카드를 (지우고) 맨 아래에 새로 올린다. 올린 메시지를 돌려준다.
async function postBoard(client, matchMsgId, match) {
  const board = normalizeBoard(match);
  if (board.channelId && board.messageId) {
    const oldCh = await fetchChannel(client, board.channelId);
    const old = oldCh && await oldCh.messages.fetch(board.messageId).catch(() => null);
    if (old) await old.delete().catch(() => {});
  }
  const channel = await resolveBoardChannel(client, match);
  if (!channel) throw new Error('팀 짜기 카드를 올릴 채널을 찾지 못함');
  const msg = await channel.send(buildBoardPayload(match, matchMsgId));
  board.channelId = msg.channelId;
  board.messageId = msg.id;
  saveNow(client);
  return msg;
}

// 티어만 바뀌었을 때: 자리는 그대로 두고 카드 내용만 고친다.
async function refreshBoard(client, matchMsgId, match) {
  const board = match?.board;
  if (!board?.channelId || !board.messageId) return;
  const ch = await fetchChannel(client, board.channelId);
  const msg = ch && await ch.messages.fetch(board.messageId).catch(() => null);
  if (msg) await msg.edit(buildBoardPayload(match, matchMsgId)).catch(() => {});
}

// 마감되면 자동으로 한 번 올린다. 마감 해제 후 다시 마감돼도 이미 있으면 그대로 둔다.
setCloseHook('내전', async (matchMsgId, match) => {
  if (match.board?.messageId) return;
  const client = match.message?.client;
  if (!client) return;
  await postBoard(client, matchMsgId, match);
});

// ── 권한 ────────────────────────────────────────────────────

function canEdit(match, userId) {
  return match.data.organizer.id === userId || ADMIN_IDS.includes(userId); // 팀 입력·밸런스·랜덤·불러오기는 주최자·관리자만
}

async function getEditableMatch(interaction, matchMsgId) {
  const match = getMatches(interaction.client).get(matchMsgId);
  if (!match) {
    await interaction.reply(notice('⚠️ **끝났거나 취소된 내전이에요.**', { ephemeral: true }));
    return null;
  }
  if (!canEdit(match, interaction.user.id)) {
    await interaction.reply(notice('❌ **팀은 이 내전의 주최자·관리자만 바꿀 수 있어요.**', { ephemeral: true }));
    return null;
  }
  return match;
}

function linkRow(url) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel('바로가기').setEmoji('🔗'),
  );
}

// ── 팀 바꾸기 ───────────────────────────────────────────────

async function commitTeams(interaction, matchMsgId, match, teams, how, extraNote = '') {
  const board = normalizeBoard(match);
  if (board.current && !board.current.draft) board.history = [board.current, ...board.history].slice(0, HISTORY_KEPT); // 초안은 내역에 안 남김
  board.count = (board.count || 0) + 1; // 내역 순번(#1, #2 …)
  board.current = { teams, at: Date.now(), by: interaction.user.id, how, no: board.count };
  try {
    await postBoard(interaction.client, matchMsgId, match);
  } catch (err) {
    logError('처리 오류', `팀 짜기 카드 다시 올리기 실패 (${matchMsgId})`, err);
    await interaction.editReply(notice('⚠️ **팀은 저장했지만 카드를 다시 올리지 못했어요.** 주최자 관리 메뉴의 📌 팀 불러오기를 눌러 주세요.'));
    return;
  }
  const head = { input: '✅ **팀을 올렸어요.**', balance: '⚖️ **티어로 밸런스를 맞춰 나눴어요.**', random: '🎲 **무작위로 나눴어요.**' }[how];
  await interaction.editReply(notice(`${head}${extraNote}`));
}

// 팀 입력에 적힌 티어를 참가자에게 저장한다. 저장한 것/못 찾은 것을 안내 문구로 돌려준다.
function learnTiers(match, hints) {
  const game = match.data.game;
  if (!tiers.hasTiers(game) || hints.length === 0) return '';
  const saved = [];
  const missed = [];
  for (const { name, tier } of hints) {
    const user = resolveMember(name, match.participants);
    if (!user) { missed.push(name); continue; }
    tiers.setTier(user.id, game, tier);
    saved.push(`${user.displayName} ${tiers.tierLabel(game, tier)}`);
  }
  let note = '';
  if (saved.length) note += `\n🏅 티어 저장: ${saved.join(', ')}`;
  if (missed.length) note += `\n-# 참가자 중에 못 찾아서 티어를 저장 안 한 이름: ${missed.join(', ')}`;
  return note;
}

function buildInputModal(match, matchMsgId) {
  const cur = normalizeBoard(match).current;
  const prefill = teamsToText(cur.teams);
  const input = new TextInputBuilder()
    .setCustomId('teams')
    .setLabel(tiers.hasTiers(match.data.game) ? '한 줄에 한 팀 · (ex.승훈 불2)처럼 쓰면 티어도 저장' : '한 줄에 한 팀 (- 나 띄어쓰기로 구분)')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('윤진-승훈-시형-연우-강현\n현호-찬영-찬우-승민-채원')
    .setRequired(true)
    .setMaxLength(1000);
  if (prefill) input.setValue(prefill.slice(0, 1000));
  return new ModalBuilder()
    .setCustomId(`team:modal:${matchMsgId}`)
    .setTitle('팀 입력')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

// ── 🏅 내 티어 설정 ──────────────────────────────────────────────
// 나만 보이는 카드들: (패널에서) 게임 고르기 → 티어 고르기 → 단계 고르기 / 점수 적기 → 저장 완료.
// 단계마다 ↩️ 뒤로 버튼이 있다(이름은 모두 '↩️ 뒤로'). matchMsgId 가 'panel' 이면 게임모집 패널에서 연 것이라 게임 고르기로 돌아갈 수 있다.

const GAME_COLORS = { lol: 0xC89B3C, valorant: 0xFF4655, overwatch: 0xF99E1A, pubg: 0xC8A96E };

function tierOptionEmoji(game, tier) {
  const id = tiers.tierEmojiId(game, tier);
  return id ? { id } : undefined;
}

function gameIconUrl(game) {
  return GAME_EMOJIS[game] ? gameThumb({ emoji: `<:g:${GAME_EMOJIS[game]}>` }) : undefined;
}

function tierIconUrl(game, tier) {
  const id = tier && tiers.tierEmojiId(game, tier);
  return id ? emojiUrl(id) : gameIconUrl(game);
}

// 저장된 티어 한 줄: "<이모지> **에메랄드4**" / 없으면 "아직 저장 안 함"
function tierLine(game, tier) {
  if (!tier) return '*아직 저장 안 함*'; // 줄 중간에도 들어가서 -# (줄 맨 앞에서만 작동) 대신 기울임
  const id = tiers.tierEmojiId(game, tier);
  return `${id ? `<:t:${id}> ` : ''}**${tiers.tierLabel(game, tier)}**`;
}

function backButton(id, label) {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Secondary);
}

function tierCard(game, { header, thumbTier = null, blocks, rows, footer }) {
  return card({
    color: GAME_COLORS[game] ?? 0x5865F2,
    header,
    sub: [tiers.LADDERS[game]?.name ?? '', '🏅 내 티어 설정'],
    thumb: tierIconUrl(game, thumbTier),
    blocks,
    footer,
    rows,
  });
}

// 게임모집 패널의 🏅 내 티어 설정: 저장된 티어가 있으면 바로 보여 주고, 아래에서 게임을 고른다.
function buildTierGamePayload(userId) {
  const games = Object.keys(tiers.LADDERS);
  const saved = games.filter(g => userId && tiers.getTier(userId, g));
  const blocks = [];
  if (saved.length) {
    blocks.push(`### 📋 내 티어\n${games.map(g => `**${tiers.LADDERS[g].name}**　${tierLine(g, tiers.getTier(userId, g))}`).join('\n')}`);
  } else {
    blocks.push('아직 저장한 티어가 없어요.\n티어를 저장해 두면 내전 팀 짜기에서 **⚖️ 밸런스**로 팀을 고르게 나눠 줘요.');
  }
  blocks.push('**어느 게임 티어를 설정할까요?**');
  const buttons = games.map(g => {
    const b = new ButtonBuilder().setCustomId(`team:tier:${g}:panel`).setLabel(tiers.LADDERS[g].name).setStyle(saved.includes(g) ? ButtonStyle.Success : ButtonStyle.Secondary);
    return GAME_EMOJIS[g] ? b.setEmoji({ id: GAME_EMOJIS[g] }) : b;
  });
  return payload(card({
    color: 0x5865F2,
    header: '🏅 내 티어 설정',
    sub: '롤 · 발로란트 · 오버워치 · 배틀그라운드',
    blocks,
    footer: saved.length ? '초록 버튼은 이미 저장된 게임이에요 · 한 번 저장하면 다음 내전에도 그대로 써요' : '한 번 저장하면 다음 내전에도 그대로 써요',
    rows: [new ActionRowBuilder().addComponents(...buttons)],
  }), { ephemeral: true });
}

function buildTierPickPayload(game, matchMsgId, userId) {
  const ladder = tiers.LADDERS[game];
  const mine = tiers.getTier(userId, game);
  const options = [...ladder.tiers].reverse().map(t => {
    const o = { label: t.name, value: t.key };
    const desc = t.scored ? `점수(${ladder.scoreUnit})로 순위` : t.divs ? `${t.divs}단계` : null;
    if (desc) o.description = desc;
    const emoji = tierOptionEmoji(game, { tier: t.key, div: t.divs ? (ladder.divOrder === 'desc' ? 1 : t.divs) : undefined });
    if (emoji) o.emoji = emoji;
    return o;
  });
  if (mine) options.push({ label: '저장한 티어 지우기', value: 'none', emoji: '🗑️' });
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`team:tier_pick:${game}:${matchMsgId}`)
    .setPlaceholder('티어를 고르세요')
    .addOptions(options);
  const rows = [new ActionRowBuilder().addComponents(menu)];
  if (matchMsgId === 'panel') rows.push(new ActionRowBuilder().addComponents(backButton('team:tier_games:panel', '↩️ 뒤로')));
  return payload(tierCard(game, {
    header: '🏅 내 티어 설정',
    thumbTier: mine,
    blocks: [`**지금 저장된 티어**\n${tierLine(game, mine)}`],
    rows,
    footer: '한 번 저장하면 다음 내전에도 그대로 써요',
  }), { ephemeral: true });
}

function buildTierDivPayload(game, tierKey, matchMsgId) {
  const ladder = tiers.LADDERS[game];
  const t = tiers.findTier(game, tierKey);
  const divs = Array.from({ length: t.divs }, (_, i) => (ladder.divOrder === 'desc' ? i + 1 : t.divs - i)); // 높은 단계부터
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`team:tier_div:${game}:${tierKey}:${matchMsgId}`)
    .setPlaceholder(`${t.name} 몇 단계인가요?`)
    .addOptions(divs.map(d => {
      const emoji = tierOptionEmoji(game, { tier: tierKey, div: d });
      return { label: `${t.name} ${d}`, value: String(d), ...(emoji ? { emoji } : {}) };
    }));
  return payload(tierCard(game, {
    header: `${t.name} 몇 단계인가요?`,
    thumbTier: { tier: tierKey, div: divs[0] },
    blocks: [`-# ${ladder.divOrder === 'desc' ? '숫자가 작을수록 높아요' : '숫자가 클수록 높아요'} (${t.name} ${divs[0]}이 가장 높음)`],
    rows: [
      new ActionRowBuilder().addComponents(menu),
      new ActionRowBuilder().addComponents(backButton(`team:tier_back:${game}:${matchMsgId}`, '↩️ 뒤로')),
    ],
  }));
}

// 점수제 티어(마스터 이상·레디언트 등): 점수를 적을지 묻는다. 안 적어도 저장된다.
function buildTierScoreAskPayload(game, key, matchMsgId) {
  const t = tiers.findTier(game, key);
  const unit = tiers.LADDERS[game].scoreUnit || '점';
  return payload(tierCard(game, {
    header: t.name,
    thumbTier: { tier: key },
    blocks: [`**${t.name}**은 단계 없이 점수(${unit})로 순위가 갈려요.\n점수를 적어 두면 ⚖️ 밸런스가 더 정확해져요. 안 적어도 괜찮아요.`],
    rows: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`team:tier_score:${game}:${key}:${matchMsgId}`).setLabel(`✏️ ${unit} 적기`).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`team:tier_save:${game}:${key}:${matchMsgId}`).setLabel('점수 없이 저장').setStyle(ButtonStyle.Primary),
      backButton(`team:tier_back:${game}:${matchMsgId}`, '↩️ 뒤로'),
    )],
  }));
}

function buildTierScoreModal(game, key, matchMsgId) {
  const t = tiers.findTier(game, key);
  const unit = tiers.LADDERS[game].scoreUnit || '점';
  return new ModalBuilder()
    .setCustomId(`team:tier_modal:${game}:${key}:${matchMsgId}`)
    .setTitle(`${t.name} 점수`)
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('score').setLabel(`${unit} (숫자만)`).setStyle(TextInputStyle.Short).setPlaceholder('예: 350').setRequired(true).setMaxLength(5),
    ));
}

function buildTierSavedPayload(game, tier, matchMsgId) {
  // 뒤로: 패널에서 열었으면 게임 고르기(내 티어 목록)로, 카드에서 열었으면 티어 고르기로
  const buttons = [backButton(matchMsgId === 'panel' ? 'team:tier_games:panel' : `team:tier_back:${game}:${matchMsgId}`, '↩️ 뒤로')];
  return payload(tierCard(game, {
    header: tier ? '✅ 티어를 저장했어요' : '🗑️ 저장한 티어를 지웠어요',
    thumbTier: tier,
    blocks: [tier ? `## ${tierLine(game, tier)}` : '-# 다시 설정하려면 ↩️ 뒤로를 눌러 주세요.'],
    footer: tier ? '팀 짜기 카드의 이름 옆 이모지와 ⚖️ 밸런스에 바로 반영돼요' : undefined,
    rows: [new ActionRowBuilder().addComponents(...buttons)],
  }));
}

async function saveMyTier(interaction, game, tier, matchMsgId) {
  tiers.setTier(interaction.user.id, game, tier);
  const match = getMatches(interaction.client).get(matchMsgId);
  await interaction.update(buildTierSavedPayload(game, tier, matchMsgId));
  if (match) await refreshBoard(interaction.client, matchMsgId, match);
}

// 🏅 내 티어 설정 선택 메뉴
async function handleTeamSelect(interaction) {
  const { customId } = interaction;

  if (customId.startsWith('team:tier_pick:')) {
    const [, , game, matchMsgId] = customId.split(':');
    const key = interaction.values[0];
    if (key === 'none') return saveMyTier(interaction, game, null, matchMsgId);
    const t = tiers.findTier(game, key);
    if (!t) return interaction.update(notice('⚠️ **알 수 없는 티어예요.**'));
    if (t.scored) return interaction.update(buildTierScoreAskPayload(game, key, matchMsgId));
    if (!t.divs) return saveMyTier(interaction, game, { tier: key }, matchMsgId);
    return interaction.update(buildTierDivPayload(game, key, matchMsgId));
  }

  if (customId.startsWith('team:tier_div:')) {
    const [, , game, key, matchMsgId] = customId.split(':');
    const div = Number(interaction.values[0]);
    return saveMyTier(interaction, game, { tier: key, div }, matchMsgId);
  }

  // 예전 팀 관리 화면의 선택 메뉴
  await interaction.reply(notice(OLD_UI_NOTE, { ephemeral: true }));
}

// ── 카드 버튼 ───────────────────────────────────────────────

async function handleTeamButton(interaction) {
  const { customId } = interaction;

  if (customId.startsWith('team:input:')) {
    const matchMsgId = customId.slice('team:input:'.length);
    const match = await getEditableMatch(interaction, matchMsgId);
    if (!match) return;
    await interaction.showModal(buildInputModal(match, matchMsgId));
    return;
  }

  if (customId.startsWith('team:random:') || customId.startsWith('team:balance:')) {
    const how = customId.startsWith('team:random:') ? 'random' : 'balance';
    const matchMsgId = customId.slice(`team:${how}:`.length);
    const match = await getEditableMatch(interaction, matchMsgId);
    if (!match) return;
    if (match.participants.length < 2) {
      await interaction.reply(notice('⚠️ **팀을 나누려면 참가자가 2명 이상이어야 해요.**', { ephemeral: true }));
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const teams = how === 'random' ? randomTeams(match.participants) : balanceTeams(match.participants, match.data.game);
    await commitTeams(interaction, matchMsgId, match, teams, how);
    return;
  }

  if (customId === 'team:tier_games:panel') return interaction.update(buildTierGamePayload(interaction.user.id));
  if (customId.startsWith('team:tier_back:')) {
    const [, , game, matchMsgId] = customId.split(':');
    if (!tiers.hasTiers(game)) return interaction.update(notice('⚠️ **이 게임은 티어를 저장하지 않아요.**'));
    return interaction.update(buildTierPickPayload(game, matchMsgId, interaction.user.id));
  }
  if (customId.startsWith('team:tier_score:') || customId.startsWith('team:tier_save:')) {
    const [, action, game, key, matchMsgId] = customId.split(':');
    if (!tiers.findTier(game, key)) return interaction.update(notice('⚠️ **알 수 없는 티어예요.**'));
    if (action === 'tier_score') return interaction.showModal(buildTierScoreModal(game, key, matchMsgId));
    return saveMyTier(interaction, game, { tier: key }, matchMsgId);
  }

  if (customId.startsWith('team:tier:')) {
    const [, , game, matchMsgId] = customId.split(':');
    if (!tiers.hasTiers(game)) {
      await interaction.reply(notice('⚠️ **이 게임은 티어를 저장하지 않아요.**', { ephemeral: true }));
      return;
    }
    // 게임모집 패널에서 게임을 고른 경우(matchMsgId 'panel')엔 그 안내 메시지를 그대로 바꾼다
    if (matchMsgId === 'panel') await interaction.update(buildTierPickPayload(game, matchMsgId, interaction.user.id));
    else await interaction.reply(buildTierPickPayload(game, matchMsgId, interaction.user.id));
    return;
  }

  // 주최자 관리 메뉴의 ⚔️ 팀 짜기: 카드를 (다시) 맨 아래에 올린다
  if (customId.startsWith('team:open:')) {
    const matchMsgId = customId.slice('team:open:'.length);
    const match = await getEditableMatch(interaction, matchMsgId);
    if (!match) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const msg = await postBoard(interaction.client, matchMsgId, match);
      await interaction.editReply(notice('✅ **팀 짜기 카드를 올렸어요.**', { rows: [linkRow(msg.url)] }));
    } catch (err) {
      logError('처리 오류', `팀 짜기 카드 게시 실패 (${matchMsgId})`, err);
      await interaction.editReply(notice('⚠️ **팀 짜기 카드를 올리지 못했어요.** 잠시 뒤 다시 시도해 주세요.'));
    }
    return;
  }

  // 예전 팀 관리 화면(임시 메시지)에 남아 있던 버튼
  await interaction.reply(notice(OLD_UI_NOTE, { ephemeral: true }));
}

async function handleTeamModal(interaction) {
  if (interaction.customId.startsWith('team:tier_modal:')) {
    const [, , game, key, matchMsgId] = interaction.customId.split(':');
    const raw = interaction.fields.getTextInputValue('score').replace(/[^0-9]/g, '');
    const score = Number(raw);
    if (!raw || !Number.isFinite(score)) {
      await interaction.reply(notice('⚠️ **점수는 숫자로 적어 주세요.** (예: 350)', { ephemeral: true }));
      return;
    }
    return saveMyTier(interaction, game, { tier: key, score }, matchMsgId);
  }
  const matchMsgId = interaction.customId.slice('team:modal:'.length);
  const match = await getEditableMatch(interaction, matchMsgId);
  if (!match) return;
  const parsed = parseTeamsText(interaction.fields.getTextInputValue('teams'), { game: match.data.game });
  if (parsed.error) {
    await interaction.reply(notice(`⚠️ ${parsed.error}`, { ephemeral: true }));
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const note = learnTiers(match, parsed.hints);
  await commitTeams(interaction, matchMsgId, match, parsed.teams, 'input', note);
}

// 예전 팀 관리 화면의 선택 메뉴(index.js 가 예전 customId 를 여기로 보낸다)
async function handleTeamAssignSelect(interaction) {
  await interaction.reply(notice(OLD_UI_NOTE, { ephemeral: true }));
}

module.exports = {
  parseTeamsText, // 테스트용
  teamsToText,
  draftTeams,
  balanceTeams,
  resolveMember,
  buildBoardPayload, // 화면 모음·테스트용
  buildTierGamePayload,
  postBoard,
  handleTeamSelect,
  handleTeamButton,
  handleTeamModal,
  handleTeamAssignSelect,
};

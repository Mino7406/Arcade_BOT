// 팀.js — 내전 "팀 짜기" 카드.
//
// 사람들은 내전이 마감되면 내전채팅으로 넘어가 메모장에 팀을 짜서 붙여넣는다(윤진-승훈-시형-연우-강현 / ...).
// 그 습관을 그대로 받아 주는 게 목표라 버튼은 둘뿐이다.
//  - 📝 팀 입력: 칸 하나짜리 입력창. 메모장에 쓰던 그대로 붙여넣으면 된다(한 줄에 한 팀).
//  - 🎲 랜덤: 참가자를 무작위로 두 팀으로 나눈다.
// 입력할 때마다 "N판"으로 쌓이고, 카드는 지우고 맨 아래에 다시 올린다(채팅에 묻히지 않게).
// 직전 판을 올린 지 ROUND_FIX_MS 안에 다시 입력하면 오타 수정으로 보고 같은 판을 덮어쓴다.
//
// 카드는 내전이 마감되면 자동으로 올라가고(공용.js markClosed → setCloseHook), /팀으로 다시 끌어올릴 수도 있다.
// 기록은 match.board = { channelId, messageId, rounds: [{ teams: [{ name, members: [이름] }], at, by }] } 에 둔다.
// 이름은 사람이 적은 글자 그대로 둔다(별명·성 붙이기·(박)민규 같은 표기가 제각각이라 억지로 맞추지 않는다).

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
const { card, notice, payload } = require('../공통/카드');
const { logError } = require('../공통/로그');
const { NAEJEON_CHAT_CHANNEL_IDS = {} } = require('../../config');

const ROUND_FIX_MS = 10 * 60 * 1000;
const MAX_TEAMS = 10;
const MAX_MEMBERS = 15;
const HISTORY_SHOWN = 3;
const TEAM_ICONS = ['🔵', '🔴', '🟢', '🟡', '🟣', '🟠', '⚪', '🟤', '⚫', '🩷'];

// ── 붙여넣은 글 읽기 ─────────────────────────────────────────

// 티어 표기(불2·다3·초2·플2·브3 …). 이름이 아니라 바로 앞 사람에게 붙인다: "승훈 불2" → "승훈(불2)"
const TIER_RE = /^(아|브|실|골|플|에|다|초|불|레|마|그|챌)[1-5]$/;
// 줄 맨 앞의 팀 이름: [공수] / 1팀 / 팀1 / 1팀: / A팀 - 같은 것
const BRACKET_NAME_RE = /^\[([^\]]{1,20})\]\s*/;
const NUMBERED_NAME_RE = /^(\d{1,2}\s*팀|팀\s*\d{1,2}|[A-Za-z]\s*팀)\s*[:：\-]?\s*/;
const COLON_NAME_RE = /^([^\s:：]{1,10})\s*[:：]\s*/;
// "1." "2)" 처럼 번호만 있는 줄(로비 구분)은 건너뛴다
const LOBBY_LINE_RE = /^\d{1,2}\s*[.)]?$/;

function parseTeamLine(line) {
  let rest = line;
  let name = null;
  let m;
  if ((m = BRACKET_NAME_RE.exec(rest))) { name = m[1].trim(); rest = rest.slice(m[0].length); }
  else if ((m = NUMBERED_NAME_RE.exec(rest))) { rest = rest.slice(m[0].length); }
  else if ((m = COLON_NAME_RE.exec(rest))) { name = m[1].trim(); rest = rest.slice(m[0].length); }

  const members = [];
  for (const token of rest.split(/[\s,，\-·|]+/).filter(Boolean)) {
    if (TIER_RE.test(token) && members.length > 0) members[members.length - 1] += `(${token})`;
    else members.push(token);
  }
  return { name, members };
}

// 성공: { teams: [{ name, members }] } / 실패: { error: '안내 문구' }
function parseTeamsText(raw) {
  const segments = String(raw || '')
    .split(/\r?\n/)
    .flatMap(line => line.split(/\s*\/\s*|\s+vs\s+/i))
    .map(s => s.trim())
    .filter(s => s && !LOBBY_LINE_RE.test(s));

  let teams = segments.map(parseTeamLine).filter(t => t.members.length > 0);

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

  const seen = new Map();
  const dups = new Set();
  for (const t of teams) for (const n of t.members) {
    const key = n.replace(/\(.*?\)$/, '');
    if (seen.has(key)) dups.add(key);
    seen.set(key, true);
  }
  if (dups.size > 0) return { error: `두 번 적힌 이름이 있어요: **${[...dups].join(', ')}**` };

  return { teams };
}

// 지난 판을 입력창에 다시 채워 줄 때 쓰는 글(한 줄에 한 팀).
function teamsToText(teams) {
  return teams.map(t => `${t.name ? `[${t.name}] ` : ''}${t.members.join('-')}`).join('\n');
}

// 이름을 입력창에 넣을 때 구분 기호(띄어쓰기·- 등)와 겹치지 않게 지운다: "코리안갱씥 이경민" → "코리안갱씥이경민"
function nameToken(name) {
  return String(name).replace(/[\s,，\-·|/]+/g, '') || '?';
}

// 첫 판 초안: 마감된 참가자를 참가 순서대로 앞에서부터 반씩 두 팀으로.
function draftTeams(participants) {
  const names = participants.map(u => nameToken(u.displayName));
  const half = Math.ceil(names.length / 2);
  return [{ name: null, members: names.slice(0, half) }, { name: null, members: names.slice(half) }];
}

function randomTeams(participants) {
  const names = participants.map(u => u.displayName);
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [names[i], names[j]] = [names[j], names[i]];
  }
  const half = Math.ceil(names.length / 2);
  return [{ name: null, members: names.slice(0, half) }, { name: null, members: names.slice(half) }];
}

// ── 카드 ────────────────────────────────────────────────────

function teamLabel(team, i) {
  return `${TEAM_ICONS[i] ?? '▫️'} **${team.name ?? `팀 ${i + 1}`}**`;
}

function buildBoardRows(matchMsgId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`team:input:${matchMsgId}`).setLabel('📝 팀 입력').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`team:random:${matchMsgId}`).setLabel('🎲 랜덤').setStyle(ButtonStyle.Secondary),
  )];
}

function buildBoardPayload(match, matchMsgId) {
  const { gameInfo, title } = match.data;
  const rounds = match.board?.rounds ?? [];
  const last = rounds.at(-1);
  const blocks = [];

  if (!last) {
    // 아직 팀이 없으면 마감된 인원을 그대로 넣은 초안을 보여 준다. 📝 팀 입력을 누르면 이 글이 입력창에 채워져 있다.
    const draft = teamsToText(draftTeams(match.participants)) || '없음';
    blocks.push(`### 👥 참가자　${match.participants.length}명\n\`\`\`\n${draft}\n\`\`\`\n**📝 팀 입력**을 누르면 위 명단이 그대로 들어가 있어요. 자리만 바꾸고 제출하세요.\n-# 한 줄에 한 팀 · 한 줄로 다 적으면 반씩 나눠요 · 귀찮으면 🎲 랜덤`);
  } else {
    blocks.push(`### 👥 참가자　${match.participants.length}명\n${match.participants.map(u => u.displayName).join(' · ') || '*없음*'}`);
    const lines = last.teams.map((t, i) => `${teamLabel(t, i)}　${t.members.join(' · ')}`);
    blocks.push(`### ⚔️ ${rounds.length}판\n${lines.join('\n')}`);
    const history = rounds.slice(0, -1).slice(-HISTORY_SHOWN).map((r, k, arr) => {
      const no = rounds.length - arr.length + k;
      return `-# ${no}판 · ${r.teams.map(t => t.members.join(' ')).join('  vs  ')}`;
    }).reverse();
    if (history.length > 0) blocks.push({ text: history.join('\n'), noDivider: true });
  }

  return payload(card({
    color: gameInfo.color,
    header: '⚔️ 팀 짜기',
    sub: [title, match.closed ? '🔒 마감됨' : '🟢 모집 중'],
    thumb: gameThumb(gameInfo),
    thumbAlt: gameInfo.name,
    blocks,
    footer: last ? '다음 판도 📝 팀 입력 — 지난 판이 미리 채워져 있어서 바꿀 사람만 고치면 돼요' : '참가자·주최자 누구나 입력할 수 있어요',
    rows: buildBoardRows(matchMsgId),
  }));
}

// ── 카드 올리기 ─────────────────────────────────────────────

async function resolveBoardChannel(client, match) {
  const configured = NAEJEON_CHAT_CHANNEL_IDS[match.guildId];
  if (configured) {
    const ch = client.channels.cache.get(configured) || await client.channels.fetch(configured).catch(() => null);
    if (ch?.isTextBased?.()) return ch;
  }
  const guild = client.guilds?.cache?.get(match.guildId);
  const byName = guild?.channels?.cache?.find?.(c => c.isTextBased?.() && c.name?.includes('내전채팅'));
  if (byName) return byName;
  return match.message?.channel ?? null;
}

// 카드를 (지우고) 맨 아래에 새로 올린다. 올린 메시지를 돌려준다.
async function postBoard(client, matchMsgId, match) {
  if (!match.board) match.board = { channelId: null, messageId: null, rounds: [] };
  const board = match.board;
  if (board.channelId && board.messageId) {
    const oldCh = client.channels.cache.get(board.channelId) || await client.channels.fetch(board.channelId).catch(() => null);
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

// 마감되면 자동으로 한 번 올린다. 마감 해제 후 다시 마감돼도 이미 있으면 그대로 둔다.
setCloseHook('내전', async (matchMsgId, match) => {
  if (match.board?.messageId) return;
  const client = match.message?.client;
  if (!client) return;
  await postBoard(client, matchMsgId, match);
});

// ── 권한 ────────────────────────────────────────────────────

function canEdit(match, userId) {
  return match.data.organizer.id === userId || ADMIN_IDS.includes(userId) || match.participants.some(u => u.id === userId);
}

function addRound(match, teams, userId) {
  if (!match.board) match.board = { channelId: null, messageId: null, rounds: [] };
  const rounds = match.board.rounds;
  const last = rounds.at(-1);
  const round = { teams, at: Date.now(), by: userId };
  const fixed = !!(last && Date.now() - last.at < ROUND_FIX_MS);
  if (fixed) rounds[rounds.length - 1] = round;
  else rounds.push(round);
  return { fixed, no: rounds.length };
}

// ── /팀 : 내전 고르기 → 카드 다시 올리기 ─────────────────────

function buildMatchSelectMenu(matches) {
  const options = matches.map(([id, m]) => {
    const emojiStr = m.data.gameInfo.emoji;
    const cm = emojiStr.match(/^<a?:(\w+):(\d+)>$/);
    const emoji = cm ? { id: cm[2], name: cm[1] } : emojiStr;
    const max = parseInt(m.data.players) || 0;
    const statusIcon = m.closed ? '🔒' : '🟢';
    const rounds = m.board?.rounds?.length ?? 0;
    return {
      label: m.data.title.slice(0, 100),
      description: `${statusIcon} ${m.participants.length}/${max}명${rounds ? ` · ⚔️ ${rounds}판` : ''} · ${m.data.datetime}`.slice(0, 100),
      value: id,
      emoji,
    };
  });
  return new StringSelectMenuBuilder()
    .setCustomId('team:match_select')
    .setPlaceholder('팀을 짤 내전을 선택하세요')
    .addOptions(options.slice(0, 25));
}

function linkRow(url) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel('바로가기').setEmoji('🔗'),
  );
}

async function handleTeamMatchSelect(interaction) {
  const matchMsgId = interaction.values[0];
  const match = getMatches(interaction.client).get(matchMsgId);
  if (!match || match.guildId !== interaction.guildId) {
    await interaction.update(notice('⚠️ **만료된 내전입니다.**'));
    return;
  }
  if (!canEdit(match, interaction.user.id)) {
    await interaction.update(notice('❌ **이 내전의 참가자·주최자만 팀을 짤 수 있습니다.**'));
    return;
  }
  await interaction.deferUpdate();
  try {
    const msg = await postBoard(interaction.client, matchMsgId, match);
    await interaction.editReply(notice('✅ **팀 짜기 카드를 올렸어요.**', { rows: [linkRow(msg.url)] }));
  } catch (err) {
    logError('처리 오류', `팀 짜기 카드 게시 실패 (${matchMsgId})`, err);
    await interaction.editReply(notice('⚠️ **팀 짜기 카드를 올리지 못했어요.** 잠시 뒤 다시 시도해 주세요.'));
  }
}

// ── 카드 버튼 ───────────────────────────────────────────────

function buildInputModal(match, matchMsgId) {
  const rounds = match.board?.rounds ?? [];
  const last = rounds.at(-1);
  const fixing = !!(last && Date.now() - last.at < ROUND_FIX_MS);
  const input = new TextInputBuilder()
    .setCustomId('teams')
    .setLabel('한 줄에 한 팀 (- 나 띄어쓰기로 구분)')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('윤진-승훈-시형-연우-강현\n현호-찬영-찬우-승민-채원')
    .setRequired(true)
    .setMaxLength(1000);
  const prefill = last ? teamsToText(last.teams) : teamsToText(draftTeams(match.participants));
  if (prefill) input.setValue(prefill.slice(0, 1000));
  return new ModalBuilder()
    .setCustomId(`team:modal:${matchMsgId}`)
    .setTitle(fixing ? `${rounds.length}판 팀 고치기` : `${rounds.length + 1}판 팀 입력`)
    .addComponents(new ActionRowBuilder().addComponents(input));
}

async function getEditableMatch(interaction, matchMsgId) {
  const match = getMatches(interaction.client).get(matchMsgId);
  if (!match) {
    await interaction.reply(notice('⚠️ **끝났거나 취소된 내전이에요.**', { ephemeral: true }));
    return null;
  }
  if (!canEdit(match, interaction.user.id)) {
    await interaction.reply(notice('❌ **이 내전의 참가자·주최자만 팀을 입력할 수 있어요.**', { ephemeral: true }));
    return null;
  }
  return match;
}

async function commitRound(interaction, matchMsgId, match, teams) {
  const { fixed, no } = addRound(match, teams, interaction.user.id);
  try {
    await postBoard(interaction.client, matchMsgId, match);
  } catch (err) {
    logError('처리 오류', `팀 짜기 카드 다시 올리기 실패 (${matchMsgId})`, err);
    await interaction.editReply(notice('⚠️ **팀은 저장했지만 카드를 다시 올리지 못했어요.** /팀으로 다시 올려 주세요.'));
    return;
  }
  await interaction.editReply(notice(fixed ? `✏️ **${no}판 팀을 고쳤어요.**` : `✅ **${no}판 팀을 올렸어요.**`));
}

async function handleTeamButton(interaction) {
  const { customId } = interaction;

  if (customId.startsWith('team:input:')) {
    const matchMsgId = customId.slice('team:input:'.length);
    const match = await getEditableMatch(interaction, matchMsgId);
    if (!match) return;
    await interaction.showModal(buildInputModal(match, matchMsgId));
    return;
  }

  if (customId.startsWith('team:random:')) {
    const matchMsgId = customId.slice('team:random:'.length);
    const match = await getEditableMatch(interaction, matchMsgId);
    if (!match) return;
    if (match.participants.length < 2) {
      await interaction.reply(notice('⚠️ **랜덤으로 나누려면 참가자가 2명 이상이어야 해요.**', { ephemeral: true }));
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await commitRound(interaction, matchMsgId, match, randomTeams(match.participants));
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
  await interaction.reply(notice('⚠️ **팀 관리 방식이 바뀌었어요.** `/팀`을 다시 실행해 주세요.', { ephemeral: true }));
}

async function handleTeamModal(interaction) {
  const matchMsgId = interaction.customId.slice('team:modal:'.length);
  const match = await getEditableMatch(interaction, matchMsgId);
  if (!match) return;
  const parsed = parseTeamsText(interaction.fields.getTextInputValue('teams'));
  if (parsed.error) {
    await interaction.reply(notice(`⚠️ ${parsed.error}`, { ephemeral: true }));
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await commitRound(interaction, matchMsgId, match, parsed.teams);
}

// 예전 팀 관리 화면의 선택 메뉴
async function handleTeamAssignSelect(interaction) {
  await interaction.reply(notice('⚠️ **팀 관리 방식이 바뀌었어요.** `/팀`을 다시 실행해 주세요.', { ephemeral: true }));
}

module.exports = {
  parseTeamsText, // 테스트용
  teamsToText,
  draftTeams,
  buildBoardPayload, // 화면 모음·테스트용
  postBoard,
  buildMatchSelectMenu,
  handleTeamMatchSelect,
  handleTeamButton,
  handleTeamModal,
  handleTeamAssignSelect,
};

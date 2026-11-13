const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
} = require('discord.js');

const {
  ADMIN_IDS, getClientMap, getNaejeonMatches: getMatches, shuffleIntoTeams, buildTeamResultCard, buildCancelledCard, buildMatchCard, findMatchRole, buildMatchMessagePayload, buildPreviewPayload, buildManagePayload, buildMentionPayload, markClosed, markReopened, toggleAutoCloseWhileClosed, announceMatchCompletionXp,
  ROLE_NAMES, scheduleCancelledDelete, deleteMentionMessage, AUTO_CLOSE_DELAY_MS, saveNow,
  buildModal: buildModalBase, buildLeaveButton: buildLeaveButtonBase, buildPreviewComponents: buildPreviewComponentsBase, buildCancelComponents: buildCancelComponentsBase,
  buildNotifyModal: buildNotifyModalBase, parseNotifyTime, deriveNotifyFromDatetime, syncAutoNotify, notifyWhenText, formatNotifyTimeSmart, isNotify12HourInput, armNotifyReminder, clearNotifyTimer, isNotifyTooFar,
  setPublicPayloadBuilder,
} = require('./공용');
const { notice, payload, text } = require('../공통/카드');
const { displayNameFromInteraction } = require('../공통/이름');
const { logAction, logError } = require('../공통/로그');
const { OWNER_IDS } = require('../../config');

const GAMES = {
  lol:       { name: '리그 오브 레전드', emoji: '<:Lol:1510933684750913626>',    defaultPlayers: 10,   color: 0xC89B3C },
  valorant:  { name: '발로란트',         emoji: '<:Val:1510933698349109268>',    defaultPlayers: 10,   color: 0xFF4655 },
  overwatch: { name: '오버워치',         emoji: '<:Over:1510933569554612324>',   defaultPlayers: 10,   color: 0xF99E1A },
  pubg:      { name: '배틀그라운드',     emoji: '<:PUBG:1510933567646203964>',   defaultPlayers: 8,    color: 0xC8A96E },
  cobblemon: { name: '코블몬 토너먼트',  emoji: '<:cobblemon:1562830370368528384>', defaultPlayers: 16, color: 0xE3350D },
  custom:    { name: '직접 입력',        emoji: '🎮',                            defaultPlayers: null, color: 0x5865F2 },
};

// ─── 빌더 헬퍼 ────────────────────────────────────────────────
// buildModal/buildLeaveButton/buildPreviewComponents/buildCancelComponents는
// mojip.js와 로직이 완전히 동일해 shared.js로 옮기고, 여기서는 'naejeon' 타입으로
// 고정해 호출하는 얇은 래퍼만 둔다(기존 함수 시그니처는 그대로 유지).

function buildModal(game, data = {}) {
  return buildModalBase('naejeon', '내전', GAMES, game, data);
}

function buildNotifyModal(matchMsgId, notifyAt, is12h, onClose) {
  return buildNotifyModalBase('naejeon', matchMsgId, notifyAt, is12h, onClose);
}

function buildPublicComponents(participants, maxPlayers, closed = false) {
  const buttons = [
    new ButtonBuilder()
      .setCustomId('naejeon:join')
      .setLabel(closed ? '🔒 마감됨' : '✅ 참가하기')
      .setStyle(closed ? ButtonStyle.Primary : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('naejeon:manage')
      .setLabel('⚙️ 관리')
      .setStyle(ButtonStyle.Secondary),
  ];
  return [new ActionRowBuilder().addComponents(...buttons)];
}

// 공개 게시 메시지: 카드 한 장(+역할 멘션 줄). 버튼은 카드 안에 들어간다.
function buildPublicMessagePayload(match, opts = {}) {
  const maxPlayers = parseInt(match.data.players) || 0;
  return buildMatchMessagePayload({
    label: '내전',
    match,
    ...opts,
    rows: buildPublicComponents(match.participants, maxPlayers, match.closed),
  });
}
setPublicPayloadBuilder('내전', buildPublicMessagePayload); // 알림이 타이머로 발송되면 공용 모듈이 이걸로 카드를 다시 그려 🔔를 지운다

function buildLeaveButton(matchMsgId) {
  return buildLeaveButtonBase('naejeon', matchMsgId);
}

function buildPreviewComponents(data = null) {
  return buildPreviewComponentsBase('naejeon', data);
}

function buildCancelComponents() {
  return buildCancelComponentsBase('naejeon');
}

// 마감된 상태에서 자동 삭제 예정 시각(closedAt + AUTO_CLOSE_DELAY_MS)이 이미 지났는지 확인한다.
// autoClose가 꺼진 채로 마감돼 타이머가 안 걸린 매치는 시간이 아무리 지나도
// 저절로 안 없어지므로, 이 경우 ON/OFF 토글 대신 바로 "삭제" 버튼을 보여준다.
function isAutoDeleteExpired(match) {
  return !!(match.closed && match.closedAt && Date.now() - match.closedAt >= AUTO_CLOSE_DELAY_MS);
}

function buildAutoCloseToggleButton(match, matchMsgId, label) {
  if (isAutoDeleteExpired(match)) {
    return new ButtonBuilder()
      .setCustomId(`naejeon:toggle_match_autoclose:${matchMsgId}`)
      .setEmoji('🗑️')
      .setLabel(`${label} 삭제`)
      .setStyle(ButtonStyle.Danger);
  }
  return new ButtonBuilder()
    .setCustomId(`naejeon:toggle_match_autoclose:${matchMsgId}`)
    .setEmoji('⏰')
    .setLabel(match.data.autoClose ? '자동 삭제: ON' : '자동 삭제: OFF')
    .setStyle(match.data.autoClose ? ButtonStyle.Success : ButtonStyle.Secondary);
}

// 알림은 마감 여부와 무관하게 예약 시각에 발송되므로, 마감 후에도 확인/수정 가능하게 둔다.
// 이미 발송이 끝난 뒤에만(notifySent) 더 바꿀 수 없도록 버튼을 비활성화한다.
function buildNotifyButton(match, matchMsgId) {
  const notifyAt = match.data?.notifyAt;
  return new ButtonBuilder()
    .setCustomId(`naejeon:notify_set:${matchMsgId}`)
    .setLabel(notifyAt ? `🔔 알림 예약: ${notifyWhenText(match.data)}` : '🔔 알림 예약')
    .setStyle(notifyAt ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setDisabled(!!match.notifySent);
}

function buildManageMenu(match, matchMsgId) {
  const hasParticipants = match.participants.length > 0;
  const addRemoveRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`naejeon:add_member:${matchMsgId}`)
      .setLabel('➕ 참가자 추가')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`naejeon:remove_member:${matchMsgId}`)
      .setLabel('➖ 참가자 제거')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasParticipants),
  );
  if (match.closed) {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`naejeon:team_builder:${matchMsgId}`)
          .setLabel('🛠️ 팀 만들기')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`naejeon:match_mention:${matchMsgId}`)
          .setLabel('📣 참가자 멘션')
          .setStyle(ButtonStyle.Success)
          .setDisabled(!!match.mentionSent),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`naejeon:match_reopen:${matchMsgId}`)
          .setLabel('🔓 마감 해제')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`naejeon:match_edit:${matchMsgId}`)
          .setLabel('✏️ 내전 수정')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`naejeon:match_cancel:${matchMsgId}`)
          .setLabel('❌ 내전 취소')
          .setStyle(ButtonStyle.Danger),
      ),
      new ActionRowBuilder().addComponents(buildAutoCloseToggleButton(match, matchMsgId, '내전'), buildNotifyButton(match, matchMsgId)),
      addRemoveRow,
    ];
  }
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`naejeon:match_close:${matchMsgId}`)
        .setLabel('🔒 마감하기')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`naejeon:match_edit:${matchMsgId}`)
        .setLabel('✏️ 내전 수정')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`naejeon:match_cancel:${matchMsgId}`)
        .setLabel('❌ 내전 취소')
        .setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(buildAutoCloseToggleButton(match, matchMsgId, '내전'), buildNotifyButton(match, matchMsgId)),
    addRemoveRow,
  ];
}

function buildTeamBuilderComponents(match, matchMsgId) {
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`naejeon:team_assign:${matchMsgId}`)
    .setPlaceholder('팀 1에 배정할 참가자를 선택하세요.')
    .setMinValues(1)
    .setMaxValues(match.participants.length - 1)
    .addOptions(
      match.participants.map(u => ({
        label: u.displayName,
        value: u.id,
      }))
    );

  return [
    new ActionRowBuilder().addComponents(selectMenu),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`naejeon:team_shuffle:${matchMsgId}`)
        .setLabel('🎲 자동 배정')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`naejeon:manage_back:${matchMsgId}`)
        .setLabel('↩️ 관리로')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildTeamDoneRow(matchMsgId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`naejeon:team_builder:${matchMsgId}`)
      .setLabel('🔄 다시 배정')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`naejeon:team_shuffle:${matchMsgId}`)
      .setLabel('🎲 자동 배정')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`naejeon:manage_back:${matchMsgId}`)
      .setLabel('↩️ 관리로')
      .setStyle(ButtonStyle.Secondary),
  );
}

function getPending(client) {
  return getClientMap(client, 'pendingNaejeon');
}

// ─── 핸들러 ───────────────────────────────────────────────────

// 코블몬 토너먼트 정원이 다 차면 참가자 전원을 멘션해 코블몬 서버에서 엔트리하라고 안내한다.
// 수동 "참가자 멘션" 버튼과 같은 mentionSent/mentionMessageId를 써서 중복 멘션을 막고, 취소 시 함께 지워지게 한다.
async function announceCobblemonEntry(match) {
  if (match.data.game !== 'cobblemon' || match.mentionSent || match.participants.length === 0) return;
  match.mentionSent = true;
  const mentionText = match.participants.map(u => `<@${u.id}>`).join(' ');
  try {
    const msg = await match.message.channel.send(buildMentionPayload({
      headline: `<:cobblemon:1562830370368528384> ${match.data.title}`,
      mentionText: `**인원이 모두 모였습니다!**\n${mentionText}`,
      tail: '코블몬 서버에 접속해 **토너먼트에 엔트리**해 주세요.',
    }));
    match.mentionMessageId = msg.id;
  } catch (err) {
    match.mentionSent = false;
    console.error('코블몬 엔트리 안내 전송 실패:', err);
    logError('처리 오류', `코블몬 엔트리 안내 전송 실패 (${match.message.id})`, err);
  }
}

async function handleGameSelect(interaction) {
  const game = interaction.values[0];
  // 코블몬 토너먼트는 오너 전용 — 선택지는 오너에게만 보이지만, 남이 띄운 메뉴를 재사용하는 경우까지 막는다.
  if (game === 'cobblemon' && !OWNER_IDS.includes(interaction.user.id)) {
    await interaction.reply(notice('⚠️ **코블몬 토너먼트는 소유자만 생성할 수 있습니다.**', { ephemeral: true }));
    return;
  }
  await interaction.showModal(buildModal(game));
}

async function handleNaejeonModal(interaction) {
  const game        = interaction.customId.split(':')[2];
  const baseGameInfo = GAMES[game];
  const isCustom    = game === 'custom';
  const gameName    = isCustom ? interaction.fields.getTextInputValue('game_name') : null;
  const gameInfo    = gameName ? { ...baseGameInfo, name: gameName } : baseGameInfo;
  const title       = interaction.fields.getTextInputValue('title') || `${gameInfo.name} 내전`;
  const datetime    = interaction.fields.getTextInputValue('datetime');
  const players     = interaction.fields.getTextInputValue('players');
  const description = interaction.fields.getTextInputValue('description');

  if (isNaN(parseInt(players)) || parseInt(players) < 1) {
    await interaction.reply(notice('⚠️ **모집 인원은 1 이상의 숫자만 입력해주세요.**', { ephemeral: true }));
    return;
  }

  const data = { game, gameInfo, title, datetime, players, description, autoClose: true, createdAt: Date.now(), organizer: { id: interaction.user.id, displayName: displayNameFromInteraction(interaction) } };
  // 알림 예약은 기본 ON: 일시를 읽을 수 있으면 자동으로 켠다(안 고친 지금 시각이면 "자동 발송" = 마감 때 바로, 고쳤으면 그 시각). 끄려면 🔔 알림 예약에서 비워 제출.
  const autoNotify = deriveNotifyFromDatetime(datetime, { base: data.createdAt });
  if (autoNotify) Object.assign(data, autoNotify, { notifyAuto: true, notifyAutoSrc: datetime });
  getPending(interaction.client).set(interaction.user.id, data);

  await interaction.reply(buildPreviewPayload('naejeon', data, { ephemeral: true }));
}

async function handleNaejeonEditModal(interaction) {
  const game        = interaction.customId.split(':')[2];
  const baseGameInfo = GAMES[game];
  const isCustom    = game === 'custom';
  const gameName    = isCustom ? interaction.fields.getTextInputValue('game_name') : null;
  const gameInfo    = gameName ? { ...baseGameInfo, name: gameName } : baseGameInfo;
  const title       = interaction.fields.getTextInputValue('title') || `${gameInfo.name} 내전`;
  const datetime    = interaction.fields.getTextInputValue('datetime');
  const players     = interaction.fields.getTextInputValue('players');
  const description = interaction.fields.getTextInputValue('description');

  if (isNaN(parseInt(players)) || parseInt(players) < 1) {
    await interaction.reply(notice('⚠️ **모집 인원은 1 이상의 숫자만 입력해주세요.**', { ephemeral: true }));
    return;
  }

  const pending = getPending(interaction.client);
  const data = pending.get(interaction.user.id);
  if (!data || !interaction.isFromMessage()) {
    await interaction.reply(notice(`⚠️ **데이터가 만료되었습니다.**\n다시 \`/내전\`을 실행해주세요.`, { ephemeral: true }));
    return;
  }

  Object.assign(data, { gameInfo, title, datetime, players, description });
  const autoNotifyOff = syncAutoNotify(data) === 'off'; // 일시로 자동 설정된 알림이면 새 일시를 따라간다

  // 미리보기의 [수정] 버튼에서 연 모달이라 update()로 그 미리보기 메시지를 바로 고친다.
  // (예전엔 처음 미리보기를 띄운 인터랙션을 보관해 editReply했는데, 토큰이 15분이면 만료돼
  //  미리보기를 오래 띄워두고 수정하면 Invalid Webhook Token(50027)으로 실패했다.)
  await interaction.update(buildPreviewPayload('naejeon', data));
  if (autoNotifyOff) await interaction.followUp(notice('🔕 **일시를 읽을 수 없어 알림 예약이 꺼졌습니다.** (예: `11/12 20:00`, `내일 저녁 8시`)\n다시 켜려면 🔔 알림 예약을 눌러주세요.', { ephemeral: true })).catch(() => {});
}

// 팀 선택 드롭다운 제출 핸들러
async function handleTeamAssign(interaction) {
  const matchMsgId = interaction.customId.slice('naejeon:team_assign:'.length);
  const match = getMatches(interaction.client).get(matchMsgId);
  if (!match) {
    await interaction.update(notice(`⚠️ **만료된 내전입니다.**`));
    return;
  }

  const team1Ids = new Set(interaction.values);
  const team1 = match.participants.filter(u => team1Ids.has(u.id));
  const team2 = match.participants.filter(u => !team1Ids.has(u.id));

  match.teams = { team1, team2 };

  await match.message.edit(buildPublicMessagePayload(match));
  await interaction.update(notice('✅ **팀 배정이 완료되었습니다.**', { rows: [buildTeamDoneRow(matchMsgId)] }));
  await interaction.channel.send(payload(buildTeamResultCard(match.data, match.teams), { allowedMentions: { parse: [] } }));
}

async function handleNaejeonButton(interaction) {
  const { customId } = interaction;

  // ── 공개 게시 ──────────────────────────────────────────────
  if (customId === 'naejeon:publish') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.reply(notice(`⚠️ **데이터가 만료되었습니다.**\n다시 \`/내전\`을 실행해주세요.`, { ephemeral: true }));
      return;
    }
    const maxPlayers = parseInt(data.players) || 0;
    const participants = [];
    const role = findMatchRole(interaction.guild, data);
    getPending(interaction.client).delete(interaction.user.id);
    const roleContent = role ? `<@&${role.id}>` : '';
    // 역할 멘션은 카드 안 맨 위 글자로 넣고, 새로 보내는 이 메시지에만 알림이 가게 allowedMentions 에 담는다.
    const publishCard = buildMatchCard({ label: '내전', data, participants, rows: buildPublicComponents(participants, maxPlayers), roleMention: roleContent, notifyOn: !!data.notifyAt }); // 미리보기에서 알림을 예약해 뒀으면 처음부터 🔔
    const msg = await interaction.channel.send(payload(publishCard, {
      allowedMentions: { roles: role ? [role.id] : [], users: [] },
    }));
    const match = { data, participants, message: msg, closed: false, closedAt: null, teams: null, mentionSent: false, roleContent, guildId: interaction.guildId };
    getMatches(interaction.client).set(msg.id, match);
    saveNow(interaction.client);
    logAction(interaction, '매치 생성', `내전 '${data.title}'(${msg.id}) 공개 게시 — ${data.gameInfo?.name ?? data.game}, 정원 ${maxPlayers}명`);
    // 게시 전 미리보기 단계에서 이미 알림 예약을 해뒀다면, 그때는 매치가 없어 타이머를 못 걸었으므로 지금 건다.
    if (data.notifyAt) armNotifyReminder(getMatches(interaction.client), msg.id, match, '내전');
    await interaction.update(notice('✅ **채널에 공개 게시되었습니다!**'));
    return;
  }

  // ── 참가하기 ───────────────────────────────────────────────
  if (customId === 'naejeon:join') {
    const match = getMatches(interaction.client).get(interaction.message.id);
    if (!match) {
      await interaction.reply(notice(`⚠️ **만료된 내전입니다.**`, { ephemeral: true }));
      return;
    }
    if (match.closed) {
      const inMatch = match.participants.some(u => u.id === interaction.user.id);
      if (!inMatch) {
        await interaction.reply(notice('🔒 **이미 마감된 내전입니다.**', { ephemeral: true }));
        return;
      }
      await interaction.reply(notice('**⚠️ 마감된 내전입니다.**\n취소하려면 아래 버튼을 눌러주세요.', { rows: [buildLeaveButton(interaction.message.id)], ephemeral: true }));
      return;
    }
    const maxPlayers = parseInt(match.data.players) || 0;
    const alreadyIn = match.participants.some(u => u.id === interaction.user.id);

    if (alreadyIn) {
      await interaction.reply(notice('**⚠️ 이미 참가 중입니다.**\n취소하려면 아래 버튼을 눌러주세요.', { rows: [buildLeaveButton(interaction.message.id)], ephemeral: true }));
      return;
    }
    if (match.participants.length >= maxPlayers) {
      await interaction.reply(notice('❌ **모집 인원이 가득 찼습니다!**', { ephemeral: true }));
      return;
    }
    match.participants.push({ id: interaction.user.id, displayName: displayNameFromInteraction(interaction) });
    if (match.participants.length >= maxPlayers) markClosed(getMatches(interaction.client), interaction.message.id, match, '내전');
    await interaction.deferUpdate();
    await match.message.edit(buildPublicMessagePayload(match));
    if (match.closed) await announceMatchCompletionXp(match);
    if (match.participants.length >= maxPlayers) await announceCobblemonEntry(match);
    await interaction.followUp(notice(`✅ **참가 완료!** 명단에 등록되었습니다.\n취소하려면 아래 버튼을 눌러주세요.`, { rows: [buildLeaveButton(interaction.message.id)], ephemeral: true }));
    return;
  }

  // ── 참가 취소 ─────────────────────────────────────────────
  if (customId.startsWith('naejeon:leave:')) {
    const matchMsgId = customId.slice('naejeon:leave:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update(notice(`⚠️ **만료된 내전입니다.**`));
      return;
    }
    const idx = match.participants.findIndex(u => u.id === interaction.user.id);
    if (idx === -1) {
      await interaction.update(notice('⚠️ **이미 참가 취소된 상태입니다.**'));
      return;
    }
    match.participants.splice(idx, 1);
    // 팀에도 있으면 제거
    if (match.teams) {
      match.teams.team1 = match.teams.team1.filter(u => u.id !== interaction.user.id);
      match.teams.team2 = match.teams.team2.filter(u => u.id !== interaction.user.id);
      if (match.teams.team1.length === 0 && match.teams.team2.length === 0) {
        match.teams = null;
      }
    }
    const maxPlayers = parseInt(match.data.players) || 0;
    const reopened = match.closed && match.participants.length < maxPlayers;
    if (reopened) markReopened(match);
    await match.message.edit(buildPublicMessagePayload(match));
    await interaction.update(notice('❌ **참가가 취소되었습니다.**'));
    return;
  }

  // ── 주최자 관리 메뉴 ──────────────────────────────────────────
  if (customId === 'naejeon:manage') {
    const matchMsgId = interaction.message.id;
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.reply(notice(`⚠️ **만료된 내전입니다.**`, { ephemeral: true }));
      return;
    }
    if (match.data.organizer.id !== interaction.user.id && !ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply(notice('❌ **주최자만 사용할 수 있습니다.**', { ephemeral: true }));
      return;
    }
    await interaction.reply(buildManagePayload({ label: '내전', match, rows: buildManageMenu(match, matchMsgId), ephemeral: true }));
    return;
  }

  // ── 마감하기 (주최자 전용) ────────────────────────────────────
  if (customId.startsWith('naejeon:match_close:')) {
    const matchMsgId = customId.slice('naejeon:match_close:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update(notice(`⚠️ **만료된 내전입니다.**`));
      return;
    }
    const maxPlayers = parseInt(match.data.players) || 0;
    if (match.participants.length < maxPlayers) {
      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`naejeon:match_close_confirm:${matchMsgId}`)
          .setLabel('✅ 마감 확정')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`naejeon:manage_back:${matchMsgId}`)
          .setLabel('↩️ 돌아가기')
          .setStyle(ButtonStyle.Secondary),
      );
      await interaction.update(notice(`⚠️ **참가자가 미달입니다.** (${match.participants.length}/${maxPlayers}명)\n그래도 마감하시겠습니까?`, { rows: [confirmRow] }));
      return;
    }
    markClosed(getMatches(interaction.client), matchMsgId, match, '내전', false);
    await match.message.edit(buildPublicMessagePayload(match));
    await announceMatchCompletionXp(match);
    await interaction.update(buildManagePayload({ label: '내전', match, note: '✅ **내전이 마감되었습니다.**', rows: buildManageMenu(match, matchMsgId) }));
    return;
  }

  // ── 마감 확정 (미달 확인 후) ──────────────────────────────────
  if (customId.startsWith('naejeon:match_close_confirm:')) {
    const matchMsgId = customId.slice('naejeon:match_close_confirm:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update(notice(`⚠️ **만료된 내전입니다.**`));
      return;
    }
    markClosed(getMatches(interaction.client), matchMsgId, match, '내전', false);
    await match.message.edit(buildPublicMessagePayload(match));
    await announceMatchCompletionXp(match);
    await interaction.update(buildManagePayload({ label: '내전', match, note: '✅ **내전이 마감되었습니다.**', rows: buildManageMenu(match, matchMsgId) }));
    return;
  }

  // ── 마감 해제 (주최자 전용) ──────────────────────────────────
  if (customId.startsWith('naejeon:match_reopen:')) {
    const matchMsgId = customId.slice('naejeon:match_reopen:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update(notice(`⚠️ **만료된 내전입니다.**`));
      return;
    }
    markReopened(match);
    await match.message.edit(buildPublicMessagePayload(match));
    await interaction.update(buildManagePayload({ label: '내전', match, note: '🔓 **내전 마감이 해제되었습니다.**', rows: buildManageMenu(match, matchMsgId) }));
    return;
  }

  // ── 자동 삭제 ON/OFF 토글 (마감 후 자동 삭제 시각이 지났다면 즉시 삭제) ──
  if (customId.startsWith('naejeon:toggle_match_autoclose:')) {
    const matchMsgId = customId.slice('naejeon:toggle_match_autoclose:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update(notice(`⚠️ **만료된 내전입니다.**`));
      return;
    }
    const enabled = isAutoDeleteExpired(match) ? true : !match.data.autoClose;
    await toggleAutoCloseWhileClosed(getMatches(interaction.client), matchMsgId, match, '내전', enabled);
    if (!getMatches(interaction.client).has(matchMsgId)) {
      await interaction.update(notice('✅ **자동 삭제 시간이 지나 내전이 삭제되었습니다.**'));
      return;
    }
    await interaction.update(buildManagePayload({ label: '내전', match, note: `⏰ **자동 삭제가 ${match.data.autoClose ? 'ON' : 'OFF'}으로 변경되었습니다.**`, rows: buildManageMenu(match, matchMsgId) }));
    return;
  }

  // ── 팀 만들기 (주최자 전용) ───────────────────────────────────
  if (customId.startsWith('naejeon:team_builder:')) {
    const matchMsgId = customId.slice('naejeon:team_builder:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update(notice(`⚠️ **만료된 내전입니다.**`));
      return;
    }
    if (match.participants.length < 2) {
      await interaction.update(buildManagePayload({ label: '내전', match, note: '⚠️ **팀 만들기는 참가자가 2명 이상이어야 합니다.**', rows: buildManageMenu(match, matchMsgId) }));
      return;
    }
    await interaction.update(notice('🛠️ **팀 만들기** - 팀 1에 배정할 참가자를 선택하세요. \n(나머지는 자동으로 팀 2가 됩니다.)', { rows: buildTeamBuilderComponents(match, matchMsgId) }));
    return;
  }

  // ── 자동 팀 배정 ──────────────────────────────────────────────
  if (customId.startsWith('naejeon:team_shuffle:')) {
    const matchMsgId = customId.slice('naejeon:team_shuffle:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update(notice(`⚠️ **만료된 내전입니다.**`));
      return;
    }
    if (match.participants.length < 2) {
      await interaction.update(buildManagePayload({ label: '내전', match, note: '⚠️ **팀을 나누려면 참가자가 2명 이상이어야 합니다.**', rows: buildManageMenu(match, matchMsgId) }));
      return;
    }
    match.teams = shuffleIntoTeams(match.participants);
    await match.message.edit(buildPublicMessagePayload(match));
    await interaction.update(notice('✅ **자동 팀 배정이 완료되었습니다.**', { rows: [buildTeamDoneRow(matchMsgId)] }));
    await interaction.channel.send(payload(buildTeamResultCard(match.data, match.teams), { allowedMentions: { parse: [] } }));
    return;
  }

  // ── 관리 메뉴로 돌아가기 ──────────────────────────────────────
  if (customId.startsWith('naejeon:manage_back:')) {
    const matchMsgId = customId.slice('naejeon:manage_back:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update(notice(`⚠️ **만료된 내전입니다.**`));
      return;
    }
    await interaction.update(buildManagePayload({ label: '내전', match, rows: buildManageMenu(match, matchMsgId) }));
    return;
  }

  // ── 참가자 멘션 (주최자 전용, 1회) ───────────────────────────────
  if (customId.startsWith('naejeon:match_mention:')) {
    const matchMsgId = customId.slice('naejeon:match_mention:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update(notice(`⚠️ **만료된 내전입니다.**`));
      return;
    }
    if (match.data.organizer.id !== interaction.user.id && !ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply(notice('❌ **주최자만 사용할 수 있습니다.**', { ephemeral: true }));
      return;
    }
    if (!match.closed) {
      await interaction.update(buildManagePayload({ label: '내전', match, note: '⚠️ **마감된 내전에서만 사용할 수 있습니다.**', rows: buildManageMenu(match, matchMsgId) }));
      return;
    }
    if (match.mentionSent) {
      await interaction.update(buildManagePayload({ label: '내전', match, note: '⚠️ **이미 멘션을 보냈습니다.**', rows: buildManageMenu(match, matchMsgId) }));
      return;
    }
    if (match.participants.length === 0) {
      await interaction.update(buildManagePayload({ label: '내전', match, note: '⚠️ **참가자가 없습니다.**', rows: buildManageMenu(match, matchMsgId) }));
      return;
    }
    match.mentionSent = true;
    const mentionText = match.participants.map(u => `<@${u.id}>`).join(' ');
    // 멘션 발송(네트워크 요청)이 3초 인터랙션 응답 제한을 넘겨 Unknown interaction(10062)이
    // 나는 걸 막기 위해, 느릴 수 있는 channel.send보다 먼저 ack한다.
    await interaction.deferUpdate();
    const mentionMsg = await interaction.channel.send(buildMentionPayload({ title: match.data.title, mentionText }));
    match.mentionMessageId = mentionMsg.id;
    await interaction.editReply(buildManagePayload({ label: '내전', match, note: '📣 **참가자에게 멘션을 보냈습니다.**', rows: buildManageMenu(match, matchMsgId) }));
    return;
  }

  // ── 알림 예약 (주최자 전용) ────────────────────────────────────
  if (customId.startsWith('naejeon:notify_set:')) {
    const matchMsgId = customId.slice('naejeon:notify_set:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update(notice(`⚠️ **만료된 내전입니다.**`));
      return;
    }
    if (match.data.organizer.id !== interaction.user.id && !ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply(notice('❌ **주최자만 사용할 수 있습니다.**', { ephemeral: true }));
      return;
    }
    if (match.notifySent) {
      await interaction.reply(notice('❌ **이미 발송된 알림은 다시 수정할 수 없습니다.**', { ephemeral: true }));
      return;
    }
    if (match.data.notifyAt) {
      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`naejeon:notify_edit:${matchMsgId}`)
          .setLabel('✏️ 수정하기')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`naejeon:manage_back:${matchMsgId}`)
          .setLabel('↩️ 돌아가기')
          .setStyle(ButtonStyle.Secondary),
      );
      await interaction.update(notice(`🔔 **이미 알림이 예약되어 있습니다.** (${notifyWhenText(match.data)})\n수정하시겠습니까?`, { rows: [confirmRow] }));
      return;
    }
    // 일시에 적힌 시각을 알림 시각으로 바로 인식한다(읽을 수 없으면 직접 입력창을 연다. 이미 지난 시각이면 마감 때 바로 보낸다).
    const auto = deriveNotifyFromDatetime(match.data.datetime, { base: match.data.createdAt });
    if (auto) {
      Object.assign(match.data, auto, { notifyAuto: true, notifyAutoSrc: match.data.datetime });
      match.notifySent = false;
      armNotifyReminder(getMatches(interaction.client), matchMsgId, match, '내전');
      await match.message.edit(buildPublicMessagePayload(match)).catch(err => { logError('매치 알림', `${match.data?.title ?? '?'}(${match.message?.id}) 알림 예약 아이콘 갱신 실패`, err); });
      await interaction.update(buildManagePayload({ label: '내전', match, note: auto.notifyOnClose ? '🔔 **자동 발송으로 설정했어요.** 마감되는 순간 참가자에게 DM 알림을 보내요.' : `🔔 **일시에 맞춰 ${formatNotifyTimeSmart(auto.notifyAt, auto.notify12h)}에 참가자에게 DM 알림을 보낼게요.**`, rows: buildManageMenu(match, matchMsgId) }));
      return;
    }
    await interaction.showModal(buildNotifyModal(matchMsgId, match.data.notifyAt, match.data.notify12h, match.data.notifyOnClose));
    return;
  }

  // ── 알림 예약 수정(이미 예약된 상태에서 확인 후 모달 열기) ──────
  if (customId.startsWith('naejeon:notify_edit:')) {
    const matchMsgId = customId.slice('naejeon:notify_edit:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update(notice(`⚠️ **만료된 내전입니다.**`));
      return;
    }
    if (match.data.organizer.id !== interaction.user.id && !ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply(notice('❌ **주최자만 사용할 수 있습니다.**', { ephemeral: true }));
      return;
    }
    if (match.notifySent) {
      await interaction.reply(notice('❌ **이미 발송된 알림은 다시 수정할 수 없습니다.**', { ephemeral: true }));
      return;
    }
    await interaction.showModal(buildNotifyModal(matchMsgId, match.data.notifyAt, match.data.notify12h, match.data.notifyOnClose));
    return;
  }

  // ── 내전 수정 (주최자 전용) ────────────────────────────────────
  if (customId.startsWith('naejeon:match_edit:')) {
    const matchMsgId = customId.slice('naejeon:match_edit:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update(notice(`⚠️ **만료된 내전입니다.**`));
      return;
    }
    const editModal = buildModal(match.data.game, match.data);
    editModal.setCustomId(`naejeon:match_edit_modal:${match.data.game}:${matchMsgId}`);
    await interaction.showModal(editModal);
    return;
  }

  // ── 내전 취소 요청 (주최자 전용) ──────────────────────────────
  if (customId.startsWith('naejeon:match_cancel:')) {
    const matchMsgId = customId.slice('naejeon:match_cancel:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update(notice(`⚠️ **만료된 내전입니다.**`));
      return;
    }
    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`naejeon:match_cancel_confirm:${matchMsgId}`)
        .setLabel('✅ 확인')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`naejeon:manage_back:${matchMsgId}`)
        .setLabel('↩️ 돌아가기')
        .setStyle(ButtonStyle.Secondary),
    );
    await interaction.update(notice('⚠️ **내전을 취소하시겠습니까?**\n참가자 명단이 모두 사라지고 모집이 종료됩니다.', { rows: [confirmRow] }));
    return;
  }

  // ── 내전 취소 확정 ────────────────────────────────────────
  if (customId.startsWith('naejeon:match_cancel_confirm:')) {
    const matchMsgId = customId.slice('naejeon:match_cancel_confirm:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update(notice('⚠️ **이미 취소된 내전입니다.**'));
      return;
    }
    const cancelledByOrganizer = match.data.organizer.id === interaction.user.id;
    const cancelledCard = buildCancelledCard({ label: '내전', data: match.data, byOrganizer: cancelledByOrganizer });

    logAction(interaction, '매치 취소', `내전 '${match.data.title}'(${matchMsgId}) ${cancelledByOrganizer ? '주최자' : '관리자'}가 취소 (참가자 ${match.participants.length}명)`);
    clearNotifyTimer(match); // 취소된 매치는 알림을 보내지 않으므로 남은 예약 타이머를 취소한다.
    await match.message.edit(payload(cancelledCard, { allowedMentions: { parse: [] } }));
    getMatches(interaction.client).delete(matchMsgId);
    await deleteMentionMessage(interaction.client, match);
    scheduleCancelledDelete(interaction.client, matchMsgId, match.message.channelId, Date.now(), match.data.title);
    await interaction.update(notice('✅ **내전이 취소되었습니다.**'));
    return;
  }

  // ── 참가자 추가 (주최자/관리자 전용) ─────────────────────────
  if (customId.startsWith('naejeon:add_member:')) {
    const matchMsgId = customId.slice('naejeon:add_member:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update(notice(`⚠️ **만료된 내전입니다.**`));
      return;
    }
    const sel = new UserSelectMenuBuilder()
      .setCustomId(`naejeon:member_add_select:${matchMsgId}`)
      .setPlaceholder('참가자 선택')
      .setMinValues(1)
      .setMaxValues(10);
    await interaction.update(notice('➕ **참가자 추가** - 추가할 멤버를 선택하세요.', { rows: [
        new ActionRowBuilder().addComponents(sel),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`naejeon:manage_back:${matchMsgId}`)
            .setLabel('↩️ 관리로')
            .setStyle(ButtonStyle.Secondary),
        ),
      ] }));
    return;
  }

  // ── 참가자 제거 (주최자/관리자 전용) ─────────────────────────
  if (customId.startsWith('naejeon:remove_member:')) {
    const matchMsgId = customId.slice('naejeon:remove_member:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update(notice(`⚠️ **만료된 내전입니다.**`));
      return;
    }
    if (match.participants.length === 0) {
      await interaction.update(buildManagePayload({ label: '내전', match, note: '⚠️ **참가자가 없습니다.**', rows: buildManageMenu(match, matchMsgId) }));
      return;
    }
    const sel = new StringSelectMenuBuilder()
      .setCustomId(`naejeon:member_remove_select:${matchMsgId}`)
      .setPlaceholder('참가자 선택')
      .setMinValues(1)
      .setMaxValues(Math.min(match.participants.length, 25))
      .addOptions(match.participants.slice(0, 25).map(u => ({ label: u.displayName, value: u.id })));
    await interaction.update(notice('➖ **참가자 제거** - 제거할 멤버를 선택하세요.', { rows: [
        new ActionRowBuilder().addComponents(sel),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`naejeon:manage_back:${matchMsgId}`)
            .setLabel('↩️ 관리로')
            .setStyle(ButtonStyle.Secondary),
        ),
      ] }));
    return;
  }

  // ── 자동 종료 토글 ───────────────────────────────
  if (customId === 'naejeon:toggle_autoclose') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.reply(notice(`⚠️ **데이터가 만료되었습니다.**\n다시 \`/내전\`을 실행해주세요.`, { ephemeral: true }));
      return;
    }
    data.autoClose = !data.autoClose;
    await interaction.update(buildPreviewPayload('naejeon', data));
    return;
  }

  // ── 스팀 멘션 토글 (직접 입력 전용) ──────────────────────────
  if (customId === 'naejeon:toggle_steam') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.reply(notice(`⚠️ **데이터가 만료되었습니다.**\n다시 \`/내전\`을 실행해주세요.`, { ephemeral: true }));
      return;
    }
    data.mentionSteam = !data.mentionSteam;
    await interaction.update(buildPreviewPayload('naejeon', data));
    return;
  }

  // ── 알림 예약 (게시 전 미리보기) ────────────────────────────────
  if (customId === 'naejeon:notify_set_preview') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.reply(notice(`⚠️ **데이터가 만료되었습니다.**\n다시 \`/내전\`을 실행해주세요.`, { ephemeral: true }));
      return;
    }
    // 일시에 적힌 시각을 알림 시각으로 바로 인식한다(읽을 수 없을 때만 직접 입력창을 연다).
    if (!data.notifyAt) {
      const auto = deriveNotifyFromDatetime(data.datetime, { base: data.createdAt });
      if (auto) {
        Object.assign(data, auto, { notifyAuto: true, notifyAutoSrc: data.datetime });
        await interaction.update(buildPreviewPayload('naejeon', data));
        return;
      }
    }
    await interaction.showModal(buildNotifyModal('preview', data.notifyAt, data.notify12h, data.notifyOnClose));
    return;
  }

  // ── 수정 ───────────────────────────────────────────────────
  if (customId === 'naejeon:edit') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.reply(notice(`⚠️ **데이터가 만료되었습니다.**\n다시 \`/내전\`을 실행해주세요.`, { ephemeral: true }));
      return;
    }
    const editModal = buildModal(data.game, data);
    editModal.setCustomId(`naejeon:modal_edit:${data.game}`);
    await interaction.showModal(editModal);
    return;
  }

  // ── 취소 → 확인 탭 ────────────────────────────────────────
  if (customId === 'naejeon:cancel') {
    await interaction.update(notice('⚠️ **내전 생성을 취소하시겠습니까?**\n입력한 내용이 모두 사라집니다.', { rows: [buildCancelComponents()] }));
    return;
  }

  // ── 취소 확인 ─────────────────────────────────────────────
  if (customId === 'naejeon:cancel_confirm') {
    getPending(interaction.client).delete(interaction.user.id);
    await interaction.update(notice('❌ **내전 생성이 취소되었습니다.**'));
    return;
  }

  // ── 돌아가기 ──────────────────────────────────────────────
  if (customId === 'naejeon:cancel_back') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.update(notice(`⚠️ **데이터가 만료되었습니다.**\n다시 \`/내전\`을 실행해주세요.`));
      return;
    }
    await interaction.update(buildPreviewPayload('naejeon', data));
    return;
  }
}

async function handleNaejeonMatchEditModal(interaction) {
  // customId: naejeon:match_edit_modal:{game}:{matchMsgId}
  const parts = interaction.customId.split(':');
  const game        = parts[2];
  const matchMsgId  = parts[3];
  const baseGameInfo = GAMES[game];
  const isCustom    = game === 'custom';
  const gameName    = isCustom ? interaction.fields.getTextInputValue('game_name') : null;
  const gameInfo    = gameName ? { ...baseGameInfo, name: gameName } : baseGameInfo;

  const match = getMatches(interaction.client).get(matchMsgId);
  if (!match) {
    await interaction.reply(notice(`⚠️ **만료된 내전입니다.**`, { ephemeral: true }));
    return;
  }

  const title       = interaction.fields.getTextInputValue('title') || `${gameInfo.name} 내전`;
  const datetime    = interaction.fields.getTextInputValue('datetime');
  const players     = interaction.fields.getTextInputValue('players');
  const description = interaction.fields.getTextInputValue('description');

  if (isNaN(parseInt(players)) || parseInt(players) < 1) {
    await interaction.reply(notice('⚠️ **모집 인원은 1 이상의 숫자만 입력해주세요.**', { ephemeral: true }));
    return;
  }

  match.data = { ...match.data, gameInfo, title, datetime, players, description };
  let autoNotifyOff = false;
  if (match.data.notifyAuto && !match.notifySent) {
    autoNotifyOff = syncAutoNotify(match.data) === 'off';
    armNotifyReminder(getMatches(interaction.client), matchMsgId, match, '내전');
  }

  await match.message.edit(buildPublicMessagePayload(match));

  await interaction.reply(notice(`✅ **내전 정보가 수정되었습니다.**${autoNotifyOff ? '\n🔕 일시를 읽을 수 없어 알림 예약이 꺼졌습니다. (예: `11/12 20:00`, `내일 저녁 8시`)' : ''}`, { ephemeral: true }));
}

// customId: naejeon:notify_modal:{matchMsgId}. 비워서 제출하면 예약을 취소한다.
async function handleNaejeonNotifyModal(interaction) {
  const matchMsgId = interaction.customId.slice('naejeon:notify_modal:'.length);
  const raw = interaction.fields.getTextInputValue('notify_time').trim();

  // 게시 전 미리보기 단계: matchMsgId가 없으므로 유저 ID로 보관된 대기 데이터를 사용한다.
  if (matchMsgId === 'preview') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data || !interaction.isFromMessage()) {
      await interaction.reply(notice(`⚠️ **데이터가 만료되었습니다.**\n다시 \`/내전\`을 실행해주세요.`, { ephemeral: true }));
      return;
    }
    if (raw) {
      const notifyAt = parseNotifyTime(raw);
      if (!notifyAt) {
        await interaction.reply(notice('⚠️ **알림 시각 형식이 올바르지 않습니다.** (예: `6/5 20:00` 또는 `6/5 오후 8:00`)', { ephemeral: true }));
        return;
      }
      if (isNotifyTooFar(notifyAt)) {
        await interaction.reply(notice('⚠️ **알림은 최대 24일 이내로만 예약할 수 있습니다.**', { ephemeral: true }));
        return;
      }
      data.notifyAt = notifyAt;
      data.notify12h = isNotify12HourInput(raw);
      data.notifyAuto = false;
      data.notifyAutoSrc = null;
      data.notifyOnClose = false;
    } else {
      data.notifyAt = null;
      data.notify12h = false;
      data.notifyAuto = false;
      data.notifyAutoSrc = null;
      data.notifyOnClose = false;
    }
    await interaction.update(buildPreviewPayload('naejeon', data));
    return;
  }

  const match = getMatches(interaction.client).get(matchMsgId);
  if (!match) {
    await interaction.reply(notice(`⚠️ **만료된 내전입니다.**`, { ephemeral: true }));
    return;
  }

  if (!raw) {
    match.data.notifyAt = null;
    match.data.notify12h = false;
    match.data.notifyAuto = false;
    match.data.notifyAutoSrc = null;
    match.data.notifyOnClose = false;
    match.notifySent = false;
    clearNotifyTimer(match);
    await match.message.edit(buildPublicMessagePayload(match)).catch(err => { console.error('알림 예약 아이콘 갱신 실패:', err); logError('매치 알림', `${match.data?.title ?? '?'}(${match.message?.id}) 알림 예약 아이콘 갱신 실패`, err); });
    await interaction.reply(notice('🔕 **알림 예약이 취소되었습니다.**', { ephemeral: true }));
    return;
  }

  const notifyAt = parseNotifyTime(raw);
  if (!notifyAt) {
    await interaction.reply(notice('⚠️ **알림 시각 형식이 올바르지 않습니다.** (예: `6/5 20:00` 또는 `6/5 오후 8:00`)', { ephemeral: true }));
    return;
  }
  if (isNotifyTooFar(notifyAt)) {
    await interaction.reply(notice('⚠️ **알림은 최대 24일 이내로만 예약할 수 있습니다.**', { ephemeral: true }));
    return;
  }

  match.data.notifyAt = notifyAt;
  match.data.notify12h = isNotify12HourInput(raw);
  match.data.notifyAuto = false;
  match.data.notifyAutoSrc = null;
  match.data.notifyOnClose = false;
  match.notifySent = false;
  armNotifyReminder(getMatches(interaction.client), matchMsgId, match, '내전');
  await match.message.edit(buildPublicMessagePayload(match)).catch(err => { console.error('알림 예약 아이콘 갱신 실패:', err); logError('매치 알림', `${match.data?.title ?? '?'}(${match.message?.id}) 알림 예약 아이콘 갱신 실패`, err); });
  await interaction.reply(notice(`✅ **${formatNotifyTimeSmart(notifyAt, match.data.notify12h)}에 참가자에게 DM 알림을 보낼게요.**`, { ephemeral: true }));
}

async function handleNaejeonMemberAdd(interaction) {
  const matchMsgId = interaction.customId.slice('naejeon:member_add_select:'.length);
  const match = getMatches(interaction.client).get(matchMsgId);
  if (!match) {
    await interaction.update(notice(`⚠️ **만료된 내전입니다.**`));
    return;
  }
  const maxPlayers = parseInt(match.data.players) || 0;
  const newUserIds = interaction.values.filter(id => !match.participants.some(u => u.id === id));
  if (match.participants.length + newUserIds.length > maxPlayers) {
    await interaction.update(buildManagePayload({ label: '내전', match, note: `⚠️ **참가자 초과로 추가할 수 없습니다.**\n(내전 수정을 통해 인원을 수정해주세요.)`, rows: buildManageMenu(match, matchMsgId) }));
    return;
  }
  const added = [];
  const skipped = [];
  for (const userId of interaction.values) {
    if (match.participants.some(u => u.id === userId)) {
      const user = interaction.users.get(userId);
      skipped.push(user?.globalName || user?.username || userId);
      continue;
    }
    const member = interaction.members.get(userId);
    const user = interaction.users.get(userId);
    const displayName = member?.displayName || member?.nick || user?.globalName || user?.username || userId;
    match.participants.push({ id: userId, displayName });
    added.push(displayName);
  }
  const justClosed = !match.closed && match.participants.length >= maxPlayers;
  if (justClosed) markClosed(getMatches(interaction.client), matchMsgId, match, '내전');
  await match.message.edit(buildPublicMessagePayload(match));
  if (justClosed) await announceMatchCompletionXp(match);
  if (justClosed) await announceCobblemonEntry(match);
  const lines = [];
  if (added.length > 0)   lines.push(`✅ 추가됨: ${added.map(n => `**${n}**`).join(', ')}`);
  if (skipped.length > 0) lines.push(`⚠️ 이미 참가 중: ${skipped.map(n => `**${n}**`).join(', ')}`);
  await interaction.update(buildManagePayload({ label: '내전', match, note: lines.join('\n') || '완료', rows: buildManageMenu(match, matchMsgId) }));
}

async function handleNaejeonMemberRemove(interaction) {
  const matchMsgId = interaction.customId.slice('naejeon:member_remove_select:'.length);
  const match = getMatches(interaction.client).get(matchMsgId);
  if (!match) {
    await interaction.update(notice(`⚠️ **만료된 내전입니다.**`));
    return;
  }
  const removeIds = new Set(interaction.values);
  const removed = match.participants.filter(u => removeIds.has(u.id)).map(u => u.displayName);
  match.participants = match.participants.filter(u => !removeIds.has(u.id));
  if (match.teams) {
    match.teams.team1 = match.teams.team1.filter(u => !removeIds.has(u.id));
    match.teams.team2 = match.teams.team2.filter(u => !removeIds.has(u.id));
    if (match.teams.team1.length === 0 && match.teams.team2.length === 0) match.teams = null;
  }
  const maxPlayers = parseInt(match.data.players) || 0;
  const reopened = match.closed && match.participants.length < maxPlayers;
  if (reopened) markReopened(match);
  await match.message.edit(buildPublicMessagePayload(match));
  const resultLines = [`➖ 제거됨: ${removed.map(n => `**${n}**`).join(', ')}`];
  if (reopened) resultLines.push('🔓 **참가자 미달로 마감이 자동 해제되었습니다.**');
  await interaction.update(buildManagePayload({ label: '내전', match, note: resultLines.join('\n'), rows: buildManageMenu(match, matchMsgId) }));
}

module.exports = { buildManageMenu, buildLeaveButton, handleGameSelect, handleNaejeonModal, handleNaejeonEditModal, handleNaejeonButton, handleNaejeonMatchEditModal, handleNaejeonNotifyModal, handleTeamAssign, handleNaejeonMemberAdd, handleNaejeonMemberRemove, buildPublicMessagePayload };

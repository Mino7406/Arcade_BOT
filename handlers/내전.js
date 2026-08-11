const {
  ActionRowBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
} = require('discord.js');

const {
  ADMIN_IDS, getNaejeonMatches: getMatches, shuffleIntoTeams, buildTeamResultEmbed, titleHeader, markClosed, markReopened, toggleAutoCloseWhileClosed, announceMatchCompletionXp,
  ROLE_NAMES, buildPreviewEmbed, scheduleCancelledDelete, deleteMentionMessage, AUTO_CLOSE_DELAY_MS,
  buildModal: buildModalBase, buildLeaveButton: buildLeaveButtonBase, buildPreviewComponents: buildPreviewComponentsBase, buildCancelComponents: buildCancelComponentsBase,
  buildNotifyModal: buildNotifyModalBase, parseNotifyTime, formatNotifyTime, formatNotifyTimeKorean, armNotifyReminder, clearNotifyTimer, isNotifyTooFar,
} = require('./공용');

const GAMES = {
  lol:       { name: '리그 오브 레전드', emoji: '<:Lol:1510933684750913626>',    defaultPlayers: 10,   color: 0xC89B3C },
  valorant:  { name: '발로란트',         emoji: '<:Val:1510933698349109268>',    defaultPlayers: 10,   color: 0xFF4655 },
  overwatch: { name: '오버워치',         emoji: '<:Over:1510933569554612324>',   defaultPlayers: 10,   color: 0xF99E1A },
  pubg:      { name: '배틀그라운드',     emoji: '<:PUBG:1510933567646203964>',   defaultPlayers: 8,    color: 0xC8A96E },
  custom:    { name: '직접 입력',        emoji: '🎮',                            defaultPlayers: null, color: 0x5865F2 },
};

// ─── 빌더 헬퍼 ────────────────────────────────────────────────
// buildModal/buildLeaveButton/buildPreviewComponents/buildCancelComponents는
// mojip.js와 로직이 완전히 동일해 shared.js로 옮기고, 여기서는 'naejeon' 타입으로
// 고정해 호출하는 얇은 래퍼만 둔다(기존 함수 시그니처는 그대로 유지).

function buildModal(game, data = {}) {
  return buildModalBase('naejeon', '내전', GAMES, game, data);
}

function buildNotifyModal(matchMsgId, notifyAt) {
  return buildNotifyModalBase('naejeon', matchMsgId, notifyAt);
}

// teams: null | { team1: User[], team2: User[] }
function buildPublicEmbed(data, participants, closed = false, teams = null) {
  const { game, gameInfo, title, datetime, players, description, organizer } = data;
  const max = parseInt(players) || 0;
  const isFull = participants.length >= max;

  const statusText = closed ? '🔒 마감됨' : isFull ? '✅ 모집 완료' : '🟢 모집 중';
  const color = closed ? 0x57F287 : isFull ? 0x808080 : gameInfo.color;

  const lines = [
    `🎮 **게임**　　${gameInfo.name}`,
    `📅 **일시**　　${datetime}`,
    `👑 **주최자**　**\`${organizer.displayName}\`**`,
    `📊 **상태**　　${statusText}`,
  ];

  const embed = new EmbedBuilder()
    .setColor(color)
    .setDescription(`${titleHeader(game, gameInfo, title)}\n${lines.join('\n')}`)
    .setFooter({ text: closed ? '🔒 마감된 내전입니다.' : isFull ? '✅ 모집이 완료되었습니다.' : '✅ 버튼을 눌러 참가하세요!' })
    .setTimestamp();

  if (description) embed.addFields({ name: '📝 메모', value: description });

  if (teams) {
    const assignedIds = new Set([
      ...teams.team1.map(u => u.id),
      ...teams.team2.map(u => u.id),
    ]);
    const unassigned = participants.filter(u => !assignedIds.has(u.id));

    if (unassigned.length > 0) {
      embed.addFields({
        name: `👤 미배정 (${unassigned.length}명)`,
        value: `\`\`\`\n${unassigned.map((u, i) => `${i + 1}. ${u.displayName}`).join('\n')}\n\`\`\``,
      });
    }

    embed.addFields(
      {
        name: `🔵 팀 1 - ${teams.team1.length}명`,
        value: teams.team1.length > 0 ? `\`\`\`\n${teams.team1.map((u, i) => `${i + 1}. ${u.displayName}`).join('\n')}\n\`\`\`` : '없음',
        inline: true,
      },
      {
        name: `🔴 팀 2 - ${teams.team2.length}명`,
        value: teams.team2.length > 0 ? `\`\`\`\n${teams.team2.map((u, i) => `${i + 1}. ${u.displayName}`).join('\n')}\n\`\`\`` : '없음',
        inline: true,
      },
    );
  } else {
    const participantText = participants.length > 0
      ? `\`\`\`\n${participants.map((u, i) => `${i + 1}. ${u.displayName}`).join('\n')}\n\`\`\``
      : '*아직 참가자가 없습니다.*';
    embed.addFields({
      name: `👥 참가자  ${participants.length} / ${max}명`,
      value: participantText,
    });
  }

  return embed;
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

function buildPublicMessagePayload(match) {
  const maxPlayers = parseInt(match.data.players) || 0;
  return {
    content: match.roleContent || '',
    embeds: [buildPublicEmbed(match.data, match.participants, match.closed, match.teams)],
    components: buildPublicComponents(match.participants, maxPlayers, match.closed),
    allowedMentions: { parse: [] },
    attachments: [], // 예전 썸네일 기능 시절 붙었던 첨부파일이 남아있는 메시지를 정리
  };
}

function buildLeaveButton(matchMsgId) {
  return buildLeaveButtonBase('naejeon', matchMsgId);
}

function buildPreviewComponents(data = null) {
  return buildPreviewComponentsBase('naejeon', data);
}

function buildCancelComponents() {
  return buildCancelComponentsBase('naejeon');
}

// 마감된 상태에서 자동 삭제 예정 시각(closedAt + 8시간)이 이미 지났는지 확인한다.
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

// 마감 후에는 알림 예약을 더 바꿀 수 없도록 버튼을 비활성화한다(설정된 시각은 그대로 유지·표시).
function buildNotifyButton(match, matchMsgId) {
  const notifyAt = match.data?.notifyAt;
  return new ButtonBuilder()
    .setCustomId(`naejeon:notify_set:${matchMsgId}`)
    .setLabel(notifyAt ? `🔔 알림 예약: ${formatNotifyTimeKorean(notifyAt)}` : '🔔 알림 예약')
    .setStyle(notifyAt ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setDisabled(!!match.closed);
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
  if (!client.pendingNaejeon) client.pendingNaejeon = new Map();
  return client.pendingNaejeon;
}

// ─── 핸들러 ───────────────────────────────────────────────────

async function handleGameSelect(interaction) {
  const game = interaction.values[0];
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
    await interaction.reply({ content: '⚠️ **모집 인원은 1 이상의 숫자만 입력해주세요.**', ephemeral: true });
    return;
  }

  const data = { game, gameInfo, title, datetime, players, description, autoClose: true, organizer: { id: interaction.user.id, displayName: interaction.member?.displayName || interaction.user.globalName || interaction.user.username }, _previewInteraction: interaction };
  getPending(interaction.client).set(interaction.user.id, data);

  await interaction.reply({
    content: '**미리보기** - 이 내용이 채널에 게시됩니다.',
    embeds: [buildPreviewEmbed(data)],
    components: buildPreviewComponents(data),
    attachments: [],
    ephemeral: true,
  });
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
    await interaction.reply({ content: '⚠️ **모집 인원은 1 이상의 숫자만 입력해주세요.**', ephemeral: true });
    return;
  }

  const pending = getPending(interaction.client);
  const data = pending.get(interaction.user.id);
  if (!data || !data._previewInteraction) {
    await interaction.reply({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/내전\`을 실행해주세요.`, ephemeral: true });
    return;
  }

  Object.assign(data, { gameInfo, title, datetime, players, description });

  await data._previewInteraction.editReply({
    content: '**미리보기** - 이 내용이 채널에 게시됩니다.',
    embeds: [buildPreviewEmbed(data)],
    components: buildPreviewComponents(data),
    attachments: [],
  });

  // 모달 인터랙션을 조용히 마무리 (새 메시지 생성 없이)
  await interaction.deferReply({ ephemeral: true });
  await interaction.deleteReply();
}

// 팀 선택 드롭다운 제출 핸들러
async function handleTeamAssign(interaction) {
  const matchMsgId = interaction.customId.slice('naejeon:team_assign:'.length);
  const match = getMatches(interaction.client).get(matchMsgId);
  if (!match) {
    await interaction.update({ content: `⚠️ **만료된 내전입니다.**`, embeds: [], attachments: [], components: [] });
    return;
  }

  const team1Ids = new Set(interaction.values);
  const team1 = match.participants.filter(u => team1Ids.has(u.id));
  const team2 = match.participants.filter(u => !team1Ids.has(u.id));

  match.teams = { team1, team2 };

  await match.message.edit(buildPublicMessagePayload(match));
  await interaction.update({ content: '✅ **팀 배정이 완료되었습니다.**', embeds: [], attachments: [], components: [buildTeamDoneRow(matchMsgId)] });
  await interaction.channel.send({ embeds: [buildTeamResultEmbed(match.data, match.teams)], attachments: [], allowedMentions: { parse: [] } });
}

async function handleNaejeonButton(interaction) {
  const { customId } = interaction;

  // ── 공개 게시 ──────────────────────────────────────────────
  if (customId === 'naejeon:publish') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.reply({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/내전\`을 실행해주세요.`, ephemeral: true });
      return;
    }
    const maxPlayers = parseInt(data.players) || 0;
    const participants = [];
    const roleName = ROLE_NAMES[data.game] || (data.mentionSteam ? '스팀' : null);
    const role = roleName && interaction.guild
      ? interaction.guild.roles.cache.find(r => r.name === roleName)
      : null;
    getPending(interaction.client).delete(interaction.user.id);
    const roleContent = role ? `<@&${role.id}>` : '';
    const msg = await interaction.channel.send({
      content: roleContent,
      embeds: [buildPublicEmbed(data, participants)],
      components: buildPublicComponents(participants, maxPlayers),
      attachments: [],
      allowedMentions: { roles: role ? [role.id] : [], users: [] },
    });
    const match = { data, participants, message: msg, closed: false, closedAt: null, teams: null, mentionSent: false, roleContent, guildId: interaction.guildId };
    getMatches(interaction.client).set(msg.id, match);
    // 게시 전 미리보기 단계에서 이미 알림 예약을 해뒀다면, 그때는 매치가 없어 타이머를 못 걸었으므로 지금 건다.
    if (data.notifyAt) armNotifyReminder(getMatches(interaction.client), msg.id, match, '내전');
    await interaction.update({ content: '✅ **채널에 공개 게시되었습니다!**', embeds: [], attachments: [], components: [] });
    return;
  }

  // ── 참가하기 ───────────────────────────────────────────────
  if (customId === 'naejeon:join') {
    const match = getMatches(interaction.client).get(interaction.message.id);
    if (!match) {
      await interaction.reply({ content: `⚠️ **만료된 내전입니다.**`, ephemeral: true });
      return;
    }
    if (match.closed) {
      const inMatch = match.participants.some(u => u.id === interaction.user.id);
      if (!inMatch) {
        await interaction.reply({ content: '🔒 **이미 마감된 내전입니다.**', ephemeral: true });
        return;
      }
      await interaction.reply({
        content: '**⚠️ 마감된 내전입니다.**\n취소하려면 아래 버튼을 눌러주세요.',
        components: [buildLeaveButton(interaction.message.id)],
        ephemeral: true,
      });
      return;
    }
    const maxPlayers = parseInt(match.data.players) || 0;
    const alreadyIn = match.participants.some(u => u.id === interaction.user.id);

    if (alreadyIn) {
      await interaction.reply({
        content: '**⚠️ 이미 참가 중입니다.**\n취소하려면 아래 버튼을 눌러주세요.',
        components: [buildLeaveButton(interaction.message.id)],
        ephemeral: true,
      });
      return;
    }
    if (match.participants.length >= maxPlayers) {
      await interaction.reply({ content: '❌ **모집 인원이 가득 찼습니다!**', ephemeral: true });
      return;
    }
    match.participants.push({ id: interaction.user.id, displayName: interaction.member?.displayName || interaction.user.globalName || interaction.user.username });
    if (match.participants.length >= maxPlayers) markClosed(getMatches(interaction.client), interaction.message.id, match, '내전');
    await interaction.deferUpdate();
    await match.message.edit(buildPublicMessagePayload(match));
    if (match.closed) await announceMatchCompletionXp(match);
    await interaction.followUp({
      content: `✅ **참가 완료!** 명단에 등록되었습니다.\n취소하려면 아래 버튼을 눌러주세요.`,
      components: [buildLeaveButton(interaction.message.id)],
      ephemeral: true,
    });
    return;
  }

  // ── 참가 취소 ─────────────────────────────────────────────
  if (customId.startsWith('naejeon:leave:')) {
    const matchMsgId = customId.slice('naejeon:leave:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 내전입니다.**`, components: [] });
      return;
    }
    const idx = match.participants.findIndex(u => u.id === interaction.user.id);
    if (idx === -1) {
      await interaction.update({ content: '⚠️ **이미 참가 취소된 상태입니다.**', components: [] });
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
    await interaction.update({ content: '❌ **참가가 취소되었습니다.**', components: [] });
    return;
  }

  // ── 주최자 관리 메뉴 ──────────────────────────────────────────
  if (customId === 'naejeon:manage') {
    const matchMsgId = interaction.message.id;
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.reply({ content: `⚠️ **만료된 내전입니다.**`, ephemeral: true });
      return;
    }
    if (match.data.organizer.id !== interaction.user.id && !ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ **주최자만 사용할 수 있습니다.**', ephemeral: true });
      return;
    }
    await interaction.reply({
      content: '⚙️ **주최자 관리 메뉴**',
      components: buildManageMenu(match, matchMsgId),
      ephemeral: true,
    });
    return;
  }

  // ── 마감하기 (주최자 전용) ────────────────────────────────────
  if (customId.startsWith('naejeon:match_close:')) {
    const matchMsgId = customId.slice('naejeon:match_close:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 내전입니다.**`, components: [] });
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
      await interaction.update({
        content: `⚠️ **참가자가 미달입니다.** (${match.participants.length}/${maxPlayers}명)\n그래도 마감하시겠습니까?`,
        embeds: [], attachments: [],
        components: [confirmRow],
      });
      return;
    }
    markClosed(getMatches(interaction.client), matchMsgId, match, '내전', false);
    await match.message.edit(buildPublicMessagePayload(match));
    await announceMatchCompletionXp(match);
    await interaction.update({
      content: '✅ **내전이 마감되었습니다.**',
      components: buildManageMenu(match, matchMsgId),
    });
    return;
  }

  // ── 마감 확정 (미달 확인 후) ──────────────────────────────────
  if (customId.startsWith('naejeon:match_close_confirm:')) {
    const matchMsgId = customId.slice('naejeon:match_close_confirm:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 내전입니다.**`, components: [] });
      return;
    }
    markClosed(getMatches(interaction.client), matchMsgId, match, '내전', false);
    await match.message.edit(buildPublicMessagePayload(match));
    await announceMatchCompletionXp(match);
    await interaction.update({
      content: '✅ **내전이 마감되었습니다.**',
      components: buildManageMenu(match, matchMsgId),
    });
    return;
  }

  // ── 마감 해제 (주최자 전용) ──────────────────────────────────
  if (customId.startsWith('naejeon:match_reopen:')) {
    const matchMsgId = customId.slice('naejeon:match_reopen:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 내전입니다.**`, components: [] });
      return;
    }
    markReopened(match);
    await match.message.edit(buildPublicMessagePayload(match));
    await interaction.update({
      content: '🔓 **내전 마감이 해제되었습니다.**',
      components: buildManageMenu(match, matchMsgId),
    });
    return;
  }

  // ── 자동 삭제 ON/OFF 토글 (마감 후 자동 삭제 시각이 지났다면 즉시 삭제) ──
  if (customId.startsWith('naejeon:toggle_match_autoclose:')) {
    const matchMsgId = customId.slice('naejeon:toggle_match_autoclose:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 내전입니다.**`, components: [] });
      return;
    }
    const enabled = isAutoDeleteExpired(match) ? true : !match.data.autoClose;
    await toggleAutoCloseWhileClosed(getMatches(interaction.client), matchMsgId, match, '내전', enabled);
    if (!getMatches(interaction.client).has(matchMsgId)) {
      await interaction.update({ content: '✅ **자동 삭제 시간이 지나 내전이 삭제되었습니다.**', components: [] });
      return;
    }
    await interaction.update({
      content: `⏰ **자동 삭제가 ${match.data.autoClose ? 'ON' : 'OFF'}으로 변경되었습니다.**`,
      components: buildManageMenu(match, matchMsgId),
    });
    return;
  }

  // ── 팀 만들기 (주최자 전용) ───────────────────────────────────
  if (customId.startsWith('naejeon:team_builder:')) {
    const matchMsgId = customId.slice('naejeon:team_builder:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 내전입니다.**`, embeds: [], attachments: [], components: [] });
      return;
    }
    if (match.participants.length < 2) {
      await interaction.update({
        content: '⚠️ **팀 만들기는 참가자가 2명 이상이어야 합니다.**',
        embeds: [], attachments: [],
        components: buildManageMenu(match, matchMsgId),
      });
      return;
    }
    await interaction.update({
      content: '🛠️ **팀 만들기** - 팀 1에 배정할 참가자를 선택하세요. \n(나머지는 자동으로 팀 2가 됩니다.)',
      embeds: [], attachments: [],
      components: buildTeamBuilderComponents(match, matchMsgId),
    });
    return;
  }

  // ── 자동 팀 배정 ──────────────────────────────────────────────
  if (customId.startsWith('naejeon:team_shuffle:')) {
    const matchMsgId = customId.slice('naejeon:team_shuffle:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 내전입니다.**`, embeds: [], attachments: [], components: [] });
      return;
    }
    if (match.participants.length < 2) {
      await interaction.update({
        content: '⚠️ **팀을 나누려면 참가자가 2명 이상이어야 합니다.**',
        embeds: [], attachments: [],
        components: buildManageMenu(match, matchMsgId),
      });
      return;
    }
    match.teams = shuffleIntoTeams(match.participants);
    await match.message.edit(buildPublicMessagePayload(match));
    await interaction.update({ content: '✅ **자동 팀 배정이 완료되었습니다.**', embeds: [], attachments: [], components: [buildTeamDoneRow(matchMsgId)] });
    await interaction.channel.send({ embeds: [buildTeamResultEmbed(match.data, match.teams)], attachments: [], allowedMentions: { parse: [] } });
    return;
  }

  // ── 관리 메뉴로 돌아가기 ──────────────────────────────────────
  if (customId.startsWith('naejeon:manage_back:')) {
    const matchMsgId = customId.slice('naejeon:manage_back:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 내전입니다.**`, embeds: [], attachments: [], components: [] });
      return;
    }
    await interaction.update({
      content: '⚙️ **주최자 관리 메뉴**',
      embeds: [], attachments: [],
      components: buildManageMenu(match, matchMsgId),
    });
    return;
  }

  // ── 참가자 멘션 (주최자 전용, 1회) ───────────────────────────────
  if (customId.startsWith('naejeon:match_mention:')) {
    const matchMsgId = customId.slice('naejeon:match_mention:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update({ content: `**⚠️ 만료된 내전입니다.**`, components: [] });
      return;
    }
    if (match.data.organizer.id !== interaction.user.id && !ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ **주최자만 사용할 수 있습니다.**', ephemeral: true });
      return;
    }
    if (!match.closed) {
      await interaction.update({ content: '⚠️ **마감된 내전에서만 사용할 수 있습니다.**', components: buildManageMenu(match, matchMsgId) });
      return;
    }
    if (match.mentionSent) {
      await interaction.update({ content: '⚠️ **이미 멘션을 보냈습니다.**', components: buildManageMenu(match, matchMsgId) });
      return;
    }
    if (match.participants.length === 0) {
      await interaction.update({ content: '⚠️ **참가자가 없습니다.**', components: buildManageMenu(match, matchMsgId) });
      return;
    }
    match.mentionSent = true;
    const mentionText = match.participants.map(u => `<@${u.id}>`).join(' ');
    const mentionMsg = await interaction.channel.send({
      content: `📣 **${match.data.title}**\n${mentionText}`,
      allowedMentions: { parse: ['users'] },
    });
    match.mentionMessageId = mentionMsg.id;
    await interaction.update({
      content: '📣 **참가자에게 멘션을 보냈습니다.**',
      components: buildManageMenu(match, matchMsgId),
    });
    return;
  }

  // ── 알림 예약 (주최자 전용) ────────────────────────────────────
  if (customId.startsWith('naejeon:notify_set:')) {
    const matchMsgId = customId.slice('naejeon:notify_set:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 내전입니다.**`, components: [] });
      return;
    }
    if (match.data.organizer.id !== interaction.user.id && !ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ **주최자만 사용할 수 있습니다.**', ephemeral: true });
      return;
    }
    if (match.closed) {
      await interaction.reply({ content: '❌ **마감된 이후에는 알림 예약을 변경할 수 없습니다.**', ephemeral: true });
      return;
    }
    await interaction.showModal(buildNotifyModal(matchMsgId, match.data.notifyAt));
    return;
  }

  // ── 내전 수정 (주최자 전용) ────────────────────────────────────
  if (customId.startsWith('naejeon:match_edit:')) {
    const matchMsgId = customId.slice('naejeon:match_edit:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 내전입니다.**`, components: [] });
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
      await interaction.update({ content: `⚠️ **만료된 내전입니다.**`, components: [] });
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
    await interaction.update({
      content: '⚠️ **내전을 취소하시겠습니까?**\n참가자 명단이 모두 사라지고 모집이 종료됩니다.',
      embeds: [], attachments: [],
      components: [confirmRow],
    });
    return;
  }

  // ── 내전 취소 확정 ────────────────────────────────────────
  if (customId.startsWith('naejeon:match_cancel_confirm:')) {
    const matchMsgId = customId.slice('naejeon:match_cancel_confirm:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update({ content: '⚠️ **이미 취소된 내전입니다.**', components: [] });
      return;
    }
    const cancelledEmbed = new EmbedBuilder()
      .setColor(0xED4245)
      .setDescription([
        titleHeader(match.data.game, match.data.gameInfo, match.data.title),
        `🎮 **게임**　　${match.data.gameInfo.name}`,
        `📅 **일시**　　${match.data.datetime}`,
        `👑 **주최자**　**\`${match.data.organizer.displayName}\`**`,
        `📊 **상태**　　🔴 취소됨`,
      ].join('\n'))
      .setFooter({ text: '❌ 주최자에 의해 내전이 취소되었습니다.' })
      .setTimestamp();

    await match.message.edit({ content: '', embeds: [cancelledEmbed], components: [], attachments: [], allowedMentions: { parse: [] } });
    getMatches(interaction.client).delete(matchMsgId);
    await deleteMentionMessage(interaction.client, match);
    scheduleCancelledDelete(interaction.client, matchMsgId, match.message.channelId);
    await interaction.update({ content: '✅ **내전이 취소되었습니다.**', components: [] });
    return;
  }

  // ── 참가자 추가 (주최자/관리자 전용) ─────────────────────────
  if (customId.startsWith('naejeon:add_member:')) {
    const matchMsgId = customId.slice('naejeon:add_member:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 내전입니다.**`, embeds: [], attachments: [], components: [] });
      return;
    }
    const sel = new UserSelectMenuBuilder()
      .setCustomId(`naejeon:member_add_select:${matchMsgId}`)
      .setPlaceholder('참가자 선택')
      .setMinValues(1)
      .setMaxValues(10);
    await interaction.update({
      content: '➕ **참가자 추가** - 추가할 멤버를 선택하세요.',
      embeds: [], attachments: [],
      components: [
        new ActionRowBuilder().addComponents(sel),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`naejeon:manage_back:${matchMsgId}`)
            .setLabel('↩️ 관리로')
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return;
  }

  // ── 참가자 제거 (주최자/관리자 전용) ─────────────────────────
  if (customId.startsWith('naejeon:remove_member:')) {
    const matchMsgId = customId.slice('naejeon:remove_member:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 내전입니다.**`, embeds: [], attachments: [], components: [] });
      return;
    }
    if (match.participants.length === 0) {
      await interaction.update({ content: '⚠️ **참가자가 없습니다.**', embeds: [], attachments: [], components: buildManageMenu(match, matchMsgId) });
      return;
    }
    const sel = new StringSelectMenuBuilder()
      .setCustomId(`naejeon:member_remove_select:${matchMsgId}`)
      .setPlaceholder('참가자 선택')
      .setMinValues(1)
      .setMaxValues(Math.min(match.participants.length, 25))
      .addOptions(match.participants.slice(0, 25).map(u => ({ label: u.displayName, value: u.id })));
    await interaction.update({
      content: '➖ **참가자 제거** - 제거할 멤버를 선택하세요.',
      embeds: [], attachments: [],
      components: [
        new ActionRowBuilder().addComponents(sel),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`naejeon:manage_back:${matchMsgId}`)
            .setLabel('↩️ 관리로')
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return;
  }

  // ── 8시간 후 자동 종료 토글 ───────────────────────────────
  if (customId === 'naejeon:toggle_autoclose') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.reply({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/내전\`을 실행해주세요.`, ephemeral: true });
      return;
    }
    data.autoClose = !data.autoClose;
    await interaction.update({
      content: '**미리보기** - 이 내용이 채널에 게시됩니다.',
      embeds: [buildPreviewEmbed(data)],
      components: buildPreviewComponents(data),
      attachments: [],
    });
    return;
  }

  // ── 스팀 멘션 토글 (직접 입력 전용) ──────────────────────────
  if (customId === 'naejeon:toggle_steam') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.reply({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/내전\`을 실행해주세요.`, ephemeral: true });
      return;
    }
    data.mentionSteam = !data.mentionSteam;
    await interaction.update({
      content: '**미리보기** - 이 내용이 채널에 게시됩니다.',
      embeds: [buildPreviewEmbed(data)],
      components: buildPreviewComponents(data),
      attachments: [],
    });
    return;
  }

  // ── 알림 예약 (게시 전 미리보기) ────────────────────────────────
  if (customId === 'naejeon:notify_set_preview') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.reply({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/내전\`을 실행해주세요.`, ephemeral: true });
      return;
    }
    await interaction.showModal(buildNotifyModal('preview', data.notifyAt));
    return;
  }

  // ── 수정 ───────────────────────────────────────────────────
  if (customId === 'naejeon:edit') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.reply({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/내전\`을 실행해주세요.`, ephemeral: true });
      return;
    }
    const editModal = buildModal(data.game, data);
    editModal.setCustomId(`naejeon:modal_edit:${data.game}`);
    await interaction.showModal(editModal);
    return;
  }

  // ── 취소 → 확인 탭 ────────────────────────────────────────
  if (customId === 'naejeon:cancel') {
    await interaction.update({
      content: '⚠️ **내전 생성을 취소하시겠습니까?**\n입력한 내용이 모두 사라집니다.',
      embeds: [], attachments: [],
      components: [buildCancelComponents()],
    });
    return;
  }

  // ── 취소 확인 ─────────────────────────────────────────────
  if (customId === 'naejeon:cancel_confirm') {
    getPending(interaction.client).delete(interaction.user.id);
    await interaction.update({ content: '❌ **내전 생성이 취소되었습니다.**', embeds: [], attachments: [], components: [] });
    return;
  }

  // ── 돌아가기 ──────────────────────────────────────────────
  if (customId === 'naejeon:cancel_back') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.update({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/내전\`을 실행해주세요.`, embeds: [], attachments: [], components: [] });
      return;
    }
    await interaction.update({
      content: '**미리보기** - 이 내용이 채널에 게시됩니다.',
      embeds: [buildPreviewEmbed(data)],
      components: buildPreviewComponents(data),
      attachments: [],
    });
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
    await interaction.reply({ content: `⚠️ **만료된 내전입니다.**`, ephemeral: true });
    return;
  }

  const title       = interaction.fields.getTextInputValue('title') || `${gameInfo.name} 내전`;
  const datetime    = interaction.fields.getTextInputValue('datetime');
  const players     = interaction.fields.getTextInputValue('players');
  const description = interaction.fields.getTextInputValue('description');

  if (isNaN(parseInt(players)) || parseInt(players) < 1) {
    await interaction.reply({ content: '⚠️ **모집 인원은 1 이상의 숫자만 입력해주세요.**', ephemeral: true });
    return;
  }

  match.data = { ...match.data, gameInfo, title, datetime, players, description };

  await match.message.edit(buildPublicMessagePayload(match));

  await interaction.reply({ content: '✅ **내전 정보가 수정되었습니다.**', ephemeral: true });
}

// customId: naejeon:notify_modal:{matchMsgId}. 비워서 제출하면 예약을 취소한다.
async function handleNaejeonNotifyModal(interaction) {
  const matchMsgId = interaction.customId.slice('naejeon:notify_modal:'.length);
  const raw = interaction.fields.getTextInputValue('notify_time').trim();

  // 게시 전 미리보기 단계: matchMsgId가 없으므로 유저 ID로 보관된 대기 데이터를 사용한다.
  if (matchMsgId === 'preview') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data || !data._previewInteraction) {
      await interaction.reply({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/내전\`을 실행해주세요.`, ephemeral: true });
      return;
    }
    if (raw) {
      const notifyAt = parseNotifyTime(raw);
      if (!notifyAt) {
        await interaction.reply({ content: '⚠️ **알림 시각 형식이 올바르지 않습니다.** (예: `6/5 20:00` 또는 `6/5 오후 8:00`)', ephemeral: true });
        return;
      }
      if (isNotifyTooFar(notifyAt)) {
        await interaction.reply({ content: '⚠️ **알림은 최대 24일 이내로만 예약할 수 있습니다.**', ephemeral: true });
        return;
      }
      data.notifyAt = notifyAt;
    } else {
      data.notifyAt = null;
    }
    await data._previewInteraction.editReply({
      content: '**미리보기** - 이 내용이 채널에 게시됩니다.',
      embeds: [buildPreviewEmbed(data)],
      components: buildPreviewComponents(data),
      attachments: [],
    });
    await interaction.deferReply({ ephemeral: true });
    await interaction.deleteReply();
    return;
  }

  const match = getMatches(interaction.client).get(matchMsgId);
  if (!match) {
    await interaction.reply({ content: `⚠️ **만료된 내전입니다.**`, ephemeral: true });
    return;
  }

  if (!raw) {
    match.data.notifyAt = null;
    match.notifySent = false;
    clearNotifyTimer(match);
    await interaction.reply({ content: '🔕 **알림 예약이 취소되었습니다.**', ephemeral: true });
    return;
  }

  const notifyAt = parseNotifyTime(raw);
  if (!notifyAt) {
    await interaction.reply({ content: '⚠️ **알림 시각 형식이 올바르지 않습니다.** (예: `6/5 20:00` 또는 `6/5 오후 8:00`)', ephemeral: true });
    return;
  }
  if (isNotifyTooFar(notifyAt)) {
    await interaction.reply({ content: '⚠️ **알림은 최대 24일 이내로만 예약할 수 있습니다.**', ephemeral: true });
    return;
  }

  match.data.notifyAt = notifyAt;
  match.notifySent = false;
  armNotifyReminder(getMatches(interaction.client), matchMsgId, match, '내전');
  await interaction.reply({
    content: `🔔 **${formatNotifyTime(notifyAt)} = ${formatNotifyTimeKorean(notifyAt)}(KST)에 마감 상태면 참가자에게 DM 알림을 보낼게요.**`,
    ephemeral: true,
  });
}

async function handleNaejeonMemberAdd(interaction) {
  const matchMsgId = interaction.customId.slice('naejeon:member_add_select:'.length);
  const match = getMatches(interaction.client).get(matchMsgId);
  if (!match) {
    await interaction.update({ content: `⚠️ **만료된 내전입니다.**`, embeds: [], attachments: [], components: [] });
    return;
  }
  const maxPlayers = parseInt(match.data.players) || 0;
  const newUserIds = interaction.values.filter(id => !match.participants.some(u => u.id === id));
  if (match.participants.length + newUserIds.length > maxPlayers) {
    await interaction.update({
      content: `⚠️ **참가자 초과로 추가할 수 없습니다.**\n(내전 수정을 통해 인원을 수정해주세요.)`,
      embeds: [], attachments: [],
      components: buildManageMenu(match, matchMsgId),
    });
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
  const lines = [];
  if (added.length > 0)   lines.push(`✅ 추가됨: ${added.map(n => `**${n}**`).join(', ')}`);
  if (skipped.length > 0) lines.push(`⚠️ 이미 참가 중: ${skipped.map(n => `**${n}**`).join(', ')}`);
  await interaction.update({ content: lines.join('\n') || '완료', embeds: [], attachments: [], components: buildManageMenu(match, matchMsgId) });
}

async function handleNaejeonMemberRemove(interaction) {
  const matchMsgId = interaction.customId.slice('naejeon:member_remove_select:'.length);
  const match = getMatches(interaction.client).get(matchMsgId);
  if (!match) {
    await interaction.update({ content: `⚠️ **만료된 내전입니다.**`, embeds: [], attachments: [], components: [] });
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
  await interaction.update({
    content: resultLines.join('\n'),
    embeds: [], attachments: [],
    components: buildManageMenu(match, matchMsgId),
  });
}

module.exports = { handleGameSelect, handleNaejeonModal, handleNaejeonEditModal, handleNaejeonButton, handleNaejeonMatchEditModal, handleNaejeonNotifyModal, handleTeamAssign, handleNaejeonMemberAdd, handleNaejeonMemberRemove, buildPublicMessagePayload };

const {
  ActionRowBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
} = require('discord.js');

const {
  ADMIN_IDS, titleHeader, markClosed, markReopened, toggleAutoCloseWhileClosed, announceMatchCompletionXp,
  ROLE_NAMES, buildPreviewEmbed, scheduleCancelledDelete, AUTO_CLOSE_DELAY_MS,
  buildModal: buildModalBase, buildLeaveButton: buildLeaveButtonBase, buildPreviewComponents: buildPreviewComponentsBase, buildCancelComponents: buildCancelComponentsBase,
  buildNotifyModal: buildNotifyModalBase, parseNotifyTime, formatNotifyTime, formatNotifyTimeKorean, armNotifyReminder, clearNotifyTimer, isNotifyTooFar,
} = require('./공용');

const GAMES = {
  lol:       { name: '리그 오브 레전드', emoji: '<:Lol:1510933684750913626>',    defaultPlayers: 5,   color: 0xC89B3C },
  valorant:  { name: '발로란트',         emoji: '<:Val:1510933698349109268>',    defaultPlayers: 5,   color: 0xFF4655 },
  overwatch: { name: '오버워치',         emoji: '<:Over:1510933569554612324>',   defaultPlayers: 5,   color: 0xF99E1A },
  pubg:      { name: '배틀그라운드',     emoji: '<:PUBG:1510933567646203964>',   defaultPlayers: 4,    color: 0xC8A96E },
  custom:    { name: '직접 입력',        emoji: '🎮',                            defaultPlayers: null, color: 0x5865F2 },
};

// ─── 빌더 헬퍼 ────────────────────────────────────────────────
// buildModal/buildLeaveButton/buildPreviewComponents/buildCancelComponents는
// naejeon.js와 로직이 완전히 동일해 shared.js로 옮기고, 여기서는 'mojip' 타입으로
// 고정해 호출하는 얇은 래퍼만 둔다(기존 함수 시그니처는 그대로 유지).

function buildModal(game, data = {}) {
  return buildModalBase('mojip', '모집', GAMES, game, data);
}

function buildNotifyModal(msgId, notifyAt) {
  return buildNotifyModalBase('mojip', msgId, notifyAt);
}

function buildPublicEmbed(data, participants, closed = false) {
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

  const participantText = participants.length > 0
    ? `\`\`\`\n${participants.map((u, i) => `${i + 1}. ${u.displayName}`).join('\n')}\n\`\`\``
    : '*아직 참가자가 없습니다.*';

  const embed = new EmbedBuilder()
    .setColor(color)
    .setDescription(`${titleHeader(game, gameInfo, title)}\n${lines.join('\n')}`);

  if (description) embed.addFields({ name: '📝 메모', value: description });

  return embed
    .addFields({ name: `👥 참가자  ${participants.length} / ${max}명`, value: participantText })
    .setFooter({ text: closed ? '🔒 마감된 모집입니다.' : isFull ? '✅ 모집이 완료되었습니다.' : '✅ 버튼을 눌러 참가하세요!' })
    .setTimestamp();
}

function buildPublicComponents(participants, maxPlayers, closed = false) {
  const buttons = [
    new ButtonBuilder()
      .setCustomId('mojip:join')
      .setLabel(closed ? '🔒 마감됨' : '✅ 참가하기')
      .setStyle(closed ? ButtonStyle.Primary : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('mojip:manage')
      .setLabel('⚙️ 관리')
      .setStyle(ButtonStyle.Secondary),
  ];
  return [new ActionRowBuilder().addComponents(...buttons)];
}

function buildMojipMessagePayload(match) {
  const maxPlayers = parseInt(match.data.players) || 0;
  return {
    embeds: [buildPublicEmbed(match.data, match.participants, match.closed)],
    components: buildPublicComponents(match.participants, maxPlayers, match.closed),
    allowedMentions: { parse: [] },
    attachments: [], // 예전 썸네일 기능 시절 붙었던 첨부파일이 남아있는 메시지를 정리
  };
}

function buildLeaveButton(msgId) {
  return buildLeaveButtonBase('mojip', msgId);
}

function buildPreviewComponents(data = null) {
  return buildPreviewComponentsBase('mojip', data);
}

function buildCancelComponents() {
  return buildCancelComponentsBase('mojip');
}

// 마감된 상태에서 자동 삭제 예정 시각(closedAt + 8시간)이 이미 지났는지 확인한다.
// autoClose가 꺼진 채로 마감돼 타이머가 안 걸린 매치는 시간이 아무리 지나도
// 저절로 안 없어지므로, 이 경우 ON/OFF 토글 대신 바로 "삭제" 버튼을 보여준다.
function isAutoDeleteExpired(match) {
  return !!(match.closed && match.closedAt && Date.now() - match.closedAt >= AUTO_CLOSE_DELAY_MS);
}

function buildAutoCloseToggleButton(match, msgId, label) {
  if (isAutoDeleteExpired(match)) {
    return new ButtonBuilder()
      .setCustomId(`mojip:toggle_match_autoclose:${msgId}`)
      .setEmoji('🗑️')
      .setLabel(`${label} 삭제`)
      .setStyle(ButtonStyle.Danger);
  }
  return new ButtonBuilder()
    .setCustomId(`mojip:toggle_match_autoclose:${msgId}`)
    .setEmoji('⏰')
    .setLabel(match.data.autoClose ? '자동 삭제: ON' : '자동 삭제: OFF')
    .setStyle(match.data.autoClose ? ButtonStyle.Success : ButtonStyle.Secondary);
}

// 마감 후에는 알림 예약을 더 바꿀 수 없도록 버튼을 비활성화한다(설정된 시각은 그대로 유지·표시).
function buildNotifyButton(match, msgId) {
  const notifyAt = match.data?.notifyAt;
  return new ButtonBuilder()
    .setCustomId(`mojip:notify_set:${msgId}`)
    .setLabel(notifyAt ? `🔔 알림 예약: ${formatNotifyTimeKorean(notifyAt)}` : '🔔 알림 예약')
    .setStyle(notifyAt ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setDisabled(!!match.closed);
}

function buildManageMenu(match, msgId) {
  const closed = match.closed;
  const hasParticipants = match.participants.length > 0;
  const addRemoveRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mojip:add_member:${msgId}`)
      .setLabel('➕ 참가자 추가')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`mojip:remove_member:${msgId}`)
      .setLabel('➖ 참가자 제거')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasParticipants),
  );
  if (closed) {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`mojip:match_mention:${msgId}`)
          .setLabel('📣 참가자 멘션')
          .setStyle(ButtonStyle.Success)
          .setDisabled(!!match.mentionSent),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`mojip:match_reopen:${msgId}`)
          .setLabel('🔓 마감 해제')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`mojip:match_edit:${msgId}`)
          .setLabel('✏️ 모집 수정')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`mojip:match_cancel:${msgId}`)
          .setLabel('❌ 모집 취소')
          .setStyle(ButtonStyle.Danger),
      ),
      new ActionRowBuilder().addComponents(buildAutoCloseToggleButton(match, msgId, '모집'), buildNotifyButton(match, msgId)),
      addRemoveRow,
    ];
  }
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`mojip:match_close:${msgId}`)
        .setLabel('🔒 마감하기')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`mojip:match_edit:${msgId}`)
        .setLabel('✏️ 모집 수정')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`mojip:match_cancel:${msgId}`)
        .setLabel('❌ 모집 취소')
        .setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(buildAutoCloseToggleButton(match, msgId, '모집'), buildNotifyButton(match, msgId)),
    addRemoveRow,
  ];
}

function getMojips(client) {
  if (!client.mojipMatches) client.mojipMatches = new Map();
  return client.mojipMatches;
}

function getPending(client) {
  if (!client.pendingMojip) client.pendingMojip = new Map();
  return client.pendingMojip;
}

// ─── 핸들러 ───────────────────────────────────────────────────

async function handleMojipGameSelect(interaction) {
  const game = interaction.values[0];
  await interaction.showModal(buildModal(game));
}

async function handleMojipModal(interaction) {
  const game        = interaction.customId.split(':')[2];
  const baseGameInfo = GAMES[game];
  const isCustom    = game === 'custom';
  const gameName    = isCustom ? interaction.fields.getTextInputValue('game_name') : null;
  const gameInfo    = gameName ? { ...baseGameInfo, name: gameName } : baseGameInfo;
  const title       = interaction.fields.getTextInputValue('title') || `${gameInfo.name} 모집`;
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

async function handleMojipEditModal(interaction) {
  const game        = interaction.customId.split(':')[2];
  const baseGameInfo = GAMES[game];
  const isCustom    = game === 'custom';
  const gameName    = isCustom ? interaction.fields.getTextInputValue('game_name') : null;
  const gameInfo    = gameName ? { ...baseGameInfo, name: gameName } : baseGameInfo;
  const title       = interaction.fields.getTextInputValue('title') || `${gameInfo.name} 모집`;
  const datetime    = interaction.fields.getTextInputValue('datetime');
  const players     = interaction.fields.getTextInputValue('players');
  const description = interaction.fields.getTextInputValue('description');

  if (isNaN(parseInt(players)) || parseInt(players) < 1) {
    await interaction.reply({ content: '⚠️ **모집 인원은 1 이상의 숫자만 입력해주세요.**', ephemeral: true });
    return;
  }

  const data = getPending(interaction.client).get(interaction.user.id);
  if (!data || !data._previewInteraction) {
    await interaction.reply({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/모집\`을 실행해주세요.`, ephemeral: true });
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

async function handleMojipButton(interaction) {
  const { customId } = interaction;

  // ── 공개 게시 ──────────────────────────────────────────────
  if (customId === 'mojip:publish') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.reply({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/모집\`을 실행해주세요.`, ephemeral: true });
      return;
    }
    const maxPlayers = parseInt(data.players) || 0;
    const participants = [];
    const roleName = ROLE_NAMES[data.game] || (data.mentionSteam ? '스팀' : null);
    const role = roleName && interaction.guild
      ? interaction.guild.roles.cache.find(r => r.name === roleName)
      : null;
    getPending(interaction.client).delete(interaction.user.id);
    const msg = await interaction.channel.send({
      content: role ? `<@&${role.id}>` : '',
      embeds: [buildPublicEmbed(data, participants)],
      components: buildPublicComponents(participants, maxPlayers),
      attachments: [],
      allowedMentions: { roles: role ? [role.id] : [], users: [] },
    });
    const match = { data, participants, message: msg, closed: false, closedAt: null, mentionSent: false, guildId: interaction.guildId };
    getMojips(interaction.client).set(msg.id, match);
    // 게시 전 미리보기 단계에서 이미 알림 예약을 해뒀다면, 그때는 매치가 없어 타이머를 못 걸었으므로 지금 건다.
    if (data.notifyAt) armNotifyReminder(getMojips(interaction.client), msg.id, match, '모집');
    await interaction.update({ content: '✅ **채널에 공개 게시되었습니다!**', embeds: [], attachments: [], components: [] });
    return;
  }

  // ── 참가하기 ───────────────────────────────────────────────
  if (customId === 'mojip:join') {
    const match = getMojips(interaction.client).get(interaction.message.id);
    if (!match) {
      await interaction.reply({ content: `⚠️ **만료된 모집입니다.**`, ephemeral: true });
      return;
    }
    if (match.closed) {
      const inMatch = match.participants.some(u => u.id === interaction.user.id);
      if (!inMatch) {
        await interaction.reply({ content: '🔒 **이미 마감된 모집입니다.**', ephemeral: true });
        return;
      }
      await interaction.reply({
        content: '**⚠️ 마감된 모집입니다.**\n취소하려면 아래 버튼을 눌러주세요.',
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
    if (match.participants.length >= maxPlayers) markClosed(getMojips(interaction.client), interaction.message.id, match, '모집');
    await interaction.deferUpdate();
    await match.message.edit({
      embeds: [buildPublicEmbed(match.data, match.participants, match.closed)],
      components: buildPublicComponents(match.participants, maxPlayers, match.closed),
      attachments: [],
    });
    if (match.closed) await announceMatchCompletionXp(match);
    await interaction.followUp({
      content: '✅ **참가 완료!** 명단에 등록되었습니다.\n취소하려면 아래 버튼을 눌러주세요.',
      components: [buildLeaveButton(interaction.message.id)],
      ephemeral: true,
    });
    return;
  }

  // ── 참가 취소 (에페메럴 버튼) ────────────────────────────
  if (customId.startsWith('mojip:leave:')) {
    const msgId = customId.slice('mojip:leave:'.length);
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 모집입니다.**`, components: [] });
      return;
    }
    const idx = match.participants.findIndex(u => u.id === interaction.user.id);
    if (idx === -1) {
      await interaction.update({ content: '⚠️ **이미 참가 취소된 상태입니다.**', components: [] });
      return;
    }
    match.participants.splice(idx, 1);
    const maxPlayers = parseInt(match.data.players) || 0;
    const reopened = match.closed && match.participants.length < maxPlayers;
    if (reopened) markReopened(match);
    await match.message.edit({
      embeds: [buildPublicEmbed(match.data, match.participants, match.closed)],
      components: buildPublicComponents(match.participants, maxPlayers, match.closed),
      attachments: [],
    });
    await interaction.update({ content: '❌ **참가가 취소되었습니다.**', components: [] });
    return;
  }

  // ── 주최자 관리 메뉴 ──────────────────────────────────────────
  if (customId === 'mojip:manage') {
    const msgId = interaction.message.id;
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.reply({ content: `⚠️ **만료된 모집입니다.**`, ephemeral: true });
      return;
    }
    if (match.data.organizer.id !== interaction.user.id && !ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ **주최자만 사용할 수 있습니다.**', ephemeral: true });
      return;
    }
    await interaction.reply({
      content: '⚙️ **주최자 관리 메뉴**',
      components: buildManageMenu(match, msgId),
      ephemeral: true,
    });
    return;
  }

  // ── 마감하기 ──────────────────────────────────────────────────
  if (customId.startsWith('mojip:match_close:')) {
    const msgId = customId.slice('mojip:match_close:'.length);
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 모집입니다.**`, components: [] });
      return;
    }
    const maxPlayers = parseInt(match.data.players) || 0;
    if (match.participants.length < maxPlayers) {
      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`mojip:match_close_confirm:${msgId}`)
          .setLabel('✅ 마감 확정')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`mojip:manage_back:${msgId}`)
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
    markClosed(getMojips(interaction.client), msgId, match, '모집', false);
    await match.message.edit({
      embeds: [buildPublicEmbed(match.data, match.participants, true)],
      components: buildPublicComponents(match.participants, maxPlayers, true),
      attachments: [],
    });
    await announceMatchCompletionXp(match);
    await interaction.update({
      content: '✅ **모집이 마감되었습니다.**',
      components: buildManageMenu(match, msgId),
    });
    return;
  }

  // ── 마감 확정 (미달 확인 후) ──────────────────────────────────
  if (customId.startsWith('mojip:match_close_confirm:')) {
    const msgId = customId.slice('mojip:match_close_confirm:'.length);
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 모집입니다.**`, components: [] });
      return;
    }
    markClosed(getMojips(interaction.client), msgId, match, '모집', false);
    const maxPlayers = parseInt(match.data.players) || 0;
    await match.message.edit({
      embeds: [buildPublicEmbed(match.data, match.participants, true)],
      components: buildPublicComponents(match.participants, maxPlayers, true),
      attachments: [],
    });
    await announceMatchCompletionXp(match);
    await interaction.update({
      content: '✅ **모집이 마감되었습니다.**',
      components: buildManageMenu(match, msgId),
    });
    return;
  }

  // ── 마감 해제 ──────────────────────────────────────────────────
  if (customId.startsWith('mojip:match_reopen:')) {
    const msgId = customId.slice('mojip:match_reopen:'.length);
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 모집입니다.**`, components: [] });
      return;
    }
    markReopened(match);
    const maxPlayers = parseInt(match.data.players) || 0;
    await match.message.edit({
      embeds: [buildPublicEmbed(match.data, match.participants, false)],
      components: buildPublicComponents(match.participants, maxPlayers, false),
      attachments: [],
    });
    await interaction.update({
      content: '🔓 **모집 마감이 해제되었습니다.**',
      components: buildManageMenu(match, msgId),
    });
    return;
  }

  // ── 자동 삭제 ON/OFF 토글 (마감 후 자동 삭제 시각이 지났다면 즉시 삭제) ──
  if (customId.startsWith('mojip:toggle_match_autoclose:')) {
    const msgId = customId.slice('mojip:toggle_match_autoclose:'.length);
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 모집입니다.**`, components: [] });
      return;
    }
    const enabled = isAutoDeleteExpired(match) ? true : !match.data.autoClose;
    await toggleAutoCloseWhileClosed(getMojips(interaction.client), msgId, match, '모집', enabled);
    if (!getMojips(interaction.client).has(msgId)) {
      await interaction.update({ content: '✅ **자동 삭제 시간이 지나 모집이 삭제되었습니다.**', components: [] });
      return;
    }
    await interaction.update({
      content: `⏰ **자동 삭제가 ${match.data.autoClose ? 'ON' : 'OFF'}으로 변경되었습니다.**`,
      components: buildManageMenu(match, msgId),
    });
    return;
  }

  // ── 참가자 멘션 (주최자 전용, 1회) ──────────────────────────────
  if (customId.startsWith('mojip:match_mention:')) {
    const msgId = customId.slice('mojip:match_mention:'.length);
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 모집입니다.**`, components: [] });
      return;
    }
    if (match.data.organizer.id !== interaction.user.id && !ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ **주최자만 사용할 수 있습니다.**', ephemeral: true });
      return;
    }
    if (!match.closed) {
      await interaction.update({ content: '⚠️ **마감된 모집에서만 사용할 수 있습니다.**', components: buildManageMenu(match, msgId) });
      return;
    }
    if (match.mentionSent) {
      await interaction.update({ content: '⚠️ **이미 멘션을 보냈습니다.**', components: buildManageMenu(match, msgId) });
      return;
    }
    if (match.participants.length === 0) {
      await interaction.update({ content: '⚠️ **참가자가 없습니다.**', components: buildManageMenu(match, msgId) });
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
      components: buildManageMenu(match, msgId),
    });
    return;
  }

  // ── 관리 메뉴로 돌아가기 ──────────────────────────────────────
  if (customId.startsWith('mojip:manage_back:')) {
    const msgId = customId.slice('mojip:manage_back:'.length);
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 모집입니다.**`, embeds: [], attachments: [], components: [] });
      return;
    }
    await interaction.update({
      content: '⚙️ **주최자 관리 메뉴**',
      embeds: [], attachments: [],
      components: buildManageMenu(match, msgId),
    });
    return;
  }

  // ── 알림 예약 (주최자 전용) ────────────────────────────────────
  if (customId.startsWith('mojip:notify_set:')) {
    const msgId = customId.slice('mojip:notify_set:'.length);
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 모집입니다.**`, components: [] });
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
    await interaction.showModal(buildNotifyModal(msgId, match.data.notifyAt));
    return;
  }

  // ── 모집 수정 ────────────────────────────────────────────────
  if (customId.startsWith('mojip:match_edit:')) {
    const msgId = customId.slice('mojip:match_edit:'.length);
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.update({ content: `**⚠️ 만료된 모집입니다.**`, components: [] });
      return;
    }
    const editModal = buildModal(match.data.game, match.data);
    editModal.setCustomId(`mojip:match_edit_modal:${match.data.game}:${msgId}`);
    await interaction.showModal(editModal);
    return;
  }

  // ── 모집 취소 요청 ────────────────────────────────────────────
  if (customId.startsWith('mojip:match_cancel:')) {
    const msgId = customId.slice('mojip:match_cancel:'.length);
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 모집입니다.**`, components: [] });
      return;
    }
    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`mojip:match_cancel_confirm:${msgId}`)
        .setLabel('✅ 확인')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`mojip:manage_back:${msgId}`)
        .setLabel('↩️ 돌아가기')
        .setStyle(ButtonStyle.Secondary),
    );
    await interaction.update({
      content: '⚠️ **모집을 취소하시겠습니까?**\n참가자 명단이 모두 사라지고 모집이 종료됩니다.',
      embeds: [], attachments: [],
      components: [confirmRow],
    });
    return;
  }

  // ── 모집 취소 확정 ────────────────────────────────────────────
  if (customId.startsWith('mojip:match_cancel_confirm:')) {
    const msgId = customId.slice('mojip:match_cancel_confirm:'.length);
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.update({ content: '⚠️ **이미 취소된 모집입니다.**', components: [] });
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
      .setFooter({ text: '❌ 주최자에 의해 모집이 취소되었습니다.' })
      .setTimestamp();

    await match.message.edit({ content: '', embeds: [cancelledEmbed], components: [], attachments: [], allowedMentions: { parse: [] } });
    getMojips(interaction.client).delete(msgId);
    scheduleCancelledDelete(interaction.client, msgId, match.message.channelId);
    await interaction.update({ content: '✅ **모집이 취소되었습니다.**', components: [] });
    return;
  }

  // ── 참가자 추가 (주최자/관리자 전용) ─────────────────────────
  if (customId.startsWith('mojip:add_member:')) {
    const msgId = customId.slice('mojip:add_member:'.length);
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 모집입니다.**`, embeds: [], attachments: [], components: [] });
      return;
    }
    const sel = new UserSelectMenuBuilder()
      .setCustomId(`mojip:member_add_select:${msgId}`)
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

            .setCustomId(`mojip:manage_back:${msgId}`)
            .setLabel('↩️ 관리로')
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return;
  }

  // ── 참가자 제거 (주최자/관리자 전용) ─────────────────────────
  if (customId.startsWith('mojip:remove_member:')) {
    const msgId = customId.slice('mojip:remove_member:'.length);
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 모집입니다.**`, embeds: [], attachments: [], components: [] });
      return;
    }
    if (match.participants.length === 0) {
      await interaction.update({ content: '⚠️ **참가자가 없습니다.**', embeds: [], attachments: [], components: buildManageMenu(match, msgId) });
      return;
    }
    const sel = new StringSelectMenuBuilder()
      .setCustomId(`mojip:member_remove_select:${msgId}`)
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
            .setCustomId(`mojip:manage_back:${msgId}`)
            .setLabel('↩️ 관리로')
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return;
  }

  // ── 8시간 후 자동 종료 토글 ───────────────────────────────
  if (customId === 'mojip:toggle_autoclose') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.reply({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/모집\`을 실행해주세요.`, ephemeral: true });
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
  if (customId === 'mojip:toggle_steam') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.reply({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/모집\`을 실행해주세요.`, ephemeral: true });
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
  if (customId === 'mojip:notify_set_preview') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.reply({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/모집\`을 실행해주세요.`, ephemeral: true });
      return;
    }
    await interaction.showModal(buildNotifyModal('preview', data.notifyAt));
    return;
  }

  // ── 수정 (미리보기) ────────────────────────────────────────────
  if (customId === 'mojip:edit') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.reply({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/모집\`을 실행해주세요.`, ephemeral: true });
      return;
    }
    const editModal = buildModal(data.game, data);
    editModal.setCustomId(`mojip:modal_edit:${data.game}`);
    await interaction.showModal(editModal);
    return;
  }

  // ── 취소 → 확인 탭 ────────────────────────────────────────────
  if (customId === 'mojip:cancel') {
    await interaction.update({
      content: '⚠️ **모집 생성을 취소하시겠습니까?**\n입력한 내용이 모두 사라집니다.',
      embeds: [], attachments: [],
      components: [buildCancelComponents()],
    });
    return;
  }

  // ── 취소 확인 ─────────────────────────────────────────────────
  if (customId === 'mojip:cancel_confirm') {
    getPending(interaction.client).delete(interaction.user.id);
    await interaction.update({ content: '❌ **모집 생성이 취소되었습니다.**', embeds: [], attachments: [], components: [] });
    return;
  }

  // ── 돌아가기 ──────────────────────────────────────────────────
  if (customId === 'mojip:cancel_back') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.update({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/모집\`을 실행해주세요.`, embeds: [], attachments: [], components: [] });
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

async function handleMojipMatchEditModal(interaction) {
  // customId: mojip:match_edit_modal:{game}:{msgId}
  const parts      = interaction.customId.split(':');
  const game       = parts[2];
  const msgId      = parts[3];
  const baseGameInfo = GAMES[game];
  const isCustom   = game === 'custom';
  const gameName   = isCustom ? interaction.fields.getTextInputValue('game_name') : null;
  const gameInfo   = gameName ? { ...baseGameInfo, name: gameName } : baseGameInfo;

  const match = getMojips(interaction.client).get(msgId);
  if (!match) {
    await interaction.reply({ content: `⚠️ **만료된 모집입니다.**`, ephemeral: true });
    return;
  }

  const title       = interaction.fields.getTextInputValue('title') || `${gameInfo.name} 모집`;
  const datetime    = interaction.fields.getTextInputValue('datetime');
  const players     = interaction.fields.getTextInputValue('players');
  const description = interaction.fields.getTextInputValue('description');

  if (isNaN(parseInt(players)) || parseInt(players) < 1) {
    await interaction.reply({ content: '⚠️ **모집 인원은 1 이상의 숫자만 입력해주세요.**', ephemeral: true });
    return;
  }

  match.data = { ...match.data, gameInfo, title, datetime, players, description };
  const maxPlayers = parseInt(players) || 0;

  await match.message.edit({
    embeds: [buildPublicEmbed(match.data, match.participants, match.closed)],
    components: buildPublicComponents(match.participants, maxPlayers, match.closed),
    attachments: [],
  });

  await interaction.reply({ content: '✅ **모집 정보가 수정되었습니다.**', ephemeral: true });
}

// customId: mojip:notify_modal:{msgId}. 비워서 제출하면 예약을 취소한다.
async function handleMojipNotifyModal(interaction) {
  const msgId = interaction.customId.slice('mojip:notify_modal:'.length);
  const raw = interaction.fields.getTextInputValue('notify_time').trim();

  // 게시 전 미리보기 단계: msgId가 없으므로 유저 ID로 보관된 대기 데이터를 사용한다.
  if (msgId === 'preview') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data || !data._previewInteraction) {
      await interaction.reply({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/모집\`을 실행해주세요.`, ephemeral: true });
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

  const match = getMojips(interaction.client).get(msgId);
  if (!match) {
    await interaction.reply({ content: `⚠️ **만료된 모집입니다.**`, ephemeral: true });
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
  armNotifyReminder(getMojips(interaction.client), msgId, match, '모집');
  await interaction.reply({
    content: `🔔 **${formatNotifyTime(notifyAt)} = ${formatNotifyTimeKorean(notifyAt)}(KST)에 마감 상태면 참가자에게 DM 알림을 보낼게요.**`,
    ephemeral: true,
  });
}

async function handleMojipMemberAdd(interaction) {
  const msgId = interaction.customId.slice('mojip:member_add_select:'.length);
  const match = getMojips(interaction.client).get(msgId);
  if (!match) {
    await interaction.update({ content: `⚠️ **만료된 모집입니다.**`, embeds: [], attachments: [], components: [] });
    return;
  }
  const maxPlayers = parseInt(match.data.players) || 0;
  const newUserIds = interaction.values.filter(id => !match.participants.some(u => u.id === id));
  if (match.participants.length + newUserIds.length > maxPlayers) {
    await interaction.update({
      content: `⚠️ **참가자 초과로 추가할 수 없습니다.**\n(모집 수정을 통해 인원을 수정해주세요.)`,
      embeds: [], attachments: [],
      components: buildManageMenu(match, msgId),
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
  if (justClosed) markClosed(getMojips(interaction.client), msgId, match, '모집');
  await match.message.edit({
    embeds: [buildPublicEmbed(match.data, match.participants, match.closed)],
    components: buildPublicComponents(match.participants, maxPlayers, match.closed),
    attachments: [],
  });
  if (justClosed) await announceMatchCompletionXp(match);
  const lines = [];
  if (added.length > 0)   lines.push(`✅ 추가됨: ${added.map(n => `**${n}**`).join(', ')}`);
  if (skipped.length > 0) lines.push(`⚠️ 이미 참가 중: ${skipped.map(n => `**${n}**`).join(', ')}`);
  await interaction.update({ content: lines.join('\n') || '완료', embeds: [], attachments: [], components: buildManageMenu(match, msgId) });
}

async function handleMojipMemberRemove(interaction) {
  const msgId = interaction.customId.slice('mojip:member_remove_select:'.length);
  const match = getMojips(interaction.client).get(msgId);
  if (!match) {
    await interaction.update({ content: `⚠️ **만료된 모집입니다.**`, embeds: [], attachments: [], components: [] });
    return;
  }
  const removeIds = new Set(interaction.values);
  const removed = match.participants.filter(u => removeIds.has(u.id)).map(u => u.displayName);
  match.participants = match.participants.filter(u => !removeIds.has(u.id));
  const maxPlayers = parseInt(match.data.players) || 0;
  const reopened = match.closed && match.participants.length < maxPlayers;
  if (reopened) markReopened(match);
  await match.message.edit({
    embeds: [buildPublicEmbed(match.data, match.participants, match.closed)],
    components: buildPublicComponents(match.participants, maxPlayers, match.closed),
    attachments: [],
  });
  const resultLines = [`➖ 제거됨: ${removed.map(n => `**${n}**`).join(', ')}`];
  if (reopened) resultLines.push('🔓 **참가자 미달로 마감이 자동 해제되었습니다.**');
  await interaction.update({
    content: resultLines.join('\n'),
    embeds: [], attachments: [],
    components: buildManageMenu(match, msgId),
  });
}

module.exports = { handleMojipGameSelect, handleMojipModal, handleMojipEditModal, handleMojipButton, handleMojipMatchEditModal, handleMojipNotifyModal, handleMojipMemberAdd, handleMojipMemberRemove, buildMojipMessagePayload };

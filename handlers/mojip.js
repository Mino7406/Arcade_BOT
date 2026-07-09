const {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
} = require('discord.js');

const { ADMIN_IDS, getResetDateStr: getResetDateStrBase, applyThumbnail, getThumbnailFiles } = require('./shared');

const GAMES = {
  lol:       { name: '리그 오브 레전드', emoji: '<:Lol:1510933684750913626>',    defaultPlayers: 5,   color: 0xC89B3C },
  valorant:  { name: '발로란트',         emoji: '<:Val:1510933698349109268>',    defaultPlayers: 5,   color: 0xFF4655 },
  overwatch: { name: '오버워치',         emoji: '<:Over:1510933569554612324>',   defaultPlayers: 5,   color: 0xF99E1A },
  pubg:      { name: '배틀그라운드',     emoji: '<:PUBG:1510933567646203964>',   defaultPlayers: 4,    color: 0xC8A96E },
  custom:    { name: '직접 입력',        emoji: '🎮',                            defaultPlayers: null, color: 0x5865F2 },
};

const ROLE_NAMES = {
  lol: '롤', valorant: '발로란트', overwatch: '오버워치', pubg: '배그',
};

// ─── 빌더 헬퍼 ────────────────────────────────────────────────

function buildModal(game, data = {}) {
  const gameInfo = GAMES[game];
  const isCustom = game === 'custom';

  const modal = new ModalBuilder()
    .setCustomId(`mojip:modal:${game}`)
    .setTitle(`${gameInfo.emoji} ${gameInfo.name} 모집 생성`);

  const titleInput = new TextInputBuilder()
    .setCustomId('title')
    .setLabel('제목 (비워두면 기본값 사용)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(isCustom ? '모집 제목을 입력하세요 (선택사항)' : `${gameInfo.name} 모집`)
    .setRequired(false)
    .setMaxLength(50);

  const datetimeInput = new TextInputBuilder()
    .setCustomId('datetime')
    .setLabel('일시')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('예: 6월 5일 오후 8시')
    .setRequired(true)
    .setMaxLength(50);

  const playersInput = new TextInputBuilder()
    .setCustomId('players')
    .setLabel('모집 인원 (숫자만 입력)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('예: 10')
    .setRequired(true)
    .setMaxLength(10);

  const descInput = new TextInputBuilder()
    .setCustomId('description')
    .setLabel('메모 / 설명 (선택사항)')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('추가 안내사항이 있으면 입력하세요.')
    .setRequired(false)
    .setMaxLength(300);

  if (data.title)       titleInput.setValue(data.title);
  if (data.datetime)    datetimeInput.setValue(data.datetime);
  if (data.players)     playersInput.setValue(data.players);
  else if (gameInfo.defaultPlayers) playersInput.setValue(String(gameInfo.defaultPlayers));
  if (data.description) descInput.setValue(data.description);

  if (isCustom) {
    const gameNameInput = new TextInputBuilder()
      .setCustomId('game_name')
      .setLabel('게임 이름')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('예: 마인크래프트, 철권 8 ...')
      .setRequired(true)
      .setMaxLength(50);
    if (data.gameInfo && data.gameInfo.name !== '직접 입력') {
      gameNameInput.setValue(data.gameInfo.name);
    }
    modal.addComponents(
      new ActionRowBuilder().addComponents(gameNameInput),
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(datetimeInput),
      new ActionRowBuilder().addComponents(playersInput),
      new ActionRowBuilder().addComponents(descInput),
    );
  } else {
    modal.addComponents(
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(datetimeInput),
      new ActionRowBuilder().addComponents(playersInput),
      new ActionRowBuilder().addComponents(descInput),
    );
  }

  return modal;
}

function buildPreviewEmbed({ game, gameInfo, title, datetime, players, description, organizer }) {
  const max = parseInt(players) || 0;

  const lines = [
    `🎮 **게임**　　${gameInfo.name}`,
    `📅 **일시**　　${datetime}`,
    `👑 **주최자**　**\`${organizer.displayName}\`**`,
    `📊 **상태**　　⏳ 게시 전`,
  ];

  const embed = new EmbedBuilder()
    .setColor(gameInfo.color)
    .setDescription(`# ${title}\n${lines.join('\n')}`);
  applyThumbnail(embed, game);

  if (description) embed.addFields({ name: '📝 메모', value: description });

  return embed
    .addFields({ name: `👥 참가자  0 / ${max}명`, value: '*아직 참가자가 없습니다.*' })
    .setFooter({ text: '🔎 게시하기 전에 내용을 다시 확인해 주세요.' })
    .setTimestamp();
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
    .setDescription(`# ${title}\n${lines.join('\n')}`);
  applyThumbnail(embed, game);

  if (description) embed.addFields({ name: '📝 메모', value: description });

  return embed
    .addFields({ name: `👥 참가자  ${participants.length} / ${max}명`, value: participantText })
    .setFooter({ text: closed ? '🔒 마감된 모집입니다.' : isFull ? '✅ 모집이 완료되었습니다.' : '✅ 버튼을 눌러 참가하세요!' })
    .setTimestamp();
}

function buildPublicComponents(participants, maxPlayers, closed = false) {
  const isFull = participants.length >= maxPlayers;
  const joinDisabled = closed || isFull;
  const buttons = [
    new ButtonBuilder()
      .setCustomId('mojip:join')
      .setLabel(closed ? '🔒 마감됨' : (isFull ? '🔒 모집 완료' : '✅ 참가하기'))
      .setStyle(joinDisabled ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setDisabled(joinDisabled),
  ];
  if (closed) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId('mojip:leave_request')
        .setLabel('🚪 나가기')
        .setStyle(ButtonStyle.Danger),
    );
  }
  buttons.push(
    new ButtonBuilder()
      .setCustomId('mojip:manage')
      .setLabel('⚙️ 관리')
      .setStyle(ButtonStyle.Secondary),
  );
  return [new ActionRowBuilder().addComponents(...buttons)];
}

function buildMojipMessagePayload(match) {
  const maxPlayers = parseInt(match.data.players) || 0;
  return {
    embeds: [buildPublicEmbed(match.data, match.participants, match.closed)],
    components: buildPublicComponents(match.participants, maxPlayers, match.closed),
    allowedMentions: { parse: [] },
    files: getThumbnailFiles(match.data.game),
  };
}

function buildLeaveButton(msgId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mojip:leave:${msgId}`)
      .setLabel('❌ 참가 취소')
      .setStyle(ButtonStyle.Danger),
  );
}

function buildPreviewComponents(data = null) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mojip:publish').setLabel('📢 채널에 공개 게시').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('mojip:edit').setLabel('✏️ 수정').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mojip:cancel').setLabel('❌ 취소').setStyle(ButtonStyle.Danger),
  );
  if (data && data.game === 'custom') {
    const steamToggle = new ButtonBuilder()
      .setCustomId('mojip:toggle_steam')
      .setEmoji({ id: '1510954746012242021', name: 'Steam' })
      .setLabel(data.mentionSteam ? '멘션 ON' : '멘션 OFF')
      .setStyle(data.mentionSteam ? ButtonStyle.Success : ButtonStyle.Secondary);
    return [row1, new ActionRowBuilder().addComponents(steamToggle)];
  }
  return [row1];
}

function buildCancelComponents() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mojip:cancel_confirm').setLabel('✅ 확인').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('mojip:cancel_back').setLabel('↩️ 돌아가기').setStyle(ButtonStyle.Secondary),
  );
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
    addRemoveRow,
  ];
}

function getResetDateStr(client) {
  return getResetDateStrBase(client, '모집');
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

  const data = { game, gameInfo, title, datetime, players, description, organizer: { id: interaction.user.id, displayName: interaction.member?.displayName || interaction.user.globalName || interaction.user.username }, _previewInteraction: interaction };
  getPending(interaction.client).set(interaction.user.id, data);

  await interaction.reply({
    content: '**미리보기** - 이 내용이 채널에 게시됩니다.',
    embeds: [buildPreviewEmbed(data)],
    components: buildPreviewComponents(data),
    files: getThumbnailFiles(data.game),
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
    await interaction.reply({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/모집\`을 실행해주세요. (${getResetDateStr(interaction.client)})`, ephemeral: true });
    return;
  }

  Object.assign(data, { gameInfo, title, datetime, players, description });

  await data._previewInteraction.editReply({
    content: '**미리보기** - 이 내용이 채널에 게시됩니다.',
    embeds: [buildPreviewEmbed(data)],
    components: buildPreviewComponents(data),
    files: getThumbnailFiles(data.game),
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
      await interaction.reply({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/모집\`을 실행해주세요. (${getResetDateStr(interaction.client)})`, ephemeral: true });
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
      files: getThumbnailFiles(data.game),
      allowedMentions: { roles: role ? [role.id] : [], users: [] },
    });
    getMojips(interaction.client).set(msg.id, { data, participants, message: msg, closed: false, mentionSent: false, guildId: interaction.guildId });
    await interaction.update({ content: '✅ **채널에 공개 게시되었습니다!**', embeds: [], attachments: [], components: [] });
    return;
  }

  // ── 참가하기 ───────────────────────────────────────────────
  if (customId === 'mojip:join') {
    const match = getMojips(interaction.client).get(interaction.message.id);
    if (!match) {
      await interaction.reply({ content: `⚠️ **만료된 모집입니다.**\n(${getResetDateStr(interaction.client)})`, ephemeral: true });
      return;
    }
    if (match.closed) {
      await interaction.reply({ content: '❌ **이미 마감된 모집입니다.**', ephemeral: true });
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
    if (match.participants.length >= maxPlayers) match.closed = true;
    await interaction.deferUpdate();
    await match.message.edit({
      embeds: [buildPublicEmbed(match.data, match.participants, match.closed)],
      components: buildPublicComponents(match.participants, maxPlayers, match.closed),
    });
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
      await interaction.update({ content: `⚠️ **만료된 모집입니다.**\n(${getResetDateStr(interaction.client)})`, components: [] });
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
    if (reopened) match.closed = false;
    await match.message.edit({
      embeds: [buildPublicEmbed(match.data, match.participants, match.closed)],
      components: buildPublicComponents(match.participants, maxPlayers, match.closed),
    });
    await interaction.update({ content: '❌ **참가가 취소되었습니다.**', components: [] });
    return;
  }

  // ── 마감 후 참가 취소 요청 (공개 임베드) ──────────────────────
  if (customId === 'mojip:leave_request') {
    const msgId = interaction.message.id;
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.reply({ content: `⚠️ **만료된 모집입니다.**\n(${getResetDateStr(interaction.client)})`, ephemeral: true });
      return;
    }
    const inMatch = match.participants.some(u => u.id === interaction.user.id);
    if (!inMatch) {
      await interaction.reply({ content: '⚠️ **참가자가 아닙니다.**', ephemeral: true });
      return;
    }
    await interaction.reply({
      content: '⚠️ **정말 모집에서 나가시겠습니까?**\n모집이 마감된 상태입니다. 취소 후에는 다시 참가할 수 없습니다.',
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`mojip:leave_do:${msgId}`)
          .setLabel('✅ 확인')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('mojip:leave_back')
          .setLabel('↩️ 돌아가기')
          .setStyle(ButtonStyle.Secondary),
      )],
      ephemeral: true,
    });
    return;
  }

  // ── 마감 후 참가 취소 확정 ────────────────────────────────────
  if (customId.startsWith('mojip:leave_do:')) {
    const msgId = customId.slice('mojip:leave_do:'.length);
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 모집입니다.**\n(${getResetDateStr(interaction.client)})`, components: [] });
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
    if (reopened) match.closed = false;
    await match.message.edit({
      embeds: [buildPublicEmbed(match.data, match.participants, match.closed)],
      components: buildPublicComponents(match.participants, maxPlayers, match.closed),
    });
    await interaction.update({ content: '🚪 **모집에서 이탈하였습니다.**', components: [] });
    return;
  }

  // ── 마감 후 참가 취소 돌아가기 ───────────────────────────────
  if (customId === 'mojip:leave_back') {
    await interaction.deferUpdate();
    await interaction.deleteReply();
    return;
  }

  // ── 주최자 관리 메뉴 ──────────────────────────────────────────
  if (customId === 'mojip:manage') {
    const msgId = interaction.message.id;
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.reply({ content: `⚠️ **만료된 모집입니다.**\n(${getResetDateStr(interaction.client)})`, ephemeral: true });
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
      await interaction.update({ content: `⚠️ **만료된 모집입니다.**\n(${getResetDateStr(interaction.client)})`, components: [] });
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
    match.closed = true;
    await match.message.edit({
      embeds: [buildPublicEmbed(match.data, match.participants, true)],
      components: buildPublicComponents(match.participants, maxPlayers, true),
    });
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
      await interaction.update({ content: `⚠️ **만료된 모집입니다.**\n(${getResetDateStr(interaction.client)})`, components: [] });
      return;
    }
    match.closed = true;
    const maxPlayers = parseInt(match.data.players) || 0;
    await match.message.edit({
      embeds: [buildPublicEmbed(match.data, match.participants, true)],
      components: buildPublicComponents(match.participants, maxPlayers, true),
    });
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
      await interaction.update({ content: `⚠️ **만료된 모집입니다.**\n(${getResetDateStr(interaction.client)})`, components: [] });
      return;
    }
    match.closed = false;
    const maxPlayers = parseInt(match.data.players) || 0;
    await match.message.edit({
      embeds: [buildPublicEmbed(match.data, match.participants, false)],
      components: buildPublicComponents(match.participants, maxPlayers, false),
    });
    await interaction.update({
      content: '🔓 **모집 마감이 해제되었습니다.**',
      components: buildManageMenu(match, msgId),
    });
    return;
  }

  // ── 참가자 멘션 (주최자 전용, 1회) ──────────────────────────────
  if (customId.startsWith('mojip:match_mention:')) {
    const msgId = customId.slice('mojip:match_mention:'.length);
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 모집입니다.**\n(${getResetDateStr(interaction.client)})`, components: [] });
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
    await interaction.channel.send({
      content: `📣 **${match.data.title}**\n${mentionText}`,
      allowedMentions: { parse: ['users'] },
    });
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
      await interaction.update({ content: `⚠️ **만료된 모집입니다.**\n(${getResetDateStr(interaction.client)})`, embeds: [], attachments: [], components: [] });
      return;
    }
    await interaction.update({
      content: '⚙️ **주최자 관리 메뉴**',
      embeds: [], attachments: [],
      components: buildManageMenu(match, msgId),
    });
    return;
  }

  // ── 모집 수정 ────────────────────────────────────────────────
  if (customId.startsWith('mojip:match_edit:')) {
    const msgId = customId.slice('mojip:match_edit:'.length);
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.update({ content: `**⚠️ 만료된 모집입니다.**\n(${getResetDateStr(interaction.client)})`, components: [] });
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
      await interaction.update({ content: `⚠️ **만료된 모집입니다.**\n(${getResetDateStr(interaction.client)})`, components: [] });
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
        `# ${match.data.title}`,
        `🎮 **게임**　　${match.data.gameInfo.name}`,
        `📅 **일시**　　${match.data.datetime}`,
        `👑 **주최자**　**\`${match.data.organizer.displayName}\`**`,
        `📊 **상태**　　🔴 취소됨`,
      ].join('\n'))
      .setFooter({ text: '❌ 주최자에 의해 모집이 취소되었습니다.' })
      .setTimestamp();

    await match.message.edit({ content: '', embeds: [cancelledEmbed], components: [], attachments: [], allowedMentions: { parse: [] } });
    getMojips(interaction.client).delete(msgId);
    await interaction.update({ content: '✅ **모집이 취소되었습니다.**', components: [] });
    return;
  }

  // ── 참가자 추가 (주최자/관리자 전용) ─────────────────────────
  if (customId.startsWith('mojip:add_member:')) {
    const msgId = customId.slice('mojip:add_member:'.length);
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 모집입니다.**\n(${getResetDateStr(interaction.client)})`, embeds: [], attachments: [], components: [] });
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
      await interaction.update({ content: `⚠️ **만료된 모집입니다.**\n(${getResetDateStr(interaction.client)})`, embeds: [], attachments: [], components: [] });
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
      .setMaxValues(match.participants.length)
      .addOptions(match.participants.map(u => ({ label: u.displayName, value: u.id })));
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

  // ── 스팀 멘션 토글 (직접 입력 전용) ──────────────────────────
  if (customId === 'mojip:toggle_steam') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.reply({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/모집\`을 실행해주세요. (${getResetDateStr(interaction.client)})`, ephemeral: true });
      return;
    }
    data.mentionSteam = !data.mentionSteam;
    await interaction.update({
      content: '**미리보기** - 이 내용이 채널에 게시됩니다.',
      embeds: [buildPreviewEmbed(data)],
      components: buildPreviewComponents(data),
      files: getThumbnailFiles(data.game),
    });
    return;
  }

  // ── 수정 (미리보기) ────────────────────────────────────────────
  if (customId === 'mojip:edit') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.reply({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/모집\`을 실행해주세요. (${getResetDateStr(interaction.client)})`, ephemeral: true });
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
      await interaction.update({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/모집\`을 실행해주세요. (${getResetDateStr(interaction.client)})`, embeds: [], attachments: [], components: [] });
      return;
    }
    await interaction.update({
      content: '**미리보기** - 이 내용이 채널에 게시됩니다.',
      embeds: [buildPreviewEmbed(data)],
      components: buildPreviewComponents(data),
      files: getThumbnailFiles(data.game),
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
    await interaction.reply({ content: `⚠️ **만료된 모집입니다.**\n(${getResetDateStr(interaction.client)})`, ephemeral: true });
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
  });

  await interaction.reply({ content: '✅ **모집 정보가 수정되었습니다.**', ephemeral: true });
}

async function handleMojipMemberAdd(interaction) {
  const msgId = interaction.customId.slice('mojip:member_add_select:'.length);
  const match = getMojips(interaction.client).get(msgId);
  if (!match) {
    await interaction.update({ content: `⚠️ **만료된 모집입니다.**\n(${getResetDateStr(interaction.client)})`, embeds: [], attachments: [], components: [] });
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
  if (!match.closed && match.participants.length >= maxPlayers) match.closed = true;
  await match.message.edit({
    embeds: [buildPublicEmbed(match.data, match.participants, match.closed)],
    components: buildPublicComponents(match.participants, maxPlayers, match.closed),
  });
  const lines = [];
  if (added.length > 0)   lines.push(`✅ 추가됨: ${added.map(n => `**${n}**`).join(', ')}`);
  if (skipped.length > 0) lines.push(`⚠️ 이미 참가 중: ${skipped.map(n => `**${n}**`).join(', ')}`);
  await interaction.update({ content: lines.join('\n') || '완료', embeds: [], attachments: [], components: buildManageMenu(match, msgId) });
}

async function handleMojipMemberRemove(interaction) {
  const msgId = interaction.customId.slice('mojip:member_remove_select:'.length);
  const match = getMojips(interaction.client).get(msgId);
  if (!match) {
    await interaction.update({ content: `⚠️ **만료된 모집입니다.**\n(${getResetDateStr(interaction.client)})`, embeds: [], attachments: [], components: [] });
    return;
  }
  const removeIds = new Set(interaction.values);
  const removed = match.participants.filter(u => removeIds.has(u.id)).map(u => u.displayName);
  match.participants = match.participants.filter(u => !removeIds.has(u.id));
  const maxPlayers = parseInt(match.data.players) || 0;
  const reopened = match.closed && match.participants.length < maxPlayers;
  if (reopened) match.closed = false;
  await match.message.edit({
    embeds: [buildPublicEmbed(match.data, match.participants, match.closed)],
    components: buildPublicComponents(match.participants, maxPlayers, match.closed),
  });
  const resultLines = [`➖ 제거됨: ${removed.map(n => `**${n}**`).join(', ')}`];
  if (reopened) resultLines.push('🔓 **참가자 미달로 마감이 자동 해제되었습니다.**');
  await interaction.update({
    content: resultLines.join('\n'),
    embeds: [], attachments: [],
    components: buildManageMenu(match, msgId),
  });
}

module.exports = { handleMojipGameSelect, handleMojipModal, handleMojipEditModal, handleMojipButton, handleMojipMatchEditModal, handleMojipMemberAdd, handleMojipMemberRemove, buildMojipMessagePayload };

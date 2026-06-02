const {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const GAMES = {
  lol:       { name: '리그 오브 레전드', emoji: '<:Lol:1510933684750913626>',    defaultPlayers: 10,   color: 0xC89B3C },
  valorant:  { name: '발로란트',         emoji: '<:Val:1510933698349109268>',    defaultPlayers: 10,   color: 0xFF4655 },
  overwatch: { name: '오버워치',         emoji: '<:Over:1510933569554612324>',   defaultPlayers: 10,   color: 0xF99E1A },
  pubg:      { name: '배틀그라운드',     emoji: '<:PUBG:1510933567646203964>',   defaultPlayers: 8,    color: 0xC8A96E },
  steam:     { name: '스팀',             emoji: '<:Steam:1510954746012242021>',  defaultPlayers: null, color: 0x1B2838 },
  custom:    { name: '직접 입력',        emoji: '🎮',                            defaultPlayers: null, color: 0x5865F2 },
};

const ROLE_NAMES = {
  lol: '롤', valorant: '발로란트', overwatch: '오버워치', pubg: '배그', steam: '스팀',
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

function buildPreviewEmbed({ gameInfo, title, datetime, players, description, organizer }) {
  const embed = new EmbedBuilder()
    .setColor(gameInfo.color)
    .setTitle(`${gameInfo.emoji} ${title}`)
    .addFields(
      { name: '🎮 게임',      value: gameInfo.name,  inline: true },
      { name: '👥 모집 인원', value: `${players}명`, inline: true },
      { name: '📅 일시',      value: datetime,        inline: true },
      { name: '👑 주최자',    value: `${organizer}`,  inline: true },
    )
    .setFooter({ text: '참여를 원하시면 아래 버튼을 눌러주세요!' })
    .setTimestamp();

  if (description) embed.addFields({ name: '📝 메모', value: description });
  return embed;
}

function buildPublicEmbed(data, participants, closed = false) {
  const { gameInfo, title, datetime, players, description, organizer } = data;
  const max = parseInt(players) || 0;
  const isFull = participants.length >= max;

  const embed = new EmbedBuilder()
    .setColor(closed ? 0x57F287 : (isFull ? 0x808080 : gameInfo.color))
    .setTitle(`${gameInfo.emoji} ${title}`)
    .addFields(
      { name: '🎮 게임',      value: gameInfo.name,                      inline: true },
      { name: '👥 모집 인원', value: `${participants.length} / ${max}명`, inline: true },
      { name: '📅 일시',      value: datetime,                            inline: true },
      { name: '👑 주최자',    value: `${organizer}`,                      inline: true },
    )
    .setFooter({ text: closed ? '🔒 마감된 모집입니다.' : (isFull ? '모집이 완료되었습니다.' : '✅ 버튼을 눌러 참가하세요!') })
    .setTimestamp();

  if (description) embed.addFields({ name: '📝 메모', value: description });

  const participantText = participants.length > 0
    ? participants.map((u, i) => `${i + 1}. ${u}`).join('\n')
    : '아직 참가자가 없습니다.';
  embed.addFields({ name: `👤 참가자 (${participants.length}/${max})`, value: participantText });
  return embed;
}

function buildPublicComponents(participants, maxPlayers, closed = false) {
  const isFull = participants.length >= maxPlayers;
  const joinDisabled = closed || isFull;
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('mojip:join')
        .setLabel(closed ? '🔒 마감됨' : (isFull ? '🔒 모집 완료' : '✅ 참가하기'))
        .setStyle(joinDisabled ? ButtonStyle.Secondary : ButtonStyle.Success)
        .setDisabled(joinDisabled),
      new ButtonBuilder()
        .setCustomId('mojip:manage')
        .setLabel('⚙️ 관리')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildLeaveButton(msgId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mojip:leave:${msgId}`)
      .setLabel('❌ 참가 취소')
      .setStyle(ButtonStyle.Danger),
  );
}

function buildPreviewComponents() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mojip:publish').setLabel('📢 채널에 공개 게시').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('mojip:edit').setLabel('✏️ 수정').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mojip:cancel').setLabel('❌ 취소').setStyle(ButtonStyle.Danger),
  );
}

function buildCancelComponents() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mojip:cancel_confirm').setLabel('✅ 확인').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('mojip:cancel_back').setLabel('↩️ 돌아가기').setStyle(ButtonStyle.Secondary),
  );
}

function buildManageMenu(closed, msgId) {
  const buttons = [
    ...(closed ? [] : [
      new ButtonBuilder()
        .setCustomId(`mojip:match_close:${msgId}`)
        .setLabel('🔒 마감하기')
        .setStyle(ButtonStyle.Primary),
    ]),
    new ButtonBuilder()
      .setCustomId(`mojip:match_edit:${msgId}`)
      .setLabel('✏️ 모집 수정')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`mojip:match_cancel:${msgId}`)
      .setLabel('❌ 모집 취소')
      .setStyle(ButtonStyle.Danger),
  ];
  return new ActionRowBuilder().addComponents(...buttons);
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
    await interaction.reply({ content: '⚠️ 모집 인원은 1 이상의 숫자만 입력해주세요.', ephemeral: true });
    return;
  }

  const data = { game, gameInfo, title, datetime, players, description, organizer: interaction.user };
  getPending(interaction.client).set(interaction.user.id, data);

  await interaction.reply({
    content: '**미리보기** — 이 내용이 채널에 게시됩니다.',
    embeds: [buildPreviewEmbed(data)],
    components: [buildPreviewComponents()],
    ephemeral: true,
  });
}

async function handleMojipButton(interaction) {
  const { customId } = interaction;

  // ── 공개 게시 ──────────────────────────────────────────────
  if (customId === 'mojip:publish') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.reply({ content: '⚠️ 데이터가 만료되었습니다. 다시 `/모집`을 실행해주세요.', ephemeral: true });
      return;
    }
    const maxPlayers = parseInt(data.players) || 0;
    const participants = [];
    const roleName = ROLE_NAMES[data.game];
    const role = roleName && interaction.guild
      ? interaction.guild.roles.cache.find(r => r.name === roleName)
      : null;
    getPending(interaction.client).delete(interaction.user.id);
    const msg = await interaction.channel.send({
      content: role ? `<@&${role.id}>` : '',
      embeds: [buildPublicEmbed(data, participants)],
      components: buildPublicComponents(participants, maxPlayers),
    });
    getMojips(interaction.client).set(msg.id, { data, participants, message: msg, closed: false });
    await interaction.update({ content: '✅ 채널에 공개 게시되었습니다!', embeds: [], components: [] });
    return;
  }

  // ── 참가하기 ───────────────────────────────────────────────
  if (customId === 'mojip:join') {
    const match = getMojips(interaction.client).get(interaction.message.id);
    if (!match) {
      await interaction.reply({ content: '⚠️ 만료된 모집입니다.', ephemeral: true });
      return;
    }
    if (match.closed) {
      await interaction.reply({ content: '❌ 이미 마감된 모집입니다.', ephemeral: true });
      return;
    }
    const maxPlayers = parseInt(match.data.players) || 0;
    const alreadyIn = match.participants.some(u => u.id === interaction.user.id);

    if (alreadyIn) {
      await interaction.reply({
        content: '이미 참가 중입니다. 취소하려면 아래 버튼을 눌러주세요.',
        components: [buildLeaveButton(interaction.message.id)],
        ephemeral: true,
      });
      return;
    }
    if (match.participants.length >= maxPlayers) {
      await interaction.reply({ content: '❌ 모집 인원이 가득 찼습니다!', ephemeral: true });
      return;
    }
    match.participants.push(interaction.user);
    await interaction.deferUpdate();
    await match.message.edit({
      embeds: [buildPublicEmbed(match.data, match.participants)],
      components: buildPublicComponents(match.participants, maxPlayers),
    });
    await interaction.followUp({
      content: '✅ **참가 완료!** 명단에 등록되었습니다.\n취소하려면 아래 버튼을 눌러주세요.',
      components: [buildLeaveButton(interaction.message.id)],
      ephemeral: true,
    });
    return;
  }

  // ── 참가 취소 ─────────────────────────────────────────────
  if (customId.startsWith('mojip:leave:')) {
    const msgId = customId.slice('mojip:leave:'.length);
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.update({ content: '⚠️ 만료된 모집입니다.', components: [] });
      return;
    }
    const idx = match.participants.findIndex(u => u.id === interaction.user.id);
    if (idx === -1) {
      await interaction.update({ content: '⚠️ 이미 참가 취소된 상태입니다.', components: [] });
      return;
    }
    match.participants.splice(idx, 1);
    const maxPlayers = parseInt(match.data.players) || 0;
    await match.message.edit({
      embeds: [buildPublicEmbed(match.data, match.participants, match.closed)],
      components: buildPublicComponents(match.participants, maxPlayers, match.closed),
    });
    await interaction.update({ content: '❌ 참가가 취소되었습니다.', components: [] });
    return;
  }

  // ── 주최자 관리 메뉴 ──────────────────────────────────────────
  if (customId === 'mojip:manage') {
    const msgId = interaction.message.id;
    const match = getMojips(interaction.client).get(msgId);
    await interaction.deferUpdate();
    if (!match) {
      await interaction.followUp({ content: '⚠️ 만료된 모집입니다.', ephemeral: true });
      return;
    }
    if (match.data.organizer.id !== interaction.user.id) {
      await interaction.followUp({ content: '❌ 주최자만 사용할 수 있습니다.', ephemeral: true });
      return;
    }
    await interaction.followUp({
      content: '⚙️ **주최자 관리 메뉴**',
      components: [buildManageMenu(match.closed, msgId)],
      ephemeral: true,
    });
    return;
  }

  // ── 마감하기 ──────────────────────────────────────────────────
  if (customId.startsWith('mojip:match_close:')) {
    const msgId = customId.slice('mojip:match_close:'.length);
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.update({ content: '⚠️ 만료된 모집입니다.', components: [] });
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
        embeds: [],
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
      components: [buildManageMenu(true, msgId)],
    });
    return;
  }

  // ── 마감 확정 (미달 확인 후) ──────────────────────────────────
  if (customId.startsWith('mojip:match_close_confirm:')) {
    const msgId = customId.slice('mojip:match_close_confirm:'.length);
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.update({ content: '⚠️ 만료된 모집입니다.', components: [] });
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
      components: [buildManageMenu(true, msgId)],
    });
    return;
  }

  // ── 관리 메뉴로 돌아가기 ──────────────────────────────────────
  if (customId.startsWith('mojip:manage_back:')) {
    const msgId = customId.slice('mojip:manage_back:'.length);
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.update({ content: '⚠️ 만료된 모집입니다.', embeds: [], components: [] });
      return;
    }
    await interaction.update({
      content: '⚙️ **주최자 관리 메뉴**',
      embeds: [],
      components: [buildManageMenu(match.closed, msgId)],
    });
    return;
  }

  // ── 모집 수정 ────────────────────────────────────────────────
  if (customId.startsWith('mojip:match_edit:')) {
    const msgId = customId.slice('mojip:match_edit:'.length);
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.update({ content: '⚠️ 만료된 모집입니다.', components: [] });
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
      await interaction.update({ content: '⚠️ 만료된 모집입니다.', components: [] });
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
      embeds: [],
      components: [confirmRow],
    });
    return;
  }

  // ── 모집 취소 확정 ────────────────────────────────────────────
  if (customId.startsWith('mojip:match_cancel_confirm:')) {
    const msgId = customId.slice('mojip:match_cancel_confirm:'.length);
    const match = getMojips(interaction.client).get(msgId);
    if (!match) {
      await interaction.update({ content: '⚠️ 이미 취소된 모집입니다.', components: [] });
      return;
    }
    const cancelledEmbed = new EmbedBuilder()
      .setColor(0xED4245)
      .setTitle(`❌ ${match.data.gameInfo.emoji} ${match.data.title} (취소됨)`)
      .addFields(
        { name: '🎮 게임',   value: match.data.gameInfo.name,   inline: true },
        { name: '📅 일시',   value: match.data.datetime,         inline: true },
        { name: '👑 주최자', value: `${match.data.organizer}`,   inline: true },
      )
      .setFooter({ text: '주최자에 의해 모집이 취소되었습니다.' })
      .setTimestamp();

    await match.message.edit({ embeds: [cancelledEmbed], components: [] });
    getMojips(interaction.client).delete(msgId);
    await interaction.update({ content: '✅ 모집이 취소되었습니다.', components: [] });
    return;
  }

  // ── 수정 (미리보기) ────────────────────────────────────────────
  if (customId === 'mojip:edit') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.reply({ content: '⚠️ 데이터가 만료되었습니다. 다시 `/모집`을 실행해주세요.', ephemeral: true });
      return;
    }
    await interaction.showModal(buildModal(data.game, data));
    return;
  }

  // ── 취소 → 확인 탭 ────────────────────────────────────────────
  if (customId === 'mojip:cancel') {
    await interaction.update({
      content: '⚠️ **모집 생성을 취소하시겠습니까?**\n입력한 내용이 모두 사라집니다.',
      embeds: [],
      components: [buildCancelComponents()],
    });
    return;
  }

  // ── 취소 확인 ─────────────────────────────────────────────────
  if (customId === 'mojip:cancel_confirm') {
    getPending(interaction.client).delete(interaction.user.id);
    await interaction.update({ content: '❌ 모집 생성이 취소되었습니다.', embeds: [], components: [] });
    return;
  }

  // ── 돌아가기 ──────────────────────────────────────────────────
  if (customId === 'mojip:cancel_back') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.update({ content: '⚠️ 데이터가 만료되었습니다. 다시 `/모집`을 실행해주세요.', embeds: [], components: [] });
      return;
    }
    await interaction.update({
      content: '**미리보기** — 이 내용이 채널에 게시됩니다.',
      embeds: [buildPreviewEmbed(data)],
      components: [buildPreviewComponents()],
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
    await interaction.reply({ content: '⚠️ 만료된 모집입니다.', ephemeral: true });
    return;
  }

  const title       = interaction.fields.getTextInputValue('title') || `${gameInfo.name} 모집`;
  const datetime    = interaction.fields.getTextInputValue('datetime');
  const players     = interaction.fields.getTextInputValue('players');
  const description = interaction.fields.getTextInputValue('description');

  if (isNaN(parseInt(players)) || parseInt(players) < 1) {
    await interaction.reply({ content: '⚠️ 모집 인원은 1 이상의 숫자만 입력해주세요.', ephemeral: true });
    return;
  }

  match.data = { ...match.data, gameInfo, title, datetime, players, description };
  const maxPlayers = parseInt(players) || 0;

  await match.message.edit({
    embeds: [buildPublicEmbed(match.data, match.participants, match.closed)],
    components: buildPublicComponents(match.participants, maxPlayers, match.closed),
  });

  await interaction.reply({ content: '✅ 모집 정보가 수정되었습니다.', ephemeral: true });
}

module.exports = { handleMojipGameSelect, handleMojipModal, handleMojipButton, handleMojipMatchEditModal };

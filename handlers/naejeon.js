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
  lol:       { name: '리그 오브 레전드', emoji: '⚔️',  defaultPlayers: 10, color: 0xC89B3C },
  valorant:  { name: '발로란트',         emoji: '🔫',  defaultPlayers: 10, color: 0xFF4655 },
  overwatch: { name: '오버워치 2',       emoji: '🦸',  defaultPlayers: 10, color: 0xF99E1A },
  pubg:      { name: '배틀그라운드',     emoji: '🪖',  defaultPlayers: 8,  color: 0xC8A96E },
  custom:    { name: '직접 입력',        emoji: '🎮',  defaultPlayers: null, color: 0x5865F2 },
};

// ─── 빌더 헬퍼 ────────────────────────────────────────────────

function buildModal(game, data = {}) {
  const gameInfo = GAMES[game];

  const modal = new ModalBuilder()
    .setCustomId(`naejeon:modal:${game}`)
    .setTitle(`${gameInfo.emoji} ${gameInfo.name} 내전 생성`);

  const titleInput = new TextInputBuilder()
    .setCustomId('title')
    .setLabel('제목 (비워두면 기본값 사용)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(`${gameInfo.name} 내전`)
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
    .setLabel('모집 인원 (명)')
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

  modal.addComponents(
    new ActionRowBuilder().addComponents(titleInput),
    new ActionRowBuilder().addComponents(datetimeInput),
    new ActionRowBuilder().addComponents(playersInput),
    new ActionRowBuilder().addComponents(descInput),
  );

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

function buildPublicEmbed(data, participants) {
  const { gameInfo, title, datetime, players, description, organizer } = data;
  const max = parseInt(players) || 0;
  const isFull = participants.length >= max;

  const embed = new EmbedBuilder()
    .setColor(isFull ? 0x808080 : gameInfo.color)
    .setTitle(`${gameInfo.emoji} ${title}`)
    .addFields(
      { name: '🎮 게임',      value: gameInfo.name,                      inline: true },
      { name: '👥 모집 인원', value: `${participants.length} / ${max}명`, inline: true },
      { name: '📅 일시',      value: datetime,                            inline: true },
      { name: '👑 주최자',    value: `${organizer}`,                      inline: true },
    )
    .setFooter({ text: isFull ? '모집이 완료되었습니다.' : '✅ 버튼을 눌러 참가하세요!ㅤㅤ※❌ 내전 취소는 주최자 전용입니다.' })
    .setTimestamp();

  if (description) embed.addFields({ name: '📝 메모', value: description });

  const participantText = participants.length > 0
    ? participants.map((u, i) => `${i + 1}. ${u}`).join('\n')
    : '아직 참가자가 없습니다.';
  embed.addFields({ name: `👤 참가자 (${participants.length}/${max})`, value: participantText });
  return embed;
}

// 공개 임베드용 컴포넌트 (참가 버튼 + 내전 취소 버튼)
function buildPublicComponents(participants, maxPlayers) {
  const isFull = participants.length >= maxPlayers;
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('naejeon:join')
        .setLabel(isFull ? '🔒 모집 완료' : '✅ 참가하기')
        .setStyle(isFull ? ButtonStyle.Secondary : ButtonStyle.Success)
        .setDisabled(isFull),
      new ButtonBuilder()
        .setCustomId('naejeon:match_edit')
        .setLabel('✏️ 수정')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('naejeon:match_cancel')
        .setLabel('🗑️ 내전 취소')
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function buildLeaveButton(matchMsgId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`naejeon:leave:${matchMsgId}`)
      .setLabel('🚪 참가 취소')
      .setStyle(ButtonStyle.Danger),
  );
}

function buildPreviewComponents() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('naejeon:publish').setLabel('📢 채널에 공개 게시').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('naejeon:edit').setLabel('✏️ 수정').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('naejeon:cancel').setLabel('❌ 취소').setStyle(ButtonStyle.Danger),
  );
}

function buildCancelComponents() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('naejeon:cancel_confirm').setLabel('✅ 확인').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('naejeon:cancel_back').setLabel('↩️ 돌아가기').setStyle(ButtonStyle.Secondary),
  );
}

function getMatches(client) {
  if (!client.naejeonMatches) client.naejeonMatches = new Map();
  return client.naejeonMatches;
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
  const gameInfo    = GAMES[game];
  const title       = interaction.fields.getTextInputValue('title') || `${gameInfo.name} 내전`;
  const datetime    = interaction.fields.getTextInputValue('datetime');
  const players     = interaction.fields.getTextInputValue('players');
  const description = interaction.fields.getTextInputValue('description');

  const data = { game, gameInfo, title, datetime, players, description, organizer: interaction.user };
  getPending(interaction.client).set(interaction.user.id, data);

  await interaction.reply({
    content: '**미리보기** — 이 내용이 채널에 게시됩니다.',
    embeds: [buildPreviewEmbed(data)],
    components: [buildPreviewComponents()],
    ephemeral: true,
  });
}

async function handleNaejeonButton(interaction) {
  const { customId } = interaction;

  // ── 공개 게시 ──────────────────────────────────────────────
  if (customId === 'naejeon:publish') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.reply({ content: '⚠️ 데이터가 만료되었습니다. 다시 `/내전`을 실행해주세요.', ephemeral: true });
      return;
    }
    const maxPlayers = parseInt(data.players) || 0;
    const participants = [];
    const msg = await interaction.channel.send({
      embeds: [buildPublicEmbed(data, participants)],
      components: buildPublicComponents(participants, maxPlayers),
    });
    getMatches(interaction.client).set(msg.id, { data, participants, message: msg });
    getPending(interaction.client).delete(interaction.user.id);
    await interaction.update({ content: '✅ 채널에 공개 게시되었습니다!', embeds: [], components: [] });
    return;
  }

  // ── 참가하기 ───────────────────────────────────────────────
  if (customId === 'naejeon:join') {
    const match = getMatches(interaction.client).get(interaction.message.id);
    if (!match) {
      await interaction.reply({ content: '⚠️ 만료된 내전입니다.', ephemeral: true });
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
      await interaction.update({ content: '⚠️ 만료된 내전입니다.', components: [] });
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
      embeds: [buildPublicEmbed(match.data, match.participants)],
      components: buildPublicComponents(match.participants, maxPlayers),
    });
    await interaction.update({ content: '🚪 참가가 취소되었습니다.', components: [] });
    return;
  }

  // ── 내전 수정 (주최자 전용) ────────────────────────────────────
  if (customId === 'naejeon:match_edit') {
    const match = getMatches(interaction.client).get(interaction.message.id);
    if (!match) {
      await interaction.reply({ content: '⚠️ 만료된 내전입니다.', ephemeral: true });
      return;
    }
    if (match.data.organizer.id !== interaction.user.id) {
      await interaction.reply({ content: '❌ 주최자만 내전을 수정할 수 있습니다.', ephemeral: true });
      return;
    }
    const editModal = buildModal(match.data.game, match.data);
    editModal.setCustomId(`naejeon:match_edit_modal:${match.data.game}:${interaction.message.id}`);
    await interaction.showModal(editModal);
    return;
  }

  // ── 내전 취소 요청 (주최자 전용) ──────────────────────────────
  if (customId === 'naejeon:match_cancel') {
    const match = getMatches(interaction.client).get(interaction.message.id);
    if (!match) {
      await interaction.reply({ content: '⚠️ 만료된 내전입니다.', ephemeral: true });
      return;
    }
    if (match.data.organizer.id !== interaction.user.id) {
      await interaction.reply({ content: '❌ 주최자만 내전을 취소할 수 있습니다.', ephemeral: true });
      return;
    }
    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`naejeon:match_cancel_confirm:${interaction.message.id}`)
        .setLabel('✅ 확인')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('naejeon:match_cancel_back')
        .setLabel('↩️ 돌아가기')
        .setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply({
      content: '⚠️ **내전을 취소하시겠습니까?**\n참가자 명단이 모두 사라지고 모집이 종료됩니다.',
      components: [confirmRow],
      ephemeral: true,
    });
    return;
  }

  // ── 내전 취소 확정 ────────────────────────────────────────
  if (customId.startsWith('naejeon:match_cancel_confirm:')) {
    const matchMsgId = customId.slice('naejeon:match_cancel_confirm:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update({ content: '⚠️ 이미 취소된 내전입니다.', components: [] });
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
      .setFooter({ text: '주최자에 의해 내전이 취소되었습니다.' })
      .setTimestamp();

    await match.message.edit({ embeds: [cancelledEmbed], components: [] });
    getMatches(interaction.client).delete(matchMsgId);
    await interaction.update({ content: '✅ 내전이 취소되었습니다.', components: [] });
    return;
  }

  // ── 내전 취소 돌아가기 ────────────────────────────────────
  if (customId === 'naejeon:match_cancel_back') {
    await interaction.update({ content: '↩️ 취소를 중단했습니다.', components: [] });
    return;
  }

  // ── 수정 ───────────────────────────────────────────────────
  if (customId === 'naejeon:edit') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.reply({ content: '⚠️ 데이터가 만료되었습니다. 다시 `/내전`을 실행해주세요.', ephemeral: true });
      return;
    }
    await interaction.showModal(buildModal(data.game, data));
    return;
  }

  // ── 취소 → 확인 탭 ────────────────────────────────────────
  if (customId === 'naejeon:cancel') {
    await interaction.update({
      content: '⚠️ **내전 생성을 취소하시겠습니까?**\n입력한 내용이 모두 사라집니다.',
      embeds: [],
      components: [buildCancelComponents()],
    });
    return;
  }

  // ── 취소 확인 ─────────────────────────────────────────────
  if (customId === 'naejeon:cancel_confirm') {
    getPending(interaction.client).delete(interaction.user.id);
    await interaction.update({ content: '❌ 내전 생성이 취소되었습니다.', embeds: [], components: [] });
    return;
  }

  // ── 돌아가기 ──────────────────────────────────────────────
  if (customId === 'naejeon:cancel_back') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.update({ content: '⚠️ 데이터가 만료되었습니다. 다시 `/내전`을 실행해주세요.', embeds: [], components: [] });
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

async function handleNaejeonMatchEditModal(interaction) {
  // customId: naejeon:match_edit_modal:{game}:{matchMsgId}
  const parts = interaction.customId.split(':');
  const game        = parts[3];
  const matchMsgId  = parts[4];
  const gameInfo    = GAMES[game];

  const match = getMatches(interaction.client).get(matchMsgId);
  if (!match) {
    await interaction.reply({ content: '⚠️ 만료된 내전입니다.', ephemeral: true });
    return;
  }

  const title       = interaction.fields.getTextInputValue('title') || `${gameInfo.name} 내전`;
  const datetime    = interaction.fields.getTextInputValue('datetime');
  const players     = interaction.fields.getTextInputValue('players');
  const description = interaction.fields.getTextInputValue('description');

  match.data = { ...match.data, title, datetime, players, description };
  const maxPlayers  = parseInt(players) || 0;

  await match.message.edit({
    embeds: [buildPublicEmbed(match.data, match.participants)],
    components: buildPublicComponents(match.participants, maxPlayers),
  });

  await interaction.reply({ content: '✅ 내전 정보가 수정되었습니다.', ephemeral: true });
}

module.exports = { handleGameSelect, handleNaejeonModal, handleNaejeonButton, handleNaejeonMatchEditModal };

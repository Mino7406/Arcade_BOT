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

const { ADMIN_IDS, getResetDateStr, getNaejeonMatches: getMatches, shuffleIntoTeams, buildTeamResultEmbed, applyThumbnail, getThumbnailFiles } = require('./shared');

const GAMES = {
  lol:       { name: '리그 오브 레전드', emoji: '<:Lol:1510933684750913626>',    defaultPlayers: 10,   color: 0xC89B3C },
  valorant:  { name: '발로란트',         emoji: '<:Val:1510933698349109268>',    defaultPlayers: 10,   color: 0xFF4655 },
  overwatch: { name: '오버워치',         emoji: '<:Over:1510933569554612324>',   defaultPlayers: 10,   color: 0xF99E1A },
  pubg:      { name: '배틀그라운드',     emoji: '<:PUBG:1510933567646203964>',   defaultPlayers: 8,    color: 0xC8A96E },
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
    .setCustomId(`naejeon:modal:${game}`)
    .setTitle(`${gameInfo.emoji} ${gameInfo.name} 내전 생성`);

  const titleInput = new TextInputBuilder()
    .setCustomId('title')
    .setLabel('제목 (비워두면 기본값 사용)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(isCustom ? '내전 제목을 입력하세요 (선택사항)' : `${gameInfo.name} 내전`)
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
  const max = parseInt(players) || 0;

  const lines = [
    `🎮 **게임**　　${gameInfo.name}`,
    `📅 **일시**　　${datetime}`,
    `👑 **주최자**　**\`${organizer.displayName}\`**`,
    `📊 **상태**　　⏳ 게시 전`,
  ];

  const embed = new EmbedBuilder()
    .setColor(gameInfo.color)
    .setTitle(`${gameInfo.emoji}  ${title}`)
    .setDescription(lines.join('\n'));
  applyThumbnail(embed);

  if (description) embed.addFields({ name: '📝 메모', value: description });

  return embed
    .addFields({ name: `👥 참가자  0 / ${max}명`, value: '*아직 참가자가 없습니다.*' })
    .setFooter({ text: '🔎 게시하기 전에 내용을 다시 확인해 주세요.' })
    .setTimestamp();
}

// teams: null | { team1: User[], team2: User[] }
function buildPublicEmbed(data, participants, closed = false, teams = null) {
  const { gameInfo, title, datetime, players, description, organizer } = data;
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
    .setTitle(`${gameInfo.emoji}  ${title}`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: closed ? '🔒 마감된 내전입니다.' : isFull ? '✅ 모집이 완료되었습니다.' : '✅ 버튼을 눌러 참가하세요!' })
    .setTimestamp();
  applyThumbnail(embed);

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
  const isFull = participants.length >= maxPlayers;
  const joinDisabled = closed || isFull;
  const buttons = [
    new ButtonBuilder()
      .setCustomId('naejeon:join')
      .setLabel(closed ? '🔒 마감됨' : (isFull ? '🔒 모집 완료' : '✅ 참가하기'))
      .setStyle(joinDisabled ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setDisabled(joinDisabled),
  ];
  if (closed) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId('naejeon:leave_request')
        .setLabel('🚪 나가기')
        .setStyle(ButtonStyle.Danger),
    );
  }
  buttons.push(
    new ButtonBuilder()
      .setCustomId('naejeon:manage')
      .setLabel('⚙️ 관리')
      .setStyle(ButtonStyle.Secondary),
  );
  return [new ActionRowBuilder().addComponents(...buttons)];
}

function buildPublicMessagePayload(match) {
  const maxPlayers = parseInt(match.data.players) || 0;
  return {
    content: match.roleContent || '',
    embeds: [buildPublicEmbed(match.data, match.participants, match.closed, match.teams)],
    components: buildPublicComponents(match.participants, maxPlayers, match.closed),
    allowedMentions: { parse: [] },
    files: getThumbnailFiles(),
  };
}

function buildLeaveButton(matchMsgId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`naejeon:leave:${matchMsgId}`)
      .setLabel('❌ 참가 취소')
      .setStyle(ButtonStyle.Danger),
  );
}

function buildPreviewComponents(data = null) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('naejeon:publish').setLabel('📢 채널에 공개 게시').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('naejeon:edit').setLabel('✏️ 수정').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('naejeon:cancel').setLabel('❌ 취소').setStyle(ButtonStyle.Danger),
  );
  if (data && data.game === 'custom') {
    const steamToggle = new ButtonBuilder()
      .setCustomId('naejeon:toggle_steam')
      .setEmoji({ id: '1510954746012242021', name: 'Steam' })
      .setLabel(data.mentionSteam ? '멘션 ON' : '멘션 OFF')
      .setStyle(data.mentionSteam ? ButtonStyle.Success : ButtonStyle.Secondary);
    return [row1, new ActionRowBuilder().addComponents(steamToggle)];
  }
  return [row1];
}

function buildCancelComponents() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('naejeon:cancel_confirm').setLabel('✅ 확인').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('naejeon:cancel_back').setLabel('↩️ 돌아가기').setStyle(ButtonStyle.Secondary),
  );
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

  const data = { game, gameInfo, title, datetime, players, description, organizer: { id: interaction.user.id, displayName: interaction.member?.displayName || interaction.user.globalName || interaction.user.username }, _previewInteraction: interaction };
  getPending(interaction.client).set(interaction.user.id, data);

  await interaction.reply({
    content: '**미리보기** - 이 내용이 채널에 게시됩니다.',
    embeds: [buildPreviewEmbed(data)],
    components: buildPreviewComponents(data),
    files: getThumbnailFiles(),
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
    await interaction.reply({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/내전\`을 실행해주세요. (${getResetDateStr(interaction.client)})`, ephemeral: true });
    return;
  }

  Object.assign(data, { gameInfo, title, datetime, players, description });

  await data._previewInteraction.editReply({
    content: '**미리보기** - 이 내용이 채널에 게시됩니다.',
    embeds: [buildPreviewEmbed(data)],
    components: buildPreviewComponents(data),
    files: getThumbnailFiles(),
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
    await interaction.update({ content: `⚠️ **만료된 내전입니다.**\n(${getResetDateStr(interaction.client)})`, embeds: [], components: [] });
    return;
  }

  const team1Ids = new Set(interaction.values);
  const team1 = match.participants.filter(u => team1Ids.has(u.id));
  const team2 = match.participants.filter(u => !team1Ids.has(u.id));

  match.teams = { team1, team2 };

  await match.message.edit(buildPublicMessagePayload(match));
  await interaction.update({ content: '✅ **팀 배정이 완료되었습니다.**', embeds: [], components: [buildTeamDoneRow(matchMsgId)] });
  await interaction.channel.send({ embeds: [buildTeamResultEmbed(match.data, match.teams)], files: getThumbnailFiles(), allowedMentions: { parse: [] } });
}

async function handleNaejeonButton(interaction) {
  const { customId } = interaction;

  // ── 공개 게시 ──────────────────────────────────────────────
  if (customId === 'naejeon:publish') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.reply({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/내전\`을 실행해주세요. (${getResetDateStr(interaction.client)})`, ephemeral: true });
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
      files: getThumbnailFiles(),
      allowedMentions: { roles: role ? [role.id] : [], users: [] },
    });
    getMatches(interaction.client).set(msg.id, { data, participants, message: msg, closed: false, teams: null, mentionSent: false, roleContent });
    await interaction.update({ content: '✅ **채널에 공개 게시되었습니다!**', embeds: [], components: [] });
    return;
  }

  // ── 참가하기 ───────────────────────────────────────────────
  if (customId === 'naejeon:join') {
    const match = getMatches(interaction.client).get(interaction.message.id);
    if (!match) {
      await interaction.reply({ content: `⚠️ **만료된 내전입니다.**\n(${getResetDateStr(interaction.client)})`, ephemeral: true });
      return;
    }
    if (match.closed) {
      await interaction.reply({ content: '❌ **이미 마감된 내전입니다.**', ephemeral: true });
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
    await match.message.edit(buildPublicMessagePayload(match));
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
      await interaction.update({ content: `⚠️ **만료된 내전입니다.**\n(${getResetDateStr(interaction.client)})`, components: [] });
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
    if (reopened) match.closed = false;
    await match.message.edit(buildPublicMessagePayload(match));
    await interaction.update({ content: '❌ **참가가 취소되었습니다.**', components: [] });
    return;
  }

  // ── 주최자 관리 메뉴 ──────────────────────────────────────────
  if (customId === 'naejeon:manage') {
    const matchMsgId = interaction.message.id;
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.reply({ content: `⚠️ **만료된 내전입니다.**\n(${getResetDateStr(interaction.client)})`, ephemeral: true });
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
      await interaction.update({ content: `⚠️ **만료된 내전입니다.**\n(${getResetDateStr(interaction.client)})`, components: [] });
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
        embeds: [],
        components: [confirmRow],
      });
      return;
    }
    match.closed = true;
    await match.message.edit(buildPublicMessagePayload(match));
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
      await interaction.update({ content: `⚠️ **만료된 내전입니다.**\n(${getResetDateStr(interaction.client)})`, components: [] });
      return;
    }
    match.closed = true;
    await match.message.edit(buildPublicMessagePayload(match));
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
      await interaction.update({ content: `⚠️ **만료된 내전입니다.**\n(${getResetDateStr(interaction.client)})`, components: [] });
      return;
    }
    match.closed = false;
    await match.message.edit(buildPublicMessagePayload(match));
    await interaction.update({
      content: '🔓 **내전 마감이 해제되었습니다.**',
      components: buildManageMenu(match, matchMsgId),
    });
    return;
  }

  // ── 팀 만들기 (주최자 전용) ───────────────────────────────────
  if (customId.startsWith('naejeon:team_builder:')) {
    const matchMsgId = customId.slice('naejeon:team_builder:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 내전입니다.**\n(${getResetDateStr(interaction.client)})`, embeds: [], components: [] });
      return;
    }
    if (match.participants.length < 2) {
      await interaction.update({
        content: '⚠️ **팀 만들기는 참가자가 2명 이상이어야 합니다.**',
        embeds: [],
        components: buildManageMenu(match, matchMsgId),
      });
      return;
    }
    await interaction.update({
      content: '🛠️ **팀 만들기** - 팀 1에 배정할 참가자를 선택하세요. \n(나머지는 자동으로 팀 2가 됩니다.)',
      embeds: [],
      components: buildTeamBuilderComponents(match, matchMsgId),
    });
    return;
  }

  // ── 자동 팀 배정 ──────────────────────────────────────────────
  if (customId.startsWith('naejeon:team_shuffle:')) {
    const matchMsgId = customId.slice('naejeon:team_shuffle:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 내전입니다.**\n(${getResetDateStr(interaction.client)})`, embeds: [], components: [] });
      return;
    }
    if (match.participants.length < 2) {
      await interaction.update({
        content: '⚠️ **팀을 나누려면 참가자가 2명 이상이어야 합니다.**',
        embeds: [],
        components: buildManageMenu(match, matchMsgId),
      });
      return;
    }
    match.teams = shuffleIntoTeams(match.participants);
    await match.message.edit(buildPublicMessagePayload(match));
    await interaction.update({ content: '✅ **자동 팀 배정이 완료되었습니다.**', embeds: [], components: [buildTeamDoneRow(matchMsgId)] });
    await interaction.channel.send({ embeds: [buildTeamResultEmbed(match.data, match.teams)], files: getThumbnailFiles(), allowedMentions: { parse: [] } });
    return;
  }

  // ── 관리 메뉴로 돌아가기 ──────────────────────────────────────
  if (customId.startsWith('naejeon:manage_back:')) {
    const matchMsgId = customId.slice('naejeon:manage_back:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 내전입니다.**\n(${getResetDateStr(interaction.client)})`, embeds: [], components: [] });
      return;
    }
    await interaction.update({
      content: '⚙️ **주최자 관리 메뉴**',
      embeds: [],
      components: buildManageMenu(match, matchMsgId),
    });
    return;
  }

  // ── 참가자 멘션 (주최자 전용, 1회) ───────────────────────────────
  if (customId.startsWith('naejeon:match_mention:')) {
    const matchMsgId = customId.slice('naejeon:match_mention:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update({ content: `**⚠️ 만료된 내전입니다.**\n(${getResetDateStr(interaction.client)})`, components: [] });
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
    await interaction.channel.send({
      content: `📣 **${match.data.title}**\n${mentionText}`,
      allowedMentions: { parse: ['users'] },
    });
    await interaction.update({
      content: '📣 **참가자에게 멘션을 보냈습니다.**',
      components: buildManageMenu(match, matchMsgId),
    });
    return;
  }

  // ── 내전 수정 (주최자 전용) ────────────────────────────────────
  if (customId.startsWith('naejeon:match_edit:')) {
    const matchMsgId = customId.slice('naejeon:match_edit:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 내전입니다.**\n(${getResetDateStr(interaction.client)})`, components: [] });
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
      await interaction.update({ content: `⚠️ **만료된 내전입니다.**\n(${getResetDateStr(interaction.client)})`, components: [] });
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
      embeds: [],
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
      .setTitle(`${match.data.gameInfo.emoji}  ${match.data.title}`)
      .setDescription([
        `🎮 **게임**　　${match.data.gameInfo.name}`,
        `📅 **일시**　　${match.data.datetime}`,
        `👑 **주최자**　**\`${match.data.organizer.displayName}\`**`,
        `📊 **상태**　　🔴 취소됨`,
      ].join('\n'))
      .setFooter({ text: '❌ 주최자에 의해 내전이 취소되었습니다.' })
      .setTimestamp();

    await match.message.edit({ content: '', embeds: [cancelledEmbed], components: [], allowedMentions: { parse: [] } });
    getMatches(interaction.client).delete(matchMsgId);
    await interaction.update({ content: '✅ **내전이 취소되었습니다.**', components: [] });
    return;
  }

  // ── 마감 후 참가 취소 요청 (공개 임베드) ──────────────────────
  if (customId === 'naejeon:leave_request') {
    const matchMsgId = interaction.message.id;
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.reply({ content: `⚠️ **만료된 내전입니다.**\n(${getResetDateStr(interaction.client)})`, ephemeral: true });
      return;
    }
    const inMatch = match.participants.some(u => u.id === interaction.user.id);
    if (!inMatch) {
      await interaction.reply({ content: '⚠️ **참가자가 아닙니다.**', ephemeral: true });
      return;
    }
    await interaction.reply({
      content: '⚠️ **정말 내전에서 나가시겠습니까?**\n내전이 마감된 상태입니다. 취소 후에는 다시 참가할 수 없습니다.',
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`naejeon:leave_do:${matchMsgId}`)
          .setLabel('✅ 확인')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('naejeon:leave_back')
          .setLabel('↩️ 돌아가기')
          .setStyle(ButtonStyle.Secondary),
      )],
      ephemeral: true,
    });
    return;
  }

  // ── 마감 후 참가 취소 확정 ────────────────────────────────────
  if (customId.startsWith('naejeon:leave_do:')) {
    const matchMsgId = customId.slice('naejeon:leave_do:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 내전입니다.**\n(${getResetDateStr(interaction.client)})`, components: [] });
      return;
    }
    const idx = match.participants.findIndex(u => u.id === interaction.user.id);
    if (idx === -1) {
      await interaction.update({ content: '⚠️ **이미 참가 취소된 상태입니다.**', components: [] });
      return;
    }
    match.participants.splice(idx, 1);
    if (match.teams) {
      match.teams.team1 = match.teams.team1.filter(u => u.id !== interaction.user.id);
      match.teams.team2 = match.teams.team2.filter(u => u.id !== interaction.user.id);
      if (match.teams.team1.length === 0 && match.teams.team2.length === 0) match.teams = null;
    }
    const maxPlayers = parseInt(match.data.players) || 0;
    const reopened = match.closed && match.participants.length < maxPlayers;
    if (reopened) match.closed = false;
    await match.message.edit(buildPublicMessagePayload(match));
    await interaction.update({ content: '🚪 **내전에서 이탈하였습니다.**', components: [] });
    return;
  }

  // ── 마감 후 참가 취소 돌아가기 ───────────────────────────────
  if (customId === 'naejeon:leave_back') {
    await interaction.deferUpdate();
    await interaction.deleteReply();
    return;
  }

  // ── 참가자 추가 (주최자/관리자 전용) ─────────────────────────
  if (customId.startsWith('naejeon:add_member:')) {
    const matchMsgId = customId.slice('naejeon:add_member:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update({ content: `⚠️ **만료된 내전입니다.**\n(${getResetDateStr(interaction.client)})`, embeds: [], components: [] });
      return;
    }
    const sel = new UserSelectMenuBuilder()
      .setCustomId(`naejeon:member_add_select:${matchMsgId}`)
      .setPlaceholder('참가자 선택')
      .setMinValues(1)
      .setMaxValues(10);
    await interaction.update({
      content: '➕ **참가자 추가** - 추가할 멤버를 선택하세요.',
      embeds: [],
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
      await interaction.update({ content: `⚠️ **만료된 내전입니다.**\n(${getResetDateStr(interaction.client)})`, embeds: [], components: [] });
      return;
    }
    if (match.participants.length === 0) {
      await interaction.update({ content: '⚠️ **참가자가 없습니다.**', embeds: [], components: buildManageMenu(match, matchMsgId) });
      return;
    }
    const sel = new StringSelectMenuBuilder()
      .setCustomId(`naejeon:member_remove_select:${matchMsgId}`)
      .setPlaceholder('참가자 선택')
      .setMinValues(1)
      .setMaxValues(match.participants.length)
      .addOptions(match.participants.map(u => ({ label: u.displayName, value: u.id })));
    await interaction.update({
      content: '➖ **참가자 제거** - 제거할 멤버를 선택하세요.',
      embeds: [],
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

  // ── 스팀 멘션 토글 (직접 입력 전용) ──────────────────────────
  if (customId === 'naejeon:toggle_steam') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.reply({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/내전\`을 실행해주세요. (${getResetDateStr(interaction.client)})`, ephemeral: true });
      return;
    }
    data.mentionSteam = !data.mentionSteam;
    await interaction.update({
      content: '**미리보기** - 이 내용이 채널에 게시됩니다.',
      embeds: [buildPreviewEmbed(data)],
      components: buildPreviewComponents(data),
      files: getThumbnailFiles(),
    });
    return;
  }

  // ── 수정 ───────────────────────────────────────────────────
  if (customId === 'naejeon:edit') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.reply({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/내전\`을 실행해주세요. (${getResetDateStr(interaction.client)})`, ephemeral: true });
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
      embeds: [],
      components: [buildCancelComponents()],
    });
    return;
  }

  // ── 취소 확인 ─────────────────────────────────────────────
  if (customId === 'naejeon:cancel_confirm') {
    getPending(interaction.client).delete(interaction.user.id);
    await interaction.update({ content: '❌ **내전 생성이 취소되었습니다.**', embeds: [], components: [] });
    return;
  }

  // ── 돌아가기 ──────────────────────────────────────────────
  if (customId === 'naejeon:cancel_back') {
    const data = getPending(interaction.client).get(interaction.user.id);
    if (!data) {
      await interaction.update({ content: `⚠️ **데이터가 만료되었습니다.**\n다시 \`/내전\`을 실행해주세요. (${getResetDateStr(interaction.client)})`, embeds: [], components: [] });
      return;
    }
    await interaction.update({
      content: '**미리보기** - 이 내용이 채널에 게시됩니다.',
      embeds: [buildPreviewEmbed(data)],
      components: buildPreviewComponents(data),
      files: getThumbnailFiles(),
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
    await interaction.reply({ content: `⚠️ **만료된 내전입니다.**\n(${getResetDateStr(interaction.client)})`, ephemeral: true });
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

async function handleNaejeonMemberAdd(interaction) {
  const matchMsgId = interaction.customId.slice('naejeon:member_add_select:'.length);
  const match = getMatches(interaction.client).get(matchMsgId);
  if (!match) {
    await interaction.update({ content: `⚠️ **만료된 내전입니다.**\n(${getResetDateStr(interaction.client)})`, embeds: [], components: [] });
    return;
  }
  const maxPlayers = parseInt(match.data.players) || 0;
  const newUserIds = interaction.values.filter(id => !match.participants.some(u => u.id === id));
  if (match.participants.length + newUserIds.length > maxPlayers) {
    await interaction.update({
      content: `⚠️ **참가자 초과로 추가할 수 없습니다.**\n(내전 수정을 통해 인원을 수정해주세요.)`,
      embeds: [],
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
  if (!match.closed && match.participants.length >= maxPlayers) match.closed = true;
  await match.message.edit(buildPublicMessagePayload(match));
  const lines = [];
  if (added.length > 0)   lines.push(`✅ 추가됨: ${added.map(n => `**${n}**`).join(', ')}`);
  if (skipped.length > 0) lines.push(`⚠️ 이미 참가 중: ${skipped.map(n => `**${n}**`).join(', ')}`);
  await interaction.update({ content: lines.join('\n') || '완료', embeds: [], components: buildManageMenu(match, matchMsgId) });
}

async function handleNaejeonMemberRemove(interaction) {
  const matchMsgId = interaction.customId.slice('naejeon:member_remove_select:'.length);
  const match = getMatches(interaction.client).get(matchMsgId);
  if (!match) {
    await interaction.update({ content: `⚠️ **만료된 내전입니다.**\n(${getResetDateStr(interaction.client)})`, embeds: [], components: [] });
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
  if (reopened) match.closed = false;
  await match.message.edit(buildPublicMessagePayload(match));
  const resultLines = [`➖ 제거됨: ${removed.map(n => `**${n}**`).join(', ')}`];
  if (reopened) resultLines.push('🔓 **참가자 미달로 마감이 자동 해제되었습니다.**');
  await interaction.update({
    content: resultLines.join('\n'),
    embeds: [],
    components: buildManageMenu(match, matchMsgId),
  });
}

module.exports = { handleGameSelect, handleNaejeonModal, handleNaejeonEditModal, handleNaejeonButton, handleNaejeonMatchEditModal, handleTeamAssign, handleNaejeonMemberAdd, handleNaejeonMemberRemove, buildPublicMessagePayload };

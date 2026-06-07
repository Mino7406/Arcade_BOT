const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');
const { buildPublicMessagePayload } = require('./naejeon');

const SIX_HOURS = 6 * 60 * 60 * 1000;

function getResetDateStr(client) {
  const startedAt = client.startedAt;
  if (!startedAt) return '봇 재시작 후 생성된 내전만 표시됩니다';
  const kst = new Date(startedAt.getTime() + 9 * 60 * 60 * 1000);
  const MM = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const DD = String(kst.getUTCDate()).padStart(2, '0');
  const HH = String(kst.getUTCHours()).padStart(2, '0');
  const mm = String(kst.getUTCMinutes()).padStart(2, '0');
  return `※ ${MM}.${DD} ${HH}:${mm}에 초기화 됨`;
}

function getMatches(client) {
  if (!client.naejeonMatches) client.naejeonMatches = new Map();
  return client.naejeonMatches;
}

function pruneStaleMatches(client) {
  const matches = getMatches(client);
  const now = Date.now();
  for (const [id, match] of matches) {
    if (match.createdAt && now - match.createdAt > SIX_HOURS) {
      matches.delete(id);
    }
  }
}

function shuffleIntoTeams(participants) {
  const shuffled = [...participants];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const half = Math.ceil(shuffled.length / 2);
  return { team1: shuffled.slice(0, half), team2: shuffled.slice(half) };
}

function buildTeamEmbed(data, teams) {
  const { gameInfo, title } = data;
  return new EmbedBuilder()
    .setColor(gameInfo.color)
    .setTitle(`${gameInfo.emoji}  ${title} - 팀 배정`)
    .addFields(
      {
        name: `🔵 팀 1 - ${teams.team1.length}명`,
        value: teams.team1.map((u, i) => `\`${i + 1}\` <@${u.id}>`).join('\n') || '없음',
        inline: true,
      },
      {
        name: `🔴 팀 2 - ${teams.team2.length}명`,
        value: teams.team2.map((u, i) => `\`${i + 1}\` <@${u.id}>`).join('\n') || '없음',
        inline: true,
      },
    )
    .setFooter({ text: '✅ 팀이 배정되었습니다.' })
    .setTimestamp();
}

function buildMatchSelectMenu(matches) {
  const options = matches.map(([id, m]) => {
    const emojiStr = m.data.gameInfo.emoji;
    const cm = emojiStr.match(/^<a?:(\w+):(\d+)>$/);
    const emoji = cm ? { id: cm[2], name: cm[1] } : emojiStr;
    return {
      label: m.data.title.slice(0, 100),
      description: `참가자 ${m.participants.length}명 · ${m.data.datetime}`.slice(0, 100),
      value: id,
      emoji,
    };
  });
  return new StringSelectMenuBuilder()
    .setCustomId('team:match_select')
    .setPlaceholder('팀을 관리할 내전을 선택하세요')
    .addOptions(options);
}

function buildManageRow(matchMsgId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`team:builder:${matchMsgId}`)
      .setLabel('🛠️ 팀 만들기')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`team:shuffle_start:${matchMsgId}`)
      .setLabel('🎲 자동 배정')
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildSetupBuilderComponents(match, matchMsgId) {
  const sel = new StringSelectMenuBuilder()
    .setCustomId(`team:assign_setup:${matchMsgId}`)
    .setPlaceholder('팀 1에 배정할 참가자를 선택하세요 (나머지는 팀 2)')
    .setMinValues(1)
    .setMaxValues(match.participants.length - 1)
    .addOptions(match.participants.map(u => ({
      label: u.displayName,
      value: u.id,
    })));
  return [
    new ActionRowBuilder().addComponents(sel),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`team:shuffle_start:${matchMsgId}`)
        .setLabel('🎲 자동 배정')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildPublicBuilderComponents(match, matchMsgId) {
  const sel = new StringSelectMenuBuilder()
    .setCustomId(`team:pub_assign:${matchMsgId}`)
    .setPlaceholder('팀 1에 배정할 참가자를 선택하세요 (나머지는 팀 2)')
    .setMinValues(1)
    .setMaxValues(match.participants.length - 1)
    .addOptions(match.participants.map(u => ({
      label: u.displayName,
      value: u.id,
    })));
  return [
    new ActionRowBuilder().addComponents(sel),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`team:pub_shuffle:${matchMsgId}`)
        .setLabel('🎲 자동 배정')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildPublicDoneRow(matchMsgId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`team:pub_builder:${matchMsgId}`)
      .setLabel('🔄 다시 배정')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`team:pub_shuffle:${matchMsgId}`)
      .setLabel('🎲 자동 배정')
      .setStyle(ButtonStyle.Secondary),
  );
}

// ── 핸들러 ─────────────────────────────────────────────────────

async function handleTeamMatchSelect(interaction) {
  const matchMsgId = interaction.values[0];
  const match = getMatches(interaction.client).get(matchMsgId);

  if (!match) {
    await interaction.update({ content: `⚠️ 만료된 내전입니다. (${getResetDateStr(interaction.client)})`, embeds: [], components: [] });
    return;
  }
  if (match.data.organizer.id !== interaction.user.id) {
    await interaction.update({ content: '❌ 내전 주최자만 팀을 관리할 수 있습니다.', embeds: [], components: [] });
    return;
  }
  if (match.participants.length < 1) {
    await interaction.update({ content: '⚠️ 팀을 나누려면 참가자가 1명 이상이어야 합니다.', embeds: [], components: [] });
    return;
  }

  if (match.teams) {
    await interaction.update({
      content: '🎮 **팀 관리** - 이미 배정된 팀이 있습니다.',
      embeds: [buildTeamEmbed(match.data, match.teams)],
      components: [buildManageRow(matchMsgId)],
    });
    return;
  }

  const { gameInfo, title, datetime } = match.data;
  const infoEmbed = new EmbedBuilder()
    .setColor(gameInfo.color)
    .setTitle(`${gameInfo.emoji} ${title}`)
    .addFields(
      { name: '📅 일시', value: datetime, inline: true },
      { name: '👥 참가자', value: `${match.participants.length}명`, inline: true },
    );

  await interaction.update({
    content: '🎮 **팀 관리** - 방식을 선택하세요.',
    embeds: [infoEmbed],
    components: [buildManageRow(matchMsgId)],
  });
}

async function handleTeamButton(interaction) {
  const { customId } = interaction;

  // ── 팀 만들기 (수동, 셋업 단계) ──────────────────────────
  if (customId.startsWith('team:builder:')) {
    const matchMsgId = customId.slice('team:builder:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update({ content: `⚠️ 만료된 내전입니다. (${getResetDateStr(interaction.client)})`, embeds: [], components: [] });
      return;
    }
    if (match.data.organizer.id !== interaction.user.id) {
      await interaction.reply({ content: '❌ 내전 주최자만 사용할 수 있습니다.', ephemeral: true });
      return;
    }
    if (match.participants.length < 2) {
      await interaction.reply({ content: '⚠️ 팀 만들기는 참가자가 2명 이상이어야 합니다.', ephemeral: true });
      return;
    }
    await interaction.update({
      content: '🛠️ **팀 만들기** - 팀 1에 배정할 참가자를 선택하세요.\n(나머지는 자동으로 팀 2가 됩니다.)',
      embeds: [],
      components: buildSetupBuilderComponents(match, matchMsgId),
    });
    return;
  }

  // ── 자동 배정 ─────────────────────────────────────────────
  if (customId.startsWith('team:shuffle_start:')) {
    const matchMsgId = customId.slice('team:shuffle_start:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update({ content: `⚠️ 만료된 내전입니다. (${getResetDateStr(interaction.client)})`, embeds: [], components: [] });
      return;
    }
    if (match.data.organizer.id !== interaction.user.id) {
      await interaction.reply({ content: '❌ 내전 주최자만 사용할 수 있습니다.', ephemeral: true });
      return;
    }
    const teams = shuffleIntoTeams(match.participants);
    match.teams = teams;
    await match.message.edit(buildPublicMessagePayload(match));
    await interaction.update({ content: '✅ **자동 팀 배정이 완료되었습니다.**', embeds: [], components: [buildManageRow(matchMsgId)] });
    await interaction.channel.send({ embeds: [buildTeamEmbed(match.data, teams)], allowedMentions: { parse: [] } });
    return;
  }

  // ── 다시 배정 (수동 선택) ────────────────────────────────
  if (customId.startsWith('team:pub_builder:')) {
    const matchMsgId = customId.slice('team:pub_builder:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.reply({ content: `⚠️ 만료된 내전입니다. (${getResetDateStr(interaction.client)})`, ephemeral: true });
      return;
    }
    if (match.data.organizer.id !== interaction.user.id) {
      await interaction.reply({ content: '❌ 내전 주최자만 사용할 수 있습니다.', ephemeral: true });
      return;
    }
    await interaction.update({
      content: '🛠️ **팀 만들기** - 팀 1에 배정할 참가자를 선택하세요.\n(나머지는 자동으로 팀 2가 됩니다.)',
      embeds: [],
      components: buildPublicBuilderComponents(match, matchMsgId),
    });
    return;
  }

  // ── 자동 재배정 ───────────────────────────────────────────
  if (customId.startsWith('team:pub_shuffle:')) {
    const matchMsgId = customId.slice('team:pub_shuffle:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.reply({ content: `⚠️ 만료된 내전입니다. (${getResetDateStr(interaction.client)})`, ephemeral: true });
      return;
    }
    if (match.data.organizer.id !== interaction.user.id) {
      await interaction.reply({ content: '❌ 내전 주최자만 사용할 수 있습니다.', ephemeral: true });
      return;
    }
    const teams = shuffleIntoTeams(match.participants);
    match.teams = teams;
    await match.message.edit(buildPublicMessagePayload(match));
    await interaction.update({ content: '✅ **자동 팀 배정이 완료되었습니다.**', embeds: [], components: [buildPublicDoneRow(matchMsgId)] });
    await interaction.channel.send({ embeds: [buildTeamEmbed(match.data, teams)], allowedMentions: { parse: [] } });
    return;
  }
}

async function handleTeamAssignSelect(interaction) {
  const { customId } = interaction;
  const isSetup = customId.startsWith('team:assign_setup:');
  const matchMsgId = isSetup
    ? customId.slice('team:assign_setup:'.length)
    : customId.slice('team:pub_assign:'.length);

  const match = getMatches(interaction.client).get(matchMsgId);
  if (!match) {
    await interaction.update({ content: `⚠️ 만료된 내전입니다. (${getResetDateStr(interaction.client)})`, embeds: [], components: [] });
    return;
  }
  if (match.data.organizer.id !== interaction.user.id) {
    await interaction.reply({ content: '❌ 내전 주최자만 사용할 수 있습니다.', ephemeral: true });
    return;
  }

  const team1Ids = new Set(interaction.values);
  const team1 = match.participants.filter(u => team1Ids.has(u.id));
  const team2 = match.participants.filter(u => !team1Ids.has(u.id));
  const teams = { team1, team2 };
  match.teams = teams;
  await match.message.edit(buildPublicMessagePayload(match));
  await interaction.update({ content: '✅ **팀 배정이 완료되었습니다.**', embeds: [], components: [buildManageRow(matchMsgId)] });
  await interaction.channel.send({ embeds: [buildTeamEmbed(match.data, teams)], allowedMentions: { parse: [] } });
}

module.exports = {
  pruneStaleMatches,
  buildMatchSelectMenu,
  handleTeamMatchSelect,
  handleTeamButton,
  handleTeamAssignSelect,
};

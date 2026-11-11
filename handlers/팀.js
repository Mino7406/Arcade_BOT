const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
} = require('discord.js');
const { buildPublicMessagePayload } = require('./내전');
const {
  ADMIN_IDS,
  getNaejeonMatches: getMatches,
  shuffleIntoTeams,
  buildTeamResultCard,
  buildCancelledCard,
  gameHeader,
} = require('./공용');
const { card, notice, payload, COLORS } = require('./카드');

function buildMatchSelectMenu(matches) {
  const options = matches.map(([id, m]) => {
    const emojiStr = m.data.gameInfo.emoji;
    const cm = emojiStr.match(/^<a?:(\w+):(\d+)>$/);
    const emoji = cm ? { id: cm[2], name: cm[1] } : emojiStr;
    const max = parseInt(m.data.players) || 0;
    const isFull = m.participants.length >= max;
    const statusIcon = m.closed ? '🔒' : isFull ? '✅' : '🟢';
    const teamIcon = m.teams ? ' · ⚔️ 팀배정' : '';
    return {
      label: m.data.title.slice(0, 100),
      description: `${statusIcon} ${m.participants.length}/${max}명${teamIcon} · ${m.data.datetime}`.slice(0, 100),
      value: id,
      emoji,
    };
  });
  return new StringSelectMenuBuilder()
    .setCustomId('team:match_select')
    .setPlaceholder('팀을 관리할 내전을 선택하세요')
    .addOptions(options.slice(0, 25));
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

// 팀 관리 안내 카드(주최자에게만 보이는 임시 메시지): 내전 정보 + 지금 팀 상태 + 방식 선택 버튼.
function buildTeamManagePayload(match, matchMsgId, hint) {
  const { game, gameInfo, title, datetime, organizer } = match.data;
  const teams = match.teams;
  const blocks = [
    `📅 **일시**　${datetime}\n👑 **주최자**　**\`${organizer.displayName}\`**\n📊 **상태**　${match.closed ? '🔒 마감됨' : '🟢 모집 중'}`,
    `### 👥 참가자　${match.participants.length}명`,
  ];
  if (teams) {
    const list = users => (users.length ? users.map((u, i) => `${i + 1}. ${u.displayName}`).join('\n') : '없음');
    blocks.push(`### 🔵 팀 1　${teams.team1.length}명\n\`\`\`\n${list(teams.team1)}\n\`\`\``);
    blocks.push(`### 🔴 팀 2　${teams.team2.length}명\n\`\`\`\n${list(teams.team2)}\n\`\`\``);
  }
  return payload(card({
    color: gameInfo.color,
    header: gameHeader(game, gameInfo, title),
    sub: ['🎮 팀 관리', hint],
    blocks,
    rows: [buildManageRow(matchMsgId)],
  }));
}

// ── 핸들러 ─────────────────────────────────────────────────────

async function handleTeamMatchSelect(interaction) {
  const matchMsgId = interaction.values[0];
  const match = getMatches(interaction.client).get(matchMsgId);

  if (!match || match.guildId !== interaction.guildId) {
    await interaction.update(notice(`⚠️ **만료된 내전입니다.**`));
    return;
  }
  if (match.data.organizer.id !== interaction.user.id && !ADMIN_IDS.includes(interaction.user.id)) {
    await interaction.update(notice('❌ **내전 주최자만 팀을 관리할 수 있습니다.**'));
    return;
  }
  if (match.participants.length < 2) {
    await interaction.update(notice('⚠️ **팀을 나누려면 참가자가 2명 이상이어야 합니다.**'));
    return;
  }

  if (match.teams) {
    await interaction.update(buildTeamManagePayload(match, matchMsgId, '이미 배정된 팀이 있습니다.'));
    return;
  }

  await interaction.update(buildTeamManagePayload(match, matchMsgId, '방식을 선택하세요.'));
}

async function handleTeamButton(interaction) {
  const { customId } = interaction;

  // ── 팀 만들기 (수동, 셋업 단계) ──────────────────────────
  if (customId.startsWith('team:builder:')) {
    const matchMsgId = customId.slice('team:builder:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update(notice(`⚠️ **만료된 내전입니다.**`));
      return;
    }
    if (match.data.organizer.id !== interaction.user.id && !ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ **내전 주최자만 사용할 수 있습니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    if (match.participants.length < 2) {
      await interaction.reply({ content: '⚠️ **팀 만들기는 참가자가 2명 이상이어야 합니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.update(notice('🛠️ **팀 만들기** - 팀 1에 배정할 참가자를 선택하세요.\n(나머지는 자동으로 팀 2가 됩니다.)', { rows: buildSetupBuilderComponents(match, matchMsgId) }));
    return;
  }

  // ── 자동 배정 ─────────────────────────────────────────────
  if (customId.startsWith('team:shuffle_start:')) {
    const matchMsgId = customId.slice('team:shuffle_start:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.update(notice(`⚠️ **만료된 내전입니다.**`));
      return;
    }
    if (match.data.organizer.id !== interaction.user.id && !ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ **내전 주최자만 사용할 수 있습니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    const teams = shuffleIntoTeams(match.participants);
    match.teams = teams;
    await match.message.edit(buildPublicMessagePayload(match));
    await interaction.update(notice('✅ **자동 팀 배정이 완료되었습니다.**', { rows: [buildManageRow(matchMsgId)] }));
    await interaction.channel.send(payload(buildTeamResultCard(match.data, teams), { allowedMentions: { parse: [] } }));
    return;
  }

  // ── 다시 배정 (수동 선택) ────────────────────────────────
  if (customId.startsWith('team:pub_builder:')) {
    const matchMsgId = customId.slice('team:pub_builder:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.reply({ content: `⚠️ **만료된 내전입니다.**`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (match.data.organizer.id !== interaction.user.id && !ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ **내전 주최자만 사용할 수 있습니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    if (match.participants.length < 2) {
      await interaction.reply({ content: '⚠️ **팀 만들기는 참가자가 2명 이상이어야 합니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.update(notice('🛠️ **팀 만들기** - 팀 1에 배정할 참가자를 선택하세요.\n(나머지는 자동으로 팀 2가 됩니다.)', { rows: buildPublicBuilderComponents(match, matchMsgId) }));
    return;
  }

  // ── 자동 재배정 ───────────────────────────────────────────
  if (customId.startsWith('team:pub_shuffle:')) {
    const matchMsgId = customId.slice('team:pub_shuffle:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) {
      await interaction.reply({ content: `⚠️ **만료된 내전입니다.**`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (match.data.organizer.id !== interaction.user.id && !ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ **내전 주최자만 사용할 수 있습니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    if (match.participants.length < 2) {
      await interaction.reply({ content: '⚠️ **팀을 나누려면 참가자가 2명 이상이어야 합니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    const teams = shuffleIntoTeams(match.participants);
    match.teams = teams;
    await match.message.edit(buildPublicMessagePayload(match));
    await interaction.update(notice('✅ **자동 팀 배정이 완료되었습니다.**', { rows: [buildPublicDoneRow(matchMsgId)] }));
    await interaction.channel.send(payload(buildTeamResultCard(match.data, teams), { allowedMentions: { parse: [] } }));
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
  if (!match || match.guildId !== interaction.guildId) {
    await interaction.update(notice(`⚠️ **만료된 내전입니다.**`));
    return;
  }
  if (match.data.organizer.id !== interaction.user.id && !ADMIN_IDS.includes(interaction.user.id)) {
    await interaction.reply({ content: '❌ **내전 주최자만 사용할 수 있습니다.**', flags: MessageFlags.Ephemeral });
    return;
  }

  const team1Ids = new Set(interaction.values);
  const team1 = match.participants.filter(u => team1Ids.has(u.id));
  const team2 = match.participants.filter(u => !team1Ids.has(u.id));
  const teams = { team1, team2 };
  match.teams = teams;
  await match.message.edit(buildPublicMessagePayload(match));
  await interaction.update(notice('✅ **팀 배정이 완료되었습니다.**', { rows: [isSetup ? buildManageRow(matchMsgId) : buildPublicDoneRow(matchMsgId)] }));
  await interaction.channel.send(payload(buildTeamResultCard(match.data, teams), { allowedMentions: { parse: [] } }));
}

module.exports = {
  buildTeamManagePayload, // 화면 모음·테스트용
  buildMatchSelectMenu,
  handleTeamMatchSelect,
  handleTeamButton,
  handleTeamAssignSelect,
};

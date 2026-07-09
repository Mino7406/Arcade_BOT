const {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');

const { ADMIN_IDS } = require('../handlers/shared');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('관리')
    .setDescription('[관리자 전용] 내전/모집을 관리합니다.'),

  async execute(interaction) {
    if (!ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ **권한이 없습니다.**', ephemeral: true });
      return;
    }

    const naejeons = interaction.client.naejeonMatches || new Map();
    const mojips   = interaction.client.mojipMatches   || new Map();

    const options = [];
    for (const [msgId, match] of naejeons) {
      if (match.guildId !== interaction.guildId) continue;
      options.push({
        label:       `[내전] ${match.data.title}`.slice(0, 100),
        description: `${match.data.organizer?.displayName ?? '?'} · ${match.data.datetime} · ${match.closed ? '🔒 마감됨' : '🟢 모집중'}`.slice(0, 100),
        value:       `naejeon:${msgId}`,
      });
    }
    for (const [msgId, match] of mojips) {
      if (match.guildId !== interaction.guildId) continue;
      options.push({
        label:       `[모집] ${match.data.title}`.slice(0, 100),
        description: `${match.data.organizer?.displayName ?? '?'} · ${match.data.datetime} · ${match.closed ? '🔒 마감됨' : '🟢 모집중'}`.slice(0, 100),
        value:       `mojip:${msgId}`,
      });
    }

    if (options.length === 0) {
      await interaction.reply({ content: '⚠️ **활성된 내전/모집이 없습니다.**', ephemeral: true });
      return;
    }

    await interaction.reply({
      content: '🔧 **관리자 메뉴** — 관리할 내전/모집을 선택하세요.',
      components: [
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('admin:select')
            .setPlaceholder('내전 / 모집 선택...')
            .addOptions(options.slice(0, 25)),
        ),
      ],
      ephemeral: true,
    });
  },
};

// ── 셀렉트 메뉴 처리 ────────────────────────────────────────────
async function handleAdminSelect(interaction) {
  if (!ADMIN_IDS.includes(interaction.user.id)) {
    await interaction.reply({ content: '❌ **권한이 없습니다.**', ephemeral: true });
    return;
  }

  const value = interaction.values[0];
  const colonIdx = value.indexOf(':');
  const type  = value.slice(0, colonIdx);
  const msgId = value.slice(colonIdx + 1);

  const map   = type === 'naejeon'
    ? interaction.client.naejeonMatches
    : interaction.client.mojipMatches;
  const match = map?.get(msgId);

  if (!match || match.guildId !== interaction.guildId) {
    await interaction.update({ content: '⚠️ **해당 내전/모집을 찾을 수 없습니다.**', components: [] });
    return;
  }

  const label = type === 'naejeon' ? '내전' : '모집';
  await interaction.update({
    content: `⚠️ **"${match.data.title}" ${label}을 어떻게 처리하시겠습니까?**`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`admin:end_confirm:${value}`)
          .setLabel('⌛ 종료')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`admin:end_delete:${value}`)
          .setLabel('🗑️ 삭제')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

// ── 버튼 처리 ────────────────────────────────────────────────────
async function handleAdminButton(interaction) {
  if (!ADMIN_IDS.includes(interaction.user.id)) {
    await interaction.reply({ content: '❌ **권한이 없습니다.**', ephemeral: true });
    return;
  }

  const { customId } = interaction;

  if (customId.startsWith('admin:end_delete:')) {
    const value    = customId.slice('admin:end_delete:'.length);
    const colonIdx = value.indexOf(':');
    const type     = value.slice(0, colonIdx);
    const msgId    = value.slice(colonIdx + 1);

    const map   = type === 'naejeon'
      ? interaction.client.naejeonMatches
      : interaction.client.mojipMatches;
    const match = map?.get(msgId);

    if (!match || match.guildId !== interaction.guildId) {
      await interaction.update({ content: '⚠️ **이미 종료된 내전/모집입니다.**', components: [] });
      return;
    }

    map.delete(msgId);
    await match.message.delete();
    await interaction.update({ content: '✅ **종료 처리 후 삭제되었습니다.**', components: [] });
    return;
  }

  if (customId.startsWith('admin:end_confirm:')) {
    const value    = customId.slice('admin:end_confirm:'.length);
    const colonIdx = value.indexOf(':');
    const type     = value.slice(0, colonIdx);
    const msgId    = value.slice(colonIdx + 1);

    const map   = type === 'naejeon'
      ? interaction.client.naejeonMatches
      : interaction.client.mojipMatches;
    const match = map?.get(msgId);

    if (!match || match.guildId !== interaction.guildId) {
      await interaction.update({ content: '⚠️ **이미 종료된 내전/모집입니다.**', components: [] });
      return;
    }

    const label = type === 'naejeon' ? '내전' : '모집';
    const max = parseInt(match.data.players) || 0;
    const participantText = match.participants.length > 0
      ? `\`\`\`\n${match.participants.map((u, i) => `${i + 1}. ${u.displayName}`).join('\n')}\n\`\`\``
      : '*참가자가 없습니다.*';

    const endedEmbed = new EmbedBuilder()
      .setColor(0x808080)
      .setDescription([
        `# ${match.data.gameInfo.emoji}  ${match.data.title}`,
        `🎮 **게임**　　${match.data.gameInfo.name}`,
        `📅 **일시**　　${match.data.datetime}`,
        `👑 **주최자**　**\`${match.data.organizer.displayName}\`**`,
        `📊 **상태**　　⚫ 종료됨`,
      ].join('\n'));

    if (match.data.description) endedEmbed.addFields({ name: '📝 메모', value: match.data.description });

    endedEmbed
      .addFields({ name: `👥 참가자  ${match.participants.length} / ${max}명`, value: participantText })
      .setFooter({ text: `⌛ ${label}이 종료되었습니다.` })
      .setTimestamp();

    await match.message.edit({ content: '', embeds: [endedEmbed], components: [], attachments: [], allowedMentions: { parse: [] } });
    map.delete(msgId);
    await interaction.update({ content: '✅ **종료 처리되었습니다.**', components: [] });
  }
}

module.exports.handleAdminSelect = handleAdminSelect;
module.exports.handleAdminButton = handleAdminButton;

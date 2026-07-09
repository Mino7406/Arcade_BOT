const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('불러오기')
    .setDescription('진행 중인 내전 또는 모집 임베드를 다시 불러옵니다.'),

  async execute(interaction) {
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
      await interaction.reply({ content: '⚠️ **진행 중인 내전/모집이 없습니다.**', ephemeral: true });
      return;
    }

    await interaction.reply({
      content: '🔎 **임베드 불러오기** - 다시 게시할 내전/모집을 선택하세요.',
      components: [
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('불러오기:select')
            .setPlaceholder('내전 / 모집 선택...')
            .addOptions(options.slice(0, 25)),
        ),
      ],
      ephemeral: true,
    });
  },
};

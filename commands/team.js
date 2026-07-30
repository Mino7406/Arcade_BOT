const { SlashCommandBuilder, ActionRowBuilder } = require('discord.js');
const { buildMatchSelectMenu } = require('../handlers/team');
const { getResetDateStr } = require('../handlers/shared');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('팀')
    .setDescription('내전 팀을 관리합니다.'),

  async execute(interaction) {
    const matches = interaction.client.naejeonMatches;

    if (!matches || matches.size === 0) {
      await interaction.reply({ content: `⚠️ **활성화된 내전이 없습니다.**\n(${getResetDateStr(interaction.client)})`, ephemeral: true });
      return;
    }

    const validMatches = [...matches.entries()].filter(([, m]) => m.guildId === interaction.guildId && m.participants.length >= 2);

    if (validMatches.length === 0) {
      await interaction.reply({ content: '⚠️ **참가자가 2명 이상인 내전이 없습니다.**', ephemeral: true });
      return;
    }

    await interaction.reply({
      content: '🎮 **팀 관리** - 어느 내전의 팀을 관리할까요?',
      components: [new ActionRowBuilder().addComponents(buildMatchSelectMenu(validMatches))],
      ephemeral: true,
    });
  },
};

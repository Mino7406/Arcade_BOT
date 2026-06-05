const { SlashCommandBuilder, ActionRowBuilder } = require('discord.js');
const { pruneStaleMatches, buildMatchSelectMenu } = require('../handlers/team');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('팀')
    .setDescription('내전 팀을 관리합니다.'),

  async execute(interaction) {
    pruneStaleMatches(interaction.client);

    const matches = interaction.client.naejeonMatches;

    if (!matches || matches.size === 0) {
      const startedAt = interaction.client.startedAt;
      const dateStr = startedAt
        ? (() => {
            const kst = new Date(startedAt.getTime() + 9 * 60 * 60 * 1000);
            const MM = String(kst.getUTCMonth() + 1).padStart(2, '0');
            const DD = String(kst.getUTCDate()).padStart(2, '0');
            const HH = String(kst.getUTCHours()).padStart(2, '0');
            const mm = String(kst.getUTCMinutes()).padStart(2, '0');
            return `${MM}.${DD} ${HH}:${mm} 초기화`;
          })()
        : '봇 재시작 후 생성된 내전만 표시됩니다';
      await interaction.reply({ content: `⚠️ 활성화된 내전이 없습니다. (${dateStr})`, ephemeral: true });
      return;
    }

    const validMatches = [...matches.entries()].filter(([, m]) => m.participants.length >= 2);

    if (validMatches.length === 0) {
      await interaction.reply({ content: '⚠️ 참가자가 2명 이상인 내전이 없습니다.', ephemeral: true });
      return;
    }

    await interaction.reply({
      content: '🎮 **팀 관리** — 어느 내전의 팀을 관리할까요?',
      components: [new ActionRowBuilder().addComponents(buildMatchSelectMenu(validMatches))],
      ephemeral: true,
    });
  },
};

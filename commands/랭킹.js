const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getLeaderboard } = require('../handlers/levels');

const MEDALS = ['🥇', '🥈', '🥉'];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('랭킹')
    .setDescription('서버 레벨 순위표를 확인합니다.'),

  async execute(interaction) {
    const top = getLeaderboard(interaction.guildId, 10);
    if (top.length === 0) {
      await interaction.reply({ content: '📭 **아직 레벨 기록이 없습니다.**', ephemeral: true });
      return;
    }

    const lines = await Promise.all(top.map(async (entry) => {
      const member = await interaction.guild.members.fetch(entry.userId).catch(() => null);
      const name = member?.displayName || `알 수 없는 사용자 (${entry.userId})`;
      const icon = MEDALS[entry.rank - 1] || `**${entry.rank}.**`;
      return `${icon}　${name}　·　Lv.${entry.level}　·　${entry.xp} XP`;
    }));

    const embed = new EmbedBuilder()
      .setColor(0xFEE75C)
      .setTitle('🏆 서버 랭킹')
      .setDescription(lines.join('\n'))
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true }); // TODO: 테스트용 임시 처리, 테스트 끝나면 ephemeral 제거
  },
};

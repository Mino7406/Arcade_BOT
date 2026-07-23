const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getXp, getRank, levelFromXp, buildProgressBar } = require('../handlers/levels');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('레벨')
    .setDescription('나 또는 다른 사용자의 레벨과 XP를 확인합니다.')
    .addUserOption(opt =>
      opt.setName('유저').setDescription('확인할 유저 (비우면 본인)').setRequired(false),
    ),

  async execute(interaction) {
    const targetUser = interaction.options.getUser('유저') || interaction.user;
    const targetMember = interaction.options.getMember('유저') || interaction.member;
    const displayName = targetMember?.displayName || targetUser.globalName || targetUser.username;

    const xp = getXp(interaction.guildId, targetUser.id);
    const { level, currentLevelXp, neededXp } = levelFromXp(xp);
    const { rank, total } = getRank(interaction.guildId, targetUser.id);
    const bar = buildProgressBar(currentLevelXp, neededXp);

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setAuthor({ name: displayName, iconURL: targetUser.displayAvatarURL() })
      .setDescription(
        `🏆 **서버 순위**　${rank ? `${rank}위 / ${total}명` : '기록 없음'}\n` +
        `⭐ **레벨**　${level}\n\n` +
        `${bar}\n` +
        `${currentLevelXp} / ${neededXp} XP`,
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};

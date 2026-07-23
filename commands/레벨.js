const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getXp, levelFromXp, buildProgressBar } = require('../handlers/levels');

function buildLevelEmbed(guildId, targetUser, displayName) {
  const xp = getXp(guildId, targetUser.id);
  const { level, currentLevelXp, neededXp } = levelFromXp(xp);
  const bar = buildProgressBar(currentLevelXp, neededXp);

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
    .setDescription(
      `## ${displayName}\n` +
      `## LEVEL ${level}\n` +
      `${bar}\n` +
      `**${currentLevelXp} / ${neededXp}** XP`,
    )
    .setTimestamp();
}

function buildShareRow(targetUserId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`level:share:${targetUserId}`)
      .setLabel('📤 공유하기')
      .setStyle(ButtonStyle.Primary),
  );
}

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

    const embed = buildLevelEmbed(interaction.guildId, targetUser, displayName);

    await interaction.reply({
      embeds: [embed],
      components: [buildShareRow(targetUser.id)],
      ephemeral: true,
    });
  },
};

// ── 공유하기 버튼 처리 ──────────────────────────────────────────
async function handleLevelShareButton(interaction) {
  const targetUserId = interaction.customId.slice('level:share:'.length);
  const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
  const targetUser = targetMember?.user || await interaction.client.users.fetch(targetUserId).catch(() => null);

  if (!targetUser) {
    await interaction.reply({ content: '⚠️ **유저를 찾을 수 없습니다.**', ephemeral: true });
    return;
  }

  const displayName = targetMember?.displayName || targetUser.globalName || targetUser.username;
  const embed = buildLevelEmbed(interaction.guildId, targetUser, displayName);

  await interaction.channel.send({ embeds: [embed] });
  await interaction.update({ components: [] });
}

module.exports.handleLevelShareButton = handleLevelShareButton;

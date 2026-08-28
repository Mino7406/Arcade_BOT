const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { ADMIN_IDS } = require('../config');
const { adjustXp, saveLevels, levelFromXp } = require('../handlers/레벨');

// 한 번에 조정 가능한 XP 폭. 오타로 터무니없는 값이 들어가는 것만 막는 안전장치.
const MAX_ABS = 10_000_000;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('xp')
    .setDescription('[관리자 전용] 유저의 XP를 수동으로 더하거나 뺍니다.')
    .addUserOption(opt =>
      opt.setName('유저').setDescription('XP를 조정할 유저').setRequired(true),
    )
    .addIntegerOption(opt =>
      opt.setName('양')
        .setDescription('더할 XP (음수를 넣으면 차감)')
        .setRequired(true)
        .setMinValue(-MAX_ABS)
        .setMaxValue(MAX_ABS),
    ),

  async execute(interaction) {
    if (!ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ **권한이 없습니다.**', ephemeral: true });
      return;
    }

    const targetUser = interaction.options.getUser('유저');
    const delta = interaction.options.getInteger('양');

    if (targetUser.bot) {
      await interaction.reply({ content: '⚠️ **봇에게는 XP를 줄 수 없습니다.**', ephemeral: true });
      return;
    }
    if (delta === 0) {
      await interaction.reply({ content: '⚠️ **0이 아닌 값을 입력하세요.**', ephemeral: true });
      return;
    }

    const result = adjustXp(interaction.guildId, targetUser.id, delta);
    try {
      saveLevels();
    } catch (err) {
      console.error('/xp 저장 실패:', err);
    }

    const sign = result.appliedDelta >= 0 ? '+' : '';
    const before = levelFromXp(result.oldXp);
    const after = levelFromXp(result.newXp);

    let desc =
      `## ⚙️ XP 수동 조정\n` +
      `대상 : <@${targetUser.id}>\n` +
      `조정 : **${sign}${result.appliedDelta} XP**\n\n` +
      `\`${result.oldXp}\` → \`${result.newXp}\` XP\n` +
      `Lv.${before.level} (${before.currentLevelXp}/${before.neededXp}) → Lv.${after.level} (${after.currentLevelXp}/${after.neededXp})`;

    if (result.leveledUp) desc += `\n📈 **${result.oldLevel} → ${result.newLevel} 레벨업**`;
    else if (result.leveledDown) desc += `\n📉 **${result.oldLevel} → ${result.newLevel} 레벨 하락**`;

    if (result.appliedDelta !== delta) {
      desc += `\n-# 요청값 ${delta} 중 ${result.appliedDelta}만 적용됨 (XP는 0 미만이 될 수 없음)`;
    }

    const embed = new EmbedBuilder()
      .setColor(result.appliedDelta >= 0 ? 0x57F287 : 0xED4245)
      .setDescription(desc)
      .setFooter({ text: `실행: ${interaction.user.tag}` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};

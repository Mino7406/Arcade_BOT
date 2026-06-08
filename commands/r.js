const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('r')
    .setDescription('진행 중인 내전 임베드를 불러옵니다.'),

  async execute(interaction) {
    const matches = interaction.client.naejeonMatches;
    if (!matches || matches.size === 0) {
      await interaction.reply({ content: '⚠️ **현재 진행 중인 내전이 없습니다.**', ephemeral: true });
      return;
    }

    const options = [...matches.entries()].map(([id, m]) => {
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

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('r:match_select')
      .setPlaceholder('내전을 선택하세요')
      .addOptions(options);

    await interaction.reply({
      content: '🔎 **내전 임베드 불러오기**\n확인할 내전을 선택하세요.',
      components: [new ActionRowBuilder().addComponents(selectMenu)],
      ephemeral: true,
    });
  },
};

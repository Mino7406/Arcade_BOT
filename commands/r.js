const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('불러오기')
    .setDescription('진행 중인 내전 또는 모집 임베드를 다시 불러옵니다.'),

  async execute(interaction) {
    await interaction.reply({
      content: '🔎 **임베드 불러오기** - 종류를 선택하세요.',
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('불러오기:type:naejeon')
            .setLabel('⚔️ 내전')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('불러오기:type:mojip')
            .setLabel('📋 모집')
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
      ephemeral: true,
    });
  },
};

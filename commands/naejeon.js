const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('내전')
    .setDescription('내전을 생성합니다.'),

  async execute(interaction) {
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('naejeon:game_select')
      .setPlaceholder('게임을 선택하세요')
      .addOptions([
        { label: '리그 오브 레전드', value: 'lol', emoji: '⚔️' },
        { label: '발로란트', value: 'valorant', emoji: '🔫' },
        { label: '오버워치 2', value: 'overwatch', emoji: '🦸' },
        { label: '배틀그라운드', value: 'pubg', emoji: '🪖' },
        { label: '직접 입력', value: 'custom', emoji: '✏️' },
      ]);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    await interaction.reply({
      content: '🎮 **내전 생성**\n어떤 게임의 내전을 만들까요?',
      components: [row],
      ephemeral: true,
    });
  },
};

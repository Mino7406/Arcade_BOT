const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('모집')
    .setDescription('게임 모집을 생성합니다.'),

  async execute(interaction) {
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('mojip:game_select')
      .setPlaceholder('게임을 선택하세요')
      .addOptions([
        { label: '리그 오브 레전드', value: 'lol',       emoji: { id: '1510933684750913626' } },
        { label: '발로란트',         value: 'valorant',  emoji: { id: '1510933698349109268' } },
        { label: '오버워치',         value: 'overwatch', emoji: { id: '1510933569554612324' } },
        { label: '배틀그라운드',     value: 'pubg',      emoji: { id: '1510933567646203964' } },
        { label: '스팀',             value: 'steam',     emoji: { id: '1510954746012242021' } },
        { label: '직접 입력',        value: 'custom',    emoji: '✏️' },
      ]);

    await interaction.reply({
      content: '🎮 **게임 모집 생성**\n어떤 게임의 모집을 만들까요?',
      components: [new ActionRowBuilder().addComponents(selectMenu)],
      ephemeral: true,
    });
  },
};

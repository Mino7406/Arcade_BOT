const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');

const { GAME_EMOJIS } = require('../config');

// 안내 패널의 "모집 생성" 버튼(index.js)에서도 재사용하기 위해 페이로드 생성 로직을 분리.
function buildGameSelectPayload() {
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('mojip:game_select')
    .setPlaceholder('게임을 선택하세요')
    .addOptions([
      { label: '리그 오브 레전드', value: 'lol',       emoji: { id: GAME_EMOJIS.lol } },
      { label: '발로란트',         value: 'valorant',  emoji: { id: GAME_EMOJIS.valorant } },
      { label: '오버워치',         value: 'overwatch', emoji: { id: GAME_EMOJIS.overwatch } },
      { label: '배틀그라운드',     value: 'pubg',      emoji: { id: GAME_EMOJIS.pubg } },
      { label: '직접 입력',        value: 'custom',    emoji: '✏️' },
    ]);

  return {
    content: '🎮 **게임 모집 생성**\n어떤 게임의 모집을 만들까요?',
    components: [new ActionRowBuilder().addComponents(selectMenu)],
    ephemeral: true,
  };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('모집')
    .setDescription('게임 모집을 생성합니다.'),

  async execute(interaction) {
    await interaction.reply(buildGameSelectPayload());
  },

  buildGameSelectPayload,
};

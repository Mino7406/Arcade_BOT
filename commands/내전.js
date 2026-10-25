const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, MessageFlags } = require('discord.js');

const { GAME_EMOJIS, OWNER_IDS } = require('../config');

// 안내 패널의 "내전 생성" 버튼(index.js)에서도 재사용하기 위해 페이로드 생성 로직을 분리.
// 코블몬 토너먼트는 OWNER_IDS에 든 사람이 열었을 때만 선택지에 넣는다.
function buildGameSelectPayload(userId) {
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('naejeon:game_select')
    .setPlaceholder('게임을 선택하세요')
    .addOptions([
      { label: '리그 오브 레전드', value: 'lol',       emoji: { id: GAME_EMOJIS.lol } },
      { label: '발로란트',         value: 'valorant',  emoji: { id: GAME_EMOJIS.valorant } },
      { label: '오버워치',         value: 'overwatch', emoji: { id: GAME_EMOJIS.overwatch } },
      { label: '배틀그라운드',     value: 'pubg',      emoji: { id: GAME_EMOJIS.pubg } },
      { label: '직접 입력',        value: 'custom',    emoji: '✏️' },
    ]);
  if (OWNER_IDS.includes(userId)) {
    selectMenu.addOptions({ label: '코블몬 토너먼트', value: 'cobblemon', emoji: { id: GAME_EMOJIS.cobblemon } });
  }

  return {
    content: '🎮 **내전 생성**\n어떤 게임의 내전을 만들까요?',
    components: [new ActionRowBuilder().addComponents(selectMenu)],
    flags: MessageFlags.Ephemeral,
  };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('내전')
    .setDescription('내전을 생성합니다.'),

  async execute(interaction) {
    await interaction.reply(buildGameSelectPayload(interaction.user.id));
  },

  buildGameSelectPayload,
};

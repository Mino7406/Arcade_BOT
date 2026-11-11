const { SlashCommandBuilder, ActionRowBuilder, MessageFlags } = require('discord.js');
const { menu, notice } = require('../handlers/카드');
const { buildMatchSelectMenu } = require('../handlers/팀');

// 안내 패널의 "팀 관리" 버튼(index.js)에서도 재사용하기 위해 페이로드 생성 로직을 분리.
function buildTeamMatchListPayload(interaction) {
  const matches = interaction.client.naejeonMatches;

  if (!matches || matches.size === 0) {
    return notice('⚠️ **활성화된 내전이 없습니다.**', { ephemeral: true });
  }

  const validMatches = [...matches.entries()].filter(([, m]) => m.guildId === interaction.guildId && m.participants.length >= 2);

  if (validMatches.length === 0) {
    return notice('⚠️ **참가자가 2명 이상인 내전이 없습니다.**', { ephemeral: true });
  }

  return menu({ header: '🛠️ 팀 관리', note: '어느 내전의 팀을 관리할까요?', rows: [new ActionRowBuilder().addComponents(buildMatchSelectMenu(validMatches))], ephemeral: true });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('팀')
    .setDescription('내전 팀을 관리합니다.'),

  async execute(interaction) {
    await interaction.reply(buildTeamMatchListPayload(interaction));
  },

  buildTeamMatchListPayload,
};

const { SlashCommandBuilder } = require('discord.js');
const { startTttCommand } = require('../handlers/틱택토');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('틱택토')
    .setDescription('틱택토 게임을 시작합니다.')
    .addUserOption(opt =>
      opt.setName('상대방')
        .setDescription('대결할 상대를 선택하세요. (없으면 봇과 대결)')
        .setRequired(false),
    )
    .addBooleanOption(opt =>
      opt.setName('무한모드')
        .setDescription('각자 최대 3개까지만 유지되고, 4번째를 두면 가장 오래된 조각이 사라집니다.')
        .setRequired(false),
    ),

  async execute(interaction) {
    await startTttCommand(interaction);
  },
};

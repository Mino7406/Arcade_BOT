const { SlashCommandBuilder } = require('discord.js');
const { startTttCommand } = require('../handlers/tictactoe');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('틱택토')
    .setDescription('틱택토 게임을 시작합니다.')
    .addUserOption(opt =>
      opt.setName('상대방')
        .setDescription('대결할 상대를 선택하세요. (없으면 봇과 대결)')
        .setRequired(false),
    ),

  async execute(interaction) {
    await startTttCommand(interaction);
  },
};

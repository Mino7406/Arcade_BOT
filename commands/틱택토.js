const { SlashCommandBuilder } = require('discord.js');
const { startTttCommand } = require('../handlers/틱택토');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('틱택토')
    .setDescription('틱택토 게임을 시작합니다. 다른 사람이 참가 버튼으로 참여하거나 봇과 대결할 수 있습니다.'),

  async execute(interaction) {
    await startTttCommand(interaction);
  },
};

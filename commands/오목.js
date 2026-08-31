const { SlashCommandBuilder } = require('discord.js');
const { startOmokCommand } = require('../handlers/오목');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('오목')
    .setDescription('오목 게임을 시작합니다. 다른 사람이 참가하거나 봇과 대결할 수 있습니다. (좌표를 채팅으로 입력)'),

  async execute(interaction) {
    await startOmokCommand(interaction);
  },
};

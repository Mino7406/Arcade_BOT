const { SlashCommandBuilder } = require('discord.js');
const { startWcCommand } = require('../handlers/wordchain');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('끝말잇기')
    .setDescription('끝말잇기 게임을 시작합니다. 다른 사람들이 참가 버튼으로 참여할 수 있습니다.'),

  async execute(interaction) {
    await startWcCommand(interaction);
  },
};

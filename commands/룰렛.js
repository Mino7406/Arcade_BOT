const { SlashCommandBuilder } = require('discord.js');
const { startRouletteCommand } = require('../handlers/룰렛');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('룰렛')
    .setDescription('XP를 걸고 룰렛머신을 돌립니다. (하루 1회)'),

  async execute(interaction) {
    await startRouletteCommand(interaction);
  },
};

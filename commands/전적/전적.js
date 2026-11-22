const { SlashCommandBuilder } = require('discord.js');
const { startRecordCommand } = require('../../handlers/전적');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('전적')
    .setDescription('롤·발로란트 전적을 이미지로 보여줍니다.'),

  async execute(interaction) {
    await startRecordCommand(interaction);
  },
};

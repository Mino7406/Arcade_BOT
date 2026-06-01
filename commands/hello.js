const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('hello')
    .setDescription('봇이 인사합니다.')
    .addUserOption(option =>
      option
        .setName('target')
        .setDescription('인사할 대상 (없으면 본인에게)')
        .setRequired(false)
    ),

  async execute(interaction) {
    const target = interaction.options.getUser('target') ?? interaction.user;
    await interaction.reply(`👋 안녕하세요, ${target}님!`);
  },
};

const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('봇의 응답 속도를 확인합니다.'),

  async execute(interaction) {
    const latency = Date.now() - interaction.createdTimestamp;
    await interaction.reply(`🏓 퐁! 응답속도: **${latency}ms** | WebSocket: **${interaction.client.ws.ping}ms**`);
  },
};

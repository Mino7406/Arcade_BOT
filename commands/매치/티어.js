// /티어 — 슬래시 명령 정의만 둔다. 화면은 handlers/매치/팀.js(게임모집 패널의 🏅 내 티어 설정과 같은 화면).
const { SlashCommandBuilder } = require('discord.js');
const { buildTierGamePayload } = require('../../handlers/매치/팀');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('티어')
    .setDescription('내 롤·발로란트·오버워치·배그 티어를 확인하고 설정합니다.'),

  async execute(interaction) {
    await interaction.reply(buildTierGamePayload(interaction.user.id));
  },
};

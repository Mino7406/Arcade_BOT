// /모집 — 슬래시 명령 정의만 둔다. 화면은 handlers/매치/메뉴.js.
const { SlashCommandBuilder } = require('discord.js');
const { buildMojipGameSelectPayload } = require('../../handlers/매치/메뉴');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('모집')
    .setDescription('게임 모집을 생성합니다.'),

  async execute(interaction) {
    await interaction.reply(buildMojipGameSelectPayload());
  },
};

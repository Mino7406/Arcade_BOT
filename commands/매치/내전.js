// /내전 — 슬래시 명령 정의만 둔다. 화면은 handlers/매치/메뉴.js.
const { SlashCommandBuilder } = require('discord.js');
const { buildNaejeonGameSelectPayload } = require('../../handlers/매치/메뉴');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('내전')
    .setDescription('내전을 생성합니다.'),

  async execute(interaction) {
    await interaction.reply(buildNaejeonGameSelectPayload(interaction.user.id));
  },
};

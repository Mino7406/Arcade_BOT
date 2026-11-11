// /불러오기 — 슬래시 명령 정의만 둔다. 화면은 handlers/매치/메뉴.js.
const { SlashCommandBuilder } = require('discord.js');
const { buildReloadListPayload } = require('../../handlers/매치/메뉴');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('불러오기')
    .setDescription('진행 중인 내전 또는 모집 임베드를 다시 불러옵니다.'),

  async execute(interaction) {
    await interaction.reply(buildReloadListPayload(interaction));
  },
};

// /팀 — 슬래시 명령 정의만 둔다. 화면은 handlers/매치/메뉴.js.
const { SlashCommandBuilder } = require('discord.js');
const { buildTeamMatchListPayload } = require('../../handlers/매치/메뉴');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('팀')
    .setDescription('내전채팅에 팀 짜기 카드를 올립니다.'),

  async execute(interaction) {
    await interaction.reply(buildTeamMatchListPayload(interaction));
  },
};

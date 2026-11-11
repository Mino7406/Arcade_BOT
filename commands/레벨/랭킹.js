// /랭킹 — 슬래시 명령 정의만 둔다. 로직은 handlers/레벨/랭킹.js.
const { SlashCommandBuilder } = require('discord.js');
const { showRanking } = require('../../handlers/레벨/랭킹');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('랭킹')
    .setDescription('서버 레벨 순위표를 확인합니다.'),

  async execute(interaction) {
    await showRanking(interaction);
  },
};

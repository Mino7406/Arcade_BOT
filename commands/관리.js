// /관리 — 슬래시 명령 정의만 둔다. 화면·버튼 로직은 handlers/관리/홈.js.
const { SlashCommandBuilder } = require('discord.js');
const { openAdminHome } = require('../handlers/관리/홈');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('관리')
    .setDescription('[관리자 전용] 소식 알림 · XP · 퀴즈 · 패널 · 게시물 관리를 한 곳에서 합니다.'),

  async execute(interaction) {
    await openAdminHome(interaction);
  },
};

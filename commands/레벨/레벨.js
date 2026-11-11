// /레벨 — 슬래시 명령 정의만 둔다. 로직은 handlers/레벨/레벨카드.js.
const { SlashCommandBuilder } = require('discord.js');
const { showLevel } = require('../../handlers/레벨/레벨카드');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('레벨')
    .setDescription('나 또는 다른 사용자의 레벨과 XP를 확인합니다.')
    .addUserOption(opt =>
      opt.setName('유저').setDescription('확인할 유저 (비우면 본인)').setRequired(false),
    ),

  async execute(interaction) {
    await showLevel(interaction);
  },
};

const { SlashCommandBuilder } = require('discord.js');
const { startRecordCommand } = require('../../handlers/전적');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('전적')
    .setDescription('롤·발로란트 전적을 이미지로 보여줍니다.')
    .addUserOption(o => o.setName('멤버').setDescription('전적을 볼 멤버 (연결해 둔 계정)').setRequired(false))
    .addStringOption(o => o.setName('닉네임').setDescription('Riot ID 이름#태그 (연결 안 한 사람도 조회)').setRequired(false)),

  async execute(interaction) {
    await startRecordCommand(interaction);
  },
};

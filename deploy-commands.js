const path = require('path');
// 실행 디렉터리(CWD)가 아니라 이 파일 기준으로 env를 찾는다(index.js와 동일) — 다른 CWD에서 실행해도 토큰을 놓치지 않게.
require('dotenv').config({ path: path.join(__dirname, 'env') });
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const { GUILD_ID, TEST_GUILD_IDS } = require('./config');

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if (command.data) {
    commands.push(command.data.toJSON());
  }
}

const rest = new REST().setToken(process.env.TOKEN);

// node deploy-commands.js → config.js의 GUILD_ID + TEST_GUILD_IDS(각 길드)에 즉시 등록
(async () => {
  try {
    if (!GUILD_ID) {
      console.error('❌ config.js에 GUILD_ID가 없습니다.');
      process.exit(1);
    }
    const guildIds = [
      ...new Set([
        ...GUILD_ID.split(',').map(id => id.trim()),
        ...(TEST_GUILD_IDS || []),
      ].filter(Boolean)),
    ];
    for (const guildId of guildIds) {
      console.log(`⏳ 길드(${guildId})에 ${commands.length}개 커맨드 등록 중...`);
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId),
        { body: commands },
      );
      console.log(`✅ 길드(${guildId}) 커맨드 등록 완료! (즉시 반영)`);
    }
  } catch (error) {
    console.error(error);
  }
})();

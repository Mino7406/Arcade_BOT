const path = require('path');
// 실행 디렉터리(CWD)가 아니라 이 파일 기준으로 env를 찾는다(index.js와 동일).
require('dotenv').config({ path: path.join(__dirname, 'env') });
const { REST, Routes } = require('discord.js');
const { GUILD_ID, TEST_GUILD_IDS } = require('./config');

const rest = new REST().setToken(process.env.TOKEN);

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
      console.log(`⏳ 길드 ${guildId} 커맨드 초기화 중...`);
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId),
        { body: [] },
      );
      console.log(`✅ 길드 ${guildId} 초기화 완료!`);
    }
    console.log('✅ 모든 길드 커맨드 초기화 완료!');
  } catch (error) {
    console.error(error);
  }
})();

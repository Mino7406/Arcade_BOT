require('dotenv').config();
const { REST, Routes } = require('discord.js');

const rest = new REST().setToken(process.env.TOKEN);

(async () => {
  try {
    const guildIdEnv = process.env.GUILD_ID;
    if (!guildIdEnv) {
      console.error('❌ .env에 GUILD_ID가 없습니다.');
      process.exit(1);
    }

    const guildIds = guildIdEnv.split(',').map(id => id.trim());
    for (const guildId of guildIds) {
      console.log(`⏳ 길드 ${guildId} 커맨드 초기화 중...`);
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId),
        { body: [] },
      );
      console.log(`✅ 길드 ${guildId} 초기화 완료!`);
    }
    console.log('✅ 모든 길드 커맨드 초기화 완료! 이제 글로벌 커맨드만 남습니다.');
  } catch (error) {
    console.error(error);
  }
})();

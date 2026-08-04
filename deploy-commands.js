require('dotenv').config({ path: './env' });
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

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

// node deploy-commands.js → GUILD_ID의 각 길드에 즉시 등록
(async () => {
  try {
    const guildIdEnv = process.env.GUILD_ID;
    if (!guildIdEnv) {
      console.error('❌ .env에 GUILD_ID가 없습니다.');
      process.exit(1);
    }
    const guildIds = guildIdEnv.split(',').map(id => id.trim());
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

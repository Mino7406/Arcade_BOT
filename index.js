require('dotenv').config();

if (process.env.PRODUCTION !== 'true') {
  console.error('❌ 로컬 환경에서는 봇을 실행할 수 없습니다. 호스트 서버에서만 실행해주세요.');
  process.exit(1);
}

const { Client, GatewayIntentBits, Collection } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { handleGameSelect, handleNaejeonModal, handleNaejeonButton, handleNaejeonMatchEditModal, handleTeamAssign } = require('./handlers/naejeon');
const { handleMojipGameSelect, handleMojipModal, handleMojipButton, handleMojipMatchEditModal } = require('./handlers/mojip');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
});

client.commands = new Collection();

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if (command.data && command.execute) {
    client.commands.set(command.data.name, command);
  }
}

client.once('clientReady', (c) => {
  console.log(`✅ 봇 로그인 완료: ${c.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  try {
    const allowedChannel = process.env.ALLOWED_CHANNEL_ID;
    const allowedChannels = allowedChannel ? allowedChannel.split(',').map(id => id.trim()) : [];
    if (allowedChannels.length > 0 && !allowedChannels.includes(interaction.channelId)) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: '❌ 이 채널에서는 사용할 수 없습니다.', ephemeral: true });
      }
      return;
    }

    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction);

    } else if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'naejeon:game_select') {
        await handleGameSelect(interaction);
      } else if (interaction.customId.startsWith('naejeon:team_assign:')) {
        await handleTeamAssign(interaction);
      } else if (interaction.customId === 'mojip:game_select') {
        await handleMojipGameSelect(interaction);
      }

    } else if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('naejeon:modal:')) {
        await handleNaejeonModal(interaction);
      } else if (interaction.customId.startsWith('naejeon:match_edit_modal:')) {
        await handleNaejeonMatchEditModal(interaction);
      } else if (interaction.customId.startsWith('mojip:modal:')) {
        await handleMojipModal(interaction);
      } else if (interaction.customId.startsWith('mojip:match_edit_modal:')) {
        await handleMojipMatchEditModal(interaction);
      }

    } else if (interaction.isButton()) {
      if (interaction.customId.startsWith('naejeon:')) {
        await handleNaejeonButton(interaction);
      } else if (interaction.customId.startsWith('mojip:')) {
        await handleMojipButton(interaction);
      }
    }
  } catch (error) {
    console.error(error);
    const msg = { content: '❌ 처리 중 오류가 발생했습니다.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
});

process.on('SIGTERM', () => { client.destroy(); process.exit(0); });
process.on('SIGINT',  () => { client.destroy(); process.exit(0); });

client.login(process.env.TOKEN);

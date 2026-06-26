require('dotenv').config({ path: './env' });
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { handleGameSelect, handleNaejeonModal, handleNaejeonEditModal, handleNaejeonButton, handleNaejeonMatchEditModal, handleTeamAssign, handleNaejeonMemberAdd, handleNaejeonMemberRemove } = require('./handlers/naejeon');
const { handleMojipGameSelect, handleMojipModal, handleMojipEditModal, handleMojipButton, handleMojipMatchEditModal, handleMojipMemberAdd, handleMojipMemberRemove } = require('./handlers/mojip');
const { handleTeamMatchSelect, handleTeamButton, handleTeamAssignSelect } = require('./handlers/team');
const { handleRButton, handleRMatchSelect } = require('./handlers/r');
const { handleTttButton } = require('./handlers/tictactoe');
const { handleWcButton, handleWcModal } = require('./handlers/wordchain');

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
  c.startedAt = new Date();
});

client.on('interactionCreate', async (interaction) => {
  try {
    const isMiniGame =
      (interaction.isChatInputCommand() && ['틱택토', '끝말잇기'].includes(interaction.commandName)) ||
      interaction.customId?.startsWith('ttt:') ||
      interaction.customId?.startsWith('wc:');

    if (!isMiniGame) {
      const allowedChannel = process.env.ALLOWED_CHANNEL_ID;
      const allowedChannels = allowedChannel ? allowedChannel.split(',').map(id => id.trim()) : [];
      if (allowedChannels.length > 0 && !allowedChannels.includes(interaction.channelId)) {
        if (interaction.isRepliable()) {
          await interaction.reply({ content: '❌ 이 채널에서는 사용할 수 없습니다.', ephemeral: true });
        }
        return;
      }
    }

    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction);

    } else if (interaction.isUserSelectMenu()) {
      if (interaction.customId.startsWith('naejeon:member_add_select:')) {
        await handleNaejeonMemberAdd(interaction);
      } else if (interaction.customId.startsWith('mojip:member_add_select:')) {
        await handleMojipMemberAdd(interaction);
      }

    } else if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'naejeon:game_select') {
        await handleGameSelect(interaction);
      } else if (interaction.customId.startsWith('naejeon:team_assign:')) {
        await handleTeamAssign(interaction);
      } else if (interaction.customId.startsWith('naejeon:member_remove_select:')) {
        await handleNaejeonMemberRemove(interaction);
      } else if (interaction.customId === 'mojip:game_select') {
        await handleMojipGameSelect(interaction);
      } else if (interaction.customId.startsWith('mojip:member_remove_select:')) {
        await handleMojipMemberRemove(interaction);
      } else if (interaction.customId === 'team:match_select') {
        await handleTeamMatchSelect(interaction);
      } else if (interaction.customId.startsWith('team:assign_setup:') || interaction.customId.startsWith('team:pub_assign:')) {
        await handleTeamAssignSelect(interaction);
      } else if (interaction.customId === '불러오기:naejeon_select' || interaction.customId === '불러오기:mojip_select') {
        await handleRMatchSelect(interaction);
      }

    } else if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('wc:word:')) {
        await handleWcModal(interaction);
      } else if (interaction.customId.startsWith('naejeon:modal:')) {
        await handleNaejeonModal(interaction);
      } else if (interaction.customId.startsWith('naejeon:modal_edit:')) {
        await handleNaejeonEditModal(interaction);
      } else if (interaction.customId.startsWith('naejeon:match_edit_modal:')) {
        await handleNaejeonMatchEditModal(interaction);
      } else if (interaction.customId.startsWith('mojip:modal:')) {
        await handleMojipModal(interaction);
      } else if (interaction.customId.startsWith('mojip:modal_edit:')) {
        await handleMojipEditModal(interaction);
      } else if (interaction.customId.startsWith('mojip:match_edit_modal:')) {
        await handleMojipMatchEditModal(interaction);
      }

    } else if (interaction.isButton()) {
      if (interaction.customId.startsWith('naejeon:')) {
        await handleNaejeonButton(interaction);
      } else if (interaction.customId.startsWith('mojip:')) {
        await handleMojipButton(interaction);
      } else if (interaction.customId.startsWith('team:')) {
        await handleTeamButton(interaction);
      } else if (interaction.customId.startsWith('불러오기:')) {
        await handleRButton(interaction);
      } else if (interaction.customId.startsWith('ttt:')) {
        await handleTttButton(interaction);
      } else if (interaction.customId.startsWith('wc:')) {
        await handleWcButton(interaction);
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

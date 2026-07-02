require('dotenv').config({ path: './env' });
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { handleGameSelect, handleNaejeonModal, handleNaejeonEditModal, handleNaejeonButton, handleNaejeonMatchEditModal, handleTeamAssign, handleNaejeonMemberAdd, handleNaejeonMemberRemove } = require('./handlers/naejeon');
const { handleMojipGameSelect, handleMojipModal, handleMojipEditModal, handleMojipButton, handleMojipMatchEditModal, handleMojipMemberAdd, handleMojipMemberRemove } = require('./handlers/mojip');
const { handleTeamMatchSelect, handleTeamButton, handleTeamAssignSelect } = require('./handlers/team');
const { handleRButton, handleRMatchSelect } = require('./handlers/r');
const { handleWcButton, handleWcMessage } = require('./handlers/wordchain');
const { handleAdminSelect, handleAdminButton } = require('./commands/관리');
const { saveAll, loadRows } = require('./db'); // ⬅️ 추가: SQLite 저장 모듈

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
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

// ─── DB에서 내전/모집 복원 ────────────────────────────────────
// 봇이 켜질 때 data.db에 저장돼 있던 내전/모집을 다시 메모리로 불러옵니다.
async function restoreMatches(c) {
  if (!c.naejeonMatches) c.naejeonMatches = new Map();
  if (!c.mojipMatches)   c.mojipMatches   = new Map();

  let ok = 0, dropped = 0;
  for (const row of loadRows()) {
    try {
      const match = JSON.parse(row.data);
      // 저장 못 했던 '살아있는 메시지'를 디스코드에서 다시 가져와 연결합니다.
      const channel = await c.channels.fetch(row.channel_id);
      match.message = await channel.messages.fetch(row.message_id);

      const map = row.type === 'naejeon' ? c.naejeonMatches : c.mojipMatches;
      map.set(row.message_id, match);
      ok++;
    } catch {
      // 메시지가 삭제됐거나 채널 접근 불가 → 그 항목은 버립니다.
      dropped++;
    }
  }
  console.log(`♻️  복원 완료: ${ok}건 복원 / ${dropped}건 누락`);
}

// ─── 봇 준비 완료 시 ──────────────────────────────────────────
// discord.js 버전에 따라 이벤트 이름이 'clientReady' 또는 'ready'라서 둘 다 등록.
// _readyDone 플래그로 한 번만 실행되게 막습니다.
let _readyDone = false;
async function onReady(c) {
  if (_readyDone) return;
  _readyDone = true;
  console.log(`✅ 봇 로그인 완료: ${c.user.tag}`);
  c.startedAt = new Date();
  await restoreMatches(c); // ⬅️ 추가: 저장된 내전/모집 복원
}
client.once('clientReady', onReady);
client.once('ready', onReady);

client.on('interactionCreate', async (interaction) => {
  try {
    const isMiniGame =
      (interaction.isChatInputCommand() && interaction.commandName === '끝말잇기') ||
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
      if (interaction.customId === 'admin:select') {
        await handleAdminSelect(interaction);
      } else if (interaction.customId === 'naejeon:game_select') {
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
      if (interaction.customId.startsWith('naejeon:modal:')) {
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
      } else if (interaction.customId.startsWith('wc:')) {
        await handleWcButton(interaction);
      } else if (interaction.customId.startsWith('admin:')) {
        await handleAdminButton(interaction);
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

client.on('messageCreate', async (message) => {
  try {
    await handleWcMessage(message);
  } catch (error) {
    console.error(error);
  }
});

// ─── 자동 저장 (30초마다) ─────────────────────────────────────
// 봇이 갑자기 죽어도(크래시) 최대 30초 전 상태까지는 보존됩니다.
setInterval(() => {
  try { saveAll(client); } catch (e) { console.error('자동 저장 실패:', e); }
}, 30_000);

// ─── 종료 시 마지막으로 한 번 더 저장 ─────────────────────────
function shutdown() {
  try { saveAll(client); } catch (e) { console.error('종료 저장 실패:', e); }
  client.destroy();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

client.login(process.env.TOKEN);
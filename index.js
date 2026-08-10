require('dotenv').config({ path: './env' });
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { handleGameSelect, handleNaejeonModal, handleNaejeonEditModal, handleNaejeonButton, handleNaejeonMatchEditModal, handleTeamAssign, handleNaejeonMemberAdd, handleNaejeonMemberRemove, buildPublicMessagePayload: buildNaejeonMessagePayload } = require('./handlers/내전');
const { handleMojipGameSelect, handleMojipModal, handleMojipEditModal, handleMojipButton, handleMojipMatchEditModal, handleMojipMemberAdd, handleMojipMemberRemove, buildMojipMessagePayload } = require('./handlers/모집');
const { armAutoEnd, AUTO_CLOSE_DELAY_MS, announceMatchCompletionXp } = require('./handlers/공용');
const { handleTeamMatchSelect, handleTeamButton, handleTeamAssignSelect } = require('./handlers/팀');
const { handleRMatchSelect } = require('./handlers/불러오기');
const { handleWcButton, handleWcMessage } = require('./handlers/끝말잇기');
const { handleAdminSelect, handleAdminButton } = require('./commands/관리');
const { buildGameSelectPayload: buildNaejeonGameSelectPayload } = require('./commands/내전');
const { buildGameSelectPayload: buildMojipGameSelectPayload } = require('./commands/모집');
const { buildReloadListPayload } = require('./commands/불러오기');
const { buildTeamMatchListPayload } = require('./commands/팀');
const { buildCommandListPayload, buildSetupPanelPayload } = require('./commands/배치');
const { handleLevelShareButton } = require('./commands/레벨');
const { handleRankingPageButton, handleRankingShareButton } = require('./commands/랭킹');
const { saveAll, loadRows } = require('./db'); // ⬅️ 추가: SQLite 저장 모듈
const { loadLevels, saveLevels, handleMessageXp, trackVoiceStateUpdate, initVoiceStates, startVoiceXpTicker, LEVEL_UP_ANNOUNCE_CHANNEL_ID } = require('./handlers/레벨');
const { handleTempVoiceState, reconcileTempChannels } = require('./handlers/음성채널');
const { logCommandUsage } = require('./handlers/명령어로그');

// 끝말잇기/랭킹 명령어와 관련 버튼을 이 채널에서만 사용할 수 있게 제한한다.
const WORDCHAIN_RANKING_CHANNEL_ID = '1522174367075663872';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
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
// 봇이 켜질 때 data.json에 저장돼 있던 내전/모집을 다시 메모리로 불러옵니다.
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
      // guildId가 없던 옛 데이터(업데이트 이전 생성분)도 실제 채널 기준으로 채워줍니다.
      match.guildId = channel.guildId;

      const map = row.type === 'naejeon' ? c.naejeonMatches : c.mojipMatches;
      map.set(row.message_id, match);

      // 봇이 꺼져있는 동안 임베드/버튼 코드가 바뀌었을 수 있으므로, 복원 시점에
      // 최신 코드 기준으로 메시지를 다시 그려 옛 라벨(예: "모집 완료")이 남지 않게 합니다.
      const buildPayload = row.type === 'naejeon' ? buildNaejeonMessagePayload : buildMojipMessagePayload;
      await match.message.edit(buildPayload(match)).catch(err => console.error('복원 후 메시지 갱신 중 오류:', err));

      // 봇이 꺼져있던 동안 setTimeout이 소실되므로, 마감(closed) 시점을 기준으로
      // 5시간 자동 삭제를 다시 스케줄링합니다. 이미 5시간이 지났다면 즉시 삭제합니다.
      // (closedAt이 없는 옛 데이터는 이미 마감 상태로 오래 방치돼 있었다는 뜻이므로 즉시 삭제합니다.)
      if (match.closed && match.data?.autoClose) {
        const label = row.type === 'naejeon' ? '내전' : '모집';
        const remaining = match.closedAt ? AUTO_CLOSE_DELAY_MS - (Date.now() - match.closedAt) : 0;
        if (remaining <= 0) {
          try {
            await announceMatchCompletionXp(match);
            map.delete(row.message_id);
            await match.message.delete();
          } catch (err) {
            console.error('복원 후 자동 삭제 처리 중 오류:', err);
          }
        } else {
          armAutoEnd(map, row.message_id, match, label, remaining);
        }
      }

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
// restoreMatches/loadLevels가 끝나기 전에는 저장 관련 데이터가 비어있는 상태라,
// 이 시점에 자동 저장(30초 간격)이 실행되면 아직 못 불러온 기존 데이터를 빈 값으로
// 덮어써버린다. 복원이 끝난 뒤에만 자동 저장이 돌게 막는 플래그.
let dataReady = false;
async function onReady(c) {
  if (_readyDone) return;
  _readyDone = true;
  console.log(`✅ 봇 로그인 완료: ${c.user.tag}`);
  c.startedAt = new Date();
  await restoreMatches(c); // ⬅️ 추가: 저장된 내전/모집 복원
  loadLevels(); // ⬅️ 추가: 저장된 레벨/XP 복원
  initVoiceStates(c); // 재시작 전 이미 통화방에 있던 유저 추적 복원
  startVoiceXpTicker(c); // 통화방 체류 XP 1분 틱 시작
  await reconcileTempChannels(c); // 재시작 전 만들어둔 임시 음성채널 중 빈 방 정리
  dataReady = true;
}
client.once('clientReady', onReady);
client.once('ready', onReady);

client.on('interactionCreate', async (interaction) => {
  try {
    // 끝말잇기/랭킹은 다른 채널 허용 목록과 무관하게 이 채널에서만 사용 가능.
    const isWordchainOrRanking =
      (interaction.isChatInputCommand() && ['끝말잇기', '랭킹'].includes(interaction.commandName)) ||
      interaction.customId?.startsWith('wc:') ||
      interaction.customId?.startsWith('ranking:');

    if (isWordchainOrRanking && interaction.channelId !== WORDCHAIN_RANKING_CHANNEL_ID) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: '❌ 이 채널에서는 사용할 수 없습니다.', ephemeral: true });
      }
      return;
    }

    const isChannelExempt =
      (interaction.isChatInputCommand() && ['레벨', '관리', '배치'].includes(interaction.commandName)) ||
      isWordchainOrRanking ||
      interaction.customId?.startsWith('admin:') ||
      interaction.customId?.startsWith('level:');

    if (!isChannelExempt) {
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
      logCommandUsage(interaction);
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
      } else if (interaction.customId === '불러오기:select') {
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
      } else if (interaction.customId.startsWith('wc:')) {
        await handleWcButton(interaction);
      } else if (interaction.customId.startsWith('admin:')) {
        await handleAdminButton(interaction);
      } else if (interaction.customId.startsWith('level:share:')) {
        await handleLevelShareButton(interaction);
      } else if (interaction.customId.startsWith('ranking:page:')) {
        await handleRankingPageButton(interaction);
      } else if (interaction.customId.startsWith('ranking:share:')) {
        await handleRankingShareButton(interaction);
      } else if (interaction.customId === 'recruit:내전') {
        await interaction.reply(buildNaejeonGameSelectPayload());
      } else if (interaction.customId === 'recruit:모집') {
        await interaction.reply(buildMojipGameSelectPayload());
      } else if (interaction.customId === 'recruit:불러오기') {
        await interaction.reply(buildReloadListPayload(interaction));
      } else if (interaction.customId === 'recruit:팀') {
        await interaction.reply(buildTeamMatchListPayload(interaction));
      } else if (interaction.customId === 'recruit:명령어') {
        await interaction.reply(buildCommandListPayload());
      } else if (interaction.customId === 'recruit:새로고침') {
        await interaction.update(buildSetupPanelPayload(interaction));
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

  try {
    const result = handleMessageXp(message);
    if (result?.leveledUp) {
      const channel = message.guild.channels.cache.get(LEVEL_UP_ANNOUNCE_CHANNEL_ID);
      if (channel) {
        await channel.send({
          content: `<@${message.author.id}>님이 ${result.newLevel}레벨을 달성했어요. 🎉`,
          allowedMentions: { users: [message.author.id] },
        });
      }
    }
  } catch (error) {
    console.error(error);
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    trackVoiceStateUpdate(oldState, newState);
  } catch (error) {
    console.error('음성 상태 추적 실패:', error);
  }

  try {
    await handleTempVoiceState(oldState, newState);
  } catch (error) {
    console.error('임시 음성채널 처리 실패:', error);
  }
});

// ─── 자동 저장 (30초마다) ─────────────────────────────────────
// 봇이 갑자기 죽어도(크래시) 최대 30초 전 상태까지는 보존됩니다.
// dataReady가 true가 되기 전(복원 완료 전)에는 저장을 건너뛴다 — 안 그러면
// 아직 비어있는 메모리 상태로 기존 data.json/levels.json을 덮어써 초기화시킨다.
setInterval(() => {
  if (!dataReady) return;
  try { saveAll(client); } catch (e) { console.error('자동 저장 실패:', e); }
  try { saveLevels(); } catch (e) { console.error('레벨 자동 저장 실패:', e); }
}, 30_000);

// ─── 종료 시 마지막으로 한 번 더 저장 ─────────────────────────
function shutdown() {
  if (dataReady) {
    try { saveAll(client); } catch (e) { console.error('종료 저장 실패:', e); }
    try { saveLevels(); } catch (e) { console.error('레벨 종료 저장 실패:', e); }
  }
  client.destroy();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

client.login(process.env.TOKEN);
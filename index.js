require('dotenv').config({ path: './env' });
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { handleGameSelect, handleNaejeonModal, handleNaejeonEditModal, handleNaejeonButton, handleNaejeonMatchEditModal, handleNaejeonNotifyModal, handleTeamAssign, handleNaejeonMemberAdd, handleNaejeonMemberRemove, buildPublicMessagePayload: buildNaejeonMessagePayload } = require('./handlers/내전');
const { handleMojipGameSelect, handleMojipModal, handleMojipEditModal, handleMojipButton, handleMojipMatchEditModal, handleMojipNotifyModal, handleMojipMemberAdd, handleMojipMemberRemove, buildMojipMessagePayload } = require('./handlers/모집');
const { armAutoEnd, AUTO_CLOSE_DELAY_MS, announceMatchCompletionXp, scheduleCancelledDelete, scheduleMessageDelete, deleteMentionMessage, armNotifyReminder, ADMIN_IDS } = require('./handlers/공용');
const { handleTeamMatchSelect, handleTeamButton, handleTeamAssignSelect } = require('./handlers/팀');
const { handleRMatchSelect } = require('./handlers/불러오기');
const { handleWcButton, handleWcMessage } = require('./handlers/끝말잇기');
const { handleTttButton } = require('./handlers/틱택토');
const { startQuizScheduler, handleQuizMessage } = require('./handlers/퀴즈');
const { handleAdminSelect, handleAdminButton } = require('./commands/관리');
const { handleQuizAdminButton, handleQuizCreateModal } = require('./commands/퀴즈');
const { buildGameSelectPayload: buildNaejeonGameSelectPayload } = require('./commands/내전');
const { buildGameSelectPayload: buildMojipGameSelectPayload } = require('./commands/모집');
const { buildReloadListPayload } = require('./commands/불러오기');
const { buildTeamMatchListPayload } = require('./commands/팀');
const { buildCommandListPayload, buildSetupPanelPayload } = require('./commands/배치');
const { handleLevelShareButton } = require('./commands/레벨');
const { handleRankingPageButton, handleRankingShareButton } = require('./commands/랭킹');
const { saveAll, loadRows } = require('./db'); // ⬅️ 추가: SQLite 저장 모듈
const { loadLevels, saveLevels, handleMessageXp, trackVoiceStateUpdate, initVoiceStates, startVoiceXpTicker, LEVEL_UP_ANNOUNCE_CHANNEL_ID, MATCH_BONUS_CHANNEL_ID } = require('./handlers/레벨');
const { handleTempVoiceState, reconcileTempChannels } = require('./handlers/음성채널');
const { logCommandUsage } = require('./handlers/명령어로그');

// 끝말잇기/틱택토/랭킹 명령어와 관련 버튼을 이 채널에서만 사용할 수 있게 제한한다.
const WORDCHAIN_RANKING_CHANNEL_ID = '1522174367075663872';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers, // /랭킹의 대량 멤버 조회(guild.members.fetch({ user: [...] }))에 필요(특권 인텐트)
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
    // 취소된 임베드는 활성 매치 목록에 없으므로(취소 시점에 즉시 제거됨) 별도 타입으로
    // 저장돼 있다. 활성 매치 복원(아래 buildPayload 재렌더링) 경로를 타면 "취소됨" 임베드가
    // 다시 모집중 상태로 잘못 되살아나므로, 여기서 따로 걸러 삭제 예약만 다시 건다.
    if (row.type === 'cancelled_delete') {
      try {
        const parsed = JSON.parse(row.data);
        // 구버전 데이터는 취소 시각 대신 deleteAt(취소 시각 + 그 당시 지연시간)만 저장했다.
        // cancelledAt이 없으면 그 시절 지연시간(AUTO_CLOSE_DELAY_MS, 8시간) 기준으로 취소
        // 시각을 역산해 복원한다 — scheduleCancelledDelete가 항상 최신 지연시간
        // (CANCELLED_DELETE_DELAY_MS)으로 다시 계산하므로 이미 지났으면 즉시 삭제된다.
        const cancelledAt = parsed.cancelledAt ?? (parsed.deleteAt - AUTO_CLOSE_DELAY_MS);
        scheduleCancelledDelete(c, row.message_id, row.channel_id, cancelledAt);
      } catch (err) {
        console.error('취소된 임베드 삭제 예약 복원 중 오류:', err);
      }
      continue;
    }
    // 내전/모집 인증 채널(MATCH_BONUS_CHANNEL_ID)의 일반 유저 메시지 자동 삭제 예약.
    // 매치 데이터가 아니라 순수 메시지 삭제 예약이므로 위 취소된 임베드와 동일하게 별도 복원한다.
    if (row.type === 'pending_msg_delete') {
      try {
        const { deleteAt } = JSON.parse(row.data);
        if (deleteAt <= Date.now()) {
          const channel = await c.channels.fetch(row.channel_id).catch(() => null);
          const message = channel && await channel.messages.fetch(row.message_id).catch(() => null);
          if (message) await message.delete().catch(() => {});
        } else {
          scheduleMessageDelete(c, row.message_id, row.channel_id, deleteAt);
        }
      } catch (err) {
        console.error('메시지 자동 삭제 예약 복원 중 오류:', err);
      }
      continue;
    }
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
      // 8시간 자동 삭제를 다시 스케줄링합니다. 이미 8시간이 지났다면 즉시 삭제합니다.
      // (closedAt이 없는 옛 데이터는 이미 마감 상태로 오래 방치돼 있었다는 뜻이므로 즉시 삭제합니다.)
      const label = row.type === 'naejeon' ? '내전' : '모집';
      let deleted = false;
      if (match.closed && match.data?.autoClose) {
        const remaining = match.closedAt ? AUTO_CLOSE_DELAY_MS - (Date.now() - match.closedAt) : 0;
        if (remaining <= 0) {
          try {
            await announceMatchCompletionXp(match);
            map.delete(row.message_id);
            await deleteMentionMessage(c, match);
            await match.message.delete();
            deleted = true;
          } catch (err) {
            console.error('복원 후 자동 삭제 처리 중 오류:', err);
          }
        } else {
          armAutoEnd(map, row.message_id, match, label, remaining);
        }
      }

      // 알림 예약(notifyAt)도 setTimeout이 소실되므로 다시 건다. 이미 지난 시각이면
      // armNotifyReminder가 내부적으로 그냥 건너뛴다(지나간 알림을 뒤늦게 보내지 않음).
      if (!deleted && match.data?.notifyAt) {
        armNotifyReminder(map, row.message_id, match, label);
      }

      ok++;
    } catch {
      // 메시지가 삭제됐거나 채널 접근 불가 → 그 항목은 버립니다.
      dropped++;
    }
  }
  console.log(`♻️  복원 완료: ${ok}건 복원 / ${dropped}건 누락`);
}

// ─── 인증 채널 자동 삭제 예약 복구 ────────────────────────────
// scheduleMessageDelete는 messageCreate 이벤트에서만 걸리는데, 봇이 꺼져있던 동안
// (재시작 등) 인증 채널에 올라온 메시지는 그 이벤트를 아예 못 받아 예약이 안 걸린 채로
// 남는다. data.json 복원(restoreMatches)은 "이미 예약돼 있던" 항목만 되살릴 뿐 이런
// 누락은 못 잡으므로, 재시작 시 최근 메시지 기록을 직접 훑어서 예약이 빠진 메시지를 찾아
// 다시 건다. 최대 500개(5페이지) 또는 24시간(자동삭제 기준 8시간의 3배)치까지만 훑고,
// 그보다 오래된 건 예외적인 경우로 보고 포기한다(무한정 과거까지 훑지 않기 위함).
const CHANNEL_RECONCILE_LOOKBACK_MS = AUTO_CLOSE_DELAY_MS * 3;
async function reconcileMatchBonusMessages(c) {
  const channel = await c.channels.fetch(MATCH_BONUS_CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const cutoff = Date.now() - CHANNEL_RECONCILE_LOOKBACK_MS;
  let before;
  let recovered = 0;

  for (let page = 0; page < 5; page++) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
    if (!batch || batch.size === 0) break;

    for (const msg of batch.values()) {
      if (msg.author.bot) continue;
      if (c.pendingMessageDeletions?.has(msg.id)) continue;
      scheduleMessageDelete(c, msg.id, msg.channelId, msg.createdTimestamp + AUTO_CLOSE_DELAY_MS);
      recovered++;
    }

    const oldest = batch.last();
    if (batch.size < 100 || !oldest || oldest.createdTimestamp < cutoff) break;
    before = oldest.id;
  }
  if (recovered > 0) console.log(`♻️  인증 채널 자동 삭제 예약 복구: ${recovered}건`);
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
  await reconcileMatchBonusMessages(c); // 봇이 꺼져있던 동안 인증 채널에 올라와 예약이 빠진 메시지 복구
  startQuizScheduler(c); // 놀이터 채널에 하루 한 번 무작위 시각으로 초성퀴즈/상식퀴즈를 번갈아 출제
  dataReady = true;
}
client.once('clientReady', onReady);
client.once('ready', onReady);

client.on('interactionCreate', async (interaction) => {
  try {
    // 끝말잇기/틱택토/레벨/랭킹은 다른 채널 허용 목록과 무관하게 이 채널에서만 사용 가능.
    const isWordchainOrRanking =
      (interaction.isChatInputCommand() && ['끝말잇기', '틱택토', '레벨', '랭킹'].includes(interaction.commandName)) ||
      interaction.customId?.startsWith('wc:') ||
      interaction.customId?.startsWith('ttt:') ||
      interaction.customId?.startsWith('ranking:') ||
      interaction.customId?.startsWith('level:');

    if (isWordchainOrRanking && interaction.channelId !== WORDCHAIN_RANKING_CHANNEL_ID) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: '❌ 이 채널에서는 사용할 수 없습니다.', ephemeral: true });
      }
      return;
    }

    // 불러오기(재게시)는 완료 보너스 채널 밖에서 쓰면 match.message.channelId가 바뀌어
    // XP 보너스 자격이 어긋나므로, 이 채널에서만 쓸 수 있게 막는다.
    const isReload =
      (interaction.isChatInputCommand() && interaction.commandName === '불러오기') ||
      interaction.customId === '불러오기:select' ||
      interaction.customId === 'recruit:불러오기';

    if (isReload && interaction.channelId !== MATCH_BONUS_CHANNEL_ID) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: '❌ 이 채널에서는 사용할 수 없습니다.', ephemeral: true });
      }
      return;
    }

    const isChannelExempt =
      (interaction.isChatInputCommand() && ['관리', '배치', '퀴즈'].includes(interaction.commandName)) ||
      isWordchainOrRanking ||
      isReload ||
      interaction.customId?.startsWith('admin:') ||
      interaction.customId?.startsWith('quiz:');

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
      } else if (interaction.customId.startsWith('naejeon:notify_modal:')) {
        await handleNaejeonNotifyModal(interaction);
      } else if (interaction.customId.startsWith('mojip:modal:')) {
        await handleMojipModal(interaction);
      } else if (interaction.customId.startsWith('mojip:modal_edit:')) {
        await handleMojipEditModal(interaction);
      } else if (interaction.customId.startsWith('mojip:match_edit_modal:')) {
        await handleMojipMatchEditModal(interaction);
      } else if (interaction.customId.startsWith('mojip:notify_modal:')) {
        await handleMojipNotifyModal(interaction);
      } else if (interaction.customId.startsWith('quiz:create_modal:')) {
        await handleQuizCreateModal(interaction);
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
      } else if (interaction.customId.startsWith('ttt:')) {
        await handleTttButton(interaction);
      } else if (interaction.customId.startsWith('admin:')) {
        await handleAdminButton(interaction);
      } else if (interaction.customId.startsWith('quiz:')) {
        await handleQuizAdminButton(interaction);
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
        if (!ADMIN_IDS.includes(interaction.user.id)) {
          await interaction.reply({ content: '❌ **권한이 없습니다.**', ephemeral: true });
        } else {
          // 채널 맨 아래로 옮기지 않고, 기존 패널 메시지를 그 자리에서 갱신한다.
          await interaction.update(buildSetupPanelPayload(interaction));
        }
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
    await handleQuizMessage(message);
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

  // 내전/모집 인증 채널에 올라온 일반 유저 메시지는 8시간 후 자동 삭제한다(봇 메시지는 제외).
  try {
    if (message.channelId === MATCH_BONUS_CHANNEL_ID && !message.author.bot) {
      scheduleMessageDelete(message.client, message.id, message.channelId);
    }
  } catch (error) {
    console.error('메시지 자동 삭제 예약 중 오류:', error);
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
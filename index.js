const path = require('path');
// 실행 디렉터리(CWD)가 아니라 이 파일 기준으로 env를 찾는다 — systemd 등 다른 CWD에서 띄워도
// 토큰을 놓치지 않게. (파일명이 '.env'가 아니라 'env'인 것은 의도된 것)
require('dotenv').config({ path: path.join(__dirname, 'env') });
const { Client, GatewayIntentBits, Partials, Collection, MessageFlags, Events, Options } = require('discord.js');
const fs = require('fs');

// 예전 위치(루트)에 남아있던 JSON 저장 파일이 있다면 DB/ 폴더로 옮긴다(내용은 그대로, 위치만
// 이동). 콘솔에 명령어를 입력할 수 없는 호스팅(버튼으로만 시작/재시작)에서도 봇을 켤 때마다
// 자동으로 처리되도록, 아래 다른 모듈을 require하기 전에(=그 모듈들이 DB/ 파일을 읽기 전에)
// 가장 먼저 실행한다. 옮길 파일이 없으면 아무 일도 하지 않는다(migrate.js 참고).
require('./migrate').migrateOldDbFiles();

const { handleGameSelect, handleNaejeonModal, handleNaejeonEditModal, handleNaejeonButton, handleNaejeonMatchEditModal, handleNaejeonNotifyModal, handleTeamAssign, handleNaejeonMemberAdd, handleNaejeonMemberRemove, buildPublicMessagePayload: buildNaejeonMessagePayload } = require('./handlers/내전');
const { handleMojipGameSelect, handleMojipModal, handleMojipEditModal, handleMojipButton, handleMojipMatchEditModal, handleMojipNotifyModal, handleMojipMemberAdd, handleMojipMemberRemove, buildMojipMessagePayload } = require('./handlers/모집');
const { armAutoEnd, AUTO_CLOSE_DELAY_MS, GENERAL_MESSAGE_DELETE_DELAY_MS, announceMatchCompletionXp, scheduleCancelledDelete, scheduleMessageDelete, deleteMentionMessage, armNotifyReminder, ADMIN_IDS, saveAll, enableSaveNow, loadRows, recoverCancelledEmbeds } = require('./handlers/공용');
const { handleTeamMatchSelect, handleTeamButton, handleTeamAssignSelect } = require('./handlers/팀');
const { handleRMatchSelect } = require('./handlers/불러오기');
const { handleWcButton, handleWcMessage } = require('./handlers/끝말잇기');
const { handleTttButton } = require('./handlers/틱택토');
const { handleOmokButton, handleOmokMessage } = require('./handlers/오목');
const { loadRoulette, saveRoulette, handleRouletteButton } = require('./handlers/룰렛');
const { loadBotMatchXp, saveBotMatchXp } = require('./handlers/봇전한도');
const { loadRealmRoster, saveRealmRoster } = require('./forms/마크/명단');
const { startQuizScheduler, handleQuizMessage } = require('./handlers/퀴즈');
const { handleRaidButton, startRaidScheduler, isPlaygroundPaused, noteChannelMessage: noteRaidChannelMessage } = require('./handlers/레이드');
// 레이드 중 막는 명령어 → 안내 문구의 "~수 없습니다" 앞부분(문구는 룰렛 안내와 같은 형식으로 통일)
const RAID_PAUSED_COMMANDS = {
  끝말잇기: '끝말잇기를 할', 틱택토: '틱택토를 할', 오목: '오목을 둘', 룰렛: '룰렛을 돌릴',
  레벨: '레벨을 확인할', 랭킹: '랭킹을 확인할',
};
const { handleQuizAdminButton, handleQuizCreateModal } = require('./commands/퀴즈');
const { buildGameSelectPayload: buildNaejeonGameSelectPayload } = require('./commands/내전');
const { buildGameSelectPayload: buildMojipGameSelectPayload } = require('./commands/모집');
const { buildReloadListPayload } = require('./commands/불러오기');
const { buildTeamMatchListPayload } = require('./commands/팀');
const { buildCommandListPayload, buildSetupPanelPayload, buildAdminMenuPayload, handlePanelButton, handlePanelMatchDeleteSelect, handlePanelBotMessageDeleteModal, handlePanelSelectButton } = require('./commands/패널');
const { handleRealmButton, handleRealmModal, handleRealmRosterModal, initRulesAgreementCache, handleRealmRulesReactionAdd, handleRealmRulesReactionRemove } = require('./forms/마크');
const { handleCobblemonButton, startCobblemonOpenTimer } = require('./forms/코블몬');
const { handleLevelShareButton } = require('./commands/레벨');
const { handleRankingPageButton, handleRankingGotoButton, handleRankingGotoModal, handleRankingShareButton } = require('./commands/랭킹');
const { handleXpUserSelect, handleXpButton, handleXpModal } = require('./commands/XP');
const { loadLevels, saveLevels, loadXpState, handleMessageXp, trackVoiceStateUpdate, initVoiceStates, startVoiceXpTicker, announceLevelUp, MATCH_BONUS_CHANNEL_ID } = require('./handlers/레벨링');
const { handleTempVoiceState, reconcileTempChannels } = require('./handlers/음성채널');
const { logInteraction, logAction, logSystem, logError, logErrorThrottled, setLogClient, userLabel, flushLogsSync } = require('./handlers/로그');

// 끝말잇기/틱택토/랭킹 명령어와 관련 버튼을 이 채널에서만 사용할 수 있게 제한한다.
// ALLOWED_CHANNEL_IDS는 내전/모집/팀 상호작용을 허용할 채널 목록(비어 있으면 제한 없음).
const { WORDCHAIN_RANKING_CHANNEL_ID, ALLOWED_CHANNEL_IDS: allowedChannels, isTestGuild, GUILD_ID, TEST_GUILD_IDS } = require('./config');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers, // /랭킹의 대량 멤버 조회(guild.members.fetch({ user: [...] }))에 필요(특권 인텐트)
    GatewayIntentBits.GuildMessageReactions, // 마크 렐름 규정집 반응(✅) 실시간 캐싱에 필요(특권 아님)
  ],
  // 규정집 메시지가 MessageManager 캐시(줄 60대)에서 밀려난 뒤에도 반응 이벤트를 받으려면
  // 메시지/반응이 partial로라도 전달돼야 한다 — 이 둘이 없으면 discord.js가 캐시 안 된
  // 메시지의 반응 이벤트를 아예 emit하지 않는다.
  partials: [Partials.Message, Partials.Reaction],

  // ── 메모리 상한 ──────────────────────────────────────────────
  // 몇 달씩 켜두는 봇이라 discord.js 기본 캐시(유저·멤버·메시지)가 "한 번 본 것"을 계속
  // 들고 있으면서 메모리가 우상향한다. 이 봇의 핸들러는 필요한 유저/멤버/채널을 그때그때
  // .fetch()로 가져오고(전부 .catch(() => null) 처리), 게임/매치가 편집하는 메시지는 자기
  // 객체에 참조를 따로 들고 있어서 — 아래처럼 캐시를 줄이고 주기적으로 비워도 동작에 영향이 없다.
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 25,        // 채널당 캐시 메시지 상한 (기본 200)
    // ReactionManager는 기본값(무제한) 유지 — 0으로 두면 메시지를 새로 가져와도 반응이 캐시에
    // 저장되지 못해 항상 비어 보인다(마크 신청서의 규정집 반응 확인 기능이 이걸로 깨진 적 있음).
    GuildBanManager: 0,        // 밴 조회 안 함
    PresenceManager: 0,        // Presence 인텐트 없음(명시)
    ThreadManager: 0,          // 스레드 안 씀
    ThreadMemberManager: 0,
  }),
  sweepers: {
    ...Options.DefaultSweeperSettings,
    messages:     { interval: 600, lifetime: 900 },                                    // 10분마다 15분 지난 캐시 메시지 제거
    users:        { interval: 3600, filter: () => (u) => u.id !== u.client.user.id },  // 1시간마다 봇 외 유저 캐시 비움
    guildMembers: { interval: 3600, filter: () => (m) => m.id !== m.client.user.id },  // 1시간마다 봇 외 멤버 캐시 비움
  },
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

// 메시지/채널이 실제로 없거나(10008, 10003) 접근 권한이 없는(50001) 경우는 재시도해도 소용없다.
// 그 외 일시적인 네트워크/디스코드 오류로 항목을 버리면 임베드만 남고 추적이 끊기므로 몇 번 더 시도한다.
const PERMANENT_FETCH_ERROR_CODES = new Set([10003, 10008, 50001]);
async function fetchWithRetry(fetcher, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetcher();
    } catch (err) {
      if (attempt >= attempts || PERMANENT_FETCH_ERROR_CODES.has(err?.code)) throw err;
      await new Promise(resolve => setTimeout(resolve, attempt * 2000));
    }
  }
}

// ─── DB에서 내전/모집 복원 ────────────────────────────────────
// 봇이 켜질 때 N-M.json에 저장돼 있던 내전/모집을 다시 메모리로 불러옵니다.
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
        // cancelledAt이 없으면 그 시절 지연시간(당시 AUTO_CLOSE_DELAY_MS 값) 기준으로 취소
        // 시각을 역산해 복원한다 — scheduleCancelledDelete가 항상 최신 지연시간
        // (CANCELLED_DELETE_DELAY_MS)으로 다시 계산하므로 이미 지났으면 즉시 삭제된다.
        const cancelledAt = parsed.cancelledAt ?? (parsed.deleteAt - AUTO_CLOSE_DELAY_MS);
        scheduleCancelledDelete(c, row.message_id, row.channel_id, cancelledAt, parsed.title ?? null);
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
      const channel = await fetchWithRetry(() => c.channels.fetch(row.channel_id));
      match.message = await fetchWithRetry(() => channel.messages.fetch(row.message_id));
      // guildId가 없던 옛 데이터(업데이트 이전 생성분)도 실제 채널 기준으로 채워줍니다.
      match.guildId = channel.guildId;

      const map = row.type === 'naejeon' ? c.naejeonMatches : c.mojipMatches;
      map.set(row.message_id, match);

      // 봇이 꺼져있는 동안 임베드/버튼 코드가 바뀌었을 수 있으므로, 복원 시점에
      // 최신 코드 기준으로 메시지를 다시 그려 옛 라벨(예: "모집 완료")이 남지 않게 합니다.
      const buildPayload = row.type === 'naejeon' ? buildNaejeonMessagePayload : buildMojipMessagePayload;
      await match.message.edit(buildPayload(match)).catch(err => console.error('복원 후 메시지 갱신 중 오류:', err));

      // 봇이 꺼져있던 동안 setTimeout이 소실되므로, 마감(closed) 시점을 기준으로
      // AUTO_CLOSE_DELAY_MS 후 자동 삭제를 다시 스케줄링합니다. 이미 지났다면 즉시 삭제합니다.
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
    } catch (err) {
      // 메시지가 삭제됐거나 채널 접근 불가 → 그 항목은 버립니다.
      dropped++;
      if (!PERMANENT_FETCH_ERROR_CODES.has(err?.code)) {
        console.error('내전/모집 복원 실패:', err);
        logError('복원 실패', `${row.type} 메시지(${row.message_id}) 복원 실패 — 추적에서 빠짐`, err);
      }
    }
  }
  console.log(`♻️  복원 완료: ${ok}건 복원 / ${dropped}건 누락`);
}

// ─── 인증 채널 자동 삭제 예약 복구 ────────────────────────────
// scheduleMessageDelete는 messageCreate 이벤트에서만 걸리는데, 봇이 꺼져있던 동안
// (재시작 등) 인증 채널에 올라온 메시지는 그 이벤트를 아예 못 받아 예약이 안 걸린 채로
// 남는다. N-M.json 복원(restoreMatches)은 "이미 예약돼 있던" 항목만 되살릴 뿐 이런
// 누락은 못 잡으므로, 재시작 시 최근 메시지 기록을 직접 훑어서 예약이 빠진 메시지를 찾아
// 다시 건다. 최대 500개(5페이지) 또는 일반 메시지 자동삭제 지연시간의 3배치까지만 훑고,
// 그보다 오래된 건 예외적인 경우로 보고 포기한다(무한정 과거까지 훑지 않기 위함).
const CHANNEL_RECONCILE_LOOKBACK_MS = GENERAL_MESSAGE_DELETE_DELAY_MS * 3;
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
      scheduleMessageDelete(c, msg.id, msg.channelId, msg.createdTimestamp + GENERAL_MESSAGE_DELETE_DELAY_MS);
      recovered++;
    }

    const oldest = batch.last();
    if (batch.size < 100 || !oldest || oldest.createdTimestamp < cutoff) break;
    before = oldest.id;
  }
  if (recovered > 0) console.log(`♻️  인증 채널 자동 삭제 예약 복구: ${recovered}건`);
}

// 채널 제한 등으로 막힌 시도를 로그에 남긴다. logInteraction이 "무엇을 눌렀는지"는 이미 남기지만
// 그 결과가 "거부됨"이라는 건 안 보여서, "명령어가 안 먹혀요" 문의에 바로 답할 수 있게 따로 적는다.
function logBlocked(interaction, 사유) {
  try {
    if (interaction.customId?.startsWith('ttt:move:')) return; // 칸 클릭은 평소에도 로그에서 뺀다
    logAction(interaction, '차단', `${사유} — ${interaction.isChatInputCommand() ? `/${interaction.commandName}` : interaction.customId}`);
  } catch (err) {
    console.error('차단 로그 기록 실패:', err);
  }
}

// ─── 응답 지연·메모리 진단 ────────────────────────────────────
// 버튼을 누르자마자 ack하는 핸들러에서도 Unknown interaction(10062)이 몰려서 나고, 호스팅이
// 메모리 초과(exit 137)로 강제 종료한 적이 있다. 원인 후보는 셋이다:
//  (1) 이벤트 루프가 멈춤(CPU 25% 제한·GC) → 아래 '루프 지연 최대'가 커진다
//  (2) 게이트웨이 연결이 끊겼다 재개되며 밀린 이벤트가 늦게 도착 → '연결 재개' 로그가 같이 찍힌다
//  (3) 메모리가 256MB 한도에 근접 → RSS가 높게 찍힌다
// 콘솔로만 남긴다(호스팅 콘솔에서 바로 보이게). 평소엔 아무것도 출력하지 않는다.
const { monitorEventLoopDelay } = require('perf_hooks');
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
const SLOW_INTERACTION_MS = 2500;  // 디스코드 응답 제한(3초)에 근접한 상호작용만 기록
const MEMORY_WARN_RSS_MB = 230;   // 요금제 RAM 256MB 기준 경고선
// 로그가 얼마나 자주 반복되는지 보이도록 각 줄 앞에 KST 시각을 붙인다.
const { KST_OFFSET_MS } = require('./handlers/시간');
function diagWarn(msg) {
  const t = new Date(Date.now() + KST_OFFSET_MS).toISOString().slice(5, 19).replace('T', ' ');
  console.warn(`[${t}] ${msg} — ${diagSnapshot()}`);
}
function diagSnapshot() {
  const mem = process.memoryUsage();
  const mb = (n) => Math.round(n / 1048576);
  // 외부 = Buffer 등 V8 힙 밖에서 JS가 잡은 메모리. RSS에서 힙·외부를 빼고 남는 큰 덩어리는 네이티브 라이브러리 몫이다.
  const snap = `RSS ${mb(mem.rss)}MB · 힙 ${mb(mem.heapUsed)}/${mb(mem.heapTotal)}MB · 외부 ${mb(mem.external)}MB · 루프 지연 최대 ${Math.round(loopDelay.max / 1e6)}ms · 핑 ${client.ws.ping}ms`;
  loopDelay.reset();
  return snap;
}
let slowWarnedAt = 0, slowSkipped = 0;
function checkInteractionAge(interaction) {
  const ageMs = Date.now() - interaction.createdTimestamp;
  if (ageMs < SLOW_INTERACTION_MS) return;
  const now = Date.now();
  if (now - slowWarnedAt < 10_000) { slowSkipped++; return; } // 몰릴 때 콘솔 도배 방지
  diagWarn(`🐢 상호작용이 ${ageMs}ms 늦게 도착 (${interaction.customId ?? `/${interaction.commandName}`})${slowSkipped ? `, 그동안 ${slowSkipped}건 더` : ''}`);
  slowWarnedAt = now;
  slowSkipped = 0;
}
client.on(Events.ShardDisconnect, (event) => diagWarn(`🔌 게이트웨이 연결 끊김 (코드 ${event?.code ?? '-'})`));
client.on(Events.ShardReconnecting, () => diagWarn('🔌 게이트웨이 재연결 시도'));
client.on(Events.ShardResume, (_id, replayed) => diagWarn(`🔌 게이트웨이 연결 재개 — 밀린 이벤트 ${replayed}건 재전송`));
let memWarnedAt = 0;
// RSS가 지금까지의 최고치보다 MEMORY_STEP_MB 넘게 오를 때마다 한 줄 남긴다 — 어느 시점(레이드·명령어 등)에
// 메모리가 뛰는지 콘솔 시각으로 맞춰볼 수 있게. 최고치 기준이라 오르내리기만 하면 다시 찍히지 않는다.
const MEMORY_STEP_MB = 20;
let rssPeakMb = 0;
setInterval(() => {
  const rssMb = process.memoryUsage().rss / 1048576;
  if (rssPeakMb && rssMb > rssPeakMb + MEMORY_STEP_MB) diagWarn(`📈 메모리 최고치 갱신 (+${Math.round(rssMb - rssPeakMb)}MB)`);
  rssPeakMb = Math.max(rssPeakMb, rssMb);
  if (rssMb < MEMORY_WARN_RSS_MB) return;
  if (Date.now() - memWarnedAt < 30 * 60 * 1000) return;
  memWarnedAt = Date.now();
  diagWarn(`🧠 메모리 경고선(${MEMORY_WARN_RSS_MB}MB) 초과`);
}, 60_000);
// C 라이브러리 종류(glibc/musl)와 메모리 관련 환경변수 — 네이티브 메모리 대책을 고를 때 필요하다.
function runtimeInfo() {
  const glibc = process.report?.getReport?.()?.header?.glibcVersionRuntime;
  return `Node ${process.version} · ${process.platform}/${process.arch} · ${glibc ? `glibc ${glibc}` : 'glibc 아님(musl 등)'} · MALLOC_ARENA_MAX=${process.env.MALLOC_ARENA_MAX ?? '미설정'}`;
}

// ─── 봇 준비 완료 시 ──────────────────────────────────────────
// 이벤트 이름이 discord.js 버전에 따라 'ready'/'clientReady'로 다르므로 Events.ClientReady 상수를 쓴다.
// (문자열 'ready'를 직접 넘기면 v14.22+ 에서 DeprecationWarning이 뜬다.)
// _readyDone 플래그는 이벤트가 혹시 두 번 들어와도 한 번만 실행되게 막아준다.
let _readyDone = false;
// restoreMatches/loadLevels가 끝나기 전에는 저장 관련 데이터가 비어있는 상태라,
// 이 시점에 자동 저장(30초 간격)이 실행되면 아직 못 불러온 기존 데이터를 빈 값으로
// 덮어써버린다. 복원이 끝난 뒤에만 자동 저장이 돌게 막는 플래그.
let dataReady = false;
async function onReady(c) {
  if (_readyDone) return;
  _readyDone = true;
  console.log(`✅ 봇 로그인 완료: ${c.user.tag}`);
  setLogClient(c); // 로그에 유저 이름을 적을 때 캐시에서 찾기 위함
  c.startedAt = new Date();
  await restoreMatches(c); // ⬅️ 추가: 저장된 내전/모집 복원
  enableSaveNow(); // 복원이 끝났으므로 이제부터는 게시/취소 직후 바로 저장해도 안전하다
  await recoverCancelledEmbeds(c, new Set([...allowedChannels, MATCH_BONUS_CHANNEL_ID])); // 저장 파일에서 빠진 취소 임베드 삭제 예약 복구
  loadLevels(); // ⬅️ 추가: 저장된 레벨/XP 복원
  loadXpState(); // XP 긴급정지/뉴비부스트 스위치 상태 복원
  loadRoulette(); // 룰렛 일일 플레이 기록 복원
  loadBotMatchXp(); // 끝말잇기·틱택토 봇전 일일 XP 한도 기록 복원
  loadRealmRoster(); // 마인크래프트 렐름 승인 명단 복원
  startCobblemonOpenTimer(c); // 게시된 코블몬 패널을 최신 내용으로 갱신 + 설치기 오픈 시각에 버튼을 다운로드 링크로 전환
  await initRulesAgreementCache(c); // 렐름 규정집 반응(✅) 캐시 초기화
  initVoiceStates(c); // 재시작 전 이미 통화방에 있던 유저 추적 복원
  startVoiceXpTicker(c); // 통화방 체류 XP 1분 틱 시작
  await reconcileTempChannels(c); // 재시작 전 만들어둔 임시 음성채널 중 빈 방 정리
  await reconcileMatchBonusMessages(c); // 봇이 꺼져있던 동안 인증 채널에 올라와 예약이 빠진 메시지 복구
  startQuizScheduler(c); // 놀이터 채널에 하루 한 번 무작위 시각으로 상식퀴즈를 출제
  startRaidScheduler(c); // 약 3일마다 놀이터에 레이드 몬스터 출현
  dataReady = true;
  diagWarn(`📊 시작 직후 메모리 (${runtimeInfo()})`);
  rssPeakMb = process.memoryUsage().rss / 1048576;
  logSystem({
    유형: '봇 상태',
    내용: `봇 시작 — ${c.user.tag}, 서버 ${c.guilds.cache.size}개, 복원된 내전 ${c.naejeonMatches?.size ?? 0}건 / 모집 ${c.mojipMatches?.size ?? 0}건, Node ${process.version}`,
  });
}
client.once(Events.ClientReady, onReady);

// ─── 슬래시 명령어 자동 등록 ──────────────────────────────────
// 토큰이 호스팅에만 있어 deploy-commands.js를 따로 돌릴 수 없으므로, 켤 때마다 commands/ 폴더의
// 명령어 목록으로 길드 명령어를 통째로 덮어쓴다(deploy-commands.js와 같은 대상: GUILD_ID + TEST_GUILD_IDS).
// 같은 목록이면 디스코드 쪽에서 바뀌는 것이 없고, 명령어를 추가·삭제한 뒤 재시작하면 바로 반영된다.
async function syncGuildCommands(c) {
  const body = [...c.commands.values()].map(cmd => cmd.data); // 빌더를 그대로 넘기면 discord.js가 toJSON()한다(deploy-commands.js와 동일한 결과)
  const guildIds = [...new Set([...GUILD_ID.split(','), ...TEST_GUILD_IDS].map(id => id.trim()).filter(Boolean))];
  let synced = 0;
  for (const guildId of guildIds) {
    if (!c.guilds.cache.has(guildId)) continue; // 봇이 없는 길드는 등록할 수 없다
    try {
      await c.application.commands.set(body, guildId);
      synced++;
    } catch (err) {
      console.error(`명령어 등록 실패 (길드 ${guildId}):`, err);
      logError('봇 상태', `슬래시 명령어 등록 실패 (길드 ${guildId})`, err);
    }
  }
  console.log(`✅ 슬래시 명령어 ${body.length}개 등록 (길드 ${synced}곳)`);
}
client.once(Events.ClientReady, (c) => { syncGuildCommands(c).catch(err => console.error('명령어 등록 중 오류:', err)); });

client.on('interactionCreate', async (interaction) => {
  try {
    // 채널 제한 등으로 막히는 시도까지 포함해, 명령어/버튼/선택 메뉴/모달 제출을 전부 기록한다.
    // (아래에서 무엇이 됐든 판단하기 전에 가장 먼저 남겨야 실제로 들어온 입력을 놓치지 않음)
    // 로그 기록 실패(디스크 문제 등)가 실제 상호작용 처리까지 막아버리면 안 되므로 따로 감싼다.
    try { logInteraction(interaction); } catch (err) { console.error('상호작용 로그 기록 실패:', err); }
    checkInteractionAge(interaction);

    // 테스트 서버(config.js의 TEST_GUILD_IDS)에서는 아래 채널 제한을 전부 건너뛴다 —
    // 기능을 확인하려면 아무 채널에서나 쓸 수 있어야 하기 때문.
    const skipChannelLimits = isTestGuild(interaction.guildId);

    // 끝말잇기/틱택토/룰렛/레벨/랭킹은 다른 채널 허용 목록과 무관하게 이 채널에서만 사용 가능.
    const isWordchainOrRanking =
      (interaction.isChatInputCommand() && ['끝말잇기', '틱택토', '오목', '룰렛', '레벨', '랭킹'].includes(interaction.commandName)) ||
      interaction.customId?.startsWith('wc:') ||
      interaction.customId?.startsWith('ttt:') ||
      interaction.customId?.startsWith('omok:') ||
      interaction.customId?.startsWith('roulette:') ||
      interaction.customId?.startsWith('ranking:') ||
      interaction.customId?.startsWith('level:');

    if (isWordchainOrRanking && !skipChannelLimits && interaction.channelId !== WORDCHAIN_RANKING_CHANNEL_ID) {
      logBlocked(interaction, '게임/랭킹 전용 채널이 아니라서 거부');
      if (interaction.isRepliable()) {
        await interaction.reply({ content: '❌ 이 채널에서는 사용할 수 없습니다.', flags: MessageFlags.Ephemeral });
      }
      return;
    }

    // 레이드 진행 중에는 놀이터 미니게임·/레벨·/랭킹을 쓸 수 없다(그 서버의 레이드일 때만 — 서버별로 따로).
    // 이미 진행 중이던 판은 그대로 끝까지 둔다(XP는 어차피 멈춤).
    if (interaction.isChatInputCommand() && RAID_PAUSED_COMMANDS[interaction.commandName] && isPlaygroundPaused(interaction.guildId)) {
      logBlocked(interaction, '레이드 진행 중이라 놀이터 일시 정지');
      await interaction.reply({ content: `👾 **몬스터 때문에 XP 시스템이 고장 나 ${RAID_PAUSED_COMMANDS[interaction.commandName]} 수 없습니다.**`, flags: MessageFlags.Ephemeral });
      return;
    }

    // 불러오기(재게시)는 완료 보너스 채널 밖에서 쓰면 match.message.channelId가 바뀌어
    // XP 보너스 자격이 어긋나므로, 이 채널에서만 쓸 수 있게 막는다.
    const isReload =
      (interaction.isChatInputCommand() && interaction.commandName === '불러오기') ||
      interaction.customId === 'reload:select' ||
      interaction.customId === 'recruit:불러오기';

    if (isReload && !skipChannelLimits && interaction.channelId !== MATCH_BONUS_CHANNEL_ID) {
      logBlocked(interaction, '불러오기 허용 채널이 아니라서 거부');
      if (interaction.isRepliable()) {
        await interaction.reply({ content: '❌ 이 채널에서는 사용할 수 없습니다.', flags: MessageFlags.Ephemeral });
      }
      return;
    }

    const isChannelExempt =
      (interaction.isChatInputCommand() && ['패널', '퀴즈', 'xp'].includes(interaction.commandName)) ||
      isWordchainOrRanking ||
      isReload ||
      interaction.customId?.startsWith('quiz:') ||
      interaction.customId?.startsWith('xp:') ||
      interaction.customId?.startsWith('realm:') ||
      interaction.customId?.startsWith('cobblemon:') ||
      interaction.customId?.startsWith('raid:') || // 레이드는 출현한 채널(놀이터·테스트 채널)에서 그대로 진행
      interaction.customId?.startsWith('form:');

    if (!isChannelExempt && !skipChannelLimits) {
      if (allowedChannels.length > 0 && !allowedChannels.includes(interaction.channelId)) {
        logBlocked(interaction, '허용 채널 목록에 없어서 거부');
        if (interaction.isRepliable()) {
          await interaction.reply({ content: '❌ 이 채널에서는 사용할 수 없습니다.', flags: MessageFlags.Ephemeral });
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
      } else if (interaction.customId === 'xp:pick') {
        await handleXpUserSelect(interaction);
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
      } else if (interaction.customId === 'reload:select') {
        await handleRMatchSelect(interaction);
      } else if (interaction.customId.startsWith('panel:match_delete_select:')) {
        await handlePanelMatchDeleteSelect(interaction);
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
      } else if (interaction.customId === 'quiz:create_modal') {
        await handleQuizCreateModal(interaction);
      } else if (interaction.customId.startsWith('panel:bot_msg_delete_modal:')) {
        await handlePanelBotMessageDeleteModal(interaction);
      } else if (interaction.customId === 'ranking:goto_modal') {
        await handleRankingGotoModal(interaction);
      } else if (interaction.customId.startsWith('xp:')) {
        await handleXpModal(interaction);
      } else if (interaction.customId === 'realm:modal') {
        await handleRealmModal(interaction);
      } else if (interaction.customId.startsWith('realm:roster:')) {
        await handleRealmRosterModal(interaction);
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
      } else if (interaction.customId.startsWith('omok:')) {
        await handleOmokButton(interaction);
      } else if (interaction.customId.startsWith('roulette:')) {
        await handleRouletteButton(interaction);
      } else if (interaction.customId.startsWith('quiz:')) {
        await handleQuizAdminButton(interaction);
      } else if (interaction.customId.startsWith('level:share:')) {
        await handleLevelShareButton(interaction);
      } else if (interaction.customId.startsWith('ranking:page:')) {
        await handleRankingPageButton(interaction);
      } else if (interaction.customId.startsWith('ranking:goto:')) {
        await handleRankingGotoButton(interaction);
      } else if (interaction.customId.startsWith('ranking:share:')) {
        await handleRankingShareButton(interaction);
      } else if (interaction.customId.startsWith('xp:')) {
        await handleXpButton(interaction);
      } else if (interaction.customId === 'recruit:내전') {
        await interaction.reply(buildNaejeonGameSelectPayload(interaction.user.id));
      } else if (interaction.customId === 'recruit:모집') {
        await interaction.reply(buildMojipGameSelectPayload());
      } else if (interaction.customId === 'recruit:불러오기') {
        await interaction.reply(buildReloadListPayload(interaction));
      } else if (interaction.customId === 'recruit:팀') {
        await interaction.reply(buildTeamMatchListPayload(interaction));
      } else if (interaction.customId === 'recruit:명령어') {
        await interaction.reply(buildCommandListPayload());
      } else if (interaction.customId === 'recruit:관리') {
        if (!ADMIN_IDS.includes(interaction.user.id)) {
          logBlocked(interaction, '관리자 권한 없음');
          await interaction.reply({ content: '❌ **권한이 없습니다.**', flags: MessageFlags.Ephemeral });
        } else {
          await interaction.reply({ ...buildAdminMenuPayload(interaction.message.id), flags: MessageFlags.Ephemeral });
        }
      } else if (interaction.customId.startsWith('panel:')) {
        await handlePanelButton(interaction);
      } else if (interaction.customId.startsWith('form:')) {
        await handlePanelSelectButton(interaction);
      } else if (interaction.customId.startsWith('realm:')) {
        await handleRealmButton(interaction);
      } else if (interaction.customId.startsWith('cobblemon:')) {
        await handleCobblemonButton(interaction);
      } else if (interaction.customId.startsWith('raid:')) {
        await handleRaidButton(interaction);
      }
    }
  } catch (error) {
    // 응답 제한(3초)을 넘겨 만료된 상호작용. 코드 오류가 아니라 지연 때문이고(원인은 위 🐢 진단 로그),
    // 이미 만료돼 안내 메시지도 보낼 수 없으므로 스택 대신 한 줄만 남긴다.
    if (error?.code === 10062) {
      console.warn(`⌛ 만료된 상호작용(10062): ${interaction.customId ?? `/${interaction.commandName}`}, ${Date.now() - interaction.createdTimestamp}ms 경과`);
      logErrorThrottled('interaction:expired', '처리 오류', '응답 제한(3초)을 넘겨 만료된 상호작용(10062)', error);
      return;
    }
    console.error(error);
    logError('처리 오류', `${interaction.isChatInputCommand?.() ? `/${interaction.commandName}` : interaction.customId ?? '알 수 없는 상호작용'} 처리 중 오류 발생`, error, {
      유저: interaction.user ? userLabel(interaction.user.id) : '-',
      채널: interaction.guildId ? `#${interaction.channel?.name ?? interaction.channelId}` : 'DM',
    });
    const msg = { content: '❌ 처리 중 오류가 발생했습니다.', flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
});

client.on('messageCreate', async (message) => {
  // 레이드 채널에 채팅이 올라오면 레이드 메시지를 맨 아래로 다시 올린다(묻히지 않게)
  try {
    noteRaidChannelMessage(message);
  } catch (error) {
    console.error('레이드 메시지 위치 확인 중 오류:', error);
  }

  try {
    await handleWcMessage(message);
  } catch (error) {
    console.error(error);
    logErrorThrottled('msg:wc', '처리 오류', '끝말잇기 메시지 처리 중 오류', error);
  }

  try {
    await handleOmokMessage(message);
  } catch (error) {
    console.error(error);
    logErrorThrottled('msg:omok', '처리 오류', '오목 메시지 처리 중 오류', error);
  }

  try {
    await handleQuizMessage(message);
  } catch (error) {
    console.error(error);
    logErrorThrottled('msg:quiz', '처리 오류', '퀴즈 정답 처리 중 오류', error);
  }

  try {
    const result = handleMessageXp(message);
    if (result?.leveledUp) {
      await announceLevelUp(message.client, message.guild.id, message.author.id, result.newLevel);
    }
  } catch (error) {
    console.error(error);
    logErrorThrottled('msg:xp', '처리 오류', '메시지 XP 처리 중 오류', error);
  }

  // 내전/모집 인증 채널에 올라온 일반 유저 메시지는 GENERAL_MESSAGE_DELETE_DELAY_MS 후 자동 삭제한다(봇 메시지는 제외).
  try {
    if (message.channelId === MATCH_BONUS_CHANNEL_ID && !message.author.bot) {
      scheduleMessageDelete(message.client, message.id, message.channelId);
    }
  } catch (error) {
    console.error('메시지 자동 삭제 예약 중 오류:', error);
    logErrorThrottled('msg:autodelete', '처리 오류', '메시지 자동 삭제 예약 중 오류', error);
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    trackVoiceStateUpdate(oldState, newState);
  } catch (error) {
    console.error('음성 상태 추적 실패:', error);
    logErrorThrottled('voice:track', '처리 오류', '음성 상태 추적 실패', error);
  }

  try {
    await handleTempVoiceState(oldState, newState);
  } catch (error) {
    console.error('임시 음성채널 처리 실패:', error);
    logErrorThrottled('voice:temp', '처리 오류', '임시 음성채널 처리 실패', error);
  }
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    await handleRealmRulesReactionAdd(reaction, user);
  } catch (error) {
    console.error('렐름 규정집 반응 추가 처리 실패:', error);
    logErrorThrottled('realm:react-add', '처리 오류', '렐름 규정집 반응 추가 처리 실패', error);
  }
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
  try {
    await handleRealmRulesReactionRemove(reaction, user);
  } catch (error) {
    console.error('렐름 규정집 반응 제거 처리 실패:', error);
    logErrorThrottled('realm:react-remove', '처리 오류', '렐름 규정집 반응 제거 처리 실패', error);
  }
});

// ─── 자동 저장 (30초마다) ─────────────────────────────────────
// 봇이 갑자기 죽어도(크래시) 최대 30초 전 상태까지는 보존됩니다.
// dataReady가 true가 되기 전(복원 완료 전)에는 저장을 건너뛴다 — 안 그러면
// 아직 비어있는 메모리 상태로 기존 N-M.json/levels.json을 덮어써 초기화시킨다.
setInterval(() => {
  if (!dataReady) return;
  try { saveAll(client); } catch (e) { console.error('자동 저장 실패:', e); logErrorThrottled('save:matches', '저장 오류', '내전/모집 자동 저장 실패', e); }
  try { saveLevels(); } catch (e) { console.error('레벨 자동 저장 실패:', e); logErrorThrottled('save:levels', '저장 오류', 'levels.json 자동 저장 실패 — XP가 디스크에 반영되지 않는 중', e); }
  try { saveRoulette(); } catch (e) { console.error('룰렛 자동 저장 실패:', e); logErrorThrottled('save:roulette', '저장 오류', 'roulette.json 자동 저장 실패', e); }
  try { saveBotMatchXp(); } catch (e) { console.error('봇전 XP 한도 자동 저장 실패:', e); logErrorThrottled('save:botxp', '저장 오류', 'botMatchXp.json 자동 저장 실패', e); }
  try { saveRealmRoster(); } catch (e) { console.error('렐름 승인 명단 자동 저장 실패:', e); logErrorThrottled('save:roster', '저장 오류', 'realm_roster.json 자동 저장 실패', e); }
}, 30_000);

// ─── 예기치 못한 예외로 봇 전체가 죽지 않도록 ─────────────────
// 타이머 콜백(예: 끝말잇기 턴 타이머)에서 예외가 나면 uncaughtException으로 프로세스가
// 그대로 종료돼, 진행 중이던 게임 임베드가 전부 '진행 중'인 채 얼어붙고 아무 반응도
// 하지 않게 된다. 원인은 로그로 남기되 프로세스는 계속 살려둔다.
// 단, ws의 'Opening handshake has timed out'은 예외: @discordjs/ws가 재연결 도중 아직 접속 중인
// 소켓을 버리면서 onerror만 떼고 닫지는 않아, 30초 뒤 그 소켓의 핸드셰이크 타임아웃이 리스너 없는
// 'error'로 터진다(최신 2.x도 동일). 새 연결은 따로 진행 중이라 봇엔 영향이 없으니 한 줄 경고로만 남긴다.
function isOrphanedHandshakeTimeout(err) {
  return err?.message === 'Opening handshake has timed out' && /[\\/]ws[\\/]lib[\\/]websocket\.js/.test(err.stack ?? '');
}
process.on('uncaughtException', (err) => {
  if (isOrphanedHandshakeTimeout(err)) {
    diagWarn('🔌 버려진 게이트웨이 소켓 핸드셰이크 타임아웃 (무시됨)');
    return;
  }
  console.error('처리되지 않은 예외:', err);
  logError('치명 오류', '처리되지 않은 예외(uncaughtException) — 봇은 계속 실행 중', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('처리되지 않은 Promise 거부:', reason);
  logError('치명 오류', '처리되지 않은 Promise 거부(unhandledRejection)', reason);
});

// ─── 종료 시 마지막으로 한 번 더 저장 ─────────────────────────
function shutdown(signal) {
  logSystem({ 유형: '봇 상태', 내용: `봇 종료 — ${signal} 수신, 가동 ${client.readyAt ? `${Math.round((Date.now() - client.readyAt.getTime()) / 60000)}분` : '-'}` });
  if (dataReady) {
    try { saveAll(client); } catch (e) { console.error('종료 저장 실패:', e); }
    try { saveLevels(); } catch (e) { console.error('레벨 종료 저장 실패:', e); }
    try { saveRoulette(); } catch (e) { console.error('룰렛 종료 저장 실패:', e); }
    try { saveBotMatchXp(); } catch (e) { console.error('봇전 XP 한도 종료 저장 실패:', e); }
    try { saveRealmRoster(); } catch (e) { console.error('렐름 승인 명단 종료 저장 실패:', e); }
  }
  // 로그는 dataReady와 무관하게(복원 전에 눌린 상호작용도 남아 있으므로) 항상 밀어 넣는다.
  // 평소 저장은 비동기라 아래 process.exit()에 끊길 수 있어, 여기서만 동기로 마무리한다.
  flushLogsSync();
  client.destroy();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ─── 로그인 대기 진단 ─────────────────────────────────────────
// discord.js는 로그인 중 REST 429를 받으면 Retry-After만큼 말없이 기다리고, 게이트웨이 접속이
// 막혀도 debug 이벤트만 남긴 채 재시도한다. 어느 쪽이든 login()이 성공도 실패도 아닌 상태로 멈춰
// 콘솔에 아무것도 안 남는다. 콘솔로 명령어를 칠 수 없는 호스팅이라 준비 완료 전까지만 discord.js
// 내부 로그를 모아뒀다가, 토큰이 필요 없는 API 응답과 함께 주기적으로 출력한다.
const LOGIN_DIAG_INTERVAL_MS = 30_000;
const LOGIN_DIAG_MAX_LINES = 12;
const loginDiagLines = [];
function recordLoginDiag(message) {
  const line = String(message).replace(/\s*\n\s*/g, ' | ');
  // discord.js가 마스킹해도 토큰 앞부분은 남으므로, 콘솔 로그를 어디 붙여넣어도 괜찮게 뺀다.
  if (line.startsWith('Provided token') || loginDiagLines.at(-1) === line) return;
  loginDiagLines.push(line);
  if (loginDiagLines.length > LOGIN_DIAG_MAX_LINES) loginDiagLines.shift();
}
async function probeDiscordApi() {
  try {
    const res = await fetch('https://discord.com/api/v10/gateway', { signal: AbortSignal.timeout(10_000) });
    const body = (await res.text()).slice(0, 120);
    return `HTTP ${res.status}, retry-after=${res.headers.get('retry-after') ?? '-'}, 본문=${body}`;
  } catch (err) {
    return `접속 실패 — ${err.cause?.code ?? err.name}: ${err.message}`;
  }
}
const loginDiagStartedAt = Date.now();
const loginDiagTimer = setInterval(async () => {
  const lines = loginDiagLines.join('\n  ');
  const probe = await probeDiscordApi();
  if (client.isReady()) return; // 응답을 기다리는 사이 준비가 끝났으면 출력할 이유가 없다
  console.warn(`⏳ 로그인 ${Math.round((Date.now() - loginDiagStartedAt) / 1000)}초째 대기 중 — Discord API 응답: ${probe}\n  ${lines}`);
}, LOGIN_DIAG_INTERVAL_MS);
client.on(Events.Debug, recordLoginDiag);
client.rest.on('restDebug', recordLoginDiag);
client.once(Events.ClientReady, () => {
  clearInterval(loginDiagTimer);
  client.off(Events.Debug, recordLoginDiag);
  client.rest.off('restDebug', recordLoginDiag);
});

// 토큰이 없거나 잘못된 경우 unhandled rejection으로 조용히 죽지 않도록 이유를 남기고 종료한다.
client.login(process.env.TOKEN).catch(err => {
  console.error('로그인 실패:', err);
  logError('봇 상태', '디스코드 로그인 실패 — 프로세스 종료', err);
  flushLogsSync();
  process.exit(1);
});
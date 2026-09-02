// 룰렛.js — 하루 한 번, XP를 걸고 돌리는 슬롯머신형 솔로(대 봇) 도박 게임.
// 이름은 "룰렛"이지만 실제 방식은 슬롯머신(3릴 심볼 매칭)이다.
// 베팅은 옵션 입력이 아니라 로비 임베드의 버튼으로 고르고, 베팅을 고르면 🎰 돌리기 버튼이 활성화된다.

const fs = require('fs');
const path = require('path');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { applyXp, getXp, levelFromXp, isExcludedGuild, announceLevelUp, isMinigameXpFrozen } = require('./레벨링');
const { kstDateString, timeUntilKstMidnight } = require('./시간');
const { logSystem } = require('./로그');
const { writeJsonIfChanged } = require('./저장');

const ROULETTE_PATH = path.join(__dirname, '..', 'DB', 'roulette.json');
fs.mkdirSync(path.dirname(ROULETTE_PATH), { recursive: true });

const MIN_BET = 10;
const MAX_BET = 300;
const BET_PRESETS = [10, 50, 100, 200, 300];
const LOBBY_TIMEOUT_MS = 60 * 1000;

// 릴 심볼별 가중치(합 100) — 값이 클수록 자주 나옴. 트리플 배당은 아래 PAYOUTS 참고.
// 가중치를 살짝 평평하게(체리 35→33, 세븐 2→3 등) 조정해 "2개 일치" 확률을 52%→50%대로 소폭만 낮춤.
const SYMBOLS = [
  { key: '🍒', weight: 33 },
  { key: '🍋', weight: 24 },
  { key: '🍇', weight: 19 },
  { key: '🔔', weight: 13 },
  { key: '💎', weight: 8 },
  { key: '7️⃣', weight: 3 },
];

// 심볼 3개가 모두 같을 때(트리플)의 배당 배율. 두 개만 같으면 공통으로 1.2배, 다 다르면 0배(전액 손실).
// 기댓값 약 0.74배(하우스 엣지 약 26%)로 설계됨 — 2개 일치 약 50%, 트리플 약 5.9%, 꽝 약 44%.
const TRIPLE_PAYOUTS = { '🍒': 2, '🍋': 2.5, '🍇': 3, '🔔': 4, '💎': 5, '7️⃣': 10 };
const TWO_MATCH_PAYOUT = 1.2;

// 결과 메시지에서 "레몬 트리플 매칭"처럼 어떤 심볼로 맞췄는지 보여주기 위한 이름표.
const SYMBOL_NAMES = { '🍒': '체리', '🍋': '레몬', '🍇': '포도', '🔔': '벨', '💎': '다이아몬드', '7️⃣': '세븐' };

let roulette = {}; // { [guildId]: { [userId]: "YYYY-MM-DD"(KST, 마지막 플레이 날짜) } }

function loadRoulette() {
  try {
    if (fs.existsSync(ROULETTE_PATH)) {
      roulette = JSON.parse(fs.readFileSync(ROULETTE_PATH, 'utf8'));
    }
  } catch (err) {
    // 초기화되면 오늘 이미 돌린 사람도 다시 돌릴 수 있게 된다(일일 1회 제한이 풀림).
    console.error('룰렛 기록 읽기 실패(일일 제한이 초기화됨):', err);
    logSystem({ 유형: '저장 오류', 내용: `roulette.json 읽기 실패 — 일일 플레이 기록 초기화됨: ${err?.message ?? err}` });
    roulette = {};
  }
}

function saveRoulette() {
  writeJsonIfChanged(ROULETTE_PATH, roulette);
}

function getGuildRoulette(guildId) {
  if (!roulette[guildId]) roulette[guildId] = {};
  return roulette[guildId];
}

function hasPlayedToday(guildId, userId) {
  return getGuildRoulette(guildId)[userId] === kstDateString();
}

function markPlayedToday(guildId, userId) {
  getGuildRoulette(guildId)[userId] = kstDateString();
}

function spinReel() {
  const totalWeight = SYMBOLS.reduce((sum, s) => sum + s.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const s of SYMBOLS) {
    if (roll < s.weight) return s.key;
    roll -= s.weight;
  }
  return SYMBOLS[SYMBOLS.length - 1].key;
}

// 릴 3개 결과로 배당 배율을 계산. { multiplier, kind } 반환 (kind: 'triple'|'two'|'none').
// symbol: 트리플일 때 맞춘 심볼 — 결과 메시지에 "레몬 트리플 매칭"처럼 종류를 적는 데 사용.
// 더블은 어떤 심볼이든 배당이 같아 종류를 표기하지 않으므로 symbol을 채우지 않는다.
function resolvePayout(reels) {
  const [a, b, c] = reels;
  if (a === b && b === c) return { multiplier: TRIPLE_PAYOUTS[a], kind: 'triple', symbol: a };
  if (a === b || b === c || a === c) return { multiplier: TWO_MATCH_PAYOUT, kind: 'two', symbol: null };
  return { multiplier: 0, kind: 'none', symbol: null };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 릴 3개 중 어느 인덱스끼리 심볼이 같은지(당첨 조합) 반환 — 결과 버튼을 초록으로 강조하는 데 사용.
function getMatchIndices(reels) {
  const [a, b, c] = reels;
  if (a === b && b === c) return [0, 1, 2];
  if (a === b) return [0, 1];
  if (b === c) return [1, 2];
  if (a === c) return [0, 2];
  return [];
}

// 릴 3개를 버튼 3개(비활성)로 그린다 — winIndices에 포함된 릴은 초록으로 강조.
function buildReelRow(lobbyId, display, winIndices = []) {
  const buttons = display.map((symbol, i) =>
    new ButtonBuilder()
      .setCustomId(`roulette:reel:${lobbyId}:${i}`)
      .setLabel(symbol)
      .setStyle(winIndices.includes(i) ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(true),
  );
  return new ActionRowBuilder().addComponents(...buttons);
}

// 틱 하나당 message.edit이 한 번 나간다. 예전엔 180ms 간격 12회(2.2초에 12번 수정)였는데,
// 디스코드는 같은 메시지 수정에 라우트별 레이트리밋을 빡빡하게 걸어서(대략 5초에 5회 수준)
// 거의 매번 걸렸다. discord.js가 알아서 큐에 넣고 기다리므로 오류가 나는 대신 연출이
// 늘어지고, 그동안 같은 라우트의 다른 요청까지 뒤에 밀린다. 전체 길이(약 2.4초)는 그대로
// 두고 호출 횟수만 절반으로 줄인다.
const SPIN_TICKS = 6;
const SPIN_TICK_MS = 400;
const REEL_STOP_AT = [2, 4, 5]; // 각 릴이 최종값에 고정되는 틱(순서대로 하나씩 멈춤 — 마지막 틱에 결과 완성)

// 실제 슬롯머신처럼 릴이 하나씩 순서대로 멈추는 애니메이션. finalReels는 이미 정해진 결과이고,
// 여기서는 그 결과가 드러나기 전까지 버튼 라벨을 무작위 심볼로 계속 바꿔가며 "돌아가는" 연출만 한다.
async function animateSpin(message, lobbyId, finalReels) {
  const display = ['🎰', '🎰', '🎰'];
  for (let tick = 0; tick < SPIN_TICKS; tick++) {
    for (let i = 0; i < 3; i++) {
      display[i] = tick >= REEL_STOP_AT[i] ? finalReels[i] : spinReel();
    }
    await message.edit({ components: [buildReelRow(lobbyId, display)] }).catch(() => {});
    await sleep(SPIN_TICK_MS);
  }
}

function getLobbies(client) {
  if (!client.rouletteLobbies) client.rouletteLobbies = new Map();
  return client.rouletteLobbies;
}

function buildLobbyEmbed(lobby) {
  const betLine = lobby.bet ? `**${lobby.bet} XP**` : '*아직 선택 안 함*';
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎰 룰렛머신')
    .setDescription(
      `<@${lobby.userId}>님, 베팅 XP를 고른 뒤 **🎰 돌리기**를 누르세요.\n\n` +
      `💰 선택한 베팅: ${betLine}\n` +
      `📊 최대 베팅 가능: **${lobby.maxAvailable} XP**`,
    )
    .setFooter({ text: '⏰ 60초 안에 돌리지 않으면 자동으로 취소됩니다.' })
    .setTimestamp();
}

function buildBetRow(lobby) {
  const buttons = BET_PRESETS.map(amount => {
    const disabled = amount > lobby.maxAvailable;
    const selected = lobby.bet === amount;
    return new ButtonBuilder()
      .setCustomId(`roulette:bet:${lobby.id}:${amount}`)
      .setLabel(`${amount} XP`)
      .setStyle(selected ? ButtonStyle.Success : ButtonStyle.Primary)
      .setDisabled(disabled);
  });
  return new ActionRowBuilder().addComponents(...buttons);
}

function buildControlRow(lobby) {
  const maxSelected = lobby.bet === lobby.maxAvailable;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`roulette:max:${lobby.id}`)
      .setLabel(`🔺 최대 (${lobby.maxAvailable})`)
      .setStyle(maxSelected ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`roulette:spin:${lobby.id}`)
      .setLabel('🎰 돌리기')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!lobby.bet),
    new ButtonBuilder()
      .setCustomId(`roulette:cancel:${lobby.id}`)
      .setLabel('❌ 취소')
      .setStyle(ButtonStyle.Danger),
  );
}

function buildLobbyComponents(lobby) {
  return [buildBetRow(lobby), buildControlRow(lobby)];
}

async function startRouletteCommand(interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  if (isExcludedGuild(guildId)) {
    await interaction.reply({ content: '⚠️ **이 서버에서는 룰렛을 이용할 수 없습니다.**', flags: MessageFlags.Ephemeral });
    return;
  }

  if (hasPlayedToday(guildId, userId)) {
    await interaction.reply({
      content: `⏳ **오늘은 이미 룰렛을 돌렸습니다.**\n다음 판까지 약 ${timeUntilKstMidnight()} 남았어요.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const currentLevelXp = levelFromXp(getXp(guildId, userId)).currentLevelXp;
  if (currentLevelXp < MIN_BET) {
    await interaction.reply({
      content: `⚠️ **베팅 가능한 XP가 부족합니다.**\n(최소 ${MIN_BET} XP 필요, 현재 레벨 안 보유 XP: ${currentLevelXp})`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lobbies = getLobbies(interaction.client);
  const lobby = {
    id: interaction.id,
    guildId,
    userId,
    bet: null,
    maxAvailable: Math.min(MAX_BET, currentLevelXp),
    interaction,
    timeoutId: null,
  };
  lobbies.set(lobby.id, lobby);

  // 로비는 본인에게만 보이게(ephemeral) 띄우고, 결과는 스핀 시점에 채널에 공개 메시지로 따로 보낸다.
  await interaction.reply({ embeds: [buildLobbyEmbed(lobby)], components: buildLobbyComponents(lobby), flags: MessageFlags.Ephemeral });

  lobby.timeoutId = setTimeout(async () => {
    const l = lobbies.get(lobby.id);
    if (!l) return;
    lobbies.delete(lobby.id);
    await l.interaction.editReply({ content: '⏰ **시간 초과로 룰렛이 취소되었습니다.**', embeds: [], components: [] }).catch(() => {});
  }, LOBBY_TIMEOUT_MS);
}

async function spinLobby(interaction, lobby, lobbies) {
  clearTimeout(lobby.timeoutId);
  lobbies.delete(lobby.id);

  // 이후 로직(스핀 계산, XP 정산, 채널 메시지 전송)이 3초를 넘기면 디스코드가 "상호작용 실패"로
  // 처리해버리는데, 그 시점엔 이미 markPlayedToday/applyXp가 끝나 있어 유저는 기회만 날리고
  // 결과도 못 보는 상황이 생길 수 있었다. 응답부터 먼저 확정해 이 경합을 없앤다.
  await interaction.deferUpdate();

  // 관리자 긴급정지 중이면 오늘 기회를 소모하지 않고 안내만 한다.
  if (isMinigameXpFrozen()) {
    await interaction.editReply({ content: '⚙️ **현재 관리자가 미니게임 XP를 일시 중지해 룰렛을 돌릴 수 없습니다.**', embeds: [], components: [] });
    return;
  }

  // 로비가 열려있던 사이(다른 곳에서) 이미 오늘 플레이했거나 XP가 줄어들었을 수 있으므로 재검증.
  if (hasPlayedToday(lobby.guildId, lobby.userId)) {
    await interaction.editReply({ content: '⏳ **오늘은 이미 룰렛을 돌렸습니다.**', embeds: [], components: [] });
    return;
  }
  const currentLevelXp = levelFromXp(getXp(lobby.guildId, lobby.userId)).currentLevelXp;
  const bet = Math.min(lobby.bet, currentLevelXp);
  if (bet < MIN_BET) {
    await interaction.editReply({ content: '⚠️ **베팅 가능한 XP가 부족해졌습니다.**', embeds: [], components: [] });
    return;
  }

  markPlayedToday(lobby.guildId, lobby.userId);

  const reels = [spinReel(), spinReel(), spinReel()];
  const { multiplier, kind, symbol } = resolvePayout(reels);
  const payout = Math.round(bet * multiplier);
  const net = payout - bet;

  const result = applyXp(lobby.guildId, lobby.userId, net);

  const symbolLabel = symbol ? `${symbol} ${SYMBOL_NAMES[symbol]}` : '';

  const resultLine =
    kind === 'triple'
      ? symbol === '7️⃣'
        ? `🎉 **JACKPOT!** (x${multiplier})`
        : `**${symbolLabel} 트리플 매칭!** (x${multiplier})`
      : kind === 'two'
        ? `🙂 **더블 매칭!** (x${multiplier})`
        : `😢 **꽝**`;

  const netLine = net >= 0 ? `📈 **+${net} XP**` : `📉 **${net} XP**`;

  const spinningEmbed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎰 룰렛머신')
    .setDescription(`<@${lobby.userId}>님이 **${bet} XP**를 걸고 돌립니다...\n\n🎰 릴이 돌아가는 중...`)
    .setTimestamp();

  const resultEmbed = new EmbedBuilder()
    .setColor(net > 0 ? 0xFFD700 : 0x808080)
    .setTitle('🎰 룰렛머신')
    .setDescription(
      `<@${lobby.userId}>님이 **${bet} XP**를 걸었습니다.\n\n` +
      `${resultLine}\n\n${netLine}`,
    )
    .setFooter({ text: '⏰ 하루에 한 번만 돌릴 수 있어요.' })
    .setTimestamp();

  // 베팅 과정은 본인에게만 보였지만, 결과는 채널 전체에 공개 메시지로 실제 슬롯머신처럼
  // 릴이 하나씩 순서대로 멈추는 연출과 함께 알린다. XP 정산은 이미 끝났으므로, 채널 공개
  // 과정에서 오류가 나더라도(권한 문제 등) 최소한 본인에게는 결과를 보여준다.
  try {
    // content/embeds/components를 전부 비운 editReply는 디스코드가 "빈 메시지"로 보고 거부한다
    // (DiscordAPIError[50006]) — 그냥 로비 메시지를 지워서 정리한다.
    await interaction.deleteReply();
    // interaction.channel은 캐시에 없으면 null일 수 있으므로(재시작 직후 등) fetch로 안전하게 가져온다.
    const channel = interaction.channel ?? await interaction.client.channels.fetch(interaction.channelId);
    const spinMessage = await channel.send({
      embeds: [spinningEmbed],
      components: [buildReelRow(lobby.id, ['🎰', '🎰', '🎰'])],
    });

    await animateSpin(spinMessage, lobby.id, reels);
    await spinMessage.edit({ embeds: [resultEmbed], components: [buildReelRow(lobby.id, reels, getMatchIndices(reels))] }).catch(() => {});
  } catch (err) {
    console.error('룰렛 결과 공개 실패:', err);
    await interaction.editReply({ content: '', embeds: [resultEmbed], components: [] }).catch(() => {});
  }

  if (result.leveledUp) {
    announceLevelUp(interaction.client, lobby.guildId, lobby.userId, result.newLevel).catch(() => {});
  }
}

async function handleRouletteButton(interaction) {
  const { customId } = interaction;
  const lobbies = getLobbies(interaction.client);
  const parts = customId.split(':');
  const action = parts[1]; // bet | max | spin | cancel
  const lobbyId = parts[2];
  const lobby = lobbies.get(lobbyId);

  if (!lobby) {
    await interaction.reply({ content: '⚠️ **만료된 룰렛입니다.**', flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.user.id !== lobby.userId) {
    await interaction.reply({ content: '⚠️ **본인이 시작한 룰렛만 조작할 수 있습니다.**', flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === 'bet') {
    const amount = parseInt(parts[3], 10);
    if (amount > lobby.maxAvailable) {
      await interaction.reply({ content: '⚠️ **베팅 가능한 XP를 초과했습니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    lobby.bet = amount;
    await interaction.update({ embeds: [buildLobbyEmbed(lobby)], components: buildLobbyComponents(lobby) });
    return;
  }

  if (action === 'max') {
    lobby.bet = lobby.maxAvailable;
    await interaction.update({ embeds: [buildLobbyEmbed(lobby)], components: buildLobbyComponents(lobby) });
    return;
  }

  if (action === 'spin') {
    if (!lobby.bet) {
      await interaction.reply({ content: '⚠️ **먼저 베팅 XP를 선택하세요.**', flags: MessageFlags.Ephemeral });
      return;
    }
    await spinLobby(interaction, lobby, lobbies);
    return;
  }

  if (action === 'cancel') {
    clearTimeout(lobby.timeoutId);
    lobbies.delete(lobby.id);
    await interaction.update({ content: '❌ **룰렛이 취소되었습니다.**', embeds: [], components: [] });
    return;
  }
}

module.exports = { startRouletteCommand, handleRouletteButton, loadRoulette, saveRoulette, MIN_BET, MAX_BET };

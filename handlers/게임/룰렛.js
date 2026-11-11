// 룰렛.js — 하루 한 번, XP를 걸고 돌리는 슬롯머신형 솔로(대 봇) 도박 게임.
// 이름은 "룰렛"이지만 실제 방식은 슬롯머신(3릴 심볼 매칭)이다.
// 베팅은 옵션 입력이 아니라 로비 임베드의 버튼으로 고르고, 베팅을 고르면 🎰 돌리기 버튼이 활성화된다.

const fs = require('fs');
const path = require('path');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { renderSlot, idleImage } = require('./룰렛그림');
const { applyXp, getXp, levelFromXp, isLevelsLoaded, isExcludedGuild, announceLevelUp, isMinigameXpFrozen, isRaidXpFrozen } = require('../레벨/레벨링');
const { kstDateString, timeUntilKstMidnight } = require('../공통/시간');
const { logSystem, logAction, logError, userLabel } = require('../공통/로그');
const { writeJsonIfChanged } = require('../공통/저장');
const { card, payload, notice, COLORS, footerSide, pullButton } = require('../공통/카드');

const ROULETTE_PATH = path.join(__dirname, '..', '..', 'DB', 'roulette.json');
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
const SPIN_STEP_MS = 1300; // 릴이 하나씩 멈추는 간격(처음 그림 → 첫 릴 → 둘째 릴 → 결과, 총 약 4초)

// 실제 슬롯머신처럼 릴이 하나씩 순서대로 멈추는 연출. finalReels 는 이미 정해진 결과이고,
// 첫 그림(전부 돌아감)은 호출하는 쪽에서 보내고, 여기서는 "첫 릴 멈춤 → 둘째 릴 멈춤"까지 고쳐 준다.
// 마지막 결과 그림은 호출하는 쪽이 이어서 고친다. 수정은 총 3번(예전엔 6번)이라 디스코드 수정 제한에도 여유가 있다.
async function animateSpin(message, lobby, bet, finalReels) {
  const stages = [[finalReels[0], null, null], [finalReels[0], finalReels[1], null]];
  for (let i = 0; i < stages.length; i++) {
    await sleep(SPIN_STEP_MS);
    await message.edit(buildSpinningPayload(lobby, bet, stages[i], i + 1)).catch(() => {});
  }
  await sleep(SPIN_STEP_MS);
}

function getLobbies(client) {
  if (!client.rouletteLobbies) client.rouletteLobbies = new Map();
  return client.rouletteLobbies;
}

const SLOT_FILE = 'slot.png';
const slotFile = (buf) => new AttachmentBuilder(buf, { name: SLOT_FILE });
const SLOT_URL = `attachment://${SLOT_FILE}`;

// 두 개 이상 같은 릴의 번호(당첨 테두리용)
function matchIndices(reels) {
  const [a, b, c] = reels;
  if (a === b && b === c) return [0, 1, 2];
  if (a === b) return [0, 1];
  if (b === c) return [1, 2];
  if (a === c) return [0, 2];
  return [];
}

// 심볼별 배당표(TRIPLE_PAYOUTS 에서 만든다 — 배당을 바꾸면 화면도 같이 바뀐다)
function payoutTable() {
  const entries = Object.entries(TRIPLE_PAYOUTS).map(([sym, x]) => `${sym.repeat(3)} **×${x}**`);
  return `### 💰 배당표\n${entries.slice(0, 3).join('　')}\n${entries.slice(3).join('　')}\n-# 같은 심볼 2개 **×${TWO_MATCH_PAYOUT}** · 모두 다르면 꽝(베팅 전액 손실)`;
}

function buildLobbyCard(lobby) {
  // 🎰 돌리기는 베팅 금액 줄 오른쪽으로, ❌ 취소는 아래 안내 줄 오른쪽으로 뺀다. 금액 버튼(10~300 XP·최대)은 따로 한 줄씩 둔다.
  const withoutSpin = pullButton(buildLobbyComponents(lobby), /^roulette:spin:/);
  const bet = lobby.bet;
  const best = Math.max(...Object.values(TRIPLE_PAYOUTS));
  const betText = bet
    ? `### 💰 베팅　**${bet} XP**\n-# 7️⃣ 트리플이면 **+${Math.round(bet * best) - bet} XP** · 꽝이면 **-${bet} XP**`
    : '### 💰 베팅　*아직 선택 안 함*\n-# 아래에서 금액을 고르세요';
  return card({
    color: COLORS.info,
    header: '🎰 룰렛머신',
    sub: ['하루 1회', `베팅 가능 최대 ${lobby.maxAvailable} XP`],
    blocks: [
      `<@${lobby.userId}>님, 베팅 XP를 고른 뒤 **🎰 돌리기**를 누르세요.`,
      { image: SLOT_URL },
      { text: betText, ...(withoutSpin.button ? { button: withoutSpin.button } : {}) },
      payoutTable(),
    ],
    footer: '⏰ 60초 안에 돌리지 않으면 자동으로 취소됩니다.',
    ...footerSide(withoutSpin.rows, /^roulette:cancel:/),
  });
}

// 로비 메시지 전체(본인에게만 보이는 임시 메시지). 처음 보낼 때만 그림 파일을 붙이고,
// 이후 베팅을 바꿔 고칠 때는 이미 붙어 있는 그림을 그대로 둔다(다시 올리지 않음).
function buildLobbyPayload(lobby, extra = {}) {
  const first = !!extra.files || extra.withImage;
  const { withImage, ...rest } = extra;
  return payload(buildLobbyCard(lobby), { keepAttachments: !first, ...rest, ...(withImage ? { files: [slotFile(idleImage())] } : {}) });
}

// 릴이 도는 중: reels 에서 null 인 릴은 아직 돌고 있다(stage 가 오를수록 하나씩 멈춘다).
function buildSpinningPayload(lobby, bet, reels, phase = 0) {
  const png = renderSlot({ reels, bet, phase, right: '돌리는 중...', rightColor: '#c9b8a0' });
  return payload(card({
    color: COLORS.info,
    header: '🎰 룰렛머신',
    sub: [`<@${lobby.userId}>`, '릴이 돌아가는 중...', `베팅 ${bet} XP`],
    blocks: [{ image: SLOT_URL }],
    footer: '🎰 두근두근... 릴이 하나씩 멈춰요',
  }), { files: [slotFile(png)] });
}

function buildResultPayload(lobby, { bet, resultLine, netLine, net, reels, multiplier = 0 }) {
  const win = net > 0;
  const jackpot = reels[0] === reels[1] && reels[1] === reels[2] && reels[0] === '7️⃣';
  const png = renderSlot({
    reels, bet, jackpot, winIdx: matchIndices(reels),
    right: net > 0 ? `+${net} XP` : net === 0 ? '본전' : `${net} XP`,
    rightColor: win ? '#7dff9d' : net === 0 ? '#ffe9a8' : '#ff9a9a',
    badge: multiplier > 0 ? `×${multiplier}` : '',
    badgeColor: jackpot ? '#ffd700' : win ? '#ffd23f' : '#c9b8a0',
  });
  return payload(card({
    color: win ? 0xFFD700 : COLORS.muted,
    header: '🎰 룰렛머신',
    sub: [`<@${lobby.userId}>`, '결과', `베팅 ${bet} XP`],
    blocks: [
      { image: SLOT_URL },
      `### ${resultLine}　${netLine}`, // 결과와 손익을 한 줄에
    ],
    footer: '⏰ 하루에 한 번만 돌릴 수 있어요.',
  }), { files: [slotFile(png)] });
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
    await interaction.reply(notice('⚠️ **이 서버에서는 룰렛을 이용할 수 없습니다.**', { ephemeral: true }));
    return;
  }

  if (hasPlayedToday(guildId, userId)) {
    logAction(interaction, '룰렛', '일일 1회 제한으로 거부됨');
    await interaction.reply(notice(`⏳ **오늘은 이미 룰렛을 돌렸습니다.**\n다음 판까지 약 ${timeUntilKstMidnight()} 남았어요.`, { ephemeral: true }));
    return;
  }

  // 봇이 막 켜져 XP 데이터를 아직 읽기 전이면 모든 XP가 0으로 보인다 — "XP 부족"으로 오해하지 않게 따로 안내한다.
  if (!isLevelsLoaded()) {
    logAction(interaction, '룰렛', 'XP 데이터를 아직 불러오지 못해 대기 안내');
    await interaction.reply(notice('⏳ **XP 데이터를 불러오는 중이에요.**\n봇이 막 켜졌다면 잠시 뒤 다시 시도해 주세요.', { ephemeral: true }));
    return;
  }

  const currentLevelXp = levelFromXp(getXp(guildId, userId)).currentLevelXp;
  if (currentLevelXp < MIN_BET) {
    logAction(interaction, '룰렛', `베팅 부족으로 거부됨 — 레벨 안 XP ${currentLevelXp}, 누적 ${getXp(guildId, userId)}, 서버 ${guildId}`);
    // 레벨이 내려가지 않도록 "현재 레벨 안에서 쌓은 XP"만 걸 수 있다. 누적 XP가 많아도(레벨업 직후·레벨 설정 직후) 0일 수 있어 이유를 같이 알려 준다.
    const totalXp = getXp(guildId, userId);
    await interaction.reply(notice(`⚠️ **베팅 가능한 XP가 부족합니다.**\n레벨이 내려가지 않도록 **현재 레벨 안에서 쌓은 XP**만 걸 수 있어요.\n-# 최소 ${MIN_BET} XP 필요 · 지금 레벨 안 XP: ${currentLevelXp} · 누적 XP: ${totalXp}`, { ephemeral: true }));
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
  await interaction.reply(buildLobbyPayload(lobby, { ephemeral: true, withImage: true }));

  lobby.timeoutId = setTimeout(async () => {
    const l = lobbies.get(lobby.id);
    if (!l) return;
    lobbies.delete(lobby.id);
    await l.interaction.editReply(notice('⏰ **시간 초과로 룰렛이 취소되었습니다.**')).catch(() => {});
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
    logAction(interaction, '룰렛', '미니게임 XP 긴급정지 중이라 거부됨');
    const content = isRaidXpFrozen()
      ? '👾 **몬스터 때문에 XP 시스템이 고장 나 룰렛을 돌릴 수 없습니다.**'
      : '⚙️ **현재 관리자가 미니게임 XP를 일시 중지해 룰렛을 돌릴 수 없습니다.**';
    await interaction.editReply(notice(content));
    return;
  }

  // 로비가 열려있던 사이(다른 곳에서) 이미 오늘 플레이했거나 XP가 줄어들었을 수 있으므로 재검증.
  if (hasPlayedToday(lobby.guildId, lobby.userId)) {
    await interaction.editReply(notice('⏳ **오늘은 이미 룰렛을 돌렸습니다.**'));
    return;
  }
  const currentLevelXp = levelFromXp(getXp(lobby.guildId, lobby.userId)).currentLevelXp;
  const bet = Math.min(lobby.bet, currentLevelXp);
  if (bet < MIN_BET) {
    await interaction.editReply(notice(`⚠️ **베팅 가능한 XP가 부족해졌습니다.**\n-# 현재 레벨 안 XP ${currentLevelXp} · 최소 ${MIN_BET} XP 필요`));
    return;
  }

  markPlayedToday(lobby.guildId, lobby.userId);

  const reels = [spinReel(), spinReel(), spinReel()];
  const { multiplier, kind, symbol } = resolvePayout(reels);
  const payout = Math.round(bet * multiplier);
  const net = payout - bet;

  const result = applyXp(lobby.guildId, lobby.userId, net, `룰렛 (베팅 ${bet}, ${kind === 'triple' ? `${symbol} 트리플` : kind === 'two' ? '더블' : '꽝'} x${multiplier}, 지급 ${payout})`);

  const symbolLabel = symbol ? `${symbol} ${SYMBOL_NAMES[symbol]}` : '';

  const resultLine =
    kind === 'triple'
      ? symbol === '7️⃣'
        ? `🎉 **JACKPOT!** (×${multiplier})`
        : `**${symbolLabel} 트리플 매칭!** (×${multiplier})`
      : kind === 'two'
        ? `🙂 **더블 매칭!** (×${multiplier})`
        : `😢 **꽝**`;

  const netLine = net >= 0 ? `📈 **+${net} XP**` : `📉 **${net} XP**`;

  // 베팅 과정은 본인에게만 보였지만, 결과는 채널 전체에 공개 메시지로 실제 슬롯머신처럼
  // 릴이 하나씩 순서대로 멈추는 연출과 함께 알린다. XP 정산은 이미 끝났으므로, 채널 공개
  // 과정에서 오류가 나더라도(권한 문제 등) 최소한 본인에게는 결과를 보여준다.
  try {
    // content/embeds/components를 전부 비운 editReply는 디스코드가 "빈 메시지"로 보고 거부한다
    // (DiscordAPIError[50006]) — 그냥 로비 메시지를 지워서 정리한다.
    await interaction.deleteReply();
    // interaction.channel은 캐시에 없으면 null일 수 있으므로(재시작 직후 등) fetch로 안전하게 가져온다.
    const channel = interaction.channel ?? await interaction.client.channels.fetch(interaction.channelId);
    const spinMessage = await channel.send(buildSpinningPayload(lobby, bet, [null, null, null], 0));

    await animateSpin(spinMessage, lobby, bet, reels);

    // 결과 수정이 일시적 오류(네트워크/레이트리밋)로 한 번 실패하면 메시지가 "릴이 돌아가는 중..."에
    // 영영 멈춰 보였다. 몇 번 재시도하고, 그래도 안 되면 결과를 새 메시지로 보낸다.
    const finalPayload = buildResultPayload(lobby, { bet, resultLine, netLine, net, reels, multiplier });
    let edited = false;
    for (let attempt = 0; attempt < 3 && !edited; attempt++) {
      try {
        // 응답이 영영 오지 않고 매달리는 경우(재시도 로직이 못 도는 경우)도 있어 시간 제한을 둔다.
        await Promise.race([
          spinMessage.edit(finalPayload),
          new Promise((_, reject) => setTimeout(() => reject(new Error('edit timeout')), 8000)),
        ]);
        edited = true;
      } catch (err) {
        console.error(`룰렛 결과 수정 실패(${attempt + 1}/3):`, err);
        await sleep(1000 * (attempt + 1));
      }
    }
    if (!edited) {
      await channel.send(finalPayload).catch(err => console.error('룰렛 결과 새 메시지 전송 실패:', err));
    }
  } catch (err) {
    console.error('룰렛 결과 공개 실패:', err);
    logError('게임 오류', `룰렛 결과 채널 공개 실패 — ${userLabel(lobby.userId)}에게만 결과 표시`, err);
    await interaction.editReply(buildResultPayload(lobby, { bet, resultLine, netLine, net, reels, multiplier })).catch(() => {});
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
    await interaction.reply(notice('⚠️ **만료된 룰렛입니다.**', { ephemeral: true }));
    return;
  }
  if (interaction.user.id !== lobby.userId) {
    await interaction.reply(notice('⚠️ **본인이 시작한 룰렛만 조작할 수 있습니다.**', { ephemeral: true }));
    return;
  }

  if (action === 'bet') {
    const amount = parseInt(parts[3], 10);
    if (amount > lobby.maxAvailable) {
      await interaction.reply(notice('⚠️ **베팅 가능한 XP를 초과했습니다.**', { ephemeral: true }));
      return;
    }
    lobby.bet = amount;
    await interaction.update(buildLobbyPayload(lobby));
    return;
  }

  if (action === 'max') {
    lobby.bet = lobby.maxAvailable;
    await interaction.update(buildLobbyPayload(lobby));
    return;
  }

  if (action === 'spin') {
    if (!lobby.bet) {
      await interaction.reply(notice('⚠️ **먼저 베팅 XP를 선택하세요.**', { ephemeral: true }));
      return;
    }
    await spinLobby(interaction, lobby, lobbies);
    return;
  }

  if (action === 'cancel') {
    clearTimeout(lobby.timeoutId);
    lobbies.delete(lobby.id);
    await interaction.update(notice('❌ **룰렛이 취소되었습니다.**'));
    return;
  }
}

// buildLobbyPayload/buildResultPayload는 화면 모음·테스트에서 직접 그려 보려고 함께 내보낸다.
module.exports = { buildLobbyPayload, buildSpinningPayload, buildResultPayload, startRouletteCommand, handleRouletteButton, loadRoulette, saveRoulette, MIN_BET, MAX_BET };

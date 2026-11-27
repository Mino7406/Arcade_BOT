// 룰렛.js — 하루 한 번, XP를 걸고 돌리는 슬롯머신형 솔로(대 봇) 도박 게임.
// 이름은 "룰렛"이지만 실제 방식은 슬롯머신(3릴 심볼 매칭)이다.
// 베팅은 옵션 입력이 아니라 로비 임베드의 버튼으로 고르고, 베팅을 고르면 🎰 돌리기 버튼이 활성화된다.

const fs = require('fs');
const path = require('path');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { renderSlot, renderHackIntro, renderRerollIntro, REROLL_INTRO_COUNT, INTRO_STEP_COUNT, idleImage } = require('./룰렛그림');
const { applyXp, getXp, levelFromXp, isLevelsLoaded, isExcludedGuild, announceLevelUp, isMinigameXpFrozen, isRaidXpFrozen } = require('../레벨/레벨링');
const { isTestGuild } = require('../../config');
const { kstDateString, timeUntilKstMidnight } = require('../공통/시간');
const { logSystem, logAction, logError, userLabel } = require('../공통/로그');
const { writeJsonIfChanged } = require('../공통/저장');
const { card, payload, notice, COLORS, footerSide, pullButton } = require('../공통/카드');
const { HACK_TOOL_NAME, hackToolWith, HACK_TOOL_MAX, hackToolEmoji, hackUseButtonEmoji, hackUseEmoji, getHackTools, useHackTool } = require('./해킹툴');
const { GATEWAY_NAME, gatewayEmoji, gatewayButtonEmoji, getGateways, useGateway, GATEWAY_MAX } = require('./블랙월게이트웨이');
const { REROLL_NAME, REROLL_MAX, REROLL_DESC, rerollEmoji, getRerolls, useReroll } = require('./역린');

const ROULETTE_PATH = path.join(__dirname, '..', '..', 'DB', 'roulette.json');
fs.mkdirSync(path.dirname(ROULETTE_PATH), { recursive: true });

const MIN_BET = 10;
const MAX_BET = 300;
const BET_PRESETS = [10, 50, 100, 200, 300]; // 한 줄 버튼 최대 5개
const LOBBY_TIMEOUT_MS = 60 * 1000;
const WALL_COLOR = 0xB81C2A; // 블랙월 게이트웨이를 발동한 룰렛 카드 띠 색(붉은)
const wallFooter = () => `${gatewayEmoji()} 블랙월 프로토콜 업로드 완료. [ACCESS_GRANTED]`; // 이모지는 봇이 켜진 뒤에야 정해지므로 쓸 때마다 만든다
const REROLL_COLOR = 0xDD5AA6; // 역린 카드 띠 색(이모지의 분홍과 맞춤)
const HACK_COLOR = 0x8B7CF6; // 해킹 툴 확인 메시지 띠 색(이모지와 맞춘 보라)
const HACK_PROMPT_MS = 60 * 1000; // 꽝이 나온 뒤 해킹 툴을 쓸지 고르는 시간(지나면 결과 확정)

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
async function animateSpin(message, lobby, bet, finalReels, hacks = 0, wall = false) {
  const stages = [[finalReels[0], null, null], [finalReels[0], finalReels[1], null]];
  for (let i = 0; i < stages.length; i++) {
    await sleep(SPIN_STEP_MS);
    await message.edit(buildSpinningPayload(lobby, bet, stages[i], i + 1, hacks, wall)).catch(() => {});
  }
  await sleep(SPIN_STEP_MS);
}

function getLobbies(client) {
  if (!client.rouletteLobbies) client.rouletteLobbies = new Map();
  return client.rouletteLobbies;
}

// 꽝이 나와 해킹 툴 사용 여부를 묻는 중인 판들. { [promptId]: { id, guildId, userId, lobby, bet, message, channel, hacks, interaction, followUp, timeoutId } }
function getHackPrompts(client) {
  if (!client.rouletteHacks) client.rouletteHacks = new Map();
  return client.rouletteHacks;
}

// 테스트 서버에서는 해킹 툴을 무제한으로 쓸 수 있다(레이드를 깨지 않아도 시험해 볼 수 있게, 개수도 줄지 않음).
const hackUnlimited = (guildId) => isTestGuild(guildId);
const hackToolsOf = (guildId, userId) => (hackUnlimited(guildId) ? Infinity : getHackTools(guildId, userId));
// 블랙월 게이트웨이(??? 레이드 MVP 보상): 돌리기 전에 발동해 두면 이번 판이 100% 잭팟. 테스트 서버에서는 무제한.
const gatewaysOf = (guildId, userId) => (hackUnlimited(guildId) ? Infinity : getGateways(guildId, userId));
const gatewayHaveText = (have) => (have === Infinity ? '테스트 서버 · 무제한' : `${have}/${GATEWAY_MAX}개`);
// 역린(알바트리온 레이드 MVP 보상): 결과가 나온 직후 릴 한 칸만 골라 다시 돌린다. 테스트 서버에서는 무제한.
const rerollsOf = (guildId, userId) => (hackUnlimited(guildId) ? Infinity : getRerolls(guildId, userId));
const rerollHaveText = (have) => (have === Infinity ? '테스트 서버 · 무제한' : `${have}/${REROLL_MAX}개`);
const hackHaveText = (have) => (have === Infinity ? '테스트 서버 · 무제한' : `${have}/${HACK_TOOL_MAX}개`);

// 해킹된 카드의 안내 줄: 인코딩이 깨진 것처럼 대체 문자(�)와 오류 코드를 섞는다(읽을 수는 있게).
// (겹침 결합 문자는 글꼴에 따라 네모로 깨져 보여서 쓰지 않는다)
const HACK_FOOTER = '⏰ 하루� 한 번�만 돌릴 ▓▒░ [ERR_0x7F]';

// 해킹 툴을 쓴 횟수 표시(카드 부제)
const hackLabel = (hacks) => (hacks > 0 ? `${hackUseEmoji()} ${HACK_TOOL_NAME} ${hacks}회 사용` : null);

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
  return `### 💰 배당표\n${entries.slice(0, 3).join('　')}\n${entries.slice(3).join('　')}\n-# 같은 심볼 2개 **×${TWO_MATCH_PAYOUT}** · 모두 다르면 **꽝**`;
}

function buildLobbyCard(lobby) {
  // ❌ 취소는 베팅 금액 줄 오른쪽으로, 🎰 돌리기는 아래 안내 줄 오른쪽으로 뺀다. 금액 버튼(10~300 XP·최대)은 따로 한 줄씩 둔다.
  const withoutCancel = pullButton(buildLobbyComponents(lobby), /^roulette:cancel:/);
  const bet = lobby.bet;
  const betText = bet
    ? `### 💰 베팅　**${bet} XP**\n-# 지금 베팅 가능한 XP **${lobby.maxAvailable} XP**`
    : `### 💰 베팅　*아직 선택 안 함*\n-# 지금 베팅 가능한 XP **${lobby.maxAvailable} XP** · 아래에서 금액을 고르세요`;
  return card({
    color: COLORS.info,
    header: '🎰 룰렛머신',
    sub: ['하루 1회', lobby.hackTools > 0 ? `${hackToolEmoji()} ${HACK_TOOL_NAME} ${hackHaveText(lobby.hackTools)}` : null, lobby.gateways > 0 ? `${gatewayEmoji()} ${GATEWAY_NAME} ${gatewayHaveText(lobby.gateways)}` : null].filter(Boolean),
    blocks: [
      `<@${lobby.userId}>님, 베팅 XP를 고른 뒤 **🎰 돌리기**를 누르세요.`,
      { image: SLOT_URL },
      { text: betText, ...(withoutCancel.button ? { button: withoutCancel.button } : {}) },
      payoutTable(),
    ],
    footer: '⏰ 60초 안에 돌리지 않으면 자동으로 취소됩니다.',
    ...footerSide(withoutCancel.rows, /^roulette:spin:/),
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
function buildSpinningPayload(lobby, bet, reels, phase = 0, hacks = 0, wall = false) {
  const png = renderSlot({ reels, bet, phase, right: '돌리는 중...', rightColor: '#c9b8a0', hacked: hacks > 0 || wall, wall }); // 블랙월: 돌기 전에 이미 완전히 잠식된 상태
  if (wall) return payload(card({
    color: WALL_COLOR,
    header: `${gatewayEmoji()} 룰렛머신`,
    sub: [`<@${lobby.userId}>`, `${gatewayEmoji()} ${GATEWAY_NAME} 사용`],
    blocks: [{ image: SLOT_URL, divider: true }],
    footer: `${gatewayEmoji()} 블랙월 너머에서 결과를 가져오는 중...`,
  }), { files: [slotFile(png)] });
  return payload(card({
    color: hacks > 0 ? HACK_COLOR : COLORS.info,
    header: hacks > 0 ? `${hackToolEmoji()} 룰렛머신` : '🎰 룰렛머신',
    sub: [`<@${lobby.userId}>`, hacks > 0 ? null : '릴이 돌아가는 중...', hackLabel(hacks)].filter(Boolean),
    blocks: [{ image: SLOT_URL, divider: true }], // 결과 카드와 같은 자리에 구분선(그림이 위아래로 움직이지 않게)
    footer: hacks > 0 ? `${hackToolEmoji()} ${hackToolWith('으로')} 결과를 다시 돌리는 중...` : '🎰 두근두근... 릴이 하나씩 멈춰요',
  }), { files: [slotFile(png)] });
}

// 블랙월 게이트웨이 발동: 돌리기 전에 평범한 룰렛이 가장자리부터 블랙월에 잠식당하는 장면(step 0~3, erosion 은 번진 정도).
const WALL_EROSION = [0, 0.2, 0.45, 0.7, 0.92]; // 0단계는 잠식 전 멀쩡한 룰렛, 1~4단계가 잠식
function buildWallErosionPayload(lobby, bet, step) {
  const intact = step === 0;
  const png = renderSlot({ reels: [null, null, null], bet, phase: step, right: intact ? '' : '잠식 중...', rightColor: '#ff6a78', hacked: !intact, wall: true, erosion: WALL_EROSION[step] });
  return payload(card({
    color: WALL_COLOR,
    header: `${gatewayEmoji()} 룰렛머신`,
    sub: [`<@${lobby.userId}>`, `${gatewayEmoji()} ${GATEWAY_NAME} 사용`],
    blocks: [{ image: SLOT_URL, divider: true }],
    footer: intact ? `${gatewayEmoji()} ${GATEWAY_NAME} 가동...` : `${gatewayEmoji()} 블랙월이 룰렛을 잠식하는 중... ${'▓'.repeat(step)}${'░'.repeat(Math.max(0, WALL_EROSION.length - 1 - step))}`,
  }), { files: [slotFile(png)] });
}

// 해킹 침입 연출 카드(해킹 툴을 쓴 뒤 다시 돌리기 전). reels: 직전 꽝 결과, step: 단계 번호.
const INTRO_STEP_MS = 900; // 단계 사이 간격(3단계 ≈ 2.7초). 디스코드 메시지 수정 제한(약 5초에 5번) 안쪽
function buildHackIntroPayload(lobby, bet, reels, step, hacks) {
  const png = renderHackIntro({ reels, bet, step });
  return payload(card({
    color: HACK_COLOR,
    header: `${hackToolEmoji()} 룰렛머신`,
    sub: [`<@${lobby.userId}>`, hackLabel(hacks)].filter(Boolean),
    blocks: [{ image: SLOT_URL, divider: true }],
    footer: `${hackToolEmoji()} ${hackToolWith('으로')} 시스템에 침입하는 중...`,
  }), { files: [slotFile(png)] });
}

function buildResultPayload(lobby, { bet, resultLine, netLine, net, reels, multiplier = 0, hacks = 0, gateway = false, rerolled = null, rerollNote = '' }, extra = {}) {
  const win = net > 0;
  const jackpot = reels[0] === reels[1] && reels[1] === reels[2] && reels[0] === '7️⃣';
  const png = renderSlot({
    reels, bet, jackpot, winIdx: matchIndices(reels),
    right: net > 0 ? `+${net} XP` : net === 0 ? '본전' : `${net} XP`,
    rightColor: win ? '#7dff9d' : net === 0 ? '#ffe9a8' : '#ff9a9a',
    badge: multiplier > 0 ? `×${multiplier}` : '',
    badgeColor: jackpot ? '#ffd700' : win ? '#ffd23f' : '#c9b8a0',
    hacked: hacks > 0 || gateway,
    wall: gateway,
    rerolled,
    phase: hacks > 0 || gateway ? 7 : 0, // 해킹 모드 결과 그림의 글리치 모양(프레임 번호)
  });
  return payload(card({
    color: gateway ? WALL_COLOR : rerolled != null ? REROLL_COLOR : hacks > 0 ? HACK_COLOR : win ? 0xFFD700 : COLORS.muted,
    header: gateway ? `${gatewayEmoji()} 룰렛머신` : rerolled != null ? `${rerollEmoji()} 룰렛머신` : hacks > 0 ? `${hackToolEmoji()} 룰렛머신` : '🎰 룰렛머신',
    sub: [`<@${lobby.userId}>`, hacks > 0 || gateway || rerolled != null ? null : '결과', hackLabel(hacks), rerolled != null ? `${rerollEmoji()} ${REROLL_NAME} · ${rerolled + 1}번 릴 재회전` : null, gateway ? `${gatewayEmoji()} ${GATEWAY_NAME} 사용` : null].filter(Boolean),
    blocks: [
      { image: SLOT_URL, divider: true }, // 제목·결과 줄 아래 구분선
      `### ${resultLine}　${netLine}`, // 결과와 손익을 한 줄에
      ...(rerolled != null && rerollNote ? [`-# ${rerollNote}`] : []),
    ],
    footer: gateway ? wallFooter() : rerolled != null ? `${rerollEmoji()} 역린의 힘으로 릴 한 칸을 다시 돌렸어요.` : hacks > 0 ? HACK_FOOTER : '⏰ 하루에 한 번만 돌릴 수 있어요.',
  }), { files: [slotFile(png)], ...extra });
}

// 꽝이 나왔을 때 돌린 사람에게만 보이는 해킹 툴 사용 확인(공개 결과 카드에는 버튼을 달지 않는다).
function buildHackPromptPayload(prompt, have, extra = {}) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`roulette:hack:${prompt.id}`).setEmoji(hackUseButtonEmoji()).setLabel('사용').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`roulette:keep:${prompt.id}`).setLabel('넘기기').setStyle(ButtonStyle.Secondary),
  );
  return payload(card({
    color: HACK_COLOR,
    header: `${hackToolEmoji()} ${HACK_TOOL_NAME}`,
    sub: [`보유 ${hackHaveText(have)}`],
    blocks: [`😢 **꽝**이 나왔어요. ${hackToolWith('을')} 써서 결과를 번복할까요?\n-# 잃은 **${prompt.bet} XP**를 돌려받고 같은 베팅으로 한 번 더 돌려요`],
    footer: `⏰ ${HACK_PROMPT_MS / 1000}초 안에 고르지 않으면 결과가 그대로 확정돼요.`,
    rows: [row],
  }), extra); // 이미 본인 전용인 메시지를 고쳐 쓰므로 ephemeral 플래그는 넣지 않는다(화면 모음은 extra로 넘김)
}

// 결과 직후 돌린 사람에게만 보이는 역린 사용 확인: 다시 돌릴 릴을 고른다.
function buildRerollPromptPayload(prompt, have, extra = {}) {
  const row = new ActionRowBuilder().addComponents(
    ...prompt.spin.reels.map((reel, i) => new ButtonBuilder().setCustomId(`roulette:rr:${prompt.id}:${i}`).setLabel(`${i + 1}번 릴 ${reel}`).setStyle(ButtonStyle.Primary)),
    new ButtonBuilder().setCustomId(`roulette:rrkeep:${prompt.id}`).setLabel('아껴 두기').setStyle(ButtonStyle.Secondary),
  );
  return payload(card({
    color: REROLL_COLOR,
    header: `${rerollEmoji()} ${REROLL_NAME}`,
    sub: [`보유 ${rerollHaveText(have)}`],
    blocks: [`🐉 **용의 역린이 반응하고 있어요.** ${REROLL_DESC}.\n-# 지금 결과: ${spinLabel(prompt.spin)} (×${prompt.spin.multiplier}) · 다시 돌린 결과가 더 나쁠 수도 있어요`],
    footer: `⏰ ${HACK_PROMPT_MS / 1000}초 안에 고르지 않으면 결과가 그대로 확정돼요. 역린은 그대로 남아요.`,
    rows: [row],
  }), extra);
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
  // 블랙월 게이트웨이를 갖고 있으면 '발동' 버튼(누르면 켜고 끔). 켜 두고 돌리면 이번 판이 100% 잭팟.
  const gate = lobby.gateways > 0
    ? [new ButtonBuilder().setCustomId(`roulette:gate:${lobby.id}`).setEmoji(gatewayButtonEmoji())
        .setLabel(lobby.gatewayArmed ? '사용됨 (다시 누르면 취소)' : `${GATEWAY_NAME} 사용`)
        .setStyle(lobby.gatewayArmed ? ButtonStyle.Success : ButtonStyle.Danger)]
    : [];
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`roulette:max:${lobby.id}`)
      .setLabel(`🔺 최대 (${lobby.maxAvailable})`)
      .setStyle(maxSelected ? ButtonStyle.Success : ButtonStyle.Secondary),
    ...gate,
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

// 베팅에 쓸 수 있는 XP: 평소엔 현재 레벨 안 XP, 테스트 서버에서는 항상 최대 베팅 한도.
function availableXp(guildId, userId) {
  if (isTestGuild(guildId)) return MAX_BET;
  return levelFromXp(getXp(guildId, userId)).currentLevelXp;
}

async function startRouletteCommand(interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  if (isExcludedGuild(guildId) && !isTestGuild(guildId)) {
    await interaction.reply(notice('⚠️ **이 서버에서는 룰렛을 이용할 수 없습니다.**', { ephemeral: true }));
    return;
  }

  if (!isTestGuild(guildId) && hasPlayedToday(guildId, userId)) {
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

  // 테스트 서버에서는 XP 가 없어도, 하루 1회 제한 없이 최대 베팅까지 걸어 볼 수 있다(XP 는 실제로 바뀌지 않는다).
  const currentLevelXp = availableXp(guildId, userId);
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
    hackTools: hackToolsOf(guildId, userId),
    gateways: gatewaysOf(guildId, userId),
    gatewayArmed: false, // 블랙월 게이트웨이 발동 여부(돌리면 이번 판이 100% 잭팟)
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
  if (!isTestGuild(lobby.guildId) && hasPlayedToday(lobby.guildId, lobby.userId)) {
    await interaction.editReply(notice('⏳ **오늘은 이미 룰렛을 돌렸습니다.**'));
    return;
  }
  const currentLevelXp = availableXp(lobby.guildId, lobby.userId);
  const bet = Math.min(lobby.bet, currentLevelXp);
  if (bet < MIN_BET) {
    await interaction.editReply(notice(`⚠️ **베팅 가능한 XP가 부족해졌습니다.**\n-# 현재 레벨 안 XP ${currentLevelXp} · 최소 ${MIN_BET} XP 필요`));
    return;
  }

  if (!isTestGuild(lobby.guildId)) markPlayedToday(lobby.guildId, lobby.userId);

  // 블랙월 게이트웨이를 발동해 뒀으면 아이템 1개를 쓰고 이번 판을 잭팟(7️⃣ 트리플)으로 확정한다. 테스트 서버는 무제한(개수 안 줄음).
  const useGate = lobby.gatewayArmed && (hackUnlimited(lobby.guildId) || useGateway(lobby.guildId, lobby.userId));
  const spin = useGate ? jackpotSpin(bet) : rollSpin(bet);
  if (useGate) logSystem({ 유형: '룰렛', 유저: userLabel(lobby.userId), 내용: `${GATEWAY_NAME} 사용 — 잭팟 확정(베팅 ${bet}, x${spin.multiplier})` });
  const net = spin.payout - bet;

  // 테스트 서버는 XP 시스템이 꺼져 있으므로 정산하지 않고 연출만 보여 준다.
  const result = isTestGuild(lobby.guildId) ? { leveledUp: false } : applyXp(lobby.guildId, lobby.userId, net, `룰렛 (베팅 ${bet}, ${spinLabel(spin)} x${spin.multiplier}, 지급 ${spin.payout})`);

  // 베팅 과정은 본인에게만 보였지만, 결과는 채널 전체에 공개 메시지로 실제 슬롯머신처럼
  // 릴이 하나씩 순서대로 멈추는 연출과 함께 알린다. XP 정산은 이미 끝났으므로, 채널 공개
  // 과정에서 오류가 나더라도(권한 문제 등) 최소한 본인에게는 결과를 보여준다.
  let shown = null;
  try {
    // 로비 메시지는 바로 지우지 않고 '돌리는 중' 안내로 바꿔 둔다. 꽝이면 해킹 툴 확인을 결과 아래(후속 메시지)에 띄우는데,
    // 후속 메시지는 이 로비에 단 답장처럼 보여서 로비를 먼저 지우면 "메시지를 불러올 수 없어요"가 뜬다 — 확인이 끝나면 함께 지운다.
    await interaction.editReply(notice('🎰 **채널에서 룰렛을 돌리는 중...**')).catch(() => {});
    // interaction.channel은 캐시에 없으면 null일 수 있으므로(재시작 직후 등) fetch로 안전하게 가져온다.
    const channel = interaction.channel ?? await interaction.client.channels.fetch(interaction.channelId);
    const message = await revealSpin(channel, null, lobby, bet, spin, 0);
    shown = { channel, message, reels: spin.reels };
  } catch (err) {
    console.error('룰렛 결과 공개 실패:', err);
    logError('게임 오류', `룰렛 결과 채널 공개 실패 — ${userLabel(lobby.userId)}에게만 결과 표시`, err);
    await interaction.editReply(buildResultPayload(lobby, resultView(bet, spin, 0))).catch(() => {});
  }

  if (result.leveledUp) {
    announceLevelUp(interaction.client, lobby.guildId, lobby.userId, result.newLevel).catch(() => {});
  }

  // 꽝이고 해킹 툴이 있으면 번복할지 본인에게만 묻는다(결과를 채널에 못 올렸으면 다시 돌릴 자리가 없어 묻지 않음).
  // 묻지 않으면 '돌리는 중' 안내(예전 로비 자리)는 지운다. 공개 실패로 결과를 여기 보여 줬으면 남긴다.
  // 역린이 있으면 결과 직후(꽝이든 아니든) 한 릴만 다시 돌릴지 먼저 묻는다. 게이트웨이로 확정한 잭팟은 묻지 않는다.
  if (shown && !spin.gateway && await offerReroll(interaction, { lobby, bet, spin, ...shown, hacks: 0, root: interaction })) return;
  if (spin.kind === 'none' && shown && await offerHack(interaction, { lobby, bet, ...shown, hacks: 0, root: interaction })) return;
  if (shown) await interaction.deleteReply().catch(() => {});
}

// 블랙월 게이트웨이: 7️⃣ 트리플(잭팟)로 확정. gateway 표시는 결과 카드에 발동했다는 걸 적는 데 쓴다.
function jackpotSpin(bet) {
  const reels = ['7️⃣', '7️⃣', '7️⃣'];
  const { multiplier, kind, symbol } = resolvePayout(reels);
  return { reels, multiplier, kind, symbol, payout: Math.round(bet * multiplier), gateway: true };
}

// 릴 3개를 돌려 결과와 지급액을 정한다.
function rollSpin(bet) {
  const reels = [spinReel(), spinReel(), spinReel()];
  const { multiplier, kind, symbol } = resolvePayout(reels);
  return { reels, multiplier, kind, symbol, payout: Math.round(bet * multiplier) };
}

// 한 릴 재회전: index 칸만 reelFn()으로 바꿔 결과와 지급액을 다시 계산한 새 spin 을 돌려준다(원본은 그대로).
function rerollReel(spin, index, bet, reelFn = spinReel) {
  const reels = [...spin.reels];
  reels[index] = reelFn();
  const { multiplier, kind, symbol } = resolvePayout(reels);
  return { reels, multiplier, kind, symbol, payout: Math.round(bet * multiplier) };
}

const spinLabel = (spin) => (spin.kind === 'triple' ? `${spin.symbol} 트리플` : spin.kind === 'two' ? '더블' : '꽝');

// 결과 카드에 넘길 값(결과 줄·손익 줄). net 은 그날 판의 최종 손익(지급 - 베팅).
function resultView(bet, spin, hacks, reroll = null) {
  const { kind, symbol, multiplier, reels } = spin;
  const net = spin.payout - bet;
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
  return { bet, resultLine, netLine, net, reels, multiplier, hacks, gateway: !!spin.gateway, ...(reroll ? { rerolled: reroll.index, rerollNote: reroll.note } : {}) };
}

// 역린 발동 장면(돌기 전 4장): 알바트리온 용 속성 도트 연출 — 용의 기운이 모이고, 칸의 그림이 타들어 가며 새 릴이 드러난다.
const REROLL_FOOTERS = ['역린 발동 중...', '역린 발동 중...', '역린 발동 중...', '역린 발동 중...']; // 장면마다 다르던 문구를 모두 같게
function buildRerollIntroPayload(lobby, bet, reels, index, step, hacks = 0) {
  const png = renderRerollIntro({ reels, bet, index, step });
  return payload(card({
    color: REROLL_COLOR,
    header: `${rerollEmoji()} 룰렛머신`,
    sub: [`<@${lobby.userId}>`, `${rerollEmoji()} ${REROLL_NAME} 사용`, hackLabel(hacks)].filter(Boolean),
    blocks: [{ image: SLOT_URL, divider: true }],
    footer: `${rerollEmoji()} ${REROLL_FOOTERS[step] ?? REROLL_FOOTERS[0]}`,
  }), { files: [slotFile(png)] });
}
// 역린 사용: 다시 돌릴 릴(index)만 금빛 테두리로 강조하고 그 칸만 돌아간다(나머지는 직전 결과 그대로 어둡게). reels 에서 null 인 칸이 도는 중.
function buildRerollSpinPayload(lobby, bet, reels, index, phase = 0, hacks = 0) {
  const png = renderSlot({ reels, bet, phase, rerollIdx: index, right: '불길 속에서 회전 중...', rightColor: '#ffb0dc' });
  return payload(card({
    color: REROLL_COLOR,
    header: `${rerollEmoji()} 룰렛머신`,
    sub: [`<@${lobby.userId}>`, `${rerollEmoji()} ${REROLL_NAME} 사용`, hackLabel(hacks)].filter(Boolean),
    blocks: [{ image: SLOT_URL, divider: true }],
    footer: `${rerollEmoji()} 역린 발동 중...`,
  }), { files: [slotFile(png)] });
}

// 채널에 릴이 하나씩 멈추는 연출을 보여 주고 결과로 고친다. message 가 있으면(해킹 툴로 다시 돌릴 때) 그 카드를 그대로 다시 돌린다.
// 결과가 실제로 올라간 메시지를 돌려준다(수정이 끝내 실패해 새로 보냈으면 새 메시지).
async function revealSpin(channel, message, lobby, bet, spin, hacks, introReels = null, reroll = null) {
  const wall = !!spin.gateway; // 블랙월 게이트웨이 발동: 돌기 전에 평범한 룰렛이 블랙월에 잠식당하고, 덮인 뒤 붉은 블랙월 룰렛이 돈다
  if (wall) {
    for (let step = 0; step < WALL_EROSION.length; step++) {
      const pl = buildWallErosionPayload(lobby, bet, step);
      if (!message) message = await channel.send(pl);
      else { try { await message.edit(pl); } catch { message = null; } }
      if (message) await sleep(INTRO_STEP_MS);
    }
  }
  // 해킹 툴을 처음 쓸 때만 바로 돌리지 않고 침입 연출부터(연속 2회째부터는 연출 없이 바로 돈다).
  if (hacks === 1 && introReels && message) {
    for (let step = 0; step < INTRO_STEP_COUNT && message; step++) {
      try { await message.edit(buildHackIntroPayload(lobby, bet, introReels, step, hacks)); } catch { message = null; }
      if (message) await sleep(INTRO_STEP_MS);
    }
  }
  if (reroll) {
    // 역린: 용의 기운에 칸이 타들어 가고(4장) → 그 칸만 돌다가 → 새 결과로 멈춘다(나머지 칸은 그대로)
    const { index, prevReels } = reroll;
    const spinning = prevReels.map((r, i) => (i === index ? null : r));
    const frames = [
      ...Array.from({ length: REROLL_INTRO_COUNT }, (_, step) => [buildRerollIntroPayload(lobby, bet, prevReels, index, step, hacks), INTRO_STEP_MS]),
      [buildRerollSpinPayload(lobby, bet, spinning, index, 1, hacks), SPIN_STEP_MS],
    ];
    for (const [pl, wait] of frames) {
      if (message) { try { await message.edit(pl); } catch { message = null; } }
      if (!message) message = await channel.send(pl);
      await sleep(wait);
    }
  }
  const first = buildSpinningPayload(lobby, bet, [null, null, null], 0, hacks, wall);
  if (!reroll && message) {
    try { await message.edit(first); } catch { message = null; } // 카드가 지워졌으면 새로 올린다
  }
  if (!reroll) {
    if (!message) message = await channel.send(first);
    await animateSpin(message, lobby, bet, spin.reels, hacks, wall);
  }

  // 결과 수정이 일시적 오류(네트워크/레이트리밋)로 한 번 실패하면 메시지가 "릴이 돌아가는 중..."에
  // 영영 멈춰 보였다. 몇 번 재시도하고, 그래도 안 되면 결과를 새 메시지로 보낸다.
  const finalPayload = buildResultPayload(lobby, resultView(bet, spin, hacks, reroll ? { index: reroll.index, note: reroll.note } : null));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // 응답이 영영 오지 않고 매달리는 경우(재시도 로직이 못 도는 경우)도 있어 시간 제한을 둔다.
      await Promise.race([
        message.edit(finalPayload),
        new Promise((_, reject) => setTimeout(() => reject(new Error('edit timeout')), 8000)),
      ]);
      return message;
    } catch (err) {
      console.error(`룰렛 결과 수정 실패(${attempt + 1}/3):`, err);
      await sleep(1000 * (attempt + 1));
    }
  }
  return channel.send(finalPayload).catch(err => { console.error('룰렛 결과 새 메시지 전송 실패:', err); return message; });
}

// 꽝이 나왔을 때 해킹 툴이 있으면 본인에게만 보이는 확인을 띄운다. 시간이 지나면 결과 확정.
// 처음엔 결과 카드 아래에 후속 메시지로 띄우고(로비 자리는 결과 카드보다 위라 놓치기 쉽다),
// 다시 돌린 뒤 또 꽝이면 같은 확인 메시지 자리(버튼을 누른 메시지)를 고쳐 쓴다. 띄웠으면 true.
// ctx.root: 처음 🎰 돌리기를 누른 상호작용 — 그 '돌리는 중' 안내(예전 로비 자리)를 마지막에 함께 지운다.
async function offerHack(interaction, ctx) {
  const have = hackToolsOf(ctx.lobby.guildId, ctx.lobby.userId);
  if (have <= 0) return false;
  const prompts = getHackPrompts(interaction.client);
  const prompt = { ...ctx, id: interaction.id, guildId: ctx.lobby.guildId, userId: ctx.lobby.userId, interaction, msg: null, timeoutId: null };
  prompts.set(prompt.id, prompt);
  try {
    if (interaction === ctx.root) prompt.msg = await interaction.followUp(buildHackPromptPayload(prompt, have, { ephemeral: true }));
    else await interaction.editReply(buildHackPromptPayload(prompt, have));
  } catch (err) {
    prompts.delete(prompt.id);
    console.error('해킹 툴 확인 메시지 표시 실패:', err);
    return false;
  }
  prompt.timeoutId = setTimeout(() => {
    if (prompts.get(prompt.id) !== prompt) return;
    prompts.delete(prompt.id);
    closePrompt(prompt); // 시간이 지나면 결과 확정 — 확인 메시지와 '돌리는 중' 안내를 지운다
  }, HACK_PROMPT_MS);
  return true;
}

// 해킹 툴 확인 메시지와 그 위 '돌리는 중' 안내(예전 로비 자리)를 지운다.
// 확인 메시지를 먼저 지워야 답장 표시가 "메시지를 불러올 수 없어요"로 깨지지 않는다.
// via: 확인 메시지의 버튼을 누른 상호작용(그 메시지를 바로 지울 수 있다). 없으면 확인을 띄운 상호작용으로 지운다.
async function closePrompt(prompt, via = null) {
  if (via) await via.deleteReply().catch(() => {});
  else await prompt.interaction.deleteReply(prompt.msg || '@original').catch(() => {});
  await prompt.root.deleteReply().catch(() => {});
}

// 🛠️ 사용 / 넘기기 버튼
async function handleHackButton(interaction, action, promptId) {
  const prompts = getHackPrompts(interaction.client);
  const prompt = prompts.get(promptId);
  if (!prompt || prompt.kind === 'reroll') { // 역린 확인은 rr 버튼만 처리한다
    await interaction.reply(notice('⚠️ **이미 확정된 결과예요.**', { ephemeral: true }));
    return;
  }
  if (interaction.user.id !== prompt.userId) {
    await interaction.reply(notice('⚠️ **본인 룰렛에만 쓸 수 있어요.**', { ephemeral: true }));
    return;
  }

  // 아래 await 전에 판을 지워서, 연타해도 한 번만 처리되게 한다.
  clearTimeout(prompt.timeoutId);
  prompts.delete(promptId);

  if (action === 'keep') {
    await interaction.deferUpdate().catch(() => {});
    await closePrompt(prompt, interaction);
    return;
  }

  // 관리자 긴급정지·레이드로 미니게임 XP가 멈췄으면 쓰지 않고(해킹 툴도 그대로) 결과를 확정한다.
  if (isMinigameXpFrozen()) {
    const content = isRaidXpFrozen()
      ? `👾 **몬스터 때문에 XP 시스템이 고장 나 ${hackToolWith('을')} 쓸 수 없습니다.**`
      : `⚙️ **현재 관리자가 미니게임 XP를 일시 중지해 ${hackToolWith('을')} 쓸 수 없습니다.**`;
    await interaction.update(notice(`${content}\n-# 결과는 그대로 확정되고 ${hackToolWith('은')} 쓰지 않았어요.`));
    return;
  }

  if (!hackUnlimited(prompt.guildId) && !useHackTool(prompt.guildId, prompt.userId)) {
    await interaction.update(notice(`⚠️ **${hackToolWith('이')} 없어요.** 결과가 그대로 확정됐어요.`));
    return;
  }
  const left = hackToolsOf(prompt.guildId, prompt.userId);
  await interaction.update(notice(`${hackToolEmoji()} **${hackToolWith('을')} 사용했어요!** 다시 돌리는 중...\n-# 남은 ${HACK_TOOL_NAME} ${hackHaveText(left)}`));

  const { lobby, bet } = prompt;
  const hacks = prompt.hacks + 1;
  const spin = rollSpin(bet);
  // 꽝으로 이미 베팅만큼 빠졌으므로 이번 지급액을 그대로 더하면 그날 손익이 (지급 - 베팅)이 된다(또 꽝이면 0).
  let result = { leveledUp: false };
  if (!isTestGuild(prompt.guildId) && spin.payout > 0) {
    result = applyXp(prompt.guildId, prompt.userId, spin.payout, `룰렛 ${HACK_TOOL_NAME} 재도전 ${hacks}회째 (베팅 ${bet}, ${spinLabel(spin)} x${spin.multiplier}, 꽝 번복 지급 ${spin.payout})`);
  }
  logSystem({ 유형: '룰렛', 유저: userLabel(prompt.userId), 내용: `${HACK_TOOL_NAME} 사용(${hacks}회째, 남은 ${left === Infinity ? '무제한' : `${left}개`}) — 베팅 ${bet}, ${spinLabel(spin)} x${spin.multiplier}` });

  let message = null;
  try {
    message = await revealSpin(prompt.channel, prompt.message, lobby, bet, spin, hacks, prompt.reels);
  } catch (err) {
    console.error('룰렛 해킹 툴 결과 공개 실패:', err);
    logError('게임 오류', `룰렛 ${HACK_TOOL_NAME} 결과 채널 공개 실패 — ${userLabel(prompt.userId)}에게만 결과 표시`, err);
    await interaction.followUp(buildResultPayload(lobby, resultView(bet, spin, hacks), { ephemeral: true })).catch(() => {});
  }

  if (result.leveledUp) {
    announceLevelUp(interaction.client, prompt.guildId, prompt.userId, result.newLevel).catch(() => {});
  }

  // 새 결과에도 역린이 있으면 먼저 묻는다(첫 결과에서 아꼈거나, 재도전 결과를 한 릴 더 고치고 싶을 수 있다).
  // 그다음 또 꽝이면 남은 개수가 있는 한 계속 쓸 수 있다(같은 확인 메시지 자리에 다시 묻는다).
  // 아니면 '사용했어요' 안내와 '돌리는 중' 안내를 지운다(결과는 채널 카드에 있다).
  if (message && await offerReroll(interaction, { lobby, bet, spin, channel: prompt.channel, message, reels: spin.reels, hacks, root: prompt.root })) return;
  if (spin.kind === 'none' && message && await offerHack(interaction, { lobby, bet, channel: prompt.channel, message, reels: spin.reels, hacks, root: prompt.root })) return;
  if (message) await closePrompt(prompt, interaction);
}

// 결과가 나온 직후 역린이 있으면 본인에게만 보이는 확인을 띄운다. 시간이 지나면 결과 확정. 띄웠으면 true.
async function offerReroll(interaction, ctx) {
  const have = rerollsOf(ctx.lobby.guildId, ctx.lobby.userId);
  if (have <= 0) return false;
  const prompts = getHackPrompts(interaction.client);
  const prompt = { ...ctx, kind: 'reroll', id: interaction.id, guildId: ctx.lobby.guildId, userId: ctx.lobby.userId, interaction, msg: null, timeoutId: null };
  prompts.set(prompt.id, prompt);
  try {
    // 처음엔 결과 카드 아래 후속 메시지로, 해킹 툴 재도전 뒤에는 같은 확인 메시지 자리(버튼을 누른 메시지)를 고쳐 쓴다.
    if (interaction === ctx.root) prompt.msg = await interaction.followUp(buildRerollPromptPayload(prompt, have, { ephemeral: true }));
    else await interaction.editReply(buildRerollPromptPayload(prompt, have));
  } catch (err) {
    prompts.delete(prompt.id);
    console.error('역린 확인 메시지 표시 실패:', err);
    return false;
  }
  prompt.timeoutId = setTimeout(() => {
    if (prompts.get(prompt.id) !== prompt) return;
    prompts.delete(prompt.id);
    closePrompt(prompt); // 시간이 지나면 결과 확정 — 아이템은 그대로
  }, HACK_PROMPT_MS);
  return true;
}

// 🔁 릴 고르기(rr) / 넘기기(rrkeep) 버튼
async function handleRerollButton(interaction, action, promptId, indexStr) {
  const prompts = getHackPrompts(interaction.client);
  const prompt = prompts.get(promptId);
  if (!prompt || prompt.kind !== 'reroll') {
    await interaction.reply(notice('⚠️ **이미 확정된 결과예요.**', { ephemeral: true }));
    return;
  }
  if (interaction.user.id !== prompt.userId) {
    await interaction.reply(notice('⚠️ **본인 룰렛에만 쓸 수 있어요.**', { ephemeral: true }));
    return;
  }
  // 아래 await 전에 판을 지워서, 연타해도 한 번만 처리되게 한다.
  clearTimeout(prompt.timeoutId);
  prompts.delete(promptId);

  const { lobby, bet } = prompt;
  // 넘기기: 아이템을 쓰지 않고 결과 확정. 꽝이고 해킹 툴이 있으면 이어서 해킹 툴 확인.
  if (action === 'rrkeep') {
    await interaction.deferUpdate().catch(() => {});
    if (prompt.spin.kind === 'none' && await offerHack(interaction, { lobby, bet, channel: prompt.channel, message: prompt.message, reels: prompt.spin.reels, hacks: prompt.hacks, root: prompt.root })) return;
    await closePrompt(prompt, interaction);
    return;
  }
  const index = parseInt(indexStr, 10);
  if (!(index >= 0 && index <= 2)) {
    await interaction.update(notice('⚠️ **릴을 알 수 없어요.** 결과가 그대로 확정됐어요.', { color: REROLL_COLOR }));
    return;
  }
  // 관리자 긴급정지·레이드로 미니게임 XP가 멈췄으면 쓰지 않고(아이템도 그대로) 결과를 확정한다.
  if (isMinigameXpFrozen()) {
    const content = isRaidXpFrozen()
      ? `👾 **몬스터 때문에 XP 시스템이 고장 나 ${REROLL_NAME}을 쓸 수 없습니다.**`
      : `⚙️ **현재 관리자가 미니게임 XP를 일시 중지해 ${REROLL_NAME}을 쓸 수 없습니다.**`;
    await interaction.update(notice(`${content}\n-# 결과는 그대로 확정되고 아이템은 쓰지 않았어요.`, { color: REROLL_COLOR }));
    return;
  }
  if (!hackUnlimited(prompt.guildId) && !useReroll(prompt.guildId, prompt.userId)) {
    await interaction.update(notice(`⚠️ **${REROLL_NAME}이 없어요.** 결과가 그대로 확정됐어요.`, { color: REROLL_COLOR }));
    return;
  }
  const left = rerollsOf(prompt.guildId, prompt.userId);
  await interaction.update(notice(`${rerollEmoji()} **${REROLL_NAME}이 깨어났어요!** ${index + 1}번 릴을 불태워 다시 돌려요...\n-# 남은 ${REROLL_NAME} ${rerollHaveText(left)}`, { color: REROLL_COLOR }));

  const spin = rerollReel(prompt.spin, index, bet);
  // 이미 이전 결과의 지급액까지 정산돼 있으므로 차액(음수 포함)만 반영해 그날 손익이 (새 지급 - 베팅)이 되게 한다.
  const diff = spin.payout - prompt.spin.payout;
  let result = { leveledUp: false };
  if (!isTestGuild(prompt.guildId) && diff !== 0) {
    result = applyXp(prompt.guildId, prompt.userId, diff, `룰렛 ${REROLL_NAME} ${index + 1}번 릴 (베팅 ${bet}, ${spinLabel(prompt.spin)} → ${spinLabel(spin)} x${spin.multiplier}, 차액 ${diff})`);
  }
  logSystem({ 유형: '룰렛', 유저: userLabel(prompt.userId), 내용: `${REROLL_NAME} 사용(${index + 1}번 릴, 남은 ${left === Infinity ? '무제한' : `${left}개`}) — 베팅 ${bet}, ${spinLabel(prompt.spin)} → ${spinLabel(spin)} x${spin.multiplier}` });

  let message = null;
  try {
    message = await revealSpin(prompt.channel, prompt.message, lobby, bet, spin, prompt.hacks, null, { index, prevReels: prompt.spin.reels, note: `${index + 1}번 릴: ${prompt.spin.reels[index]} → ${spin.reels[index]} · ${spinLabel(prompt.spin)} → ${spinLabel(spin)}` });
  } catch (err) {
    console.error('룰렛 역린 결과 공개 실패:', err);
    logError('게임 오류', `룰렛 ${REROLL_NAME} 결과 채널 공개 실패 — ${userLabel(prompt.userId)}에게만 결과 표시`, err);
    await interaction.followUp(buildResultPayload(lobby, resultView(bet, spin, prompt.hacks, { index, note: `${index + 1}번 릴: ${prompt.spin.reels[index]} → ${spin.reels[index]} · ${spinLabel(prompt.spin)} → ${spinLabel(spin)}` }), { ephemeral: true })).catch(() => {});
  }
  if (result.leveledUp) announceLevelUp(interaction.client, prompt.guildId, prompt.userId, result.newLevel).catch(() => {});

  // 다시 돌린 결과가 꽝이고 해킹 툴이 있으면 이어서 해킹 툴 확인(같은 확인 메시지 자리).
  if (spin.kind === 'none' && message && await offerHack(interaction, { lobby, bet, channel: prompt.channel, message, reels: spin.reels, hacks: prompt.hacks, root: prompt.root })) return;
  if (message) await closePrompt(prompt, interaction);
}

async function handleRouletteButton(interaction) {
  const { customId } = interaction;
  const lobbies = getLobbies(interaction.client);
  const parts = customId.split(':');
  const action = parts[1]; // bet | max | gate | spin | cancel | hack | keep
  if (action === 'hack' || action === 'keep') {
    await handleHackButton(interaction, action, parts[2]);
    return;
  }
  if (action === 'rr' || action === 'rrkeep') {
    await handleRerollButton(interaction, action, parts[2], parts[3]);
    return;
  }
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

  if (action === 'gate') {
    if (!(lobby.gateways > 0)) { await interaction.reply(notice(`⚠️ **${GATEWAY_NAME}가 없어요.**`, { ephemeral: true })); return; }
    lobby.gatewayArmed = !lobby.gatewayArmed;
    if (lobby.gatewayArmed && lobby.maxAvailable >= MIN_BET) lobby.bet = lobby.maxAvailable; // 사용하면 걸 수 있는 최댓값으로 자동 베팅(바로 🎰 돌리기가 켜짐)
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
module.exports = { buildLobbyPayload, buildWallErosionPayload, WALL_EROSION, buildSpinningPayload, buildResultPayload, buildHackPromptPayload, buildRerollPromptPayload, buildRerollIntroPayload, buildRerollSpinPayload, rerollReel, buildHackIntroPayload, startRouletteCommand, handleRouletteButton, loadRoulette, saveRoulette, MIN_BET, MAX_BET };

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { applyXp, getXp, levelFromXp, LEVEL_UP_ANNOUNCE_CHANNEL_ID, EXCLUDED_GUILD_IDS } = require('./레벨');

const TURN_MS  = 20_000;
const TURN_SEC = TURN_MS / 1000;
const JOIN_MS  = 90_000;
const REMATCH_EXPIRY_MS = 5 * 60_000; // 종료된 게임은 5분간 재대결 버튼으로 이어할 수 있음
const KOREAN   = /^[가-힣]+$/;
// 사람끼리만 참가한 게임에서 자동으로 거는 내기 XP. 진 사람의 "현재 레벨 안에 쌓인 XP"로
// 상한을 걸어(min(WAGER_XP, currentLevelXp)) 내기에서 져도 레벨이 떨어지지는 않게 한다.
// 살아남은 사람이 여럿이면 진 사람의 몫을 그만큼 나눠 가짐(틱택토와 동일한 방식).
const WAGER_XP = 100;
// 참가자 중 봇이 있는 게임에서 봇이 탈락했을 때 생존자 각자에게 지급하는 고정 XP(내기 아님).
const BOT_WIN_XP = 60;
// 악용 방지: 봇전 반복 플레이로 XP를 무한히 파밍하거나("🏳️ 포기"로 즉시 끝내는 것 포함),
// 같은 상대와 즉석 내기를 연달아 반복해서 XP를 옮기는 것을 막기 위해 유저당 쿨다운을 둔다
// (쿨다운 중이면 게임 자체는 정상 진행되지만 XP 정산만 생략됨 — 플레이를 막지는 않음).
const XP_SETTLE_COOLDOWN_MS = 3 * 60 * 1000;
const xpSettleCooldowns = new Map(); // userId → 마지막 XP 정산 시각

function isOnCooldown(userId) {
  const last = xpSettleCooldowns.get(userId);
  return !!last && Date.now() - last < XP_SETTLE_COOLDOWN_MS;
}

function markCooldown(userId) {
  xpSettleCooldowns.set(userId, Date.now());
}

// ── 두음법칙 변환 ─────────────────────────────────────────────────
// 단어 첫머리의 'ㄹ/ㄴ' 초성은 뒤따르는 모음에 따라 'ㄴ' 또는 'ㅇ'으로
// 바뀌어 표기됩니다 (예: 력 → 역, 로 → 노). 끝말잇기에서는 이전 단어가
// 이런 글자로 끝나면, 다음 단어는 원래 글자 또는 두음법칙 변환형
// 둘 중 하나로 시작해도 인정해야 합니다.
const DUEUM_YA_VOWELS = new Set([2, 6, 7, 12, 17, 20]); // ㅑㅕㅖㅛㅠㅣ
const DUEUM_A_VOWELS  = new Set([0, 1, 8, 11, 13, 18]); // ㅏㅐㅗㅚㅜㅡ

function dueumConvert(char) {
  const code = char.charCodeAt(0) - 0xAC00;
  if (code < 0 || code > 11171) return null;

  const initial = Math.floor(code / (21 * 28));
  const medial = Math.floor((code % (21 * 28)) / 28);
  const final = code % 28;

  let newInitial = null;
  if (initial === 5) { // ㄹ
    if (DUEUM_YA_VOWELS.has(medial)) newInitial = 11; // ㅇ
    else if (DUEUM_A_VOWELS.has(medial)) newInitial = 2; // ㄴ
  } else if (initial === 2 && DUEUM_YA_VOWELS.has(medial)) { // ㄴ
    newInitial = 11; // ㅇ
  }

  if (newInitial === null) return null;
  return String.fromCharCode(0xAC00 + newInitial * 21 * 28 + medial * 28 + final);
}

function getAcceptableStarts(lastChar) {
  const converted = dueumConvert(lastChar);
  return converted ? [lastChar, converted] : [lastChar];
}

// ── 한국어기초사전 API 검증 ──────────────────────────────────────
// 키가 없거나 API 호출이 실패하면 통과 처리(fail-open)하여
// 인프라 문제로 게임이 부당하게 끝나지 않도록 합니다.
async function checkWordExists(word) {
  const apiKey = process.env.KRDICT_API_KEY;
  if (!apiKey) return true;

  try {
    const url = `https://krdict.korean.go.kr/api/search?key=${apiKey}&q=${encodeURIComponent(word)}&method=exact&part=word&advanced=y&target=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return true;

    const xml = await res.text();
    const match = xml.match(/<total>(\d+)<\/total>/);
    return match ? Number(match[1]) > 0 : true;
  } catch {
    return true;
  }
}

// ── 봇 단어 선택 (API 기반) ───────────────────────────────────────
const KO_SEED_SYLLABLES = [
  '가', '나', '다', '라', '마', '바', '사', '아', '자', '차', '카', '타', '파', '하',
  '거', '너', '더', '러', '머', '버', '서', '어', '저', '처', '커', '터', '퍼', '허',
];

async function fetchWordsStartingWith(prefix) {
  const apiKey = process.env.KRDICT_API_KEY;
  if (!apiKey) return null;

  try {
    const url = `https://krdict.korean.go.kr/api/search?key=${apiKey}&q=${encodeURIComponent(prefix)}&method=start&pos=1&num=100&sort=popular&part=word&advanced=y&target=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;

    const xml = await res.text();
    return [...xml.matchAll(/<word>([^<]+)<\/word>/g)]
      .map(m => m[1].trim())
      .filter(w => KOREAN.test(w) && w.length >= 2 && w[0] === prefix);
  } catch {
    return null;
  }
}

async function findBotWord(game) {
  const prefixes = game.lastChar
    ? getAcceptableStarts(game.lastChar)
    : [KO_SEED_SYLLABLES[Math.floor(Math.random() * KO_SEED_SYLLABLES.length)]];

  const results = await Promise.all(prefixes.map(fetchWordsStartingWith));
  if (results.every(r => !r)) return null; // 전부 API 실패

  const candidates = results.flat().filter(Boolean);
  const unused = [...new Set(candidates)].filter(w => !game.used.has(w));
  if (!unused.length) return null;
  return unused[Math.floor(Math.random() * unused.length)];
}

function getGames(client) {
  if (!client.wcGames) client.wcGames = new Map();
  return client.wcGames;
}

function getDisplayName(interaction) {
  return interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
}

// ── 임베드 빌더 ────────────────────────────────────────────────

function buildWaitingEmbed(game) {
  const participantText = game.players.length > 0
    ? `\`\`\`\n${game.players.map((p, i) => `${i + 1}. ${p.name}${p.id === game.hostId ? ' 👑' : ''}`).join('\n')}\n\`\`\``
    : '*아직 참가자가 없습니다.*';

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setDescription('# 🔤 끝말잇기\n참가자를 기다리는 중입니다.');
  return embed
    .addFields(
      { name: `👥 참가자  ${game.players.length}명`, value: participantText },
      {
        name: '📋 규칙',
        value:
          '• 이전 단어의 **마지막 글자**로 시작하는 단어를 입력하세요.\n' +
          '• 두음법칙 변환형(예: 력→역, 로→노)도 인정됩니다.\n' +
          '• 실제 사전에 있는 단어만 인정됩니다. (2글자 이상)\n' +
          '• 이미 사용된 단어는 사용할 수 없습니다.\n' +
          `• **${TURN_SEC}초** 내에 입력하지 않으면 탈락합니다.`,
      },
      {
        name: '⚠️ XP 내기',
        value: `참가자가 전부 사람이면 탈락자가 최대 ${WAGER_XP} XP를 잃고(레벨은 안 깎임) 생존자들이 나눠 받습니다. 봇이 참가하면 내기 대신, 봇을 이겼을 때 생존자에게 고정 XP가 지급됩니다.`,
      },
    )
    .setFooter({ text: '최소 2명이 참가해야 시작할 수 있습니다.' });
}

function buildPlayingEmbed(game) {
  const currentPlayer = game.players[game.currentIdx];
  const recentWords = game.history.slice(-8).join(' → ') || '(없음)';

  const wordLine = game.lastWord
    ? `**마지막 단어** : \`${game.lastWord}\`　**시작 글자** : \`${getAcceptableStarts(game.lastChar).join('`/`')}\``
    : '**첫 번째 단어를 입력하세요!** (아무 한국어 단어)';

  const participantText = `\`\`\`\n${game.players.map((p, i) => `${i + 1}. ${p.name}${i === game.currentIdx ? ' ▶️' : ''}`).join('\n')}\n\`\`\``;

  const embed = new EmbedBuilder()
    .setColor(0x57F287)
    .setDescription(`# 🔤 끝말잇기 진행 중\n${wordLine}\n\n💬 **\`${currentPlayer.name}\`의 차례** — 채팅에 단어를 입력하세요! (${currentPlayer.id === 'BOT' ? '자동' : `${TURN_SEC}초`})`);
  return embed
    .addFields(
      { name: `👥 참가자  ${game.players.length}명`, value: participantText, inline: true },
      { name: '📝 최근 단어', value: recentWords, inline: true },
    )
    .setTimestamp();
}

function buildFinishedEmbed(game) {
  const loserPlayer = game.players.find(p => p.id === game.loser);
  const loserName = loserPlayer?.name ?? '알 수 없음';

  const REASONS = {
    timeout:     `⏰ ${TURN_SEC}초 내에 단어를 입력하지 못했습니다.`,
    wrong_start: `❌ \`${game.failWord}\`은(는) \`${getAcceptableStarts(game.lastChar).join('\`/\`')}\`(으)로 시작하지 않습니다.`,
    duplicate:   `🔁 \`${game.failWord}\`은(는) 이미 사용된 단어입니다.`,
    not_korean:  `🚫 \`${game.failWord}\`은(는) 한국어 단어가 아닙니다.`,
    too_short:   `🚫 한 글자 단어(\`${game.failWord}\`)는 사용할 수 없습니다.`,
    not_in_dict: `📖 \`${game.failWord}\`은(는) 사전에 없는 단어입니다.`,
    gave_up:     `🏳️ 단어를 이을 수 없어 포기했습니다.`,
    cancelled:   `❌ 방장이 게임을 취소했습니다.`,
  };

  const recent = game.history.slice(-10).join(' → ') || '(없음)';

  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setDescription(
      `# 🔤 끝말잇기 종료\n**탈락** : \`${loserName}\`\n**이유** : ${REASONS[game.endReason] || '게임 종료'}\n\n` +
      `총 **${game.history.length}개** 단어 사용` +
      formatXpResultLine(game),
    );
  return embed
    .addFields({ name: '📝 마지막 단어들', value: recent })
    .setTimestamp();
}

function formatXpResultLine(game) {
  const result = game.xpResult;
  if (!result) return '';

  const winnerText = result.winnerResults.map(w => `<@${w.userId}> +${w.amount}`).join(', ');
  if (result.type === 'wager') {
    return `\n🎲 내기 결과 : <@${result.loserId}> −${result.wager} XP → ${winnerText} XP`;
  }
  return `\n🎉 봇을 이겨서 XP 획득 : ${winnerText} XP`;
}

// ── 컴포넌트 빌더 ──────────────────────────────────────────────

function buildWaitingComponents(game) {
  const hasBot = game.players.some(p => p.id === 'BOT');
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`wc:join:${game.id}`)
        .setLabel('✋ 참가')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`wc:start:${game.id}`)
        .setLabel('▶️ 게임 시작')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(game.players.length < 2),
      new ButtonBuilder()
        .setCustomId(`wc:bot_start:${game.id}`)
        .setLabel('🤖 봇과 시작')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(hasBot || game.players.length !== 1),
      new ButtonBuilder()
        .setCustomId(`wc:cancel:${game.id}`)
        .setLabel('❌ 취소')
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function buildPlayingComponents(game) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`wc:giveup:${game.id}`)
        .setLabel('🏳️ 포기')
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function buildFinishedComponents(game) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`wc:rematch:${game.id}`)
        .setLabel('🔁 재대결')
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

// ── 재대결 승낙/거절 ──────────────────────────────────────────
// 참가자가 여럿일 수 있으므로, 재대결을 신청하면 신청자를 제외한 이전 참가자 전원이
// 각자 수락/거절해야 한다. 사람 상대가 없었던(봇하고만 했던) 게임은 승낙받을 상대가
// 없으므로 이 단계 없이 바로 시작한다(startRematchGame으로 직행).
function buildRematchRequestEmbed(game) {
  const lines = game.humanPlayers
    .map(p => `${game.accepted.has(p.id) ? '✅ 수락' : '⌛ 대기 중'}  <@${p.id}>`)
    .join('\n');
  let desc = `# 🔁 끝말잇기 재대결 신청\n모두 수락하면 바로 시작됩니다.\n\n${lines}`;
  if (game.hadBot) desc += '\n\n🤖 봇도 함께 참가합니다.';

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setDescription(desc)
    .setTimestamp();
}

function buildRematchRequestComponents(game) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`wc:rematch_accept:${game.id}`).setLabel('✅ 수락').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`wc:rematch_decline:${game.id}`).setLabel('❌ 거절').setStyle(ButtonStyle.Danger),
    ),
  ];
}

async function startRematchRequest(interaction, humanPlayers, hadBot) {
  const games = getGames(interaction.client);
  const gameId = interaction.id;

  const game = {
    id: gameId,
    channelId: interaction.channelId,
    guildId: interaction.guildId,
    status: 'rematch_pending',
    humanPlayers,
    hadBot,
    accepted: new Set([interaction.user.id]),
    message: null,
    timeoutId: null,
  };
  games.set(gameId, game);

  await interaction.update({
    content: '',
    embeds: [buildRematchRequestEmbed(game)],
    components: buildRematchRequestComponents(game),
    attachments: [],
  });
  game.message = await interaction.fetchReply();

  // 60초 내로 전원 수락하지 않으면 만료
  game.timeoutId = setTimeout(async () => {
    const g = games.get(gameId);
    if (!g || g.status !== 'rematch_pending') return;
    games.delete(gameId);
    await g.message.edit({ content: '⏰ **재대결 신청이 만료되었습니다.**', embeds: [], components: [], attachments: [] }).catch(() => {});
  }, 60_000);
}

// 전원 수락(혹은 애초에 사람 상대가 없어 승낙이 필요 없는) 경우 실제 게임을 시작한다.
async function startRematchGame(interaction, gameId, humanPlayers, hadBot) {
  const games = getGames(interaction.client);

  const players = humanPlayers.map(p => ({ id: p.id, name: p.name }));
  if (hadBot) players.push({ id: 'BOT', name: '봇' });
  for (let i = players.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [players[i], players[j]] = [players[j], players[i]];
  }

  const game = {
    id: gameId,
    hostId: interaction.user.id,
    channelId: interaction.channelId,
    guildId: interaction.guildId,
    players,
    currentIdx: 0,
    used: new Set(),
    history: [],
    lastWord: null,
    lastChar: null,
    status: 'playing',
    loser: null,
    endReason: null,
    failWord: null,
    xpResult: null,
    message: null,
    timeoutId: null,
  };
  games.set(gameId, game);

  await interaction.update({
    content: '🔄 **재대결이 시작됐습니다!**',
    embeds: [buildPlayingEmbed(game)],
    components: buildPlayingComponents(game),
    attachments: [],
  });
  game.message = await interaction.fetchReply();
  startTurn(game, games);
}

// ── 게임 종료 / XP 정산 ────────────────────────────────────────

// 사람끼리만 참가한 게임에서 진 사람의 내기 XP(min(WAGER_XP, 현재 레벨 안 XP))를 생존자들에게
// 고르게 나눠준다 — 참가자 중 봇이 있으면(hasBot) 적용하지 않음(아래 settleBotWinXp가 대신 처리).
function settleWagerXp(game) {
  if (!game.guildId || game.endReason === 'cancelled') return null;
  if (game.players.some(p => p.id === 'BOT')) return null;

  const survivors = game.players.map(p => p.id).filter(id => id !== game.loser);
  if (!survivors.length) return null;
  if (isOnCooldown(game.loser) || survivors.some(isOnCooldown)) return null; // 같은 유저들이 연달아 내기를 반복해 XP를 옮기는 것 방지

  const loserLevelXp = levelFromXp(getXp(game.guildId, game.loser)).currentLevelXp;
  const wager = Math.min(WAGER_XP, loserLevelXp);
  if (wager <= 0) return null;

  const loserResult = applyXp(game.guildId, game.loser, -wager);
  const share = Math.floor(wager / survivors.length);
  let remainder = wager - share * survivors.length;
  const winnerResults = [];
  for (const id of survivors) {
    const amount = share + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
    if (amount > 0) winnerResults.push({ userId: id, amount, ...applyXp(game.guildId, id, amount) });
  }
  return { type: 'wager', wager, loserId: game.loser, loserResult, winnerResults };
}

// 참가자 중 봇이 있었고 봇이 탈락했다면(=사람들이 이김) 생존자(사람) 각자에게 고정 XP를 지급.
// 사람이 탈락한 경우(봇이 살아남은 경우)는 지급하지 않음 — 봇전은 보상만 있고 패널티는 없음.
function settleBotWinXp(game) {
  if (!game.guildId || game.endReason === 'cancelled') return null;
  if (game.loser !== 'BOT') return null;

  const survivors = game.players.map(p => p.id).filter(id => id !== 'BOT');
  if (!survivors.length) return null;
  if (survivors.some(isOnCooldown)) return null; // 봇전 반복 플레이로 XP를 무한히 파밍하는 것 방지

  const winnerResults = survivors.map(id => ({ userId: id, amount: BOT_WIN_XP, ...applyXp(game.guildId, id, BOT_WIN_XP) }));
  return { type: 'bot_win', winnerResults };
}

async function announceLevelUp(client, guildId, userId, newLevel) {
  try {
    const channel = await client.channels.fetch(LEVEL_UP_ANNOUNCE_CHANNEL_ID).catch(() => null);
    if (channel?.guildId === guildId) {
      await channel.send({ content: `<@${userId}>님이 ${newLevel}레벨을 달성했어요. 🎉`, allowedMentions: { users: [userId] } });
    }
  } catch (err) {
    console.error('끝말잇기 레벨업 메시지 전송 실패:', err);
  }
}

function settleGameXp(game) {
  if (EXCLUDED_GUILD_IDS.includes(game.guildId)) return; // 레벨 시스템 제외 서버(테스트 서버 등)는 내기/보상도 미적용
  const result = settleWagerXp(game) || settleBotWinXp(game);
  game.xpResult = result;
  if (!result) return;

  if (result.loserId) markCooldown(result.loserId);
  for (const w of result.winnerResults) markCooldown(w.userId);

  const client = game.message?.client;
  if (!client) return;
  for (const w of result.winnerResults) {
    if (w.leveledUp) announceLevelUp(client, game.guildId, w.userId, w.newLevel).catch(() => {});
  }
}

function endGame(game, games, loserId, reason, failWord = null) {
  clearTimeout(game.timeoutId);
  game.status    = 'finished';
  game.loser     = loserId;
  game.endReason = reason;
  game.failWord  = failWord;
  settleGameXp(game);
  // 즉시 지우지 않고 잠시 남겨둬서 '재대결' 버튼이 원래 참가자 명단을 찾을 수 있게 함
  setTimeout(() => games.delete(game.id), REMATCH_EXPIRY_MS);
  game.message?.edit({ embeds: [buildFinishedEmbed(game)], components: buildFinishedComponents(game), attachments: [] }).catch(() => {});
}

async function botPlay(game, games) {
  const g = games.get(game.id);
  if (!g || g.status !== 'playing') return;

  const word = await findBotWord(g);
  if (games.get(g.id) !== g || g.status !== 'playing') return; // 검색 대기 중 이미 종료됨
  if (!word) {
    endGame(g, games, 'BOT', 'gave_up');
    return;
  }

  g.used.add(word);
  g.history.push(word);
  g.lastWord = word;
  g.lastChar = word[word.length - 1];
  g.currentIdx = (g.currentIdx + 1) % g.players.length;

  await g.message?.edit({
    embeds: [buildPlayingEmbed(g)],
    components: buildPlayingComponents(g),
    attachments: [],
  }).catch(() => {});

  startTurn(g, games);
}

function startTurn(game, games) {
  clearTimeout(game.timeoutId);

  const currentPlayer = game.players[game.currentIdx];
  if (currentPlayer.id === 'BOT') {
    game.timeoutId = setTimeout(() => botPlay(game, games), 2000);
    return;
  }

  game.timeoutId = setTimeout(() => {
    const g = games.get(game.id);
    if (!g || g.status !== 'playing') return;
    endGame(g, games, g.players[g.currentIdx].id, 'timeout');
  }, TURN_MS);
}

// ── 커맨드 진입 ────────────────────────────────────────────────

async function createLobby(interaction, initialPlayers, hostId) {
  const games = getGames(interaction.client);
  const gameId = interaction.id;

  const game = {
    id: gameId,
    hostId,
    channelId: interaction.channelId,
    guildId: interaction.guildId,
    players: initialPlayers,
    currentIdx: 0,
    used: new Set(),
    history: [],
    lastWord: null,
    lastChar: null,
    status: 'waiting',
    loser: null,
    endReason: null,
    failWord: null,
    xpResult: null,
    message: null,
    timeoutId: null,
  };
  games.set(gameId, game);

  await interaction.reply({
    embeds: [buildWaitingEmbed(game)],
    components: buildWaitingComponents(game),
    attachments: [],
  });
  try {
    game.message = await interaction.fetchReply();
  } catch {
    games.delete(gameId);
    return;
  }

  game.timeoutId = setTimeout(async () => {
    const g = games.get(gameId);
    if (!g || g.status !== 'waiting') return;
    games.delete(gameId);
    await game.message?.edit({ content: '⏰ **참가자가 없어 게임이 취소되었습니다.**', embeds: [], components: [], attachments: [] }).catch(() => {});
  }, JOIN_MS);
}

async function startWcCommand(interaction) {
  await createLobby(
    interaction,
    [{ id: interaction.user.id, name: getDisplayName(interaction) }],
    interaction.user.id,
  );
}

// ── 버튼 핸들러 ────────────────────────────────────────────────

async function handleWcButton(interaction) {
  const { customId } = interaction;
  const games = getGames(interaction.client);

  // ── 참가 ──────────────────────────────────────────────────
  if (customId.startsWith('wc:join:')) {
    const gameId = customId.slice('wc:join:'.length);
    const game = games.get(gameId);
    if (!game || game.status !== 'waiting') {
      await interaction.reply({ content: '⚠️ **참가할 수 없는 게임입니다.**', ephemeral: true });
      return;
    }
    if (game.players.some(p => p.id === interaction.user.id)) {
      await interaction.reply({ content: '⚠️ **이미 참가 중입니다.**', ephemeral: true });
      return;
    }
    game.players.push({ id: interaction.user.id, name: getDisplayName(interaction) });
    await interaction.update({ embeds: [buildWaitingEmbed(game)], components: buildWaitingComponents(game), attachments: [] });
    return;
  }

  // ── 시작 ──────────────────────────────────────────────────
  if (customId.startsWith('wc:start:')) {
    const gameId = customId.slice('wc:start:'.length);
    const game = games.get(gameId);
    if (!game || game.status !== 'waiting') {
      await interaction.reply({ content: '⚠️ **게임을 시작할 수 없습니다.**', ephemeral: true });
      return;
    }
    if (interaction.user.id !== game.hostId) {
      await interaction.reply({ content: '⚠️ **방장만 게임을 시작할 수 있습니다.**', ephemeral: true });
      return;
    }
    if (game.players.length < 2) {
      await interaction.reply({ content: '⚠️ **최소 2명이 필요합니다.**', ephemeral: true });
      return;
    }
    clearTimeout(game.timeoutId);
    for (let i = game.players.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [game.players[i], game.players[j]] = [game.players[j], game.players[i]];
    }
    game.status = 'playing';
    game.currentIdx = 0;
    await interaction.update({ embeds: [buildPlayingEmbed(game)], components: buildPlayingComponents(game), attachments: [] });
    startTurn(game, games);
    return;
  }

  // ── 봇과 시작 ─────────────────────────────────────────────
  if (customId.startsWith('wc:bot_start:')) {
    const gameId = customId.slice('wc:bot_start:'.length);
    const game = games.get(gameId);
    if (!game || game.status !== 'waiting') {
      await interaction.reply({ content: '⚠️ **게임을 시작할 수 없습니다.**', ephemeral: true });
      return;
    }
    if (interaction.user.id !== game.hostId) {
      await interaction.reply({ content: '⚠️ **방장만 사용할 수 있습니다.**', ephemeral: true });
      return;
    }
    if (game.players.some(p => p.id === 'BOT')) {
      await interaction.reply({ content: '⚠️ **봇은 이미 참가 중입니다.**', ephemeral: true });
      return;
    }
    if (game.players.length !== 1) {
      await interaction.reply({ content: '⚠️ **참가자가 1명일 때만 봇과 시작할 수 있습니다.**', ephemeral: true });
      return;
    }
    clearTimeout(game.timeoutId);
    game.players.push({ id: 'BOT', name: '봇' });
    for (let i = game.players.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [game.players[i], game.players[j]] = [game.players[j], game.players[i]];
    }
    game.status = 'playing';
    game.currentIdx = 0;
    await interaction.update({ embeds: [buildPlayingEmbed(game)], components: buildPlayingComponents(game), attachments: [] });
    startTurn(game, games);
    return;
  }

  // ── 취소 ──────────────────────────────────────────────────
  if (customId.startsWith('wc:cancel:')) {
    const gameId = customId.slice('wc:cancel:'.length);
    const game = games.get(gameId);
    if (!game) {
      await interaction.reply({ content: '⚠️ **게임을 찾을 수 없습니다.**', ephemeral: true });
      return;
    }
    if (interaction.user.id !== game.hostId) {
      await interaction.reply({ content: '⚠️ **방장만 취소할 수 있습니다.**', ephemeral: true });
      return;
    }
    clearTimeout(game.timeoutId);
    if (game.status === 'playing') {
      endGame(game, games, game.hostId, 'cancelled');
      await interaction.deferUpdate();
    } else {
      games.delete(gameId);
      await interaction.update({ content: '❌ **게임이 취소되었습니다.**', embeds: [], components: [], attachments: [] });
    }
    return;
  }

  // ── 포기 ──────────────────────────────────────────────────
  if (customId.startsWith('wc:giveup:')) {
    const gameId = customId.slice('wc:giveup:'.length);
    const game = games.get(gameId);
    if (!game || game.status !== 'playing') {
      await interaction.reply({ content: '⚠️ **진행 중인 게임이 아닙니다.**', ephemeral: true });
      return;
    }
    const currentPlayer = game.players[game.currentIdx];
    if (currentPlayer.id === 'BOT' || interaction.user.id !== currentPlayer.id) {
      await interaction.reply({ content: `⚠️ **지금은 \`${currentPlayer.name}\`의 차례입니다.**`, ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    endGame(game, games, currentPlayer.id, 'gave_up');
    return;
  }

  // ── 재대결 신청 ───────────────────────────────────────────
  if (customId.startsWith('wc:rematch:')) {
    const oldGameId = customId.slice('wc:rematch:'.length);
    const oldGame = games.get(oldGameId);
    if (!oldGame || oldGame.status !== 'finished') {
      await interaction.reply({ content: '⚠️ **재대결을 시작할 수 없습니다.** `/끝말잇기`로 새로 시작해주세요.', ephemeral: true });
      return;
    }
    if (!oldGame.players.some(p => p.id === interaction.user.id)) {
      await interaction.reply({ content: '⚠️ **이전 게임 참가자만 재대결을 시작할 수 있습니다.**', ephemeral: true });
      return;
    }

    const hadBot = oldGame.players.some(p => p.id === 'BOT');
    const humanPlayers = oldGame.players.filter(p => p.id !== 'BOT').map(p => ({ id: p.id, name: p.name }));
    const others = humanPlayers.filter(p => p.id !== interaction.user.id);

    if (others.length === 0) {
      // 승낙받을 사람 상대가 없음(봇하고만 했던 게임) — 바로 시작
      await startRematchGame(interaction, interaction.id, humanPlayers, hadBot);
    } else {
      await startRematchRequest(interaction, humanPlayers, hadBot);
    }
    return;
  }

  // ── 재대결 수락 ───────────────────────────────────────────
  if (customId.startsWith('wc:rematch_accept:')) {
    const gameId = customId.slice('wc:rematch_accept:'.length);
    const game = games.get(gameId);
    if (!game || game.status !== 'rematch_pending') {
      await interaction.reply({ content: '⚠️ **만료된 재대결 신청입니다.**', ephemeral: true });
      return;
    }
    if (!game.humanPlayers.some(p => p.id === interaction.user.id)) {
      await interaction.reply({ content: '⚠️ **이전 게임 참가자만 응답할 수 있습니다.**', ephemeral: true });
      return;
    }
    game.accepted.add(interaction.user.id);

    if (game.humanPlayers.every(p => game.accepted.has(p.id))) {
      clearTimeout(game.timeoutId);
      await startRematchGame(interaction, gameId, game.humanPlayers, game.hadBot);
      return;
    }

    await interaction.update({ embeds: [buildRematchRequestEmbed(game)], components: buildRematchRequestComponents(game) });
    return;
  }

  // ── 재대결 거절 ───────────────────────────────────────────
  if (customId.startsWith('wc:rematch_decline:')) {
    const gameId = customId.slice('wc:rematch_decline:'.length);
    const game = games.get(gameId);
    if (!game || game.status !== 'rematch_pending') {
      await interaction.reply({ content: '⚠️ **만료된 재대결 신청입니다.**', ephemeral: true });
      return;
    }
    if (!game.humanPlayers.some(p => p.id === interaction.user.id)) {
      await interaction.reply({ content: '⚠️ **이전 게임 참가자만 응답할 수 있습니다.**', ephemeral: true });
      return;
    }
    clearTimeout(game.timeoutId);
    games.delete(gameId);
    await interaction.update({ content: `❌ **<@${interaction.user.id}>님이 재대결을 거절했습니다.**`, embeds: [], components: [], attachments: [] });
    return;
  }
}

// ── 채팅 메시지 핸들러 ──────────────────────────────────────────

async function handleWcMessage(message) {
  if (message.author.bot) return;

  const games = getGames(message.client);
  for (const game of games.values()) {
    if (game.status !== 'playing') continue;
    if (game.channelId !== message.channelId) continue;

    const currentPlayer = game.players[game.currentIdx];
    if (currentPlayer.id === 'BOT' || currentPlayer.id !== message.author.id) continue;

    const word = message.content.trim();
    if (!word) continue; // 스티커/첨부파일 등 텍스트 없는 메시지는 시도로 취급하지 않음

    if (!KOREAN.test(word)) {
      await message.react('❌').catch(() => {});
      endGame(game, games, currentPlayer.id, 'not_korean', word);
      return;
    }

    if (word.length < 2) {
      await message.react('❌').catch(() => {});
      endGame(game, games, currentPlayer.id, 'too_short', word);
      return;
    }

    if (game.lastChar && !getAcceptableStarts(game.lastChar).includes(word[0])) {
      await message.react('❌').catch(() => {});
      endGame(game, games, currentPlayer.id, 'wrong_start', word);
      return;
    }

    if (game.used.has(word)) {
      await message.react('❌').catch(() => {});
      endGame(game, games, currentPlayer.id, 'duplicate', word);
      return;
    }

    const exists = await checkWordExists(word);
    if (games.get(game.id) !== game || game.status !== 'playing') return; // 검증 대기 중 타임아웃 등으로 이미 종료됨
    if (!exists) {
      await message.react('❌').catch(() => {});
      endGame(game, games, currentPlayer.id, 'not_in_dict', word);
      return;
    }

    game.used.add(word);
    game.history.push(word);
    game.lastWord = word;
    game.lastChar = word[word.length - 1];
    game.currentIdx = (game.currentIdx + 1) % game.players.length;

    await message.react('✅').catch(() => {});
    await game.message.edit({
      embeds: [buildPlayingEmbed(game)],
      components: buildPlayingComponents(game),
      attachments: [],
    }).catch(() => {});

    startTurn(game, games);
    return;
  }
}

module.exports = { startWcCommand, handleWcButton, handleWcMessage };

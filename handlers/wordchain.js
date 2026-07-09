const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const { applyThumbnail, getThumbnailFiles } = require('./shared');

const TURN_MS  = 20_000;
const TURN_SEC = TURN_MS / 1000;
const JOIN_MS  = 90_000;
const REMATCH_EXPIRY_MS = 5 * 60_000; // 종료된 게임은 5분간 재대결 버튼으로 이어할 수 있음
const KOREAN   = /^[가-힣]+$/;

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
    .setTitle('끝말잇기')
    .setDescription('참가자를 기다리는 중입니다.');
  applyThumbnail(embed);
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
    .setTitle('끝말잇기 진행 중')
    .setDescription(`${wordLine}\n\n💬 **\`${currentPlayer.name}\`의 차례** — 채팅에 단어를 입력하세요! (${currentPlayer.id === 'BOT' ? '자동' : `${TURN_SEC}초`})`);
  applyThumbnail(embed);
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
    .setTitle('끝말잇기 종료')
    .setDescription(
      `**탈락** : \`${loserName}\`\n**이유** : ${REASONS[game.endReason] || '게임 종료'}\n\n` +
      `총 **${game.history.length}개** 단어 사용`,
    );
  applyThumbnail(embed);
  return embed
    .addFields({ name: '📝 마지막 단어들', value: recent })
    .setTimestamp();
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

// ── 게임 종료 ──────────────────────────────────────────────────

function endGame(game, games, loserId, reason, failWord = null) {
  clearTimeout(game.timeoutId);
  game.status    = 'finished';
  game.loser     = loserId;
  game.endReason = reason;
  game.failWord  = failWord;
  // 즉시 지우지 않고 잠시 남겨둬서 '재대결' 버튼이 원래 참가자 명단을 찾을 수 있게 함
  setTimeout(() => games.delete(game.id), REMATCH_EXPIRY_MS);
  game.message?.edit({ embeds: [buildFinishedEmbed(game)], components: buildFinishedComponents(game) }).catch(() => {});
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
    message: null,
    timeoutId: null,
  };
  games.set(gameId, game);

  await interaction.reply({
    embeds: [buildWaitingEmbed(game)],
    components: buildWaitingComponents(game),
    files: getThumbnailFiles(),
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
    await game.message?.edit({ content: '⏰ **참가자가 없어 게임이 취소되었습니다.**', embeds: [], components: [] }).catch(() => {});
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
    await interaction.update({ embeds: [buildWaitingEmbed(game)], components: buildWaitingComponents(game) });
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
    await interaction.update({ embeds: [buildPlayingEmbed(game)], components: buildPlayingComponents(game) });
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
    await interaction.update({ embeds: [buildPlayingEmbed(game)], components: buildPlayingComponents(game) });
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
      await interaction.update({ content: '❌ **게임이 취소되었습니다.**', embeds: [], components: [] });
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

  // ── 재대결 ────────────────────────────────────────────────
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
    const rematchPlayers = oldGame.players
      .filter(p => p.id !== 'BOT')
      .map(p => ({ id: p.id, name: p.name }));
    await createLobby(interaction, rematchPlayers, interaction.user.id);
    await oldGame.message?.edit({ components: [] }).catch(() => {});
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
    }).catch(() => {});

    startTurn(game, games);
    return;
  }
}

module.exports = { startWcCommand, handleWcButton, handleWcMessage };

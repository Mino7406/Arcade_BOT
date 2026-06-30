const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const TURN_MS = 10_000;
const JOIN_MS = 90_000;
const KOREAN  = /^[가-힣]+$/;

// ── 봇 단어 사전 ───────────────────────────────────────────────
const BOT_WORDS = [
  '가방', '가수', '가을', '가족', '가구', '가위', '가게', '가스', '가면', '각도',
  '간식', '갈비', '감자', '강물', '강아지', '거북이', '거울', '겨울', '고구마', '고기',
  '고래', '고양이', '고추', '공부', '공원', '공항', '과자', '교실', '교육', '구름',
  '국수', '기린', '기차', '김치', '나라', '나무', '나비', '나팔', '낙타', '냉면',
  '너구리', '노래', '노을', '눈물', '눈송이', '다람쥐', '다리', '단풍', '달팽이', '당근',
  '대나무', '도깨비', '도서관', '도시', '독수리', '동물', '동생', '두부', '딸기', '라디오',
  '라면', '로봇', '마늘', '마음', '마을', '마차', '만두', '매미', '모기', '모자',
  '목소리', '무지개', '문어', '물고기', '미역', '바나나', '바다', '바람', '바위', '방학',
  '배추', '백조', '뱀', '버스', '벌꿀', '벚꽃', '보름달', '볼펜', '봄비', '부채',
  '비행기', '사과', '사람', '사랑', '사막', '사슴', '사자', '삼각형', '새벽', '서울',
  '소나기', '소나무', '소금', '소리', '소방차', '손가락', '수박', '수영장', '숙제', '시계',
  '신발', '아기', '아버지', '아이', '아침', '아파트', '악어', '앵무새', '야구', '양말',
  '어머니', '연필', '염소', '영화', '오리', '오징어', '온도', '우산', '우유', '유리',
  '이불', '일기', '자동차', '자연', '자유', '자전거', '전기', '전철', '전화', '젓가락',
  '지갑', '지구', '지하철', '진달래', '책상', '천둥', '청소', '초록', '축구', '치킨',
  '카메라', '코끼리', '코알라', '크레용', '타조', '태양', '토끼', '토마토', '파도',
  '파랑새', '포도', '포크', '피아노', '하늘', '하루', '하마', '학교', '해바라기',
  '햄버거', '호랑이', '호수', '호박', '화분', '황소',
];

function findBotWord(game) {
  const available = BOT_WORDS.filter(
    w => !game.used.has(w) && (!game.lastChar || w[0] === game.lastChar),
  );
  if (!available.length) return null;
  return available[Math.floor(Math.random() * available.length)];
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
  const list = game.players
    .map((p, i) => `${i + 1}. \`${p.name}\`${p.id === game.hostId ? '  👑' : ''}`)
    .join('\n');

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🔤 끝말잇기')
    .setDescription(`참가자를 기다리는 중 **(${game.players.length}명)**\n\n${list}`)
    .addFields({
      name: '📋 규칙',
      value:
        '• 이전 단어의 **마지막 글자**로 시작하는 단어를 입력하세요.\n' +
        '• 이미 사용된 단어는 사용할 수 없습니다.\n' +
        '• **10초** 내에 입력하지 않으면 탈락합니다.',
    })
    .setFooter({ text: '최소 2명이 참가해야 시작할 수 있습니다.' });
}

function buildPlayingEmbed(game) {
  const currentPlayer = game.players[game.currentIdx];
  const recentWords = game.history.slice(-8).join(' → ') || '(없음)';

  const wordLine = game.lastWord
    ? `**마지막 단어** : \`${game.lastWord}\`　**시작 글자** : \`${game.lastChar}\``
    : '**첫 번째 단어를 입력하세요!** (아무 한국어 단어)';

  const playerList = game.players
    .map((p, i) => `${i === game.currentIdx ? '▶️' : '　'} \`${p.name}\``)
    .join('\n');

  return new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('🔤 끝말잇기 진행 중')
    .setDescription(`${wordLine}\n\n⏱️ **\`${currentPlayer.name}\`의 차례** (${currentPlayer.id === 'BOT' ? '자동' : '10초'})`)
    .addFields(
      { name: '👥 순서', value: playerList, inline: true },
      { name: '📝 최근 단어', value: recentWords, inline: true },
    )
    .setTimestamp();
}

function buildFinishedEmbed(game) {
  const loserPlayer = game.players.find(p => p.id === game.loser);
  const loserName = loserPlayer?.name ?? '알 수 없음';

  const REASONS = {
    timeout:     `⏰ 10초 내에 단어를 입력하지 못했습니다.`,
    wrong_start: `❌ \`${game.failWord}\`은(는) \`${game.lastChar}\`(으)로 시작하지 않습니다.`,
    duplicate:   `🔁 \`${game.failWord}\`은(는) 이미 사용된 단어입니다.`,
    not_korean:  `🚫 \`${game.failWord}\`은(는) 한국어 단어가 아닙니다.`,
    gave_up:     `🏳️ 단어를 이을 수 없어 포기했습니다.`,
    cancelled:   `❌ 방장이 게임을 취소했습니다.`,
  };

  const recent = game.history.slice(-10).join(' → ') || '(없음)';

  return new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle('🔤 끝말잇기 종료')
    .setDescription(
      `**탈락** : \`${loserName}\`\n**이유** : ${REASONS[game.endReason] || '게임 종료'}\n\n` +
      `총 **${game.history.length}개** 단어 사용`,
    )
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
        .setDisabled(hasBot),
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
        .setCustomId(`wc:input:${game.id}`)
        .setLabel('📝 단어 입력')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`wc:giveup:${game.id}`)
        .setLabel('🏳️ 포기')
        .setStyle(ButtonStyle.Danger),
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
  games.delete(game.id);
  game.message.edit({ embeds: [buildFinishedEmbed(game)], components: [] }).catch(() => {});
}

async function botPlay(game, games) {
  const g = games.get(game.id);
  if (!g || g.status !== 'playing') return;

  const word = findBotWord(g);
  if (!word) {
    endGame(g, games, 'BOT', 'gave_up');
    return;
  }

  g.used.add(word);
  g.history.push(word);
  g.lastWord = word;
  g.lastChar = word[word.length - 1];
  g.currentIdx = (g.currentIdx + 1) % g.players.length;

  await g.message.edit({
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

async function startWcCommand(interaction) {
  const games = getGames(interaction.client);
  const gameId = interaction.id;

  const game = {
    id: gameId,
    hostId: interaction.user.id,
    players: [{ id: interaction.user.id, name: getDisplayName(interaction) }],
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
  });
  game.message = await interaction.fetchReply();

  game.timeoutId = setTimeout(async () => {
    const g = games.get(gameId);
    if (!g || g.status !== 'waiting') return;
    games.delete(gameId);
    await game.message.edit({ content: '⏰ **참가자가 없어 게임이 취소되었습니다.**', embeds: [], components: [] }).catch(() => {});
  }, JOIN_MS);
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
    clearTimeout(game.timeoutId);
    game.players.push({ id: 'BOT', name: '🤖 봇' });
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

  // ── 단어 입력 버튼 → 모달 ──────────────────────────────────
  if (customId.startsWith('wc:input:')) {
    const gameId = customId.slice('wc:input:'.length);
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

    const label = game.lastChar
      ? `"${game.lastChar}"(으)로 시작하는 단어를 입력하세요`
      : '아무 한국어 단어를 입력하세요 (첫 단어)';

    const modal = new ModalBuilder()
      .setCustomId(`wc:word:${gameId}`)
      .setTitle('🔤 끝말잇기')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('word')
            .setLabel(label)
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(game.lastChar ? `${game.lastChar}...` : '단어 입력')
            .setRequired(true)
            .setMaxLength(20),
        ),
      );

    await interaction.showModal(modal);
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
}

// ── 모달 핸들러 ────────────────────────────────────────────────

async function handleWcModal(interaction) {
  const gameId = interaction.customId.slice('wc:word:'.length);
  const games  = getGames(interaction.client);
  const game   = games.get(gameId);

  if (!game || game.status !== 'playing') {
    await interaction.reply({ content: '⚠️ **이미 종료된 게임입니다.**', ephemeral: true });
    return;
  }

  const currentPlayer = game.players[game.currentIdx];
  if (interaction.user.id !== currentPlayer.id) {
    await interaction.reply({ content: '⚠️ **지금은 당신의 차례가 아닙니다.**', ephemeral: true });
    return;
  }

  const word = interaction.fields.getTextInputValue('word').trim();

  if (!KOREAN.test(word)) {
    await interaction.deferReply({ ephemeral: true });
    await interaction.deleteReply().catch(() => {});
    endGame(game, games, currentPlayer.id, 'not_korean', word);
    return;
  }

  if (game.lastChar && word[0] !== game.lastChar) {
    await interaction.deferReply({ ephemeral: true });
    await interaction.deleteReply().catch(() => {});
    endGame(game, games, currentPlayer.id, 'wrong_start', word);
    return;
  }

  if (game.used.has(word)) {
    await interaction.deferReply({ ephemeral: true });
    await interaction.deleteReply().catch(() => {});
    endGame(game, games, currentPlayer.id, 'duplicate', word);
    return;
  }

  game.used.add(word);
  game.history.push(word);
  game.lastWord = word;
  game.lastChar = word[word.length - 1];
  game.currentIdx = (game.currentIdx + 1) % game.players.length;

  await interaction.deferReply({ ephemeral: true });
  await interaction.deleteReply().catch(() => {});

  await game.message.edit({
    embeds: [buildPlayingEmbed(game)],
    components: buildPlayingComponents(game),
  }).catch(() => {});

  startTurn(game, games);
}

module.exports = { startWcCommand, handleWcButton, handleWcModal };

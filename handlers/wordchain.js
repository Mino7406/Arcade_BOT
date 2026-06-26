const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const TURN_MS  = 10_000;
const JOIN_MS  = 90_000;
const KOREAN   = /^[가-힣]+$/;

function getGames(client) {
  if (!client.wcGames) client.wcGames = new Map();
  return client.wcGames;
}

// ── 임베드 빌더 ────────────────────────────────────────────────

function buildWaitingEmbed(game) {
  const list = game.players
    .map((id, i) => `${i + 1}. <@${id}>${id === game.hostId ? '  👑' : ''}`)
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
  const currentId = game.players[game.currentIdx];
  const recentWords = game.history.slice(-8).join(' → ') || '(없음)';

  const wordLine = game.lastWord
    ? `**마지막 단어** : \`${game.lastWord}\`　**시작 글자** : \`${game.lastChar}\``
    : '**첫 번째 단어를 입력하세요!** (아무 한국어 단어)';

  const playerList = game.players
    .map((id, i) => `${i === game.currentIdx ? '▶️' : '　'} <@${id}>`)
    .join('\n');

  return new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('🔤 끝말잇기 진행 중')
    .setDescription(`${wordLine}\n\n⏱️ **<@${currentId}>의 차례** (10초)`)
    .addFields(
      { name: '👥 순서', value: playerList, inline: true },
      { name: '📝 최근 단어', value: recentWords, inline: true },
    )
    .setTimestamp();
}

function buildFinishedEmbed(game) {
  const REASONS = {
    timeout:     `⏰ 30초 내에 단어를 입력하지 못했습니다.`,
    wrong_start: `❌ \`${game.failWord}\`은(는) \`${game.lastChar}\`(으)로 시작하지 않습니다.`,
    duplicate:   `🔁 \`${game.failWord}\`은(는) 이미 사용된 단어입니다.`,
    not_korean:  `🚫 \`${game.failWord}\`은(는) 한국어 단어가 아닙니다.`,
    gave_up:     `🏳️ 포기했습니다.`,
    cancelled:   `❌ 방장이 게임을 취소했습니다.`,
  };

  const recent = game.history.slice(-10).join(' → ') || '(없음)';

  return new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle('🔤 끝말잇기 종료')
    .setDescription(
      `**탈락** : <@${game.loser}>\n**이유** : ${REASONS[game.endReason] || '게임 종료'}\n\n` +
      `총 **${game.history.length}개** 단어 사용`,
    )
    .addFields({ name: '📝 마지막 단어들', value: recent })
    .setTimestamp();
}

// ── 컴포넌트 빌더 ──────────────────────────────────────────────

function buildWaitingComponents(game) {
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
  game.status   = 'finished';
  game.loser    = loserId;
  game.endReason = reason;
  game.failWord  = failWord;
  games.delete(game.id);
  game.message.edit({ embeds: [buildFinishedEmbed(game)], components: [] }).catch(() => {});
}

function startTurn(game, games) {
  clearTimeout(game.timeoutId);
  game.timeoutId = setTimeout(() => {
    const g = games.get(game.id);
    if (!g || g.status !== 'playing') return;
    endGame(g, games, g.players[g.currentIdx], 'timeout');
  }, TURN_MS);
}

// ── 커맨드 진입 ────────────────────────────────────────────────

async function startWcCommand(interaction) {
  const games = getGames(interaction.client);
  const gameId = interaction.id;

  const game = {
    id: gameId,
    hostId: interaction.user.id,
    players: [interaction.user.id],
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

  // 대기 시간 초과 시 자동 취소
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
    if (game.players.includes(interaction.user.id)) {
      await interaction.reply({ content: '⚠️ **이미 참가 중입니다.**', ephemeral: true });
      return;
    }
    game.players.push(interaction.user.id);
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

    // 참가자 순서 무작위 섞기
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
    const currentId = game.players[game.currentIdx];
    if (interaction.user.id !== currentId) {
      await interaction.reply({ content: `⚠️ **지금은 <@${currentId}>의 차례입니다.**`, ephemeral: true });
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
    const currentId = game.players[game.currentIdx];
    if (interaction.user.id !== currentId) {
      await interaction.reply({ content: `⚠️ **지금은 <@${currentId}>의 차례입니다.**`, ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    endGame(game, games, currentId, 'gave_up');
    return;
  }
}

// ── 모달 핸들러 ────────────────────────────────────────────────

async function handleWcModal(interaction) {
  const gameId = interaction.customId.slice('wc:word:'.length);
  const games  = getGames(interaction.client);
  const game   = games.get(gameId);

  // 게임이 이미 끝났거나 없는 경우 (타임아웃 등)
  if (!game || game.status !== 'playing') {
    await interaction.reply({ content: '⚠️ **이미 종료된 게임입니다.**', ephemeral: true });
    return;
  }

  const currentId = game.players[game.currentIdx];
  if (interaction.user.id !== currentId) {
    await interaction.reply({ content: '⚠️ **지금은 당신의 차례가 아닙니다.**', ephemeral: true });
    return;
  }

  const word = interaction.fields.getTextInputValue('word').trim();

  // 한국어 검사
  if (!KOREAN.test(word)) {
    await interaction.deferReply({ ephemeral: true });
    await interaction.deleteReply().catch(() => {});
    endGame(game, games, currentId, 'not_korean', word);
    return;
  }

  // 시작 글자 검사
  if (game.lastChar && word[0] !== game.lastChar) {
    await interaction.deferReply({ ephemeral: true });
    await interaction.deleteReply().catch(() => {});
    endGame(game, games, currentId, 'wrong_start', word);
    return;
  }

  // 중복 검사
  if (game.used.has(word)) {
    await interaction.deferReply({ ephemeral: true });
    await interaction.deleteReply().catch(() => {});
    endGame(game, games, currentId, 'duplicate', word);
    return;
  }

  // 유효한 단어 처리
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

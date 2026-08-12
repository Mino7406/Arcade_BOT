const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { applyXp, getXp, levelFromXp, LEVEL_UP_ANNOUNCE_CHANNEL_ID, EXCLUDED_GUILD_IDS } = require('./레벨');

const TIMEOUT_MS = 5 * 60 * 1000;
// 유저끼리 대결할 때 자동으로 거는 내기 XP. 실제로는 진 사람의 "현재 레벨 안에 쌓인 XP"로
// 상한을 걸어(min(WAGER_XP, currentLevelXp)) 아무리 내기에서 져도 레벨이 떨어지지는 않게 한다.
const WAGER_XP = 100;
// 봇을 상대로 이겼을 때 지급하는 고정 XP(내기 아님, 사람에게서 빼앗지 않음). 봇 AI가 꽤
// 세서(이기기→막기→중앙→코너) 실제로 이기기 쉽지 않으므로 파밍 걱정 없이 넉넉히 준다.
const BOT_WIN_XP = 60;

const WINS = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

function getGames(client) {
  if (!client.tttGames) client.tttGames = new Map();
  return client.tttGames;
}

function checkWinner(board) {
  for (const [a, b, c] of WINS) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return null;
}

function isFull(board) {
  return board.every(c => c !== '');
}

function getBotMove(board) {
  // 이길 수 있으면 이김
  for (const [a, b, c] of WINS) {
    if (board[a] === 'O' && board[b] === 'O' && board[c] === '') return c;
    if (board[a] === 'O' && board[c] === 'O' && board[b] === '') return b;
    if (board[b] === 'O' && board[c] === 'O' && board[a] === '') return a;
  }
  // 상대 승리 막기
  for (const [a, b, c] of WINS) {
    if (board[a] === 'X' && board[b] === 'X' && board[c] === '') return c;
    if (board[a] === 'X' && board[c] === 'X' && board[b] === '') return b;
    if (board[b] === 'X' && board[c] === 'X' && board[a] === '') return a;
  }
  // 중앙
  if (board[4] === '') return 4;
  // 코너
  const corners = [0, 2, 6, 8].filter(i => board[i] === '');
  if (corners.length) return corners[Math.floor(Math.random() * corners.length)];
  // 남은 칸
  const empty = board.map((v, i) => v === '' ? i : -1).filter(i => i !== -1);
  return empty[Math.floor(Math.random() * empty.length)];
}

function buildEmbed(game) {
  const xName = game.players.X === 'BOT' ? '🤖 봇' : `<@${game.players.X}>`;
  const oName = game.players.O === 'BOT' ? '🤖 봇' : `<@${game.players.O}>`;

  let desc = `❌ ${xName}  **vs**  ⭕ ${oName}\n\n`;

  if (game.status === 'waiting') {
    desc += '⏳ 상대방의 수락을 기다리는 중...';
  } else if (game.status === 'finished') {
    if (game.winner === 'DRAW') {
      desc += '**🤝 무승부!**';
    } else {
      const winName = game.winner === 'X' ? xName : oName;
      const winEmoji = game.winner === 'X' ? '❌' : '⭕';
      desc += `**🏆 ${winEmoji} ${winName} 승리!**`;

      if (game.xpResult?.type === 'wager') {
        const { wager, winnerId, loserId } = game.xpResult;
        desc += `\n🎲 내기 결과 : <@${loserId}> −${wager} XP → <@${winnerId}> +${wager} XP`;
      } else if (game.xpResult?.type === 'bot_win') {
        desc += `\n🎉 <@${game.xpResult.winnerId}>님 +${game.xpResult.amount} XP!`;
      }
    }
  } else {
    const turnName = game.currentTurn === 'X' ? xName : oName;
    const turnEmoji = game.currentTurn === 'X' ? '❌' : '⭕';
    desc += `${turnEmoji} **${turnName}의 차례**`;
  }

  const color =
    game.status === 'finished'
      ? game.winner === 'DRAW' ? 0x808080 : 0xFFD700
      : 0x5865F2;

  return new EmbedBuilder()
    .setColor(color)
    .setTitle('⚔️ 틱택토')
    .setDescription(desc)
    .setTimestamp();
}

function buildBoard(game) {
  const rows = [];
  for (let r = 0; r < 3; r++) {
    const btns = [];
    for (let c = 0; c < 3; c++) {
      const idx = r * 3 + c;
      const cell = game.board[idx];
      let style = ButtonStyle.Secondary;
      let disabled = game.status === 'finished';

      const btn = new ButtonBuilder()
        .setCustomId(`ttt:move:${game.id}:${idx}`)
        .setDisabled(disabled);

      if (cell === 'X') {
        btn.setLabel('❌').setStyle(ButtonStyle.Primary).setDisabled(true);
      } else if (cell === 'O') {
        btn.setLabel('⭕').setStyle(ButtonStyle.Danger).setDisabled(true);
      } else {
        btn.setEmoji('⬜').setStyle(style);
      }

      btns.push(btn);
    }
    rows.push(new ActionRowBuilder().addComponents(...btns));
  }
  return rows;
}

// 사람 vs 사람 대결에서 승부가 났을 때 내기 XP를 정산한다(무승부·봇 상대는 여기서 처리 안 함).
// 진 사람의 currentLevelXp(현재 레벨 안에서 쌓인 XP)로 상한을 걸어두기 때문에, 아무리 내기에서
// 져도 레벨업 문턱 아래로는 안 내려간다(레벨 자체가 깎이지 않음).
function settleWagerXp(game) {
  if (!game.guildId || game.winner === 'DRAW') return null;
  const loserMark = game.winner === 'X' ? 'O' : 'X';
  const winnerId = game.players[game.winner];
  const loserId = game.players[loserMark];
  if (winnerId === 'BOT' || loserId === 'BOT') return null; // 봇이 낀 경기는 아래 settleBotWinXp가 처리

  const loserLevelXp = levelFromXp(getXp(game.guildId, loserId)).currentLevelXp;
  const wager = Math.min(WAGER_XP, loserLevelXp);
  if (wager <= 0) return null;

  const loserResult = applyXp(game.guildId, loserId, -wager);
  const winnerResult = applyXp(game.guildId, winnerId, wager);
  return { type: 'wager', wager, winnerId, loserId, winnerResult, loserResult };
}

// 사람이 봇을 이겼을 때 고정 XP를 지급한다(봇이 이기거나 무승부면 지급 없음).
function settleBotWinXp(game) {
  if (!game.guildId || game.winner === 'DRAW') return null;
  const loserMark = game.winner === 'X' ? 'O' : 'X';
  const winnerId = game.players[game.winner];
  if (game.players[loserMark] !== 'BOT' || winnerId === 'BOT') return null;

  const result = applyXp(game.guildId, winnerId, BOT_WIN_XP);
  return { type: 'bot_win', amount: BOT_WIN_XP, winnerId, winnerResult: result };
}

async function announceLevelUp(client, guildId, userId, newLevel) {
  try {
    const channel = await client.channels.fetch(LEVEL_UP_ANNOUNCE_CHANNEL_ID).catch(() => null);
    if (channel?.guildId === guildId) {
      await channel.send({ content: `<@${userId}>님이 ${newLevel}레벨을 달성했어요. 🎉`, allowedMentions: { users: [userId] } });
    }
  } catch (err) {
    console.error('틱택토 레벨업 메시지 전송 실패:', err);
  }
}

function settleGameXp(game) {
  if (EXCLUDED_GUILD_IDS.includes(game.guildId)) return; // 레벨 시스템 제외 서버(테스트 서버 등)는 내기/보상도 미적용
  const result = settleWagerXp(game) || settleBotWinXp(game);
  game.xpResult = result;
  if (!result) return;

  const client = game.message?.client;
  if (!client) return;
  if (result.winnerResult?.leveledUp) {
    announceLevelUp(client, game.guildId, result.winnerId, result.winnerResult.newLevel).catch(() => {});
  }
}

function applyMove(game, games, idx, mark) {
  game.board[idx] = mark;
  const winner = checkWinner(game.board);
  if (winner) {
    game.status = 'finished';
    game.winner = winner;
    clearTimeout(game.timeoutId);
    games.delete(game.id);
    settleGameXp(game);
  } else if (isFull(game.board)) {
    game.status = 'finished';
    game.winner = 'DRAW';
    clearTimeout(game.timeoutId);
    games.delete(game.id);
  } else {
    game.currentTurn = game.currentTurn === 'X' ? 'O' : 'X';
  }
}

function resetTimeout(game, games) {
  clearTimeout(game.timeoutId);
  game.timeoutId = setTimeout(async () => {
    const g = games.get(game.id);
    if (!g || g.status !== 'playing') return;
    g.status = 'finished';
    g.winner = 'DRAW';
    games.delete(g.id);
    await g.message.edit({ content: '⏰ **시간 초과로 게임이 종료되었습니다.**', embeds: [buildEmbed(g)], components: buildBoard(g) }).catch(() => {});
  }, TIMEOUT_MS);
}

async function startTttCommand(interaction) {
  const games = getGames(interaction.client);
  const gameId = interaction.id;
  const opponent = interaction.options.getUser('상대방');

  if (opponent) {
    if (opponent.id === interaction.user.id) {
      await interaction.reply({ content: '⚠️ **자기 자신에게는 도전할 수 없습니다.**', ephemeral: true });
      return;
    }
    if (opponent.bot) {
      await interaction.reply({ content: '⚠️ **봇에게는 도전할 수 없습니다.**', ephemeral: true });
      return;
    }

    const game = {
      id: gameId,
      board: Array(9).fill(''),
      players: { X: interaction.user.id, O: opponent.id },
      guildId: interaction.guildId,
      currentTurn: 'X',
      status: 'waiting',
      winner: null,
      message: null,
      timeoutId: null,
    };
    games.set(gameId, game);

    const acceptRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ttt:accept:${gameId}`).setLabel('✅ 수락').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`ttt:decline:${gameId}`).setLabel('❌ 거절').setStyle(ButtonStyle.Danger),
    );

    await interaction.reply({
      content: `⚔️ <@${opponent.id}>님, <@${interaction.user.id}>님이 틱택토 대결을 신청했습니다!`,
      embeds: [buildEmbed(game)],
      components: [acceptRow],
    });
    game.message = await interaction.fetchReply();

    // 60초 수락 대기
    game.timeoutId = setTimeout(async () => {
      const g = games.get(gameId);
      if (!g || g.status !== 'waiting') return;
      games.delete(gameId);
      await interaction.editReply({ content: '⏰ **대결 신청이 만료되었습니다.**', embeds: [], components: [] }).catch(() => {});
    }, 60_000);
    return;
  }

  // 봇 대결
  const game = {
    id: gameId,
    board: Array(9).fill(''),
    players: { X: interaction.user.id, O: 'BOT' },
    guildId: interaction.guildId,
    currentTurn: 'X',
    status: 'playing',
    winner: null,
    message: null,
    timeoutId: null,
  };
  games.set(gameId, game);

  await interaction.reply({ embeds: [buildEmbed(game)], components: buildBoard(game) });
  game.message = await interaction.fetchReply();
  resetTimeout(game, games);
}

async function handleTttButton(interaction) {
  const { customId } = interaction;
  const games = getGames(interaction.client);

  // ── 수락 ──────────────────────────────────────────────────
  if (customId.startsWith('ttt:accept:')) {
    const gameId = customId.slice('ttt:accept:'.length);
    const game = games.get(gameId);
    if (!game) {
      await interaction.reply({ content: '⚠️ **만료된 게임입니다.**', ephemeral: true });
      return;
    }
    if (interaction.user.id !== game.players.O) {
      await interaction.reply({ content: '⚠️ **초대받은 플레이어만 수락할 수 있습니다.**', ephemeral: true });
      return;
    }
    clearTimeout(game.timeoutId);
    game.status = 'playing';
    await interaction.update({ content: '', embeds: [buildEmbed(game)], components: buildBoard(game) });
    resetTimeout(game, games);
    return;
  }

  // ── 거절 ──────────────────────────────────────────────────
  if (customId.startsWith('ttt:decline:')) {
    const gameId = customId.slice('ttt:decline:'.length);
    const game = games.get(gameId);
    if (!game) {
      await interaction.reply({ content: '⚠️ **만료된 게임입니다.**', ephemeral: true });
      return;
    }
    if (interaction.user.id !== game.players.O && interaction.user.id !== game.players.X) {
      await interaction.reply({ content: '⚠️ **게임 참가자만 사용할 수 있습니다.**', ephemeral: true });
      return;
    }
    clearTimeout(game.timeoutId);
    games.delete(gameId);
    await interaction.update({ content: `❌ **<@${interaction.user.id}>님이 대결을 거절했습니다.**`, embeds: [], components: [] });
    return;
  }

  // ── 이동 ──────────────────────────────────────────────────
  if (customId.startsWith('ttt:move:')) {
    const parts = customId.split(':');
    const gameId = parts[2];
    const cellIdx = parseInt(parts[3]);
    const game = games.get(gameId);

    if (!game || game.status !== 'playing') {
      await interaction.reply({ content: '⚠️ **진행 중인 게임이 아닙니다.**', ephemeral: true });
      return;
    }

    const currentPlayerId = game.players[game.currentTurn];
    if (interaction.user.id !== currentPlayerId) {
      const turnEmoji = game.currentTurn === 'X' ? '❌' : '⭕';
      await interaction.reply({ content: `⚠️ **지금은 ${turnEmoji} 플레이어의 차례입니다.**`, ephemeral: true });
      return;
    }
    if (game.board[cellIdx] !== '') {
      await interaction.reply({ content: '⚠️ **이미 놓인 칸입니다.**', ephemeral: true });
      return;
    }

    applyMove(game, games, cellIdx, game.currentTurn === 'X' ? 'X' : 'O');
    await interaction.update({ content: '', embeds: [buildEmbed(game)], components: buildBoard(game) });

    if (game.status === 'finished') return;

    // 봇 차례
    if (game.players[game.currentTurn] === 'BOT') {
      const botIdx = getBotMove(game.board);
      applyMove(game, games, botIdx, 'O');
      await game.message.edit({ content: '', embeds: [buildEmbed(game)], components: buildBoard(game) }).catch(() => {});
      return;
    }

    resetTimeout(game, games);
  }
}

module.exports = { startTttCommand, handleTttButton };

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
// 봇을 상대로 이겼을 때 지급하는 고정 XP(내기 아님, 사람에게서 빼앗지 않음).
const BOT_WIN_XP = 60;
// 악용 방지: 봇전 반복 플레이로 XP를 무한히 파밍하거나, 같은 상대와 즉석 내기를 연달아
// 반복해서 XP를 옮기는 것을 막기 위해 유저당 쿨다운을 둔다(쿨다운 중이면 게임은 정상 진행
// 되지만 XP 정산만 생략됨 — 플레이 자체를 막지는 않음).
const XP_SETTLE_COOLDOWN_MS = 3 * 60 * 1000;
const xpSettleCooldowns = new Map(); // userId → 마지막 XP 정산 시각

function isOnCooldown(userId) {
  const last = xpSettleCooldowns.get(userId);
  return !!last && Date.now() - last < XP_SETTLE_COOLDOWN_MS;
}

function markCooldown(userId) {
  xpSettleCooldowns.set(userId, Date.now());
}

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

// board(3x3=9칸) 자체가 아주 작아서 완전 탐색이 순식간에 끝나므로, 휴리스틱 대신 미니맥스로
// 항상 최선의 수를 찾는다. 이러면 봇은 이론상 절대 지지 않는다(최악이 무승부) — 예전 휴리스틱
// (이기기→막기→포크 방어 등)은 "상대 코너, 내 중앙, 상대 반대편 코너"로 시작하는 유명한
// 트릭에 뚫려서 XP가 걸린 봇전을 몇 수만 외우면 반복해서 이길 수 있었는데, 완전 탐색은 이런
// 알려진 트릭을 포함해 어떤 수순으로도 봇을 이길 수 없게 만들어 내기/보상 XP 파밍을 원천 차단한다.
function evaluate(board) {
  const winner = checkWinner(board);
  if (winner === 'O') return 1;
  if (winner === 'X') return -1;
  if (isFull(board)) return 0;
  return null; // 아직 안 끝남
}

function minimax(board, isBotTurn) {
  const score = evaluate(board);
  if (score !== null) return score;

  const mark = isBotTurn ? 'O' : 'X';
  let best = isBotTurn ? -Infinity : Infinity;
  for (let i = 0; i < 9; i++) {
    if (board[i] !== '') continue;
    board[i] = mark;
    const s = minimax(board, !isBotTurn);
    board[i] = '';
    best = isBotTurn ? Math.max(best, s) : Math.min(best, s);
  }
  return best;
}

function getBotMove(board) {
  let bestScore = -Infinity;
  let bestMoves = [];
  for (let i = 0; i < 9; i++) {
    if (board[i] !== '') continue;
    board[i] = 'O';
    const s = minimax(board, false);
    board[i] = '';
    if (s > bestScore) {
      bestScore = s;
      bestMoves = [i];
    } else if (s === bestScore) {
      bestMoves.push(i);
    }
  }
  return bestMoves[Math.floor(Math.random() * bestMoves.length)];
}

// ── 무한모드(각자 최대 3개, 4번째를 두면 가장 오래된 조각이 사라짐) 전용 봇 AI ──
// 이 모드는 판이 절대 다 채워지지 않아(각자 최대 3개 = 최대 6칸) 일반 minimax처럼
// "판이 꽉 찰 때까지" 완전 탐색하면 게임 트리가 끝없이 순환해 재귀가 끝나지 않는다.
// 그래서 깊이를 제한한 minimax + 휴리스틱 평가로 대신한다(완벽한 수는 아니지만 충분히
// 잘 막고 잘 노림).
const INFINITE_BOT_DEPTH = 4;

function evaluateInfiniteHeuristic(board) {
  let score = 0;
  for (const line of WINS) {
    const vals = line.map(i => board[i]);
    const oCount = vals.filter(v => v === 'O').length;
    const xCount = vals.filter(v => v === 'X').length;
    if (oCount > 0 && xCount > 0) continue; // 이미 막힌 줄은 승산 없음
    if (oCount === 3) score += 100;
    else if (oCount === 2) score += 10;
    else if (oCount === 1) score += 1;
    if (xCount === 3) score -= 100;
    else if (xCount === 2) score -= 10;
    else if (xCount === 1) score -= 1;
  }
  return score;
}

// 무한모드의 "4번째를 두면 가장 오래된 조각 소멸" 규칙을 반영해 다음 board/marks를 계산.
function simulateInfiniteMove(board, marks, idx, mark) {
  const nextBoard = board.slice();
  const nextMarks = { X: [...marks.X], O: [...marks.O] };
  nextBoard[idx] = mark;
  nextMarks[mark].push(idx);
  if (nextMarks[mark].length > 3) {
    const vanished = nextMarks[mark].shift();
    nextBoard[vanished] = '';
  }
  return { board: nextBoard, marks: nextMarks };
}

function minimaxInfinite(board, marks, isBotTurn, depth) {
  const winner = checkWinner(board);
  if (winner === 'O') return 1000 + depth; // 더 빨리 이기는 수를 선호
  if (winner === 'X') return -1000 - depth;
  if (depth === 0) return evaluateInfiniteHeuristic(board);

  const mark = isBotTurn ? 'O' : 'X';
  let best = isBotTurn ? -Infinity : Infinity;
  for (let i = 0; i < 9; i++) {
    if (board[i] !== '') continue;
    const next = simulateInfiniteMove(board, marks, i, mark);
    const s = minimaxInfinite(next.board, next.marks, !isBotTurn, depth - 1);
    best = isBotTurn ? Math.max(best, s) : Math.min(best, s);
  }
  return best;
}

function getBotMoveInfinite(board, marks) {
  let bestScore = -Infinity;
  let bestMoves = [];
  for (let i = 0; i < 9; i++) {
    if (board[i] !== '') continue;
    const next = simulateInfiniteMove(board, marks, i, 'O');
    const s = minimaxInfinite(next.board, next.marks, false, INFINITE_BOT_DEPTH - 1);
    if (s > bestScore) {
      bestScore = s;
      bestMoves = [i];
    } else if (s === bestScore) {
      bestMoves.push(i);
    }
  }
  return bestMoves[Math.floor(Math.random() * bestMoves.length)];
}

function buildEmbed(game) {
  const xName = game.players.X === 'BOT' ? '🤖 봇' : `<@${game.players.X}>`;
  const oName = game.players.O === 'BOT' ? '🤖 봇' : `<@${game.players.O}>`;

  let desc = `❌ ${xName}  **vs**  ⭕ ${oName}\n\n`;

  if (game.status === 'waiting') {
    desc += '⏳ 상대방의 수락을 기다리는 중...\n' +
      `⚠️ 이 대결은 **XP 내기**가 걸립니다 — 지는 사람이 최대 ${WAGER_XP} XP를 잃고(레벨은 안 깎임) 이긴 사람이 그만큼 받습니다.`;
    if (game.infinite) {
      desc += '\n🌀 **무한모드**: 각자 최대 3개까지만 유지되고, 4번째를 두면 가장 오래된 조각이 사라집니다.';
    }
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

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(game.infinite ? '⚔️ 틱택토 · 🌀 무한모드' : '⚔️ 틱택토')
    .setDescription(desc)
    .setTimestamp();

  if (game.infinite && game.status === 'playing') {
    embed.setFooter({ text: '🌀 각자 최대 3개까지만 유지되며, 4번째를 두면 가장 오래된 조각(회색으로 표시)이 사라집니다.' });
  }

  return embed;
}

// 무한모드에서 각 마크가 이미 3개를 채워, 다음 그 마크가 하나 더 놓이면 사라질 "가장 오래된"
// 칸의 인덱스를 반환한다({ X: idx|undefined, O: idx|undefined }). 그 칸은 buildBoard에서
// 옅은 색(Secondary)으로 그려서 곧 사라질 조각임을 미리 알려준다.
function getFadingCells(game) {
  const fading = {};
  if (!game.infinite) return fading;
  for (const mark of ['X', 'O']) {
    const arr = game.marks?.[mark] || [];
    if (arr.length >= 3) fading[mark] = arr[0];
  }
  return fading;
}

function buildBoard(game) {
  const rows = [];
  const fading = getFadingCells(game);
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
        const isFading = fading.X === idx;
        btn.setLabel('❌').setStyle(isFading ? ButtonStyle.Secondary : ButtonStyle.Primary).setDisabled(true);
      } else if (cell === 'O') {
        const isFading = fading.O === idx;
        btn.setLabel('⭕').setStyle(isFading ? ButtonStyle.Secondary : ButtonStyle.Danger).setDisabled(true);
      } else {
        btn.setEmoji('⬜').setStyle(style);
      }

      btns.push(btn);
    }
    rows.push(new ActionRowBuilder().addComponents(...btns));
  }

  if (game.status === 'finished') {
    rows.push(buildRematchRow(game));
  }

  return rows;
}

// 재대결 버튼: 게임이 끝나면 map에서 지워지므로(applyMove), 다시 조회할 필요가 없도록
// 필요한 정보(선/후공 플레이어, 무한모드 여부)를 customId에 그대로 인코딩해둔다.
function buildRematchRow(game) {
  const flag = game.infinite ? '1' : '0';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ttt:rematch:${game.players.X}:${game.players.O}:${flag}`)
      .setLabel('🔄 재대결')
      .setStyle(ButtonStyle.Primary),
  );
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
  if (isOnCooldown(winnerId) || isOnCooldown(loserId)) return null; // 같은 유저가 연달아 내기를 반복해 XP를 옮기는 것 방지

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
  if (isOnCooldown(winnerId)) return null; // 봇전 반복 플레이로 XP를 무한히 파밍하는 것 방지

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

  markCooldown(result.winnerId);
  if (result.loserId) markCooldown(result.loserId);

  const client = game.message?.client;
  if (!client) return;
  if (result.winnerResult?.leveledUp) {
    announceLevelUp(client, game.guildId, result.winnerId, result.winnerResult.newLevel).catch(() => {});
  }
}

function applyMove(game, games, idx, mark) {
  game.board[idx] = mark;

  if (game.infinite) {
    // 각자 최대 3개까지만 유지 — 4번째를 두면 그 마크의 가장 오래된 조각이 사라진다.
    game.marks[mark].push(idx);
    if (game.marks[mark].length > 3) {
      const vanished = game.marks[mark].shift();
      game.board[vanished] = '';
    }
  }

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
  const infinite = interaction.options.getBoolean('무한모드') ?? false;

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
      infinite,
      marks: { X: [], O: [] },
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
    infinite,
    marks: { X: [], O: [] },
  };
  games.set(gameId, game);

  await interaction.reply({ embeds: [buildEmbed(game)], components: buildBoard(game) });
  game.message = await interaction.fetchReply();
  resetTimeout(game, games);
}

// 재대결: 원래 게임은 끝나는 순간 map에서 지워지므로, ttt:rematch 버튼의 customId에
// 담아둔 정보(X/O였던 유저, 무한모드 여부)만으로 새 게임을 만든다. 사람 상대였던 경우
// 선공/후공을 서로 바꿔서(X↔O) 매번 같은 사람만 먼저 두지 않게 한다.
async function startRematch(interaction, prevXId, prevOId, infinite) {
  const games = getGames(interaction.client);
  const gameId = interaction.id;

  if (prevOId === 'BOT') {
    if (interaction.user.id !== prevXId) {
      await interaction.reply({ content: '⚠️ **원래 참가자만 재대결할 수 있습니다.**', ephemeral: true });
      return;
    }

    const game = {
      id: gameId,
      board: Array(9).fill(''),
      players: { X: prevXId, O: 'BOT' },
      guildId: interaction.guildId,
      currentTurn: 'X',
      status: 'playing',
      winner: null,
      message: null,
      timeoutId: null,
      infinite,
      marks: { X: [], O: [] },
    };
    games.set(gameId, game);

    await interaction.update({ content: '', embeds: [buildEmbed(game)], components: buildBoard(game) });
    game.message = await interaction.fetchReply();
    resetTimeout(game, games);
    return;
  }

  if (interaction.user.id !== prevXId && interaction.user.id !== prevOId) {
    await interaction.reply({ content: '⚠️ **원래 참가자만 재대결할 수 있습니다.**', ephemeral: true });
    return;
  }

  const game = {
    id: gameId,
    board: Array(9).fill(''),
    players: { X: prevOId, O: prevXId }, // 선공/후공을 바꿔서 재대결
    guildId: interaction.guildId,
    currentTurn: 'X',
    status: 'playing',
    winner: null,
    message: null,
    timeoutId: null,
    infinite,
    marks: { X: [], O: [] },
  };
  games.set(gameId, game);

  await interaction.update({
    content: `🔄 **재대결이 시작됐습니다!** (이번엔 <@${prevOId}>님이 선공 ❌)`,
    embeds: [buildEmbed(game)],
    components: buildBoard(game),
  });
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
      const botIdx = game.infinite ? getBotMoveInfinite(game.board, game.marks) : getBotMove(game.board);
      applyMove(game, games, botIdx, 'O');
      await game.message.edit({ content: '', embeds: [buildEmbed(game)], components: buildBoard(game) }).catch(() => {});
      return;
    }

    resetTimeout(game, games);
    return;
  }

  // ── 재대결 ────────────────────────────────────────────────
  if (customId.startsWith('ttt:rematch:')) {
    const parts = customId.split(':');
    const prevXId = parts[2];
    const prevOId = parts[3];
    const infinite = parts[4] === '1';
    await startRematch(interaction, prevXId, prevOId, infinite);
  }
}

module.exports = { startTttCommand, handleTttButton };

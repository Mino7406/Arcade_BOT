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
const BOT_WIN_XP = 10;
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
    const xReady = game.ready.X ? '✅ 준비완료' : '⌛ 대기 중';
    const oReady = game.ready.O ? '✅ 준비완료' : '⌛ 대기 중';
    desc += '⏳ 두 사람 모두 준비하면 시작됩니다.\n' +
      `${xReady} ${xName}   ·   ${oReady} ${oName}\n\n` +
      '⚠️ **XP 내기**\n' +
      `• 📉 지는 사람이 **${WAGER_XP}** XP를 잃습니다.\n` +
      `• 📈 이긴 사람이 **${WAGER_XP}** XP를 받습니다.`;
    if (game.infinite) {
      desc += '\n**(♾️ 무한모드)**\n 각자 최대 3개까지만 유지되고, 4번째를 두면 가장 오래된 조각이 사라집니다.';
    }
  } else if (game.status === 'setup') {
    desc += `⚙️ 아래 **시작** 버튼을 누르면 대결이 시작됩니다.\n(이기면 +${BOT_WIN_XP} XP)`;
    if (game.infinite) {
      desc += '\n**(♾️ 무한모드)**\n 각자 최대 3개까지만 유지되고, 4번째를 두면 가장 오래된 조각이 사라집니다.';
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
        desc += `\n🎲 **내기 결과**\n📉 <@${loserId}> **−${wager} XP**\n📈 <@${winnerId}> **+${wager} XP**`;
      } else if (game.xpResult?.type === 'bot_win') {
        desc += `\n🎉 <@${game.xpResult.winnerId}>님 **+${game.xpResult.amount} XP** 획득!`;
      } else if (game.xpResult?.type === 'cooldown') {
        const cooldownMin = Math.ceil(XP_SETTLE_COOLDOWN_MS / 60000);
        desc += `\n⏳ 연속 대결 쿨다운 중이라\n 이번 판은 XP 정산이 생략됐습니다.\n-# (직전 정산 후 ${cooldownMin}분 이내)`;
      }
    }
  } else {
    const turnName = game.currentTurn === 'X' ? xName : oName;
    const turnEmoji = game.currentTurn === 'X' ? '❌' : '⭕';
    desc += `${turnEmoji} **${turnName}의 차례**`;
    if (game.infinite) {
      desc += '\n-# 각자 최대 3개까지만 유지되며, 4번째를 두면 가장 오래된 조각이 사라집니다.';
    }
  }

  const color =
    game.status === 'finished'
      ? game.winner === 'DRAW' ? 0x808080 : 0xFFD700
      : 0x5865F2;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(game.infinite ? '⚔️ 틱택토 (♾️ 무한모드)' : '⚔️ 틱택토')
    .setDescription(desc)
    .setTimestamp();

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
    rows.push(buildFinishedRow(game));
  }

  return rows;
}

// 재대결/종료 버튼: 게임이 끝나면 map에서 지워지므로(applyMove), 다시 조회할 필요가 없도록
// 필요한 정보(선/후공 플레이어, 무한모드 여부)를 customId에 그대로 인코딩해둔다.
function buildFinishedRow(game) {
  const flag = game.infinite ? '1' : '0';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ttt:rematch:${game.players.X}:${game.players.O}:${flag}`)
      .setLabel('🔄 재대결')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`ttt:close:${game.players.X}:${game.players.O}`)
      .setLabel('🛑 종료')
      .setStyle(ButtonStyle.Secondary),
  );
}

// 무한모드 토글 버튼: PvP 대결 신청 로비(waiting)와 봇 대결 설정 로비(setup) 둘 다 이 버튼을
// 쓰므로, 현재 game.infinite 값에 맞춰 라벨/스타일만 바뀐다.
function buildInfiniteToggleButton(game) {
  return new ButtonBuilder()
    .setCustomId(`ttt:toggleinf:${game.id}`)
    .setLabel(game.infinite ? '♾️ 무한모드: ON' : '♾️ 무한모드: OFF')
    .setStyle(game.infinite ? ButtonStyle.Success : ButtonStyle.Secondary);
}

// PvP 대결 신청 로비(준비 대기 중)에서 쓰는 버튼 행 — 준비 버튼은 누른 사람 본인의 준비
// 상태만 토글하고(둘 다 준비되면 자동 시작), 라벨 자체는 고정이며 현재 준비 상태는 임베드에 표시.
function buildChallengeRow(game) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ttt:ready:${game.id}`).setLabel('✅ 준비').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ttt:decline:${game.id}`).setLabel('❌ 거절').setStyle(ButtonStyle.Danger),
    buildInfiniteToggleButton(game),
  );
}

// 봇 대결 설정 로비(시작 전)에서 쓰는 버튼 행.
function buildBotSetupRow(game) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ttt:botstart:${game.id}`).setLabel('▶️ 시작').setStyle(ButtonStyle.Success),
    buildInfiniteToggleButton(game),
  );
}

// 로비 상태(waiting/setup)에 맞는 버튼 행을 골라준다 — 무한모드 토글 후 다시 그릴 때 공용으로 사용.
function buildLobbyRow(game) {
  return game.players.O === 'BOT' ? buildBotSetupRow(game) : buildChallengeRow(game);
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
  // 같은 유저가 연달아 내기를 반복해 XP를 옮기는 것 방지 — 재대결로 곧바로 다시 붙었을 때도
  // 걸릴 수 있으므로, 조용히 넘기지 않고 xpResult에 이유를 남겨서 화면에 안내한다.
  if (isOnCooldown(winnerId) || isOnCooldown(loserId)) return { type: 'cooldown' };

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
  // 봇전 반복 플레이로 XP를 무한히 파밍하는 것 방지 — 이유를 xpResult에 남겨서 화면에 안내한다.
  if (isOnCooldown(winnerId)) return { type: 'cooldown' };

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
  if (!result || result.type === 'cooldown') return;

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
      infinite: false,
      marks: { X: [], O: [] },
      ready: { X: false, O: false },
    };
    games.set(gameId, game);

    await interaction.reply({
      content: `⚔️ <@${opponent.id}>님, <@${interaction.user.id}>님이 틱택토 대결을 신청했습니다!`,
      embeds: [buildEmbed(game)],
      components: [buildChallengeRow(game)],
    });
    game.message = await interaction.fetchReply();

    // 60초 내로 둘 다 준비하지 않으면 만료
    game.timeoutId = setTimeout(async () => {
      const g = games.get(gameId);
      if (!g || g.status !== 'waiting') return;
      games.delete(gameId);
      await interaction.editReply({ content: '⏰ **대결 신청이 만료되었습니다.**', embeds: [], components: [] }).catch(() => {});
    }, 60_000);
    return;
  }

  // 봇 대결 — 설정 로비(무한모드 토글 후 시작 버튼)를 먼저 보여준다.
  const game = {
    id: gameId,
    board: Array(9).fill(''),
    players: { X: interaction.user.id, O: 'BOT' },
    guildId: interaction.guildId,
    currentTurn: 'X',
    status: 'setup',
    winner: null,
    message: null,
    timeoutId: null,
    infinite: false,
    marks: { X: [], O: [] },
  };
  games.set(gameId, game);

  await interaction.reply({ embeds: [buildEmbed(game)], components: [buildBotSetupRow(game)] });
  game.message = await interaction.fetchReply();

  // 60초 내로 시작하지 않으면 만료
  game.timeoutId = setTimeout(async () => {
    const g = games.get(gameId);
    if (!g || g.status !== 'setup') return;
    games.delete(gameId);
    await interaction.editReply({ content: '⏰ **설정 시간이 초과되어 게임이 취소되었습니다.**', embeds: [], components: [] }).catch(() => {});
  }, 60_000);
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

    // 봇전 재대결도 곧바로 시작하지 않고, 무한모드를 다시 고를 수 있는 설정 로비를 보여준다.
    const game = {
      id: gameId,
      board: Array(9).fill(''),
      players: { X: prevXId, O: 'BOT' },
      guildId: interaction.guildId,
      currentTurn: 'X',
      status: 'setup',
      winner: null,
      message: null,
      timeoutId: null,
      infinite,
      marks: { X: [], O: [] },
    };
    games.set(gameId, game);

    await interaction.update({ content: '', embeds: [buildEmbed(game)], components: [buildBotSetupRow(game)] });
    game.message = await interaction.fetchReply();

    game.timeoutId = setTimeout(async () => {
      const g = games.get(gameId);
      if (!g || g.status !== 'setup') return;
      games.delete(gameId);
      await g.message.edit({ content: '⏰ **설정 시간이 초과되어 게임이 취소되었습니다.**', embeds: [], components: [] }).catch(() => {});
    }, 60_000);
    return;
  }

  if (interaction.user.id !== prevXId && interaction.user.id !== prevOId) {
    await interaction.reply({ content: '⚠️ **원래 참가자만 재대결할 수 있습니다.**', ephemeral: true });
    return;
  }

  // 사람 상대 재대결은 즉시 시작하지 않고, 기존 준비 로비(ttt:ready/ttt:decline)를 그대로
  // 재사용해 상대의 승낙을 받는다. 신청한 사람은 자동으로 준비 상태로 시작한다.
  const newX = prevOId;
  const newO = prevXId; // 선공/후공을 바꿔서 재대결
  const requesterMark = interaction.user.id === newX ? 'X' : 'O';
  const opponentId = requesterMark === 'X' ? newO : newX;

  const game = {
    id: gameId,
    board: Array(9).fill(''),
    players: { X: newX, O: newO },
    guildId: interaction.guildId,
    currentTurn: 'X',
    status: 'waiting',
    winner: null,
    message: null,
    timeoutId: null,
    infinite,
    marks: { X: [], O: [] },
    ready: { X: requesterMark === 'X', O: requesterMark === 'O' },
  };
  games.set(gameId, game);

  await interaction.update({
    content: `🔄 <@${opponentId}>님, <@${interaction.user.id}>님이 재대결을 신청했습니다!`,
    embeds: [buildEmbed(game)],
    components: [buildChallengeRow(game)],
  });
  game.message = await interaction.fetchReply();

  // 60초 내로 상대가 준비하지 않으면 만료
  game.timeoutId = setTimeout(async () => {
    const g = games.get(gameId);
    if (!g || g.status !== 'waiting') return;
    games.delete(gameId);
    await g.message.edit({ content: '⏰ **재대결 신청이 만료되었습니다.**', embeds: [], components: [] }).catch(() => {});
  }, 60_000);
}

async function handleTttButton(interaction) {
  const { customId } = interaction;
  const games = getGames(interaction.client);

  // ── 준비 ──────────────────────────────────────────────────
  // 두 참가자가 각자 자기 준비 상태를 토글하고, 둘 다 준비되면 그 순간 바로 시작한다.
  if (customId.startsWith('ttt:ready:')) {
    const gameId = customId.slice('ttt:ready:'.length);
    const game = games.get(gameId);
    if (!game || game.status !== 'waiting') {
      await interaction.reply({ content: '⚠️ **만료된 게임입니다.**', ephemeral: true });
      return;
    }
    const mark = interaction.user.id === game.players.X ? 'X'
      : interaction.user.id === game.players.O ? 'O' : null;
    if (!mark) {
      await interaction.reply({ content: '⚠️ **게임 참가자만 사용할 수 있습니다.**', ephemeral: true });
      return;
    }
    game.ready[mark] = !game.ready[mark];

    if (game.ready.X && game.ready.O) {
      clearTimeout(game.timeoutId);
      game.status = 'playing';
      await interaction.update({ content: '', embeds: [buildEmbed(game)], components: buildBoard(game) });
      resetTimeout(game, games);
      return;
    }

    await interaction.update({ embeds: [buildEmbed(game)], components: [buildChallengeRow(game)] });
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

  // ── 무한모드 토글 (PvP 준비 로비 / 봇 설정 로비 공용) ────────────
  if (customId.startsWith('ttt:toggleinf:')) {
    const gameId = customId.slice('ttt:toggleinf:'.length);
    const game = games.get(gameId);
    if (!game || (game.status !== 'waiting' && game.status !== 'setup')) {
      await interaction.reply({ content: '⚠️ **만료된 게임입니다.**', ephemeral: true });
      return;
    }
    if (interaction.user.id !== game.players.X && interaction.user.id !== game.players.O) {
      await interaction.reply({ content: '⚠️ **게임 참가자만 사용할 수 있습니다.**', ephemeral: true });
      return;
    }
    game.infinite = !game.infinite;
    if (game.status === 'waiting') {
      // 규칙이 바뀌었으니 양쪽 다 다시 준비해야 한다.
      game.ready.X = false;
      game.ready.O = false;
    }
    await interaction.update({ embeds: [buildEmbed(game)], components: [buildLobbyRow(game)] });
    return;
  }

  // ── 봇 대결 시작 ─────────────────────────────────────────────
  if (customId.startsWith('ttt:botstart:')) {
    const gameId = customId.slice('ttt:botstart:'.length);
    const game = games.get(gameId);
    if (!game || game.status !== 'setup') {
      await interaction.reply({ content: '⚠️ **만료된 게임입니다.**', ephemeral: true });
      return;
    }
    if (interaction.user.id !== game.players.X) {
      await interaction.reply({ content: '⚠️ **게임을 시작한 사람만 시작할 수 있습니다.**', ephemeral: true });
      return;
    }
    clearTimeout(game.timeoutId);
    game.status = 'playing';
    await interaction.update({ content: '', embeds: [buildEmbed(game)], components: buildBoard(game) });
    resetTimeout(game, games);
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
    return;
  }

  // ── 종료 ──────────────────────────────────────────────────
  if (customId.startsWith('ttt:close:')) {
    const parts = customId.split(':');
    const xId = parts[2];
    const oId = parts[3];
    if (interaction.user.id !== xId && interaction.user.id !== oId) {
      await interaction.reply({ content: '⚠️ **원래 참가자만 종료할 수 있습니다.**', ephemeral: true });
      return;
    }
    await interaction.update({ components: [] });
  }
}

module.exports = { startTttCommand, handleTttButton };

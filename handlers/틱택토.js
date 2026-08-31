const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const { applyXp, getXp, levelFromXp, isExcludedGuild, announceLevelUp } = require('./레벨링');
const {
  getRemainingBotXp, addBotMatchXp, DAILY_BOT_MATCH_XP_CAP, timeUntilKstMidnight,
  WAGER_XP, BOT_WIN_XP_MIN, BOT_WIN_XP_MAX, rollBotWinXp,
} = require('./봇전한도');
const { displayNameFromInteraction } = require('./이름');

const TIMEOUT_MS = 5 * 60 * 1000;
// 대기 로비를 열어두는 시간 — 끝말잇기와 동일하게 2분. 그 안에 시작하지 않으면 자동 취소된다.
const LOBBY_MS = 2 * 60 * 1000;
// 악용 방지: 봇전 반복 플레이로 XP를 무한히 파밍하거나, 같은 상대와 즉석 내기를 연달아
// 반복해서 XP를 옮기는 것을 막기 위해 유저당 쿨다운을 둔다(쿨다운 중이면 게임은 정상 진행
// 되지만 XP 정산만 생략됨 — 플레이 자체를 막지는 않음). 정산 시각은 유저당 하나로 공용이고,
// 판정 기준(내기/봇전)만 다르게 본다 — 끝말잇기와 동일한 구조·값.
const WAGER_SETTLE_COOLDOWN_MS = 3 * 60 * 1000; // 사람 vs 사람 내기 정산
const BOT_SETTLE_COOLDOWN_MS   = 5 * 60 * 1000; // 봇전 보상 정산
const xpSettleCooldowns = new Map(); // userId → 마지막 XP 정산 시각(내기·봇전 공용)

function isOnCooldown(userId, cooldownMs) {
  const last = xpSettleCooldowns.get(userId);
  return !!last && Date.now() - last < cooldownMs;
}

function markCooldown(userId) {
  const now = Date.now();
  // 정산이 끝난 판마다만 불리므로(자주 호출되지 않음), 이참에 만료된 항목을 청소해
  // 맵이 과거 플레이어들로 무한히 커지지 않게 한다.
  for (const [id, last] of xpSettleCooldowns) {
    if (now - last > BOT_SETTLE_COOLDOWN_MS) xpSettleCooldowns.delete(id);
  }
  xpSettleCooldowns.set(userId, now);
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

// 봇은 minimax(무한모드는 깊이 제한 minimax)로 늘 최선의 수만 둬서 이론상 지지 않는다 —
// 그러면 봇전이 언제나 무승부 아니면 봇 승리로만 끝나 사람이 이길 길이 없다. 그래서 봇 차례마다
// 낮은 확률로 최선수 대신 아무 빈칸에나 두는 "실수"를 섞어, 가끔 사람이 파고들 틈을 만든다.
// 확률이 낮아 대부분의 수는 여전히 제대로 둔다(반복 파밍은 그대로 쿨다운·하루 한도로 차단).
const BOT_BLUNDER_CHANCE = 0.18;

function randomEmptyCell(board) {
  const empty = [];
  for (let i = 0; i < 9; i++) if (board[i] === '') empty.push(i);
  return empty[Math.floor(Math.random() * empty.length)];
}

// 이번 봇 차례에 둘 칸을 고른다 — 대개는 최선수, 낮은 확률로 일부러 아무 빈칸.
function pickBotMove(game) {
  if (Math.random() < BOT_BLUNDER_CHANCE) return randomEmptyCell(game.board);
  return game.infinite ? getBotMoveInfinite(game.board, game.marks) : getBotMove(game.board);
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

// ── 대기 로비(끝말잇기와 동일한 형태) ──────────────────────────────
// /틱택토 → 참가 버튼으로 대기열에 합류(최대 2명), 방장이 시작하거나 혼자면 봇과 시작.
// 무한모드 토글은 틱택토 고유 기능이라 로비 아래 줄에 그대로 둔다.

function buildLobbyEmbed(game) {
  const playerList = game.lobbyPlayers.length > 0
    ? '```\n' + game.lobbyPlayers.map((p, i) => `${i + 1}. ${p.name}${p.id === game.hostId ? ' 👑' : ''}`).join('\n') + '\n```'
    : '*아직 참가자가 없습니다.*';

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setDescription(
      `## ${game.infinite ? '⭕❌ 틱택토 (♾️ 무한모드)' : '⭕❌ 틱택토'}\n` +
      `참가자를 기다리는 중입니다.\n-# (${LOBBY_MS / 60_000}분 내 시작하지 않으면 자동 취소됩니다)`,
    );
  return embed
    .addFields(
      { name: `👥 참가자  ${game.lobbyPlayers.length}명`, value: playerList },
      {
        name: '📋 규칙',
        value:
          '• 3×3 판에서 번갈아 ❌/⭕를 놓아 가로·세로·대각선으로 3칸을 먼저 이으면 승리합니다.\n' +
          '• 자기 차례에 빈 칸 버튼을 눌러 표시합니다.\n' +
          '• 한 수도 두지 않고 5분이 지나면 시간 초과로 무승부 처리됩니다.\n' +
          '• ♾️ **무한모드**를 켜면 각자 최대 3개까지만 남고, 4번째를 두면 가장 오래된 조각이 사라집니다.',
      },
      {
        name: '🎲 XP 내기',
        value:
          `• 사람끼리 대결하면 진 사람이 최대 ${WAGER_XP} XP를 잃고(강등보호 작동) 이긴 사람이 받습니다.\n` +
          `• 봇과 대결하면 내기 대신, 봇을 이겼을 때 ${BOT_WIN_XP_MIN}~${BOT_WIN_XP_MAX} XP가 지급됩니다.\n` +
          `• 봇전 보상은 하루 최대 ${DAILY_BOT_MATCH_XP_CAP} XP까지만 받을 수 있습니다.`,
      },
    )
    .setFooter({ text: '최소 2명이 참가해야 시작할 수 있습니다.' });
}

function buildLobbyComponents(game) {
  const hasBot = game.lobbyPlayers.some(p => p.id === 'BOT');
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ttt:join:${game.id}`)
        .setLabel('✋ 참가')
        .setStyle(ButtonStyle.Success)
        .setDisabled(game.lobbyPlayers.length >= 2),
      new ButtonBuilder()
        .setCustomId(`ttt:start:${game.id}`)
        .setLabel('▶️ 게임 시작')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(game.lobbyPlayers.length < 2),
      new ButtonBuilder()
        .setCustomId(`ttt:bot_start:${game.id}`)
        .setLabel('🤖 봇과 시작')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(hasBot || game.lobbyPlayers.length !== 1),
      new ButtonBuilder()
        .setCustomId(`ttt:cancel:${game.id}`)
        .setLabel('❌ 취소')
        .setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(buildInfiniteToggleButton(game)),
  ];
}

function buildEmbed(game) {
  const xName = game.players.X === 'BOT' ? '🤖 봇' : `<@${game.players.X}>`;
  const oName = game.players.O === 'BOT' ? '🤖 봇' : `<@${game.players.O}>`;

  let desc = `## ${game.infinite ? '⭕❌ 틱택토 (♾️ 무한모드)' : '⭕❌ 틱택토'}\n❌ ${xName}  **vs**  ⭕ ${oName}\n\n`;

  if (game.status === 'finished') {
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
        if (game.xpResult.capped) desc += `\n-# 하루 봇전 XP 한도(${DAILY_BOT_MATCH_XP_CAP})에 걸려 일부만 지급됐습니다.`;
      } else if (game.xpResult?.type === 'bot_daily_cap') {
        desc += `\n🚫 오늘 봇전 XP 한도(하루 ${DAILY_BOT_MATCH_XP_CAP})를 모두 채워\n 이번 판은 지급되지 않았습니다.\n-# (약 ${timeUntilKstMidnight()} 후 초기화)`;
      } else if (game.xpResult?.type === 'cooldown') {
        const cooldownMin = Math.ceil((game.xpResult.cooldownMs ?? BOT_SETTLE_COOLDOWN_MS) / 60000);
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
    .setDescription(desc)
    .setTimestamp();

  if (game.status !== 'finished') {
    embed.setFooter({ text: `⏰ ${TIMEOUT_MS / 60000}분 안에 두지 않으면 시간 초과로 종료됩니다.` });
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

// 무한모드 토글 버튼: 대기 로비에서 참가자 누구든 눌러 규칙을 바꿀 수 있다 —
// 현재 game.infinite 값에 맞춰 라벨/스타일만 바뀐다.
function buildInfiniteToggleButton(game) {
  return new ButtonBuilder()
    .setCustomId(`ttt:toggleinf:${game.id}`)
    .setLabel(game.infinite ? '♾️ 무한모드: ON' : '♾️ 무한모드: OFF')
    .setStyle(game.infinite ? ButtonStyle.Success : ButtonStyle.Secondary);
}

// 대기 로비의 참가자 목록으로 실제 대국의 선공(X)/후공(O)을 정한다.
// 봇이 낀 판은 예전처럼 사람이 X(선공), 봇이 O(후공) 고정 — 봇 AI가 'O' 기준으로 짜여 있다.
// 사람끼리면 선공을 무작위로 섞는다.
function assignMarks(game) {
  const bot = game.lobbyPlayers.find(p => p.id === 'BOT');
  if (bot) {
    const human = game.lobbyPlayers.find(p => p.id !== 'BOT');
    game.players = { X: human.id, O: 'BOT' };
    return;
  }
  const ps = game.lobbyPlayers.slice();
  if (Math.random() < 0.5) ps.reverse();
  game.players = { X: ps[0].id, O: ps[1].id };
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
  if (isOnCooldown(winnerId, WAGER_SETTLE_COOLDOWN_MS) || isOnCooldown(loserId, WAGER_SETTLE_COOLDOWN_MS)) {
    return { type: 'cooldown', cooldownMs: WAGER_SETTLE_COOLDOWN_MS };
  }

  const loserLevelXp = levelFromXp(getXp(game.guildId, loserId)).currentLevelXp;
  const wager = Math.min(WAGER_XP, loserLevelXp);
  if (wager <= 0) return null;

  const loserResult = applyXp(game.guildId, loserId, -wager);
  const winnerResult = applyXp(game.guildId, winnerId, wager);
  return { type: 'wager', wager, winnerId, loserId, winnerResult, loserResult };
}

// 사람이 봇을 이겼을 때 보상 XP를 지급한다(봇이 이기거나 무승부면 지급 없음).
function settleBotWinXp(game) {
  if (!game.guildId || game.winner === 'DRAW') return null;
  const loserMark = game.winner === 'X' ? 'O' : 'X';
  const winnerId = game.players[game.winner];
  if (game.players[loserMark] !== 'BOT' || winnerId === 'BOT') return null;
  // 봇전 반복 플레이로 XP를 무한히 파밍하는 것 방지 — 이유를 xpResult에 남겨서 화면에 안내한다.
  if (isOnCooldown(winnerId, BOT_SETTLE_COOLDOWN_MS)) return { type: 'cooldown', cooldownMs: BOT_SETTLE_COOLDOWN_MS };

  // 하루(KST) 누적 상한(끝말잇기와 합산). 남은 한도가 없으면 이번 판은 지급하지 않고,
  // 굴린 금액보다 한도가 적으면 그만큼만 준다.
  const remaining = getRemainingBotXp(game.guildId, winnerId);
  if (remaining <= 0) return { type: 'bot_daily_cap' };

  const rolled = rollBotWinXp();
  const amount = Math.min(rolled, remaining);
  addBotMatchXp(game.guildId, winnerId, amount);
  const result = applyXp(game.guildId, winnerId, amount);
  return { type: 'bot_win', amount, winnerId, winnerResult: result, capped: amount < rolled };
}

function settleGameXp(game) {
  if (isExcludedGuild(game.guildId)) return; // 레벨 시스템 제외 서버(테스트 서버 등)는 내기/보상도 미적용
  const result = settleWagerXp(game) || settleBotWinXp(game);
  game.xpResult = result;
  if (!result || result.type === 'cooldown' || result.type === 'bot_daily_cap') return;

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

// 대기 로비 → 실제 대국 시작. 누른 버튼(시작/봇과 시작)의 상호작용으로 로비 메시지를 보드로 바꾼다.
async function beginGame(interaction, game, games) {
  assignMarks(game);
  clearTimeout(game.timeoutId);
  game.status = 'playing';
  game.currentTurn = 'X';
  game.board = Array(9).fill('');
  game.marks = { X: [], O: [] };

  await interaction.update({ content: '', embeds: [buildEmbed(game)], components: buildBoard(game) });
  resetTimeout(game, games);
}

async function startTttCommand(interaction) {
  const games = getGames(interaction.client);
  const gameId = interaction.id;

  const game = {
    id: gameId,
    hostId: interaction.user.id,
    guildId: interaction.guildId,
    lobbyPlayers: [{ id: interaction.user.id, name: displayNameFromInteraction(interaction) }],
    board: Array(9).fill(''),
    players: null,
    currentTurn: 'X',
    status: 'waiting',
    winner: null,
    message: null,
    timeoutId: null,
    infinite: false,
    marks: { X: [], O: [] },
  };
  games.set(gameId, game);

  await interaction.reply({ embeds: [buildLobbyEmbed(game)], components: buildLobbyComponents(game) });
  game.message = await interaction.fetchReply();

  // 2분 내로 시작하지 않으면 자동 취소
  game.timeoutId = setTimeout(async () => {
    const g = games.get(gameId);
    if (!g || g.status !== 'waiting') return;
    games.delete(gameId);
    await interaction.editReply({ content: '⏰ **참가자가 없어 게임이 취소되었습니다.**', embeds: [], components: [] }).catch(() => {});
  }, LOBBY_MS);
}

// 지난 판 결과 보드는 그대로 남겨두고, 재대결은 새 메시지로 시작한다 — 예전엔 결과 보드를
// 통째로 덮어써서 방금 끝난 판의 최종 보드와 XP 정산 내역이 사라졌다.
// 다 쓴 '재대결 / 종료' 버튼만 떼어낸다.
async function postRematchMessage(interaction, payload) {
  await interaction.update({ components: [] });
  return interaction.channel.send(payload);
}

// 재대결이 성사되지 못하면(취소·만료) 지난 판 결과 보드에 재대결 버튼을 되살려
// 그 자리에서 다시 신청할 수 있게 한다. 원래 게임은 이미 map에서 지워졌으므로,
// 버튼을 다시 만드는 데 필요한 값은 재대결을 시작할 때 game.rematchSource에 담아둔다.
async function restoreRematchButton(game) {
  const source = game?.rematchSource;
  if (!source?.message) return;
  await source.message.edit({
    components: [buildFinishedRow({ players: { X: source.xId, O: source.oId }, infinite: source.infinite })],
  }).catch(() => {});
}

// 참가자 둘이 거의 동시에 '재대결'을 누르면 신청이 두 개 만들어지고 둘 다 같은 메시지를
// 붙잡는다. 그러면 밀려난 쪽의 만료 타이머가 살아 있다가, 그 사이 시작된 게임 화면을
// '만료되었습니다'로 덮어써 지워버린다. 결과 메시지 하나당 재대결은 하나만 만들게 막는다.
// (끝말잇기와 달리 원래 게임은 끝나는 순간 지워지므로, 그 게임 대신 결과 메시지를 기준으로 센다)
function hasRematchFrom(games, messageId) {
  for (const game of games.values()) {
    if (game.sourceMessageId === messageId) return true;
  }
  return false;
}

// 재대결: 원래 게임은 끝나는 순간 map에서 지워지므로, ttt:rematch 버튼의 customId에
// 담아둔 정보(X/O였던 유저, 무한모드 여부)만으로 새 대기 로비를 만든다. 신청자만 로비에
// 들어간 상태로 시작하고, 사람 상대였다면 상대를 멘션해 참가 버튼을 누르도록 안내한다.
async function startRematch(interaction, prevXId, prevOId, infinite) {
  const games = getGames(interaction.client);
  const gameId = interaction.id;
  const isBot = prevOId === 'BOT';
  const prevIds = isBot ? [prevXId] : [prevXId, prevOId];

  if (!prevIds.includes(interaction.user.id)) {
    await interaction.reply({ content: '⚠️ **원래 참가자만 재대결할 수 있습니다.**', flags: MessageFlags.Ephemeral });
    return;
  }

  if (hasRematchFrom(games, interaction.message.id)) {
    await interaction.reply({ content: '⚠️ **이미 재대결 신청이 진행 중입니다.**', flags: MessageFlags.Ephemeral });
    return;
  }

  const invitedId = isBot ? null : prevIds.find(id => id !== interaction.user.id);

  const game = {
    id: gameId,
    hostId: interaction.user.id,
    guildId: interaction.guildId,
    lobbyPlayers: [{ id: interaction.user.id, name: displayNameFromInteraction(interaction) }],
    sourceMessageId: interaction.message.id, // 이 결과 메시지에서 시작된 재대결임을 표시(중복 신청 차단용)
    rematchSource: { message: interaction.message, xId: prevXId, oId: prevOId, infinite }, // 취소·만료 시 재대결 버튼을 되살릴 지난 판
    board: Array(9).fill(''),
    players: null,
    currentTurn: 'X',
    status: 'waiting',
    winner: null,
    message: null,
    timeoutId: null,
    infinite,
    marks: { X: [], O: [] },
  };
  games.set(gameId, game);

  const content = invitedId
    ? `🔄 <@${invitedId}>님, <@${interaction.user.id}>님이 재대결을 신청했습니다! 참가하려면 **✋ 참가**를 누르세요.`
    : undefined;

  game.message = await postRematchMessage(interaction, {
    content,
    embeds: [buildLobbyEmbed(game)],
    components: buildLobbyComponents(game),
  });

  // 2분 내로 시작하지 않으면 만료 — 지난 판에 재대결 버튼을 되살린다.
  game.timeoutId = setTimeout(async () => {
    const g = games.get(gameId);
    if (!g || g.status !== 'waiting') return;
    games.delete(gameId);
    await g.message.edit({ content: '⏰ **재대결 신청이 만료되었습니다.**', embeds: [], components: [] }).catch(() => {});
    await restoreRematchButton(g);
  }, LOBBY_MS);
}

async function handleTttButton(interaction) {
  const { customId } = interaction;
  const games = getGames(interaction.client);

  // ── 참가 ──────────────────────────────────────────────────
  if (customId.startsWith('ttt:join:')) {
    const gameId = customId.slice('ttt:join:'.length);
    const game = games.get(gameId);
    if (!game || game.status !== 'waiting') {
      await interaction.reply({ content: '⚠️ **참가할 수 없는 게임입니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    if (game.lobbyPlayers.some(p => p.id === interaction.user.id)) {
      await interaction.reply({ content: '⚠️ **이미 참가 중입니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    if (game.lobbyPlayers.length >= 2) {
      await interaction.reply({ content: '⚠️ **정원(2명)이 이미 찼습니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    game.lobbyPlayers.push({ id: interaction.user.id, name: displayNameFromInteraction(interaction) });
    await interaction.update({ embeds: [buildLobbyEmbed(game)], components: buildLobbyComponents(game) });
    return;
  }

  // ── 시작 ──────────────────────────────────────────────────
  if (customId.startsWith('ttt:start:')) {
    const gameId = customId.slice('ttt:start:'.length);
    const game = games.get(gameId);
    if (!game || game.status !== 'waiting') {
      await interaction.reply({ content: '⚠️ **게임을 시작할 수 없습니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.user.id !== game.hostId) {
      await interaction.reply({ content: '⚠️ **방장만 게임을 시작할 수 있습니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    if (game.lobbyPlayers.length < 2) {
      await interaction.reply({ content: '⚠️ **최소 2명이 필요합니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    await beginGame(interaction, game, games);
    return;
  }

  // ── 봇과 시작 ─────────────────────────────────────────────
  if (customId.startsWith('ttt:bot_start:')) {
    const gameId = customId.slice('ttt:bot_start:'.length);
    const game = games.get(gameId);
    if (!game || game.status !== 'waiting') {
      await interaction.reply({ content: '⚠️ **게임을 시작할 수 없습니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.user.id !== game.hostId) {
      await interaction.reply({ content: '⚠️ **방장만 사용할 수 있습니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    if (game.lobbyPlayers.some(p => p.id === 'BOT')) {
      await interaction.reply({ content: '⚠️ **봇은 이미 참가 중입니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    if (game.lobbyPlayers.length !== 1) {
      await interaction.reply({ content: '⚠️ **참가자가 1명일 때만 봇과 시작할 수 있습니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    game.lobbyPlayers.push({ id: 'BOT', name: '봇' });
    await beginGame(interaction, game, games);
    return;
  }

  // ── 취소 ──────────────────────────────────────────────────
  if (customId.startsWith('ttt:cancel:')) {
    const gameId = customId.slice('ttt:cancel:'.length);
    const game = games.get(gameId);
    if (!game) {
      await interaction.reply({ content: '⚠️ **게임을 찾을 수 없습니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.user.id !== game.hostId) {
      await interaction.reply({ content: '⚠️ **방장만 취소할 수 있습니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    clearTimeout(game.timeoutId);
    games.delete(gameId);
    await interaction.update({ content: '❌ **게임이 취소되었습니다.**', embeds: [], components: [] });
    await restoreRematchButton(game);
    return;
  }

  // ── 무한모드 토글 (대기 로비) ──────────────────────────────
  if (customId.startsWith('ttt:toggleinf:')) {
    const gameId = customId.slice('ttt:toggleinf:'.length);
    const game = games.get(gameId);
    if (!game || game.status !== 'waiting') {
      await interaction.reply({ content: '⚠️ **만료된 게임입니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    if (!game.lobbyPlayers.some(p => p.id === interaction.user.id)) {
      await interaction.reply({ content: '⚠️ **게임 참가자만 사용할 수 있습니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    game.infinite = !game.infinite;
    await interaction.update({ embeds: [buildLobbyEmbed(game)], components: buildLobbyComponents(game) });
    return;
  }

  // ── 이동 ──────────────────────────────────────────────────
  if (customId.startsWith('ttt:move:')) {
    const parts = customId.split(':');
    const gameId = parts[2];
    const cellIdx = parseInt(parts[3]);
    const game = games.get(gameId);

    if (!game || game.status !== 'playing') {
      await interaction.reply({ content: '⚠️ **진행 중인 게임이 아닙니다.**', flags: MessageFlags.Ephemeral });
      return;
    }

    const currentPlayerId = game.players[game.currentTurn];
    if (interaction.user.id !== currentPlayerId) {
      const turnEmoji = game.currentTurn === 'X' ? '❌' : '⭕';
      await interaction.reply({ content: `⚠️ **지금은 ${turnEmoji} 플레이어의 차례입니다.**`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (game.board[cellIdx] !== '') {
      await interaction.reply({ content: '⚠️ **이미 놓인 칸입니다.**', flags: MessageFlags.Ephemeral });
      return;
    }

    applyMove(game, games, cellIdx, game.currentTurn === 'X' ? 'X' : 'O');
    await interaction.update({ content: '', embeds: [buildEmbed(game)], components: buildBoard(game) });

    if (game.status === 'finished') return;

    // 봇 차례
    if (game.players[game.currentTurn] === 'BOT') {
      const botIdx = pickBotMove(game);
      applyMove(game, games, botIdx, 'O');
      await game.message.edit({ content: '', embeds: [buildEmbed(game)], components: buildBoard(game) }).catch(() => {});
      // 봇이 두고 나면 다시 사람 차례 — 이 턴에도 5분 타이머를 새로 걸어야 한다.
      // (안 걸면 beginGame 때 건 타이머 하나로 온 게임을 재는 꼴이 돼, 봇전은 판 시작 후
      //  5분이 지나면 사람 차례에 무승부로 끝나버린다. 사람 vs 사람은 아래에서 매 턴 갱신됨)
      if (game.status !== 'finished') resetTimeout(game, games);
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
      await interaction.reply({ content: '⚠️ **원래 참가자만 종료할 수 있습니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.update({ components: [] });
  }
}

module.exports = { startTttCommand, handleTttButton };

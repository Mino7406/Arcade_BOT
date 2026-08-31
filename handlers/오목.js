// 오목.js — 15×15 오목 미니게임. 대기 로비 · 봇전 · XP 내기 · 재대결까지
// 끝말잇기/틱택토와 같은 흐름으로 맞췄다. 판 이미지 렌더링과 봇 AI도 이 한 파일에 들어있다.
//
// 렌더링: 외부 이미지 라이브러리(canvas·pureimage·sharp 등)는 네이티브 빌드가 필요하거나
//   상주 메모리를 크게 먹어서, 콘솔 없이 버튼으로만 재시작하는 호스팅 + 256MB RAM 환경에
//   부담이다. 그래서 픽셀 버퍼에 직접 선/원/글자를 찍고 Node 내장 zlib로 PNG를 인코딩한다
//   (의존성 0). 렌더 1회에 약 1MB 버퍼가 잠깐 잡혔다가 GC된다.
// AI: "경우의 수 10^180" 같은 완전 탐색이나 대형 정석 DB는 쓰지 않는다. 각 빈 칸에 돌을 놨을
//   때 4방향으로 만들어지는 연속선(길이 + 양끝 열림)을 패턴 점수로 환산해, 내 공격 점수와
//   상대 공격 점수(=막아야 할 급함)를 합산해 가장 좋은 칸을 고른다. 한 수 계산이 수 ms.

const zlib = require('zlib');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  MessageFlags,
} = require('discord.js');
const { applyXp, getXp, levelFromXp, isExcludedGuild, announceLevelUp } = require('./레벨링');
const {
  getRemainingBotXp, addBotMatchXp, DAILY_BOT_MATCH_XP_CAP, timeUntilKstMidnight,
  WAGER_XP, BOT_WIN_XP_MIN, BOT_WIN_XP_MAX, rollBotWinXp,
} = require('./봇전한도');
const { displayNameFromInteraction } = require('./이름');

const N = 15;
const cellIdx = (x, y) => y * N + x;
const other = (c) => (c === 'B' ? 'W' : 'B');

// ══════════════════════════════════════════════════════════════
//  판 렌더링 (PNG)
// ══════════════════════════════════════════════════════════════

// 5×7 비트맵 폰트 (좌표 A~O, 숫자 0~9에만 쓴다. P~Z는 재사용 대비).
// 각 글자는 7바이트(위→아래). 하위 5비트가 한 줄이고 bit4가 가장 왼쪽 픽셀.
const FONT = {
  '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14],
  '2': [14, 17, 1, 2, 4, 8, 31],     '3': [31, 2, 4, 2, 1, 17, 14],
  '4': [2, 6, 10, 18, 31, 2, 2],     '5': [31, 16, 30, 1, 1, 17, 14],
  '6': [6, 8, 16, 30, 17, 17, 14],   '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14], '9': [14, 17, 17, 15, 1, 2, 12],
  'A': [14, 17, 17, 31, 17, 17, 17], 'B': [30, 17, 17, 30, 17, 17, 30],
  'C': [14, 17, 16, 16, 16, 17, 14], 'D': [28, 18, 17, 17, 17, 18, 28],
  'E': [31, 16, 16, 30, 16, 16, 31], 'F': [31, 16, 16, 30, 16, 16, 16],
  'G': [14, 17, 16, 23, 17, 17, 15], 'H': [17, 17, 17, 31, 17, 17, 17],
  'I': [14, 4, 4, 4, 4, 4, 14],      'J': [7, 2, 2, 2, 2, 18, 12],
  'K': [17, 18, 20, 24, 20, 18, 17], 'L': [16, 16, 16, 16, 16, 16, 31],
  'M': [17, 27, 21, 21, 17, 17, 17], 'N': [17, 17, 25, 21, 19, 17, 17],
  'O': [14, 17, 17, 17, 17, 17, 14], 'P': [30, 17, 17, 30, 16, 16, 16],
  'Q': [14, 17, 17, 17, 21, 18, 13], 'R': [30, 17, 17, 30, 20, 18, 17],
  'S': [15, 16, 16, 14, 1, 1, 30],   'T': [31, 4, 4, 4, 4, 4, 4],
  'U': [17, 17, 17, 17, 17, 17, 14], 'V': [17, 17, 17, 17, 17, 10, 4],
  'W': [17, 17, 17, 21, 21, 27, 17], 'X': [17, 17, 10, 4, 10, 17, 17],
  'Y': [17, 17, 10, 4, 4, 4, 4],     'Z': [31, 1, 2, 4, 8, 16, 31],
};

const CELL = 36;                    // 교차점 간격(px)
const MARGIN = 42;                  // 좌표 라벨용 여백(px)
const SIZE = MARGIN * 2 + CELL * (N - 1); // 588×588
const STONE_R = CELL * 0.45;        // 돌 반지름
const STAR_R = 3.4;                 // 화점 반지름
const STARS = [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]]; // 화점 위치(0-indexed)

const COL = {
  wood:      [0xE3, 0xBE, 0x84],
  woodEdge:  [0xC9, 0x9F, 0x63],
  grid:      [0x4A, 0x39, 0x28],
  label:     [0x3A, 0x2E, 0x22],
  black:     [0x1B, 0x1B, 0x1F],
  blackEdge: [0x00, 0x00, 0x00],
  white:     [0xF6, 0xF5, 0xF0],
  whiteEdge: [0x69, 0x62, 0x58],
  last:      [0xE0, 0x2C, 0x2C], // 마지막 착수 표시(빨간 링)
};

function px(buf, x, y, c) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 3;
  buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
}

function blend(buf, x, y, c, a) {
  if (a <= 0 || x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  if (a >= 1) return px(buf, x, y, c);
  const i = (y * SIZE + x) * 3;
  buf[i]     = Math.round(c[0] * a + buf[i]     * (1 - a));
  buf[i + 1] = Math.round(c[1] * a + buf[i + 1] * (1 - a));
  buf[i + 2] = Math.round(c[2] * a + buf[i + 2] * (1 - a));
}

function fillRect(buf, x0, y0, w, h, c) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px(buf, x, y, c);
}

// 안티에일리어싱 원(coverage = 반지름 경계에서 부드럽게 0→1).
function fillCircle(buf, cx, cy, r, c) {
  const x0 = Math.floor(cx - r - 1), x1 = Math.ceil(cx + r + 1);
  const y0 = Math.floor(cy - r - 1), y1 = Math.ceil(cy + r + 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      blend(buf, x, y, c, Math.max(0, Math.min(1, r + 0.5 - d)));
    }
  }
}

// 링(테두리만). lw = 선 두께.
function strokeCircle(buf, cx, cy, r, lw, c) {
  const x0 = Math.floor(cx - r - lw), x1 = Math.ceil(cx + r + lw);
  const y0 = Math.floor(cy - r - lw), y1 = Math.ceil(cy + r + lw);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.abs(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r);
      blend(buf, x, y, c, Math.max(0, Math.min(1, lw / 2 + 0.5 - d)));
    }
  }
}

// 글자 하나를 (left, top) 기준으로 scale배 확대해 찍는다.
function glyph(buf, ch, left, top, scale, c) {
  const rows = FONT[ch];
  if (!rows) return;
  for (let r = 0; r < 7; r++) {
    for (let col = 0; col < 5; col++) {
      if ((rows[r] >> (4 - col)) & 1) fillRect(buf, left + col * scale, top + r * scale, scale, scale, c);
    }
  }
}

// 문자열을 (cx, cy) 중앙 정렬로 찍는다.
function drawText(buf, str, cx, cy, scale, c) {
  const adv = 6 * scale;                 // 글자 폭 5 + 간격 1
  let left = Math.round(cx - (str.length * adv - scale) / 2);
  const top = Math.round(cy - (7 * scale) / 2);
  for (const ch of str) { glyph(buf, ch, left, top, scale, c); left += adv; }
}

const pxOf = (g) => MARGIN + g * CELL;  // 교차점(0~14) → 픽셀 좌표

// ── PNG 인코딩 (truecolor 8bit, filter 0) ────────────────────
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(rgb) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type: truecolor RGB

  const stride = SIZE * 3;
  const raw = Buffer.alloc((stride + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * (stride + 1)] = 0; // 스캔라인 필터 바이트
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });

  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// board: 길이 225 배열('' | 'B' | 'W'), last: {x,y}|null → PNG Buffer
function renderBoard(board, last) {
  const buf = Buffer.alloc(SIZE * SIZE * 3);

  fillRect(buf, 0, 0, SIZE, SIZE, COL.wood);
  fillRect(buf, 0, 0, SIZE, 2, COL.woodEdge);
  fillRect(buf, 0, SIZE - 2, SIZE, 2, COL.woodEdge);
  fillRect(buf, 0, 0, 2, SIZE, COL.woodEdge);
  fillRect(buf, SIZE - 2, 0, 2, SIZE, COL.woodEdge);

  for (let i = 0; i < N; i++) {
    fillRect(buf, pxOf(0), pxOf(i), CELL * (N - 1) + 1, 1, COL.grid);   // 가로줄
    fillRect(buf, pxOf(i), pxOf(0), 1, CELL * (N - 1) + 1, COL.grid);   // 세로줄
  }
  for (const [sx, sy] of STARS) fillCircle(buf, pxOf(sx) + 0.5, pxOf(sy) + 0.5, STAR_R, COL.grid);

  for (let i = 0; i < N; i++) {
    drawText(buf, String.fromCharCode(65 + i), pxOf(i) + 0.5, MARGIN / 2, 3, COL.label);
    drawText(buf, String(i + 1), MARGIN / 2, pxOf(i) + 0.5, 3, COL.label);
  }

  for (let g = 0; g < 225; g++) {
    const v = board[g];
    if (!v) continue;
    const cx = pxOf(g % 15) + 0.5, cy = pxOf(Math.floor(g / 15)) + 0.5;
    if (v === 'B') {
      fillCircle(buf, cx, cy, STONE_R, COL.blackEdge);
      fillCircle(buf, cx, cy, STONE_R - 1.2, COL.black);
      blend(buf, Math.round(cx - STONE_R * 0.35), Math.round(cy - STONE_R * 0.35), [255, 255, 255], 0.18);
    } else {
      fillCircle(buf, cx, cy, STONE_R, COL.whiteEdge);
      fillCircle(buf, cx, cy, STONE_R - 1.2, COL.white);
    }
  }

  if (last) strokeCircle(buf, pxOf(last.x) + 0.5, pxOf(last.y) + 0.5, STONE_R * 0.42, 2, COL.last);

  return encodePng(buf);
}

// ══════════════════════════════════════════════════════════════
//  봇 AI
// ══════════════════════════════════════════════════════════════

const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
const WIN = 100000;
const inBoard = (x, y) => x >= 0 && y >= 0 && x < N && y < N;
const at = (board, x, y) => (inBoard(x, y) ? board[cellIdx(x, y)] : null); // 판 밖은 null(=막힘)

// (x, y)에 c를 놨다고 가정하고, dx/dy 축에서 만들어지는 연속선 정보.
// len: c가 연속으로 이어지는 총 길이(놓은 돌 포함), open: 그 선의 양끝 중 빈 칸인 쪽 수(0~2).
function lineInfo(board, x, y, dx, dy, c) {
  let len = 1, open = 0;
  for (const sign of [1, -1]) {
    let nx = x + dx * sign, ny = y + dy * sign;
    while (at(board, nx, ny) === c) { len++; nx += dx * sign; ny += dy * sign; }
    if (at(board, nx, ny) === '') open++;
  }
  return { len, open };
}

function patternValue(len, open) {
  if (len >= 5) return WIN;
  if (open === 0) return 0;            // 양끝 다 막힌 선은 승산 없음
  if (len === 4) return open === 2 ? 15000 : 4000;
  if (len === 3) return open === 2 ? 3000 : 300;
  if (len === 2) return open === 2 ? 250 : 40;
  return open === 2 ? 12 : 4;          // len === 1
}

// (x, y)가 비어 있을 때, 거기에 c를 놓으면 c 진영이 얻는 공격 가치의 합.
function cellScore(board, x, y, c) {
  let s = 0;
  for (const [dx, dy] of DIRS) {
    const { len, open } = lineInfo(board, x, y, dx, dy, c);
    s += patternValue(len, open);
  }
  return s;
}

// (x, y)에 c를 실제로 놓은 뒤, 그 돌을 지나는 가장 긴 연속선 길이. 5 이상이면 승리.
function longestRun(board, x, y, c) {
  let best = 1;
  for (const [dx, dy] of DIRS) {
    let len = 1;
    for (const sign of [1, -1]) {
      let nx = x + dx * sign, ny = y + dy * sign;
      while (at(board, nx, ny) === c) { len++; nx += dx * sign; ny += dy * sign; }
    }
    if (len > best) best = len;
  }
  return best;
}

const isWin = (board, x, y, c) => longestRun(board, x, y, c) >= 5;
const isFull = (board) => board.every(v => v !== '');

// 기존 돌 주변(체비셰프 거리 ≤ 2)의 빈 칸만 후보로 본다 — 오목은 늘 돌 근처에 둔다.
function candidates(board) {
  const out = [];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (board[cellIdx(x, y)] !== '') continue;
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const v = at(board, x + dx, y + dy);
          if (v && v !== '') { near = true; break; }
        }
      }
      if (near) out.push({ x, y });
    }
  }
  return out;
}

// 봇이 이번에 둘 칸. blunder=true면 정석적 최선수 대신 가벼운 실수를 섞되, 상대가 바로 5를
// 만드는 자리만은 막아서 게임이 어이없이 끝나지는 않게 한다.
function pickBotMove(board, botColor, blunder = false) {
  const opp = other(botColor);
  const cells = candidates(board);
  if (cells.length === 0) return { x: 7, y: 7 }; // 첫 수

  let win = null, block = null, bestOppShape = -1;
  let bestOff = null, bestOffScore = -1;
  let bestCombo = null, bestComboScore = -Infinity;

  for (const { x, y } of cells) {
    const off = cellScore(board, x, y, botColor);
    const def = cellScore(board, x, y, opp);

    if (off >= WIN && !win) win = { x, y };
    if (def >= WIN && (!block || def > bestOppShape)) { block = { x, y }; }
    if (def > bestOppShape) bestOppShape = def;
    if (off > bestOffScore) { bestOffScore = off; bestOff = { x, y }; }

    const combo = off * 1.0 + def * 0.95 + Math.random() * 0.5;
    if (combo > bestComboScore) { bestComboScore = combo; bestCombo = { x, y }; }
  }

  if (win && !blunder) return win;            // 내가 이기는 수
  if (block) return block;                    // 상대 5 임박은 blunder여도 무조건 막는다
  if (win) return win;
  if (blunder) return cells[Math.floor(Math.random() * cells.length)];

  if (bestOppShape >= 15000) {                // 상대 열린 4 임박 → 그 위협을 없애는 칸
    let bx = null, bs = -1;
    for (const { x, y } of cells) {
      const def = cellScore(board, x, y, opp);
      if (def > bs) { bs = def; bx = { x, y }; }
    }
    if (bx) return bx;
  }
  if (bestOffScore >= 15000) return bestOff;  // 내 열린 4 가능 → 만들기(사실상 승리)

  return bestCombo || bestOff;
}

// ══════════════════════════════════════════════════════════════
//  게임 진행 · 로비 · 봇전 · XP · 재대결
// ══════════════════════════════════════════════════════════════

// 한 수 제한시간(사람 차례). 오목은 끝말잇기보다 숙고 시간이 길어 넉넉히 잡는다.
const TURN_MS = 5 * 60 * 1000;
// 대기 로비를 열어두는 시간 — 끝말잇기/틱택토와 동일하게 2분.
const LOBBY_MS = 2 * 60 * 1000;
// 봇전 파밍 방지용 유저당 XP 정산 쿨다운(플레이 자체는 막지 않고 정산만 생략) — 틱택토와 동일.
const WAGER_SETTLE_COOLDOWN_MS = 3 * 60 * 1000;
const BOT_SETTLE_COOLDOWN_MS   = 5 * 60 * 1000;
const xpSettleCooldowns = new Map(); // userId → 마지막 XP 정산 시각(내기·봇전 공용)

// 봇이 늘 최선수만 두면 사람이 이길 길이 거의 없어 봇전 보상이 사실상 죽는다. 낮은 확률로
// "가벼운 실수"를 섞어(상대 5 임박만은 무조건 막음) 사람이 파고들 틈을 만든다. 반복 파밍은
// 쿨다운·하루 한도로 따로 차단된다 — 틱택토의 BOT_BLUNDER_CHANCE와 같은 취지.
const BOT_BLUNDER_CHANCE = 0.14;

function isOnCooldown(userId, cooldownMs) {
  const last = xpSettleCooldowns.get(userId);
  return !!last && Date.now() - last < cooldownMs;
}

function markCooldown(userId) {
  const now = Date.now();
  for (const [id, last] of xpSettleCooldowns) {
    if (now - last > BOT_SETTLE_COOLDOWN_MS) xpSettleCooldowns.delete(id);
  }
  xpSettleCooldowns.set(userId, now);
}

function getGames(client) {
  if (!client.omokGames) client.omokGames = new Map();
  return client.omokGames;
}

// "H8", "8H", "h-8", "H 8" 등을 {x, y}(0~14)로. 좌표로 안 보이면 null(잡담으로 무시).
function parseCoord(text) {
  const s = (text || '').trim().toUpperCase().replace(/[\s\-.,]/g, '');
  let m = s.match(/^([A-O])(\d{1,2})$/);
  let colCh, row;
  if (m) { colCh = m[1]; row = parseInt(m[2], 10); }
  else {
    m = s.match(/^(\d{1,2})([A-O])$/);
    if (!m) return null;
    row = parseInt(m[1], 10); colCh = m[2];
  }
  if (row < 1 || row > 15) return null;
  return { x: colCh.charCodeAt(0) - 65, y: row - 1 };
}

const coordLabel = (x, y) => String.fromCharCode(65 + x) + (y + 1);

async function react(message, emoji) {
  try { await message.react(emoji); } catch { /* 권한 없음 등은 무시 */ }
}

// ── XP 정산 (틱택토와 동일한 구조·상수) ──────────────────────────
function settleWagerXp(game) {
  if (!game.guildId || game.winner === 'DRAW') return null;
  const loserColor = other(game.winner);
  const winnerId = game.players[game.winner];
  const loserId = game.players[loserColor];
  if (winnerId === 'BOT' || loserId === 'BOT') return null;
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

function settleBotWinXp(game) {
  if (!game.guildId || game.winner === 'DRAW') return null;
  const loserColor = other(game.winner);
  const winnerId = game.players[game.winner];
  if (game.players[loserColor] !== 'BOT' || winnerId === 'BOT') return null;
  if (isOnCooldown(winnerId, BOT_SETTLE_COOLDOWN_MS)) return { type: 'cooldown', cooldownMs: BOT_SETTLE_COOLDOWN_MS };
  const remaining = getRemainingBotXp(game.guildId, winnerId);
  if (remaining <= 0) return { type: 'bot_daily_cap' };
  const rolled = rollBotWinXp();
  const amount = Math.min(rolled, remaining);
  addBotMatchXp(game.guildId, winnerId, amount);
  const result = applyXp(game.guildId, winnerId, amount);
  return { type: 'bot_win', amount, winnerId, winnerResult: result, capped: amount < rolled };
}

function settleGameXp(game) {
  if (isExcludedGuild(game.guildId)) return;
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

// ── 렌더 페이로드 ───────────────────────────────────────────
function boardFile(game) {
  return new AttachmentBuilder(renderBoard(game.board, game.lastMove), { name: 'omok.png' });
}

function buildEmbed(game) {
  const bName = game.players.B === 'BOT' ? '🤖 봇' : `<@${game.players.B}>`;
  const wName = game.players.W === 'BOT' ? '🤖 봇' : `<@${game.players.W}>`;
  let desc = `# ⚫ 오목\n⚫ ${bName}  **vs**  ⚪ ${wName}\n\n`;

  if (game.status === 'finished') {
    if (game.winner === 'DRAW') {
      desc += '**🤝 무승부!**';
    } else {
      const winName = game.winner === 'B' ? bName : wName;
      const winEmoji = game.winner === 'B' ? '⚫' : '⚪';
      desc += `**🏆 ${winEmoji} ${winName} 승리!**`;
      if (game.lastMove) desc += `  \n-# 마지막 수: ${coordLabel(game.lastMove.x, game.lastMove.y)} · 총 ${game.moveCount}수`;

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
    const turnName = game.turn === 'B' ? bName : wName;
    const turnEmoji = game.turn === 'B' ? '⚫' : '⚪';
    desc += `${turnEmoji} **${turnName}의 차례** — 좌표를 채팅으로 입력하세요 (예: \`H8\`)`;
    if (game.lastMove) desc += `\n-# 마지막 수: ${coordLabel(game.lastMove.x, game.lastMove.y)} · ${game.moveCount}수`;
  }

  const color = game.status === 'finished'
    ? (game.winner === 'DRAW' ? 0x808080 : 0xFFD700)
    : 0x5865F2;

  return new EmbedBuilder()
    .setColor(color)
    .setDescription(desc)
    .setImage('attachment://omok.png')
    .setFooter({ text: '5분 안에 두지 않으면 시간 초과로 종료됩니다.' })
    .setTimestamp();
}

// 종료 후 재대결/종료 버튼 — 게임이 map에서 지워지므로 필요한 정보는 customId에 담는다.
function buildFinishedRow(bId, wId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`omok:rematch:${bId}:${wId}`).setLabel('🔄 재대결').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`omok:close:${bId}:${wId}`).setLabel('🛑 종료').setStyle(ButtonStyle.Secondary),
  );
}

function boardPayload(game) {
  return {
    content: '',
    embeds: [buildEmbed(game)],
    files: [boardFile(game)],
    components: game.status === 'finished' ? [buildFinishedRow(game.players.B, game.players.W)] : [],
    attachments: [],
  };
}

// ── 대기 로비 (틱택토와 동일한 형태, 무한모드 토글만 없음) ──────────
function buildLobbyEmbed(game) {
  const playerList = game.lobbyPlayers.length > 0
    ? '```\n' + game.lobbyPlayers.map((p, i) => `${i + 1}. ${p.name}${p.id === game.hostId ? ' 👑' : ''}`).join('\n') + '\n```'
    : '*아직 참가자가 없습니다.*';

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setDescription(
      '# ⚫ 오목\n참가자를 기다리는 중입니다.\n' +
      `-# (${LOBBY_MS / 60_000}분 내 시작하지 않으면 자동 취소됩니다)`,
    )
    .addFields(
      { name: `👥 참가자  ${game.lobbyPlayers.length}명`, value: playerList },
      {
        name: '📋 규칙',
        value:
          '• 15×15 판에서 번갈아 돌을 놓아 가로·세로·대각선으로 **5개**를 먼저 이으면 승리합니다.\n' +
          '• 자기 차례에 **좌표를 채팅으로 입력**해 돌을 놓습니다. (예: `H8`, `8H`)\n' +
          '• 선공(⚫ 흑)이 먼저 둡니다. 봇과 대결하면 사람이 흑입니다.\n' +
          '• 한 수도 두지 않고 5분이 지나면 시간 초과로 종료됩니다.',
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
      new ButtonBuilder().setCustomId(`omok:join:${game.id}`).setLabel('✋ 참가').setStyle(ButtonStyle.Success)
        .setDisabled(game.lobbyPlayers.length >= 2),
      new ButtonBuilder().setCustomId(`omok:start:${game.id}`).setLabel('▶️ 게임 시작').setStyle(ButtonStyle.Primary)
        .setDisabled(game.lobbyPlayers.length < 2),
      new ButtonBuilder().setCustomId(`omok:bot_start:${game.id}`).setLabel('🤖 봇과 시작').setStyle(ButtonStyle.Secondary)
        .setDisabled(hasBot || game.lobbyPlayers.length !== 1),
      new ButtonBuilder().setCustomId(`omok:cancel:${game.id}`).setLabel('❌ 취소').setStyle(ButtonStyle.Danger),
    ),
  ];
}

// 로비 참가자 → 선공(B)/후공(W). 봇이 낀 판은 사람이 흑(선공) 고정(봇 AI가 'W' 기준).
function assignColors(game) {
  const bot = game.lobbyPlayers.find(p => p.id === 'BOT');
  if (bot) {
    const human = game.lobbyPlayers.find(p => p.id !== 'BOT');
    game.players = { B: human.id, W: 'BOT' };
    return;
  }
  const ps = game.lobbyPlayers.slice();
  if (Math.random() < 0.5) ps.reverse();
  game.players = { B: ps[0].id, W: ps[1].id };
}

// ── 게임 진행 ───────────────────────────────────────────────
function applyMove(game, games, x, y, color) {
  game.board[cellIdx(x, y)] = color;
  game.lastMove = { x, y };
  game.moveCount++;

  if (isWin(game.board, x, y, color)) {
    game.status = 'finished';
    game.winner = color;
    clearTimeout(game.timeoutId);
    games.delete(game.id);
    settleGameXp(game);
  } else if (isFull(game.board)) {
    game.status = 'finished';
    game.winner = 'DRAW';
    clearTimeout(game.timeoutId);
    games.delete(game.id);
  } else {
    game.turn = other(color);
  }
}

function resetTimeout(game, games) {
  clearTimeout(game.timeoutId);
  game.timeoutId = setTimeout(async () => {
    const g = games.get(game.id);
    if (!g || g.status !== 'playing') return;
    g.status = 'finished';
    g.winner = 'DRAW'; // 시간 초과는 무효 종료 — XP 정산 없음(틱택토와 동일)
    games.delete(g.id);
    await g.message.edit({
      content: '⏰ **시간 초과로 게임이 종료되었습니다.**',
      embeds: [buildEmbed(g)],
      files: [boardFile(g)],
      components: [buildFinishedRow(g.players.B, g.players.W)],
      attachments: [],
    }).catch(() => {});
  }, TURN_MS);
}

async function botTurn(game, games) {
  const blunder = Math.random() < BOT_BLUNDER_CHANCE;
  const mv = pickBotMove(game.board, 'W', blunder);
  applyMove(game, games, mv.x, mv.y, 'W');
  await game.message.edit(boardPayload(game)).catch(() => {});
  if (game.status !== 'finished') resetTimeout(game, games);
}

async function beginGame(interaction, game, games) {
  assignColors(game);
  clearTimeout(game.timeoutId);
  game.status = 'playing';
  game.turn = 'B';
  game.board = Array(225).fill('');
  game.lastMove = null;
  game.moveCount = 0;

  await interaction.update(boardPayload(game));
  game.message = await interaction.fetchReply();
  resetTimeout(game, games);
}

function newGame(interaction, id) {
  return {
    id,
    hostId: interaction.user.id,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    lobbyPlayers: [{ id: interaction.user.id, name: displayNameFromInteraction(interaction) }],
    board: Array(225).fill(''),
    players: null,
    turn: 'B',
    status: 'waiting',
    winner: null,
    lastMove: null,
    moveCount: 0,
    message: null,
    timeoutId: null,
  };
}

async function startOmokCommand(interaction) {
  const games = getGames(interaction.client);
  const gameId = interaction.id;
  const game = newGame(interaction, gameId);
  games.set(gameId, game);

  await interaction.reply({ embeds: [buildLobbyEmbed(game)], components: buildLobbyComponents(game) });
  game.message = await interaction.fetchReply();

  game.timeoutId = setTimeout(async () => {
    const g = games.get(gameId);
    if (!g || g.status !== 'waiting') return;
    games.delete(gameId);
    await interaction.editReply({ content: '⏰ **참가자가 없어 게임이 취소되었습니다.**', embeds: [], components: [] }).catch(() => {});
  }, LOBBY_MS);
}

// 재대결: 원래 게임은 끝나는 순간 지워지므로, customId에 담아둔 흑/백 유저로 새 대기 로비를 연다.
async function startRematch(interaction, prevBId, prevWId) {
  const games = getGames(interaction.client);
  const gameId = interaction.id;
  const isBot = prevWId === 'BOT';
  const prevIds = isBot ? [prevBId] : [prevBId, prevWId];

  if (!prevIds.includes(interaction.user.id)) {
    await interaction.reply({ content: '⚠️ **원래 참가자만 재대결할 수 있습니다.**', flags: MessageFlags.Ephemeral });
    return;
  }
  for (const g of games.values()) {
    if (g.sourceMessageId === interaction.message.id) {
      await interaction.reply({ content: '⚠️ **이미 재대결 신청이 진행 중입니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
  }

  const invitedId = isBot ? null : prevIds.find(id => id !== interaction.user.id);
  const game = newGame(interaction, gameId);
  game.sourceMessageId = interaction.message.id;
  games.set(gameId, game);

  await interaction.update({ components: [] });
  const content = invitedId
    ? `🔄 <@${invitedId}>님, <@${interaction.user.id}>님이 재대결을 신청했습니다! 참가하려면 **✋ 참가**를 누르세요.`
    : undefined;
  game.message = await interaction.channel.send({
    content,
    embeds: [buildLobbyEmbed(game)],
    components: buildLobbyComponents(game),
  });

  game.timeoutId = setTimeout(async () => {
    const g = games.get(gameId);
    if (!g || g.status !== 'waiting') return;
    games.delete(gameId);
    await g.message.edit({ content: '⏰ **재대결 신청이 만료되었습니다.**', embeds: [], components: [] }).catch(() => {});
  }, LOBBY_MS);
}

async function handleOmokButton(interaction) {
  const { customId } = interaction;
  const games = getGames(interaction.client);

  if (customId.startsWith('omok:join:')) {
    const game = games.get(customId.slice('omok:join:'.length));
    if (!game || game.status !== 'waiting') return interaction.reply({ content: '⚠️ **참가할 수 없는 게임입니다.**', flags: MessageFlags.Ephemeral });
    if (game.lobbyPlayers.some(p => p.id === interaction.user.id)) return interaction.reply({ content: '⚠️ **이미 참가 중입니다.**', flags: MessageFlags.Ephemeral });
    if (game.lobbyPlayers.length >= 2) return interaction.reply({ content: '⚠️ **정원(2명)이 이미 찼습니다.**', flags: MessageFlags.Ephemeral });
    game.lobbyPlayers.push({ id: interaction.user.id, name: displayNameFromInteraction(interaction) });
    return interaction.update({ embeds: [buildLobbyEmbed(game)], components: buildLobbyComponents(game) });
  }

  if (customId.startsWith('omok:start:')) {
    const game = games.get(customId.slice('omok:start:'.length));
    if (!game || game.status !== 'waiting') return interaction.reply({ content: '⚠️ **게임을 시작할 수 없습니다.**', flags: MessageFlags.Ephemeral });
    if (interaction.user.id !== game.hostId) return interaction.reply({ content: '⚠️ **방장만 게임을 시작할 수 있습니다.**', flags: MessageFlags.Ephemeral });
    if (game.lobbyPlayers.length < 2) return interaction.reply({ content: '⚠️ **최소 2명이 필요합니다.**', flags: MessageFlags.Ephemeral });
    return beginGame(interaction, game, games);
  }

  if (customId.startsWith('omok:bot_start:')) {
    const game = games.get(customId.slice('omok:bot_start:'.length));
    if (!game || game.status !== 'waiting') return interaction.reply({ content: '⚠️ **게임을 시작할 수 없습니다.**', flags: MessageFlags.Ephemeral });
    if (interaction.user.id !== game.hostId) return interaction.reply({ content: '⚠️ **방장만 사용할 수 있습니다.**', flags: MessageFlags.Ephemeral });
    if (game.lobbyPlayers.some(p => p.id === 'BOT')) return interaction.reply({ content: '⚠️ **봇은 이미 참가 중입니다.**', flags: MessageFlags.Ephemeral });
    if (game.lobbyPlayers.length !== 1) return interaction.reply({ content: '⚠️ **참가자가 1명일 때만 봇과 시작할 수 있습니다.**', flags: MessageFlags.Ephemeral });
    game.lobbyPlayers.push({ id: 'BOT', name: '봇' });
    return beginGame(interaction, game, games);
  }

  if (customId.startsWith('omok:cancel:')) {
    const game = games.get(customId.slice('omok:cancel:'.length));
    if (!game) return interaction.reply({ content: '⚠️ **게임을 찾을 수 없습니다.**', flags: MessageFlags.Ephemeral });
    if (interaction.user.id !== game.hostId) return interaction.reply({ content: '⚠️ **방장만 취소할 수 있습니다.**', flags: MessageFlags.Ephemeral });
    clearTimeout(game.timeoutId);
    games.delete(game.id);
    return interaction.update({ content: '❌ **게임이 취소되었습니다.**', embeds: [], components: [] });
  }

  if (customId.startsWith('omok:rematch:')) {
    const [, , bId, wId] = customId.split(':');
    return startRematch(interaction, bId, wId);
  }

  if (customId.startsWith('omok:close:')) {
    const [, , bId, wId] = customId.split(':');
    if (interaction.user.id !== bId && interaction.user.id !== wId) {
      return interaction.reply({ content: '⚠️ **원래 참가자만 종료할 수 있습니다.**', flags: MessageFlags.Ephemeral });
    }
    return interaction.update({ components: [] });
  }
}

// ── 채팅 좌표 입력 ─────────────────────────────────────────────
async function handleOmokMessage(message) {
  if (message.author.bot) return;
  const games = getGames(message.client);

  for (const game of games.values()) {
    if (game.status !== 'playing' || game.channelId !== message.channelId) continue;

    const currentId = game.players[game.turn];
    if (currentId === 'BOT' || currentId !== message.author.id) continue;

    const coord = parseCoord(message.content);
    if (!coord) return; // 좌표가 아닌 잡담 — 무시(제한 시간은 그대로 흐른다)

    if (game.board[cellIdx(coord.x, coord.y)] !== '') {
      const warn = await message.reply('⚠️ 이미 돌이 있는 자리입니다. 다른 좌표를 입력하세요.').catch(() => null);
      if (warn) setTimeout(() => warn.delete().catch(() => {}), 4000);
      return;
    }

    clearTimeout(game.timeoutId);
    applyMove(game, games, coord.x, coord.y, game.turn);
    await react(message, '✅');
    await game.message.edit(boardPayload(game)).catch(() => {});

    if (game.status === 'finished') return;
    if (game.players[game.turn] === 'BOT') await botTurn(game, games);
    else resetTimeout(game, games);
    return;
  }
}

module.exports = { startOmokCommand, handleOmokButton, handleOmokMessage };

// 룰렛그림.js — 룰렛머신(슬롯머신) 그림. 레이드와 같은 순수 JS 그림판(handlers/레이드/그림판.js)으로 그린다.
//
// 서버 부담을 줄이는 설계(CPU 25% / RAM 256MB):
//  - 기계 틀·화면 같은 변하지 않는 배경은 처음 한 번만 그려 버퍼로 보관하고, 그림마다 복사만 한다.
//  - Painter(버퍼 약 0.4MB)는 하나만 만들어 계속 쓴다. 그리기 + PNG 변환이 한 함수 안에서 끝나는(동기) 구조라
//    여러 명이 동시에 돌려도 서로 섞이지 않는다.
//  - 그림 한 장은 서버 기준 몇 ms. 결과물(PNG)은 보내고 나면 바로 버린다(캐시는 대기 화면 한 장뿐).
//  - 글자는 레이드 그림과 같은 폰트를 쓰므로 폰트 메모리가 늘지 않는다(loadFont 캐시).

const path = require('path');
const { Painter, loadFont } = require('../레이드/그림판');

const W = 640;
const H = 320;
const SCALE = 0.8; // 설계 크기 640×320 → 실제 512×256 (디스코드가 채팅 폭으로 줄여 보여 주므로 글자 크기는 그대로)
const FONT_PATH = path.join(__dirname, '..', '..', 'assets', 'fonts', 'NanumGothic-Bold.ttf');

// 화면 배치(설계 좌표)
const WIN_W = 140;
const WIN_H = 140;
const WIN_Y = 88;
const WIN_X = [66, 220, 374];

let font = null;
let painter = null;
let bg = null; // 배경 버퍼(RGB)
let idle = null; // 대기 화면 PNG 캐시

function getFont() {
  if (!font) font = loadFont(FONT_PATH);
  return font;
}
function getPainter() {
  if (!painter) painter = new Painter(W, H, SCALE);
  return painter;
}

// ── 심볼 그리기(중심 cx, cy 기준 약 ±50) ────────────────────────
function cherry(p, cx, cy) {
  p.line(cx - 12, cy + 22, cx + 8, cy - 38, 5, '#3a7d2c');
  p.line(cx + 20, cy + 26, cx + 8, cy - 38, 5, '#3a7d2c');
  p.poly([cx + 8, cy - 38, cx + 40, cy - 54, cx + 32, cy - 30], '#4caf3d');
  p.circle(cx - 14, cy + 26, 25, '#d81f35');
  p.circle(cx + 22, cy + 30, 25, '#d81f35');
  p.circle(cx - 23, cy + 17, 6, '#ff8a96');
  p.circle(cx + 13, cy + 21, 6, '#ff8a96');
}
function lemon(p, cx, cy) {
  const ell = (rx, ry) => {
    const pts = [];
    for (let k = 0; k < 28; k++) { const t = (k / 28) * Math.PI * 2; pts.push(cx + Math.cos(t) * rx, cy + Math.sin(t) * ry); }
    return pts;
  };
  p.poly(ell(50, 36), '#d9a820');
  p.poly([cx - 56, cy + 2, cx - 44, cy - 8, cx - 44, cy + 10], '#d9a820');
  p.poly([cx + 56, cy + 2, cx + 44, cy - 8, cx + 44, cy + 10], '#d9a820');
  p.poly(ell(46, 32), '#f7d12c');
  p.poly(ell(20, 8).map((v, i) => (i % 2 ? v - 14 : v - 10)), '#fff2a6');
  p.poly([cx + 6, cy - 34, cx + 34, cy - 50, cx + 28, cy - 28], '#4caf3d');
}
function grapes(p, cx, cy) {
  p.line(cx, cy - 22, cx, cy - 46, 6, '#6b4a2a');
  p.poly([cx + 2, cy - 40, cx + 34, cy - 54, cx + 26, cy - 32], '#4caf3d');
  const spots = [[-28, -6], [0, -6], [28, -6], [-14, 18], [14, 18], [0, 42]];
  for (const [dx, dy] of spots) {
    p.circle(cx + dx, cy + dy, 16, '#7d3fb8');
    p.circle(cx + dx - 5, cy + dy - 5, 4.5, '#c8a0f0');
  }
}
function bell(p, cx, cy) {
  const pts = [cx - 52, cy + 34, cx - 40, cy + 24, cx - 35, cy - 4];
  for (let k = 0; k <= 12; k++) { const t = Math.PI - (k / 12) * Math.PI; pts.push(cx + Math.cos(t) * 35, cy - 4 - Math.sin(t) * 35); }
  pts.push(cx + 40, cy + 24, cx + 52, cy + 34);
  p.poly(pts, '#f5b82e');
  p.poly([cx - 26, cy - 8, cx - 18, cy - 24, cx - 12, cy - 22, cx - 18, cy + 10], '#ffe08a');
  p.circle(cx, cy - 44, 7, '#c98a10');
  p.circle(cx, cy + 40, 9, '#c98a10');
}
function diamond(p, cx, cy) {
  p.poly([cx - 24, cy - 30, cx + 24, cy - 30, cx + 46, cy - 6, cx, cy + 46, cx - 46, cy - 6], '#47d4ff');
  p.poly([cx - 24, cy - 30, cx, cy - 6, cx - 46, cy - 6], '#8ae8ff');
  p.poly([cx + 24, cy - 30, cx + 46, cy - 6, cx, cy - 6], '#2fb3e0');
  p.poly([cx - 46, cy - 6, cx, cy - 6, cx, cy + 46], '#2aa6d6');
  p.poly([cx + 46, cy - 6, cx, cy + 46, cx, cy - 6], '#1d8fc0');
  p.poly([cx - 24, cy - 30, cx + 24, cy - 30, cx, cy - 6], '#b5f2ff');
}
function seven(p, cx, cy) {
  const f = getFont();
  p.text(f, '7', cx + 4, cy + 8, { size: 132, color: '#6e0e1c' });
  p.text(f, '7', cx, cy + 3, { size: 132, color: '#ff3347' });
}
const SYMBOL_DRAW = { '🍒': cherry, '🍋': lemon, '🍇': grapes, '🔔': bell, '💎': diamond, '7️⃣': seven };

// ── 고정 배경(기계 틀) ─────────────────────────────────────────
function drawStaticBg(p) {
  const f = getFont();
  p.clear('#150d26');
  // 몸체 + 금색 테두리
  p.roundRect(20, 14, 560, 292, 28, '#a81e2c');
  p.strokeRoundRect(20, 14, 560, 292, 28, 6, '#f5c542');
  // 위쪽 간판
  p.roundRect(170, 22, 260, 40, 20, '#f5c542');
  p.text(f, '룰렛머신', 300, 42, { size: 24, color: '#7a1020' });
  // 릴 판
  p.roundRect(40, 76, 500, 166, 18, '#2b0f1f');
  for (const x of WIN_X) {
    p.roundRect(x - 4, WIN_Y - 4, WIN_W + 8, WIN_H + 8, 14, '#d9b24c');
    p.roundRect(x, WIN_Y, WIN_W, WIN_H, 10, '#fff6dc');
  }
  // 당첨선 화살표
  p.poly([44, 148, 62, 158, 44, 168], '#ff3347');
  p.poly([536, 148, 518, 158, 536, 168], '#ff3347');
  // 아래 표시판
  p.roundRect(40, 250, 500, 42, 12, '#150a14');
  // 레버 받침
  p.circle(596, 222, 12, '#7a7f8c');
  p.roundRect(584, 222, 24, 28, 6, '#5a5f6c');
}

function getBg() {
  if (!bg) {
    const p = getPainter();
    drawStaticBg(p);
    bg = Buffer.from(p.buf); // 복사해서 보관
  }
  return bg;
}

// ── 변하는 부분 ────────────────────────────────────────────────
function drawSpinningWindow(p, x, phase) {
  // 돌아가는 릴: 가로 줄무늬가 위아래로 흘러가는 것처럼 보이게(프레임마다 위치가 달라진다)
  const colors = ['#e8d49a', '#f0e0b0', '#dcc283'];
  for (let k = 0; k < 6; k++) {
    const y = WIN_Y + 8 + ((k * 26 + phase * 11) % (WIN_H - 20));
    p.roundRect(x + 10, y, WIN_W - 20, 10, 5, colors[k % 3]);
  }
  p.text(getFont(), '?', x + WIN_W / 2, WIN_Y + WIN_H / 2, { size: 70, color: '#d1b36a' });
}

/**
 * 슬롯머신 그림(PNG 버퍼)을 만든다.
 * @param {object} o
 * @param {Array<string|null>} o.reels  릴 3개의 심볼(이모지 키). null 이면 아직 돌아가는 중.
 * @param {number} [o.bet]              베팅 XP(아래 표시판 왼쪽)
 * @param {string} [o.right]            아래 표시판 오른쪽 글자(결과 금액 등)
 * @param {string} [o.rightColor]
 * @param {string} [o.badge]            금액 왼쪽에 붙는 배율 배지 글자(예: '×1.2') — 금액과 색이 달라 한눈에 구분된다
 * @param {string} [o.badgeColor]       배지 바탕색
 * @param {number[]} [o.winIdx]         당첨 릴 번호(초록/금색 테두리)
 * @param {boolean} [o.jackpot]
 * @param {number} [o.phase]            돌아가는 연출 프레임 번호(0~)
 */
function renderSlot({ reels = [null, null, null], bet, right = '', rightColor = '#ffe9a8', badge = '', badgeColor = '#ffd23f', winIdx = [], jackpot = false, phase = 0 } = {}) {
  const p = getPainter();
  getBg().copy(p.buf);
  const f = getFont();

  // 간판 양옆 전구(프레임마다 번갈아 켜진다)
  for (let k = 0; k < 6; k++) {
    const lit = (k + phase) % 2 === 0;
    p.circle(60 + k * 18, 42, 6, lit ? '#ffe45c' : '#7a5a20');
    p.circle(540 - k * 18, 42, 6, lit ? '#ffe45c' : '#7a5a20');
  }

  // 레버: 돌리는 중이면 아래로 당겨진 모양
  const pulled = reels.some(r => r === null);
  const topY = pulled ? 196 : 130;
  p.line(596, 222, 596, topY + 14, 9, '#b8bcc6');
  p.circle(596, topY, 16, '#e0243a');
  p.circle(590, topY - 5, 5, '#ff8a96');

  // 릴
  for (let i = 0; i < 3; i++) {
    const x = WIN_X[i];
    if (reels[i] === null) { drawSpinningWindow(p, x, phase + i * 2); continue; }
    const draw = SYMBOL_DRAW[reels[i]];
    if (draw) draw(p, x + WIN_W / 2, WIN_Y + WIN_H / 2);
  }

  // 당첨 릴 테두리
  for (const i of winIdx) {
    p.strokeRoundRect(WIN_X[i] - 2, WIN_Y - 2, WIN_W + 4, WIN_H + 4, 12, 6, jackpot ? '#ffd700' : '#37d67a');
  }

  // 아래 표시판
  if (bet != null) p.text(f, `베팅 ${bet} XP`, 58, 271, { size: 22, color: '#ffe9a8', align: 'left' });
  let rightX = 522;
  if (right) {
    p.text(f, right, rightX, 271, { size: 24, color: rightColor, align: 'right' });
    rightX -= p.textWidth(f, right, 24) + 14;
  }
  if (badge) {
    // 배율 배지: 금색 알약 + 어두운 글자
    const w = p.textWidth(f, badge, 22) + 22;
    p.roundRect(rightX - w, 258, w, 26, 13, badgeColor);
    p.text(f, badge, rightX - w / 2, 271, { size: 22, color: '#3a1a00' });
  }

  return p.png();
}

// 대기(로비) 화면: 한 번만 그려 보관한다 — 로비를 열 때마다 새로 그리지 않는다.
function idleImage() {
  if (!idle) idle = renderSlot({ reels: ['7️⃣', '7️⃣', '7️⃣'], right: '베팅을 골라 주세요', rightColor: '#c9b8a0' });
  return idle;
}

// 봇 시작 후 한 번 불러 두면 첫 판이 느리지 않다(배경·글자 캐시 준비).
function warmUp() { getBg(); idleImage(); }

module.exports = { renderSlot, idleImage, warmUp };

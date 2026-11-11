// 룰렛그림.js — 룰렛머신(슬롯머신) 그림. 레이드와 같은 순수 JS 그림판(handlers/레이드/그림판.js)으로 그린다.
//
// 서버 부담을 줄이는 설계(CPU 25% / RAM 256MB):
//  - 기계 틀·화면 같은 변하지 않는 배경은 처음 한 번만 그려 버퍼로 보관하고, 그림마다 복사만 한다.
//  - Painter(버퍼 약 0.4MB)는 하나만 만들어 계속 쓴다. 그리기 + PNG 변환이 한 함수 안에서 끝나는(동기) 구조라
//    여러 명이 동시에 돌려도 서로 섞이지 않는다.
//  - 그림 한 장은 서버 기준 몇 ms. 결과물(PNG)은 보내고 나면 바로 버린다(캐시는 대기 화면 한 장뿐).
//  - 글자는 레이드 그림과 같은 폰트를 쓰므로 폰트 메모리가 늘지 않는다(loadFont 캐시).
//
// 모양 규칙: 기계는 좌우·상하 대칭(위 판 / 릴 판 / 아래 판), 심볼은 모두 "진한 테두리 → 바탕 → 음영 → 빛 반사" 순서로
// 그리고, 칸 안에서 위아래·좌우 가운데에 오도록 측정한 보정값(SYMBOL_OFFSET)을 쓴다.

const path = require('path');
const { Painter, loadFont } = require('../레이드/그림판');

const W = 600;
const H = 256;
const SCALE = 0.8; // 설계 크기 600×256 → 실제 480×205 (디스코드가 채팅 폭으로 줄여 보여 주므로 글자 크기는 그대로)
const FONT_PATH = path.join(__dirname, '..', '..', 'assets', 'fonts', 'NanumGothic-Bold.ttf');

// 화면 배치(설계 좌표). 가운데(x=300, y=128) 기준 상하좌우 대칭.
const WIN_W = 140;
const WIN_H = 124;
const WIN_Y = 66;
const WIN_X = [76, 230, 384]; // 140폭 3칸 + 간격 14
const WIN_CY = WIN_Y + WIN_H / 2;
const TOP_PLATE_Y = 16;       // 위 판(브랜드) 16~50
const BOTTOM_PLATE_Y = 206;   // 아래 판(베팅·결과) 206~240
const PLATE_H = 34;

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

// ── 그리기 도우미 ───────────────────────────────────────────────
const mirror = (cx, pts) => { // x 를 cx 기준으로 뒤집은 점 목록(좌우 대칭 도형용)
  const out = [];
  for (let k = 0; k < pts.length; k += 2) out.push(2 * cx - pts[k], pts[k + 1]);
  return out;
};
const scalePts = (pts, cx, cy, k) => pts.map((v, i) => (i % 2 ? cy + (v - cy) * k : cx + (v - cx) * k));
// 윤곽선(어두운 바깥) → 음영 → 바탕 → 빛 반사 순으로 그리는 공
function ball(p, x, y, r, { outline, base, shade, light }) {
  p.circle(x, y, r + 1.6, outline);
  p.circle(x, y, r, shade);
  p.circle(x - 2, y - 3, r - 4, base);
  p.circle(x - r * 0.38, y - r * 0.42, r * 0.28, light);
}
// 잎 한 장: (x, y)에서 deg 방향(도, 화면 좌표 기준 — 330이면 오른쪽 위)으로 뻗는 끝이 뾰족한 잎.
// bend 가 음수면 잎 끝이 위로, 양수면 아래로 살짝 휜다. 윤곽 → 바탕 → 한쪽 밝은 면 → 잎맥 순으로 그린다.
function leafShape(x, y, deg, len, wid, bend, grow = 0) {
  const a = (deg * Math.PI) / 180;
  const dx = Math.cos(a), dy = Math.sin(a);
  const nx = -dy, ny = dx;
  const center = [], upper = [], lower = [];
  for (let k = 0; k <= 12; k++) {
    const t = k / 12;
    const half = Math.sin(Math.PI * Math.pow(t, 0.9)) * (wid / 2 + grow);
    const off = bend * Math.sin(Math.PI * t);
    const cx = x + dx * len * t + nx * off - dx * grow;
    const cy = y + dy * len * t + ny * off - dy * grow;
    center.push(cx, cy);
    upper.push(cx + nx * half, cy + ny * half);
    lower.push(cx - nx * half, cy - ny * half);
  }
  const rev = [];
  for (let k = lower.length - 2; k >= 0; k -= 2) rev.push(lower[k], lower[k + 1]);
  const centerRev = [];
  for (let k = center.length - 2; k >= 0; k -= 2) centerRev.push(center[k], center[k + 1]);
  return { outline: [...upper, ...rev], upper, center, centerRev };
}
function leaf(p, x, y, deg, len = 36, wid = 17, bend = -5) {
  p.poly(leafShape(x, y, deg, len, wid, bend, 1.6).outline, '#2d6a24');
  const base = leafShape(x, y, deg, len, wid, bend);
  p.poly(base.outline, '#47ad3a');
  p.poly([...base.upper, ...base.centerRev], '#74cf5c');                    // 위쪽 밝은 면
  for (let k = 0; k < base.center.length - 2; k += 2) {                      // 잎맥(휜 가운데선)
    p.line(base.center[k], base.center[k + 1], base.center[k + 2], base.center[k + 3], 1.8, '#2f7d28');
  }
}
// 살짝 휘어진 줄기: 시작점 → 끝점(control 은 휘는 정도를 정하는 기준점)
function curvedStem(p, a, b, ctrl, width, color) {
  let prev = a;
  for (let k = 1; k <= 8; k++) {
    const t = k / 8, u = 1 - t;
    const pt = [u * u * a[0] + 2 * u * t * ctrl[0] + t * t * b[0], u * u * a[1] + 2 * u * t * ctrl[1] + t * t * b[1]];
    p.line(prev[0], prev[1], pt[0], pt[1], width, color);
    prev = pt;
  }
}

// ── 심볼(중심 cx, cy 기준 약 ±55) ───────────────────────────────
function cherry(p, cx, cy) {
  // 두 알에서 가는 줄기가 위로 모여 V 모양(좌우 대칭). 줄기는 가늘게, 알은 크게.
  const top = [cx + 2, cy - 36];
  for (const sx of [-1, 1]) {
    const from = [cx + sx * 25, cy + 12];
    curvedStem(p, from, top, [cx + sx * 16, cy - 20], 6, '#3d2a14');
    curvedStem(p, from, top, [cx + sx * 16, cy - 20], 3, '#6aa84a');
  }
  p.circle(top[0], top[1], 4, '#3d2a14');
  p.circle(top[0], top[1], 2.2, '#6aa84a');
  for (const sx of [-1, 1]) {
    ball(p, cx + sx * 25, cy + 28, 23, { outline: '#a01a2e', base: '#ee3248', shade: '#c81c34', light: '#ffc8ce' });
  }
}

function grapes(p, cx, cy) {
  // 짧은 줄기
  p.line(cx, cy - 30, cx, cy - 46, 8, '#5a4220');
  p.line(cx, cy - 30, cx, cy - 46, 4.5, '#8a6a38');
  // 알 6개(3-2-1): 크고 서로 살짝만 겹쳐 알 하나하나가 또렷하다. 아래 줄부터 그린다.
  const rows = [
    [[0, 44]],
    [[-17, 15], [17, 15]],
    [[-34, -14], [0, -14], [34, -14]],
  ];
  for (const row of rows) {
    for (const [dx, dy] of row) {
      ball(p, cx + dx, cy + dy, 17.5, { outline: '#5a2d90', base: '#9657d6', shade: '#6a34a4', light: '#e2c8f8' });
    }
  }
}

function lemon(p, cx, cy) {
  // 약간 기울어진 타원(-26도) + 양 끝의 둥근 꼭지. 아래쪽 음영과 위쪽 빛 반사로 입체감을 준다.
  const ang = -0.45, ca = Math.cos(ang), sa = Math.sin(ang);
  const rot = (x, y) => [cx + x * ca - y * sa, cy + x * sa + y * ca];
  const ell = (rx, ry, ox = 0, oy = 0) => {
    const pts = [];
    for (let k = 0; k < 32; k++) { const t = (k / 32) * Math.PI * 2; pts.push(...rot(ox + Math.cos(t) * rx, oy + Math.sin(t) * ry)); }
    return pts;
  };
  const nub = (x, r, color) => { const [nx, ny] = rot(x, 0); p.circle(nx, ny, r, color); };
  p.poly(ell(44.5, 34.5), '#d9b01c');
  nub(-46, 7.5, '#d9b01c'); nub(46, 7.5, '#d9b01c');
  p.poly(ell(42, 32), '#e0ac18');
  p.poly(ell(40, 28, 0, -3), '#f7d12c');
  nub(-46, 5, '#eab920'); nub(46, 5, '#eab920');
  p.poly(ell(20, 6, -8, -14), '#fff2a6');
}

function bell(p, cx, cy) {
  // 왼쪽 절반 윤곽을 만들고 좌우로 뒤집어 완전한 대칭 종 모양을 만든다.
  const left = [cx, cy - 40];
  for (let k = 1; k <= 12; k++) { const t = (k / 12) * (Math.PI / 2); left.push(cx - Math.sin(t) * 36, cy - 4 - Math.cos(t) * 36); }
  left.push(cx - 38, cy + 16, cx - 52, cy + 34);
  const rightPts = mirror(cx, left);
  const rightRev = [];
  for (let k = rightPts.length - 2; k >= 2; k -= 2) rightRev.push(rightPts[k], rightPts[k + 1]);
  const body = [...left, ...rightRev];
  p.poly(scalePts(body, cx, cy, 1.05), '#b07a10');           // 테두리
  p.poly(body, '#f5b82e');                                   // 바탕
  p.poly([cx + 8, cy - 32, cx + 30, cy - 12, cx + 38, cy + 16, cx + 52, cy + 34, cx + 24, cy + 34, cx + 22, cy + 8], '#dc9a1c'); // 오른쪽 음영
  p.poly([cx - 28, cy - 12, cx - 20, cy - 28, cx - 13, cy - 26, cx - 19, cy + 12], '#ffe9a0');  // 왼쪽 빛 반사
  p.roundRect(cx - 54, cy + 28, 108, 12, 6, '#b07a10');      // 아랫단 테두리
  p.roundRect(cx - 52, cy + 30, 104, 9, 4, '#e0a020');        // 아랫단
  ball(p, cx, cy + 47, 7, { outline: '#b07a10', base: '#e0a020', shade: '#b87a10', light: '#ffe08a' }); // 추
  ball(p, cx, cy - 46, 6, { outline: '#b07a10', base: '#e0a020', shade: '#b87a10', light: '#ffe08a' }); // 꼭지 고리
}

function sparkle(p, x, y, r, color) { // 네 갈래 반짝이(좌우 대칭)
  p.poly([x, y - r, x + r * 0.28, y - r * 0.28, x + r, y, x + r * 0.28, y + r * 0.28, x, y + r, x - r * 0.28, y + r * 0.28, x - r, y, x - r * 0.28, y - r * 0.28], color);
}
function diamond(p, cx, cy) {
  const outer = [cx - 26, cy - 30, cx + 26, cy - 30, cx + 48, cy - 6, cx, cy + 46, cx - 48, cy - 6];
  p.poly(scalePts(outer, cx, cy + 4, 1.05), '#2a86b0');        // 테두리
  p.poly(outer, '#47d4ff');
  p.poly([cx - 26, cy - 30, cx, cy - 6, cx - 48, cy - 6], '#8ae8ff');
  p.poly([cx + 26, cy - 30, cx + 48, cy - 6, cx, cy - 6], '#2fb3e0');
  p.poly([cx - 48, cy - 6, cx, cy - 6, cx, cy + 46], '#2aa6d6');
  p.poly([cx + 48, cy - 6, cx, cy + 46, cx, cy - 6], '#1d8fc0');
  p.poly([cx - 26, cy - 30, cx + 26, cy - 30, cx, cy - 6], '#b5f2ff');
  sparkle(p, cx - 58, cy - 26, 9, '#ffffff');
  sparkle(p, cx + 58, cy - 26, 9, '#ffffff');
}

function seven(p, cx, cy) {
  const f = getFont();
  const size = 118;
  // 테두리: 8방향으로 어두운 글자를 겹쳐 둘러싼다 → 아래 음영 → 밝은 윗면 → 본 글자
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    p.text(f, '7', cx + Math.cos(a) * 3, cy + 3 + Math.sin(a) * 3, { size, color: '#7a1020' });
  }
  p.text(f, '7', cx, cy + 6, { size, color: '#8f1226' });
  p.text(f, '7', cx - 1.5, cy + 2, { size, color: '#ff7686' });
  p.text(f, '7', cx, cy + 3.5, { size, color: '#ff3347' });
}
const SYMBOL_DRAW = { '🍒': cherry, '🍋': lemon, '🍇': grapes, '🔔': bell, '💎': diamond, '7️⃣': seven };
const SYMBOLS = Object.keys(SYMBOL_DRAW);

// 칸(높이 124) 안에 위아래 여유(약 12px)가 생기도록 심볼마다 크기를 줄여 그린다. 1 = 원래 크기.
const SYMBOL_SCALE = { '🍒': 0.95, '🍋': 1.05, '🍇': 0.86, '🔔': 0.88, '💎': 1.0, '7️⃣': 0.95 };

// (cx, cy)를 기준으로 모든 좌표·반지름·굵기·글자 크기를 k배로 줄여 그리는 그림판 대리자.
function scaled(p, cx, cy, k) {
  const X = x => cx + (x - cx) * k;
  const Y = y => cy + (y - cy) * k;
  return {
    circle: (x, y, r, c) => p.circle(X(x), Y(y), r * k, c),
    poly: (pts, c) => p.poly(pts.map((v, i) => (i % 2 ? Y(v) : X(v))), c),
    line: (x1, y1, x2, y2, w, c) => p.line(X(x1), Y(y1), X(x2), Y(y2), w * k, c),
    roundRect: (x, y, w, h, r, c) => p.roundRect(X(x), Y(y), w * k, h * k, r * k, c),
    text: (f, str, x, y, o = {}) => p.text(f, str, X(x), Y(y), { ...o, size: (o.size || 16) * k }),
  };
}
function drawSymbol(p, key, cx, cy, extra = 1) {
  const draw = SYMBOL_DRAW[key];
  if (!draw) return;
  draw(scaled(p, cx, cy, (SYMBOL_SCALE[key] ?? 1) * extra), cx, cy);
}

// 칸 안에서 위아래·좌우 가운데에 오도록 측정해 둔 보정값(설계 좌표). 값은 symbolBounds()로 다시 잴 수 있다.
const SYMBOL_OFFSET = {
  '🍒': [0, -6.5],
  '🍋': [0, 0],
  '🍇': [0, -5.5],
  '🔔': [0, -0.5],
  '💎': [0, -8],
  '7️⃣': [0, -1.5],
};

// ── 고정 배경(기계 틀) ─────────────────────────────────────────
function drawStaticBg(p) {
  const f = getFont();
  p.clear('#150d26');
  // 몸체 + 금색 테두리(상하좌우 대칭)
  p.roundRect(20, 8, 560, 240, 26, '#a81e2c');
  p.strokeRoundRect(20, 8, 560, 240, 26, 6, '#f5c542');
  // 위 판(브랜드) / 아래 판(베팅·결과): 같은 크기·모양
  p.roundRect(50, TOP_PLATE_Y, 500, PLATE_H, 12, '#150a14');
  p.roundRect(50, BOTTOM_PLATE_Y, 500, PLATE_H, 12, '#150a14');
  p.text(f, 'ARCADE  ROULETTE', 300, TOP_PLATE_Y + PLATE_H / 2, { size: 19, color: '#f5c542' });
  // 릴 판
  p.roundRect(50, 58, 500, 140, 16, '#2b0f1f');
  for (const x of WIN_X) {
    p.roundRect(x - 4, WIN_Y - 4, WIN_W + 8, WIN_H + 8, 14, '#d9b24c');
    p.roundRect(x, WIN_Y, WIN_W, WIN_H, 10, '#fff6dc');
  }
  // 당첨선 화살표(좌우 대칭)
  const tri = [54, WIN_CY - 10, 72, WIN_CY, 54, WIN_CY + 10];
  p.poly(tri, '#ff3347');
  p.poly(mirror(300, tri), '#ff3347');
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
function drawSpinningWindow(p, x, phase, reel) {
  // 도는 릴: 칸 크기 그대로 심볼이 바뀌며 흐려졌다 나타났다(페이드 아웃·인) 한다. 릴마다 박자가 어긋난다.
  const FADE = [0.5, 0.8, 0.5, 0.1]; // 프레임별 흐림 정도(0 = 또렷, 1 = 안 보임)
  const f = FADE[(phase + reel) % FADE.length];
  const key = SYMBOLS[(reel * 2 + phase * 5 + 1) % SYMBOLS.length];
  const [ox, oy] = SYMBOL_OFFSET[key] || [0, 0];
  drawSymbol(p, key, x + WIN_W / 2 + ox, WIN_CY + oy);
  // 칸 안쪽만 칸 바탕색(크림)과 섞어 흐리게 한다.
  const sc = p.s, bgc = [0xff, 0xf6, 0xdc];
  const x0 = Math.round(x * sc), x1 = Math.round((x + WIN_W) * sc);
  const y0 = Math.round(WIN_Y * sc), y1 = Math.round((WIN_Y + WIN_H) * sc);
  for (let yy = y0 + 2; yy < y1 - 2; yy++) {
    let i = (yy * p.w + x0 + 2) * 3;
    for (let xx = x0 + 2; xx < x1 - 2; xx++, i += 3) {
      for (let c = 0; c < 3; c++) p.buf[i + c] = Math.round(p.buf[i + c] * (1 - f) + bgc[c] * f);
    }
  }
}

// 전구: 위 판·아래 판 양옆에 같은 모양으로 그려 상하 대칭을 맞춘다(프레임마다 번갈아 켜진다).
function drawBulbs(p, phase) {
  for (const y of [TOP_PLATE_Y + PLATE_H / 2, BOTTOM_PLATE_Y + PLATE_H / 2]) {
    for (let k = 0; k < 2; k++) {
      const lit = (k + phase) % 2 === 0;
      const c = lit ? '#ffe45c' : '#7a5a20';
      p.circle(68 + k * 17, y, 5, c);
      p.circle(532 - k * 17, y, 5, c);
    }
  }
}

/**
 * 슬롯머신 그림(PNG 버퍼)을 만든다.
 * @param {object} o
 * @param {Array<string|null>} o.reels  릴 3개의 심볼(이모지 키). null 이면 아직 돌아가는 중.
 * @param {number} [o.bet]              베팅 XP(아래 판 왼쪽)
 * @param {string} [o.right]            아래 판 오른쪽 글자(결과 금액 등)
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
  drawBulbs(p, phase);

  for (let i = 0; i < 3; i++) {
    const x = WIN_X[i];
    if (reels[i] === null) { drawSpinningWindow(p, x, phase, i); continue; }
    const [ox, oy] = SYMBOL_OFFSET[reels[i]] || [0, 0];
    drawSymbol(p, reels[i], x + WIN_W / 2 + ox, WIN_CY + oy);
  }

  // 당첨 릴 테두리
  for (const i of winIdx) {
    p.strokeRoundRect(WIN_X[i] - 2, WIN_Y - 2, WIN_W + 4, WIN_H + 4, 12, 6, jackpot ? '#ffd700' : '#37d67a');
  }

  // 아래 판
  const py = BOTTOM_PLATE_Y + PLATE_H / 2 - 1;
  if (bet != null) p.text(f, `베팅 ${bet} XP`, 108, py, { size: 20, color: '#ffe9a8', align: 'left' });
  let rightX = 492;
  if (right) {
    p.text(f, right, rightX, py, { size: 22, color: rightColor, align: 'right' });
    rightX -= p.textWidth(f, right, 22) + 12;
  }
  if (badge) {
    const w = p.textWidth(f, badge, 20) + 20;
    p.roundRect(rightX - w, BOTTOM_PLATE_Y + 5, w, PLATE_H - 10, 12, badgeColor);
    p.text(f, badge, rightX - w / 2, py, { size: 20, color: '#3a1a00' });
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

// 도구용: 심볼 하나가 칸 가운데에서 얼마나 치우쳐 그려지는지 잰다(보정값 SYMBOL_OFFSET 을 구할 때 쓴다).
// 반환: 그림의 위/아래/왼/오른 끝(설계 좌표)과, 가운데에서 벗어난 정도(dx, dy).
function symbolBounds(key) {
  const p = getPainter();
  p.clear('#ffffff');
  const cx = 300, cy = 128;
  drawSymbol(p, key, cx, cy);
  let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
  const b = p.buf;
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      const i = (y * p.w + x) * 3;
      if (b[i] < 250 || b[i + 1] < 250 || b[i + 2] < 250) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const s = p.s;
  const box = { left: minX / s, right: (maxX + 1) / s, top: minY / s, bottom: (maxY + 1) / s };
  return { ...box, dx: (box.left + box.right) / 2 - cx, dy: (box.top + box.bottom) / 2 - cy };
}

module.exports = { renderSlot, idleImage, warmUp, symbolBounds, drawSymbol, SYMBOLS };

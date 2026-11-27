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

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
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
let hackBg = null; // 해킹 툴로 번복할 때 쓰는 해킹된 기계 배경 버퍼(RGB)
const emblems = new Map(); // 해골·역린 같은 그림 파일별 { 원본, 크기별 RGBA 캐시 }
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
function drawSpinningWindow(p, x, phase, reel, base = getBg(), only = null) {
  // 도는 릴: 릴 띠(심볼 여러 개가 세로로 이어진 것)를 그리고 세로로 길게 번지게(모션 블러) 해서 빠르게 돌아가는 느낌을 낸다.
  const sc = p.s;
  const gap = 104; // 심볼 사이 간격(설계 좌표)
  const shift = ((phase * 37 + reel * 53) % gap) - gap / 2;
  for (let k = -2; k <= 2; k++) {
    const key = only || SYMBOLS[(((phase * 2 + reel * 3 + k) % SYMBOLS.length) + SYMBOLS.length) % SYMBOLS.length]; // only: 블랙월은 7️⃣만 돈다
    const [ox, oy] = SYMBOL_OFFSET[key] || [0, 0];
    drawSymbol(p, key, x + WIN_W / 2 + ox, WIN_CY + oy + shift + k * gap);
  }
  // 칸 밖으로 삐져나온 부분은 고정 배경으로 되돌린다(칸 위·아래 + 칸 좌우 틀).
  const W2 = p.w;
  const x0 = Math.round(x * sc), x1 = Math.round((x + WIN_W) * sc);
  const y0 = Math.round(WIN_Y * sc), y1 = Math.round((WIN_Y + WIN_H) * sc);
  for (let yy = 0; yy < p.h; yy++) {
    for (let xx = x0 - Math.round(4 * sc); xx < x1 + Math.round(4 * sc); xx++) {
      if (xx >= x0 && xx < x1 && yy >= y0 && yy < y1) continue;
      const i = (yy * W2 + xx) * 3;
      p.buf[i] = base[i]; p.buf[i + 1] = base[i + 1]; p.buf[i + 2] = base[i + 2];
    }
  }
  // 칸 안쪽을 세로로 번지게: 열마다 앞뒤 R 픽셀 평균(윗·아랫 가장자리는 칸 안 픽셀만 사용).
  const R = Math.round(26 * sc), h = y1 - y0;
  const col = new Float32Array(h * 3);
  for (let xx = x0; xx < x1; xx++) {
    for (let r = 0; r < h; r++) { const i = ((y0 + r) * W2 + xx) * 3; col[r * 3] = p.buf[i]; col[r * 3 + 1] = p.buf[i + 1]; col[r * 3 + 2] = p.buf[i + 2]; }
    for (let r = 0; r < h; r++) {
      const a = Math.max(0, r - R), b = Math.min(h - 1, r + R), n = b - a + 1;
      let sr = 0, sg = 0, sb = 0;
      for (let q = a; q <= b; q++) { sr += col[q * 3]; sg += col[q * 3 + 1]; sb += col[q * 3 + 2]; }
      const i = ((y0 + r) * W2 + xx) * 3;
      p.buf[i] = sr / n; p.buf[i + 1] = sg / n; p.buf[i + 2] = sb / n;
    }
  }
}

// ── 해킹 모드(해킹 툴로 결과를 번복할 때) ─────────────────────────────
// 기계가 해킹당한 것처럼 보이게: 몸체를 보라·네온 시안으로 바꾼 배경(한 번만 그려 보관) +
// 위 판 양옆 해골(해킹 툴 이모지 그림) + 글리치 후처리(가로 줄 밀림·RGB 분리·스캔라인).
const HACK = {
  body: '#1d0b3a', border: '#3ee6ff', border2: '#b26bff', plate: '#07031a', reelBg: '#120726',
  window: '#efe6ff', frame: '#7c4dff', arrow: '#3ee6ff', brand: '#c9a8ff', win: '#3ee6ff',
};
const SKULL_FILE = path.join(__dirname, '..', '..', 'assets', '이모지', 'hacktool.png');

function drawHackBg(p) {
  const f = getFont();
  p.clear('#0a0418');
  p.roundRect(20, 8, 560, 240, 26, HACK.body);
  p.strokeRoundRect(20, 8, 560, 240, 26, 6, HACK.border);
  p.strokeRoundRect(28, 16, 544, 224, 20, 2, HACK.border2);
  p.roundRect(50, TOP_PLATE_Y, 500, PLATE_H, 12, HACK.plate);
  p.roundRect(50, BOTTOM_PLATE_Y, 500, PLATE_H, 12, HACK.plate);
  p.strokeRoundRect(50, TOP_PLATE_Y, 500, PLATE_H, 12, 2, HACK.border2);
  p.strokeRoundRect(50, BOTTOM_PLATE_Y, 500, PLATE_H, 12, 2, HACK.border2);
  p.text(f, 'SYSTEM  HACKED', 300, TOP_PLATE_Y + PLATE_H / 2, { size: 19, color: HACK.brand });
  p.roundRect(50, 58, 500, 140, 16, HACK.reelBg);
  for (const x of WIN_X) {
    p.roundRect(x - 4, WIN_Y - 4, WIN_W + 8, WIN_H + 8, 14, HACK.frame);
    p.roundRect(x, WIN_Y, WIN_W, WIN_H, 10, HACK.window);
  }
  const tri = [54, WIN_CY - 10, 72, WIN_CY, 54, WIN_CY + 10];
  p.poly(tri, HACK.arrow);
  p.poly(mirror(300, tri), HACK.arrow);
}

function getHackBg() {
  if (!hackBg) {
    const p = getPainter();
    drawHackBg(p);
    hackBg = Buffer.from(p.buf);
  }
  return hackBg;
}

// 8비트 RGBA/RGB PNG(인터레이스 없음)를 읽는다 — 해골 그림 하나만 쓰므로 필요한 만큼만 구현.
function decodePng(buf) {
  let off = 8, w = 0, h = 0, type = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), kind = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); type = data[9]; }
    else if (kind === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3, stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * 4);
  const cur = Buffer.alloc(stride), prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    raw.copy(cur, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = cur[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      out[o] = cur[x * bpp]; out[o + 1] = cur[x * bpp + 1]; out[o + 2] = cur[x * bpp + 2]; out[o + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    cur.copy(prev);
  }
  return { w, h, data: out };
}

// 해골 그림을 size(픽셀) 정사각형으로 줄여 둔다(상자 평균). 크기별로 한 번만 만든다.
function getSkull(size, file = SKULL_FILE) {
  let skull = emblems.get(file);
  if (!skull) {
    try { skull = { src: decodePng(fs.readFileSync(file)), sized: new Map() }; } catch { skull = { src: null, sized: new Map() }; }
    emblems.set(file, skull);
  }
  if (!skull.src) return null;
  if (!skull.sized.has(size)) {
    const { w, h, data } = skull.src, out = new Float32Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const sx0 = Math.floor(x * w / size), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * w / size));
        const sy0 = Math.floor(y * h / size), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * h / size));
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) {
          const i = (yy * w + xx) * 4, al = data[i + 3] / 255;
          r += data[i] * al; g += data[i + 1] * al; b += data[i + 2] * al; a += al; n++;
        }
        const o = (y * size + x) * 4;
        out[o] = a ? r / a : 0; out[o + 1] = a ? g / a : 0; out[o + 2] = a ? b / a : 0; out[o + 3] = a / n;
      }
    }
    skull.sized.set(size, out);
  }
  return skull.sized.get(size);
}

// 설계 좌표 (cx, cy) 가운데에 해골을 찍는다. size 는 설계 크기.
function drawSkull(p, cx, cy, size, file = SKULL_FILE) {
  const px = Math.round(size * p.s), img = getSkull(px, file);
  if (!img) return;
  const x0 = Math.round(cx * p.s - px / 2), y0 = Math.round(cy * p.s - px / 2);
  for (let y = 0; y < px; y++) {
    const yy = y0 + y;
    if (yy < 0 || yy >= p.h) continue;
    for (let x = 0; x < px; x++) {
      const xx = x0 + x, o = (y * px + x) * 4, a = img[o + 3];
      if (xx < 0 || xx >= p.w || a <= 0.01) continue;
      p.blend((yy * p.w + xx) * 3, [img[o], img[o + 1], img[o + 2]], a);
    }
  }
}

// 프레임마다 다르지만 같은 프레임이면 늘 같은 모양이 나오게 하는 난수(그림 비교·테스트가 흔들리지 않게)
function seeded(seed) {
  let t = seed >>> 0;
  return () => { t = (t + 0x6D2B79F5) >>> 0; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}

// 글리치 후처리: ① 몇 줄 띠를 좌우로 밀기(아래 판 글자는 읽히게 빼고) ② 빨강·파랑 채널을 좌우로 살짝 어긋나게 ③ 스캔라인.
function applyGlitch(p, phase, power = 1) {
  const rand = seeded(phase * 7919 + 17), W2 = p.w, H2 = p.h, buf = p.buf, rowBytes = W2 * 3;
  const limit = Math.round((BOTTOM_PLATE_Y - 4) * p.s);
  const row = Buffer.alloc(rowBytes);
  const bands = Math.round((4 + Math.floor(rand() * 3)) * power);
  for (let k = 0; k < bands; k++) {
    const y0 = Math.floor(rand() * (limit - 10)), hgt = 2 + Math.floor(rand() * 7);
    const dx = Math.round((rand() < 0.5 ? -1 : 1) * (3 + rand() * 9) * Math.min(power, 2));
    for (let y = y0; y < Math.min(limit, y0 + hgt); y++) {
      const start = y * rowBytes;
      buf.copy(row, 0, start, start + rowBytes);
      for (let x = 0; x < W2; x++) {
        const sx = Math.min(W2 - 1, Math.max(0, x - dx));
        buf[start + x * 3] = row[sx * 3]; buf[start + x * 3 + 1] = row[sx * 3 + 1]; buf[start + x * 3 + 2] = row[sx * 3 + 2];
      }
      // 밀린 띠는 살짝 시안·보라로 물들인다
      const tint = k % 2 ? [62, 230, 255] : [178, 107, 255];
      for (let x = 0; x < W2; x++) p.blend(start + x * 3, tint, 0.18);
    }
  }
  // RGB 분리: 빨강은 오른쪽, 파랑은 왼쪽으로 2px
  const sh = 2;
  for (let y = 0; y < H2; y++) {
    const start = y * rowBytes;
    buf.copy(row, 0, start, start + rowBytes);
    for (let x = 0; x < W2; x++) {
      buf[start + x * 3] = row[Math.max(0, x - sh) * 3];
      buf[start + x * 3 + 2] = row[Math.min(W2 - 1, x + sh) * 3 + 2];
    }
  }
  // 스캔라인: 세 줄에 한 줄씩 어둡게
  for (let y = 0; y < H2; y += 3) {
    const start = y * rowBytes;
    for (let i = start; i < start + rowBytes; i++) buf[i] = buf[i] * 0.78;
  }
}

// 해킹 모드 전구 자리: 위 판 양옆에 해골, 아래 판 양옆엔 깜빡이는 네온 점
function drawHackDecor(p, phase) {
  drawSkull(p, 76, TOP_PLATE_Y + PLATE_H / 2, 30);
  drawSkull(p, 524, TOP_PLATE_Y + PLATE_H / 2, 30);
  for (let k = 0; k < 2; k++) {
    const lit = (k + phase) % 2 === 0;
    const c = lit ? HACK.border : '#3b2a6b';
    const y = BOTTOM_PLATE_Y + PLATE_H / 2;
    p.circle(68 + k * 17, y, 5, c);
    p.circle(532 - k * 17, y, 5, c);
  }
}

// 칸 하나(틀 포함)를 k배로 어둡게 — 당첨 칸이 아닌 릴을 눌러 당첨 칸이 한눈에 보이게 한다.
function dimWindow(p, x, k) {
  const x0 = Math.round((x - 4) * p.s), x1 = Math.round((x + WIN_W + 4) * p.s);
  const y0 = Math.round((WIN_Y - 4) * p.s), y1 = Math.round((WIN_Y + WIN_H + 4) * p.s);
  for (let y = y0; y < y1; y++) for (let i = (y * p.w + x0) * 3, e = (y * p.w + x1) * 3; i < e; i++) p.buf[i] *= k;
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
 * @param {boolean} [o.hacked]         해킹 툴로 번복 중 — 해킹된 기계(보라·시안 + 해골 + 글리치)로 그린다
 */
function paintSlot({ reels = [null, null, null], bet, right = '', rightColor = '#ffe9a8', badge = '', badgeColor = '#ffd23f', winIdx = [], jackpot = false, phase = 0, hacked = false, wall = false, rerollIdx = null, rerolled = null } = {}) {
  const p = getPainter();
  const base = hacked && !wall ? getHackBg() : getBg();
  base.copy(p.buf);
  const f = getFont();
  if (wall) drawWallBg(p); else if (hacked) drawHackDecor(p, phase); else drawBulbs(p, phase);
  const spinBase = wall ? Buffer.from(p.buf) : base; // 블랙월은 도는 칸 둘레도 블랙월 바탕으로 되돌린다

  for (let i = 0; i < 3; i++) {
    const x = WIN_X[i];
    if (reels[i] === null) { drawSpinningWindow(p, x, phase, i, spinBase, wall ? '7️⃣' : null); continue; }
    const [ox, oy] = SYMBOL_OFFSET[reels[i]] || [0, 0];
    drawSymbol(p, reels[i], x + WIN_W / 2 + ox, WIN_CY + oy);
  }

  // 역린 사용: 다시 돌릴 칸만 보랏빛 테두리가 맥동하고(phase 마다 두께가 달라짐) 나머지 칸은 어둡게 눌러 둔다.
  if (rerollIdx != null) {
    for (let i = 0; i < 3; i++) if (i !== rerollIdx) dimWindow(p, WIN_X[i], 0.45);
    const rcx = WIN_X[rerollIdx] + WIN_W / 2; 
    dragonSparks(p, 41 + phase, 22, rcx, WIN_CY, 100, true); // 도는 동안은 은은하게 — 칸 둘레에서 반짝이는 불씨만 // 칸 둘레로 용의 불씨가 흩날린다
    const pulse = phase % 2 === 0 ? 0 : 3, x = WIN_X[rerollIdx];
    p.strokeRoundRect(x - 9 - pulse, WIN_Y - 9 - pulse, WIN_W + 18 + pulse * 2, WIN_H + 18 + pulse * 2, 19, 5, '#4a0c44');
    p.strokeRoundRect(x - 6, WIN_Y - 6, WIN_W + 12, WIN_H + 12, 16, 4, '#e8449e');
    p.strokeRoundRect(x - 2, WIN_Y - 2, WIN_W + 4, WIN_H + 4, 12, 3, '#ffc4e4');
  }

  // 당첨 릴 강조: 당첨 안 된 칸은 어둡게 눌러 대비를 키우고, 당첨 칸엔 굵고 밝은 테두리 + 바깥 빛 번짐.
  if (winIdx.length) {
    for (let i = 0; i < 3; i++) if (!winIdx.includes(i)) dimWindow(p, WIN_X[i], 0.42);
    const [glow, mid, line] = jackpot ? ['#7a5a00', '#d9a400', '#ffe14d'] : hacked && !wall ? ['#0f4a5c', '#2bb5d6', '#7ff3ff'] : ['#0f5a2a', '#25c25a', '#5dff8f'];
    for (const i of winIdx) {
      p.strokeRoundRect(WIN_X[i] - 6, WIN_Y - 6, WIN_W + 12, WIN_H + 12, 16, 6, glow);
      p.strokeRoundRect(WIN_X[i] - 4, WIN_Y - 4, WIN_W + 8, WIN_H + 8, 14, 5, mid);
      p.strokeRoundRect(WIN_X[i] - 1, WIN_Y - 1, WIN_W + 2, WIN_H + 2, 11, 5, line);
    }
  }

  // 역린으로 다시 돌린 릴(결과 화면): 용 속성 분홍 테두리 + 불씨 — 어느 칸을 다시 돌렸는지 한눈에 보인다
  if (rerolled != null) {
    const x = WIN_X[rerolled];
    p.strokeRoundRect(x - 12, WIN_Y - 12, WIN_W + 24, WIN_H + 24, 22, 1.6, '#0a0210'); // 어두운 외곽선
    p.strokeRoundRect(x - 11, WIN_Y - 11, WIN_W + 22, WIN_H + 22, 21, 5, '#8a1a64'); // 바깥 열기
    p.strokeRoundRect(x - 7, WIN_Y - 7, WIN_W + 14, WIN_H + 14, 17, 5, '#f04aa6'); // 굵은 본 테두리
    p.strokeRoundRect(x - 3, WIN_Y - 3, WIN_W + 6, WIN_H + 6, 13, 3, '#ffd0ea'); // 안쪽 밝은 선
    const rcx = x + WIN_W / 2; // 발동 연출의 '여운' 장면과 같은 빛줄기·고리·불씨를 심볼 위로 얇게 입힌다(심볼은 읽히게 코어는 없음)
    dragonField(p, { cx: rcx, cy: WIN_CY, R: 200, coreR: 0, power: 0.5, rot: 0.9, seed: 31, alphaK: 0.62, pal: DRG_PINK }); // 심볼 위로도 얇게 지나가는 빛줄기(과하지 않게)
    dragonRing(p, rcx, WIN_CY, 140, 0.8, 0.32, 0.45, null, DRG_PINK);
    dragonSparks(p, 71, 38, rcx, WIN_CY, 165);
  }

  // 아래 판
  const py = BOTTOM_PLATE_Y + PLATE_H / 2 - 1;
  if (bet != null) p.text(f, `베팅 : ${bet} XP`, 108, py, { size: 20, color: '#ffe9a8', align: 'left' });
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

  if (hacked && !wall) applyGlitch(p, phase);
  if (wall) { wallPlate(p, phase, 0); wallOverlay(p, phase + 3); applyGlitch(p, phase + 11, 0.3); } // 글리치는 조금만
  return p;
}

// 침식 합성: 평범한 룰렛(A)을 칸(8px) 단위로 블랙월(B, 지금 p.buf)로 바꾼다. 가장자리에서 가운데로 번지고(번지는 앞쪽 칸은 붉게 물듦), erosion 이 1이면 전부 블랙월.
function mixErosion(p, A, erosion, seed) {
  let st = (seed * 2654435761 + 7) >>> 0;
  const rnd = () => ((st = (st * 1103515245 + 12345) >>> 0) / 4294967296);
  const w = p.w, h = p.h, S = 6, b = p.buf;
  const cols = Math.ceil(w / S), rows = Math.ceil(h / S);
  const limit = erosion * 1.3 - 0.05;
  // 칸마다 블랙월(true)/평범(false): 가장자리에서 안쪽으로 들쭉날쭉하게 번진다
  const wallCell = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const bx = c * S, by = r * S;
    const edge = Math.min(bx, w - S - bx, by, h - S - by) / (Math.min(w, h) / 2);
    wallCell[r * cols + c] = edge + (rnd() - 0.5) * 0.3 < limit;
  }
  const isWall = (c, r) => c < 0 || r < 0 || c >= cols || r >= rows ? true : wallCell[r * cols + c];
  const put = (x, y, rr, gg, bb) => { if (x < 0 || y < 0 || x >= w || y >= h) return; const i = (y * w + x) * 3; b[i] = rr; b[i + 1] = gg; b[i + 2] = bb; };
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (wallCell[r * cols + c]) continue; // 블랙월 칸은 이미 그려져 있음
    for (let y = r * S; y < Math.min(h, r * S + S); y++) for (let x = c * S; x < Math.min(w, c * S + S); x++) {
      const i = (y * w + x) * 3; b[i] = A[i]; b[i + 1] = A[i + 1]; b[i + 2] = A[i + 2];
    }
  }
  // 번지는 앞쪽: 채운 사각형 대신 가는 붉은 세로선·가로 막대·테두리만 있는 사각형(회로/글리치 느낌)이 쌓인다
  const reds = [[255, 58, 74], [220, 34, 52], [150, 16, 30], [255, 110, 120]];
  const inWall = (x, y) => isWall(Math.floor(x / S), Math.floor(y / S));
  const nearFront = (x, y) => { const c = Math.floor(x / S), r = Math.floor(y / S); for (let d = -3; d <= 3; d++) for (let e = -3; e <= 3; e++) if (!isWall(c + d, r + e)) return true; return false; };
  const px = (x, y, c) => { if (inWall(x, y)) put(Math.floor(x), Math.floor(y), c[0], c[1], c[2]); };
  const rect = (x, y, rw, rh, c) => { for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) px(xx, yy, c); };
  const count = Math.floor(30 + erosion * 70);
  for (let n = 0, tries = 0; n < count && tries < count * 40; tries++) {
    const x = Math.floor(rnd() * w), y = Math.floor(rnd() * h);
    if (!inWall(x, y) || !nearFront(x, y)) continue;
    n++;
    const c = reds[Math.floor(rnd() * reds.length)], k = rnd();
    if (k < 0.4) rect(x, y, rnd() < 0.7 ? 1 : 2, 14 + Math.floor(rnd() * 56), c); // 세로선
    else if (k < 0.65) rect(x, y, 14 + Math.floor(rnd() * 46), rnd() < 0.7 ? 1 : 3, c); // 가로 막대
    else if (k < 0.9) { // 테두리만 있는 사각형
      const rw = 12 + Math.floor(rnd() * 30), rh = 8 + Math.floor(rnd() * 22);
      rect(x, y, rw, 1, c); rect(x, y + rh, rw, 1, c); rect(x, y, 1, rh, c); rect(x + rw, y, 1, rh + 1, c);
    } else rect(x, y, 3 + Math.floor(rnd() * 4), 3 + Math.floor(rnd() * 4), [90, 8, 20]); // 어두운 작은 조각
  }
}

// 룰렛 그림 한 장(PNG). wall 이고 erosion(0~1 미만)이 있으면 평범한 룰렛이 블랙월로 침식당하는 중간 모습.
function renderSlot(o = {}) {
  if (o.wall && o.erosion === 0) return paintSlot({ ...o, wall: false, hacked: false }).png(); // 잠식 0단계: 멀쩡한 평범한 룰렛
  if (o.wall && o.erosion != null && o.erosion < 1) {
    const normal = paintSlot({ ...o, wall: false, hacked: false });
    const A = Buffer.from(normal.buf);
    const p = paintSlot({ ...o, wall: true });
    mixErosion(p, A, o.erosion, (o.phase ?? 0) + 5);
    return p.png();
  }
  return paintSlot(o).png();
}

// 블랙월 게이트웨이 룰렛의 위 판: 'ARCADE ROULETTE' 대신 깨진 'BLACKWALL GATEWAY'
function wallPlate(p, seed = 0, level = 0) {
  const f = getFont();
  p.roundRect(53, TOP_PLATE_Y + 3, 494, PLATE_H - 6, 10, '#0a0204');
  drawBrokenPlate(p, f, TOP_PLATE_Y, [{ text: 'BLACKWALL GATEWAY', x: 300, align: 'center', size: 19, color: '#ff3a4a' }], level, 31 + seed * 7);
}
// ── 블랙월 룰렛 바탕·오염(??? 화면과 같은 느낌) ──
// 바탕: 새까만 공허 + 얇은 붉은 테두리 + 어두운 릴 창(심볼은 원래 색 그대로). 판 글자 자리는 검은 판 + 붉은 테두리.
function drawWallBg(p) {
  p.clear('#0d0406');
  p.strokeRoundRect(4, 4, W - 8, H - 8, 16, 2.5, '#9a1c28');
  p.strokeRoundRect(12, 12, W - 24, H - 24, 12, 1, '#4a0f16');
  for (const y of [TOP_PLATE_Y, BOTTOM_PLATE_Y]) {
    p.roundRect(50, y, 500, PLATE_H, 8, '#080203');
    p.strokeRoundRect(50, y, 500, PLATE_H, 8, 1.5, '#8a1424');
  }
  for (let i = 0; i < 3; i++) {
    p.roundRect(WIN_X[i], WIN_Y, WIN_W, WIN_H, 10, '#1a0a0d');
    p.strokeRoundRect(WIN_X[i], WIN_Y, WIN_W, WIN_H, 10, 1.5, '#ff3a4a');
  }
}
// 오염: 네 모서리 블록(붉은·어두운·빠진 칸·회로 막대) + 테두리를 따라 흐르는 붉은 줄기 + 드문 붉은 점. seed 로 모양이 정해진다.
function wallOverlay(p, seed = 0) {
  let st = (seed * 2654435761 + 12345) >>> 0;
  const rnd = () => ((st = (st * 1103515245 + 12345) >>> 0) / 4294967296);
  for (const [cx, cy, sx, sy] of [[0, 0, 1, 1], [W, 0, -1, 1], [0, H, 1, -1], [W, H, -1, -1]]) {
    for (let by = 0; by < 56; by += 6) for (let bx = 0; bx < 70; bx += 6) {
      const d = Math.hypot(bx / 70, by / 56);
      if (d > 1 || rnd() > (1 - d) ** 1.2) continue;
      const x = sx > 0 ? cx + bx : cx - bx - 6, y = sy > 0 ? cy + by : cy - by - 6, r = rnd();
      if (r < 0.5) p.rect(x, y, 6, 6, ['#96101e', '#5a0812', '#dc2234'][Math.floor(rnd() * 3)]);
      else if (r < 0.7) p.rect(x, y, 6, 6, '#060204');
      else if (r < 0.85) p.rect(x, y + 2, 6 * (1 + Math.floor(rnd() * 3)), 2, '#ff3c4c');
    }
    for (let i = 0; i < 3; i++) { const x = sx > 0 ? cx + 8 + rnd() * 30 : cx - 8 - rnd() * 30, len = 26 + rnd() * 46; p.rect(x, sy > 0 ? cy : cy - len, 1.5, len, '#ff2e40'); }
  }
  for (let i = 0; i < 14; i++) p.rect(rnd() * (W - 2), rnd() * (H - 2), 2, 2, rnd() < 0.5 ? '#c81e2d' : '#781420');
}

// ── 블랙월 물들이기(예전 방식 — 지금은 쓰지 않음) ──────────────────────
// 해킹된 기계 그림을 검정+붉은 단색으로 바꾸고, 주사선·붉은 세로 데이터 줄기·모서리 블록·가로 띠 어긋남을 얹는다. seed 로 모양이 정해진다(같은 장면은 같은 모양).
function tintBlackwall(p, seed = 0) {
  const b = p.buf;
  for (let i = 0; i < b.length; i += 3) {
    const r = b[i], g = b[i + 1], bl = b[i + 2];
    const lum = 0.3 * r + 0.59 * g + 0.11 * bl;
    const mx = Math.max(r, g, bl);
    b[i] = Math.min(255, Math.round(lum * 0.55 + mx * 0.7));
    b[i + 1] = Math.round(lum * 0.14);
    b[i + 2] = Math.round(lum * 0.18);
  }
  let st = (seed * 2654435761 + 12345) >>> 0;
  const rnd = () => ((st = (st * 1103515245 + 12345) >>> 0) / 4294967296);
  const W = p.w / p.s, H = p.h / p.s;
  for (let y = 0; y < H; y += 4) p.rect(0, y, W, 1, '#000000'); // 주사선
  for (let i = 0; i < 14; i++) { const x = rnd() * W, y = rnd() * H * 0.6, len = 30 + rnd() * H * 0.5; p.rect(x, y, 2, len, rnd() < 0.8 ? '#ff2a3c' : '#ffc8cc'); } // 세로 데이터 줄기
  for (const [cx, cy, sx, sy] of [[0, 0, 1, 1], [W, 0, -1, 1], [0, H, 1, -1], [W, H, -1, -1]]) { // 모서리 블록
    for (let k = 0; k < 9; k++) { const bx = rnd() * 46, by = rnd() * 36, bw = 6 + rnd() * 12; p.rect(sx > 0 ? cx + bx : cx - bx - bw, sy > 0 ? cy + by : cy - by - 6, bw, 6, ['#96101e', '#5a0812', '#dc2234', '#060204'][Math.floor(rnd() * 4)]); }
  }
}

// ── 해킹 침입 연출(해킹 툴을 쓰면 다시 돌리기 전에 짧게) ─────────────────────
// 1·2단계: 평범한 룰렛 기계가 점점 해킹된 기계 색으로 물들고, 위 판의 'ARCADE ROULETTE' 글자가 점점 더 깨진다(3단계에서 SYSTEM HACKED).
// 세 단계 모두 직전 꽝 결과(점점 어둡게) 위 정중앙에 해킹 툴 해골이 점점 크게 뜬다. 3단계는 완전히 해킹된 기계.
const INTRO_STEPS = [
  { mix: 0.15, brand: 'ARC4DE  RO#LET7E', brandColor: '#f5c542', broken: 1, skull: 70, dim: 0.7, power: 0.9 },
  { mix: 0.6, brand: 'A#C4D3  R0U#L37E', brandColor: '#e8b86a', broken: 2, skull: 112, dim: 0.45, power: 1.6 },
  { final: true, skull: 140, dim: 0.25, power: 1.0 },
];

// 글자 일부를 기호로 바꿔 깨뜨린다(단계가 높을수록 많이). 같은 seed 면 늘 같은 모양.
function corruptText(str, level, seed) {
  const rand = seeded(seed), glyphs = '#@%&$?/0';
  return [...str].map(ch => (ch !== ' ' && rand() < level * 0.14 ? glyphs[Math.floor(rand() * glyphs.length)] : ch)).join('');
}

// 판(위·아래) 한 줄의 깨진 글자: 빨강·시안 잔상이 좌우로 어긋나 겹치고, 판 안 가로 줄 몇 가닥이 잘려 밀리고, 노이즈 블록이 낀다.
// items: [{ text, x, align, size, color }]
function drawBrokenPlate(p, f, plateY, items, level, seed) {
  const rand = seeded(seed);
  const cy = plateY + PLATE_H / 2 - (plateY === BOTTOM_PLATE_Y ? 1 : 0);
  const off = 1 + level * 1.5;
  for (const it of items) {
    const o = { size: it.size, align: it.align };
    p.text(f, it.text, it.x - off, cy, { ...o, color: '#ff2d55' });
    p.text(f, it.text, it.x + off, cy, { ...o, color: '#3ee6ff' });
    p.text(f, it.text, it.x, cy, { ...o, color: it.color });
  }
  const x0 = Math.round(56 * p.s), x1 = Math.round(544 * p.s);
  const y0 = Math.round((plateY + 4) * p.s), y1 = Math.round((plateY + PLATE_H - 4) * p.s);
  const row = Buffer.alloc((x1 - x0) * 3);
  for (let k = 0; k < level * 2; k++) {
    const ys = y0 + Math.floor(rand() * (y1 - y0 - 2)), h = 1 + Math.floor(rand() * 3);
    const dx = Math.round((rand() < 0.5 ? -1 : 1) * (3 + rand() * 4) * level);
    for (let y = ys; y < Math.min(y1, ys + h); y++) {
      const base = (y * p.w + x0) * 3;
      p.buf.copy(row, 0, base, base + row.length);
      for (let x = 0; x < x1 - x0; x++) {
        const sx = Math.min(x1 - x0 - 1, Math.max(0, x - dx)) * 3;
        p.buf[base + x * 3] = row[sx]; p.buf[base + x * 3 + 1] = row[sx + 1]; p.buf[base + x * 3 + 2] = row[sx + 2];
      }
    }
  }
  const noise = ['#3ee6ff', '#b26bff', '#ff2d55', '#f5c542', '#ffffff'];
  for (let k = 0; k < 1 + level * 3; k++) {
    const w = 3 + Math.floor(rand() * 12), h = 2 + Math.floor(rand() * 4);
    p.rect(90 + rand() * 420, plateY + 6 + rand() * (PLATE_H - 14), w, h, noise[Math.floor(rand() * noise.length)]);
  }
}
const INTRO_STEP_COUNT = INTRO_STEPS.length;

// 두 배경 버퍼를 t 만큼 섞어 painter 버퍼에 넣는다(0 = 평범한 기계, 1 = 해킹된 기계)
function mixInto(p, a, b, t) {
  const buf = p.buf;
  for (let i = 0; i < buf.length; i++) buf[i] = a[i] + (b[i] - a[i]) * t;
}
const lerpHex = (h1, h2, t) => {
  const c = (h, k) => parseInt(h.slice(1 + k * 2, 3 + k * 2), 16);
  return '#' + [0, 1, 2].map(k => Math.round(c(h1, k) + (c(h2, k) - c(h1, k)) * t).toString(16).padStart(2, '0')).join('');
};

/**
 * 해킹 침입 연출 그림 한 장(PNG).
 * @param {object} o
 * @param {Array<string>} o.reels  직전 결과 릴(꽝)
 * @param {number} [o.bet]
 * @param {number} o.step          0 ~ INTRO_STEP_COUNT-1
 */
function renderHackIntro({ reels, bet, step = 0 }) {
  const st = INTRO_STEPS[Math.max(0, Math.min(INTRO_STEP_COUNT - 1, step))];
  const p = getPainter();
  const f = getFont();
  const final = !!st.final;
  if (final) {
    getHackBg().copy(p.buf);
    drawHackDecor(p, step);
  } else {
    mixInto(p, getBg(), getHackBg(), st.mix);
    // 위 판 글자를 깨진 글자로 다시 쓴다(판 안쪽만 덮어 테두리는 그대로)
    p.roundRect(53, TOP_PLATE_Y + 3, 494, PLATE_H - 6, 10, lerpHex('#150a14', '#07031a', st.mix));
    drawBrokenPlate(p, f, TOP_PLATE_Y, [{ text: st.brand, x: 300, align: 'center', size: 19, color: st.brandColor }], st.broken, 31 + step * 7);
    drawBulbs(p, step);
  }
  for (let i = 0; i < 3; i++) {
    if (reels?.[i]) {
      const [ox, oy] = SYMBOL_OFFSET[reels[i]] || [0, 0];
      drawSymbol(p, reels[i], WIN_X[i] + WIN_W / 2 + ox, WIN_CY + oy);
    }
    if (st.dim < 1) dimWindow(p, WIN_X[i], st.dim);
  }
  // 아래 판: 직전 꽝 결과(베팅·손실)가 단계마다 점점 깨진다(글자가 기호로 바뀌는 건 2단계부터)
  const lvl = step + 1;
  const bottom = [{ text: corruptText(`-${bet ?? 0} XP`, step, 71 + step), x: 492, align: 'right', size: 22, color: '#ff9a9a' }];
  if (bet != null) bottom.unshift({ text: corruptText(`베팅 : ${bet} XP`, step, 53 + step), x: 108, align: 'left', size: 20, color: '#ffe9a8' });
  drawBrokenPlate(p, f, BOTTOM_PLATE_Y, bottom, lvl, 97 + step * 11);
  drawSkull(p, 300, WIN_CY, st.skull); // 정중앙 해골이 단계마다 커진다(글리치에 같이 흔들린다)
  applyGlitch(p, 11 + step * 5, st.power);
  return p.png();
}

// ── 역린 발동 연출: 알바트리온 용 속성 도트 연출(레이드 '용의 숨결'과 같은 결) ───────────────────────────
// 레이드 연출과 같은 문법으로 그린다: 4px 도트 격자 · 순서 디더링(Bayer)으로 색 경계 · 부드러운 잡음(fbm) · 용 속성 램프(검보라 → 자홍 → 분홍 → 흰색).
// 고른 칸에 용의 기운이 모여 터지며, 원래 칸의 그림이 불타는 종이처럼 잡음 무늬를 따라 타들어 가 사라지고 그 자리에서 새 릴이 돌기 시작한다.
// 빛줄기와 불씨는 칸 밖(이웃한 릴·위아래 판)으로 번진다.
//  ① 응축 : 칸이 어두워지고 한가운데 용의 기운이 작게 맺힌다 · 도트 고리가 돈다
//  ② 격발 : 기운이 커지며 방사 빛줄기가 뻗고 칸의 그림이 가장자리부터 타들어 간다
//  ③ 폭발 : 빛줄기가 기계 전체로 번지고 충격 고리가 퍼지며 대부분 타 없어져 새 릴이 드러난다
//  ④ 여운 : 불씨와 가루가 흩날리고 칸은 용의 빛 테두리로 남는다 — 이어서 그 칸만 돈다
const REROLL_INTRO_COUNT = 4;
const REROLL_TEXT = ['역린 발동 중...', '역린 발동 중...', '역린 발동 중...', '역린 발동 중...']; // 그림 안 문구도 모두 같게
const DRG = ['#12041a', '#2a0c52', '#5a1a96', '#9a2ab4', '#d84aa8', '#f0a8e8', '#ffffff']; // 레이드 용 속성 램프에서 어두운 쪽을 보랏빛으로 비튼 것(검보라 → 보라 → 자홍 → 연분홍 → 흰색)
const DRG_LINE = '#0a0210';
const CELL = 4; // 도트 한 칸(설계 좌표). 레이드 연출의 AG 와 같은 크기
const BAY4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bay = (i, j) => (BAY4[(j & 3) * 4 + (i & 3)] + 0.5) / 16;
const DRG_PINK = ['#12041a', '#34093e', '#6c1258', '#b01a74', '#e8407e', '#ffa0d4', '#ffffff']; // 도는 화면·결과 화면용: 분홍 위주에 보랏빛을 살짝만
function dramp(v, i, j, pal = DRG) { const f = Math.max(0, Math.min(0.9999, v)) * (pal.length - 1), k = Math.floor(f); return pal[Math.min(pal.length - 1, k + (f - k > bay(i, j) ? 1 : 0))]; }
const hash2 = (x, y, k = 0) => { let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(k | 0, 1274126177)) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
function vnoise(x, y, k = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), u = (t) => t * t * (3 - 2 * t), fx = u(x - xi), fy = u(y - yi);
  const a = hash2(xi, yi, k), b = hash2(xi + 1, yi, k), c = hash2(xi, yi + 1, k), d = hash2(xi + 1, yi + 1, k);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
const fbm = (x, y, k = 0) => vnoise(x, y, k) * 0.5 + vnoise(x * 2.1, y * 2.1, k + 1) * 0.3 + vnoise(x * 4.3, y * 4.3, k + 2) * 0.2;
const hexA = (hex, a) => hex + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0');
// 설계 좌표 (x, y) 가 있는 도트 칸의 픽셀 범위로 원본 버퍼 src 의 색을 p.buf 로 복사한다
function copyCell(p, src, ci, cj) {
  const sc = p.s, x0 = Math.round(ci * CELL * sc), x1 = Math.round((ci + 1) * CELL * sc), y0 = Math.round(cj * CELL * sc), y1 = Math.round((cj + 1) * CELL * sc);
  for (let y = y0; y < Math.min(y1, p.h); y++) for (let x = x0; x < Math.min(x1, p.w); x++) { const i = (y * p.w + x) * 3; p.buf[i] = src[i]; p.buf[i + 1] = src[i + 1]; p.buf[i + 2] = src[i + 2]; }
}
function darkenCell(p, ci, cj, k) {
  const sc = p.s, x0 = Math.round(ci * CELL * sc), x1 = Math.round((ci + 1) * CELL * sc), y0 = Math.round(cj * CELL * sc), y1 = Math.round((cj + 1) * CELL * sc);
  for (let y = y0; y < Math.min(y1, p.h); y++) for (let x = x0; x < Math.min(x1, p.w); x++) { const i = (y * p.w + x) * 3; p.buf[i] *= k; p.buf[i + 1] *= k; p.buf[i + 2] *= k; }
}
const cell = (p, ci, cj, hex) => p.rect(ci * CELL, cj * CELL, CELL, CELL, hex);

const inSkip = (skip, px, py) => !!skip && (Array.isArray(skip) ? skip : [skip]).some(r => px > r.x0 && px < r.x1 && py > r.y0 && py < r.y1);
const winRect = (i, pad = 3) => ({ x0: WIN_X[i] - pad, x1: WIN_X[i] + WIN_W + pad, y0: WIN_Y - pad, y1: WIN_Y + WIN_H + pad });
// 칸 테두리 바깥으로 번지는 용의 열기: 칸에서 멀어질수록 램프가 식는다(디더링). 칸 둘레가 달아오른 듯 보인다.
function dragonHalo(p, rect, reach, strength = 1) {
  for (let cj = Math.floor((rect.y0 - reach) / CELL); cj < Math.ceil((rect.y1 + reach) / CELL); cj++) for (let ci = Math.floor((rect.x0 - reach) / CELL); ci < Math.ceil((rect.x1 + reach) / CELL); ci++) {
    const px = ci * CELL + CELL / 2, py = cj * CELL + CELL / 2;
    if (px < 26 || px > 574 || py < 14 || py > 242) continue;
    const dx = Math.max(rect.x0 - px, 0, px - rect.x1), dy = Math.max(rect.y0 - py, 0, py - rect.y1), dist = Math.hypot(dx, dy);
    if (dist <= 0.1 || dist > reach) continue; // 칸 안쪽은 건드리지 않는다
    const v = (1 - dist / reach) * strength;
    if (v < 0.22) continue;
    cell(p, ci, cj, hexA(dramp(0.5 + v * 0.5, ci, cj), 0.25 + v * 0.65));
  }
}
// 용의 기운 한 덩어리: 중심에 맺힌 빛(core) + 방사 빛줄기(ray) + 잡음을 4px 도트 격자에 용 램프(디더링)로 칠한다. skip 은 칠하지 않을 사각형(결과 화면에서 심볼을 가리지 않게).
function dragonField(p, { cx, cy, R, coreR, power = 1, rays = 13, rot = 0, seed = 11, skip = null, alphaK = 1, pal = DRG }) {
  const X0 = 26, X1 = 574, Y0 = 14, Y1 = 242;
  const fx0 = Math.max(X0, cx - R * 1.3), fx1 = Math.min(X1, cx + R * 1.3), fy0 = Math.max(Y0, cy - R), fy1 = Math.min(Y1, cy + R);
  for (let cj = Math.floor(fy0 / CELL); cj < Math.ceil(fy1 / CELL); cj++) for (let ci = Math.floor(fx0 / CELL); ci < Math.ceil(fx1 / CELL); ci++) {
    const px = ci * CELL + CELL / 2, py = cj * CELL + CELL / 2;
    if (inSkip(skip, px, py)) continue;
    const dx = px - cx, dy = (py - cy) / 0.8, dist = Math.hypot(dx, dy), d = dist / R, ang = Math.atan2(dy, dx);
    const core = coreR > 0 ? Math.pow(Math.max(0, 1 - dist / coreR), 1.4) : 0;
    const ray = Math.pow(Math.max(0, Math.cos(ang * rays / 2 + rot)), 7) * Math.pow(Math.max(0, 1 - d), 1.1) * power;
    const n = fbm(px / 10, py / 10, seed) * 0.34 * Math.max(0, 1 - d * 0.9);
    const v = core * 1.15 + ray * 0.95 + n - 0.1;
    if (v < 0.17) continue; // 어두운 램프 색은 이웃한 릴 위에서 칙칙한 얼룩이 되므로 밝은 부분만 칠한다
    cell(p, ci, cj, hexA(dramp(Math.max(v, 0.52), ci, cj, pal), Math.min(0.9, 0.3 + v * 0.7) * alphaK));
  }
}
// 도트로 이어진 충격 고리(타원). thick 은 두께(도트 칸 수), density 는 점이 찍힐 확률
function dragonRing(p, cx, cy, ringR, thick, density, alpha, skip = null, pal = DRG) {
  const X0 = 26, X1 = 574, Y0 = 14, Y1 = 242;
  for (let cj = Math.floor((cy - ringR) / CELL) - 1; cj < Math.ceil((cy + ringR) / CELL) + 1; cj++) for (let ci = Math.floor((cx - ringR * 1.25) / CELL) - 1; ci < Math.ceil((cx + ringR * 1.25) / CELL) + 1; ci++) {
    const px = ci * CELL + CELL / 2, py = cj * CELL + CELL / 2;
    if (px < X0 || px > X1 || py < Y0 || py > Y1) continue;
    if (inSkip(skip, px, py)) continue;
    const d = Math.hypot(px - cx, (py - cy) / 0.8);
    if (Math.abs(d - ringR) < CELL * thick && hash2(ci, cj, 3) < density) cell(p, ci, cj, hexA(dramp(0.72 + hash2(ci, cj, 4) * 0.3, ci, cj, pal), alpha));
  }
}

// 칸 둘레로 흩날리는 용의 불씨(분홍·흰 도트, 가끔 십자 반짝임). 같은 seed 면 같은 모양.
function dragonSparks(p, seed, count, cx, cy, spread, big = false) {
  const rnd = seeded(seed);
  for (let k = 0; k < count; k++) {
    const a = rnd() * Math.PI * 2, dd = (big ? 0.5 + rnd() * 0.55 : 0.45 + rnd() * 0.75) * spread, gx = Math.floor((cx + Math.cos(a) * dd * 1.15) / CELL), gy = Math.floor((cy + Math.sin(a) * dd * 0.75) / CELL);
    if (gx * CELL < 26 || gx * CELL > 574 || gy * CELL < 14 || gy * CELL > 242) continue;
    const bright = big ? rnd() < 0.65 : rnd() < 0.3, col = bright ? '#ffffff' : rnd() < 0.62 ? '#ff9ccf' : rnd() < 0.5 ? '#ee4a98' : '#c89cff';
    cell(p, gx, gy, col);
    if (bright || big) { const arm = bright ? '#ffb4dc' : '#e0408c'; cell(p, gx + 1, gy, arm); cell(p, gx - 1, gy, arm); cell(p, gx, gy + 1, arm); cell(p, gx, gy - 1, arm); }
    if (big && bright && rnd() < 0.4) { cell(p, gx + 2, gy, '#ffe6f4'); cell(p, gx - 2, gy, '#ffe6f4'); cell(p, gx, gy + 2, '#ffe6f4'); cell(p, gx, gy - 2, '#ffe6f4'); } // 큰 반짝임은 십자가 길다
  }
}

/**
 * 역린 발동 연출 그림 한 장(PNG).
 * @param {object} o
 * @param {Array<string>} o.reels  지금 결과 릴(심볼 3개)
 * @param {number} o.index         다시 돌릴 릴(0~2)
 * @param {number} [o.bet]
 * @param {number} o.step          0 ~ REROLL_INTRO_COUNT-1
 */
function renderRerollIntro({ reels, bet, index = 0, step = 0, hacked = false }) {
  const st = Math.max(0, Math.min(REROLL_INTRO_COUNT - 1, step));
  const p = getPainter(), f = getFont();
  const base = hacked ? getHackBg() : getBg(); // 해킹 툴을 먼저 썼으면 해킹된 기계 위에서 역린이 발동한다
  base.copy(p.buf);
  if (hacked) drawHackDecor(p, st); else drawBulbs(p, st);
  const x = WIN_X[index], cx = x + WIN_W / 2, cy = WIN_Y + WIN_H / 2;
  for (let i = 0; i < 3; i++) {
    if (reels?.[i]) { const [ox, oy] = SYMBOL_OFFSET[reels[i]] || [0, 0]; drawSymbol(p, reels[i], WIN_X[i] + WIN_W / 2 + ox, WIN_CY + oy); }
    if (i !== index) dimWindow(p, WIN_X[i], 0.5);
  }
  const old = Buffer.from(p.buf); // 타들어 가기 전 모습
  drawSpinningWindow(p, x, 3, index, base, null);
  const fresh = Buffer.from(p.buf); // 그 자리에서 돌고 있는 새 릴
  old.copy(p.buf);

  // 칸 안: 잡음 무늬를 따라 타들어 간다(진행도 prog 보다 잡음이 작은 곳부터 새 릴로 바뀜, 경계는 불타는 가장자리)
  const prog = [0, 0.3, 0.78, 1.05][st], dark = [0.55, 0.62, 1, 1][st];
  const c0 = Math.floor(x / CELL), c1 = Math.ceil((x + WIN_W) / CELL), r0 = Math.floor(WIN_Y / CELL), r1 = Math.ceil((WIN_Y + WIN_H) / CELL);
  const burn = [];
  for (let cj = r0; cj < r1; cj++) for (let ci = c0; ci < c1; ci++) {
    const px = ci * CELL + CELL / 2, py = cj * CELL + CELL / 2;
    if (px < x || px > x + WIN_W || py < WIN_Y || py > WIN_Y + WIN_H) continue;
    // 가장자리일수록 먼저 타들어 간다(잡음 + 중심에서의 거리)
    const d = Math.hypot((px - cx) / (WIN_W / 2), (py - cy) / (WIN_H / 2)), n = fbm(px / 9, py / 9, 5) * 0.75 + (1 - Math.min(1, d)) * 0.25;
    if (n < prog - 0.07) copyCell(p, fresh, ci, cj);
    else if (n < prog - 0.02) burn.push([ci, cj, 0.98]);
    else if (n < prog + 0.035) burn.push([ci, cj, 0.62 + (prog + 0.035 - n) * 6]);
    else if (dark < 1) darkenCell(p, ci, cj, dark);
  }
  for (const [ci, cj, v] of burn) cell(p, ci, cj, dramp(v, ci, cj));

  // 용의 기운: 한가운데 맺힌 빛 + 방사 빛줄기 + 잡음. 칸 밖으로도 번지되 기계 몸체 안쪽에서만.
  dragonField(p, { cx, cy, R: [78, 130, 250, 190][st], coreR: [30, 44, 66, 40][st], power: [0.25, 0.8, 1, 0.45][st], rot: st * 0.35, seed: 11 + st });
  // 충격 고리(도트로 이어진 고리) — 단계가 갈수록 멀리 퍼진다
  dragonRing(p, cx, cy, [38, 74, 150, 224][st], st === 2 ? 1.4 : 0.9, st === 3 ? 0.4 : 0.78, st === 3 ? 0.55 : 0.9);
  const X0 = 26, X1 = 574, Y0 = 14, Y1 = 242;
  // 불씨·가루: 분홍·흰 도트가 흩날린다(단계가 갈수록 멀리, 마지막엔 드문드문)
  const spread = [60, 100, 230, 250][st], count = [14, 24, 110, 70][st], rnd = seeded(47 + st * 5);
  for (let k = 0; k < count; k++) {
    const a = rnd() * Math.PI * 2, dd = (0.2 + rnd() * 0.8) * spread, gx = Math.floor((cx + Math.cos(a) * dd) / CELL), gy = Math.floor((cy + Math.sin(a) * dd * 0.8 - (st >= 2 ? rnd() * 26 : 0)) / CELL);
    const gxp = gx * CELL, gyp = gy * CELL;
    if (gxp < X0 || gxp > X1 || gyp < Y0 || gyp > Y1) continue;
    const bright = rnd() < 0.3, col = bright ? '#ffffff' : rnd() < 0.5 ? '#e0b0ff' : '#c04ae0';
    cell(p, gx, gy, col);
    if (bright && st >= 1) { cell(p, gx + 1, gy, '#e8b8ff'); cell(p, gx - 1, gy, '#e8b8ff'); cell(p, gx, gy + 1, '#e8b8ff'); cell(p, gx, gy - 1, '#e8b8ff'); } // 십자 반짝임
  }
  // 칸 테두리: 용의 빛(도트 램프)으로 — 단계가 갈수록 밝고 두껍다
  const rim = [['#12041a', '#2a0c52', '#5a1a96'], ['#2a0c52', '#7a2ac0', '#c04ae0'], ['#5a1a96', '#c04ae0', '#e8c0ff'], ['#2a0c52', '#7a2ac0', '#d8b0ff']][st];
  p.strokeRoundRect(x - 8, WIN_Y - 8, WIN_W + 16, WIN_H + 16, 18, 4, rim[0]);
  p.strokeRoundRect(x - 5, WIN_Y - 5, WIN_W + 10, WIN_H + 10, 15, 3, rim[1]);
  p.strokeRoundRect(x - 2, WIN_Y - 2, WIN_W + 4, WIN_H + 4, 12, 2, rim[2]);
  p.strokeRoundRect(x - 10, WIN_Y - 10, WIN_W + 20, WIN_H + 20, 20, 1.5, DRG_LINE); // 어두운 외곽선(도트 그림 느낌)
  const py = BOTTOM_PLATE_Y + PLATE_H / 2 - 1;
  if (st >= 2) p.roundRect(53, BOTTOM_PLATE_Y + 3, 494, PLATE_H - 6, 10, '#150a14', 0.7); // 빛줄기가 판 위로 번져도 글자가 읽히게
  if (bet != null) p.text(f, `베팅 : ${bet} XP`, 108, py, { size: 20, color: '#ffe9a8', align: 'left' });
  p.text(f, REROLL_TEXT[st], 492, py, { size: 22, color: ['#c8a0f0', '#e0b8ff', '#ffffff', '#e0b8ff'][st], align: 'right' });
  if (hacked) applyGlitch(p, st + 7);
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

module.exports = { renderSlot, renderHackIntro, renderRerollIntro, REROLL_INTRO_COUNT, INTRO_STEP_COUNT, idleImage, warmUp, symbolBounds, drawSymbol, SYMBOLS };

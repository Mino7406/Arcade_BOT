// 맵연출.js — 🗺️ 맵 뽑기 연출 프레임을 그린다. 맵 카드가 슬롯처럼 옆으로 흘러가다 당첨 맵에서 멈춘다.
// 재료: assets/맵/카드/<게임>/<키>.png · assets/맵/연출/배경_<게임>.png (scripts/맵연출이미지.py).
// 화면 가운데의 고정 테두리 안이 "지금 고른 칸"이고, 카드는 가운데에서 멀수록 어둡다. 뽑기가 끝나면 reelCache 를 비워 메모리를 돌려준다.
const fs = require('fs');
const path = require('path');
const { Painter } = require('../레이드/그림판');
const { decodePng } = require('../공통/이모지그림');

const ASSET = path.join(__dirname, '..', '..', 'assets', '맵');
const W = 960, H = 540, CW = 300, CH = 372, PITCH = 330; // 카드 폭 300 + 간격 30
const CX = (W - CW) / 2, CY = 124;
const ACCENT = { valorant: [253, 69, 86], overwatch: [250, 156, 30] };

const cache = new Map(); // 파일 → { w, h, data }
function load(file) {
  if (!cache.has(file)) {
    let img = null;
    try { img = decodePng(fs.readFileSync(file)); } catch { /* 없으면 null — 그 자리는 빈 배경 */ }
    cache.set(file, img);
  }
  return cache.get(file);
}
const clearReelCache = () => cache.clear();

// 이미지를 (x0, y0) 에 찍는다. bright(0~1)로 어둡게, 화면 밖은 자른다.
function blit(p, img, x0, y0, bright) {
  if (!img) return;
  const { w, h, data } = img;
  for (let y = 0; y < h; y++) {
    const yy = y0 + y;
    if (yy < 0 || yy >= p.h) continue;
    for (let x = 0; x < w; x++) {
      const xx = x0 + x;
      if (xx < 0 || xx >= p.w) continue;
      const o = (y * w + x) * 4, i = (yy * p.w + xx) * 3;
      p.buf[i] = data[o] * bright; p.buf[i + 1] = data[o + 1] * bright; p.buf[i + 2] = data[o + 2] * bright;
    }
  }
}

function frame(game, strip, offset) {
  const p = new Painter(W, H, 1);
  const bg = load(path.join(ASSET, '연출', `배경_${game}.png`));
  if (bg) blit(p, bg, 0, 0, 1); else p.clear('#0c0f16');
  const first = Math.floor(offset - 3), last = Math.ceil(offset + 3);
  for (let k = first; k <= last; k++) {
    const key = strip[k];
    if (!key) continue;
    const x = Math.round(CX + (k - offset) * PITCH);
    if (x >= W || x + CW <= 0) continue;
    const lit = Math.max(0, 1 - Math.abs(k - offset)); // 가운데에 가까울수록 1
    blit(p, load(path.join(ASSET, '카드', game, `${key}.png`)), x, CY, 0.55 + 0.45 * lit);
  }
  // 고정 테두리(굵은 선 + 바깥 빛 번짐)
  const acc = ACCENT[game] ?? ACCENT.overwatch, bx = Math.round(CX) - 4, by = CY - 4, bw = CW + 8, bh = CH + 8;
  const px = (x, y, a) => { if (x >= 0 && x < W && y >= 0 && y < H) p.blend((y * W + x) * 3, acc, a); };
  for (let d = 1; d <= 14; d++) {
    const a = 0.4 * (1 - d / 15) ** 2;
    for (let x = bx - d; x < bx + bw + d; x++) { px(x, by - d, a); px(x, by + bh + d - 1, a); }
    for (let y = by - d; y < by + bh + d; y++) { px(bx - d, y, a); px(bx + bw + d - 1, y, a); }
  }
  for (let t = 0; t < 5; t++) {
    for (let x = bx; x < bx + bw; x++) { px(x, by + t, 1); px(x, by + bh - 1 - t, 1); }
    for (let y = by; y < by + bh; y++) { px(bx + t, y, 1); px(bx + bw - 1 - t, y, 1); }
  }
  return p.png();
}

module.exports = { frame, clearReelCache };

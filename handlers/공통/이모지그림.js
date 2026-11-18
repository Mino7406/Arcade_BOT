// 이모지그림.js — assets/이모지/*.png (8비트 RGBA/RGB, 인터레이스 없음)를 레이드 그림판(Painter)에 찍는 작은 도구.
// 크기별로 한 번만 줄여(상자 평균) 보관한다. 읽기 실패하면 조용히 아무것도 안 그린다.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIR = path.join(__dirname, '..', '..', 'assets', '이모지');
const cache = new Map(); // file → { src, sized: Map }

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

function sizedIcon(file, size) {
  let e = cache.get(file);
  if (!e) {
    try { e = { src: decodePng(fs.readFileSync(path.join(DIR, file))), sized: new Map() }; } catch { e = { src: null, sized: new Map() }; }
    cache.set(file, e);
  }
  if (!e.src) return null;
  if (!e.sized.has(size)) {
    const { w, h, data } = e.src, out = new Float32Array(size * size * 4);
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
    e.sized.set(size, out);
  }
  return e.sized.get(size);
}

// 설계 좌표 (cx, cy) 가운데에 size(설계 크기) 정사각형으로 찍는다. p 는 Painter(p.s = 렌더 배율).
function drawEmojiFile(p, file, cx, cy, size) {
  const px = Math.round(size * p.s), img = sizedIcon(file, px);
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

module.exports = { drawEmojiFile };

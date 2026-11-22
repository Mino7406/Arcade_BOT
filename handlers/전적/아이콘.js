// 아이콘.js — 디스크의 PNG 아이콘을 읽어 원하는 크기로 줄이고(상자 평균), 그림판(Painter)에 찍는다. 작은 PNG 인코더도 있다.
// 그림판 쪽 규칙: 8비트 RGB/RGBA 비인터레이스 PNG 만 읽는다(handlers/공통/이모지그림.js 의 decodePng).
const fs = require('fs');
const zlib = require('zlib');
const { decodePng } = require('../공통/이모지그림');

const CACHE_LIMIT = 400; // 줄인 아이콘을 메모리에 둘 최대 개수(서버 RAM 256MB 보호)
const cache = new Map();

// ── PNG 만들기 ────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// 8비트 RGBA(w*h*4 바이트) → PNG
function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 비트 깊이
  ihdr[9] = 6; // RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ── 줄이기 ────────────────────────────────────────────────────
// RGBA 바이트 이미지를 outW×outH 로 줄인다. 결과는 [r(0~255), g, b, a(0~1)] 가 픽셀마다 이어진 Float32Array.
// 투명한 칸이 색을 번지게 하지 않도록 알파로 가중한다.
function boxResize(data, w, h, outW, outH) {
  const out = new Float32Array(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const sy0 = Math.floor(y * h / outH), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * h / outH));
    for (let x = 0; x < outW; x++) {
      const sx0 = Math.floor(x * w / outW), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * w / outW));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) {
        const i = (yy * w + xx) * 4, al = data[i + 3] / 255;
        r += data[i] * al; g += data[i + 1] * al; b += data[i + 2] * al; a += al; n++;
      }
      const o = (y * outW + x) * 4;
      out[o] = a ? r / a : 0; out[o + 1] = a ? g / a : 0; out[o + 2] = a ? b / a : 0; out[o + 3] = a / n;
    }
  }
  return out;
}

// 파일의 PNG 를 size×size 로 줄여 돌려준다. circle 이면 바깥을 투명하게 깎는다. 읽기 실패는 null.
function loadIcon(file, size, { circle = false } = {}) {
  const key = `${file}|${size}|${circle ? 1 : 0}`;
  if (cache.has(key)) return cache.get(key);
  let icon = null;
  try {
    const src = decodePng(fs.readFileSync(file));
    icon = boxResize(src.data, src.w, src.h, size, size);
    if (circle) {
      const r = size / 2;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const d = Math.hypot(x + 0.5 - r, y + 0.5 - r);
        icon[(y * size + x) * 4 + 3] *= Math.max(0, Math.min(1, r - d + 0.5));
      }
    }
  } catch {
    icon = null;
  }
  if (icon) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value); // 가장 오래된 것부터 버린다
    cache.set(key, icon);
  }
  return icon;
}

// 그림판에 (cx, cy) 가운데로 찍는다. icon 은 loadIcon 으로 만든 것이고 size 는 그 아이콘의 한 변(렌더 픽셀). null 이면 아무것도 안 그린다.
function drawIcon(p, icon, cx, cy, size) {
  if (!icon) return;
  const x0 = Math.round(cx * p.s - size / 2), y0 = Math.round(cy * p.s - size / 2);
  for (let y = 0; y < size; y++) {
    const yy = y0 + y;
    if (yy < 0 || yy >= p.h) continue;
    for (let x = 0; x < size; x++) {
      const xx = x0 + x, o = (y * size + x) * 4, a = icon[o + 3];
      if (xx < 0 || xx >= p.w || a <= 0.01) continue;
      p.blend((yy * p.w + xx) * 3, [icon[o], icon[o + 1], icon[o + 2]], a);
    }
  }
}

// 설계 좌표 크기(size)로 파일을 읽어 바로 찍는 편의 함수.
function drawIconFile(p, file, cx, cy, size, opts) {
  const px = Math.round(size * p.s);
  drawIcon(p, file ? loadIcon(file, px, opts) : null, cx, cy, px);
}

module.exports = { encodePng, boxResize, loadIcon, drawIcon, drawIconFile };

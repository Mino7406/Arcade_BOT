// 그림판.js — 네이티브 라이브러리 없이 RGB 버퍼에 직접 그리는 작은 그림 엔진(레이드 패널용).
//
// 왜 직접 만드나: @napi-rs/canvas는 리눅스 서버에서 불러오기만 해도 RSS가 +133MB(윈도우는 +21MB)
// 늘었고, resvg·pureimage는 그림마다 메모리가 쌓이거나 느렸다. 256MB 요금제에서는 버틸 수 없다.
// 여기서는 버퍼 하나(약 1.7MB)를 계속 재사용하고, 글자는 opentype.js 저메모리 모드로 필요한 글자만
// 읽어(폰트 상주 +4MB) 윤곽선을 직접 칠한다. 순수 JS라 리눅스와 윈도우의 메모리 사용량이 같다.
//
// 칠하기: 도형·글자를 모두 다각형(윤곽선 목록)으로 바꾼 뒤, 픽셀 한 줄을 4개의 보조 줄로 나눠
// 가로 구간 겹침 비율을 누적하는 방식으로 안티앨리어싱한다(non-zero 감기 규칙 — 글자 구멍도 처리).

const fs = require('fs');
const zlib = require('zlib');

const SUB = 4; // 픽셀 한 줄당 보조 줄 수(세로 안티앨리어싱 품질)

const colorCache = new Map();
function rgb(hex) {
  let c = colorCache.get(hex);
  if (!c) {
    c = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    colorCache.set(hex, c);
  }
  return c;
}

// ── 폰트 ───────────────────────────────────────────────────────
// lowMemory: 글자 모양을 전부 미리 읽지 않고 쓸 때 읽는다(전체 파싱이면 폰트 하나에 힙 +28MB).
function loadFont(filePath) {
  const opentype = require('opentype.js');
  const buf = fs.readFileSync(filePath);
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), { lowMemory: true });
}

// 이모지는 폰트에 없어 네모로 나오므로 빼고, 폰트에 없는 글자는 '?'로 바꾼다.
function cleanText(font, s) {
  const stripped = String(s).replace(/[\p{Extended_Pictographic}️‍]/gu, '').replace(/ {2,}/g, ' ').trim();
  let out = '';
  for (const ch of stripped) out += (ch === ' ' || font.charToGlyphIndex(ch) > 0) ? ch : '?';
  return out;
}

// ── PNG ────────────────────────────────────────────────────────
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

class Painter {
  constructor(width, height) {
    this.w = width;
    this.h = height;
    this.buf = Buffer.alloc(width * height * 3);
    this.cov = new Float32Array(width + 1); // 한 픽셀 줄의 덮인 비율 누적
    this.raw = Buffer.alloc((width * 3 + 1) * height); // PNG 스캔라인(필터 바이트 포함) 재사용
  }

  // 덮인 비율 a(0~1)만큼 색을 섞는다.
  blend(i, c, a) {
    const b = this.buf;
    if (a >= 0.999) { b[i] = c[0]; b[i + 1] = c[1]; b[i + 2] = c[2]; return; }
    b[i] += (c[0] - b[i]) * a;
    b[i + 1] += (c[1] - b[i + 1]) * a;
    b[i + 2] += (c[2] - b[i + 2]) * a;
  }

  clear(hex) { this.rect(0, 0, this.w, this.h, hex); }

  // 정수 픽셀 사각형(안티앨리어싱 없음 — 픽셀 아트·배경용).
  rect(x, y, w, h, hex) {
    const c = rgb(hex);
    const x0 = Math.max(0, Math.round(x)), x1 = Math.min(this.w, Math.round(x + w));
    const y0 = Math.max(0, Math.round(y)), y1 = Math.min(this.h, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) {
      let i = (yy * this.w + x0) * 3;
      for (let xx = x0; xx < x1; xx++, i += 3) { this.buf[i] = c[0]; this.buf[i + 1] = c[1]; this.buf[i + 2] = c[2]; }
    }
  }

  // contours: [[x,y, x,y, ...], ...] 닫힌 윤곽선들. non-zero 감기 규칙.
  fill(contours, hex, alpha = 1) {
    const c = rgb(hex);
    const edges = [];
    let minY = Infinity, maxY = -Infinity;
    for (const pts of contours) {
      const n = pts.length / 2;
      for (let k = 0; k < n; k++) {
        const x0 = pts[k * 2], y0 = pts[k * 2 + 1];
        const x1 = pts[((k + 1) % n) * 2], y1 = pts[((k + 1) % n) * 2 + 1];
        if (y0 === y1) continue;
        const dir = y1 > y0 ? 1 : -1;
        const top = dir > 0 ? [x0, y0, x1, y1] : [x1, y1, x0, y0];
        edges.push({ ya: top[1], yb: top[3], xa: top[0], slope: (top[2] - top[0]) / (top[3] - top[1]), dir });
        minY = Math.min(minY, top[1]); maxY = Math.max(maxY, top[3]);
      }
    }
    if (!edges.length) return;
    edges.sort((a, b) => a.ya - b.ya);
    const yStart = Math.max(0, Math.floor(minY)), yEnd = Math.min(this.h - 1, Math.ceil(maxY));
    const cov = this.cov;
    const xs = [];
    let active = [];
    let next = 0;
    for (let py = yStart; py <= yEnd; py++) {
      let lo = this.w, hi = -1;
      for (let s = 0; s < SUB; s++) {
        const sy = py + (s + 0.5) / SUB;
        while (next < edges.length && edges[next].ya <= sy) active.push(edges[next++]);
        active = active.filter(e => e.yb > sy);
        xs.length = 0;
        for (const e of active) xs.push([e.xa + (sy - e.ya) * e.slope, e.dir]);
        xs.sort((a, b) => a[0] - b[0]);
        // 왼쪽부터 감기 수를 세며, 0이 아닌 구간(=도형 안쪽)을 덮인 비율로 누적한다.
        let wind = 0, startX = 0;
        for (const [x, dir] of xs) {
          const before = wind;
          wind += dir;
          if (before === 0 && wind !== 0) { startX = x; continue; }
          if (before === 0 || wind !== 0) continue;
          const xa = Math.max(0, startX), xb = Math.min(this.w, x);
          if (xb <= xa) continue;
          const ia = Math.floor(xa), ib = Math.floor(xb), wgt = 1 / SUB;
          if (ia === ib) cov[ia] += (xb - xa) * wgt;
          else {
            cov[ia] += (ia + 1 - xa) * wgt;
            for (let q = ia + 1; q < ib; q++) cov[q] += wgt;
            if (ib < this.w) cov[ib] += (xb - ib) * wgt;
          }
          if (ia < lo) lo = ia;
          if (ib > hi) hi = Math.min(ib, this.w - 1);
        }
      }
      for (let px = lo; px <= hi; px++) {
        const a = cov[px];
        if (a > 0.001) this.blend((py * this.w + px) * 3, c, Math.min(1, a) * alpha);
        cov[px] = 0;
      }
    }
  }

  // ── 도형 → 윤곽선 ────────────────────────────────────────────
  static roundRectPts(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    const pts = [];
    const corner = (cx, cy, a0) => {
      for (let k = 0; k <= 6; k++) {
        const a = a0 + (k / 6) * (Math.PI / 2);
        pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
    };
    corner(x + w - r, y + r, -Math.PI / 2);
    corner(x + w - r, y + h - r, 0);
    corner(x + r, y + h - r, Math.PI / 2);
    corner(x + r, y + r, Math.PI);
    return pts;
  }
  static reversed(pts) {
    const out = [];
    for (let k = pts.length - 2; k >= 0; k -= 2) out.push(pts[k], pts[k + 1]);
    return out;
  }

  roundRect(x, y, w, h, r, hex, alpha = 1) { this.fill([Painter.roundRectPts(x, y, w, h, r)], hex, alpha); }

  // 테두리: 바깥 윤곽 + 거꾸로 감은 안쪽 윤곽(구멍).
  strokeRoundRect(x, y, w, h, r, lw, hex) {
    const outer = Painter.roundRectPts(x - lw / 2, y - lw / 2, w + lw, h + lw, r + lw / 2);
    const inner = Painter.reversed(Painter.roundRectPts(x + lw / 2, y + lw / 2, w - lw, h - lw, Math.max(0, r - lw / 2)));
    this.fill([outer, inner], hex);
  }

  circle(cx, cy, r, hex) {
    const pts = [];
    const n = Math.max(12, Math.ceil(r * 1.5));
    for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2; pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
    this.fill([pts], hex);
  }

  poly(pts, hex) { this.fill([pts], hex); }

  // 두께 있는 선(끝은 둥글게 처리하지 않고 반원 대신 사각 + 끝점 원).
  line(x1, y1, x2, y2, width, hex) {
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (width / 2), ny = (dx / len) * (width / 2);
    this.fill([[x1 + nx, y1 + ny, x2 + nx, y2 + ny, x2 - nx, y2 - ny, x1 - nx, y1 - ny]], hex);
    this.circle(x1, y1, width / 2, hex);
    this.circle(x2, y2, width / 2, hex);
  }

  // ── 글자 ─────────────────────────────────────────────────────
  textWidth(font, s, size) {
    return font.getAdvanceWidth(cleanText(font, s), size);
  }

  // y는 글자 줄의 세로 가운데. maxWidth를 넘으면 글자 크기를 줄여 맞춘다.
  text(font, s, x, y, { size = 16, color = '#ffffff', align = 'center', maxWidth } = {}) {
    const str = cleanText(font, s);
    if (!str) return;
    let w = font.getAdvanceWidth(str, size);
    if (maxWidth && w > maxWidth) { size = size * (maxWidth / w); w = maxWidth; }
    const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    const baseline = y + size * 0.36;
    const path = font.getPath(str, left, baseline, size);
    const contours = [];
    let cur = null, px = 0, py = 0;
    const steps = size > 30 ? 8 : 5;
    for (const cmd of path.commands) {
      if (cmd.type === 'M') { if (cur && cur.length > 4) contours.push(cur); cur = [cmd.x, cmd.y]; px = cmd.x; py = cmd.y; }
      else if (cmd.type === 'L') { cur.push(cmd.x, cmd.y); px = cmd.x; py = cmd.y; }
      else if (cmd.type === 'Q') {
        for (let k = 1; k <= steps; k++) {
          const t = k / steps, u = 1 - t;
          cur.push(u * u * px + 2 * u * t * cmd.x1 + t * t * cmd.x, u * u * py + 2 * u * t * cmd.y1 + t * t * cmd.y);
        }
        px = cmd.x; py = cmd.y;
      } else if (cmd.type === 'C') {
        for (let k = 1; k <= steps; k++) {
          const t = k / steps, u = 1 - t;
          cur.push(
            u * u * u * px + 3 * u * u * t * cmd.x1 + 3 * u * t * t * cmd.x2 + t * t * t * cmd.x,
            u * u * u * py + 3 * u * u * t * cmd.y1 + 3 * u * t * t * cmd.y2 + t * t * t * cmd.y,
          );
        }
        px = cmd.x; py = cmd.y;
      } else if (cmd.type === 'Z') { if (cur && cur.length > 4) contours.push(cur); cur = null; }
    }
    if (cur && cur.length > 4) contours.push(cur);
    this.fill(contours, color);
  }

  // RGB 버퍼 → PNG. 압축 레벨 3(단색 위주라 크기 차이는 작고 시간은 크게 준다).
  png() {
    const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // truecolor RGB
    const stride = this.w * 3;
    for (let y = 0; y < this.h; y++) {
      this.raw[y * (stride + 1)] = 0;
      this.buf.copy(this.raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
    }
    const idat = zlib.deflateSync(this.raw, { level: 3 });
    return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
  }
}

module.exports = { Painter, loadFont };

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

// ── 칠하기 핵심 ─────────────────────────────────────────────────
// 윤곽선들을 width×height 영역 안에서 훑어, 덮인 픽셀마다 emit(px, py, a)를 부른다(a: 0~1).
// 한 픽셀 줄을 SUB개의 보조 줄로 나눠 가로 구간 겹침을 누적한다. 구간 양 끝 픽셀만 소수 비율로 더하고
// 안쪽 꽉 찬 픽셀은 차분 배열(diff)에 +/-만 찍어 줄 끝에 누적합으로 한 번에 계산한다
// (보조 줄마다 안쪽 픽셀을 일일이 더하던 것보다 큰 도형에서 몇 배 빠르다).
const scratch = { cov: new Float32Array(0), diff: new Float32Array(0), ex: new Float64Array(0), ed: new Int8Array(0) };
function ensureScratch(width) {
  if (scratch.cov.length < width + 2) {
    scratch.cov = new Float32Array(width + 2);
    scratch.diff = new Float32Array(width + 2);
  }
}
function scan(contours, width, height, emit, scale = 1) {
  // 모서리 목록(위→아래 방향으로 정규화)
  const edges = [];
  let minY = Infinity, maxY = -Infinity;
  for (const pts of contours) {
    const n = pts.length / 2;
    for (let k = 0; k < n; k++) {
      const x0 = pts[k * 2] * scale, y0 = pts[k * 2 + 1] * scale;
      const k2 = (k + 1) % n;
      const x1 = pts[k2 * 2] * scale, y1 = pts[k2 * 2 + 1] * scale;
      if (y0 === y1) continue;
      if (y1 > y0) edges.push({ ya: y0, yb: y1, xa: x0, slope: (x1 - x0) / (y1 - y0), dir: 1 });
      else edges.push({ ya: y1, yb: y0, xa: x1, slope: (x0 - x1) / (y0 - y1), dir: -1 });
      if (y0 < minY) minY = y0; if (y1 < minY) minY = y1;
      if (y0 > maxY) maxY = y0; if (y1 > maxY) maxY = y1;
    }
  }
  if (!edges.length) return;
  edges.sort((a, b) => a.ya - b.ya);
  ensureScratch(width);
  const { cov, diff } = scratch;
  if (scratch.ex.length < edges.length) { scratch.ex = new Float64Array(edges.length); scratch.ed = new Int8Array(edges.length); }
  const ex = scratch.ex, ed = scratch.ed;
  const active = [];
  let next = 0;
  const wgt = 1 / SUB;
  const yStart = Math.max(0, Math.floor(minY)), yEnd = Math.min(height - 1, Math.ceil(maxY));
  for (let py = yStart; py <= yEnd; py++) {
    let lo = width, hi = -1;
    for (let sIdx = 0; sIdx < SUB; sIdx++) {
      const sy = py + (sIdx + 0.5) / SUB;
      while (next < edges.length && edges[next].ya <= sy) active.push(edges[next++]);
      // 끝난 모서리 제거 + 교차점 계산(할당 없이)
      let n = 0;
      for (let k = 0; k < active.length; k++) {
        const e = active[k];
        if (e.yb <= sy) continue;
        active[n] = e;
        ex[n] = e.xa + (sy - e.ya) * e.slope;
        ed[n] = e.dir;
        n++;
      }
      active.length = n;
      // 교차점 삽입 정렬(보통 몇 개라 이게 가장 빠르다)
      for (let a = 1; a < n; a++) {
        const xv = ex[a], dv = ed[a];
        let b = a - 1;
        while (b >= 0 && ex[b] > xv) { ex[b + 1] = ex[b]; ed[b + 1] = ed[b]; b--; }
        ex[b + 1] = xv; ed[b + 1] = dv;
      }
      // 왼쪽부터 감기 수를 세며, 0이 아닌 구간(=도형 안쪽)을 누적한다.
      let wind = 0, startX = 0;
      for (let k = 0; k < n; k++) {
        const before = wind;
        wind += ed[k];
        if (before === 0 && wind !== 0) { startX = ex[k]; continue; }
        if (before === 0 || wind !== 0) continue;
        const xa = startX < 0 ? 0 : startX, xb = ex[k] > width ? width : ex[k];
        if (xb <= xa) continue;
        const ia = Math.floor(xa), ib = Math.floor(xb);
        if (ia === ib) cov[ia] += (xb - xa) * wgt;
        else {
          cov[ia] += (ia + 1 - xa) * wgt;
          diff[ia + 1] += wgt;
          diff[ib] -= wgt;
          if (ib < width) cov[ib] += (xb - ib) * wgt;
        }
        if (ia < lo) lo = ia;
        if (ib > hi) hi = ib;
      }
    }
    if (hi < 0) continue;
    const end = Math.min(hi, width - 1);
    let run = 0;
    for (let px = lo; px <= end; px++) {
      run += diff[px];
      const a = cov[px] + run;
      diff[px] = 0;
      cov[px] = 0;
      if (a > 0.001) emit(px, py, a > 1 ? 1 : a);
    }
    diff[end + 1] = 0; cov[end + 1] = 0;
    if (hi >= width) { diff[width] = 0; cov[width] = 0; }
  }
}

// ── 글자 모양 캐시 ───────────────────────────────────────────────
// 같은 글자(폰트·크기·문자열)는 한 번만 윤곽을 칠해 덮인 비율 마스크로 저장하고, 다음부터는 색만
// 입혀 찍는다. 이름·라벨처럼 턴마다 반복되는 글자가 대부분이라 그림 시간이 크게 준다.
const MASK_CACHE_MAX = 300;
const maskCache = new Map(); // key → { x0, y0, w, h, data }
let fontIds = new WeakMap(), nextFontId = 1;
function fontId(font) {
  let id = fontIds.get(font);
  if (!id) { id = nextFontId++; fontIds.set(font, id); }
  return id;
}
function glyphContours(path, steps) {
  const contours = [];
  let cur = null, px = 0, py = 0;
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
  return contours;
}
// 문자열의 덮인 비율 마스크. 원점(0,0)은 글자 줄 시작점의 기준선(baseline).
function textMask(font, str, size) {
  const key = `${fontId(font)}|${size.toFixed(2)}|${str}`;
  let m = maskCache.get(key);
  if (m) { maskCache.delete(key); maskCache.set(key, m); return m; } // 최근 사용으로 갱신
  const contours = glyphContours(font.getPath(str, 0, 0, size), size > 30 ? 8 : 5);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of contours) for (let k = 0; k < c.length; k += 2) {
    if (c[k] < minX) minX = c[k]; if (c[k] > maxX) maxX = c[k];
    if (c[k + 1] < minY) minY = c[k + 1]; if (c[k + 1] > maxY) maxY = c[k + 1];
  }
  if (!contours.length) m = { x0: 0, y0: 0, w: 0, h: 0, data: new Uint8Array(0) };
  else {
    const x0 = Math.floor(minX) - 1, y0 = Math.floor(minY) - 1;
    const w = Math.ceil(maxX) - x0 + 2, h = Math.ceil(maxY) - y0 + 2;
    const shifted = contours.map(c => { const o = new Array(c.length); for (let k = 0; k < c.length; k += 2) { o[k] = c[k] - x0; o[k + 1] = c[k + 1] - y0; } return o; });
    const data = new Uint8Array(w * h);
    scan(shifted, w, h, (px, py, a) => { data[py * w + px] = Math.round(a * 255); });
    m = { x0, y0, w, h, data };
  }
  maskCache.set(key, m);
  if (maskCache.size > MASK_CACHE_MAX) maskCache.delete(maskCache.keys().next().value);
  return m;
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

// width·height·좌표·글자 크기는 모두 "설계 크기" 기준으로 받고, 실제 그림은 scale배로 작게 만든다.
// 디스코드가 그림을 채팅 폭(약 550px)으로 줄여 보여주므로, 설계 크기 900px을 0.75배(675px)로 그려도
// 화면에 보이는 글자 크기는 같고 칠할 픽셀은 44% 준다(CPU 25% 서버에서 그림 시간이 그만큼 준다).
class Painter {
  constructor(width, height, scale = 1) {
    this.s = scale;
    this.w = Math.round(width * scale); // 실제 버퍼 크기(픽셀)
    this.h = Math.round(height * scale);
    this.buf = Buffer.alloc(this.w * this.h * 3);
  }

  // 덮인 비율 a(0~1)만큼 색을 섞는다.
  blend(i, c, a) {
    const b = this.buf;
    if (a >= 0.999) { b[i] = c[0]; b[i + 1] = c[1]; b[i + 2] = c[2]; return; }
    b[i] += (c[0] - b[i]) * a;
    b[i + 1] += (c[1] - b[i + 1]) * a;
    b[i + 2] += (c[2] - b[i + 2]) * a;
  }

  clear(hex) {
    const c = rgb(hex);
    for (let i = 0; i < this.buf.length; i += 3) { this.buf[i] = c[0]; this.buf[i + 1] = c[1]; this.buf[i + 2] = c[2]; }
  }

  // 정수 픽셀 사각형(안티앨리어싱 없음 — 픽셀 아트·배경용). 시작·끝을 각각 반올림해, 맞닿은
  // 사각형(픽셀 아트 칸)끼리는 배율이 소수여도 틈이나 겹침이 생기지 않는다.
  rect(x, y, w, h, hex) {
    const c = rgb(hex);
    const s = this.s;
    const x0 = Math.max(0, Math.round(x * s)), x1 = Math.min(this.w, Math.round((x + w) * s));
    const y0 = Math.max(0, Math.round(y * s)), y1 = Math.min(this.h, Math.round((y + h) * s));
    for (let yy = y0; yy < y1; yy++) {
      let i = (yy * this.w + x0) * 3;
      for (let xx = x0; xx < x1; xx++, i += 3) { this.buf[i] = c[0]; this.buf[i + 1] = c[1]; this.buf[i + 2] = c[2]; }
    }
  }

  // contours: [[x,y, x,y, ...], ...] 닫힌 윤곽선들. non-zero 감기 규칙.
  fill(contours, hex, alpha = 1) {
    const c = rgb(hex);
    const w = this.w;
    scan(contours, this.w, this.h, (px, py, a) => this.blend((py * w + px) * 3, c, a * alpha), this.s);
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
    const k = this.s; // 배율
    const left = Math.round((align === 'center' ? x - w / 2 : align === 'right' ? x - w : x) * k);
    const baseline = Math.round((y + size * 0.36) * k);
    const m = textMask(font, str, size * k);
    const c = rgb(color);
    for (let my = 0; my < m.h; my++) {
      const py = baseline + m.y0 + my;
      if (py < 0 || py >= this.h) continue;
      for (let mx = 0; mx < m.w; mx++) {
        const a = m.data[my * m.w + mx];
        if (!a) continue;
        const px = left + m.x0 + mx;
        if (px < 0 || px >= this.w) continue;
        this.blend((py * this.w + px) * 3, c, a / 255);
      }
    }
  }

  // 글자 모양을 미리 만들어 캐시에 넣는다(첫 그림이 느리지 않게, 봇 시작 후 잘게 나눠 호출).
  warmText(font, s, size) {
    const str = cleanText(font, s);
    if (str) textMask(font, str, size * this.s);
  }

  // RGB 버퍼 → PNG. 압축은 동기(deflateSync)로 한다 — 측정상 한 장 0.5ms(서버 약 5ms)로 작고,
  // 비동기(zlib 스레드 풀)로 하면 스레드별 메모리 때문에 RSS가 30MB 더 높게 유지됐다.
  // 압축 레벨 1(가장 빠름 — 단색 위주라 크기 차이는 작다).
  png() {
    const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // truecolor RGB
    const stride = this.w * 3;
    if (!this.raw) this.raw = Buffer.alloc((stride + 1) * this.h); // 스캔라인 버퍼 재사용
    for (let y = 0; y < this.h; y++) {
      this.raw[y * (stride + 1)] = 0;
      this.buf.copy(this.raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
    }
    const idat = zlib.deflateSync(this.raw, { level: 1 });
    return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
  }
}

module.exports = { Painter, loadFont };

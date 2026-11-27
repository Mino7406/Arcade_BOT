// 레이드그림.js — 레이드 패널(모집·전투·결과)을 PNG 한 장으로 그린다.
// 디스코드 V2 컴포넌트로는 카드 가로 배치·가운데 정렬이 안 돼서, 몬스터와 파티 카드 4장이 있는
// "판"만 그림으로 만들고 타이머·버튼·클릭마다 바뀌는 선택 상태는 글자 컴포넌트로 둔다(handlers/레이드.js).
//
// 그리기는 handlers/그림판.js(순수 JS, 버퍼 하나 재사용)로 한다. 예전엔 @napi-rs/canvas를 썼는데
// 리눅스 서버에서 불러오기만 해도 RSS가 +133MB 늘어 256MB 요금제에서 버틸 수 없었다.
// 글자 크기: 디스코드는 900px 그림을 채팅 폭(약 400~550px)으로 줄여 보여주므로, 그림 안 글자는
// 최소 20px 이상으로 둔다(줄어든 화면에서 12px 안팎). 세부 수치는 그림 밑 글자 컴포넌트가 맡는다.
// 폰트·그림을 못 쓰면 render*는 null을 돌려주고, 레이드.js가 글자 화면으로 대신 보여준다.

const path = require('path');
const { drawEmojiFile } = require('../공통/이모지그림');
const { Painter, loadFont } = require('./그림판');
const { drawEnergy, drawFaint, bodyTint } = require('./용뢰');
const { ROLES, ROLE_ORDER, rolesOfMonster, PLAYER_MAX_HP, ACTIONS, createBattle, choose, resolveTurn, isStunned, slowTurnsLeft, isShielded, isPowered, poisonStacks, isConfused, chillStacks, isFeared, isPhased, isIntentHidden, isWarnIntent, telegraphText, moveFx, isWeak, weakTurnsLeft, isStenched, stenchTurnsLeft, isErrored, errorTurnsLeft, isVulnerable, vulnTurnsLeft, isDoomed } = require('./전투');

const W = 900; // 설계 크기(좌표는 전부 이 기준)
const H = 640;
const RENDER_SCALE = 0.75; // 실제 그림은 675×480 — 디스코드가 어차피 채팅 폭으로 줄여 보여줘 글자 크기는 같고 픽셀은 44% 준다
const C = {
  bg: '#17120e', frame: '#8a6a2c', gold: '#e2b14a', box: '#0c0a08', card: '#2a2119', cardEmpty: '#4a3d2a',
  teal: '#1d4c56', tealText: '#e6f4f6', orange: '#f5ab2e', text: '#ffffff', sub: '#eee6d8', dim: '#7d7466',
  muted: '#a59b8a', ok: '#7ee0a6', red: '#ff4a3a', hpBack: '#3a2f25',
};

const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
const FONT_FILES = { regular: 'NanumGothic-Regular.ttf', bold: 'NanumGothic-Bold.ttf' };

// 서버(256MB)에서 그림이 메모리를 얼마나 쓰는지 확인하기 위한 콘솔 기록. 로드 전후와
// 처음 몇 장·이후 10장마다 RSS와 그리는 시간을 남긴다.
const rssMb = () => Math.round(process.memoryUsage().rss / 1048576);
let renderCount = 0;
let warming = false; // 미리 데우기 중에 그린 그림은 기록하지 않는다
function logRender(scene, drawMs, pngMs, bytes) {
  if (warming) return;
  renderCount++;
  if (renderCount > 3 && renderCount % 10 !== 0) return;
  console.warn(`🎨 레이드 그림 #${renderCount}(${scene}) 그리기 ${drawMs.toFixed(0)}ms + 압축 ${pngMs.toFixed(0)}ms · ${Math.round(bytes / 1024)}KB · RSS ${rssMb()}MB`);
}

let fonts = null;
let painter = null;
let unavailable = false; // 한 번 실패하면 다시 시도하지 않는다
function load() {
  if (painter || unavailable) return painter;
  const before = rssMb();
  const startedAt = Date.now();
  try {
    fonts = {
      regular: loadFont(path.join(FONT_DIR, FONT_FILES.regular)),
      bold: loadFont(path.join(FONT_DIR, FONT_FILES.bold)),
    };
    painter = new Painter(W, H, RENDER_SCALE);
    console.warn(`🎨 레이드 그림 엔진 로드 — RSS ${before}→${rssMb()}MB, ${Date.now() - startedAt}ms`);
  } catch (err) {
    unavailable = true;
    console.error('레이드 그림 기능을 쓸 수 없어 글자 화면으로 대신합니다:', err.message);
  }
  return painter;
}

// ── 그리기 도구 ────────────────────────────────────────────────
let p; // 현재 그리는 Painter (render* 안에서만 유효)
const B = () => fonts.bold;
const R = () => fonts.regular;
function text(s, x, y, size, color, opts = {}) {
  p.text(opts.regular ? R() : B(), s, x, y, { size, color, align: opts.align || 'center', maxWidth: opts.maxWidth });
}
// ── 깨진 글자(오염 테마) ──
// 글자가 깨진 것처럼(사용자 결정 — 지금은 ① 끄고 ② 글리치를 세게: rate 0): ① 문자 깨짐 — 일부 글자를 �(직접 그림 — 나눔고딕에 없음)·▒로 바꾸고, errCode면 끝에 흐린 ERR_0x?? 코드
// ② 6번째 시안의 색 어긋남 — 청록·붉은 그림자를 좌우로 off px, 글자 상자 안 가로 띠 밀림(strips), 빠진 칸(holes). 같은 글자는 매번 같은 모양(seed).
// ???처럼 기호뿐인 글자는 ①이 없고 ②만.
function seeded(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296); }
function isCorrupt(monster) { return monster?.theme === 'corrupt'; }
const isAlat = (monster) => monster?.theme === 'alat'; // 알바트리온 전용 테마(폭풍·균열)
const REPLACEMENT = '\uFFFD';
function corruptChars(s, seed, rate) {
  const rnd = seeded(seed * 7919 + s.length);
  const chars = [...s];
  const idx = chars.map((ch, i) => (/[\s!?.,()]/.test(ch) ? -1 : i)).filter(i => i >= 0);
  const n = idx.length && rate > 0 ? Math.max(1, Math.round(idx.length * rate)) : 0;
  for (let k = 0; k < n; k++) {
    const i = idx.splice(Math.floor(rnd() * idx.length), 1)[0];
    chars[i] = rnd() < 0.6 ? REPLACEMENT : '▒';
  }
  return { chars, code: 'ERR_0x' + Math.floor(rnd() * 256).toString(16).toUpperCase().padStart(2, '0') };
}
function glitchText(s, x, y, size, color, { seed = 1, rate = 0, errCode = false, off = 2, strips = 2, shift = 3, holes = 2, tint = false, maxWidth } = {}) {
  const k = RENDER_SCALE;
  const { chars, code } = corruptChars(s, seed, rate);
  const repW = size * 0.86;
  const charW = (ch) => (ch === ' ' ? size * 0.3 : p.textWidth(B(), ch, size)); // 공백 하나는 글꼴 폭이 0으로 나와 따로
  const widthOf = (ch) => (ch === REPLACEMENT ? repW : charW(ch));
  const codeSize = Math.round(size * 0.72);
  const codeW = errCode ? p.textWidth(B(), code, codeSize) + size * 0.4 : 0;
  let total = chars.reduce((sum, ch) => sum + widthOf(ch), 0) + codeW;
  const sc = maxWidth && total > maxWidth ? maxWidth / total : 1; // 넘치면 글자 크기를 줄인다
  const fs_ = size * sc;
  total *= sc;
  const left = x - total / 2;
  // 색 어긋남: 청록(왼쪽) → 붉은(오른쪽) → 본래 색 순서로 세 번 그린다(off는 실제 픽셀)
  for (const [dx, col] of [[-off / k, '#2fb8c0'], [off / k, '#bf1e2d'], [0, color]]) {
    let cx = left + dx;
    for (const ch of chars) {
      const w = widthOf(ch) * sc;
      if (ch === REPLACEMENT) {
        const r = fs_ * 0.42, mx = cx + w / 2;
        p.poly([mx, y - r, mx + r, y, mx, y + r, mx - r, y], col);
        if (dx === 0) text('?', mx, y + fs_ * 0.02, Math.round(fs_ * 0.62), C.bg);
      } else if (ch !== ' ') {
        text(ch, cx, y, fs_, col, { align: 'left' });
      }
      cx += w;
    }
    if (errCode && dx === 0) text(code, cx + size * 0.4 * sc, y + fs_ * 0.06, Math.round(codeSize * sc), C.dim, { align: 'left' });
  }
  // 띠 밀림 · 빠진 칸(실제 픽셀)
  const rnd = seeded(seed * 9973 + s.length);
  const bx0 = Math.max(0, Math.round(left * k) - 6), bx1 = Math.min(p.w, Math.round((left + total) * k) + 6);
  const by0 = Math.max(0, Math.round((y - fs_ * 0.6) * k)), by1 = Math.min(p.h, Math.round((y + fs_ * 0.6) * k));
  const rowBytes = (bx1 - bx0) * 3, hh = by1 - by0;
  if (rowBytes <= 0 || hh <= 4) return;
  for (let i = 0; i < strips; i++) {
    const sy = Math.floor(rnd() * (hh - 3)), sh = 2 + Math.floor(rnd() * Math.max(1, Math.floor(hh / 7) - 1));
    const dx = (rnd() < 0.5 ? -1 : 1) * (1 + Math.floor(rnd() * shift));
    for (let yy = by0 + sy; yy < by0 + sy + sh && yy < by1; yy++) {
      const start = (yy * p.w + bx0) * 3;
      const row = Buffer.from(p.buf.subarray(start, start + rowBytes));
      p.buf.fill(0, start, start + rowBytes);
      row.copy(p.buf, start + Math.max(0, dx) * 3, Math.max(0, -dx) * 3, rowBytes - Math.max(0, dx) * 3);
      if (tint) { // 밀린 줄은 붉은/청록으로 물든다(밝은 글자 픽셀만)
        const tc = i % 2 ? [40, 220, 230] : [255, 50, 70];
        for (let j = start; j < start + rowBytes; j += 3) if (p.buf[j] + p.buf[j + 1] + p.buf[j + 2] > 300) { p.buf[j] = tc[0]; p.buf[j + 1] = tc[1]; p.buf[j + 2] = tc[2]; }
      }
    }
  }
  const cols = [[8, 2, 4], [180, 20, 36], [40, 200, 210]];
  for (let i = 0; i < holes; i++) {
    const hx = bx0 + Math.floor(rnd() * Math.max(1, bx1 - bx0 - 6)), hy = by0 + Math.floor(rnd() * Math.max(1, hh - 4));
    const w = 3 + Math.floor(rnd() * 3), c = cols[Math.floor(rnd() * 3)];
    for (let yy = hy; yy < hy + 2; yy++) for (let xx = hx; xx < hx + w && xx < p.w; xx++) { const j = (yy * p.w + xx) * 3; p.buf[j] = c[0]; p.buf[j + 1] = c[1]; p.buf[j + 2] = c[2]; }
  }
}
function bar(x, y, w, h, ratio, color) {
  p.roundRect(x, y, w, h, h / 2, C.hpBack);
  const fw = Math.max(0, Math.min(1, ratio)) * w;
  if (fw > 0) p.roundRect(x, y, Math.max(fw, h), h, h / 2, color);
}
const hpColor = (ratio) => (ratio > 0.5 ? '#3ecf6e' : ratio > 0.25 ? '#f0b232' : '#f04b3a');
// 독에 걸린 카드: 밝은 보라(검은 숫자가 잘 읽히는 밝기). 위험(25% 이하)은 평소처럼 빨강으로 둬 놓치지 않게.
// 독류 HP 바 색: 상태이상의 status.color(화상은 주황), 없으면 보라. 25% 이하는 빨강.
const poisonHpColor = (ratio, color) => (ratio > 0.25 ? color || '#b98af2' : '#f04b3a');
function pill(x, y, w, h, label, size, fill = C.teal, color = C.tealText) {
  p.roundRect(x, y, w, h, 7, fill);
  text(label, x + w / 2, y + h / 2, size, color, { maxWidth: w - 12 });
}

// 모집 제목 양옆 아이콘(16×16 픽셀 아트, 오리지널). TITLE_ICON으로 고른다.
const TITLE_ICON = 'skull';
const TITLE_ICONS = {
  skull: {
    rows: [
      '....dddddddd....', '...dwwwwwwwwd...', '..dwwwwwwwwwwd..', '.dwwwwwwwwwwwwd.',
      '.dwwwwwwwwwwwwd.', '.dwkkkwwwwkkkwd.', '.dwkkkwwwwkkkwd.', '.dwwkwwwwwwkwwd.',
      '.dwwwwwkkwwwwwd.', '..dwwwwkkwwwwd..', '...dwwwwwwwwd...', '....dwdwdwdwd...',
      '....dwdwdwdwd...', '.....ddddddd....', '................', '................',
    ],
    palette: { d: '#2a1f1a', w: '#efe6d6', k: '#1a1210' },
  },
  dragon: {
    rows: [
      '..dd........dd..', '.dgd........dgd.', '.dggd......dggd.', '..dgrrrrrrrrgd..',
      '..drrrrrrrrrrd..', '.drryyrrrryyrrd.', '.drrykrrrrkyrrd.', '.drrrrrrrrrrrrd.',
      '..drrrrrrrrrrd..', '..drrrrrrrrrrd..', '...drrkrrkrrd...', '...drrrrrrrrd...',
      '....dwdrrdwd....', '.....dddddd.....', '................', '................',
    ],
    palette: { d: '#1a0f0a', g: '#c9b48a', r: '#c0392b', y: '#ffd23a', k: '#1a0f0a', w: '#f4efe6' },
  },
};
function titleIcon(cx, cy) {
  drawPixels(TITLE_ICONS[TITLE_ICON], cx, cy, 3);
}

// 경광등(예전 제목 양옆 장식 — 지금은 안 씀)
function siren(cx, cy, s = 1) {
  const dome = [];
  for (let k = 0; k <= 10; k++) { const a = Math.PI + (k / 10) * Math.PI; dome.push(cx + Math.cos(a) * 14 * s, cy - 4 * s + Math.sin(a) * 14 * s); }
  p.poly([cx - 14 * s, cy + 11 * s, ...dome, cx + 14 * s, cy + 11 * s], C.red);
  p.rect(cx - 7 * s, cy - 10 * s, 4 * s, 13 * s, '#ffd2c8');
  p.roundRect(cx - 19 * s, cy + 11 * s, 38 * s, 7 * s, 2, C.gold);
  for (const [x1, y1, x2, y2] of [[-22, -16, -28, -22], [22, -16, 28, -22], [0, -25, 0, -32], [-25, 0, -32, 0], [25, 0, 32, 0]]) {
    p.line(cx + x1 * s, cy + y1 * s, cx + x2 * s, cy + y2 * s, 3.2 * s, C.red);
  }
}

// 픽셀 아트 한 장을 (cx, cy) 가운데에 칸 크기 px로 그린다. dim이면 어둡게(빈자리·쓰러짐).
function drawPixels(sp, cx, cy, px, { dim = false, colors = null } = {}) {
  const w = sp.rows[0].length * px;
  const h = sp.rows.length * px;
  const palette = colors ? { ...sp.palette, ...colors } : sp.palette;
  sp.rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === '.') return;
    const color = dim ? grayOf(palette[ch], 0.45) : palette[ch];
    const shift = sp.glitchRows?.includes(y) ? px * 0.6 : 0;
    // 칸 크기가 소수여도 칸 사이에 틈이 생기지 않게 경계를 정수 픽셀로 맞춘다.
    const x0 = Math.round(cx - w / 2 + x * px + shift);
    const y0 = Math.round(cy - h / 2 + y * px);
    p.rect(x0, y0, Math.round(cx - w / 2 + (x + 1) * px + shift) - x0, Math.round(cy - h / 2 + (y + 1) * px) - y0, color);
  }));
}
// 이름 끝 글자 받침에 따라 '이'/'가'(한글이 아니면 '이(가)')
function subjectJosa(name) {
  const code = String(name).trim().slice(-1).charCodeAt(0) - 0xAC00;
  if (code < 0 || code > 11171) return '이(가)';
  return code % 28 ? '이' : '가';
}

function grayOf(hex, k) {
  const v = Math.round((parseInt(hex.slice(1, 3), 16) * 0.3 + parseInt(hex.slice(3, 5), 16) * 0.59 + parseInt(hex.slice(5, 7), 16) * 0.11) * k);
  const g = v.toString(16).padStart(2, '0');
  return `#${g}${g}${g}${hex.slice(7)}`; // 알파(#rrggbbaa)가 있으면 그대로 유지
}

// 역할 아이콘: 몬스터와 같은 16×16 픽셀 아트(오리지널). '.'은 투명.
const ROLE_SPRITES = {
  sword: {
    rows: [
      '.............ddd', '............dwsd', '...........dwsd.', '..........dwsd..',
      '.........dwsd...', '........dwsd....', '.......dwsd.....', '..dd..dwsd......',
      '..dgddwsd.......', '...dgwsd........', '....dgd.........', '...dbdgd........',
      '..dbd.dgd.......', '.dbd...dd.......', 'dpd.............', 'dd..............',
    ],
    palette: { d: '#15151b', w: '#ffffff', s: '#a9bdd4', g: '#e8b34a', b: '#7a4a26', p: '#e8b34a' },
  },
  archer: {
    // 활대는 화살 방향(오른쪽)으로 휘고, 시위는 왼쪽, 화살은 시위에 걸려 손잡이 위로 지나간다.
    rows: [
      '....dhbd........', '....ldhbd.......', '....ldhbd.......', '....l.dhbd......',
      '....l.dhbd......', '....l..dhbd.....', '.fffl..dwwd.dgd.', 'f.aaaaadwwdaaggd',
      '.fffl..dwwd.dgd.', '....l..dhbd.....', '....l..dhbd.....', '....l.dhbd......',
      '....l.dhbd......', '....ldhbd.......', '....ldhbd.......', '....dhbd........',
    ],
    palette: { d: '#15151b', b: '#8b5a2b', h: '#c98c4a', w: '#5a3418', l: '#f1e7d0', a: '#d9c7a3', g: '#a9bdd4', f: '#e5484d' },
  },
  tank: {
    rows: [
      '..dddddddddddd..', '.dggggggggggggd.', '.dguuuuwwuuuugd.', '.dguhuuwwuuuugd.',
      '.dguhuuwwuuuugd.', '.dgwwwwwwwwwwgd.', '.dgwwwwwwwwwwgd.', '.dguhuuwwuuuugd.',
      '.dguuuuwwuuuugd.', '..dguuuwwuuugd..', '..dguuuwwuuugd..', '...dguuwwuugd...',
      '....dguwwugd....', '.....dgwwgd.....', '......dggd......', '.......dd.......',
    ],
    palette: { d: '#15151b', g: '#e8b34a', u: '#3566c9', h: '#6f9cff', w: '#f4f1e8' },
  },
  healer: {
    rows: [
      '................', '..dddd....dddd..', '.drrrrd..drrrrd.', 'drhhrrrddrrrrrrd',
      'drhrrrrrrrrrrrrd', 'drrrrrrwwrrrrrrd', 'drrrrrrwwrrrrrrd', 'drrrrwwwwwwrrrrd',
      '.drrrwwwwwwrrrd.', '.drrrrrwwrrrrrd.', '..drrrrwwrrrrd..', '...drrrrrrrrd...',
      '....drrrrrrd....', '.....drrrrd.....', '......drrd......', '.......dd.......',
    ],
    palette: { d: '#15151b', r: '#e5484d', h: '#ff9aa0', w: '#ffffff' },
  },
};
// 속성 직업(🔥💧⚡❄️) 아이콘: 32×32 확정 그림(scripts/아이콘변환.js 가 만든 파일). 오라 칸은 반투명(#rrggbb80)이다.
Object.assign(ROLE_SPRITES, require('./알바트리온아이콘'));
const ROLE_ICON_PX = 3.4; // 16칸 × 3.4 ≈ 54px. 칸 수가 다른 그림(32칸)은 전체 크기가 같도록 칸 크기를 줄인다.
const iconPx = (sprite, px = ROLE_ICON_PX) => (sprite.rows.length > 16 ? px * 1.3 : px) * 16 / sprite.rows.length; // 32칸 속성 아이콘은 더 크게
// 속성 직업 카드: 속성 색 은은한 빛무리 + 바닥 그림자를 깔아 아이콘이 카드에 떠 보이지 않고 놓여 있게 한다.
const ELEMENT_GLOW = { none: '#c8c4d8', fire: '#ff8c23', water: '#46cdff', thunder: '#f0f546', ice: '#82d7ff' };
const mixHex = (a, b, t) => '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0')).join('');
function elementGlow(role, cx, cy, dim) {
  const glow = ELEMENT_GLOW[role];
  if (!glow || !/^#[0-9a-f]{6}$/i.test(C.card)) return;
  const k = dim ? 0.5 : 1;
  // 속성색을 투명도로 얹는다(카드색과 섞은 불투명 원이면 밝은 기술 연출 위에서 어두운 원이 따로 떠 보인다)
  [[33, 0.10], [28, 0.17], [22, 0.25]].forEach(([r, t]) => p.circle(cx, cy, r, glow, t * k));
  const sy = cy + 31, pts = [];
  for (let i = 0; i < 20; i++) { const a = i / 20 * Math.PI * 2; pts.push(cx + Math.cos(a) * 24, sy + Math.sin(a) * 4); }
  p.poly(pts, '#000000', 0.3);
}
function roleIcon(role, cx, cy, dim = false) {
  const dy = ELEMENT_GLOW[role] ? -4 : 0;
  elementGlow(role, cx, cy + dy, dim);
  drawPixels(ROLE_SPRITES[role], cx, cy + dy, iconPx(ROLE_SPRITES[role]), { dim });
}

// ── 알바트리온 속성별 몸 변화: 칸 도트만으로 날개 윤곽(스프라이트에서 뽑은 가장자리)에 속성 효과를 붙인다 ──
// 불=날개 아래 끝에서 위로 갈라지는 용암 균열 + 뿔끝 불꽃 + 불씨 / 물=아래 끝에서 흘러내리는 물줄기·물방울 + 윗가장자리 거품 + 어깨 파도 마루 /
// 번개=바깥 윤곽에서 뻗어 나가는 지그재그 전기 + 뿔끝 스파크 / 얼음=윗가장자리에 돋은 얼음 결정 + 아래 끝에 매달린 고드름 + 뿔 옆 성에 / 용=윗가장자리에서 바깥으로 휘감겨 오르는 어둠 불꽃 + 흩어지는 알갱이.
// 기존의 날개막 선 효과(물결·전기 줄기·성에 금)도 그대로 두고, 그 위에 윤곽 기반 효과를 더했다.
// (c, r)은 스프라이트 칸 좌표(60×46). 왼쪽 기준으로 적고 오른쪽은 59 - c 로 거울. 날개막 색은 몬스터 데이터의 elementColors(s·m)로 속성마다 물들인다.
function alatBodyFx(el, cx, cy, cell, rows, rage = false) {
  const ox = cx - 30 * cell, oy = cy - 23 * cell;
  const cd = (c, r, col) => p.rect(Math.round(ox + c * cell), Math.round(oy + r * cell), Math.ceil(cell), Math.ceil(cell), col);
  const both = (fn) => { fn(1); fn(-1); };
  const cc = (sd, c) => (sd === 1 ? c : 59 - c);
  // 날개 윤곽: 왼쪽 날개(열 0~15)의 가장자리 칸을 스프라이트에서 뽑는다 — 위쪽(top)·아래쪽(bottom)·바깥쪽(outer)
  const R = rows || [];
  const solid = (r, c) => !!R[r] && !!R[r][c] && R[r][c] !== '.';
  const edge = [], top = [], bottom = [], outer = [];
  for (let r = 0; r < R.length; r++) for (let c = 0; c <= 15; c++) {
    if (!solid(r, c)) continue;
    const up = !solid(r - 1, c), down = !solid(r + 1, c), left = !solid(r, c - 1);
    if (up || down || left || !solid(r, c + 1)) edge.push([c, r]);
    if (up && r <= 14 && c >= 3) top.push([c, r]);
    if (down && r >= 19) bottom.push([c, r]);
    if (left) outer.push([c, r]);
  }
  const pts = (a) => { const out = []; for (let i = 0; i < a.length - 1; i++) { const [c0, r0] = a[i], [c1, r1] = a[i + 1], n = Math.max(Math.abs(c1 - c0), Math.abs(r1 - r0), 1); for (let k = 0; k < n; k++) out.push([Math.round(c0 + (c1 - c0) * k / n), Math.round(r0 + (r1 - r0) * k / n)]); } out.push(a[a.length - 1]); return out; };
  // 줄기: 먼저 둘레(halo, 좌우 한 칸) → 본색 → 밝은 심(몇 칸 건너 하나)
  const bolt = (sd, a, halo, mid, core) => { const q = pts(a); for (const [c, r] of q) { cd(cc(sd, c) - 1, r, halo); cd(cc(sd, c) + 1, r, halo); } q.forEach(([c, r], i) => cd(cc(sd, c), r, i % 3 === 1 ? core : mid)); };
  const horn = (cols) => { for (const [dx, dy, col] of cols) cd(0 + dx, 0 + dy, col); };
  if (el === 'fire') {
    both(sd => {
      for (const [dx, dy, col] of [[0, 1, '#a02a08'], [0, 0, '#ff5a14'], [-1, 0, '#c8380c'], [1, 0, '#c8380c'], [0, -1, '#ff7a1c'], [-1, -1, '#ff5a14'], [0, -2, '#ffb347'], [1, -2, '#ff7a1c'], [0, -3, '#ffd060'], [0, -4, '#fff1b0']]) cd(cc(sd, 18) + dx, 1 + dy, col); // 뿔끝 불꽃(3톤 + 곁불)
      for (const seg of [[[14, 13], [13, 14], [13, 16]], [[10, 18], [9, 19], [8, 21]]]) pts(seg).forEach(([c, r], i) => cd(cc(sd, c), r, i % 2 ? '#ffb347' : '#ff7a1c')); // 날개막 위 짧은 균열 조각(기존)
      edge.filter(([c, r]) => r >= 20 && c % 3 === 0).forEach(([c, r]) => { // 용암 균열: 날개 아래 끝에서 위로 갈라져 오른다
        for (let k = 0; k < 4; k++) cd(cc(sd, c + (k % 2 ? 1 : 0)), r - 1 - k, k < 2 ? '#ff9a2a' : '#c8380c');
        cd(cc(sd, c), r, '#ffe08a');
      });
      for (const [c, r] of [[5, 13], [3, 17], [7, 24], [2, 21]]) cd(cc(sd, c), r, '#ffb347'); // 날개 끝에서 피어오르는 불씨
    });
  } else if (el === 'water') {
    both(sd => {
      for (const [c, r, col] of [[17, 10, '#1c5a96'], [16, 9, '#2a8ad0'], [15, 8, '#46cdff'], [15, 7, '#46cdff'], [14, 6, '#7ad8ff'], [14, 5, '#7ad8ff'], [15, 4, '#bfeaff'], [16, 4, '#ffffff'], [17, 5, '#bfeaff'], [13, 7, '#2a8ad0'], [13, 8, '#1c5a96'], [12, 9, '#1c5a96'], [16, 6, '#2a8ad0'], [16, 8, '#2a8ad0']]) cd(cc(sd, c), r, col); // 어깨에서 말려 올라가는 파도 마루
      for (let c = 4; c <= 13; c++) { const rr = 18 + Math.round(Math.sin(c * 0.8) * 1.2); cd(cc(sd, c), rr, Math.sin(c * 0.8) > 0.8 ? '#ffffff' : (c % 2 ? '#7ad8ff' : '#46cdff')); } // 날개막 위 물결(기존)
      for (let c = 3; c <= 10; c++) { const rr = 22 + Math.round(Math.sin(c * 0.8 + 1) * 1.2); cd(cc(sd, c), rr + 1, '#1c5a96'); cd(cc(sd, c), rr, Math.sin(c * 0.8 + 1) > 0.8 ? '#ffffff' : (c % 2 ? '#46cdff' : '#7ad8ff')); }
      bottom.filter(([c]) => c % 3 === 1).forEach(([c, r], i) => { // 날개 아래 끝에서 흘러내리는 물줄기(끝에 맺힌 물방울)
        const len = 3 + (i % 2);
        for (let k = 1; k <= len; k++) { cd(cc(sd, c), r + k, k === len ? '#ffffff' : k === len - 1 ? '#bfeaff' : '#46cdff'); if (k < len) cd(cc(sd, c) + (sd === 1 ? 1 : -1), r + k, '#1c5a96'); }
      });
      top.filter(([c]) => c % 2 === 0).forEach(([c, r]) => { cd(cc(sd, c), r - 1, '#bfeaff'); if (c % 4 === 0) cd(cc(sd, c), r - 2, '#ffffff'); }); // 윗가장자리에 이는 흰 거품
      for (const [c, r] of [[2, 14], [1, 19], [9, 6], [14, 27]]) { cd(cc(sd, c), r, '#ffffff'); cd(cc(sd, c) - 1, r, '#7ad8ff'); cd(cc(sd, c) + 1, r, '#7ad8ff'); cd(cc(sd, c), r + 1, '#7ad8ff'); } // 떠 있는 물방울
      cd(cc(sd, 18), 3, '#bfeaff'); cd(cc(sd, 19), 4, '#7ad8ff'); // 뿔에 맺힌 물기
    });
  } else if (el === 'thunder') {
    both(sd => {
      bolt(sd, [[13, 9], [9, 11], [10, 13], [6, 15]], '#5a5008', '#f0f546', '#ffffff'); // 날개로 흐르는 전기 줄기(기존)
      bolt(sd, [[13, 9], [16, 11], [15, 13]], '#5a5008', '#f0f546', '#ffffff'); bolt(sd, [[10, 13], [7, 14], [8, 17]], '#5a5008', '#f0f546', '#ffffff'); // 곁가지
      outer.filter(([c, r], i) => r >= 6 && r % 4 === 2).forEach(([c, r]) => { // 바깥 윤곽에서 뻗어 나가는 지그재그 전기
        for (let k = 1; k <= 4; k++) { const rr = r + (k % 2 ? -1 : 1) * (k > 1 ? 1 : 0); cd(cc(sd, c - k), rr, k === 4 ? '#ffffff' : k % 2 ? '#f0f546' : '#c8b010'); }
        cd(cc(sd, c), r, '#fff8b0');
      });
      for (const [dx, dy] of [[0, -1], [1, 0], [-1, 0], [0, 1]]) cd(cc(sd, 18) + dx, 0 + dy, '#fff8b0'); cd(cc(sd, 18), 0, '#ffffff'); // 뿔끝 스파크(십자)
      for (const [c, r] of [[3, 17], [2, 20], [4, 24]]) { cd(cc(sd, c), r, '#fff8b0'); cd(cc(sd, c) + 1, r, '#f0f546'); } // 튀는 불꽃
    });
  } else if (el === 'ice') {
    both(sd => {
      for (const [c, r, col] of [[3, 11, '#e8fbff'], [4, 10, '#e8fbff'], [5, 9, '#a8e4ff'], [6, 8, '#ffffff'], [7, 8, '#a8e4ff'], [8, 9, '#e8fbff']]) cd(cc(sd, c), r, col); // 날개 윗가장자리 서리(기존)
      for (const [c, r] of [[6, 12], [7, 13], [8, 14], [9, 13], [10, 12], [6, 16], [7, 17], [5, 18], [9, 16]]) cd(cc(sd, c), r, '#7ab8dc'); // 날개막 성에 금(기존)
      for (const [c, r] of [[5, 15], [8, 15], [11, 17]]) cd(cc(sd, c), r, '#e8fbff'); // 성에 알갱이
      top.filter(([c]) => c % 3 === 0).forEach(([c, r], i) => { // 윗가장자리에 돋은 얼음 결정(아래 어두운 청색 → 끝은 흰색)
        const h = 2 + (i % 2);
        for (let k = 1; k <= h; k++) cd(cc(sd, c), r - k, k === h ? '#ffffff' : k === 1 ? '#7ab8dc' : '#a8e4ff');
        cd(cc(sd, c) + (sd === 1 ? 1 : -1), r - 1, '#4a88b0');
      });
      bottom.filter(([c]) => c % 3 === 1).forEach(([c, r], i) => { // 아래 끝에 매달린 고드름(옆 그늘 한 줄)
        const h = 3 + (i % 2);
        for (let k = 1; k <= h; k++) { cd(cc(sd, c), r + k, k === h ? '#ffffff' : k === 1 ? '#e8fbff' : '#a8e4ff'); if (k < h) cd(cc(sd, c) + (sd === 1 ? 1 : -1), r + k, '#4a88b0'); }
      });
      cd(cc(sd, 17), 4, '#a8e4ff'); cd(cc(sd, 17), 5, '#e8fbff'); cd(cc(sd, 16), 6, '#a8e4ff'); // 뿔 옆 성에
    });
  } else if (el === 'dragon') {
    both(sd => {
      top.filter(([c]) => c % 3 === 1).forEach(([c, r], i) => { // 윗가장자리에서 바깥으로 휘감겨 오르는 어둠 불꽃(자홍 → 분홍)
        const dir = i % 2 ? 1 : 2;
        cd(cc(sd, c), r - 1, '#701e4c'); cd(cc(sd, c - 1), r - 2, '#e8407a'); cd(cc(sd, c - 1 - dir), r - 2 - (dir === 2 ? 0 : 1), '#ff7ab0'); cd(cc(sd, c - 2 - dir), r - 3 - (dir === 2 ? 0 : 1), '#ffa0d0');
      });
      for (const [c, r] of [[1, 9], [0, 15], [2, 21], [4, 25]]) { cd(cc(sd, c), r, '#ff7ab0'); cd(cc(sd, c), r + 1, '#701e4c'); } // 날개 끝에서 흩어지는 어둠 알갱이
      for (const [dx, dy, col] of [[0, 1, '#701e4c'], [0, 0, '#e8407a'], [-1, 0, '#a0185a'], [1, 0, '#a0185a'], [0, -1, '#ff7ab0'], [0, -2, '#ffa0d0'], [0, -3, '#ffd0e8']]) cd(cc(sd, 18) + dx, 1 + dy, col); // 뿔끝 어둠 불꽃
    });
  }
  if (rage) both(sd => { // 분노: 날개 아래 끝에서 갈라져 오르는 붉은 균열 + 윗가장자리 붉은 불씨 + 뿔끝 붉은 불꽃(속성 효과 위에 겹친다)
    bottom.filter(([c]) => c % 3 === 2).forEach(([c, r]) => { for (let k = 0; k < 4; k++) cd(cc(sd, c - (k % 2 ? 1 : 0)), r - 1 - k, k < 2 ? '#ff5a3a' : '#a0121c'); cd(cc(sd, c), r, '#ffd0c0'); });
    top.filter(([c]) => c % 2 === 0).forEach(([c, r]) => { cd(cc(sd, c), r - 1, '#a0121c'); if (c % 4 === 0) cd(cc(sd, c), r - 2, '#ff3a2a'); });
    for (const [dx, dy, col] of [[0, 1, '#5a0a10'], [0, 0, '#c8141c'], [0, -1, '#ff3a2a'], [0, -2, '#ff8a6a']]) cd(cc(sd, 18) + dx, 1 + dy, col);
  });
}

// ── 알바트리온 속성 전환 연출: 이전 속성 색 고리가 바깥으로 흩어지고, 새 속성 색 고리가 몸을 감싸며 조여든다 + 큰 전환 문구 ──
const ELEMENT_LABEL = { none: '무속성', fire: '불꽃', water: '물', thunder: '번개', ice: '얼음', dragon: '용' };
const ELEMENT_COLOR = { none: '#c8c4d8', fire: '#ff8c23', water: '#46cdff', thunder: '#f0f546', ice: '#a8e4ff', dragon: '#e8407a' };
let alatEmblem = null; // 위 속성 표시 아이콘 그리기 함수(alatHeader가 채운다): (cx, cy, 반지름, 속성)
function alatShiftBack(cx, cy, from, to) { // 몸 뒤(뒤 층): 퍼지는 옛 속성 고리 + 새 속성 후광
  const a = ELEMENT_COLOR[from] || '#c08aff', b = ELEMENT_COLOR[to] || '#c08aff';
  haze(cx, cy, 96, b, 0.16); haze(cx, cy, 64, b, 0.2);
  for (const [r, w] of [[150, 5], [118, 4]]) for (let i = 0; i < 40; i++) { const ang = (i / 40) * Math.PI * 2; if (i % 3 === 0) continue; p.rect(Math.round(cx + Math.cos(ang) * r * 1.35), Math.round(cy + Math.sin(ang) * r * 0.62), w, w, a); } // 옛 속성: 바깥으로 흩어지는 점선 고리
  for (let i = 0; i < 28; i++) { const ang = (i / 28) * Math.PI * 2; p.line(cx + Math.cos(ang) * 72, cy + Math.sin(ang) * 40, cx + Math.cos(ang) * 112, cy + Math.sin(ang) * 62, 3, i % 2 ? b : a + 'aa'); } // 몸에서 터지는 방사선
}
function alatShiftFront(cx, cy, from, to) { // 몸 앞(앞 층): 몸을 조여드는 새 속성 고리 + 문구
  const b = ELEMENT_COLOR[to] || '#c08aff', a = ELEMENT_COLOR[from] || '#c08aff';
  for (const [r, w] of [[84, 6], [56, 4]]) for (let i = 0; i < 36; i++) { const ang = (i / 36) * Math.PI * 2; if (i % 4 === 3) continue; p.rect(Math.round(cx + Math.cos(ang) * r * 1.3), Math.round(cy + Math.sin(ang) * r * 0.62), w, w, b); } // 새 속성: 몸을 감싸는 도트 고리
  // 전환 표시: 스킬 이름 띠 바로 아래 왼쪽 옆면에 [이전 속성 아이콘 → 새 속성 아이콘](위 속성 표시와 같은 아이콘을 작게)
  const c = sideCard("L", 182, 132, 36, 10, b), x1 = c.x0 + 13, ax = x1 + 29, x2 = ax + 29;
  if (alatEmblem) { alatEmblem(x1, c.cy, 12, from, false); alatEmblem(x2, c.cy, 12, to, false); }
  p.line(ax - 8, c.cy, ax + 8, c.cy, 3, '#ffffff'); p.line(ax + 2, c.cy - 6, ax + 8, c.cy, 3, '#ffffff'); p.line(ax + 2, c.cy + 6, ax + 8, c.cy, 3, '#ffffff'); // 화살표
}


// ── 에스카톤 저지먼트 연출: 지금 속성이 전장 전체를 뒤덮는다 ──
// 바탕은 이미 쓰고 있는 속성 브레스의 '전장 뒤덮기'(alatOverlay field: 불=용암 바다 · 물=소용돌이 · 번개=먹구름과 빛기둥 · 얼음=서리 · 용=어둠) 렌더를 그대로 쓰고,
// 단계마다 밝기·광선·섬광만 다르게 얹는다. 선택 화면(충전)과 결과 화면 4단계(임계 → 방출 → 식음 → 여운).
const ESC_COLS = ['#ff8c23', '#46cdff', '#f0f546', '#a8e4ff', '#e8407a']; // 불 · 물 · 번개 · 얼음 · 용(마지막 다섯 속성 충격파)
const ESC_THEME = {
  fire:    { main: '#ff7a1c', hi: '#ffd060', dark: '#8a1a0c', deep: '#240a06', core: '#ff3a2a' },
  water:   { main: '#2a8ad0', hi: '#bfeaff', dark: '#123c90', deep: '#06122a', core: '#46cdff' },
  thunder: { main: '#f0c820', hi: '#fff8b0', dark: '#7a5a00', deep: '#14120a', core: '#f0f546' },
  ice:     { main: '#6cb4dc', hi: '#f0fbff', dark: '#245a88', deep: '#08182a', core: '#a8e4ff' },
  dragon:  { main: '#e8407a', hi: '#ffa0d0', dark: '#701e4c', deep: '#16061a', core: '#ff5a9a' },
};
// 속성 골짜기: 같은 골짜기의 암벽·하늘 틈·바닥을 속성 색으로 다시 칠한다(스킬 연출이 아니라 전장 자체가 변한다)
const ESC_PAL = {
  fire:    { ROCK: ['#0e0504', '#2a0c08', '#4a1a0c', '#7a2a10', '#b8441a', '#e8701e', '#ffb04a'], SKY: ['#a83a14', '#ff8a2a', '#ffd070', '#fff0c0'], FLOOR: ['#2a0c06', '#5a1a0a', '#9a3010', '#e0601a', '#ffa040'] },
  water:   { ROCK: ['#040e1c', '#08203a', '#0e3a64', '#1a5a94', '#2a82c0', '#5cb4e8', '#a8e0ff'], SKY: ['#3a86c0', '#7cc8f0', '#c4ecff', '#ffffff'], FLOOR: ['#06223e', '#0e4a80', '#2a82c8', '#7cc8f0', '#e8f8ff'] },
  thunder: { ROCK: ['#08080c', '#14141c', '#262432', '#403c4a', '#6a6258', '#a09468', '#e0d080'], SKY: ['#58502a', '#c8b030', '#fff070', '#ffffff'], FLOOR: ['#14120a', '#2a260c', '#5a4c10', '#c8a818', '#fff070'] },
  ice:     { ROCK: ['#06101c', '#0e2238', '#1c3e60', '#3a6a94', '#6aa0c8', '#a8d0e8', '#e0f4ff'], SKY: ['#8ac0e0', '#c8ecff', '#eefaff', '#ffffff'], FLOOR: ['#10243c', '#2a5078', '#5a90b8', '#a8d8f0', '#f0fbff'] },
  dragon:  { ROCK: ['#0a0410', '#1c0a24', '#34123e', '#5a1c5c', '#8a2a78', '#c0489c', '#ff90c8'], SKY: ['#6a1860', '#c83a8c', '#ff8ac4', '#ffe0f0'], FLOOR: ['#16061c', '#34103c', '#701e64', '#c0407c', '#ff9ad0'] },
};
const escTheme = (el) => ESC_THEME[el] || ESC_THEME.fire;
function escField(el, cx, cy, dim, stage = -1, sup = false) { // 속성 골짜기(몬스터 뒤) + 어둡게(dim 0~1). stage 1(방출)이면 하늘 틈의 빛기둥도 뒤에 그린다
  const t = escTheme(el), BX = { x: 20, y: 120, w: W - 40, h: 224 }, rnd = seedRng(61);
  p.roundRect(BX.x, BX.y, BX.w, BX.h, 14, C.box);
  alatCanyon(BX.y, BX.h, true, { ...(ESC_PAL[el] || ESC_PAL.fire), clean: true }); // 바닥 균열·점·먼지 없이 속성 색 골짜기만
  for (const sd of [-1, 1]) { const ox = sd < 0 ? BX.x + 4 : BX.x + BX.w - 4, by = BX.y + BX.h - 4, f = (x, y) => [ox + sd * x, by - y]; p.fill([[...f(0, 0), ...f(0, 74), ...f(34, 50), ...f(64, 84), ...f(108, 34), ...f(150, 0)]], '#0a0608', 0.88); } // 앞쪽 바위 실루엣
  if (stage === 1) { // 방출: 하늘 틈의 빛이 기둥이 되어 골짜기를 환하게 밝힌다(몬스터 뒤라 몬스터는 또렷하다)
    p.roundRect(BX.x, BX.y, BX.w, BX.h, 14, sup ? '#fff4d0' : mixHex(t.hi, '#ffffff', 0.4), sup ? 0.18 : 0.26);
    p.fill([[cx - 34, BX.y + 4, cx + 34, BX.y + 4, cx + 100, BX.y + BX.h - 6, cx - 100, BX.y + BX.h - 6]], sup ? '#ffe9a8' : t.hi, 0.42);
    p.fill([[cx - 14, BX.y + 4, cx + 14, BX.y + 4, cx + 44, BX.y + BX.h - 6, cx - 44, BX.y + BX.h - 6]], '#ffffff', 0.55);
  }
  p.strokeRoundRect(BX.x, BX.y, BX.w, BX.h, 14, 1.5, C.frame);
  if (dim > 0) p.roundRect(BX.x, BX.y, BX.w, BX.h, 14, t.deep, dim);
}
// ── 아레나 옆면에서 밀고 나오는 띠(스킬 이름·에스카톤·다음 행동·속성 전환 공용) ──
const flagShapeR = (x, y, w, h, t) => [x, y, x + w - t, y, x + w, y + h / 2, x + w - t, y + h, x, y + h]; // 오른쪽만 뾰족(왼쪽 가장자리에서 나오는 판)
const flagShape = (x, y, w, h, t) => [x + t, y, x + w, y, x + w, y + h, x + t, y + h, x, y + h / 2]; // 왼쪽만 뾰족(오른쪽 가장자리에서 나오는 판)
const SIDE_L = 21, SIDE_R = W - 21; // 아레나 안쪽 가장자리 // 아레나 테두리 안쪽(테두리를 넘지 않게)
function sideCard(dir, y, w, h, tip, col, bg = '#120a06') { // 화면 옆 가장자리에서 밀고 나온 판. dir 'L' = 왼쪽, 'R' = 오른쪽. w = 아레나 안으로 보이는 길이. 반환: 글자를 넣을 안쪽 범위
  const E = dir === 'L' ? SIDE_L : SIDE_R, bleed = 27, tw = w + bleed, x = dir === 'L' ? E - bleed : E - w;
  const sh = (xx, yy, ww, hh, t) => dir === 'L' ? flagShapeR(xx, yy, ww, hh, t) : flagShape(xx, yy, ww, hh, t);
  const cy = y + h / 2;
  p.fill([sh(x, y, tw, h, tip)], mixHex(col, '#000000', 0.5)); const t1 = tip * (h - 2) / h, t3 = tip * (h - 6) / h; // 안쪽 판은 비스듬한 끝 선이 바깥과 나란하도록 끝 길이를 비례로 줄인다(어긋나면 모서리가 삐져나옴)
  p.fill([sh(x + 1, y + 1, tw - 2, h - 2, t1)], col); p.fill([sh(x + 3, y + 3, tw - 6, h - 6, t3)], bg);
  { const bh = (h - 6) * 0.4, dx = t3 * bh / ((h - 6) / 2), y0 = y + 3, y1 = y0 + bh; // 윗면 빛: 판의 비스듬한 끝 선을 따라가는 사다리꼴
    p.fill([dir === 'L' ? [x + 3, y0, x + tw - 3 - t3, y0, x + tw - 3 - t3 + dx, y1, x + 3, y1] : [x + 3 + t3, y0, x + tw - 3, y0, x + tw - 3, y1, x + 3 + t3 - dx, y1]], mixHex(bg, col, 0.2)); }
  const a = dir === 'L' ? E + 8 : x + tip + 4, b = dir === 'L' ? x + tw - tip - 4 : E - 8;
  for (let k = a; k + h - 8 < b; k += 9) p.line(k, y + h - 4, k + h - 8, y + 4, 1, mixHex(bg, col, 0.1)); // 안쪽 빗금 무늬
  return { x, x0: dir === 'L' ? E + 14 : x + tip + 8, x1: dir === 'L' ? x + tw - tip - 4 : E - 14, cy };
}
const ESC_T = { next: { tag: '필살기', title: '에스카톤 저지먼트', hint: '', gauge: (n) => `억제 ${n}/100`, ok: '억제 성공 가능', short: () => '억제 부족 — 전멸 위험' }, banner: { tag: '필살기', title: '에스카톤 저지먼트', win: '억제 성공 — 모두 버텨냈다', lose: '억제 실패 — 하늘이 모든 것을 삼켰다' } };
const ESC_BOX = { x: 20, y: 120, w: W - 40, h: 224 };
const escShape = (x, y, w, h, t) => [x + t, y, x + w - t, y, x + w, y + h / 2, x + w - t, y + h, x + t, y + h, x, y + h / 2]; // 양끝이 뾰족한 판
function escBrackets(col, inset = 6, len = 46, wd = 4) { // 상자 네 모서리의 꺾쇠(필살기 경고 틀)
  const B = ESC_BOX, x0 = B.x + inset, y0 = B.y + inset, x1 = B.x + B.w - inset, y1 = B.y + B.h - inset;
  for (const [x, y, dx, dy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) { p.line(x, y, x + dx * len, y, wd, col); p.line(x, y, x, y + dy * len, wd, col); }
}
function escCharge(cx, cy, el) { // 충전(선택 화면): 어두워진 속성 골짜기 + 필살기 경고 틀 — 몸의 핵은 몬스터 위에 따로 그린다
  escField(el, cx, cy, 0.3);
}
function escCore(cx, cy, el, power = 1) { // 몸 한가운데에서 차오르는 핵(몬스터 위에 그린다). power 1 = 충전, 1.7 = 터지기 직전, 2.4 = 방출
  const t = escTheme(el), y = cy + 6, k = power;
  for (const [r, c, al] of [[78, t.core, 0.1], [60, t.core, 0.13], [44, t.core, 0.17], [30, t.hi, 0.22], [18, t.hi, 0.3], [9, '#ffffff', 0.5]]) haze(cx, y, r * k * 0.8, c, al); // 단단한 원 없이 겹겹의 부드러운 빛번짐만
  p.circle(cx, y, 3 * k, '#ffffff');
}
function escBanner(sup, el) { // 결과 화면 필살기 띠: 왼쪽 옆면에서 밀고 나오는 판 — 이름 + 억제 성공/실패 칩
  const rim = sup ? '#8ec8ff' : '#ff4a3a', tw = Math.min(p.textWidth(B(), ESC_T.banner.title, 18), 160), cw = 72;
  const bw = Math.min(tw + cw + 70, 300), c = sideCard('L', 132, bw, 38, 18, rim, sup ? '#0a1626' : '#1c0608');
  engraved(ESC_T.banner.title, c.x0 + tw / 2, c.cy + 1, 18, mixHex(sup ? '#ffd870' : '#ff9a6a', '#ffffff', 0.45), { maxWidth: 160 });
  p.roundRect(c.x1 - cw, c.cy - 12, cw, 24, 5, sup ? '#7ee0a6' : '#ff6a5a'); p.strokeRoundRect(c.x1 - cw, c.cy - 12, cw, 24, 5, 1, mixHex(sup ? '#7ee0a6' : '#ff6a5a', '#ffffff', 0.5)); text(sup ? '억제 성공' : '억제 실패', c.x1 - cw / 2, c.cy, 15, '#10050c', { maxWidth: cw - 6 });
}
function alatNextBox(b, tele, warn, smash) { // 선택 화면 '다음 행동' 상자(알바트리온 전용): 오른쪽 옆면에서 밀고 나오는 판
  const A = require('./알바트리온'), el = b.alat.element;
  const col = warn ? '#ff4a3a' : (ELEMENT_COLOR[el] || '#c8c4d8');
  if (!smash) {
    // 결과 화면의 스킬 이름 띠(왼쪽)와 같은 모양의 얇은 한 줄 띠를 오른쪽에: 앞쪽 화살표 + 새긴 예고 문구. 박스·이름표 없이 글자만 크게
    const SZ = 22, avail0 = 262, tw = Math.min(p.textWidth(B(), tele, SZ), avail0), c = sideCard('R', 132, Math.min(tw + 66, 330), 38, 18, col);
    for (let k = 0; k < 3; k++) { const lx = c.x0 + k * 8, al = 1 - k * 0.3; p.line(lx, c.cy - 7, lx + 5, c.cy, 2, mixHex('#120a06', col, al)); p.line(lx + 5, c.cy, lx, c.cy + 7, 2, mixHex('#120a06', col, al)); }
    engraved(tele, c.x0 + 32 + tw / 2, c.cy + 1, SZ, mixHex(col, '#ffffff', 0.55), { maxWidth: avail0 });
    return;
  }
  // 필살기 예고: 같은 옆면에 두 줄짜리 붉은 판(이름 + 억제 게이지)
  const ratio = Math.max(0, Math.min(1, b.alat.gauge / A.K.GAUGE_MAX)), full = ratio >= 1;
  const c = sideCard('R', 130, 318, 66, 20, '#ff4a3a', '#140304'), top = c.cy - 16;
  p.roundRect(c.x0, top - 12, 60, 24, 5, '#ff9a6a'); text(ESC_T.next.tag, c.x0 + 30, top, 17, '#10050c');
  engraved(ESC_T.next.title, c.x0 + 68 + (c.x1 - c.x0 - 68) / 2, top + 1, 20, '#ffd9c8', { maxWidth: c.x1 - c.x0 - 74 });
  const gx = c.x0, gw = 70, gy = c.cy + 8; // 억제 게이지(가득 차야 버틴다)
  p.roundRect(gx - 2, gy - 2, gw + 4, 14, 5, '#050102'); p.roundRect(gx, gy, Math.max(0, gw * ratio), 10, 4, full ? '#7ee0a6' : '#ff6a5a'); p.rect(gx + gw - 2, gy - 4, 3, 18, '#ffffff');
  text(ESC_T.next.gauge(Math.round(b.alat.gauge)), gx + gw + 8, gy + 5, 16, '#ffd9c8', { align: 'left' });
  text(full ? '성공 가능' : '전멸 위험', c.x1, gy + 5, 16, full ? '#7ee0a6' : '#ff7a6a', { align: 'right' });
}
// 결과 화면(몬스터 위에 얹는 부분): 핵의 빛과 가는 가장자리 빛만. 화면·카드를 덮는 막이나 몸을 가로지르는 선은 쓰지 않는다(억제 성공은 띠 색과 따뜻한 빛으로 구분). stage 0 임계 · 1 방출 · 2 식음 · 3 여운
function escFlash(stage, cx, cy, sup, el, targets = []) { // 방출·식음·여운은 매번 같은 그림이라 칸 목록을 저장해 재사용한다(첫 번째만 계산)
  pixCacheCtx = stage >= 1 ? { key: `esc:${stage}:${el}:${sup ? 1 : 0}`, n: 0 } : null;
  try { escFlashBody(stage, cx, cy, sup, el, targets); } finally { pixCacheCtx = null; }
}
function escFlashBody(stage, cx, cy, sup, el, targets = []) {
  // 에스카톤 저지먼트 결과 연출 — 몬헌 월드 영상(모으기 18~27초 → 방출 27.5초~)을 도트로 옮김.
  // 모으기 끝(stage 0): 어두운 붉은 하늘 · 바닥이 용암처럼 달아오름 · 곳곳에서 불기둥 · 가슴의 핵이 붉게 빛남
  // 방출(stage 1): 사방에서 불똥 구슬이 튀고 → 노랗고 하얀 불덩이가 화면을 뒤덮고 → 세로로 치솟는 불길 장막이 전장 전체를 채움
  // 식음(stage 2): 불기둥과 불길이 둘레에 남고 바닥이 계속 타오름 · 여운(stage 3): 바닥의 불과 불씨
  // 속성이 달라지면 같은 구조를 그 속성 램프(물·번개·얼음·용)로 칠한다. 모두 2px 도트(램프·디더링·외곽선).
  const key = ALAT_RAMP[el] ? el : 'fire', pal = ALAT_RAMP[key], line = ALAT_LINE[key], br = BREATH[key], ice = ALAT_RAMP.ice;
  const pal6 = key === 'fire' ? FIRE6 : key === 'dragon' ? DRAGON6 : [pal[1], pal[2], pal[3], pal[4], pal[5], pal[6]];
  const ex = cx, ey = cy + 6, rnd = seedRng(900 + stage * 13), K = stage * 7, WALL_Y = 352, G = 2;
  const clampY = sup ? WALL_Y - 2 : H; // 억제 성공이면 방벽 아래(카드 줄)는 불길이 닿지 않는다
  // 속성 구슬(도트 구체): 왼쪽 위 광원의 구형 음영(램프+디더링) · 가장자리의 어두운 테두리 · 흰 하이라이트 · 바깥으로 디더링되며 번지는 빛무리.
  const orb = (buf, x, y, R, k, pl = pal, dim = 1, swirl = 0) => { // swirl: 구 안에서 소용돌이치는 결(디더링 띠)의 세기
    const HALO = R < 8 ? 2.2 : 1.9;
    buf.paint(x - R * HALO, y - R * HALO, x + R * HALO, y + R * HALO, (px, py, i, j) => {
      if (py > clampY) return null;
      const dx = (px - x) / R, dy = (py - y) / R, d = Math.hypot(dx, dy), n = fbm(px / 13 + k, py / 13 - k * 0.7, k) - 0.5, rr = d + n * 0.22;
      if (rr > 1) { // 빛무리: 구 바깥으로 갈수록 성기게(바이어 디더링) — 은은히 번진다
        const t = (rr - 1) / (HALO - 1); if (t >= 1) return null;
        return bay(i, j) < Math.pow(1 - t, 2.2) * 0.62 * dim ? ramp(pl, 0.22 + (1 - t) * 0.4, i, j) : null;
      }
      if (Math.hypot(dx + 0.34, dy + 0.4) < 0.17) return '#ffffff'; // 하이라이트(광원 쪽 작은 반사점)
      const nz = Math.sqrt(Math.max(0, 1 - Math.min(1, d * d))), lam = Math.max(0, -dx * 0.42 - dy * 0.5 + nz * 0.76); // 구의 밝은 쪽
      let t = 0.2 + lam * 0.62 + (1 - d) * (1 - d) * 0.32 + n * 0.16 + (swirl ? swirl * Math.sin(Math.atan2(dy, dx) * 3 + d * 15 + k * 0.7 + n * 3) * (0.4 + d) : 0); // 가운데가 뜨거운 핵 + 광원 쪽이 밝은 면
      if (rr > 0.8) t = Math.min(t, 0.06 + (1 - rr) / 0.2 * 0.24); // 가장자리는 어두운 테두리로 눌러 윤곽을 잡는다
      return ramp(pl, t * dim, i, j);
    });
  };
  // 전장을 채우는 불길 장막: 세로로 길게 늘인 노이즈(불 혀) + 아래가 뜨겁고 위가 성긴 높이 분포. cover 0~1 = 화면을 덮는 정도
  const inferno = (buf, cover, hot, k, yMax = H) => buf.paint(0, 0, W, Math.min(yMax, clampY), (px, py, i, j) => {
    const yy = py / H, tongue = fbm(px / 20, py / 110 - k * 0.6, k + 2) - 0.5, puff = fbm(px / 70, py / 60, k + 5) - 0.5, r = Math.hypot(px - ex, (py - ey) * 1.3);
    let I = cover * (0.28 + 0.9 * Math.pow(yy, 0.9)) + tongue * 1.15 + puff * 0.55 + hot * Math.exp(-(r * r) / (2 * 190 * 190));
    I += (bay(i, j) - 0.5) * 0.1;
    if (I < 0.34) return null;
    const s0 = Math.min(1, 0.18 + (I - 0.34) * 1.15);
    return ramp(pal, s0, i, j);
  });
  const lava = (buf, y0) => buf.paint(20, y0, W - 20, 344, (px, py, i, j) => { // 달아오른 바닥: 어두운 암반 + 밝은 용암 줄기
    const n = fbm(px / 34, py / 16, 11), vein = 1 - Math.min(1, Math.abs(n - 0.5) * 7.5), f = (py - y0) / (344 - y0);
    const fade = Math.min(1, f * 2.6); if (fade < 0.08 + bay(i, j) * 0.92) return null; // 위쪽 경계는 디더링으로 스며들게(띠가 붙은 것처럼 보이지 않게)
    return ramp(pal, 0.18 + vein * 0.62 + f * 0.18 + (fbm(px / 9, py / 9, 12) - 0.5) * 0.2, i, j);
  });
  const embers = (n, y0, y1, big) => { for (let k = 0; k < n; k++) { const x = rnd() * W, y = y0 + rnd() * (y1 - y0), c = br.mote[k % 4]; if (y > clampY) continue; if (big && k % 6 === 0) { p.rect(Math.round(x / 2) * 2 - 2, Math.round(y / 2) * 2, 6, 2, c); p.rect(Math.round(x / 2) * 2, Math.round(y / 2) * 2 - 2, 2, 6, c); } else p.rect(Math.round(x / 2) * 2, Math.round(y / 2) * 2, 2 + (k % 3 === 0 ? 2 : 0), 2 + (k % 3 === 0 ? 2 : 0), c); } };
  const glowBalls = (n) => { const buf = pixBuf(G); for (let k = 0; k < n; k++) { const x = 30 + rnd() * (W - 60), y = 50 + rnd() * 330; orb(buf, x, y, 5 + rnd() * 9, K + k, pal); } buf.flush(null); }; // 사방으로 튀는 불똥 구슬
  const pillars = (n, hMin, hMax, w) => { const buf = pixBuf(G); for (let k = 0; k < n; k++) pxFire(buf, 50 + (k + 0.3 + rnd() * 0.4) * ((W - 100) / n), 340 + rnd() * 4, w, hMin + rnd() * (hMax - hMin), pal6, K + k * 5, (rnd() - 0.5) * 0.7); buf.flush(line); };
  // 용뢰(참고영상): 모으기 — 몸의 핵이 붉은 에너지 구가 되고 그 안에서만 흰 번개가 지직거린다(영상 23~26초) /
  // 방출 첫 순간 — 하늘에서 몸을 지나 바닥까지 내리꽂는 흰 낙뢰와 붉은 빛무리(영상 27.5초). 검은 외곽선 없이 흰 심 → 분홍 → 붉은 디더링 빛무리로 불과 섞는다
  const RYU = ['#3a0610', '#7a0c1c', '#c0142c', '#e8283c', '#ff5a6a', '#ffb4bc', '#fff4f4'];
  const glowLine = (paths, coreW, haloR, inside = null, deep = false) => {
    const cells = new Map();
    for (const pts of paths) for (let s = 0; s < pts.length - 1; s++) { const [ax, ay] = pts[s], [bx, by] = pts[s + 1], n = Math.ceil(Math.hypot(bx - ax, by - ay)); for (let q = 0; q <= n; q++) { const i = Math.floor((ax + (bx - ax) * q / n) / G), j = Math.floor((ay + (by - ay) * q / n) / G); cells.set(i * 4096 + j, [i, j]); } }
    const dist = new Map();
    for (const [i, j] of cells.values()) for (let dj = -haloR; dj <= haloR; dj++) for (let di = -haloR; di <= haloR; di++) { const d = Math.hypot(di, dj); if (d > haloR) continue; const k = (i + di) * 4096 + j + dj, o = dist.get(k); if (!o || d < o[2]) dist.set(k, [i + di, j + dj, d]); }
    const buf = pixBuf(G);
    for (const [i, j, d] of dist.values()) {
      const x = i * G + 1, y = j * G + 1; if (y > clampY || (inside && !inside(x, y))) continue;
      if (d <= coreW) buf.set(i, j, '#ffffff');
      else if (d <= coreW + 1.2) buf.set(i, j, RYU[5]);
      else { const t = (d - coreW - 1.2) / (haloR - coreW - 1.2); if (bay(i, j) < Math.pow(1 - t, deep ? 1.1 : 1.6) * (deep ? 0.95 : 0.85)) buf.set(i, j, deep ? (t < 0.25 ? RYU[4] : t < 0.6 ? RYU[3] : RYU[2]) : (t < 0.4 ? RYU[4] : RYU[3])); }
    }
    buf.flush(null);
  };
  // 속성 구슬: 불 구슬과 같은 모양·도트로, 일부만 용(붉은 구 속 흰 번개)·빙(푸른 구 속 결정 반짝임)·뢰(노란 구 속 흰 번개)가 된다. 모으기의 붉은 구와 같은 모양말이라 따로 놀지 않는다
  const ICE_ORB = ['#0e2c4c', '#1f5a8e', '#3a8ac8', '#6cc0ec', '#b4e6fa', '#e6f8ff', '#ffffff'];
  const ORB6 = { fire: FIRE6, dragon: ['#3a0610', '#7a0c1c', '#c0142c', '#ff5a6a', '#ffb4bc', '#fff4f4'], ice: ['#0e2c4c', '#1f5a8e', '#3a8ac8', '#6cc0ec', '#b4e6fa', '#ffffff'], thunder: ['#3a2a00', '#7a5a00', '#c89a10', '#ffe040', '#fff59a', '#ffffff'] };
  const elemOrbs = (n, rMin, rMax, dim = 1, big = 0) => {
    const kinds = ['fire', 'fire', 'dragon', 'fire', 'ice', 'fire', 'thunder'], list = [];
    for (let q = 0; q < n; q++) { const kd = kinds[q % kinds.length], R = q < big ? rMax + 4 + rnd() * 6 : rMin + rnd() * (rMax - rMin), x = 30 + rnd() * (W - 60), y = 50 + rnd() * 290; if (y + R > clampY) continue; list.push([kd, x, y, R, q]); }
    // 불꽃: 구슬마다 그 속성 색의 불꽃이 위로 타오른다(구슬이 불덩이처럼 보이게). 빙은 끝에 서리 결정, 뢰는 둘레에 튀는 불꽃 알갱이
    const fb = pixBuf(G);
    for (const [kd, x, y, R, q] of list) if (R >= 5) pxFire(fb, x, y + R * 0.55, R * 2.1, R * (2.4 + (q % 3) * 0.4) * dim, ORB6[kd], K + q * 3 + 90, (q % 2 ? -1 : 1) * 0.35);
    fb.flush(null);
    const buf = pixBuf(G);
    for (const [kd, x, y, R, q] of list) orb(buf, x, y, R, K + q + 70, kd === 'dragon' ? RYU : kd === 'ice' ? ICE_ORB : kd === 'thunder' ? ALAT_RAMP.thunder : pal, dim);
    buf.flush(null);
    for (const [kd, x, y, R] of list) { if (kd === 'fire' || R < 7) continue; const inR = (xx, yy) => Math.hypot(xx - x, yy - y) < R * 0.9;
      if (kd === 'ice') { const sb = pixBuf(G); for (const a of [0, Math.PI / 3, -Math.PI / 3]) for (let t = -R * 0.6; t <= R * 0.6; t += 1) { const xx = x + Math.cos(a) * t, yy = y + Math.sin(a) * t; sb.set(Math.floor(xx / G), Math.floor(yy / G), Math.abs(t) < R * 0.25 ? '#ffffff' : ICE_ORB[5]); } sb.flush(null);
        for (let c = 0; c < 2; c++) pxFlake(x + (rnd() - 0.5) * R * 1.6, y - R * (1.8 + rnd() * 1.4), false, '#ffffff', ICE_ORB[4]); } // 결정 반짝임 + 불꽃 끝에 맺힌 서리
      else { const crk = []; for (let c = 0; c < 2; c++) { const a = rnd() * 6.28; crk.push(zigzag(x + Math.cos(a) * R * 0.15, y + Math.sin(a) * R * 0.15, x + Math.cos(a + 2.4) * R * 0.75, y + Math.sin(a + 2.4) * R * 0.75, rnd, 4, R * 0.4)); } glowLine(crk, 0, 1, inR);
        if (kd === 'thunder') for (let c = 0; c < 6; c++) { const a = rnd() * 6.28, rr = R * (1.1 + rnd() * 0.6); p.rect(Math.round((x + Math.cos(a) * rr) / 2) * 2, Math.round((y + Math.sin(a) * rr) / 2) * 2, 2, 2, c % 2 ? '#ffffff' : '#fff59a'); } } } // 구 안의 흰 번개(뢰는 둘레에 튀는 불꽃 알갱이)
  };
  if (stage === 0) { // 모으기 끝: 용암 바닥 · 바닥을 따라 일렁이는 불길 · 붉게 달아오른 핵
    alatTint(key, 0.05, 0.12);
    dotGlow(ex, ey, 300, 190, br.glow[0], 0.2); dotGlow(ex, ey, 160, 110, br.glow[1], 0.26);
    dotGlow(ex, ey, 96, 74, RYU[2], 0.24); // 핵 둘레가 붉게 물든다
    { const buf = pixBuf(G); orb(buf, ex, ey, 34, K, ['#3a0808', '#8a1410', '#d03a14', '#ff7a2a', '#ffb347', '#ffe9a8', '#ffffff'], 1, 0.11); buf.flush(null); } // 에너지 구: 임계 직전의 용암빛(붉은 주황 → 금빛 핵) + 안쪽에서 소용돌이치는 디더링 결
    { const crk = []; for (let q = 0; q < 4; q++) { const a = rnd() * 6.28, r0 = 4 + rnd() * 8, r1 = 26 + rnd() * 16; crk.push(zigzag(ex + Math.cos(a) * r0, ey + Math.sin(a) * r0, ex + Math.cos(a + (rnd() - 0.5)) * r1, ey + Math.sin(a + (rnd() - 0.5)) * r1 * 0.8, rnd, 5, 12)); }
      glowLine(crk, 0, 3, (x, y) => Math.hypot(x - ex, y - ey) < 44); } // 구 안에서만 지직거리는 흰 번개
    embers(36, 130, 330, false);
  } else if (stage === 1) { // 방출: 불똥 → 불덩이가 화면을 삼킴 → 불길 장막
    alatTint(key, 0.05, 0.08);
    p.roundRect(0, 0, W, H, 0, '#1a0606', 0.4); // 어둡게 눌러 폭발이 도드라지게
    const BH = Math.min(H, clampY), SMOKE = ['#1a0d0a', '#2e1610', '#4a1a10'];
    // 불덩이 한 개: 가장자리가 울퉁불퉁하게 부풀고(노이즈로 휘어진 윤곽), 안쪽은 난류가 소용돌이치는 램프(흰 핵 → 노랑 → 주황 → 붉음), 바깥은 연기·그을음이 디더링으로 번진다.
    const fireball = (cx, cy, R, seed, pl0, heat = 1, smoke = true, pat = null) => { const buf = pixBuf(G), M = R * 1.55;
      buf.paint(cx - M, Math.max(0, cy - M), cx + M, Math.min(BH, cy + M), (px, py, i, j) => {
        const dx = px - cx, dy = (py - cy) * 1.05, r = Math.hypot(dx, dy), th = Math.atan2(dy, dx);
        const warp = fbm(px / 60 + seed, py / 60, seed) - 0.5, lobe = fbm(Math.cos(th) * 1.7 + seed, Math.sin(th) * 1.7, seed + 4) - 0.5, edge = R * (0.8 + warp * 0.55 + lobe * 0.7);
        if (r < edge) {
          const t = 1 - r / edge, sw = fbm(px / 15 + warp * 4, py / 15 - warp * 4, seed + 2) - 0.5, rays = Math.sin(th * 9 + lobe * 6) * 0.045 * (1 - t); // 소용돌이 난류 + 가장자리에서 바깥으로 흐르는 가는 결
          const pv = pat ? pat(px, py, i, j, t) : 0; if (typeof pv === 'string') return pv; // 속성 무늬가 색을 직접 지정하면(번개의 하늘색) 그대로 쓴다
          const I = (t * 0.88 + 0.1 + sw * 0.5 + rays) * heat + pv, pl = typeof pl0 === 'function' ? pl0(t, i, j, px, py) : pl0;
          return I < 0.1 && smoke ? SMOKE[Math.min(2, Math.floor(bay(i, j) * 3))] : ramp(pl, I, i, j);
        }
        if (!smoke) return null; const h = (r - edge) / (R * 0.55); // 바깥 연기 고리: 그을음 갈색이 성기게
        return h < 1 && bay(i, j) < Math.pow(1 - h, 1.8) * 0.8 ? SMOKE[Math.min(2, Math.floor(bay(i + 1, j + 2) * 3))] : null;
      }); buf.flush(null); };
    // 속성 표현: 색은 불꽃색 그대로 두고, 불덩이 바깥쪽 결(디더링 무늬)로 속성을 나타낸다. 화면 위치에 따라 완만하게 속성이 바뀌고(저주파 노이즈) 경계는 디더링으로 풀린다.
    //   용 = 어두운 균열 + 갈라진 틈의 열기 · 불 = 무늬 없음 · 번개 = 흰 번개 결(가는 능선) · 얼음 = 격자 결정 + 서리 알갱이 · 물 = 겹겹의 물결 파문
    const pat = (px, py, i, j, t) => {
      const amp = Math.max(0, Math.min(1, (0.86 - t) / 0.45)); if (amp <= 0) return 0; // 가운데 핵은 깨끗하게(번개·얼음은 amp와 상관없이 또렷하게 그린다)
      const nn = Math.max(0, Math.min(1, (fbm(px / 300 + 3, py / 260, K + 17) - 0.3) / 0.4)), jt = (bay(i, j) - 0.5) * 0.1, kk = [0.14, 0.41, 0.7, 0.85].filter(T => nn + jt > T).length; // 속성 구간 비율: 용 14% · 불 27% · 번개 29% · 얼음 15% · 물 15%(경계는 디더링으로 풀린다)
      if (kk === 0) { const e = Math.abs(fbm(px / 26, py / 26, K + 30) - 0.5); return e < 0.028 ? -0.42 * amp : e < 0.05 ? 0.22 * amp : 0; }
      if (kk === 2) { // 번개: 몸 중심에서 바깥으로 지그재그로 튀는 방전 줄기 — 반지름 방향으로 길게 늘인 노이즈 능선 + 반지름마다 꺾이는 흔들림 + 중간중간 끊김
        const dx = px - ex, dy = (py - ey) * 1.08, r = Math.hypot(dx, dy), th = Math.atan2(dy, dx);
        const zig = (fbm(r / 15 + 3, th * 2.5, K + 41) - 0.5) * 1.1, e = Math.abs(fbm(th * 7 + zig, r / 150, K + 40) - 0.5), seg = fbm(r / 52 + 9, th * 4, K + 50) > 0.5;
        const v = e * (260 / Math.max(r, 130)) * (seg ? 1 : 3.2); // 먼 곳일수록 가늘게, 끊긴 구간은 거의 사라진다
        if (v < 0.011) return '#ffffff';
        if (v < 0.022) return '#d6f1ff'; // 연한 하늘빛 흰색
        if (v < 0.038) return bay(i, j) < 0.55 ? '#7cc8ff' : '#3c94f0'; // 하늘색 → 파랑 테두리
        if (v < 0.075) return bay(i, j) < (0.075 - v) / 0.037 * 0.75 ? 0.3 : 0; // 줄기 둘레가 번쩍이며 밝아지는 빛무리
        return 0;
      }
      if (kk === 3) return 0; // 얼음은 가운데가 아니라 화면 테두리가 살짝 어는 것으로 표현한다(아래 frostEdge)
      if (kk === 4) { const rp = Math.sin(Math.hypot(px - ex, (py - ey) * 1.1) / 7 + (fbm(px / 50, py / 50, K + 5) - 0.5) * 7); return rp > 0.78 ? 0.22 * amp : rp < -0.86 ? -0.16 * amp : 0; }
      return 0;
    };
    for (let q = 0; q < 10; q++) fireball(40 + rnd() * (W - 80), 150 + rnd() * (H - 190), 90 + rnd() * 70, 20 + q * 7, pal, 0.95, true, pat); // 화면 곳곳에서 번지는 불덩이들
    fireball(ex, ey, 560, 3, pal, 1.05, true, pat); // 화면 전체를 삼키는 주 불덩이
    fireball(ex - 6, ey - 4, 170, 9, [pal[3], pal[4], pal[5], pal[6], '#ffffff'], 1.1, false); // 뜨거운 핵(흰빛)
    { const buf = pixBuf(G); // 충격파 고리 세 겹: 앞쪽(바깥) 가장자리는 흰 심으로 밝고 뒤쪽으로 갈수록 붉게 흐려지는 디더링 띠 — 군데군데 노이즈로 끊어져 찢긴 파동처럼 보인다
      buf.paint(0, 0, W, BH, (px, py, i, j) => {
        const r = Math.hypot(px - ex, (py - ey) * 1.08);
        for (const [R0, w] of [[300, 18], [450, 26], [610, 32]]) {
          const d = r - R0; if (d < -w || d > w * 0.3) continue;
          const gap = fbm(px / 34 + R0, py / 34, K + R0 / 50) > 0.34 ? 1 : 0.3, t = (d + w) / (w * 1.3); // t: 0(뒤쪽 끝) → 1(앞쪽 가장자리)
          if (d > -w * 0.08 && d < w * 0.12 && gap === 1) return '#ffffff'; // 앞쪽 가장자리의 흰 심
          if (bay(i, j) < Math.pow(t, 1.6) * 1.15 * gap) return ramp([pal[1], pal[2], pal[3], pal[4], pal[5]], t, i, j);
          if (d > w * 0.12 && bay(i, j) < 0.35) return pal[1]; // 앞쪽 바깥에 남는 어두운 잔상 알갱이
        }
        return null;
      }); buf.flush(null); }
    { const buf = pixBuf(G), N = 96, sp = Array.from({ length: N }, (_, n) => ({ a: (n + rnd()) / N * 6.2832, r0: 130 + rnd() * 230, L: 140 + rnd() * 420, w: 1.3 + rnd() * 2.4, on: rnd() < 0.62 })); // 충격 줄기: 몸에서 바깥으로 뻗는, 끝이 뾰족하게 줄어드는 도트 줄기(머리는 흰색 → 꼬리로 갈수록 붉고 성김)
      buf.paint(0, 0, W, BH, (px, py, i, j) => {
        const dx = px - ex, dy = (py - ey) * 1.08, r = Math.hypot(dx, dy); if (r < 120) return null;
        const th = (Math.atan2(dy, dx) + 6.2832) % 6.2832, b0 = Math.floor(th / 6.2832 * N);
        for (let o = -1; o <= 1; o++) {
          const m = sp[(b0 + o + N) % N]; if (!m.on) continue;
          const u = (r - m.r0) / m.L; if (u < 0 || u > 1) continue;
          let da = Math.abs(th - m.a); if (da > 3.1416) da = 6.2832 - da;
          const half = m.w * (1 - u * 0.85), perp = r * Math.sin(da); // 폭: 시작이 굵고 끝으로 갈수록 가늘게
          if (perp > half) continue;
          const core = perp < half * 0.4; // 가운데 심은 밝게
          if (bay(i, j) > (1 - u) * 1.1 + 0.08) continue; // 끝으로 갈수록 디더링으로 흩어진다
          return core ? (u < 0.5 ? '#ffffff' : pal[5]) : (u < 0.55 ? pal[4] : pal[2]);
        }
        return null;
      }); buf.flush(null); }
    embers(60, 0, 620, true);
    if (sup) { // 억제 성공: 카드 위에 육각 무늬 방벽이 불길을 막는다
      const buf = pixBuf(G); buf.paint(0, 324, W, 384, (px, py, i, j) => { const yb = WALL_Y + Math.sin(px / 46) * 5, d = Math.abs(py - yb); if (d > 12) return null; return ramp(ice, 0.95 - d / 12 * 0.45 + (((i + (j & 1) * 2) % 5 === 0) ? 0.1 : 0), i, j); }); buf.flush('#0a2440');
      const sb = pixBuf(G); for (const [tx] of targets) pxBurst(sb, tx, WALL_Y, 34, ice, rnd); sb.flush('#0a2440');
      dotGlow(W / 2, WALL_Y, 440, 70, '#9ad0ff', 0.6);
    } else { // 전멸: 카드마다 불길이 덮치고 가장자리가 붉게
      alatTint('fire', 0.05, 0.1);
    }
  } else if (stage === 2) { // 식음: 옅은 불길 줄기와 붉은 핵, 카드에 남은 그을음
    alatTint(key, 0.04, 0.12);
    dotGlow(ex, ey, 300, 190, br.glow[0], 0.4);
    { const buf = pixBuf(G); // 식어 가는 열기: 바닥에서 올라오는 붉은 기운이 위로 갈수록 디더링으로 성기게 사라지고, 위쪽엔 연기
      buf.paint(0, 112, W, Math.min(H, clampY), (px, py, i, j) => {
        const f = (py - 112) / (H - 112), n = fbm(px / 46, py / 30 - K * 0.3, K + 4) - 0.5, heat = Math.pow(f, 1.6) * 0.95 + n * 0.3 - 0.12, smoke = (1 - f) * 0.35 + n * 0.25 - 0.12;
        if (heat > 0.08 && bay(i, j) < heat * 1.1) return ramp(pal, 0.1 + heat * 0.65, i, j);
        if (smoke > 0.05 && bay(i, j) < smoke) return ['#0e0706', '#1c0d0a', '#2e1610'][Math.min(2, Math.floor(bay(i, j) * 3))];
        return null;
      }); buf.flush(null); }
    embers(80, 100, 560, false); // 식음: 이미 방출한 뒤라 입(몸 중심)의 불덩이는 그리지 않는다
    if (sup) { const buf = pixBuf(G); buf.paint(0, 330, W, 372, (px, py, i, j) => { const yb = WALL_Y + Math.sin(px / 46) * 5, d = Math.abs(py - yb); return d > 6 || bay(i, j) > 0.5 ? null : ramp(ice, 0.8 - d / 12, i, j); }); buf.flush(null); }
  } else { // 여운: 바닥에 남은 불과 불씨
    alatTint(key, 0.03, 0.1);
    embers(50, 100, 560, false);
  }
}

// 알바트리온 분노(몬스터 뒤): 검붉은 열기 + 떠오르는 붉은 불씨. 등 뒤 불길과 몸 둘레 윤곽선은 그리지 않는다(분노 외형은 붉은 눈·날개 균열이 맡는다).
function alatRageAura(cx, cy) {
  const rnd = seedRng(energyTick + 21);
  haze(cx, cy + 10, 170, '#8a0a14', 0.12); haze(cx, cy + 14, 112, '#c8141c', 0.12);
  for (let i = 0; i < 24; i++) dot(cx + (rnd() - 0.5) * 350, cy - 76 + rnd() * 160, 3 + Math.floor(rnd() * 3), i % 3 ? '#ff4a3a' : '#ffb090');
}

// 몬스터: sprite(픽셀 아트). maxH 안에 맞춘다. gray: 결과 화면용 흑백.
// (그림 파일 몬스터는 PNG 해석기가 필요해 아직 지원하지 않는다 — 넣을 때 그림판.js에 추가)
// pose: 기술 키(sprite.poses) — 없으면 평상시 얼굴(분노면 sprite.rageRows).
// outline: 외곽선(a) 색을 바꿔 칠한다(보호막으로 단단해진 몸).
function drawMonster(monster, cx, cy, maxH, { rage = false, gray = false, pose = null, outline = null, dormant = false, element = null } = {}) {
  const sp = monster.sprite;
  if (!sp) return;
  // dormant(흉성의 용뢰가 빠진 돌덩이 상태): sprite.dormantRows/dormantColors 로 그리고, 번개·후광·몸 색 변화는 모두 끈다.
  const isDormant = monster.theme === 'energy' && (dormant || process.env.ENERGY_DORMANT === '1') && !!sp.dormantRows;
  const rows = isDormant ? sp.dormantRows : (pose && sp.poses?.[pose]) || (rage && sp.rageRows) || sp.rows;
  const elementColors = element && sp.elementColors?.[element] ? sp.elementColors[element] : null; // 알바트리온: 지금 속성에 맞는 몸 색
  const poseColors = pose && sp.poseColors?.[pose] ? sp.poseColors[pose] : null; // 알바트리온: 기술 자세마다 입 속·뿔 빛 색(쓰는 기술 속성)
  const colors0 = isDormant ? { ...sp.dormantColors, ...(outline ? { a: outline } : {}) } : (rage || outline || elementColors || poseColors ? { ...(rage ? sp.rageColors : {}), ...elementColors, ...poseColors, ...(outline ? { a: outline } : {}) } : null);
  const colors = rage && monster.alat && colors0 ? { ...colors0, e: '#ff2a2a' } : colors0; // 알바트리온 분노: 속성과 상관없이 눈이 붉게 타오른다
  // sprite.scale: 몬스터마다 그림 크기 배율(기본 1). 칸 수가 많아 작아 보이는 몬스터를 키울 때 쓴다.
  const cell = Math.floor((maxH * (sp.scale ?? 1)) / rows.length);
  // 용뢰 테마(흉성): 몸 뒤에 붉은 후광과 무작위 번개를 그린다. 그릴 때마다 시드가 달라 화면마다 모양이 바뀐다. 흑백(결과·쓰러짐)엔 그리지 않는다.
  let tint = null;
  if (monster.theme === 'energy' && !gray && !isDormant) {
    const intensity = drawEnergy((x, y, w, h, c) => p.rect(x, y, w, h, c), cx, cy, rows[0].length / 2, cell, ++energyTick, rage);
    tint = bodyTint({ ...sp.palette, ...colors }, ['a', 'h', 'o', 'b', 'd'], intensity, rage ? 1.6 : 1); // 번개가 많이 퍼진 화면일수록 몸이 아주 조금 붉어진다
  }
  if (isDormant && !gray) { // 땅에 박힌 돌덩이 뒤에서 용뢰를 은은하게 모으는 연출(몸 중심은 sprite.dormantCenter 칸 오프셋)
    const [ox, oy] = sp.dormantCenter ?? [0, 0];
    drawFaint((x, y, w, h, c) => p.rect(x, y, w, h, c), cx + ox * cell, cy + oy * cell, sp.dormantBodyR ?? rows[0].length / 2, cell, ++energyTick, sp.dormantGroundDy);
  }
  drawPixels({ ...sp, rows }, cx, cy, cell, { dim: gray, colors: tint ? { ...colors, ...tint } : colors });
  if (element && !gray && !isDormant && monster.alat) alatBodyFx(element, cx, cy, cell, rows, rage);
}
// ── 습격 연출 ───────────────────────────────────────────────────────────────
// 몬스터 칸(그림 틀 안쪽) 범위: 이 안에서만 그린다(HP 바·카드를 덮지 않게).
const FX_BOX = { x0: 30, y0: 128, x1: 870, y1: 338 }; // 설계 좌표(900×640) 기준 몬스터 칸 안쪽
const seedRng = (n) => { let s = (n * 9301 + 49297) % 233280; return () => ((s = (s * 9301 + 49297) % 233280) / 233280); };
const SKY_BOX = { x0: 0, y0: 0, x1: W, y1: 340 }; // 습격 예고 혜성이 움직이는 범위: 몬스터 칸에 갇히지 않고 위쪽(HP 바·이름 줄)까지 화면 하늘 전체
const clampBox = (x, y, box = FX_BOX) => [Math.min(box.x1, Math.max(box.x0, x)), Math.min(box.y1, Math.max(box.y0, y))];
const inBox = (x, y) => x >= FX_BOX.x0 && x <= FX_BOX.x1 && y >= FX_BOX.y0 && y <= FX_BOX.y1;
// 칸 단위(G px) 도트로 영역을 칠한다. colorAt(x, y) 가 null 이면 비움. 몬스터 칸 밖은 그리지 않는다.
function cellPaint(G, colorAt, box = FX_BOX) {
  for (let y = box.y0; y < box.y1; y += G) for (let x = box.x0; x < box.x1; x += G) { const c = colorAt(x + G / 2, y + G / 2); if (c) p.rect(x, y, G, G, c); }
}
const hash2 = (x, y, k = 0) => { const v = Math.sin(x * 12.9898 + y * 78.233 + k * 37.719) * 43758.5453; return v - Math.floor(v); };
// 지그재그 번개 줄기(붉은 심 + 밝은 속) — 몬스터 칸 안으로 잘라 그린다
function skyBolt(x0, y0, x1, y1, rnd, w = 5, box = FX_BOX) {
  const pts = [[x0, y0]], n = 6, dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1;
  for (let i = 1; i < n; i++) { const t = i / n, o = (rnd() - 0.5) * 30; pts.push([x0 + dx * t - dy / L * o, y0 + dy * t + dx / L * o]); }
  pts.push([x1, y1]);
  const cp = pts.map(([x, y]) => clampBox(x, y, box));
  for (const [ww, c] of [[w + 6, '#5a0f18'], [w + 2, '#e8203a'], [Math.max(2, w - 2), '#ffd8d0']])
    for (let i = 0; i < cp.length - 1; i++) p.line(cp[i][0], cp[i][1], cp[i + 1][0], cp[i + 1][1], ww, c);
}

// 습격 예고(선택 화면): 알 수 없는 큰 불덩이가 하늘(오른쪽 위)에서 몬스터 쪽으로 곧장 내려온다.
// 머리는 어두운 핵 + 붉은 테두리 + 둘레의 용뢰, 꼬리는 줄무늬 진 붉은 에너지에서 잿빛 연기로 흐려지며 칸 밖 위쪽으로 길게 이어진다.
function ambushSky(cx, cy) {
  const seed = ++energyTick, rnd = seedRng(seed), G = 5, K = 0.84; // K: 혜성 전체 크기 배율(사용자 요청: 구도는 그대로, 크기만 줄임)
  const hx = cx + 188, hy = cy - 92;           // 머리: 몬스터 칸 오른쪽 위(칸 안), 꼬리는 칸 밖 하늘에서 시작한다
  const sx = hx + 330, sy = -90;               // 꼬리 시작(화면 밖 오른쪽 위)
  const dx = hx - sx, dy = hy - sy, L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L;
  haze(hx, hy, 76 * K, '#ff3a2a', 0.24); // 바깥 음영 테두리(번짐)

  cellPaint(G, (x, y) => {
    const rx = x - sx, ry = y - sy, t = (rx * ux + ry * uy) / L; // 0 = 꼬리 끝, 1 = 머리
    if (t < 0 || t > 1.02) return null;
    const d = Math.abs(rx * -uy + ry * ux);
    const w = (12 + 50 * (1 - t)) * K * 1.35; // 머리에서 멀수록 꼬리가 넓어진다(꼬리만 1.35배 — 사용자 요청)
    const streak = 0.78 + 0.22 * Math.sin(d * 0.42 + t * 22 + hash2(Math.floor(x / G), Math.floor(y / G)) * 2);
    const k = d / (w * streak), n = hash2(Math.floor(x / G), Math.floor(y / G), seed % 7);
    if (k < 0.2) return '#fff0ea';
    if (k < 0.4) return '#ffa090';
    if (k < 0.65) return t > 0.55 ? '#e8203a' : (n < 0.75 ? '#e8203a' : '#a3141a');
    if (k < 0.9) return n < 0.8 ? '#8a1228' : '#5a0f18';
    if (k < 1.35 && n < 0.5 * (1.35 - k) / 0.45 + 0.1) return n < 0.25 ? '#6a6068' : '#3a3036'; // 잿빛 연기
    return null;
  }, SKY_BOX);
  // 머리: 둥근 불덩이(어두운 핵 + 붉은 테두리 + 밝은 안쪽 반사) — 둘레의 용뢰 스파크는 사용자 요청으로 뺐다
  haze(hx, hy, 58 * K, '#ff5a3a', 0.55); // 안쪽 음영 테두리
  const R = Math.round(40 * K), ST = 3;
  for (let y = -R; y <= R; y += ST) for (let x = -R; x <= R; x += ST) {
    const r = Math.hypot(x, y); if (r > R) continue;
    const lit = (-x * 0.55 - y * 0.8) / R;
    p.rect(hx + x - 1, hy + y - 1, ST, ST, r > R - 5 ? '#ffb090' : r > R - 10 ? '#e8203a' : lit > 0.45 ? '#6a2a30' : lit > 0 ? '#3a161c' : '#1a0a0e');
  }
  for (const [a, b] of [[-7, -6], [6, 2], [-1, 9], [11, -8]]) p.rect(hx + a, hy + b, 4, 4, '#ff5a4a'); // 핵 표면의 갈라진 붉은 빛
  // 머리 앞쪽으로 날리는 불똥과 부서진 파편
  for (let i = 0; i < 16; i++) { const px = hx - 24 - rnd() * 170, py = hy + (rnd() - 0.3) * 80; if (px > 0 && px < W && py > 0 && py < SKY_BOX.y1) dot(px, py, 3 + rnd() * 3, i % 3 ? '#ff7a5a' : '#ffd0c8'); }
  // 몬스터 칸 가장자리가 붉게 달아오른다
  for (const x of [FX_BOX.x0 - 6, FX_BOX.x1 + 2]) p.roundRect(x, FX_BOX.y0 - 4, 4, FX_BOX.y1 - FX_BOX.y0 + 8, 2, '#ff3a2a', 0.45); // 칸 양쪽 가장자리가 붉게
}

// 습격 착지 연기: 위로 솟은 먼지가 몬스터 칸 위쪽의 이름·HP 바까지 살짝 덮는다. thick=true 면 덮인 순간, false 면 걷히며 남은 옅은 연기.
function ambushSmoke(stage) {
  const rnd = seedRng(777); // 모든 단계가 같은 덩어리 배치를 쓰게 고정
  const G = 5, ex = W / 2, ey = 200; // 폭발 위치(연기를 아래에서 비춘다)
  const puffs = [];
  const layer = (n, rMin, rMax, yMin, yMax, layerId) => { for (let i = 0; i < n; i++) puffs.push({ x: -20 + rnd() * (W + 40), y: yMin + rnd() * (yMax - yMin), r: rMin + rnd() * (rMax - rMin), L: layerId, k: rnd() }); };
  layer(14, 70, 110, 10, 100, 0);   // 뒤: 큰 어두운 덩이(헤더 전체를 빈틈없이 덮는 바탕)
  layer(16, 46, 78, 20, 126, 1);    // 중간
  layer(18, 26, 54, 34, 150, 2);    // 앞: 작은 덩이(아래쪽 가장자리가 울퉁불퉁하게 말림)
  for (let x = 0; x <= W; x += 60) puffs.push({ x, y: 56, r: 64, L: 0, k: 0.5 }); // 빈틈 방지용 바탕
  if (stage >= 3) { // 잔잔: 몇 군데에만 옅게
    // 잔잔 단계: 헤더 쪽엔 연기를 남기지 않는다(이름·HP가 깨끗이 보이게)
    return;
  }
  const lift = stage === 2 ? 24 : 0;     // 2단계: 연기가 위로 말려 올라가며
  const rs = stage === 2 ? 0.58 : 1;     // 덩이가 작아져 사이가 벌어지며 흩어진다(헤더가 비쳐 보이기 시작) — 점 노이즈 대신 덩이 모양 그대로 줄어든다
  const keep = 1;
  const owner = (x, y) => { let best = null; for (const q of puffs) { if ((x - q.x) ** 2 + (y + lift - q.y) ** 2 <= (q.r * rs) ** 2 && (!best || q.L > best.L || (q.L === best.L && q.k > best.k))) best = q; } return best; };
  cellPaint(G, (x, y) => {
    const q = owner(x, y); if (!q) return null;
    const n = hash2(Math.floor(x / G), Math.floor(y / G), 41);
    if (n > keep) return null; // 흩어지는 단계의 빈틈
    const edge = !owner(x - G * 1.5, y) || !owner(x + G * 1.5, y) || !owner(x, y - G * 1.5) || !owner(x, y + G * 1.5);
    const heat = Math.max(0, 1 - Math.hypot(x - ex, y - ey) / 520) * (stage === 2 ? 0.5 : 1); // 폭발에 가까울수록 붉게 달궈짐(흩어질수록 식는다)
    const ny = (y + lift - q.y) / (q.r * rs), nx = (x - q.x) / (q.r * rs);
    const lit = ny * 0.75 - nx * 0.15 + (q.L - 1) * 0.12 + (n - 0.5) * 0.25;
    if (edge && q.L < 2) return n < 0.5 ? '#241a16' : '#30241e';
    if (lit > 0.55) return heat > 0.35 ? (n < 0.5 ? '#d88050' : '#c26a3e') : '#9a8068';
    if (lit > 0.2) return heat > 0.3 ? '#a45a38' : (n < 0.3 ? '#7a6252' : '#6a5446');
    if (lit > -0.2) return n < 0.35 ? '#56443a' : '#4a3a32';
    return n < 0.4 ? '#382c26' : '#2e241f';
  }, { x0: 0, y0: 0, x1: W, y1: 214 });
}

// 습격 착지(턴 결과 화면) — 참고 영상(발파루크 습격)처럼: 화면 전체가 붉게 번쩍이고 충돌 지점에 하얀 핵의 뾰족한 폭발이 터진다.
// 몬스터 뒤(back)에는 옅은 열기만, 번쩍임은 그림을 다 그린 뒤 맨 위에 덮는다(ambushFlash).
function ambushImpact(cx, cy, layer) {
  if (layer === 'back' && (process.env.CALM_STYLE ?? 'BC') === '0') heatGlow(cx, cy + 30, 124);
}
function calmStyle(st, cx, cy, stage) {
  const gy = cy + 66;
  if (st === '0') { for (const [dx, k] of [[-210, 1], [-120, 2], [120, 3], [210, 4]]) wisp(cx + dx, gy - 4, 52, k); return; }
  if (st === 'BC') { calmStyle('B', cx, cy, stage); calmStyle('C', cx, cy, stage); return; } // 붉은 안개 띠·불씨 + 피어오르는 연기 기둥
  const rnd = seedRng(energyTick + 11);
  if (st === 'A') { // 바닥 먼지 구름만: 양옆으로 낮게 퍼지는 겹겹의 먼지, 후광 없음
    for (const side of [-1, 1]) for (let i = 0; i < 6; i++) { const x = cx + side * (70 + i * 42 + rnd() * 20), r = 54 - i * 5; wisp(x, gy - 2 - rnd() * 6, r, i + (side > 0 ? 9 : 0)); }
  } else if (st === 'B') { // 먼지 구름 없이, 돌 둘레 흩어지는 불씨와 바닥에서 기어오르는 옅은 붉은 안개 띠
    for (let i = 0; i < 5; i++) p.roundRect(cx - 330 + i * 18, gy - 8 - i * 7, 660 - i * 36, 16 + i * 6, 12, '#7a2a1a', 0.05);
    for (let i = 0; i < 40; i++) dot(cx + (rnd() - 0.5) * 520, gy - rnd() * 130, 2 + Math.floor(rnd() * 3), rnd() < 0.5 ? '#ff8a3a' : '#ffd080');
  } else if (st === 'C') { // 크레이터에서 가늘게 피어오르는 연기 기둥 3줄(각각 위로 퍼지며 흐려짐)
    for (const [dx, k] of [[-40, 0], [6, 1], [48, 2]]) for (let t = 0; t < 9; t++) { const r = 8 + t * 5, x = cx + dx + Math.sin(t * 0.8 + k * 2) * (4 + t * 1.8), y = gy - 20 - t * 17; p.roundRect(x - r, y - r * 0.8, r * 2, r * 1.6, r * 0.8, t < 3 ? '#6a4a38' : '#5a463a', Math.max(0.05, 0.26 - t * 0.026)); p.roundRect(x - r * 0.6, y - r * 0.55 - 3, r * 1.1, r * 0.8, r * 0.4, '#9a7a62', Math.max(0.03, 0.14 - t * 0.014)); }
    for (let i = 0; i < 24; i++) dot(cx + (rnd() - 0.5) * 360, gy - rnd() * 150, 2 + Math.floor(rnd() * 2), '#ff9a4a');
  } else if (st === 'D') { // 충격으로 갈라진 땅에서 가라앉는 붉은 열기 + 땅을 따라 흐르는 낮은 연기 한 줄
    for (let x = -300; x <= 300; x += 26) { const h = 16 + 10 * Math.sin(x * 0.04 + 1) + rnd() * 6; p.roundRect(cx + x - 22, gy - h, 44, h + 8, 18, '#5a463a', 0.22); p.roundRect(cx + x - 16, gy - h - 4, 30, h * 0.6, 12, '#8a6a52', 0.14); }
    for (let i = 0; i < 18; i++) dot(cx + (rnd() - 0.5) * 420, gy - 6 - rnd() * 60, 2 + Math.floor(rnd() * 3), '#ff8a3a');
  }
}
// 열기 후광: 매끈한 한 장 대신 겹겹의 띠(포스터화된 그라데이션) + 바깥 얇은 고리 + 안쪽 따뜻한 중심으로 깊이를 낸다
function heatGlow(cx, cy, R) {
  const ring = (r, c, a) => haze(cx, cy, r, c, a);
  ring(R, '#ff7a3a', 0.035);
  ring(R * 0.9, '#ff6a30', 0.03);
  ring(R * 0.76, '#ff6a30', 0.03);
  ring(R * 0.6, '#ff8a40', 0.03);
  ring(R * 0.44, '#ffa050', 0.03);
  ring(R * 0.28, '#ffb060', 0.03);
  const rim = (r, a) => { for (let t = 0; t < 120; t++) { const th = t / 120 * Math.PI * 2; dot(cx + Math.cos(th) * r, cy + Math.sin(th) * r, 3, '#ff8a4a'); } };
  rim(R * 1.02, 0);
}
// 바닥에 깔리는 먼지 연기: 납작한 덩이 여러 개가 겹겹이(뒤 어둡게 → 앞 밝게), 아래쪽은 불빛을 받아 따뜻하고 위쪽 가장자리는 옅게 풀린다. 위로 가느다란 먼지 줄기와 떠다니는 알갱이.
function wisp(cx, cy, r, k = 0) {
  const rnd = seedRng(Math.floor(cx * 7 + cy * 3 + k * 101));
  const n = 5, blobs = Array.from({ length: n }, (_, i) => ({ x: cx + (i - (n - 1) / 2) * r * 0.42 + (rnd() - 0.5) * r * 0.2, w: r * (0.5 + rnd() * 0.4), h: r * (0.2 + rnd() * 0.16), y: cy - rnd() * r * 0.2 }));
  for (const b of blobs) p.roundRect(b.x - b.w, b.y - b.h * 0.9, b.w * 2, b.h * 2, b.h, '#2a1a16', 0.30);          // 뒤: 어두운 그림자 덩이
  for (const b of blobs) p.roundRect(b.x - b.w * 0.88, b.y - b.h * 1.0 - b.h * 0.15, b.w * 1.76, b.h * 1.7, b.h * 0.85, '#5a4034', 0.28); // 중간: 먼지색
  for (const b of blobs) p.roundRect(b.x - b.w * 0.7, b.y - b.h * 1.2, b.w * 1.3, b.h * 1.0, b.h * 0.5, '#8a6a52', 0.2);                  // 위쪽 왼쪽 밝은 면
  for (const b of blobs) p.roundRect(b.x - b.w * 0.6, b.y + b.h * 0.1, b.w * 1.2, b.h * 0.6, b.h * 0.3, '#c0703a', 0.14);                 // 아래쪽 땅 불빛
  for (let i = 0; i < 4; i++) { const px = cx + (rnd() - 0.5) * r * 1.8, py = cy - r * (0.25 + rnd() * 0.6); dot(px, py, 3 + Math.floor(rnd() * 2) * 2, i % 2 ? '#8a6a52' : '#b0805a'); } // 떠다니는 먼지 알갱이
  for (let i = 0; i < 2; i++) { const px = cx + (rnd() - 0.5) * r * 1.2; for (let t = 0; t < 4; t++) p.roundRect(px + Math.sin(t + k + i) * 4 - 7 + t, cy - r * 0.3 - t * 12, 14 - t * 2, 14, 7, '#6a5444', 0.2 - t * 0.04); } // 위로 피어오르는 가는 먼지 줄기
}
// stage 0: 충돌 순간(화면 전체가 붉고 폭발이 가장 크다) → 1: 폭발이 작아지고 식음 → 2: 폭발은 사라지고 불씨만 → 3: 붉은 기운이 옅게 남음
function ambushFlash(stage, cx, cy) {
  const rnd = seedRng(energyTick + 3), ex = cx, ey = cy + 22;
  const tint = [0.22, 0.15, 0.1, 0.07][stage] ?? 0.07, vig = [0.07, 0.045, 0.025, 0.012][stage] ?? 0.012;
  p.roundRect(0, 0, W, H, 0, '#ff1a14', tint); // 붉은 번쩍임: 전체에 깔고, 가장자리일수록 더 진하게(비네팅)
  for (let k = 0; k < 6; k++) {
    const t = 110 - k * 17, sd = 150 - k * 24;
    p.roundRect(0, 0, W, t, 0, '#8a0000', vig); p.roundRect(0, H - t, W, t, 0, '#8a0000', vig);
    p.roundRect(0, 0, sd, H, 0, '#8a0000', vig); p.roundRect(W - sd, 0, sd, H, 0, '#8a0000', vig);
  }
  const S = stage === 0 ? 1 : stage === 1 ? 0.5 : 0; // 폭발 크기 배율
  if (S > 0) {
    haze(ex, ey, 190 * S, '#ffb060', 0.18); haze(ex, ey, 120 * S, stage === 0 ? '#fff0b0' : '#ffa060', 0.22); // 폭발 둘레 열기 번짐
    // 폭발 본체: 뾰족한 별 모양을 4px 도트로 칠해 질감(디더링)·겹겹의 색을 낸다. 1단계는 작고 식은(붉은 쪽) 색
    const N = 14, lens = Array.from({ length: N }, () => 0.62 + rnd() * 0.5), cool = stage === 1 ? 0.28 : 0; // cool: 안쪽 색을 한 단계씩 식힌다
    cellPaint(4, (x, y) => {
      const dx = x - ex, dy = (y - ey) / 0.62, r = Math.hypot(dx, dy); if (r > 290 * S) return null;
      let th = Math.atan2(dy, dx); if (th < 0) th += Math.PI * 2;
      const seg = th / (Math.PI * 2) * N, i0 = Math.floor(seg) % N, i1 = (i0 + 1) % N, f = seg - Math.floor(seg);
      const spike = (lens[i0] * (1 - f) + lens[i1] * f) * (0.46 + 0.54 * Math.abs(Math.cos(f * Math.PI)));
      const L = 250 * S * spike * (0.94 + 0.12 * hash2(Math.floor(x / 4), Math.floor(y / 4), 31));
      if (r > L) return null;
      const k = Math.min(0.999, r / L + cool), n = hash2(Math.floor(x / 4), Math.floor(y / 4), 32);
      if (k < 0.1) return '#ffffff';
      if (k < 0.26) return n < 0.8 ? '#fffbe8' : '#ffe9a8';
      if (k < 0.46) return n < 0.7 ? '#ffd35a' : '#ffa83a';
      if (k < 0.7) return n < 0.65 ? '#ff7a2a' : n < 0.9 ? '#ff5a24' : '#e8381c';
      return n < 0.5 ? '#e8201a' : n < 0.85 ? '#b8140f' : '#7a0c0c';
    }, { x0: Math.max(0, ex - 300 * S), y0: Math.max(0, ey - 190 * S), x1: Math.min(W, ex + 300 * S), y1: Math.min(H, ey + 190 * S) });
    // 광선(0단계에서 가장 길고 1단계에선 짧게)
    for (const [x1, y1, w] of [[-470, -70, 7], [470, -70, 7], [-430, 46, 6], [430, 46, 6], [-250, -150, 6], [250, -150, 6], [0, -180, 6], [-180, 110, 4], [180, 110, 4]]) {
      p.line(ex, ey, ex + x1 * 0.5 * S, ey + y1 * 0.5 * S, Math.max(2, w * S), '#fff0c8'); p.line(ex + x1 * 0.5 * S, ey + y1 * 0.5 * S, ex + x1 * S, ey + y1 * S, Math.max(1, (w - 4) * S), '#ffd890');
    }
    if (stage === 0) for (const [x1, y1] of [[-330, -20], [330, -20], [-140, -120], [140, -120], [-300, 90], [300, 90]]) p.line(ex, ey, ex + x1, ey + y1, 4, '#a80f0a');
    // 충격파 고리: 충돌 지점에서 퍼지는 밝은 타원(0단계 세 겹 → 1단계 더 넓고 흐린 한 겹)
    const rings = stage === 0 ? [[330, 70, '#ffe2a0', 5], [230, 50, '#ffffff', 4], [430, 92, '#ff9a5a', 4]] : [[440, 96, '#a85a3a', 3]];
    for (const [rx, ry, c, w] of rings) for (let a = 0; a < 180; a++) { const t = (a / 180) * Math.PI * 2; dot(ex + Math.cos(t) * rx, ey + 50 + Math.sin(t) * ry, w, c); }
    // 불꽃 입자·파편(1단계에선 적게, 아래로 가라앉으며 어두워짐)
    const sparks = stage === 0 ? 70 : 34;
    for (let i = 0; i < sparks; i++) {
      const t = rnd() * Math.PI * 2, d = (90 + rnd() * 380) * (stage === 0 ? 1 : 0.8), sz = 3 + Math.floor(rnd() * 4), px = ex + Math.cos(t) * d, py = ey + Math.sin(t) * d * 0.6 + (stage === 0 ? 0 : 24);
      const c = stage === 0 ? (d < 200 ? (i % 2 ? '#fffbe8' : '#ffe080') : d < 320 ? (i % 2 ? '#ff9a3a' : '#ffb85a') : (i % 2 ? '#e8301a' : '#ff6a2a')) : (i % 2 ? '#e8602a' : '#b8301a');
      if (stage === 0) p.line(ex + Math.cos(t) * (d - 22 - sz * 2), ey + Math.sin(t) * (d - 22 - sz * 2) * 0.6, px, py, Math.max(1, sz - 2), c);
      p.rect(px - sz / 2, py - sz / 2, sz, sz, c);
    }
    for (let i = 0; i < 14; i++) {
      const t = rnd() * Math.PI * 2, d = 130 + rnd() * 300, sz = 8 + Math.floor(rnd() * 3) * 5, px = ex + Math.cos(t) * d, py = ey + Math.sin(t) * d * 0.55 - 14 + (stage === 0 ? 0 : 40);
      p.rect(px - sz / 2, py - sz / 2, sz, sz, '#2a1210'); p.rect(px - sz / 2, py - sz / 2, sz / 2, sz / 2, '#7a3a2a');
    }
  } else {
    // 2·3단계: 폭발은 사라지고 열기와 가라앉는 불씨만 남는다
    calmStyle(process.env.CALM_STYLE ?? 'BC', cx, cy, stage); // 땅 위로 잔잔히 깔리는 연기
    if (stage === 2) heatGlow(ex, ey, 130);
    const embers = stage === 2 ? 34 : 18;
    for (let i = 0; i < embers; i++) { const px = ex + (rnd() - 0.5) * 560, py = ey + 20 - rnd() * (stage === 2 ? 170 : 120); dot(px, py, 3 + rnd() * 3, i % 2 ? '#ff7a3a' : '#ffd080'); }
  }
}

let energyTick = (Date.now() % 100000) | 0; // 번개 모양 시드(그릴 때마다 증가)

// 분노 연출(모든 몬스터 공통 — 얼굴은 바꾸지 않고 주변으로 위험한 느낌을 낸다):
// 몸 둘레에 붉은 기운(실루엣을 사방으로 밀어 찍음), 바닥 불빛, 피어오르는 불씨, 머리 위 분노 마크.
function monsterSilhouette(monster, cx, cy, maxH, pose, color, d) {
  const sp = monster.sprite;
  if (!sp) return;
  const rows = (pose && sp.poses?.[pose]) || sp.rows;
  const solid = Object.fromEntries(Object.keys(sp.palette).map(k => [k, color]));
  const px = Math.floor((maxH * (sp.scale ?? 1)) / rows.length);
  for (const [dx, dy] of [[-d, 0], [d, 0], [0, -d], [0, d], [-d * 0.7, -d * 0.7], [d * 0.7, -d * 0.7], [-d * 0.7, d * 0.7], [d * 0.7, d * 0.7]]) {
    drawPixels({ ...sp, rows }, cx + dx, cy + dy, px, { colors: solid });
  }
  return { w: rows[0].length * px, h: rows.length * px };
}
// 필살기 예고 중 부르르 떠는 연출(모든 몬스터 공통): 몸 양옆 떨림 표시(짧은 도트 줄). 잔상(테두리처럼 보임)은 사용자가 빼 달라고 해서 뺌.
function shakeFx(monster, cx, cy, maxH, pose) {
  const sp = monster.sprite;
  if (!sp) return;
  const rows = (pose && sp.poses?.[pose]) || sp.rows;
  const px = Math.floor((maxH * (sp.scale ?? 1)) / rows.length);
  const w = rows[0].length * px, h = rows.length * px;
  // 떨림 표시: 몸 양옆에 바깥으로 갈수록 짧아지는 세로 도트 줄 두 개씩(위·아래 두 군데)
  for (const side of [-1, 1]) {
    for (const [gap, n] of [[16, 3], [30, 2]]) {
      for (const yy of [-h * 0.22, h * 0.22]) {
        for (let i = 0; i < n; i++) dot(cx + side * (w / 2 + gap), cy + yy + (i - (n - 1) / 2) * 7, 5, '#f4e6cf');
      }
    }
  }
}
function rageFx(monster, cx, cy, maxH, pose, layer) {
  if (layer === 'box') {
    // 바닥 불빛
    p.roundRect(cx - 130, cy + 54, 260, 16, 8, '#ff3b2f', 0.28);
    p.roundRect(cx - 90, cy + 57, 180, 10, 5, '#ff6a3d', 0.4);
    // 피어오르는 불씨(위치 고정 — 그릴 때마다 같은 그림이라 깜빡이지 않게)
    for (const [dx, dy, sz] of [[-150, 20, 8], [-128, -30, 6], [-172, -6, 5], [146, 28, 8], [168, -18, 6], [124, -44, 5], [-104, -70, 5], [108, -76, 6]]) {
      p.rect(cx + dx - sz / 2, cy + dy - sz / 2, sz, sz, '#ff7a3d');
      p.rect(cx + dx - sz / 4, cy + dy - sz * 1.6, sz / 2, sz / 2, '#ffb36b');
    }
    return;
  }
  if (layer === 'aura') {
    monsterSilhouette(monster, cx, cy, maxH, pose, '#7a1410', 9);
    monsterSilhouette(monster, cx, cy, maxH, pose, '#ff3b2f', 4);
    return;
  }
  if (layer === 'mark') {
    // 분노 마크: 네 갈래로 꺾인 붉은 핏줄 표시를 머리 오른쪽 위에
    const sp = monster.sprite;
    const rows = (pose && sp?.poses?.[pose]) || sp?.rows || [''];
    const px = Math.floor((maxH * (sp?.scale ?? 1)) / rows.length);
    const mx = cx + (rows[0].length * px) / 2 - 6, my = cy - (rows.length * px) / 2 + 4;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      p.line(mx + sx * 4, my + sy * 14, mx + sx * 4, my + sy * 5, 5, '#ff2a1f');
      p.line(mx + sx * 14, my + sy * 4, mx + sx * 5, my + sy * 4, 5, '#ff2a1f');
    }
  }
}

// 상태 효과 아이콘(12×12 픽셀, 오리지널). 납작한 단색 배지 + 화살표로 효과를 알아보게 한다.
const STATUS_ICONS = {
  // 보호막(몬스터): 푸른 방패에 초록 위 화살표(받는 피해 감소)
  shield: {
    rows: [
      '.dddddddddd.', 'dbbbbbbbbbbd', 'dbbbbggbbbbd', 'dbbbggggbbbd', 'dbbggggggbbd', 'dbbbbggbbbbd',
      'dbbbbggbbbbd', 'dbbbbggbbbbd', '.dbbbbbbbbd.', '..dbbbbbbd..', '...dbbbbd...', '....dddd....',
    ],
    palette: { d: '#1c2a38', b: '#6f8fae', g: '#7ccf5a' },
  },
  // 공격력 증가(몬스터): 오른쪽 위를 향한 칼(흰 날·금빛 가드·갈색 손잡이) + 오른쪽 아래 초록 위 화살표
  power: {
    rows: [
      '........ddd.', '.......dwwd.', '......dwwsd.', '.....dwwsd..', '....dwwsd...', '.dd.dwsd.g..',
      '.dydwsd.ggg.', '..dyyd.ggggg', '.dbdyyd..g..', 'dbd..dd..g..', 'dd.......g..', '.........g..',
    ],
    palette: { d: '#2a1410', w: '#ffffff', s: '#b9c6d6', y: '#f0b84a', b: '#8b5a2b', g: '#7ccf5a' },
  },
};
// 악취 기운(카드 아이콘 위): 작은 방귀 구름 + 맴도는 파리 두 마리(냄새 줄은 X자처럼 보여 뺌 — 사용자 요청)
// 악취(구린 방귀): 악취 아이콘 색(갈색 #8a4f1e · 주황 #c47a32 · 밝은 주황 #eaa860)으로 은은하게. k = 진하기(맞은 순간 1, 남아 있는 동안 0.6)
const STENCH_C = { dark: '#8a4f1e', mid: '#c47a32', light: '#eaa860' };
// 반투명 뭉게구름 하나: 가운데 큰 동그라미 + 양옆·위 작은 동그라미를 옅게 겹친다(겹친 곳이 조금 더 진해 입체감)
function softCloud(x, y, s, color, alpha) {
  for (const [dx, dy, r] of [[0, 0, 14], [-13, 4, 10], [13, 4, 10], [-5, -8, 9], [7, -7, 8]]) haze(x + dx * s, y + dy * s, r * s, color, alpha);
}
// 아이콘 뒤: 아래쪽에 옅은 구름 두 덩이가 깔림
function stenchBehind(role, cx, cy, k) {
  softCloud(cx - 26, cy + 18, 1.3, STENCH_C.dark, 0.16 * k);
  softCloud(cx + 28, cy + 14, 1.2, STENCH_C.dark, 0.16 * k);
}
// 아이콘 앞: 작은 구름이 아이콘 아래쪽에 살짝 걸치고, 위로 아주 작은 구름이 떠오름(아이콘은 비쳐 보이게 옅게)
function stenchFront(cx, cy, k) {
  softCloud(cx - 4, cy + 30, 1.1, STENCH_C.mid, 0.16 * k);
  softCloud(cx + 34, cy - 30, 0.55, STENCH_C.light, 0.22 * k);
  softCloud(cx - 30, cy - 40, 0.45, STENCH_C.light, 0.2 * k);
}
// 악취: 갈색 냄새 구름 배지 + 냄새 줄 + 남은 턴
function stenchBadge(cx, cy, turns) {
  drawPixels(STENCH_ICON, cx, cy, 2.4);
  btext(`${turns}턴`, cx, cy + 24, 15, '#e0c49a');
}
// 카드 왼쪽 위 상태 아이콘: 기절(별). 점액는 아이콘 없이 점액 얼룩으로 표시한다.
// 카드 왼쪽 상태 배지: 기절(별) · 독(거품). 환각은 배지 대신 아이콘 위 소용돌이(카드 그리는 곳에서, 점액처럼).
// 냉기는 독 아래(같은 자리 규칙). 빙결(stunStatus.fx 'ice')은 별 대신 아이콘 위 얼음 덮개(iceCover)로 보인다.
// 기절 별은 배지 대신 환각 소용돌이처럼 아이콘 오른쪽 아래에 걸쳐 그린다(카드 그리는 곳 — 사용자 요청).
let badgeCompact = false; // 상태이상이 3개 이상이면 2열 격자 + 숫자를 아이콘 모서리로
const btext = (...a) => { if (!badgeCompact) text(...a); };
function statusBadges(b, mem, x, y) {
  const items = []; // { draw(cx, cy), step: 세로 간격, label: 숫자(압축 모드에서 모서리에 표시) }
  const stacks = poisonStacks(b, mem);
  if (stacks) items.push({ draw: (cx, cy) => poisonBadge(cx, cy, stacks, mem.poisonStatus?.color), step: stacks > 1 ? 44 : 34, label: stacks > 1 ? `×${stacks}` : '' });
  if (isFeared(b, mem)) items.push({ draw: fearBadge, step: 34, label: '' });
  // 점액(slow)도 독처럼 배지로: 몬스터 겉면 색 방울 + 남은 턴
  const slowLeft = slowTurnsLeft(b, mem);
  if (slowLeft > 0) items.push({ draw: (cx, cy) => mem.slowStatus?.fx === 'water' ? wetBadge(cx, cy, slowLeft) : mem.slowStatus?.fx === 'lightning' ? shockBadge(cx, cy, slowLeft) : slowBadge(cx, cy, slowLeft, b.monster.sprite?.palette?.o || '#7fdc8c'), step: 44, label: String(slowLeft) });
  const chill = chillStacks(b, mem);
  if (chill) items.push({ draw: (cx, cy) => chillBadge(cx, cy, chill), step: 44, label: `×${chill}` });
  const stench = stenchTurnsLeft(b, mem);
  if (stench) items.push({ draw: (cx, cy) => stenchBadge(cx, cy, stench), step: 44, label: String(stench) });
  if (isErrored(b, mem)) { const t = errorTurnsLeft(b, mem); items.push({ draw: (cx, cy) => errorBadge(cx, cy, t), step: 44, label: String(t) }); }
  if (isVulnerable(b, mem)) { const t = vulnTurnsLeft(b, mem); items.push({ draw: (cx, cy) => mem.vulnStatus?.fx === 'dragon' ? dragonBadge(cx, cy, t) : vulnBadge(cx, cy, t), step: 44, label: String(t) }); }
  if (isDoomed(b, mem)) items.push({ draw: doomBadge, step: 34, label: mem.doomStacks ? `${mem.doomStacks + 1}` : '' });
  if (items.length < 3) { // 둘 이하면 예전처럼 세로로 쌓는다
    let by = y;
    for (const it of items) { it.draw(x, by); by += it.step; }
    return;
  }
  // 셋 이상: 아이콘 왼쪽 띠에 2열 격자로 촘촘히, 숫자는 아이콘 오른쪽 아래 모서리에(카드 아래 이름·체력 줄을 가리지 않게)
  badgeCompact = true;
  try {
    items.forEach((it, i) => {
      const cx = x - 12 + (i % 2) * 28, cy = y - 10 + Math.floor(i / 2) * 28;
      it.draw(cx, cy);
      if (it.label) { text(it.label, cx + 11, cy + 14, 12, '#000000'); text(it.label, cx + 10, cy + 13, 12, '#ffffff'); }
    });
  } finally { badgeCompact = false; }
}
// ── ??? 상태 아이콘(검은 바탕 + 붉은 선, 터미널 느낌) ──
// 오류: 붉은 테두리 네모 + 청록 그림자가 어긋난 느낌표 + 끊긴 줄 + 남은 턴
function errorBadge(cx, cy, turns) {
  p.rect(cx - 13, cy - 13, 26, 26, '#1a0608'); p.strokeRoundRect(cx - 13, cy - 13, 26, 26, 2, 2, '#ff3a4a');
  p.rect(cx + 0.5, cy - 8, 3.5, 10, '#2ad0d8'); p.rect(cx + 0.5, cy + 4, 3.5, 3.5, '#2ad0d8');
  p.rect(cx - 2, cy - 8, 3.5, 10, '#ff3a4a'); p.rect(cx - 2, cy + 4, 3.5, 3.5, '#ff3a4a');
  p.rect(cx - 13, cy + 1, 10, 2, '#0d0406'); p.rect(cx + 4, cy - 5, 9, 2, '#0d0406');
  btext(`${turns}턴`, cx, cy + 26, 15, '#ffb0b8');
}
// 취약: 조준선(락온) + 남은 턴
function vulnBadge(cx, cy, turns) {
  p.circle(cx, cy, 12, '#ff3a4a'); p.circle(cx, cy, 9.5, '#14040a'); p.circle(cx, cy, 5, '#ff3a4a'); p.circle(cx, cy, 3, '#14040a');
  for (const [x, y, w, h] of [[-1, -17, 2, 8], [-1, 9, 2, 8], [-17, -1, 8, 2], [9, -1, 8, 2]]) p.rect(cx + x, cy + y, w, h, '#ff3a4a');
  p.rect(cx - 1, cy - 1, 2, 2, '#ffb0b8');
  btext(`${turns}턴`, cx, cy + 26, 15, '#ffb4bc');
}
// 즉사: 글리치 해골(붉은 해골 + 청록 그림자 + 잘린 줄) — 이번 턴 판정
function doomBadge(cx, cy) {
  for (const [dx, c] of [[2, '#2ad0d8'], [0, '#ff3a4a']]) { p.roundRect(cx - 11 + dx, cy - 13, 22, 18, 8, c); p.rect(cx - 6 + dx, cy + 4, 12, 7, c); }
  p.circle(cx - 4, cy - 4, 3.2, '#0d0406'); p.circle(cx + 4, cy - 4, 3.2, '#0d0406'); p.rect(cx - 1, cy, 2, 3, '#0d0406');
  p.rect(cx - 3, cy + 7, 1.5, 4, '#0d0406'); p.rect(cx + 1.5, cy + 7, 1.5, 4, '#0d0406');
  p.rect(cx - 14, cy - 1, 12, 2, '#0d0406'); p.rect(cx + 3, cy + 3, 12, 1.5, '#0d0406');
}
// 점액: 독 거품처럼 방울 세 개(어두운 테두리 → 점액색 → 흰 반사광) + 아래에 남은 턴
function slowBadge(cx, cy, turns, color) {
  const blobs = [[-5, 3, 9], [7, -4, 7], [4, 9, 5]];
  for (const [dx, dy, r] of blobs) p.circle(cx + dx, cy + dy, r + 2.5, '#0e2a14');
  for (const [dx, dy, r] of blobs) p.circle(cx + dx, cy + dy, r, color);
  p.circle(cx - 8, cy, 2.5, '#f4fff0');
  btext(`${turns}턴`, cx, cy + 24, 15, color);
}
// 젖음(해일 소용돌이, slow): 푸른 테두리 네모 + 물방울 + 아래 물결 두 줄 + 남은 턴
// 젖음 상태(아이콘 위): 은은하게 — 아이콘에 아주 옅은 물빛 막만 씌우고, 아이콘을 타고 흘러내리는 작은 물방울 두 개를 흐리게. 테두리·반사광은 없다.
function wetIcon(cx, cy) {
  p.circle(cx, cy, 33, '#46cdff', 0.07); // 아주 옅은 물빛 막
  for (const [ox, oy, len] of [[-16, -4, 10], [14, 6, 12]]) { // 작은 물방울 두 개(줄기와 방울 모두 반투명)
    const x = Math.round(cx + ox), y = Math.round(cy + oy);
    p.roundRect(x - 0.5, y - len, 1, len, 0.5, '#9ad8ff', 0.3);
    p.circle(x, y + 1.5, 2.2, '#7cc8ff', 0.55); p.circle(x - 0.6, y + 0.8, 0.7, '#ffffff', 0.8);
  }
}
function wetBadge(cx, cy, turns) {
  p.rect(cx - 13, cy - 13, 26, 26, '#06142a'); p.strokeRoundRect(cx - 13, cy - 13, 26, 26, 2, 2, '#2a8ad0');
  p.poly([cx, cy - 11, cx + 3, cy - 5, cx + 7, cy + 0, cx + 7, cy + 3, cx + 5, cy + 6, cx - 5, cy + 6, cx - 7, cy + 3, cx - 7, cy + 0, cx - 3, cy - 5], '#46cdff');
  p.poly([cx - 1, cy - 8, cx + 1, cy - 4, cx - 3, cy + 1, cx - 5, cy + 1], '#bfeaff');
  p.rect(cx - 9, cy + 8, 5, 2, '#7ad8ff'); p.rect(cx - 3, cy + 9, 6, 2, '#bfeaff'); p.rect(cx + 4, cy + 8, 5, 2, '#7ad8ff');
  btext(`${turns}턴`, cx, cy + 26, 15, '#9ad8ff');
}
function isIced(b, mem) { return isStunned(b, mem) && mem.stunStatus?.fx === 'ice'; }
// 눈송이: 세 갈래 선(어두운 테두리 → 하늘색) + 가운데 흰 점
function flake(cx, cy, r) {
  for (const [w, c] of [[Math.max(4, r * 0.55), '#0e2a3d'], [Math.max(2, r * 0.25), '#bfeaff']]) {
    for (let k = 0; k < 3; k++) {
      const a = (k * Math.PI) / 3 + Math.PI / 2;
      p.line(cx - Math.cos(a) * r, cy - Math.sin(a) * r, cx + Math.cos(a) * r, cy + Math.sin(a) * r, w, c);
    }
  }
  p.circle(cx, cy, Math.max(1.5, r * 0.22), '#ffffff');
}
// 냉기: 눈송이 + 아래에 중첩 수(몇 개인지가 중요해서 1부터 표시)
function chillBadge(cx, cy, stacks) {
  flake(cx, cy, 12);
  btext(`×${stacks}`, cx, cy + 24, 15, '#bfeaff');
}
// 빙결: 역할 아이콘을 덮는 반투명 얼음 덩어리 + 흰 반사선
function iceCover(cx, cy) {
  p.roundRect(cx - 42, cy - 38, 84, 72, 8, '#bfeaff', 0.5); // 아래 이름 글자와 안 겹치게 높이 72
  p.strokeRoundRect(cx - 42, cy - 38, 84, 72, 8, 2.5, '#e8fbff');
  p.line(cx - 30, cy - 18, cx - 16, cy - 32, 4, '#ffffff');
  p.line(cx - 30, cy - 4, cx - 4, cy - 30, 3, '#ffffff');
  p.line(cx + 18, cy + 30, cx + 32, cy + 16, 3, '#ffffff');
}
// 환각(최면) 상태: 카드 아이콘 위에 겹쳐 그리는 청록 소용돌이(점액 얼룩처럼 아이콘에 묻은 느낌).
// 아이콘 색과 섞여 안 보이지 않게 어두운 테두리를 먼저 굵게 깔고 그 위에 밝은 청록을 그린다.
function confuseSwirl(cx, cy) {
  const turns = 2.2, steps = 40, R = 21;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, a = t * turns * Math.PI * 2, rr = R * (1 - t * 0.85);
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  for (const [width, color] of [[9, '#0b2b2e'], [5, '#8ffff0']]) {
    for (let i = 1; i < pts.length; i++) p.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], width, color);
  }
}
// 독: 보라 거품 세 개 + 아래에 중첩 수(2 이상일 때). 화상(status.color가 있는 독류)은 불꽃 배지로 따로 그린다.
function poisonBadge(cx, cy, stacks, color) {
  if (color) return burnBadge(cx, cy, stacks);
  p.circle(cx - 5, cy + 3, 9, '#9b3fc0');
  p.circle(cx + 7, cy - 4, 7, '#b45fe0');
  p.circle(cx + 4, cy + 9, 5, '#c98af0');
  p.circle(cx - 8, cy, 3, '#f1cdfb');
  if (stacks > 1) btext(`×${stacks}`, cx, cy + 22, 15, '#e2b8ff');
}
// 불꽃 모양(겹겹이: 어두운 테두리 → 빨강 → 주황 → 노란 심). 화상 배지·혼불·피격 연출에 쓴다.
function flame(cx, cy, s, layers = [['#4a1206', 1.25], ['#e8401c', 1], ['#ff9a3c', 0.72], ['#ffe066', 0.42]]) {
  for (const [c, k] of layers) {
    const h = 15 * s * k, w = 9 * s * k;
    p.poly([cx, cy - h, cx + w * 0.55, cy - h * 0.35, cx + w, cy + h * 0.2, cx + w * 0.7, cy + h * 0.62, cx, cy + h * 0.8,
      cx - w * 0.7, cy + h * 0.62, cx - w, cy + h * 0.2, cx - w * 0.35, cy - h * 0.1, cx - w * 0.2, cy - h * 0.55], c);
  }
}
// 화상: 큰 불꽃 + 옆 작은 불꽃 + 아래에 중첩 수(독 거품과 다른 모양)
function burnBadge(cx, cy, stacks) {
  flame(cx, cy, 1);
  flame(cx + 9, cy + 4, 0.5, [['#4a1206', 1.3], ['#ff9a3c', 1], ['#ffe066', 0.55]]);
  if (stacks > 1) text(`×${stacks}`, cx, cy + 22, 15, '#ffc08a');
}
// 공포: 질린 눈 — 보라 눈꺼풀 안 커다란 흰자 + 오그라든 작은 눈동자
function fearBadge(cx, cy) {
  p.poly([cx - 17, cy, cx - 9, cy - 10, cx + 9, cy - 10, cx + 17, cy, cx + 9, cy + 10, cx - 9, cy + 10], '#1a0a2a');
  p.poly([cx - 14, cy, cx - 7, cy - 8, cx + 7, cy - 8, cx + 14, cy, cx + 7, cy + 8, cx - 7, cy + 8], '#8a5fe0');
  p.poly([cx - 11, cy, cx - 5, cy - 6, cx + 5, cy - 6, cx + 11, cy, cx + 5, cy + 6, cx - 5, cy + 6], '#ffffff');
  p.circle(cx, cy, 2.4, '#1a0a2a');
}
// 표식(영혼 사냥 대상): 카드 오른쪽 위 빛나는 눈
function markEye(cx, cy) {
  p.poly([cx - 18, cy, cx - 8, cy - 9, cx + 8, cy - 9, cx + 18, cy, cx + 8, cy + 9, cx - 8, cy + 9], '#2a1f4a');
  p.poly([cx - 14, cy, cx - 6, cy - 6, cx + 6, cy - 6, cx + 14, cy, cx + 6, cy + 6, cx - 6, cy + 6], '#7ef0e0');
  p.circle(cx, cy, 5, '#1a1033');
  p.circle(cx - 2, cy - 2, 1.6, '#ffffff');
}
// 기절: 납작한 노란 별 두 개(작은 별 왼쪽 위 · 큰 별 오른쪽 아래). 픽셀 대신 다각형이라 가장자리가 깔끔하다.
function star(cx, cy, R, color) {
  const pts = [];
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const rr = k % 2 ? R * 0.45 : R;
    pts.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  p.poly(pts, color);
}
// 기절(카드): 아이콘 머리 위 타원 궤도를 도는 별 세 개 — 앞쪽(궤도 아래)일수록 크고 밝게, 뒤쪽은 작고 어둡게
function stunOrbit(cx, cy) {
  const rx = 44, ry = 10;
  const at = (a) => [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
  // 별 셋: 오른쪽 앞 · 왼쪽 앞 · 머리 위(뒤). 아이콘 한가운데는 비워 둔다. 뒤쪽부터 그려 앞쪽 별이 위에 오게.
  const stars = [-1.57, 0.45, 2.69].sort((u, v) => Math.sin(u) - Math.sin(v)); // 사용자가 고른 배치
  for (const a of stars) {
    const front = (Math.sin(a) + 1) / 2; // 0 뒤 ~ 1 앞
    const R = 7 + front * 4;
    // 꼬리: 별이 지나온 궤도를 따라 굵게 시작해 가늘어지는 빛줄기(겹친 원 — 어두운 테두리 → 밝은 심)
    const n = 18, span = 1.25;
    for (const [pad, color] of [[2.5, '#3a2a08'], [0, '#ffe680']]) {
      for (let i = n; i >= 1; i--) {
        const t = i / n;
        const [tx, ty] = at(a - t * span);
        p.circle(tx, ty, Math.max(0.8, R * 0.62 * (1 - t)) + pad * (1 - t * 0.7), color);
      }
    }
    const [sx, sy] = at(a);
    star(sx, sy, R + 2.5, '#3a2a08'); // 테두리
    star(sx, sy, R, front > 0.4 ? '#ffd23f' : '#e8b62c');
    p.circle(sx - R * 0.18, sy - R * 0.22, Math.max(1.2, R * 0.16), '#fff8d6'); // 반짝임
  }
}
function stunStars(x, y) {
  star(x - 7, y - 9, 10, '#ffd23f');
  star(x + 8, y + 8, 15, '#ffd23f');
}

// 점액 흩뿌리기 줄기 방향(단위벡터 x·y, 뻗는 거리, 끝 방울 반지름). 아래쪽은 '다음 행동' 상자(y 276)에 닿지 않게 짧게.
const SPRAY = [
  [-1, -0.15, 175, 12], [-0.85, 0.5, 150, 10], [-0.75, -0.75, 125, 9], [-0.4, 1, 115, 8],
  [1, -0.15, 175, 12], [0.85, 0.5, 150, 10], [0.75, -0.75, 125, 9], [0.4, 1, 115, 8],
];
// 몬스터 기술 연출(턴 결과 화면). 몬스터마다 그리지 않고 기술 종류(moves 키)로 공통 처리한다.
// layer 'back'은 몬스터 뒤, 'front'는 앞에 그린다. color는 몬스터 겉면 색(점액·기운).
// 연출 도우미 — 몬스터 그림과 어울리게 네모 도트로 그린다.
function dot(x, y, size, c) { p.rect(Math.round(x - size / 2), Math.round(y - size / 2), Math.round(size), Math.round(size), c); }
// 반짝임: 가운데 + 상하좌우 네 칸
function sparkle(x, y, size, c) { for (const [i, j] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) dot(x + i * size, y + j * size, size, c); }
// 최면 물결: 양옆으로 도트 호 세 겹(청록·보라·청록, 바깥일수록 짧게). scale로 몬스터(1)·카드(작게, 두 겹 — 피해 숫자·독 표시와 안 겹치게)에 같이 쓴다.
function hypnoWaves(cx, cy, scale, purple, rings = 3) {
  [[112, '#7ef0e0'], [142, purple], [172, '#7ef0e0']].slice(0, rings).forEach(([r0, c], k) => {
    const r = r0 * scale;
    const size = Math.max(3, (k === 1 ? 7 : 6) * scale * 1.6);
    for (const side of [-1, 1]) {
      const span = 0.95 - k * 0.12;
      const steps = Math.max(4, Math.round((r * span * 2) / (10 * Math.max(scale * 1.6, 0.5))));
      for (let i = 0; i <= steps; i++) {
        const a = -span + (i / steps) * span * 2;
        dot(cx + side * Math.cos(a) * r, cy + Math.sin(a) * r * 0.58, size, c);
      }
    }
  });
}
// 포자 알갱이: 모서리를 깎은 4×4 동그란 알 — 왼쪽 위는 밝은 반사광, 오른쪽 아래는 그늘(어두운 바탕에서도 둥글게 보이게)
const SPORE_BALL = ['.cc.', 'clcc', 'cccd', '.dd.'];
function puff(x, y, size, c, light, dark = '#3a1450') {
  SPORE_BALL.forEach((line, j) => [...line].forEach((ch, i) => {
    if (ch === '.') return;
    dot(x + (i - 1.5) * size, y + (j - 1.5) * size, size, ch === 'l' ? light : ch === 'd' ? dark : c);
  }));
}
// 작은 유령(원혼 폭풍): 5×5 도트
const MINI_GHOST = { rows: ['.www.', 'wwwww', 'wkwkw', 'wwwww', 'w.w.w'], palette: { w: '#f1ecff', k: '#2a1f4a' } };
const MINI_GHOST_DARK = { rows: ['.www.', 'wwwww', 'wkwkw', 'wwwww', 'w.w.w'], palette: { w: '#9b7bff', k: '#1a0f33' } };
// 들쭉날쭉한 호(울부짖기 음파): 중심에서 r, 각도 a0~a1, 바깥·안쪽을 번갈아
function jaggedArc(cx, cy, r, a0, a1, squash, width, color, teeth = 9) {
  let prev = null;
  for (let i = 0; i <= teeth * 2; i++) {
    const a = a0 + ((a1 - a0) * i) / (teeth * 2);
    const rr = r + (i % 2 ? 9 : -5);
    const pt = [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * squash];
    if (prev) p.line(prev[0], prev[1], pt[0], pt[1], width, color);
    prev = pt;
  }
}
// 영혼 사냥: 세 줄 할퀴기(시안 B) — 맞은 대상 카드 전체를 가르는 큰 할퀴기만(고스트 쪽 연출은 없음, 사용자 결정).
// 한 줄은 가운데가 굵고 양끝이 가늘며, 어두운 테두리 → 보라 → 연보라 → 흰 심으로 겹친다.
function clawMarks(cx, cy, size, flip = 1) {
  for (const [d, w, l] of [[-26, 14, 0.85], [0, 20, 1], [26, 14, 0.85]]) {
    const pts = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      pts.push([cx + flip * ((-80 * l + t * 160 * l) * size) + d * size, cy + (-70 * l + t * 140 * l) * size - Math.sin(t * Math.PI) * 14 * size]);
    }
    for (const [k, c] of [[1, '#1a0a2a'], [0.7, '#7a5ad6'], [0.42, '#d9ceff'], [0.18, '#ffffff']]) {
      for (let i = 1; i < pts.length; i++) {
        const taper = Math.sin(((i - 0.5) / (pts.length - 1)) * Math.PI);
        p.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], Math.max(1.5, w * k * taper * Math.max(size, 0.6)), c);
      }
    }
  }
}
function curseLink(mx, my, tx, ty) {
  // 대상 카드: 카드 전체를 비스듬히 가르는 큰 할퀴기 세 줄
  clawMarks(tx, ty, 1);
}
// 얼음 결정 조각: (x, y) 중심, 길이 len, 폭 w, 방향 ang(라디안, 뾰족한 끝이 향하는 쪽)
function iceShard(x, y, len, w, ang, color) {
  const c = Math.cos(ang), sn = Math.sin(ang);
  const pt = (a, b) => [x + c * a - sn * b, y + sn * a + c * b];
  const shape = (k) => [pt(len * 0.5 * k, 0), pt(len * 0.12 * k, w * k), pt(-len * 0.36 * k, w * 0.8 * k), pt(-len * 0.5 * k, 0), pt(-len * 0.36 * k, -w * 0.8 * k), pt(len * 0.12 * k, -w * k)].flat();
  p.poly(shape(1.18), '#1b3a5c');
  p.poly(shape(1), color);
  p.poly([...pt(len * 0.5, 0), ...pt(len * 0.12, -w), ...pt(-len * 0.36, -w * 0.8), ...pt(-len * 0.3, -w * 0.45), ...pt(len * 0.1, -w * 0.5)], '#ffffff');
}
// 점액 방울(어두운 테두리 · 몸 색 · 흰 반사광)
function gooBlob(x, y, r, color) {
  p.circle(x, y, r + 3, '#16120c');
  p.circle(x, y, r, color);
  p.circle(x - r * 0.35, y - r * 0.35, Math.max(1.6, r * 0.3), '#f4fff0');
}
// 반투명 동그라미(연기·먼지·섬광)
function haze(x, y, r, color, alpha) { p.roundRect(x - r, y - r, r * 2, r * 2, r, color, alpha); }
// ── 알바트리온 속성 기술 연출(몬스터헌터 알바트리온 참고) ──
// 흉성 습격 폭발과 같은 결: 화면 색 번쩍임 + 몬스터 칸을 채우는 큰 연출 + 맞은 카드 아이콘 둘레의 작은 타격.
// 모든 모양은 4px 도트로 칠한다(부드러운 잡음으로 형태, 순서 디더링으로 색 경계, 어두운 외곽선으로 도트 그림 느낌).
const ALAT_FX = ['alflame', 'alwater', 'albolt', 'alice', 'aldragon'];
const ALAT_MOVE_COLOR = { alflame: '#ff8c23', alwater: '#46cdff', albolt: '#f0f546', alice: '#82d7ff', aldragon: '#e8407a' }; // 기술 띠 테두리 색(속성)
let alatTargets = []; // 이번 기술에 맞은 카드 아이콘 가운데 [x, y]
const AG = 4;
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bay = (i, j) => (BAYER4[(j & 3) * 4 + (i & 3)] + 0.5) / 16;
// 어두움→밝음 램프에서 v(0~1)의 색을 순서 디더링으로 고른다(두 색 사이를 격자 무늬로 섞음)
function ramp(pal, v, i, j) { const f = Math.max(0, Math.min(0.9999, v)) * (pal.length - 1), k = Math.floor(f); return pal[Math.min(pal.length - 1, k + (f - k > bay(i, j) ? 1 : 0))]; }
function vnoise(x, y, k = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), s = (t) => t * t * (3 - 2 * t), u = s(x - xi), v = s(y - yi);
  const a = hash2(xi, yi, k), b = hash2(xi + 1, yi, k), c = hash2(xi, yi + 1, k), d = hash2(xi + 1, yi + 1, k);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x, y, k = 0) => vnoise(x, y, k) * 0.5 + vnoise(x * 2.1, y * 2.1, k + 1) * 0.3 + vnoise(x * 4.3, y * 4.3, k + 2) * 0.2;
const ALAT_RAMP = {
  fire: ['#3a0606', '#7a0c0c', '#c01a10', '#e8401c', '#ff7a2a', '#ffb347', '#ffe28a', '#fffbe8'],
  water: ['#0a1a48', '#123c90', '#1e64d0', '#3c94f0', '#7cc8ff', '#c4ecff', '#ffffff'],
  thunder: ['#3a2a00', '#7a5a00', '#c89a10', '#f0c820', '#ffe040', '#fff59a', '#ffffff'],
  ice: ['#12345a', '#245a88', '#3c86b8', '#6cb4dc', '#a8dcf2', '#dcf4ff', '#ffffff'],
  dragon: ['#12041a', '#36093a', '#6e1250', '#b0185a', '#e8407a', '#ffa0d0', '#ffffff'],
  none: ['#16141e', '#2a2838', '#43405a', '#66627f', '#908ca8', '#c4c0d8', '#f4f2ff'], // 무속성(모집 로비·결과·전투 시작): 은빛 보랏빛
};
const ALAT_LINE = { none: '#0c0a14', fire: '#1e0404', water: '#06102e', thunder: '#241a00', ice: '#0a2440', dragon: '#0a0210' };
const ALAT_TINT = { none: ['#b8b4d0', '#14121e'], fire: ['#ff3a14', '#5a0000'], water: ['#1a6aff', '#001440'], thunder: ['#fff04a', '#3a3000'], ice: ['#9ae4ff', '#08304a'], dragon: ['#c0186a', '#1a0020'] };
// 화면 전체 색 번쩍임 + 가장자리를 어둡게(비네팅)
function alatTint(el, tint = 0.14, vig = 0.06) {
  const [tc, vc] = ALAT_TINT[el];
  p.roundRect(0, 0, W, H, 0, tc, tint);
  for (let k = 0; k < 6; k++) {
    const t = 110 - k * 17, sd = 150 - k * 24;
    p.roundRect(0, 0, W, t, 0, vc, vig); p.roundRect(0, H - t, W, t, 0, vc, vig);
    p.roundRect(0, 0, sd, H, 0, vc, vig); p.roundRect(W - sd, 0, sd, H, 0, vc, vig);
  }
}
// 도트 버퍼: 칸을 모아 두었다가 외곽선(빈 이웃 칸)과 함께 한 번에 칠한다
const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
// 같은 그림을 매번 새로 계산하지 않게 칸 목록을 저장해 둔다(에스카톤 방출처럼 화면 전체를 덮는 장면은 계산이 1.5초 넘게 걸려, 느린 호스트에서는 다음 단계가 건너뛰어졌다).
// pixCacheCtx 가 켜져 있으면 pixBuf 를 만든 순서대로 번호를 붙여 칸 목록을 기억하고, 다음부터는 계산(paint 의 노이즈)을 건너뛰고 저장된 칸만 그린다. 그림이 항상 같은 장면에서만 켠다.
let pixCacheCtx = null;
const pixCache = new Map();
function pixBuf(G = AG) { // G: 칸 크기(기본 4px, 2로 주면 더 잘게 칠한다)
  const m = new Map(), ck = pixCacheCtx ? `${pixCacheCtx.key}:${pixCacheCtx.n++}` : null, hit = ck ? pixCache.get(ck) : null;
  const buf = {
    clipY: H, // 이 y 아래는 칠하지 않는다(몬스터 칸 연출이 카드 뒤로 비치지 않게)
    set(i, j, c) { if (!hit && i >= 0 && j >= 0 && i * G < W && j * G < H) m.set(i * 1024 + j, [i, j, c]); },
    paint(x0, y0, x1, y1, fn) {
      if (hit) return buf; // 저장된 그림이 있으면 계산하지 않는다
      for (let j = Math.max(0, Math.floor(y0 / G)); j * G < Math.min(H, y1); j++) for (let i = Math.max(0, Math.floor(x0 / G)); i * G < Math.min(W, x1); i++) {
        const c = fn(i * G + G / 2, j * G + G / 2, i, j); if (c) buf.set(i, j, c);
      }
      return buf;
    },
    flush(outline) {
      if (hit) { for (let q = 0; q < hit.n; q++) { const j = hit.j[q]; if (j * G < buf.clipY) p.rect(hit.i[q] * G, j * G, G, G, hit.pal[hit.c[q]]); } return; }
      const list = [];
      if (outline) { const o = new Map(); for (const [i, j] of m.values()) for (const [di, dj] of N8) { const k = (i + di) * 1024 + j + dj; if (!m.has(k)) o.set(k, [i + di, j + dj]); } for (const [i, j] of o.values()) if (i >= 0 && j >= 0) list.push([i, j, outline]); }
      for (const [i, j, c] of m.values()) list.push([i, j, c]);
      if (ck) { // 저장: 칸 좌표(Int16) + 색 번호(Uint8) — 색은 따로 모아 둔다
        const pal = [], idx = new Map(), n = list.length, ai = new Int16Array(n), aj = new Int16Array(n), ac = new Uint8Array(n);
        list.forEach(([i, j, c], q) => { let k = idx.get(c); if (k === undefined) { k = pal.length; pal.push(c); idx.set(c, k); } ai[q] = i; aj[q] = j; ac[q] = k; });
        if (pal.length < 256) pixCache.set(ck, { i: ai, j: aj, c: ac, pal, n });
      }
      for (const [i, j, c] of list) if (j * G < buf.clipY) p.rect(i * G, j * G, G, G, c);
      m.clear();
    },
  };
  return buf;
}
const snap = (v) => Math.round(v / AG) * AG;
// 뾰족한 별 모양 작은 폭발(카드 타격용)
function pxBurst(buf, cx, cy, R, pal, rnd, squash = 0.8) {
  const N = 10, lens = Array.from({ length: N }, () => 0.55 + rnd() * 0.6);
  buf.paint(cx - R, cy - R * squash, cx + R, cy + R * squash, (x, y, i, j) => {
    const dx = x - cx, dy = (y - cy) / squash, r = Math.hypot(dx, dy); let th = Math.atan2(dy, dx); if (th < 0) th += Math.PI * 2;
    const seg = th / (Math.PI * 2) * N, i0 = Math.floor(seg) % N, f = seg - Math.floor(seg);
    const L = R * (lens[i0] * (1 - f) + lens[(i0 + 1) % N] * f) * (0.45 + 0.55 * Math.abs(Math.cos(f * Math.PI)));
    return r > L ? null : ramp(pal, 0.3 + (1 - r / L) * 0.75, i, j);
  });
}
// 지그재그 꺾임점
function zigzag(x0, y0, x1, y1, rnd, n, jag) {
  const L = Math.hypot(x1 - x0, y1 - y0) || 1, nx = -(y1 - y0) / L, ny = (x1 - x0) / L, pts = [[x0, y0]];
  for (let k = 1; k < n; k++) { const t = k / n, o = (rnd() - 0.5) * jag; pts.push([x0 + (x1 - x0) * t + nx * o, y0 + (y1 - y0) * t + ny * o]); }
  pts.push([x1, y1]); return pts;
}
// 도트 번개: paths = [[점들, 굵기(0 가늘게·1 굵게)]] — 번짐(디더링 후광) → 외곽선 → 몸 → 하얀 심
function pxStrike(paths, pal, line, glowR = 0) {
  const core = new Map(), body = new Map();
  for (const [pts, wd] of paths) for (let k = 0; k < pts.length - 1; k++) {
    const [ax, ay] = pts[k], [bx, by] = pts[k + 1], n = Math.ceil(Math.hypot(bx - ax, by - ay) / 2);
    for (let q = 0; q <= n; q++) {
      const i = Math.floor((ax + (bx - ax) * q / n) / AG), j = Math.floor((ay + (by - ay) * q / n) / AG);
      core.set(i * 1024 + j, [i, j, wd]); body.set(i * 1024 + j, [i, j]);
      for (let dj = -wd; dj <= wd; dj++) for (let di = -wd; di <= wd; di++) if (di * di + dj * dj <= wd * wd + wd * 0.5) body.set((i + di) * 1024 + j + dj, [i + di, j + dj]); // wd: 굵기(칸 반지름)
    }
  }
  if (glowR) {
    const g = new Map();
    for (const [i, j] of core.values()) for (let dj = -glowR; dj <= glowR; dj++) for (let di = -glowR; di <= glowR; di++) {
      const d = Math.hypot(di, dj) / glowR, k = (i + di) * 1024 + j + dj;
      if (d <= 1 && !body.has(k) && bay(i + di, j + dj) < 0.5 * (1 - d) * (1 - d) + 0.04 * (1 - d)) g.set(k, [i + di, j + dj, d < 0.45 ? pal[3] : pal[2]]);
    }
    for (const [i, j, c] of g.values()) p.rect(i * AG, j * AG, AG, AG, c);
  }
  const out = new Map();
  for (const [i, j] of body.values()) for (const [di, dj] of N8) { const k = (i + di) * 1024 + j + dj; if (!body.has(k)) out.set(k, [i + di, j + dj]); }
  for (const [i, j] of out.values()) p.rect(i * AG, j * AG, AG, AG, line);
  for (const [i, j] of body.values()) p.rect(i * AG, j * AG, AG, AG, pal[4]);
  for (const [i, j, wd] of core.values()) p.rect(i * AG, j * AG, AG, AG, wd ? pal[pal.length - 1] : pal[5]); // 가는 줄기는 하얀 심 대신 밝은 색
}
// 밑(bx,by)에서 ang(0=위, +면 오른쪽으로 기움)으로 솟는 얼음 결정: 왼쪽 면 어둡게 · 오른쪽 면 밝게 · 하이라이트 줄 · 뾰족한 끝
function pxCrystal(buf, bx, by, h, w, ang, pal) {
  const ax = Math.sin(ang), ay = -Math.cos(ang), rx = -ay, ry = ax, ext = h + w;
  buf.paint(bx - ext, by - ext, bx + ext, by + 8, (x, y, i, j) => {
    const vx = x - bx, vy = y - by, v = vx * ax + vy * ay, u = vx * rx + vy * ry;
    if (v < -4 || v > h) return null;
    const lim = v < h * 0.7 ? w / 2 : (w / 2) * (h - v) / (h * 0.3); if (Math.abs(u) > lim) return null;
    let s = u < 0 ? 0.32 + (v / h) * 0.12 : 0.6 + (v / h) * 0.1;
    if (u > lim * 0.2 && u < lim * 0.5 && v < h * 0.85) s = 0.96;
    if (v > h * 0.7 && u >= 0) s = 0.82;
    return ramp(pal, s, i, j);
  });
}
// 도트 타원 고리
function pxEllipse(cx, cy, rx, ry, c, n = 64) { const seen = new Set(); for (let a = 0; a < n; a++) { const t = a / n * Math.PI * 2, x = snap(cx + Math.cos(t) * rx), y = snap(cy + Math.sin(t) * ry), k = x * 4096 + y; if (!seen.has(k)) { seen.add(k); p.rect(x - 2, y - 2, AG, AG, c); } } }
// 튀는 물방울 호(위로 솟았다 떨어짐)
function droplets(cx, cy, n, spread, hgt, pal, rnd) {
  for (let q = 0; q < n; q++) {
    const dir = (q / (n - 1)) * 2 - 1, vx = dir * spread * (0.6 + rnd() * 0.5), vh = hgt * (0.55 + rnd() * 0.5) * (1 - Math.abs(dir) * 0.45);
    for (let s = 1; s <= 8; s++) {
      const t = s / 8, x = cx + vx * t, y = cy - vh * 4 * t * (1 - t) * 0.95 - vh * 0.1 * t;
      if (s < 8 && bay(Math.floor(x / AG), Math.floor(y / AG)) > 0.35 + t * 0.5) continue;
      const sz = s === 8 ? 8 : 4; p.rect(snap(x) - sz / 2, snap(y) - sz / 2, sz, sz, s === 8 ? pal[5] : pal[4]);
      if (s === 8) p.rect(snap(x) - 2, snap(y) - 2, 4, 4, '#ffffff');
    }
  }
}
function pxFlake(x, y, big, c = '#ffffff', tip = '#a8dcf2') {
  x = snap(x); y = snap(y); p.rect(x, y, 4, 4, c);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { p.rect(x + dx * 4, y + dy * 4, 4, 4, c); if (big) p.rect(x + dx * 8, y + dy * 8, 4, 4, tip); }
  if (big) for (const [dx, dy] of [[1, 1], [-1, -1], [1, -1], [-1, 1]]) p.rect(x + dx * 8, y + dy * 8, 4, 4, tip);
}

// 빛 번짐: 겹겹의 반투명 띠(포스터화된 그라데이션) — 격자 점보다 부드럽게
function dglow(cx, cy, rx, ry, col, dens) { for (let k = 0; k < 5; k++) { const s = 1 - k * 0.19; p.roundRect(cx - rx * s, cy - ry * s, rx * 2 * s, ry * 2 * s, Math.min(rx, ry) * s, col, dens * 0.09); } }
// 불길 덩어리: 여러 갈래로 휘는 혀를 겹친 세기장을 단계 색으로 나눠 칠한다 —
// 바깥 붉은 불꽃 안에 주황·노랑 불꽃과 흰 심이 따로 일렁이고, 끝에서 불조각이 떨어져 나간다
const FIRE6 = ['#6a0a08', '#c01c0c', '#f0501a', '#ff9a2a', '#ffd24a', '#fff6d0'];
const DRAGON6 = ['#24051f', '#5a0d3c', '#961450', '#d8306a', '#ff7aa8', '#ffe4f0'];
function pxFire(buf, cx, baseY, w, h, pal6, k, lean = 0) {
  const r = seedRng(Math.floor(k) * 31 + 7), n = 3 + Math.floor(w / 26), ts = [];
  for (let q = 0; q < n; q++) { const f = q / (n - 1) - 0.5; ts.push({ x: cx + f * w * 0.78 + (r() - 0.5) * 10, b: baseY, h: h * (0.42 + 0.58 * Math.cos(f * Math.PI * 0.95)) * (0.72 + r() * 0.45), w: w * (0.3 + r() * 0.18), ph: r() * 6, curl: lean + (r() - 0.5) * 0.7, s: 1 }); }
  for (let q = 0; q < 3; q++) { const hh = h * (0.14 + r() * 0.1); ts.push({ x: cx + (r() - 0.5) * w * 0.7, b: baseY - h * (0.78 + r() * 0.35), h: hh, w: w * (0.08 + r() * 0.06), ph: r() * 6, curl: lean, s: 0.62 }); } // 떨어져 나간 불조각
  buf.paint(cx - w - h * 0.4, baseY - h * 1.3, cx + w + h * 0.4, baseY + 6, (x, y, i, j) => {
    const xd = x + (fbm(x / 9, y / 12 + k, k) - 0.5) * w * 0.2;
    let I = 0;
    for (const t of ts) {
      const v = (t.b - y) / t.h; if (v < -0.06 || v > 1) continue;
      const vv = Math.max(0, v), ax = t.x + Math.sin(vv * 4.4 + t.ph) * t.w * 0.3 * vv + t.curl * vv * vv * t.h * 0.35;
      const hw = (t.w / 2) * Math.pow(1 - vv, 0.8) * (vv < 0.12 ? 0.6 + vv / 0.12 * 0.4 : 1), e = 1 - Math.abs(xd - ax) / hw;
      if (e > 0) I = Math.max(I, e * (1 - Math.pow(vv, 1.3) * 0.72) * t.s);
    }
    if (I <= 0) return null;
    I += (bay(i, j) - 0.5) * 0.07 + (fbm(x / 13, y / 9 - k * 0.3, k + 9) - 0.5) * 0.2;
    return I > 0.8 ? pal6[5] : I > 0.63 ? pal6[4] : I > 0.46 ? pal6[3] : I > 0.3 ? pal6[2] : I > 0.14 ? pal6[1] : I > 0.04 ? pal6[0] : null;
  });
}
// 한 점을 향해 모이는(또는 퍼지는) 집중선: 격자 칸으로 끊어 그린다
function speedLines(cx, cy, n, r0, r1, col, rnd, squash = 1, yMin = 0, yMax = H) {
  for (let q = 0; q < n; q++) {
    const a = rnd() * Math.PI * 2, s = r0 + rnd() * (r1 - r0) * 0.3, e = s + (r1 - r0) * (0.3 + rnd() * 0.5);
    for (let r = s; r < e; r += AG) { const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * squash; if (y >= yMin && y < yMax && bay(Math.floor(x / AG), Math.floor(y / AG)) < 0.75 - (r - s) / (e - s) * 0.5) p.rect(snap(x), snap(y), AG, AG, col); }
  }
}
const cardLeft = (tx) => tx - CARD_W / 2;
// 카드 테두리를 속성 색으로 빛나게(바깥 디더링 번짐 + 밝은 선)
function cardRim(tx, col, glow) {
  const x = cardLeft(tx);
  for (let k = 0; k < 3; k++) p.strokeRoundRect(x - 2 - k * 3, CARD_Y - 2 - k * 3, CARD_W + 4 + k * 6, CARD_H + 4 + k * 6, 14 + k * 3, 3, glow, 0.35 - k * 0.1);
  p.strokeRoundRect(x, CARD_Y, CARD_W, CARD_H, 12, 3, col);
}
// 격자 점 빛 번짐(타원): 가운데일수록 촘촘한 도트 — 브레스 둘레의 달아오른 공기
function dotGlow(cx, cy, rx, ry, col, dens, yMin = 0) {
  const i0 = Math.max(0, Math.floor((cx - rx) / AG)), i1 = Math.min(W / AG, Math.ceil((cx + rx) / AG)), j0 = Math.max(Math.floor(yMin / AG), Math.floor((cy - ry) / AG)), j1 = Math.min(H / AG, Math.ceil((cy + ry) / AG));
  for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
    const dx = (i * AG + 2 - cx) / rx, dy = (j * AG + 2 - cy) / ry, d = dx * dx + dy * dy;
    if (d < 1 && bay(i, j) < dens * Math.pow(1 - d, 1.6)) p.rect(i * AG, j * AG, AG, AG, col);
  }
}
// 속성별 브레스 색: dark 화면 누름, edge 가장자리 연기·안개, glow 빛 번짐(바깥·안쪽), ray 집중선, mote 날리는 입자
const BREATH = {
  fire: { dark: '#1a0200', edge: ['#1e0c08', '#3e2018', '#6a3a2a'], glow: ['#c01a10', '#ff9a2a'], ray: '#ffb347', mote: ['#fffbe8', '#ffe28a', '#ffb347', '#ff7a2a'], tail: '#e8401c' },
  water: { dark: '#000a1e', edge: ['#06204a', '#123c78', '#3a6eb0'], glow: ['#1e64d0', '#7cc8ff'], ray: '#c4ecff', mote: ['#ffffff', '#e8f8ff', '#9fe0ff', '#7cc8ff'], tail: '#3c94f0' },
  thunder: { dark: '#04040a', edge: ['#14140c', '#2e2a14', '#5a4e1c'], glow: ['#c89a10', '#fff59a'], ray: '#fff59a', mote: ['#ffffff', '#fffbc0', '#ffe040', '#f0c820'], tail: '#c89a10' },
  ice: { dark: '#020a18', edge: ['#1a3450', '#4a7094', '#9cc4e0'], glow: ['#3c86b8', '#dcf4ff'], ray: '#ffffff', mote: ['#ffffff', '#f4feff', '#dcf4ff', '#a8dcf2'], tail: '#6cb4dc' },
  dragon: { dark: '#0a0006', edge: ['#10020c', '#2a081e', '#521838'], glow: ['#6e1250', '#e8407a'], ray: '#ffa0d0', mote: ['#ffffff', '#ffa0d0', '#e8407a', '#b0185a'], tail: '#6e1250' },
};
// 브레스 줄기의 모양: 입(ox,oy)에서 (ex,ey) 방향으로 원근으로 넓어진다. 칸마다 [축 방향 t, 폭 비율 u]
function breathAxis(ox, oy, ex, ey) { const L = Math.hypot(ex - ox, ey - oy) || 1; return { L, ux: (ex - ox) / L, uy: (ey - oy) / L }; }
// 브레스 줄기 속 질감: (t 입에서부터 거리 비율, u 폭 비율 -1~1) → 색
const BREATH_TEX = {
  // 화염: 일렁이는 불길 + 방사 줄무늬, 가장자리는 말려 오르는 검은 연기
  fire(t, u, au, x, y, i, j, k, R, B) {
    if (au > 1.3) return null;
    const n = fbm(u * 2.4 + 9, t * 5.5 - u * u * 2, k), st = fbm(u * 13 + 3, t * 1.3, k + 4);
    const I = (1 - Math.pow(Math.min(1, au), 2.2)) * 0.88 + (n - 0.5) * 0.85 + (st - 0.5) * 0.6 - t * 0.08;
    if (I > 0.16) return ramp(R, Math.min(1, (I - 0.1) * 1.35), i, j);
    if (I > -0.12 && t > 0.05) { const sm = fbm(x / 24, y / 24 + t * 2, k + 7); return bay(i, j) < 0.3 + sm * 0.6 ? B.edge[sm > 0.6 ? 2 : sm > 0.48 ? 1 : 0] : null; }
    return null;
  },
  // 물: 입에서 쏟아지는 물살 — 가운데는 흰 물줄기, 둘레로 나선 띠가 감겨 흐르고 가장자리는 거품과 튀는 물방울
  water(t, u, au, x, y, i, j, k, R) {
    const en = fbm(t * 9, u * 2 + 5, k), lim = 0.9 + (en - 0.5) * 0.4;
    if (au > lim + 0.25) return au < lim + 0.55 && t > 0.06 && hash2(i, j, k) < 0.1 * (1 - (au - lim - 0.25) / 0.3) ? (hash2(i, j, k + 1) < 0.5 ? '#ffffff' : R[4]) : null;
    if (au > lim) return bay(i, j) < 0.6 + en * 0.4 ? (en > 0.48 ? '#ffffff' : R[5]) : null;
    const ang = Math.asin(Math.max(-1, Math.min(1, u / lim))), helix = Math.sin(t * 46 - ang * 2.6 + k), core = Math.max(0, 1 - au / (lim * 0.34));
    return ramp(R, 0.34 + (1 - au / lim) * 0.3 + helix * 0.2 + core * 0.35 + (fbm(t * 7, u * 3, k + 2) - 0.5) * 0.18, i, j);
  },
  // 낙뢰: 입에서 터지는 전기 — 노란 안개 속에 갈라지는 번개 핏줄(능선 잡음의 밝은 선)과 하얀 심, 가장자리는 튀는 스파크
  thunder(t, u, au, x, y, i, j, k, R) {
    if (au > 1.12) return null;
    const ridge = 1 - Math.abs(fbm(t * 6 + u * 1.2, u * 3.4, k) - 0.5) * 7, vein = ridge > 0.62 ? ridge : 0;
    const fog = (1 - Math.pow(Math.min(1, au), 1.8)) * 0.55 + (fbm(t * 8, u * 4, k + 3) - 0.5) * 0.3 - t * 0.1;
    if (au < 0.1 + 0.03 * Math.sin(t * 40)) return '#ffffff';
    if (vein) return vein > 0.82 ? '#ffffff' : R[5];
    if (fog > 0.2) return ramp(R, 0.18 + fog, i, j);
    return fog > 0.04 && bay(i, j) < fog * 3 ? R[1] : null;
  },
  // 용: 입에서 뿜는 어둠의 불 — 흰 심, 자홍 몸, 검붉은 바깥 연기, 그 위를 가르는 붉은 균열
  dragon(t, u, au, x, y, i, j, k, R, B) {
    const en = fbm(t * 7, u * 2, k), lim = 1 + (en - 0.5) * 0.35;
    if (au > lim) return au < lim + 0.3 && t > 0.05 && bay(i, j) < 0.55 * (1 - (au - lim) / 0.3) ? B.edge[hash2(i, j, k) < 0.5 ? 1 : 2] : null;
    const body = 1 - Math.pow(au / lim, 1.6), crack = Math.abs(fbm(t * 5 + u, u * 3, k + 6) - 0.5) < 0.03;
    if (au < 0.08) return '#ffffff';
    if (crack) return '#14000a';
    return ramp(R, 0.16 + body * 0.78 + (fbm(t * 9, u * 5, k + 1) - 0.5) * 0.22, i, j);
  },
};
// 뒤 배경을 가로지르는 브레스(몬스터 칸 층): 화면 누름 → 도트 빛 → 원뿔 줄기(흐르는 결·방사 줄무늬·연기 가장자리) → 집중선
function breathField(el, ox, oy, ex, ey, spread, k0, rnd, tMax = 9) {
  const R = ALAT_RAMP[el], B = BREATH[el], { L, ux, uy } = breathAxis(ox, oy, ex, ey);
  p.roundRect(0, 0, W, H, 0, B.dark, 0.5);
  dotGlow(ox, oy + 30, 330, 230, B.glow[0], 0.55, 110); dotGlow(ox, oy + 10, 170, 110, B.glow[1], 0.6, 110);
  const buf = pixBuf(), tex = BREATH_TEX[el];
  buf.paint(0, 112, W, H, (x, y, i, j) => {
    const vx = x - ox, vy = y - oy, t = (vx * ux + vy * uy) / L; if (t < -0.02 || t > tMax) return null;
    const u = (-vx * uy + vy * ux) / (14 + spread * Math.pow(Math.max(0, t), 1.1));
    return tex(t, u, Math.abs(u), x, y, i, j, k0, R, B);
  });
  buf.flush(null);
  speedLines(ox, oy, 70, 80, 560, B.ray, rnd, 0.75, 110, CARD_Y); // HP 바 아래부터
  return { L, ux, uy };
}
// 브레스를 타고 관객 쪽으로 날아드는 입자(맨 위 층, 멀수록 크다). 입 쪽으로 꼬리
function breathMotes(el, ox, oy, ex, ey, spread, rnd, n = 46) {
  const B = BREATH[el], { L, ux, uy } = breathAxis(ox, oy, ex, ey);
  for (let q = 0; q < n; q++) {
    const t = 0.15 + rnd() * 0.85, u = (rnd() - 0.5) * 1.6, hw = 14 + spread * Math.pow(t, 1.1);
    const x = ox + ux * t * L - uy * u * hw, y = oy + uy * t * L + ux * u * hw; if (x < 0 || x > W || y < 112 || y > H) continue;
    const sz = 4 + Math.floor(t * 1.6) * 4, dx = x - ox, dy = y - oy, d = Math.hypot(dx, dy) || 1, tail = 6 + t * 26;
    if (el === 'ice' && q % 3 === 0) { pxFlake(x, y, t > 0.5); continue; }
    for (let s = AG; s < tail; s += AG) if (bay(Math.floor((x - dx / d * s) / AG), Math.floor((y - dy / d * s) / AG)) < 1 - s / tail) p.rect(snap(x - dx / d * s), snap(y - dy / d * s), AG, AG, B.tail);
    p.rect(snap(x) - sz / 2, snap(y) - sz / 2, sz, sz, B.mote[Math.floor(rnd() * 4)]);
  }
}

// 화면 아무 데나 흩어진 입자(꼬리 방향 dirAt(x,y) → [dx,dy])
function scatterMotes(cols, tailCol, rnd, n, dirAt, yMin = 120) {
  for (let q = 0; q < n; q++) {
    const x = rnd() * W, y = yMin + rnd() * (H - yMin), sz = 4 + Math.floor(rnd() * 2) * 4, [dx, dy] = dirAt(x, y), tail = 8 + rnd() * 22;
    for (let s = AG; s < tail; s += AG) if (bay(Math.floor((x - dx * s) / AG), Math.floor((y - dy * s) / AG)) < 1 - s / tail) p.rect(snap(x - dx * s), snap(y - dy * s), AG, AG, tailCol);
    p.rect(snap(x) - sz / 2, snap(y) - sz / 2, sz, sz, cols[Math.floor(rnd() * cols.length)]);
  }
}
const RED_BOLT = ['#1a0006', '#5a0a1a', '#a01430', '#e8203a', '#ff5a6a', '#ffb0b8', '#ffffff'];

// 맞은 카드 테두리 변화(속성마다): 화염 숯·불씨 / 물 거품·흘러내림 / 번개 테두리를 도는 전류 / 서리 성에 / 용 검붉은 잠식
function cardBorderFx(el, tx, k0, rnd) {
  const x0 = cardLeft(tx), x1 = x0 + CARD_W, y0 = CARD_Y, y1 = CARD_Y + CARD_H, R = ALAT_RAMP[el], buf = pixBuf();
  const edgeD = (x, y) => Math.min(x - x0, x1 - x, y - y0, y1 - y);
  if (el === 'thunder') { // 전기가 흐르는 테두리: 바깥 빛 번짐 → 안쪽 전기 띠(속을 기는 하얀 잔전류) → 두 겹 테두리 전류 → 모서리 건너뛰는 전류·십자 섬광 → 바깥으로 튀는 방전·불꽃
    buf.paint(x0 - 16, y0 - 16, x1 + 16, y1 + 16, (x, y, i, j) => {
      const d = edgeD(x, y), n = fbm(x / 10, y / 10, k0 + tx);
      if (d < 0) { const o = -d; return o < 16 && bay(i, j) < (1 - o / 16) * (0.35 + n * 0.4) ? (o < 6 ? R[4] : R[3]) : null; }
      const thr = 5 + n * 16 * (y < y0 + 60 || y > y1 - 60 ? 1 : 0.7); if (d > thr) return null;
      if (Math.abs(fbm(x / 7, y / 7, k0 + 5) - 0.5) < 0.045) return '#ffffff';
      return bay(i, j) < (1 - d / thr) * 1.15 ? ramp(R, 0.5 + (1 - d / thr) * 0.45, i, j) : null;
    });
    buf.flush(null);
    p.strokeRoundRect(x0, y0, CARD_W, CARD_H, 12, 3, '#fff59a');
    const paths = [], pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
    for (let s = 0; s < 4; s++) {
      const [ax, ay] = pts[s], [bx, by] = pts[s + 1], nx = -(by - ay), ny = bx - ax, L = Math.hypot(nx, ny), ix = -nx / L * 6, iy = -ny / L * 6; // ix,iy: 카드 안쪽으로 6px
      paths.push([zigzag(ax, ay, bx, by, rnd, 16, 10), 1]);
      paths.push([zigzag(ax + ix, ay + iy, bx + ix, by + iy, rnd, 20, 16), 0]);
      for (let q = 0; q < 3; q++) { // 바깥으로 짧게 튀는 방전
        const t = 0.1 + rnd() * 0.8, sx = ax + (bx - ax) * t, sy = ay + (by - ay) * t, len = 16 + rnd() * 26;
        paths.push([zigzag(sx, sy, sx + nx / L * len + (rnd() - 0.5) * 16, sy + ny / L * len + (rnd() - 0.5) * 16, rnd, 3, 10), 0]);
      }
    }
    const crn = [[x0, y0, 1, 1], [x1, y0, -1, 1], [x1, y1, -1, -1], [x0, y1, 1, -1]];
    for (const [cx, cy, sx, sy] of crn) paths.push([zigzag(cx + sx * 34, cy - sy * 4, cx - sx * 4, cy + sy * 34, rnd, 5, 14), 0]); // 모서리를 건너뛰는 전류
    pxStrike(paths, R, ALAT_LINE.thunder, 3);
    for (const [cx, cy] of crn) { const x = snap(cx), y = snap(cy); for (let s = 4; s <= 16; s += 4) { const c = s < 12 ? '#ffffff' : R[5]; p.rect(x - s, y, 4, 4, c); p.rect(x + s, y, 4, 4, c); p.rect(x, y - s, 4, 4, c); p.rect(x, y + s, 4, 4, c); } p.rect(x - 4, y - 4, 12, 12, R[5]); p.rect(x, y, 4, 4, '#ffffff'); } // 모서리 십자 섬광
    for (let q = 0; q < 26; q++) { const s = Math.floor(rnd() * 4), t = rnd(), [ax, ay] = pts[s], [bx, by] = pts[s + 1], o = (rnd() - 0.3) * 22; const x = ax + (bx - ax) * t + (s % 2 ? o * (s === 1 ? 1 : -1) : 0), y = ay + (by - ay) * t + (s % 2 ? 0 : o * (s === 0 ? -1 : 1)); p.rect(snap(x), snap(y), 4, 4, rnd() < 0.5 ? '#ffffff' : R[5]); } // 테두리 둘레 불꽃 알갱이
    return;
  }
  if (el === 'water') { // 젖음: 카드 전체에 옅은 물빛 막 + 위에서 흘러내리는 물줄기 몇 가닥(끝에 맺힌 방울). 테두리·거품은 그리지 않는다
    p.roundRect(x0, y0, CARD_W, CARD_H, 12, R[3], 0.10);
    p.roundRect(x0 + 3, y0 + 3, CARD_W - 6, 26, 10, R[5], 0.12); // 윗면 물막의 번들거림
    const sr = seedRng(k0 * 7 + Math.floor(tx));
    for (let q = 0; q < 6; q++) {
      const sx = snap(x0 + 14 + sr() * (CARD_W - 28)), sy = y0 + 4 + sr() * 30, len = 22 + sr() * 70;
      p.roundRect(sx - 1, sy, 3, len, 1.5, R[4], 0.38); // 물줄기
      p.roundRect(sx - 1, sy, 1, len, 0.5, R[6], 0.35);  // 줄기의 하이라이트
      p.circle(sx, sy + len + 2, 3.2, R[4], 0.7); p.circle(sx - 1, sy + len + 1, 1.2, R[6]); // 끝의 물방울
    }
    return;
  }
  buf.paint(x0 - 6, y0 - 6, x1 + 6, y1 + 6, (x, y, i, j) => {
    const d = edgeD(x, y), n = fbm(x / 14, y / 14, k0 + tx); if (d < -5) return null;
    if (el === 'ice') { // 테두리부터 번지는 성에
      const thr = 6 + n * 26 * (y < y0 + 120 ? 1 : 0.5); if (d > thr) return null;
      return n > 0.62 && d > thr * 0.5 ? '#ffffff' : ramp(R, 0.62 + (1 - d / thr) * 0.35, i, j);
    }
    if (el === 'fire') { // 타들어간 가장자리: 바깥은 이글거리는 불씨, 안쪽은 숯, 숯 사이로 달아오른 금
      const thr = 5 + n * 24 * (y < y0 + 90 || y > y1 - 60 ? 1 : 0.6); if (d > thr) return null;
      if (d < thr * 0.35) return ramp(ALAT_RAMP.fire, 0.55 + (1 - d / (thr * 0.35)) * 0.45, i, j);
      return Math.abs(fbm(x / 9, y / 9, k0 + 5) - 0.5) < 0.04 ? '#ff7a2a' : (n > 0.55 ? '#4a1206' : '#240804');
    }
    if (el === 'water') { // 젖은 느낌만: 가장자리에 얇은 물막이 듬성듬성 비치고, 옆면을 따라 물방울 줄기가 조금 흘러내린다(카드를 덮지 않게 성기게)
      const top = y - y0, drip = Math.max(0, 1 - top / (30 + hash2(Math.floor(x / 14), 1, k0) * 90));
      const thr = 3 + n * 6 + (x - x0 < 10 || x1 - x < 10 ? drip * 10 : 0);
      if (d > thr || bay(i, j) > 0.55 + (n - 0.5)) return null;
      return d < 2 ? R[6] : ramp(R, 0.35 + (1 - d / thr) * 0.3, i, j);
    }
    if (el === 'dragon') { // 검붉은 잠식: 테두리에서 안으로 번지는 어둠과 그 속을 흐르는 붉은 핏줄
      const thr = 8 + n * 34; if (d > thr) return null;
      const vein = Math.abs(fbm(x / 11, y / 11, k0 + 9) - 0.5) < 0.035;
      return vein ? (d < thr * 0.6 ? '#ff5a8a' : '#d8306a') : (d < thr * 0.3 ? '#5a0d3c' : bay(i, j) < 1 - d / thr ? '#24051f' : null);
    }
    return null;
  });
  buf.flush(null);
  if (el === 'fire') for (let q = 0; q < 14; q++) { const x = x0 + rnd() * CARD_W, y = y0 - 4 - rnd() * 40; p.rect(snap(x), snap(y), 4, 4, rnd() < 0.5 ? '#ffe28a' : '#ff7a2a'); }
}


// 알바트리온 기술 연출 — 모두 화면 뒤 배경을 가로지르는 큰 연출이지만, 기술마다 모양과 방향이 다르다.
//   화염: 입에서 아래로 원근으로 퍼지는 브레스 / 물: 입에서 좌우 화면 끝까지 가로지르는 물살
//   낙뢰: 먹구름에서 화면을 세로로 가르는 번개 기둥들 / 서리: 몸에서 사방으로 터지는 얼음 창 / 용: 화면 전체를 휘감는 소용돌이
// layer 'field' = 몬스터 칸 층(카드·말풍선·현황 패널보다 아래), 'hit' = 맨 위(맞은 카드 타격·입자·화면 색)
// mx,my: 몬스터 가운데, targets: 맞은 카드 아이콘 가운데 [x, y]
const ALAT_FX_EL = { alflame: 'fire', alwater: 'water', albolt: 'thunder', alice: 'ice', aldragon: 'dragon' };
function alatOverlay(fx, mx, my, targets, layer) {
  const el = ALAT_FX_EL[fx]; if (!el) return;
  const rnd = seedRng(energyTick * 5 + (layer === 'hit' ? 17 : 3) + mx), k0 = Math.floor(seedRng(energyTick)() * 50), oy = my - 8, floorY = 340; // oy: 알바트리온 그림의 입 높이
  const R = ALAT_RAMP[el], B = BREATH[el], buf = pixBuf(), field = layer === 'field';
  const ts = targets.length ? targets : [[mx, CARD_Y + 86]];
  if (el === 'fire') {
    if (field) { breathField('fire', mx, oy, mx, H, 600, k0, rnd); return; }
    for (const [tx, ty] of targets) { cardBorderFx('fire', tx, k0, rnd); pxFire(buf, tx, ty + 32, 72, 52, FIRE6, tx + 7); buf.flush(ALAT_LINE.fire); }
    breathMotes('fire', mx, oy, mx, H, 600, rnd, 46);
  } else if (el === 'water') {
    // 소용돌이 해류: 입에서 터진 물이 나선으로 회전하는 터널이 되어 화면 전체를 감싸며 다가온다.
    // 가운데(몬스터)는 소용돌이의 눈, 바깥으로 갈수록 물결 고리(파도 마루)의 간격이 넓어져 관객 쪽으로 밀려오는 원근이 생긴다
    const cy = oy + 6;
    if (field) {
      p.roundRect(0, 0, W, H, 0, B.dark, 0.5);
      buf.paint(0, 112, W, H, (x, y, i, j) => {
        const dx = x - mx, dy = (y - cy) / 0.72, r = Math.hypot(dx, dy);
        if (r < 80) return null; // 소용돌이 눈: 몬스터가 보이게 비워 둔다
        if (r < 92) return fbm(x / 6, y / 6, k0) > 0.4 ? '#ffffff' : R[5]; // 소용돌이 눈의 거품 테
        const th = Math.atan2(dy, dx), lr = Math.log(r / 80) / Math.log(1.55), tw = th + lr * 0.75;
        const fr = (((lr - 0.12 * (k0 % 7)) % 1) + 1) % 1, cn = fbm(Math.cos(th) * 3 + 7, Math.sin(th) * 3 + lr * 2, k0 + 2);
        if (fr < 0.12 + (cn - 0.5) * 0.14) return fbm(x / 7, y / 7, k0 + 3) > 0.35 ? '#ffffff' : R[5]; // 다가오는 파도 마루
        const st = fbm(Math.cos(tw) * 3 + lr * 0.4, Math.sin(tw) * 3 + lr * 1.8, k0), swirl = Math.sin(tw * 6 - lr * 2) * 0.5 + 0.5;
        return ramp(R, 0.16 + (1 - fr) * 0.34 + swirl * 0.22 + (st - 0.5) * 0.5, i, j);
      });
      buf.flush(null);
      speedLines(mx, cy, 60, 100, 620, B.ray, rnd, 0.72, 110, H);
      return;
    }
    for (const [tx, ty] of targets) { cardBorderFx('water', tx, k0, rnd); }
    scatterMotes(B.mote, B.tail, rnd, 16, (x, y) => { const dx = x - mx, dy = y - cy, d = Math.hypot(dx, dy) || 1; return [dx / d, dy / d]; });
  } else if (el === 'thunder') {
    // 천뢰 낙하: 먹구름이 소용돌이치며 갈라지고, 화면을 세로로 가르는 빛기둥이 맞은 사람 앞 바닥에 꽂힌다.
    // 꽂힌 자리엔 빛의 반구가 솟고, 두꺼운 충격파 고리가 원근으로 커지며 파티 쪽으로 밀려온다
    const gx = ts[0][0], gy = floorY - 2, top = 112;
    if (field) {
      p.roundRect(0, 0, W, H, 0, B.dark, 0.62);
      for (let q = 0; q < 50; q++) { const x = rnd() * W, y = 200 + rnd() * 430, len = 10 + rnd() * 16; for (let s = 0; s < len; s += AG) p.rect(snap(x - s * 0.35), snap(y + s), AG, AG, '#2a3450'); } // 옅은 비
      const storm = ['#04050a', '#0c1022', '#181e36', '#2a3250', '#4a4e60', '#a8984e', '#f0e488', '#ffffff'];
      buf.paint(0, top, W, 250, (x, y, i, j) => { // 먹구름: 기둥 위에서 소용돌이치고 밑면이 달아오른다
        const dx = x - gx, dy = (y - top) * 2.2, r = Math.hypot(dx, dy), sw = Math.atan2(dy, dx) * 2 + r / 60;
        const dens = fbm(Math.cos(sw) * 2 + x / 140, Math.sin(sw) * 2 + y / 40, k0) * 1.35 - (y - top) / 120 + (fbm(x / 20, y / 14, k0 + 3) - 0.5) * 0.3;
        if (dens < 0.2) return null;
        const lit = Math.max(0, 1 - r / 260) * (0.4 + (y - top) / 160);
        return ramp(storm, Math.min(1, dens * 0.7 + lit * 0.9), i, j);
      });
      buf.flush(null);
      dotGlow(gx, 230, 190, 240, B.glow[0], 0.32, top); dotGlow(gx, gy, 320, 90, B.glow[1], 0.4, top);
      buf.paint(gx - 120, top, gx + 120, gy + 4, (x, y, i, j) => { // 빛기둥: 흰 심 + 아래로 흐르는 결 + 가장자리는 지직거리며 흩어짐
        const t = (y - top) / (gy - top), hw = 40 + 22 * t, u = (x - gx + Math.sin(y / 23 + k0) * 6) / hw, au = Math.abs(u);
        if (au > 1.25) return null;
        if (au < 0.3 + 0.06 * Math.sin(y / 9)) return au < 0.18 || fbm(x / 6, y / 10, k0 + 9) > 0.45 ? '#ffffff' : R[5];
        const st = fbm(u * 7 + 3, y / 70, k0 + 5), flick = Math.sin(y / 5 + k0) > 0.8 ? 0.12 : 0;
        const v = (1 - au) * 0.95 + (st - 0.5) * 0.5 + flick;
        if (au > 0.85 && bay(i, j) > (1.25 - au) * 2.2) return null;
        return v > 0.12 ? ramp(R, Math.min(1, v + 0.1), i, j) : null;
      });
      buf.flush(null);
      buf.paint(gx - 170, gy - 110, gx + 170, gy + 6, (x, y, i, j) => { // 꽂힌 자리에서 솟는 빛의 반구
        const d = Math.hypot((x - gx) / 160, (y - gy) / 100); if (d > 1 || y > gy + 4) return null;
        if (d > 0.82 && bay(i, j) > (1 - d) * 5) return null;
        return ramp(R, 1.05 - d * 0.75 + (fbm(x / 12, y / 12, k0 + 6) - 0.5) * 0.3, i, j);
      });
      buf.flush(null);
      for (const [rx, ry, w, v] of [[240, 42, 26, 0.95], [440, 80, 40, 0.7]]) { // 두꺼운 충격파 고리(앞쪽이 밝고 뒤로 흐려짐)
        buf.paint(gx - rx - w, gy - ry - w, gx + rx + w, gy + ry + w, (x, y, i, j) => {
          const d = Math.hypot((x - gx) / rx, (y - gy) / ry), b = (d - 1) * rx; if (Math.abs(b) > w / 2 || y < top + 4) return null;
          const f = 1 - Math.abs(b) / (w / 2), front = y > gy ? 1 : 0.22;
          return bay(i, j) < f * 1.7 * front ? ramp(R, (v * f + (fbm(x / 9, y / 9, k0 + 2) - 0.5) * 0.3) * front + 0.1, i, j) : null;
        });
      }
      buf.flush(null);
      const main = zigzag(gx + (rnd() - 0.5) * 30, top, gx, gy, rnd, 11, 36), paths = [[main, 1]];
      for (let b = 0; b < 4; b++) { const s = main[2 + b * 2], sd = b % 2 ? 1 : -1; paths.push([zigzag(s[0], s[1], s[0] + sd * (40 + rnd() * 50), s[1] + 20 + rnd() * 40, rnd, 5, 16), 0]); } // 기둥에서 뻗는 곁가지
      pxStrike(paths, R, ALAT_LINE.thunder, 6);
      buf.paint(gx - 300, gy - 60, gx + 300, gy + 40, (x, y, i, j) => { // 꽂힌 자리: 흰 심이 달아오른 납작한 타원 + 가로로 길게 뻗는 섬광 + 짧은 세로 섬광(외곽선 없이 빛만)
        const dx = Math.abs(x - gx), dy = Math.abs(y - gy), core = Math.hypot(dx / 84, dy / 24);
        if (core < 1) return core < 0.55 ? '#ffffff' : (bay(i, j) < (1 - core) * 2.4 ? '#ffffff' : R[5]);
        const hf = 1 - dx / 290; if (hf > 0 && dy < 2 + 6 * hf) return bay(i, j) < hf * 1.6 ? (dy < 4 ? '#ffffff' : R[5]) : null;
        const vf = 1 - dy / 56; if (vf > 0 && dx < 2 + 5 * vf && y < gy) return bay(i, j) < vf * 1.6 ? '#ffffff' : null;
        return null;
      });
      buf.flush(null);
      for (let q = 0; q < 16; q++) { const a = -Math.PI * (0.05 + rnd() * 0.9), d = 50 + rnd() * 90, x = gx + Math.cos(a) * d * 1.6, y = gy + Math.sin(a) * d * 0.7; p.rect(snap(x), snap(y), 4, 4, rnd() < 0.5 ? '#ffffff' : R[5]); } // 튀는 불꽃
      for (let q = 0; q < 22; q++) { const a = -Math.PI * (0.08 + rnd() * 0.84), d = 70 + rnd() * 170, x = gx + Math.cos(a) * d * 1.5, y = gy + Math.sin(a) * d, sz = 8 + Math.floor(rnd() * 3) * 4; if (y < top) continue; p.rect(snap(x), snap(y), sz, sz, '#16140c'); p.rect(snap(x), snap(y), sz / 2, sz / 2, '#f0c820'); } // 튀어 오르는 바닥 파편
      speedLines(gx, gy, 46, 140, 640, B.ray, rnd, 0.5, top, H);
      return;
    }
    for (const [tx] of targets) cardBorderFx('thunder', tx, k0, rnd);
    p.roundRect(0, 0, W, H, 0, '#fffbe0', 0.12);
    scatterMotes(B.mote, B.tail, rnd, 30, (x, y) => { const dx = x - gx, dy = y - gy, d = Math.hypot(dx, dy) || 1; return [dx / d, dy / d]; });
  } else if (el === 'ice') {
    // 빙결 해일: 입에서 냉기 줄기가 바닥으로 내리꽂히자, 그 자리부터 얼음 결정 무리가 파도처럼 파티 쪽으로 밀려온다.
    // 먼 줄은 작고 푸르스름하게 어둡고, 가까운 줄일수록 거대하고 밝다. 맨 앞 마루에선 하얀 냉기와 얼음 파편이 터져 흩날린다
    const hz = 292, deep = ['#06142a', '#0c2440', '#163a60', '#245a88', '#3c86b8', '#6cb4dc', '#a8dcf2'];
    if (field) {
      p.roundRect(0, 0, W, H, 0, B.dark, 0.48);
      dotGlow(mx, hz + 20, 460, 110, B.glow[0], 0.5, 112);
      buf.paint(20, hz, W - 20, CARD_Y + 4, (x, y, i, j) => { const a = Math.atan2(x - mx, y - hz + 30), crack = Math.abs(Math.sin(a * 15 + fbm(x / 40, y / 40, k0) * 3)) > 0.965; return crack ? R[1] : ramp(deep, 0.35 + fbm(x / 30, y / 10, k0 + 4) * 0.4, i, j); }); // 얼어붙은 바닥
      buf.flush(null);
      buf.paint(mx - 90, oy + 20, mx + 90, hz + 16, (x, y, i, j) => { // 입에서 바닥으로 내리꽂는 냉기 줄기
        const t = (y - oy - 20) / (hz + 10 - oy - 20); if (t < 0 || t > 1) return null;
        const hw = 14 + 56 * Math.pow(t, 1.2), au = Math.abs(x - mx + (fbm(y / 18, 2, k0) - 0.5) * 16 * t) / hw; if (au > 1.15) return null;
        if (au > 0.8 && bay(i, j) > (1.15 - au) * 2.6) return null;
        return au < 0.2 ? '#ffffff' : ramp(R, 1 - au * 0.6 + (fbm(x / 8, y / 14, k0 + 8) - 0.5) * 0.35, i, j);
      });
      buf.flush(null);
      const N = 6;
      for (let k = 0; k < N; k++) { // 뒤 줄부터: 무리 지어(한 무리 2~4개를 부채꼴로), 사이사이 빈자리
        const z = k / (N - 1), by = hz + 8 + Math.pow(z, 1.3) * 58, s = 0.35 + Math.pow(z, 1.5) * 2.3, gap = 80 + z * 120, n = Math.ceil(W / gap) + 2;
        const pal = z < 0.5 ? deep : R; // 먼 줄은 어둡고 푸르게(공기 원근)
        for (let q = 0; q < n; q++) {
          if (hash2(k, q, k0 + 9) < 0.22) continue;
          const cx = mx + (q - (n - 1) / 2) * gap + (hash2(k, q, k0) - 0.5) * gap * 0.6;
          if (k < 3 && Math.abs(cx - mx) < 70) continue; // 몬스터 발밑 바로 앞은 비워 몸이 보이게
          const cnt = 2 + Math.floor(hash2(q, k, k0 + 3) * 3), big = (30 + hash2(q, k, k0 + 1) * 34) * s;
          for (let c = 0; c < cnt; c++) {
            const f = cnt === 1 ? 0 : c / (cnt - 1) - 0.5, h = big * (c === Math.floor(cnt / 2) ? 1 : 0.45 + hash2(c, q, k0 + 4) * 0.35);
            pxCrystal(buf, cx + f * big * 0.35, by, h, 8 + h * 0.26, f * 0.9 + (cx - mx) / 1300, pal);
          }
        }
        buf.flush(ALAT_LINE.ice);
      }
      buf.paint(0, CARD_Y - 70, W, CARD_Y + 4, (x, y, i, j) => { // 맨 앞 마루에서 터지는 하얀 냉기
        const h = 50 + fbm(x / 50, 1, k0 + 11) * 40, d = (CARD_Y + 4 - y) / h; if (d > 1) return null;
        return bay(i, j) < (1 - d) * 0.85 * (0.5 + fbm(x / 16, y / 16, k0 + 12)) ? (d < 0.4 ? '#ffffff' : '#dcf4ff') : null;
      });
      buf.flush(null);
      return;
    }
    for (const [tx, ty] of targets) { cardBorderFx('ice', tx, k0, rnd); for (const [dx, h, a] of [[-50, 30, -0.35], [-34, 20, -0.7], [50, 30, 0.35], [34, 20, 0.7]]) pxCrystal(buf, tx + dx, ty + 30, h, 12 + h * 0.12, a, R); buf.flush(ALAT_LINE.ice); }
    for (let q = 0; q < 16; q++) { const x = rnd() * W, y = CARD_Y - 120 + rnd() * 160, h = 10 + rnd() * 16; pxCrystal(buf, x, y, h, 6 + h * 0.3, (rnd() - 0.5) * 3, R); } // 날아드는 얼음 파편
    buf.flush(ALAT_LINE.ice);
    for (let q = 0; q < 14; q++) { const x = snap(rnd() * W), y = snap(130 + rnd() * 480), L = 8 + Math.floor(rnd() * 3) * 4; p.rect(x - L, y, L * 2 + 4, 4, '#ffffff'); p.rect(x, y - L, 4, L * 2 + 4, '#ffffff'); p.rect(x - 4, y - 4, 12, 12, '#dcf4ff'); p.rect(x, y, 4, 4, '#ffffff'); } // 반짝임
    for (let q = 0; q < 22; q++) pxFlake(rnd() * W, 120 + rnd() * 500, rnd() < 0.4);
  } else if (el === 'dragon') {
    // 정면 광선: 입에서 쏜 굵은 광선이 화면(파티)을 정면으로 꿰뚫는다 — 흰 심, 붉고 검은 동심원, 방사 줄무늬가 화면을 채우고 테두리엔 붉은 번개
    const cx = mx, cy = oy + 8;
    if (field) {
      p.roundRect(0, 0, W, H, 0, B.dark, 0.62);
      const edgeAt = (th) => 330 * (0.85 + 0.3 * fbm(Math.cos(th) * 2 + 3, Math.sin(th) * 2 + 3, k0));
      buf.paint(0, 112, W, H, (x, y, i, j) => {
        const dx = x - cx, dy = (y - cy) / 0.8, r = Math.hypot(dx, dy), th = Math.atan2(dy, dx), edge = edgeAt(th);
        if (r > edge) return r < edge + 150 && bay(i, j) < 0.5 * (1 - (r - edge) / 150) * (0.4 + 0.6 * (Math.sin(th * 14 + fbm(Math.cos(th) * 5, Math.sin(th) * 5, k0 + 4) * 4) * 0.5 + 0.5)) ? B.edge[hash2(i, j, k0) < 0.5 ? 1 : 2] : null;
        const q = r / edge; if (q < 0.15) return '#ffffff';
        const streak = Math.sin(th * 22 + fbm(Math.cos(th) * 4, q * 3, k0 + 2) * 5) * 0.5 + 0.5, ring = Math.sin(q * 26 - k0) > 0.86 ? 0.16 : 0;
        return ramp(R, 1 - q * 0.88 + (streak - 0.5) * 0.4 * q + ring, i, j);
      });
      buf.flush(null);
      speedLines(cx, cy, 70, 120, 640, B.ray, rnd, 0.8, 110, H);
      const arcs = [];
      for (let q = 0; q < 8; q++) { const a0 = rnd() * Math.PI * 2, pts = []; for (let s = 0; s <= 6; s++) { const a = a0 + s * 0.1, rr = edgeAt(a) * (0.95 + rnd() * 0.12); const y = cy + Math.sin(a) * rr * 0.8; if (y < 116) break; pts.push([cx + Math.cos(a) * rr, y]); } if (pts.length > 2) arcs.push([pts, q < 3 ? 1 : 0]); } // 광선 테두리를 기는 붉은 번개
      pxStrike(arcs, RED_BOLT, '#14000a', 4);
      return;
    }
    for (const [tx] of targets) cardBorderFx('dragon', tx, k0, rnd);
    scatterMotes(B.mote, B.tail, rnd, 44, (x, y) => { const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy) || 1; return [dx / d, dy / d]; });
  }
  alatTint(el, 0.07, 0.05);
}

// 알바트리온 기술 움직임: 정지 그림이라도 위치·크기·잔상으로 동작이 보이게 한다(이전 위치에 잔상, 진행 방향에 속도선).
//   브레스(화염·물·서리): 뒤로 젖혔다 앞으로 숙이며 내뿜음 / 낙뢰: 날개를 펴고 위로 솟구침 / 용의 숨결: 크게 부풀며 앞으로 / 발톱: 앞으로 돌진 / 필살(에스카톤): 선택 화면에서 떨며 떠오르고, 결과에선 내리꽂음
function alatMotion(fx, charging, cx, cy, turn) {
  // 몬스터가 연출 앞으로 튀어나와 커지지 않게: 크기·앞뒤 이동 없이 제자리에서 살짝 떠오르며 날갯짓하듯 위아래로만 움직인다(잔상·속도선 없음)
  const j = (k) => ((turn * 7 + k * 13) % 5) - 2; // 턴마다 다른 작은 떨림
  if (charging) return { x: cx + j(1) * 2, y: cy - 6 + j(2), s: 1, ghosts: [] };
  if (fx === 'smash') return { x: cx, y: cy - 4, s: 1, ghosts: [] };
  if (fx === 'attack') return { x: cx + 8, y: cy - 2, s: 1, ghosts: [] };
  if (ALAT_FX.includes(fx)) return { x: cx, y: cy - 8, s: 1, ghosts: [] };
  return null;
}
function alatStreaks({ x, y, dir }) { // 움직임 방향 속도선: dir 1 앞(아래)·-1 위·0 사방
  const col = ['#ffffff', '#cfc8e0', '#8a82a0'];
  for (let q = 0; q < 14; q++) {
    const sx = x + (q - 6.5) * 18 + ((q * 37) % 9) - 4, len = 16 + ((q * 53) % 22);
    const y0 = dir >= 0 ? y - 70 - ((q * 29) % 20) : y + 30 + ((q * 29) % 20);
    for (let t = 0; t < len; t += 4) if ((t / 4 + q) % 3) p.rect(Math.round(sx / 4) * 4, Math.round((y0 + (dir >= 0 ? t : -t)) / 4) * 4, 4, 4, col[Math.min(2, Math.floor(t / (len / 3)))]);
  }
}
// 입 앞에서 아래로 짧게 퍼지는 숨결(몸 앞에 그린다): 입 속 빛 → 좁은 원뿔 → 흩어지는 입자. 몸통을 가리지 않게 짧고 가늘게
function alatMouthBurst(el, x, y, up) {
  const R = ALAT_RAMP[el], buf = pixBuf(), k = Math.floor(seedRng(energyTick + 9)() * 50);
  buf.paint(x - 30, y - 4, x + 30, y + 46, (px, py, i, j) => {
    const t = (py - y) / 40; if (t < 0 || t > 1) return null;
    const hw = 4 + 20 * Math.pow(t, 0.9), a = Math.abs(px - x + (fbm(py / 9, 1, k) - 0.5) * 6 * t) / hw; if (a > 1) return null;
    if (bay(i, j) > (1 - t * 0.85) * 1.15) return null; // 끝으로 갈수록 성기게 흩어짐
    return ramp(R, 1 - a * 0.7 - t * 0.12, i, j);
  });
  buf.flush(null);
  for (let q = 0; q < 10; q++) { const t = 0.2 + ((q * 37) % 8) / 10, off = (((q * 53) % 9) - 4) * (3 + t * 4); p.rect(Math.round((x + off) / 4) * 4, Math.round((y + t * 52) / 4) * 4, 4, 4, q % 2 ? '#ffffff' : R[R.length - 2]); }
}
function monsterFx(move, cx, cy, color, layer, spore = color, accent = spore) {
  if (!move) return;
  if (ALAT_FX.includes(move)) { if (layer === (move === 'alflame' || move === 'alice' || move === 'albolt' ? 'front' : 'back')) alatOverlay(move, cx, cy, alatTargets, 'field'); return; } // 화염 브레스만 입에서 몸 앞으로 쏟아지고, 나머지 기술은 몸 뒤 배경 연출 // 알바트리온: 몬스터 칸 연출(카드·말풍선보다 아래), 타격은 맨 위에서 'hit'
  if (HEUNG_FX.includes(move)) { heungMonsterFx(move, cx, cy, layer); return; }
  if (move === 'fart' && layer === 'front') {
    // 구린 방귀: 뒤돌아선 엉덩이에서 뿜어진 커다란 가스 덩어리 하나가 파티 쪽(아래·양옆)으로 뭉게뭉게 부풀어 퍼진다.
    // 겹친 원들의 합집합을 8px 도트로 칠하고(외곽선·그늘·밝은 면), 엉덩이 쪽엔 '뿌웅' 충격선.
    const G2 = 8;
    const puffs = [[0, 52, 44], [-78, 74, 40], [78, 74, 40], [-160, 96, 38], [160, 96, 38], [-240, 112, 32], [240, 112, 32],
      [-36, 106, 40], [36, 106, 40], [-118, 122, 34], [118, 122, 34], [-300, 126, 22], [300, 126, 22]];
    const inside = (x, y) => puffs.some(([dx, dy, r]) => (x - (cx + dx)) ** 2 + (y - (cy + dy)) ** 2 <= r * r);
    const nearTop = (x, y) => puffs.some(([dx, dy, r]) => { const ux = x - (cx + dx), uy = y - (cy + dy); return ux * ux + uy * uy <= r * r && uy < -r * 0.35 && ux < r * 0.3; });
    const bottom = cy + 146; // 몬스터 칸 아래 끝 위에서 멈춘다
    for (let y = cy + 4; y <= bottom; y += G2) for (let x = cx - 330; x <= cx + 330; x += G2) {
      if (!inside(x, y)) continue;
      const edge = !inside(x - G2, y) || !inside(x + G2, y) || !inside(x, y - G2) || !inside(x, y + G2) || y + G2 > bottom;
      const shade = !inside(x, y + G2 * 2) || y + G2 * 2 > bottom;
      p.rect(x - G2 / 2, y - G2 / 2, G2, G2, edge ? '#4a3c18' : nearTop(x, y) ? '#e6dca0' : shade ? '#8c7c3a' : '#bcae5c');
    }
    // 뿌웅: 엉덩이 바로 아래 양옆으로 짧은 충격선
    for (const [x1, y1, x2, y2] of [[-62, 22, -96, 8], [62, 22, 96, 8], [-56, 40, -100, 40], [56, 40, 100, 40]]) p.line(cx + x1, cy + y1, cx + x2, cy + y2, 4, '#f4ecc0');
    return;
  }
  if (move === 'peel' && layer === 'front') {
    // 바나나 껍질 뿌리기: 몸 둘레로 흩날리는 바나나 껍질 + 작은 노란 조각
    for (const [dx, dy] of [[-150, -46], [156, -40], [-182, 30], [188, 36], [-96, 70], [104, 74]]) drawPixels(PEEL, cx + dx, cy + dy, 6);
    for (const [dx, dy] of [[-120, -10], [126, -6], [-60, 84], [66, 86]]) dot(cx + dx, cy + dy, 5, '#f5d040');
    return;
  }
  const G = 8;
  const cell = (x, y, c) => p.rect(cx + Math.round((x - cx) / G) * G - G / 2, cy + Math.round((y - cy) / G) * G - G / 2, G, G, c);
  if (move === 'spore' && layer === 'front') {
    // 갓 밑에서 사방으로 퍼지는 포자 가루: 몸 쪽 작은 도트 → 끝에 2×2 가루 뭉치
    for (const [ux, uy, dist] of SPRAY) {
      const at = (d) => [cx + ux * d, cy + uy * d * 0.62];
      cell(...at(dist * 0.5), spore);
      cell(...at(dist * 0.72), spore);
      const [ex, ey] = at(dist);
      for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]]) cell(ex + i * G, ey + j * G, (i + j) % 2 ? color : spore);
    }
    return;
  }
  if (move === 'hypno' && layer === 'back') {
    // 최면술: 몸 양옆으로 퍼져 나가는 최면 물결(도트 호 세 겹, 청록·보라 번갈아) + 반짝임
    hypnoWaves(cx, cy - 4, 1, color);
    for (const [dx, dy, sz] of [[-96, -70, 5], [100, -66, 4], [-200, -20, 4], [204, 10, 5], [-60, 74, 4], [70, 72, 4]]) sparkle(cx + dx, cy + dy, sz, '#e8fffb');
    return;
  }
  if (move === 'absorb' && layer === 'back') {
    // 독기 흡수: 여섯 갈래 독기 줄기가 휘어 들며 몸으로 빨려 듦 — 꼬리는 가늘고 어둡게, 머리는 굵고 밝게.
    // 위쪽(HP 바)과 오른쪽 피해 숫자 자리는 피한다.
    const purple = ['#5a2a72', '#8a44b0', spore, '#f1cdfb'];
    const lime = ['#3d5a1a', '#7aa832', accent, '#f4ffd0'];
    [-158, -112, 160, -22, 22, 112].forEach((deg, k) => {
      const tones = k % 2 ? lime : purple;
      const dir = Math.cos((deg * Math.PI) / 180) > 0 ? 1 : -1;
      const pts = [];
      for (let i = 0; i <= 6; i++) {
        const r = 182 - i * 12;
        const a = (deg * Math.PI) / 180 + i * 0.09 * dir; // 같은 방향으로 감겨 들어감
        pts.push([cx + Math.cos(a) * r, cy - 2 + Math.sin(a) * r * 0.46]);
      }
      // 혜성처럼: 꼬리 쪽 작은 어두운 도트 → 머리 쪽 큰 밝은 도트(촘촘히 이어 줄기로 보이게)
      pts.forEach(([x, y], i) => dot(x, y, 4 + i * 1.6, tones[Math.min(3, Math.floor(i / 1.75))]));
      dot(pts[6][0] - 2, pts[6][1] - 2, 4, '#ffffff');
    });
    return;
  }
  if (move === 'frost' && layer === 'front') {
    // 서리 숨결: 입에서 아래·양옆으로 퍼지는 하얀 입김 도트(바깥으로 갈수록 크게) + 눈송이
    for (const [ux, uy] of [[-1, 0.3], [-0.6, 0.8], [0, 1], [0.6, 0.8], [1, 0.3]]) {
      for (let i = 1; i <= 5; i++) {
        const d = 44 + i * 26;
        dot(cx + ux * d, cy + 26 + uy * d * 0.5, 4 + i * 1.6, i % 2 ? '#ffffff' : color);
      }
    }
    for (const [dx, dy, r] of [[-176, -30, 9], [180, -22, 9], [-126, 64, 7], [134, 66, 7]]) flake(cx + dx, cy + dy, r);
    return;
  }
  if (move === 'icefall' && layer === 'back') {
    // 빙하 낙하: 떨어지는 조각들 뒤의 짧은 속도선
    for (const [x0, y0] of [[-210, -60], [-120, -78], [120, -80], [210, -62], [-40, -84], [40, -86]]) {
      for (let i = 0; i < 3; i++) p.line(cx + x0 - 16 - i * 10, cy + y0 + 40 - i * 12, cx + x0 - 9 - i * 10, cy + y0 + 50 - i * 12, 3 - i * 0.6, '#e8fbff'); // 조각 뒤 짧은 속도선(몬스터 칸 안)
    }
    return;
  }
  if (move === 'icefall' && layer === 'front') {
    // 비스듬히 내리꽂히는 커다란 빙하 결정 조각 + 바닥에서 터지는 서리 충격파(흰 고리 · 얼음 가시 · 눈송이)
    for (const [x0, y0, len, w] of [[-210, -24, 74, 16], [-126, 6, 92, 20], [126, 4, 92, 20], [212, -26, 74, 16], [-44, 30, 60, 13], [48, 28, 60, 13]]) {
      iceShard(cx + x0, cy + y0, len, w, 1.05, color);
    }
    for (let k = 0; k < 26; k++) { const a = (k / 26) * Math.PI * 2; dot(cx + Math.cos(a) * 190, cy + 66 + Math.sin(a) * 26, k % 2 ? 5 : 7, k % 2 ? '#bfeaff' : '#ffffff'); }
    for (const sd of [-1, 1]) for (const [d, h] of [[150, 24], [196, 34], [236, 20]]) iceShard(cx + sd * d, cy + 62 - h / 2, h + 10, 6, -Math.PI / 2, color);
    for (const [dx, dy, r] of [[-250, -60, 8], [250, -54, 8], [-90, 60, 7], [92, 62, 7]]) flake(cx + dx, cy + dy, r);
    return;
  }
  // ── 고스트 ──
  if (move === 'wail' && layer === 'back') {
    // 울부짖기: 입에서 터져 나가는 들쭉날쭉한 음파 고리 세 겹(안쪽은 밝고 굵게, 바깥은 흐리게)
    for (const [r, w, c] of [[96, 6, '#f4f0ff'], [132, 5, '#c3b4ff'], [168, 4, '#7c5fd6']]) {
      jaggedArc(cx, cy + 18, r, -0.85, 0.85, 0.62, w, c);
      jaggedArc(cx, cy + 18, r, Math.PI - 0.85, Math.PI + 0.85, 0.62, w, c);
    }
    return;
  }
  if (move === 'wail' && layer === 'front') {
    // 공기가 떨리는 짧은 선(입 양옆)
    for (const s of [-1, 1]) for (const [dx, dy] of [[70, -20], [78, 8], [70, 36]]) p.line(cx + s * dx, cy + dy, cx + s * (dx + 16), cy + dy - 6, 4, '#f4f0ff');
    return;
  }
  if (move === 'phase' && layer === 'back') {
    // 투명화: 몸 둘레 흩어지는 반짝임
    for (const [dx, dy, sz] of [[-120, -50, 5], [124, -40, 5], [-150, 20, 4], [150, 30, 4], [-70, 70, 4], [80, 66, 5], [0, -80, 4]]) sparkle(cx + dx, cy + dy, sz, '#e6dcff');
    return;
  }
  if (move === 'storm' && layer === 'back') {
    // 원혼 폭풍: 세 갈래 나선 팔(바깥은 진한 보라, 안쪽으로 갈수록 밝게)이 몸을 휘감는 회오리
    for (let arm = 0; arm < 3; arm++) {
      for (let i = 0; i < 26; i++) {
        const t = i / 25, a = arm * (Math.PI * 2 / 3) + t * 4.2, r = 210 - t * 120;
        dot(cx + Math.cos(a) * r, cy + 10 + Math.sin(a) * r * 0.38, 4 + t * 7, t < 0.35 ? '#4b2f8f' : t < 0.7 ? '#8a6ae0' : '#d9ceff');
      }
    }
    return;
  }
  if (move === 'storm' && layer === 'front') {
    // 회오리를 타고 도는 작은 유령들(앞쪽은 밝고 크게, 뒤쪽은 어둡고 작게)
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + 0.3, r = k % 2 ? 175 : 140;
      const x = cx + Math.cos(a) * r, y = cy + 10 + Math.sin(a) * r * 0.38;
      drawPixels(Math.sin(a) > 0 ? MINI_GHOST : MINI_GHOST_DARK, x, y, Math.sin(a) > 0 ? 5 : 4);
    }
    return;
  }
  // ── 꼬마 폭탄 ──
  if (move === 'dust' && layer === 'back') {
    // 분진 흩날리기: 몸 양옆으로 퍼지는 뿌연 화약 먼지
    for (const [dx, dy, r] of [[-130, 30, 46], [-195, 46, 36], [130, 30, 46], [195, 46, 36], [-80, 62, 32], [80, 64, 32], [-160, 0, 30], [160, 0, 30]]) haze(cx + dx, cy + dy, r, '#8a7a66', 0.16); // 아주 옅게 겹쳐 뿌연 먼지처럼
    return;
  }
  if (move === 'dust' && layer === 'front') {
    // 화약 가루 알갱이(갈색·회색 네모, 바깥으로 갈수록 작고 듬성) + 사이사이 불티 — 매번 같은 모양(고정 난수)
    let seed = 7;
    const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    for (let i = 0; i < 70; i++) {
      const side = i % 2 ? 1 : -1, t = rnd();
      const x = cx + side * (60 + t * 170), y = cy + 6 + (rnd() - 0.3) * 90 * (0.4 + t);
      const sz = 7 - t * 4;
      p.rect(x, y, sz, sz, i % 7 === 0 ? '#ff9a3c' : i % 5 === 0 ? '#ffe066' : i % 2 ? '#5e4f40' : '#9c8a72');
    }
    return;
  }
  if (move === 'smoke' && layer === 'front') {
    // 연막탄: 반투명 연기 뭉치가 겹겹이 — 아래는 짙고 위로 갈수록 옅게 피어오름
    for (const [dx, dy, r, a] of [
      [-150, 60, 44, 0.55], [-90, 74, 40, 0.6], [-20, 80, 42, 0.6], [50, 78, 40, 0.6], [120, 70, 44, 0.55], [180, 56, 34, 0.5],
      [-200, 40, 30, 0.45], [-130, 20, 34, 0.4], [140, 18, 34, 0.4], [210, 30, 28, 0.4],
      [-110, -24, 26, 0.28], [100, -30, 28, 0.28], [-40, -60, 22, 0.2], [60, -64, 20, 0.2],
    ]) {
      // 옅게 여러 겹: 공처럼 보이지 않게 진하기를 낮추고 위쪽에 밝은 겹을 살짝
      haze(cx + dx, cy + dy, r * 1.15, '#6a6a76', a * 0.32);
      haze(cx + dx, cy + dy, r * 0.8, '#7e7e8a', a * 0.3);
      haze(cx + dx - r * 0.2, cy + dy - r * 0.35, r * 0.55, '#c4c4ce', a * 0.25);
    }
    return;
  }
  if (move === 'ignite' && layer === 'back') {
    // 점화: 도화선 끝의 뜨거운 빛
    haze(cx + 22, cy - 56, 34, '#ffe066', 0.35);
    return;
  }
  if (move === 'ignite' && layer === 'front') {
    // 도화선 끝에서 치익 터지는 불꽃 별 + 바로 둘레를 도는 작은 불티 + 위로 피어오르는 연기 세 줄기
    const fx = cx + 22, fy = cy - 56;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2, len = k % 2 ? 14 : 26;
      p.line(fx, fy, fx + Math.cos(a) * len, fy + Math.sin(a) * len * (Math.sin(a) < 0 ? 0.45 : 1), k % 2 ? 3 : 5, k % 2 ? '#ff9a3c' : '#ffe066');
    }
    p.circle(fx, fy, 6, '#ffffff');
    for (let k = 0; k < 10; k++) { const a = (k / 10) * Math.PI * 2 + 0.3; dot(fx + Math.cos(a) * 36, fy + 6 + Math.sin(a) * 18, k % 2 ? 3 : 4, k % 2 ? '#ffe066' : '#ff6a2c'); }
    for (const [dx, dy, r] of [[-30, -6, 9], [-44, -12, 7], [40, -8, 8], [56, -12, 6], [-14, -14, 6]]) haze(fx + dx, fy + dy, r, '#a4a4b0', 0.45);
    return;
  }
  if (move === 'boom' && layer === 'back') {
    // 대폭발: 몬스터 칸 전체가 붉게 물들고, 몸 뒤로 들쭉날쭉한 거대한 폭발 섬광(빨강 → 주황 → 노랑 → 흰 심)
    p.roundRect(20, 120, W - 40, 224, 14, '#ff2a14', 0.22);
    const spikes = (r1, r2, n, c, rot) => {
      const pts = [];
      for (let k = 0; k < n * 2; k++) {
        const a = rot + (k / (n * 2)) * Math.PI * 2, r = k % 2 ? r2 : r1 * (0.85 + ((k * 37) % 10) / 40);
        pts.push(cx + Math.cos(a) * r, cy + 10 + Math.sin(a) * r * 0.62);
      }
      p.poly(pts, c);
    };
    spikes(250, 150, 14, '#7a0f08', 0.1);
    spikes(215, 125, 14, '#e8401c', 0.3);
    spikes(170, 100, 12, '#ff9a3c', 0.05);
    spikes(120, 75, 10, '#ffe066', 0.2);
    haze(cx, cy + 10, 70, '#ffffff', 0.55);
    return;
  }
  if (move === 'boom' && layer === 'front') {
    // 사방으로 날아가는 시커먼 파편(뒤로 불꼬리) + 바닥 충격선
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2 + 0.2, r = 205 + (k % 3) * 18;
      const x = cx + Math.cos(a) * r, y = cy + 10 + Math.sin(a) * r * 0.5;
      p.line(x - Math.cos(a) * 30, y - Math.sin(a) * 15, x - Math.cos(a) * 10, y - Math.sin(a) * 5, 4, '#ffb070');
      p.poly([x - 9, y - 6, x + 3, y - 11, x + 10, y + 2, x - 2, y + 9], '#1a0d08');
      p.poly([x - 5, y - 3, x + 2, y - 6, x + 6, y + 1, x - 1, y + 5], '#5a3a2a');
    }
    for (const s of [-1, 1]) for (const [d, y] of [[110, 70], [160, 76], [220, 70]]) p.line(cx + s * d, cy + y, cx + s * (d + 40), cy + y + 4, 5, '#ffe066');
    return;
  }
  if (move === 'burst' && layer === 'back') {
    // 포자 대폭발: 몸 둘레 충격 고리(도트, 보라·연두 번갈아)
    for (let k = 0; k < 30; k++) {
      const a = (k / 30) * Math.PI * 2;
      dot(cx + Math.cos(a) * 128, cy + 6 + Math.sin(a) * 128 * 0.42, 8, k % 2 ? spore : accent);
    }
    return;
  }
  if (move === 'burst' && layer === 'front') {
    // 사방으로 터져 나가는 큰 포자 구름 뭉치 + 그 바깥 파편 한 알씩
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
      const [px, py] = [cx + Math.cos(a) * 182, cy + 4 + Math.sin(a) * 182 * 0.4];
      // 날아가는 꼬리(몸 쪽으로 작아지는 가루 두 알) + 포자 알갱이
      dot(cx + Math.cos(a) * 128, cy + 4 + Math.sin(a) * 128 * 0.4, 5, spore);
      dot(cx + Math.cos(a) * 150, cy + 4 + Math.sin(a) * 150 * 0.4, 7, spore);
      puff(px, py, 9, k % 2 ? spore : color, '#f1cdfb');
      dot(cx + Math.cos(a + 0.16) * 236, cy + 4 + Math.sin(a + 0.16) * 236 * 0.38, 7, accent);
    }
    return;
  }
  if (move === 'attack' && layer === 'back') {
    // 위에서 아래로 내리꽂는 속도선(도트: 아래로 갈수록 크고 밝게)
    for (const [dx, n] of [[-72, 3], [-42, 4], [42, 4], [72, 3]]) {
      for (let i = 0; i < n; i++) dot(cx + dx, cy - 82 + i * 11, 4 + i * 1.5, i === n - 1 ? '#fff6e6' : '#c9b89a');
    }
  } else if (move === 'sweep' && layer === 'front') {
    // 몸에서 바깥으로 튀어 나가는 점액 — 몬스터와 같은 칸(8px) 격자에 맞춘 도트:
    // 몸 쪽에 작은 점 두 개(궤적) → 끝에 십자 모양 큰 방울(왼쪽 위 칸은 밝은 반사광)
    const G = 8;
    const cell = (x, y, c) => p.rect(cx + Math.round((x - cx) / G) * G - G / 2, cy + Math.round((y - cy) / G) * G - G / 2, G, G, c);
    for (const [ux, uy, dist] of SPRAY) {
      const at = (d) => [cx + ux * d, cy + uy * d * 0.62];
      cell(...at(dist * 0.55), color);
      cell(...at(dist * 0.75), color);
      const [ex, ey] = at(dist);
      for (const [i, j] of [[0, -1], [-1, 0], [0, 0], [1, 0], [0, 1]]) cell(ex + i * G, ey + j * G, color);
      cell(ex - G, ey - G, '#eaffdf');
    }
  } else if (move === 'charge' && layer === 'back') {
    // 빨아들이는 기운: 바깥에서 몸 쪽으로 모이는 선
    for (const [dx, dy] of [[-130, -40], [-140, 20], [130, -40], [140, 20], [-90, -66], [90, -66]]) {
      p.line(cx + dx, cy + dy, cx + dx * 0.72, cy + dy * 0.72, 4, color);
    }
  } else if (move === 'heal' && layer === 'front') {
    // 재생: 몸 주위로 피어오르는 초록 십자
    for (const [dx, dy, s] of [[-110, -20, 9], [-80, -60, 7], [104, -10, 9], [76, -58, 7], [-130, 26, 6], [128, 30, 6]]) {
      p.rect(cx + dx - s, cy + dy - s / 3, s * 2, (s * 2) / 3, '#7cff9a');
      p.rect(cx + dx - s / 3, cy + dy - s, (s * 2) / 3, s * 2, '#7cff9a');
    }
  } else if (move === 'smash' && layer === 'front' && themeKey !== ':alat') {
    // 필살 짓누르기(시안 A 굵은 충격선): 양옆으로 뻗는 노란 충격선 세 줄씩(바깥으로 갈수록 가늘게) + 흙먼지 뭉치 + 위로 튀는 작은 충격 별
    for (const sd of [-1, 1]) {
      for (const [y0, y1, len, w] of [[30, 6, 150, 7], [48, 40, 190, 9], [62, 66, 220, 7]]) {
        for (let i = 0; i < 8; i++) { const t0 = i / 8, t1 = (i + 1) / 8; p.line(cx + sd * (84 + len * t0), cy + y0 + (y1 - y0) * t0, cx + sd * (84 + len * t1), cy + y0 + (y1 - y0) * t1, Math.max(2, w * (1 - t0 * 0.7)), '#ffd166'); }
      }
      for (const [dx, dy, r] of [[120, 68, 11], [160, 60, 9], [205, 72, 10], [250, 62, 8]]) { p.circle(cx + sd * dx, cy + dy, r, '#8a7a62'); p.circle(cx + sd * dx - r * 0.3, cy + dy - r * 0.3, r * 0.35, '#b8a888'); }
      star(cx + sd * 110, cy - 10, 9, '#ffd166'); star(cx + sd * 170, cy - 30, 6, '#fff1c2');
    }
  }
}

// ── 흉성(용뢰) 기술 연출·피격 이펙트·상태 배지 ──
// 기존 몬스터처럼 기술마다 몬스터 쪽 연출(monsterFx), 맞은 카드 이펙트(hitFx), 상태 배지를 따로 둔다. 색은 용뢰(검붉은 심 · 붉은 줄기 · 하얀 속).
const HEUNG_FX = ['thump', 'chain', 'erode', 'lightning', 'release', 'comet'];
const ALL_BOX = { x0: 0, y0: 0, x1: W, y1: H };
const RED3 = ['#3a0a10', '#e8203a', '#fff0e8']; // 심(어두운) · 줄기 · 속
function redBolt(x0, y0, x1, y1, rnd, w = 5) { skyBolt(x0, y0, x1, y1, rnd, w, ALL_BOX); }
function slash(x0, y0, x1, y1, w) { for (const [k, c] of [[w + 6, RED3[0]], [w, RED3[1]], [Math.max(2, w - 5), RED3[2]]]) p.line(x0, y0, x1, y1, k, c); }
function cometAt(hx, hy, dx, dy, K = 1) { // 머리(hx,hy)에서 (dx,dy) 방향으로 길게 이어지는 혜성: 어두운 연기 → 붉은 줄기 → 밝은 속, 머리는 하얀 핵
  const L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L;
  for (let i = 0; i < 20; i++) { const t = i / 20, r = (22 - 16 * t) * K; dot(hx + ux * L * t, hy + uy * L * t, r * 2.2, t > 0.55 ? '#4a3430' : '#8a1a22'); }
  for (let i = 0; i < 18; i++) { const t = i / 18, r = (15 - 11 * t) * K; dot(hx + ux * L * t * 0.8, hy + uy * L * t * 0.8, r * 2, t > 0.5 ? '#e8203a' : '#ff6a4a'); }
  for (let i = 0; i < 10; i++) { const t = i / 10, r = (8 - 5 * t) * K; dot(hx + ux * L * t * 0.45, hy + uy * L * t * 0.45, r * 2, '#fff0e8'); }
  p.circle(hx, hy, 17 * K, '#ffb090'); p.circle(hx, hy, 12 * K, '#fff6e0'); p.circle(hx, hy, 6 * K, '#ffffff');
}
function ringDots(cx, cy, rx, ry, n, size, c) { for (let a = 0; a < n; a++) { const t = a / n * Math.PI * 2; dot(cx + Math.cos(t) * rx, cy + Math.sin(t) * ry, size, c); } }
// ── 도트 덩어리 그리기 도구(기존 몬스터 연출처럼 6~8px 칸 + 어두운 테두리 → 본색 → 밝은 속) ──
const HG = 6;
const HKEY = (i, j) => i * 10000 + j;
function pxBolt(x0, y0, x1, y1, rnd, w = 1, jag = 26, whiteCore = false, g = HG) { // 칸 단위로 굳힌 지그재그 번개(검붉은 테두리 · 붉은 몸 · 하얀 속). g: 칸 크기(작을수록 가늘고 정교). 지나간 꺾임점을 돌려준다
  const L = Math.hypot(x1 - x0, y1 - y0) || 1, n = Math.max(4, Math.round(L / (g * 5.5))), nx = -(y1 - y0) / L, ny = (x1 - x0) / L;
  const pts = [[x0, y0]];
  for (let k = 1; k < n; k++) { const t = k / n, o = (rnd() - 0.5) * jag; pts.push([x0 + (x1 - x0) * t + nx * o, y0 + (y1 - y0) * t + ny * o]); }
  pts.push([x1, y1]);
  const core = new Map();
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, ay] = pts[k], [bx, by] = pts[k + 1], m = Math.ceil(Math.hypot(bx - ax, by - ay) / 2);
    for (let q = 0; q <= m; q++) { const x = ax + (bx - ax) * q / m, y = ay + (by - ay) * q / m; core.set(HKEY(Math.floor(x / g), Math.floor(y / g)), [Math.floor(x / g), Math.floor(y / g)]); }
  }
  const thick = new Map(core);
  if (w >= 2) for (const [i, j] of core.values()) for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) thick.set(HKEY(i + di, j + dj), [i + di, j + dj]);
  const out = new Map();
  for (const [i, j] of thick.values()) for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) { const k2 = HKEY(i + di, j + dj); if (!thick.has(k2)) out.set(k2, [i + di, j + dj]); }
  const ok = (i, j) => i >= 0 && j >= 0 && i * g < W && j * g < H;
  for (const [i, j] of out.values()) if (ok(i, j)) p.rect(i * g, j * g, g, g, RED3[0]);
  for (const [i, j] of thick.values()) if (ok(i, j)) p.rect(i * g, j * g, g, g, RED3[1]);
  for (const [i, j] of core.values()) if (ok(i, j)) { if (whiteCore) p.rect(i * g, j * g, g, g, RED3[2]); else p.rect(i * g + 1, j * g + 1, g - 2, g - 2, RED3[2]); }
  return pts;
}
// 번개 둘레의 은은한 붉은 번짐: 줄기 점들 주변을 성긴 점으로(바깥일수록 더 성김) 어둡게 물들인다
function pxGlow(pts, r, rnd, g = 4) {
  const seen = new Set();
  for (const [px, py] of pts) for (let y = py - r; y <= py + r; y += g) for (let x = px - r; x <= px + r; x += g) {
    const d = Math.hypot(x - px, y - py) / r; if (d > 1) continue;
    const key = HKEY(Math.floor(x / g), Math.floor(y / g)); if (seen.has(key)) continue; seen.add(key);
    if (hash2(Math.floor(x / g), Math.floor(y / g), 3) < 0.55 * (1 - d) && x > 0 && y > 0 && x < W && y < H) p.rect(Math.floor(x / g) * g, Math.floor(y / g) * g, g, g, d < 0.5 ? '#5a1a2a' : '#3a121c');
  }
}
function pxSmoke(cx, cy, r, tones, rnd, nPuff = 5) { // 겹친 덩이를 칸으로 칠한 연기(가장자리 어둡게, 위쪽 밝게)
  const puffs = Array.from({ length: nPuff }, (_, i) => ({ x: cx + (i - (nPuff - 1) / 2) * r * 0.55 + (rnd() - 0.5) * r * 0.3, y: cy + (rnd() - 0.5) * r * 0.5, r: r * (0.5 + rnd() * 0.35) }));
  const inside = (x, y) => puffs.some(q => (x - q.x) ** 2 + (y - q.y) ** 2 <= q.r * q.r);
  for (let y = cy - r * 1.4; y < cy + r * 1.4; y += HG) for (let x = cx - r * 2; x < cx + r * 2; x += HG) {
    if (!inside(x, y)) continue;
    const edge = !inside(x - HG, y) || !inside(x + HG, y) || !inside(x, y - HG) || !inside(x, y + HG);
    const lit = !inside(x, y - HG * 1.5) ? 2 : !inside(x - HG * 1.5, y) ? 1 : 0, n = hash2(Math.floor(x / HG), Math.floor(y / HG), 5);
    p.rect(Math.floor(x / HG) * HG, Math.floor(y / HG) * HG, HG, HG, edge ? tones[0] : lit === 2 ? tones[3] : lit === 1 ? tones[2] : n < 0.5 ? tones[1] : tones[2]);
  }
}
function pxStar(cx, cy, R, rnd, squash = 0.7) { // 뾰족한 별 모양 폭발(하얀 핵 → 붉은 가장자리)
  const N = 12, lens = Array.from({ length: N }, () => 0.6 + rnd() * 0.55);
  for (let y = cy - R * squash; y < cy + R * squash; y += HG / 1.5) for (let x = cx - R; x < cx + R; x += HG) {
    const dx = x - cx, dy = (y - cy) / squash, r = Math.hypot(dx, dy); let th = Math.atan2(dy, dx); if (th < 0) th += Math.PI * 2;
    const seg = th / (Math.PI * 2) * N, i0 = Math.floor(seg) % N, f = seg - Math.floor(seg), spike = (lens[i0] * (1 - f) + lens[(i0 + 1) % N] * f) * (0.5 + 0.5 * Math.abs(Math.cos(f * Math.PI))), L = R * spike;
    if (r > L) continue;
    const k = r / L, n = hash2(Math.floor(x / HG), Math.floor(y / HG), 9);
    p.rect(Math.floor(x / HG) * HG, Math.floor(y / HG) * HG, HG, HG, k < 0.2 ? '#ffffff' : k < 0.4 ? '#fff0e8' : k < 0.62 ? (n < 0.7 ? '#ff8a6a' : '#ff6a4a') : k < 0.85 ? '#e8203a' : '#7a0c1c');
  }
}
function pxRing(cx, cy, rx, ry, c, n = 40, sz = HG) { for (let a = 0; a < n; a++) { const t = a / n * Math.PI * 2; p.rect(Math.round((cx + Math.cos(t) * rx) / sz) * sz - sz / 2, Math.round((cy + Math.sin(t) * ry) / sz) * sz - sz / 2, sz, sz, c); } }
const CARD_X = [121, 340, 559, 777]; // 파티 카드 가운데(설계 좌표). 위쪽 y 는 몬스터 칸 아래 바로 밑
const SMOKE_RED = ['#2a0a14', '#5a1a30', '#8a2a44', '#c0485a'];
let heungTargets = []; // 이번 기술에 맞은 파티원 카드 가운데 x(낙뢰가 그 자리를 내려친다)
function heungMonsterFx(move, cx, cy, layer) {
  const rnd = seedRng(++energyTick * 3 + 7), front = layer === 'front', back = layer === 'back';
  if (move === 'thump' && front) { // 용뢰 치기: 용뢰를 온몸에 두르고 파티 쪽으로 몸통 박치기, 앞에 충격 별
    for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2 + 0.3; pxBolt(cx + Math.cos(a) * 66, cy + Math.sin(a) * 58, cx + Math.cos(a) * 112, cy + Math.sin(a) * 100, rnd, 1, 18); }
    for (const dx of [-60, -30, 30, 60]) pxBolt(cx + dx, cy - 70, cx + dx * 0.8, cy - 130, rnd, 1, 8); // 뒤로 흐르는 속도선
    pxStar(cx, cy + 128, 70, rnd); pxRing(cx, cy + 134, 110, 26, '#ffb090');
  } else if (move === 'chain' && front) { // 용뢰 연쇄: 바닥을 타고 좌우로 퍼지는 전류(가는 칸 · 곁가지 · 번짐 · 그을음 · 불똥) + 퍼져 나가는 고리
    for (let x = cx - 360; x < cx + 360; x += 14) if (hash2(x, 7, 2) < 0.7) p.rect(x, 322 + Math.floor(hash2(x, 3, 4) * 14), 8 + Math.floor(hash2(x, 5, 6) * 10), 3, '#1a0a0e'); // 바닥 그을음
    for (const sd of [-1, 1]) {
      const main = [
        [cx + sd * 40, 302, cx + sd * 150, 312 + (rnd() - 0.5) * 8],
        [cx + sd * 150, 312, cx + sd * 262, 304 + (rnd() - 0.5) * 8],
        [cx + sd * 262, 304, cx + sd * 392, 320 + (rnd() - 0.5) * 8],
      ];
      const path = [];
      for (const [ax, ay, bx, by] of main) path.push(...pxBolt(ax, ay, bx, by, rnd, 1, 14, true, 4));
      pxGlow(path, 14, rnd);
      for (const [ax, ay, bx, by] of main) pxBolt(ax, ay, bx, by, rnd, 1, 14, true, 4); // 번짐 위에 다시 또렷하게
      for (const [fx, fy, ex, ey] of [[cx + sd * 100, 308, cx + sd * 150, 268], [cx + sd * 190, 310, cx + sd * 250, 262], [cx + sd * 262, 304, cx + sd * 292, 280], [cx + sd * 330, 312, cx + sd * 372, 284], [cx + sd * 130, 310, cx + sd * 176, 334]]) {
        const sub = pxBolt(fx, fy, ex, ey + (rnd() - 0.5) * 6, rnd, 1, 10, false, 4);
        if (rnd() < 0.7) pxBolt(sub[1][0], sub[1][1], sub[1][0] + sd * (16 + rnd() * 14), sub[1][1] - 14 - rnd() * 12, rnd, 1, 6, false, 3);
      }
      pxStar(cx + sd * 392, 320, 14, rnd, 0.9);
    }
    pxRing(cx, 306, 130, 22, '#fff0e8', 52, 4); pxRing(cx, 306, 230, 34, '#e8203a', 72, 4); pxRing(cx, 306, 340, 46, '#7a0c1c', 84, 4);
    for (let i2 = 0; i2 < 34; i2++) { const x = cx + (rnd() - 0.5) * 760, y = 252 + rnd() * 80; p.rect(Math.round(x / 4) * 4, Math.round(y / 4) * 4, 4, 4, rnd() < 0.5 ? '#ff6a4a' : '#fff0e8'); } // 튀는 불똥
  } else if (move === 'erode' && front) { // 용기 침식: 땅 위로 어두운 붉은 구름이 번져 파티를 덮음(번개 없이 구름만)
    pxSmoke(cx - 170, cy + 96, 70, SMOKE_RED, rnd, 6); pxSmoke(cx + 170, cy + 96, 70, SMOKE_RED, rnd, 6);
    pxSmoke(cx - 330, cy + 104, 56, SMOKE_RED, rnd, 5); pxSmoke(cx + 330, cy + 104, 56, SMOKE_RED, rnd, 5);
    pxSmoke(cx, cy + 128, 92, SMOKE_RED, rnd, 8);
    for (let i = 0; i < 22; i++) { const x = cx + (rnd() - 0.5) * 640, y = cy + 40 + rnd() * 100; p.rect(x, y - rnd() * 30, 6, 6, rnd() < 0.5 ? '#ff6a4a' : '#e8203a'); }
  } else if (move === 'lightning' && front) { // 낙뢰: 먼저 가는 붉은 줄이 내려와 표시하고, 곧이어 굵은 번개가 맞은 사람 위로 내려침(분노엔 두 명)
    const xs = heungTargets.length ? heungTargets : [cx], endY = 470; // 충격파는 맞은 사람 아이콘 아래까지 내려온다
    for (const tx of xs) {
      // 내려오는 표시 줄(번개 줄기는 없음): 은은한 붉은 번짐 기둥 + 하얀 속의 붉은 일직선 빔 + 하늘 끝의 충전 불꽃 + 땅의 조준 고리
      for (let y = 140; y < endY; y += 4) for (let dx = -10; dx <= 10; dx += 4) if (hash2(Math.floor((tx + dx) / 4), Math.floor(y / 4), 8) < 0.5 * (1 - Math.abs(dx) / 12)) p.rect(Math.round((tx + dx) / 4) * 4 - 2, y, 4, 4, '#3a121c');
      p.rect(tx - 5, 150, 10, endY - 150 - 8, '#3a0a10'); p.rect(tx - 3, 150, 6, endY - 150 - 8, '#e8203a'); p.rect(tx - 1, 150, 2, endY - 150 - 8, '#fff0e8'); // 끊김 없는 일직선 빔
      pxStar(tx, 146, 16, rnd, 1); for (const [dx, dy] of [[-22, 6], [24, 12], [-12, 22], [14, 26]]) p.rect(tx + dx - 2, 140 + dy, 4, 4, rnd() < 0.5 ? '#fff0e8' : '#ff6a4a');
      pxRing(tx, endY - 2, 40, 10, '#fff0e8', 28, 4); p.rect(tx - 56, endY - 4, 14, 4, '#e8203a'); p.rect(tx + 42, endY - 4, 14, 4, '#e8203a'); p.rect(tx - 2, endY - 22, 4, 12, '#e8203a');
      // 땅: 충격 별 + 갈라진 틈 + 그을음 + 튀는 파편
      pxStar(tx, endY - 6, 40, rnd, 0.8);
      for (const [dx, dy] of [[-70, 8], [-46, 18], [52, 14], [78, 4], [-20, 24], [26, 22]]) pxBolt(tx + dx * 0.3, endY + 2, tx + dx, endY + dy, rnd, 1, 6, false, 3);
      pxRing(tx, endY + 2, 64, 14, '#fff0e8', 40, 4); pxRing(tx, endY + 2, 96, 22, '#e8203a', 56, 4);
      for (let i2 = 0; i2 < 14; i2++) { const a = rnd() * Math.PI * 2, d = 24 + rnd() * 60; p.rect(Math.round((tx + Math.cos(a) * d) / 4) * 4, Math.round((endY - 6 + Math.sin(a) * d * 0.5) / 4) * 4, 4, 4, i2 % 3 ? '#ff8a4a' : '#fff0e8'); }
    }
  } else if (move === 'release' && front) { // 용기 해방: 몸을 가둔 껍질이 깨지듯 사방으로 에너지 파편과 별 모양 폭발
    pxStar(cx, cy, 150, rnd, 0.62);
    for (let i = 0; i < 16; i++) { const a = rnd() * Math.PI * 2, d = 100 + rnd() * 120; p.rect(cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.7, 8, 8, i % 2 ? '#e8203a' : '#2a0a14'); }
    pxRing(cx, cy, 200, 100, '#fff0e8', 60);
  }
}
// 맞은 카드 아이콘 위 이펙트
function heungHitFx(move, cx, cy) {
  const rnd = seedRng(Math.floor(cx * 3 + cy) + ++energyTick);
  if (move === 'thump') { // 맞은 카드: 하얀 핵의 도트 별 + 둘레로 튀는 짧은 용뢰 + 납작한 충격 고리
    pxStar(cx, cy, 24, rnd, 0.9);
    for (let i = 0; i < 5; i++) { const a = i / 5 * Math.PI * 2 + 0.5; pxBolt(cx + Math.cos(a) * 22, cy + Math.sin(a) * 20, cx + Math.cos(a) * 46, cy + Math.sin(a) * 40, rnd, 1, 8); }
    pxRing(cx, cy + 16, 38, 11, '#ffb090', 20, 4);
  } else if (move === 'chain') {
    redBolt(cx - 30, cy - 26, cx + 28, cy + 24, rnd, 4); redBolt(cx + 30, cy - 24, cx - 28, cy + 26, rnd, 4);
    for (const [dx, dy] of [[-24, 20], [26, -22], [0, -32], [2, 32]]) dot(cx + dx, cy + dy, 4, '#fff0e8');
  } else if (move === 'erode') {
    haze(cx, cy, 30, '#5a1a3a', 0.4); haze(cx - 6, cy + 4, 20, '#8a1a3a', 0.35);
    for (let i = 0; i < 12; i++) { const a = i * 0.55, r = 34 - i * 1.5; dot(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.8, 4, i % 2 ? '#e8203a' : '#8a2a4a'); }
  } else if (move === 'lightning') {
    // 낙뢰는 맞은 카드 위에 따로 이펙트를 그리지 않는다(몬스터 쪽 연출만)
  } else if (move === 'comet') { // 맞은 카드: 도트 충격파 — 칸으로 굳힌 두 겹 고리와 하얀 핵의 작은 별
    // 불덩이가 떨어져 터짐: 주황·붉은 도트 폭발 + 사방으로 날아가는 돌 파편
    pxStar(cx, cy + 4, 34, rnd, 0.85);
    for (let i = 0; i < 9; i++) { const a2 = i / 9 * Math.PI * 2 + 0.3, d = 34 + rnd() * 16; p.rect(cx + Math.cos(a2) * d - 4, cy + Math.sin(a2) * d * 0.8 - 4, 8, 8, i % 3 ? '#3a1a14' : '#ff8a4a'); }
  } else if (false) {
    // 간단한 충격파: 아이콘 둘레로 퍼지는 붉은·밝은 고리 두 겹과 옅은 번쩍임
    haze(cx, cy, 24, '#ffe0d8', 0.2);
    ringDots(cx, cy, 24, 21, 24, 4, '#fff0e8'); ringDots(cx, cy, 36, 31, 32, 4, '#ff6a4a');
  }
}
// 필살 혜성 낙하 준비 중: 몬스터는 하늘로 올라가 보이지 않고 칸 한가운데에 붉은 점이 맥동하며 떠 있다(꼬리 없음)
function cometDot(cx, cy) {
  const pulse = 0.5 + 0.5 * Math.sin(energyTick * 0.9);
  haze(cx, cy, 70 + 8 * pulse, '#ff2a1a', 0.16); haze(cx, cy, 46, '#ff4a3a', 0.2);
  ringDots(cx, cy, 52 + 5 * pulse, 52 + 5 * pulse, 40, 3, '#ff6a4a');
  p.rect(cx - 11, cy - 11, 22, 22, '#ff3a3a'); p.rect(cx - 7, cy - 7, 14, 14, '#ff8a7a'); p.rect(cx - 4, cy - 4, 8, 8, '#ffffff');
  for (const [dx, dy] of [[-30, -16], [26, 20], [-18, 30], [34, -26]]) dot(cx + dx, cy + dy, 3, '#ffd0c8');
}
// 감전(감속) 배지: 어두운 칸 + 붉은 번개 + 남은 턴
function shockBadge(cx, cy, turns) {
  p.rect(cx - 13, cy - 13, 26, 26, '#1a0608'); p.strokeRoundRect(cx - 13, cy - 13, 26, 26, 2, 2, '#e8203a');
  const pts = [[cx + 4, cy - 11], [cx - 4, cy - 1], [cx + 2, cy - 1], [cx - 5, cy + 11]];
  for (let i = 0; i < 3; i++) { p.line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], 6, '#e8203a'); p.line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], 2.5, '#fff0e8'); }
  btext(`${turns}턴`, cx, cy + 26, 15, '#ffb0b8');
}
// 용기 침식(받는 피해 증가) 배지: 붉은 고리 + 갈라진 틈 + 아래 화살표 + 남은 턴
function dragonBadge(cx, cy, turns) {
  p.circle(cx, cy, 13, '#8a1a3a'); p.circle(cx, cy, 10, '#1a0608');
  p.line(cx - 6, cy - 8, cx + 1, cy - 1, 3, '#e8203a'); p.line(cx + 1, cy - 1, cx - 2, cy + 3, 3, '#e8203a');
  p.poly([cx + 3, cy, cx + 9, cy, cx + 6, cy + 7], '#ff6a4a');
  btext(`${turns}턴`, cx, cy + 26, 15, '#ffb4bc');
}
// 맞은 파티원 카드 아이콘 위 타격 표시: 박치기는 할퀸 자국, 흩뿌리기는 점액 얼룩, 짓누르기는 충격 별.
function hitFx(move, cx, cy, color, spore = color, accent = spore) {
  if (move === 'ambush') move = 'comet'; // 습격도 필살 흉성 낙하와 같은 맞은 카드 이펙트(불덩이 폭발)
  if (HEUNG_FX.includes(move)) { heungHitFx(move, cx, cy); return; }
  if (ALAT_FX.includes(move)) return;
  if (move === 'fart') {
    return; // 구린 방귀 피격·악취는 카드에서 stenchBehind·stenchFront로(아이콘 뒤·앞에 나눠 그림)
  }
  if (move === 'peel') {
    // 바나나 껍질에 맞음: 아이콘 옆에 껍질 두 개 + 미끄러진 자국
    drawPixels(PEEL, cx - 30, cy + 20, 5);
    drawPixels(PEEL, cx + 30, cy - 18, 5);
    p.line(cx - 40, cy + 40, cx - 8, cy + 40, 3, '#f5d040');
    return;
  }
  if (move === 'spore') {
    // 포자 흩뿌리기: 점액 얼룩(동그라미)과 구분되게 — 대폭발과 같은 동그란 포자 알갱이 두 개 + 흩날리는 네모 가루
    puff(cx - 22, cy - 16, 4, spore, '#f1cdfb');
    puff(cx + 22, cy + 14, 4, color, '#f1cdfb');
    for (const [dx, dy, sz, c] of [[6, -28, 5, accent], [-30, 12, 4, spore], [28, -12, 4, accent], [-6, 28, 5, spore], [-14, 0, 3, accent], [12, 2, 3, spore]]) dot(cx + dx, cy + dy, sz, c);
  } else if (move === 'hypno') {
    // 몬스터 옆 최면 물결을 줄인 것 — 아이콘 양옆으로 퍼지는 도트 호 세 겹 + 반짝임
    hypnoWaves(cx, cy, 0.27, color, 2);
    sparkle(cx - 26, cy - 30, 3, '#e8fffb');
    sparkle(cx + 26, cy + 30, 3, '#e8fffb');
  } else if (move === 'burst') {
    // 아이콘 네 귀퉁이로 터진 포자 구름(가운데 아이콘은 보이게)
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([i, j], k) => puff(cx + i * 30, cy + j * 26, 5, k % 2 ? accent : spore, '#f1cdfb'));
  } else if (move === 'attack') {
    // 일반 공격: 도트로 그린 할퀸 자국 세 줄(어두운 테두리 → 빨강 → 가운데 흰 심), 다른 연출처럼 네모 도트
    for (const d of [-14, 0, 14]) {
      const pts = Array.from({ length: 13 }, (_, t) => [cx - 22 + d + t * 3.4, cy - 26 + t * 4.4]);
      for (const [x, y] of pts) dot(x, y, 9, '#3a0a08');
      for (const [x, y] of pts) dot(x, y, 5, '#ff4a3a');
      for (const [x, y] of pts.slice(4, 9)) dot(x, y, 2, '#fff1e8');
    }
  } else if (move === 'sweep') {
    // 점액 얼룩: 아이콘 색과 섞여 안 보이지 않게 어두운 테두리를 먼저 깔고, 점액색 방울 + 흰 반사광
    const blobs = [[-18, -12, 11], [20, 8, 9], [2, 22, 7]];
    for (const [dx, dy, r] of blobs) p.circle(cx + dx, cy + dy, r + 3, '#0e2a14');
    for (const [dx, dy, r] of blobs) p.circle(cx + dx, cy + dy, r, color);
    for (const [dx, dy, r] of blobs) p.circle(cx + dx - r * 0.35, cy + dy - r * 0.35, Math.max(1.8, r * 0.28), '#f4fff0');
  } else if (move === 'curse') {
    // 영혼 사냥: 대상 카드 표시는 renderBattle의 curseLink가 그린다(세 줄 할퀴기)
  } else if (move === 'wail') {
    // 울부짖기: 아이콘을 감싸는 들쭉날쭉한 음파 두 겹(양옆)
    for (const [r, c] of [[30, '#f4f0ff'], [42, '#9b7bff']]) {
      jaggedArc(cx, cy, r, -0.9, 0.9, 1, 3, c, 5);
      jaggedArc(cx, cy, r, Math.PI - 0.9, Math.PI + 0.9, 1, 3, c, 5);
    }
  } else if (move === 'storm') {
    // 원혼 폭풍: 아이콘 둘레를 도는 작은 유령 셋 + 나선 도트
    for (let i = 0; i < 12; i++) { const a = i * 0.55, r = 42 - i * 1.4; dot(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.8, 4, i % 2 ? '#8a6ae0' : '#d9ceff'); }
    for (const [dx, dy] of [[-30, -22], [30, -14], [-4, 32]]) drawPixels(MINI_GHOST, cx + dx, cy + dy, 3.4);
  } else if (move === 'dust') {
    // 분진: 아이콘에 들러붙는 뿌연 먼지 + 화약 알갱이 + 불티
    haze(cx - 10, cy + 8, 26, '#7a6a58', 0.45);
    haze(cx + 14, cy - 10, 20, '#9c8a72', 0.4);
    for (const [dx, dy, c] of [[-28, -14, '#5e4f40'], [22, 20, '#5e4f40'], [-6, -30, '#9c8a72'], [30, -26, '#9c8a72'], [-30, 22, '#ff9a3c'], [8, 28, '#ffe066'], [26, 4, '#ff9a3c']]) p.rect(cx + dx, cy + dy, 6, 6, c);
  } else if (move === 'boom') {
    // 대폭발: 아이콘 뒤 들쭉날쭉한 폭발(검은 테두리 → 빨강 → 주황 → 노랑) + 날아가는 파편
    const burst = (r1, r2, c) => { const pts = []; for (let k = 0; k < 20; k++) { const a = (k / 20) * Math.PI * 2, r = k % 2 ? r2 : r1; pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r); } p.poly(pts, c); };
    burst(46, 26, '#1a0d08'); burst(42, 23, '#e8401c'); burst(32, 18, '#ff9a3c'); burst(20, 12, '#ffe066');
    for (const [dx, dy] of [[-40, -30], [40, -26], [-36, 34], [42, 30]]) p.rect(cx + dx, cy + dy, 7, 7, '#1a0d08');
  } else if (move === 'frost') {
    // 서리 숨결: 아이콘을 휩쓸고 지나가는 차가운 입김 바람줄기 세 줄(물결, 끝으로 갈수록 가늘게) + 서리 알갱이
    // — 눈송이·얼음 덩어리는 쓰지 않는다(냉기 배지·빙결 덮개와 헷갈리지 않게, 사용자 지적)
    for (const [dy, amp] of [[-20, 5], [0, 7], [20, 5]]) {
      const pts = Array.from({ length: 13 }, (_, i) => [cx - 44 + i * 7.3, cy + dy + Math.sin(i * 0.9) * amp]);
      for (const [w, c] of [[7, '#2a5f8a'], [4, '#d8f4ff']]) for (let i = 1; i < pts.length; i++) p.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], Math.max(1.5, w * (1 - i / 16)), c);
    }
    for (const [dx, dy] of [[-36, -32], [30, -30], [40, 12], [-40, 30], [8, 34], [-6, -36]]) dot(cx + dx, cy + dy, 3, '#ffffff');
  } else if (move === 'icefall') {
    // 빙하 낙하: 아이콘 아래에서 솟구친 날카로운 얼음 결정 무리 + 튀는 조각 + 눈송이
    for (const [dx, len, w, ang] of [[-30, 34, 8, -2.05], [-12, 44, 9, -1.75], [12, 40, 9, -1.4], [30, 32, 7, -1.1]]) iceShard(cx + dx, cy + 22, len, w, ang, color); // 아이콘 아래쪽만 덮게
    for (const [dx, dy] of [[-40, -20], [40, -26], [-34, 34], [38, 30]]) iceShard(cx + dx, cy + dy, 14, 4, 0.8, color);
    flake(cx + 30, cy - 34, 7);
  } else if (move === 'smash') {
    p.poly([cx, cy - 34, cx + 9, cy - 9, cx + 34, cy, cx + 9, cy + 9, cx, cy + 34, cx - 9, cy + 9, cx - 34, cy, cx - 9, cy - 9], '#ffd166'); // 충격 별(원래대로)
  }
}

function frame() {
  p.clear(C.bg);
  p.strokeRoundRect(5, 5, W - 10, H - 10, 16, 2, C.frame);
}
function monsterBox(y, h) {
  p.roundRect(20, y, W - 40, h, 14, C.box);
  if (themeKey === ':alat') alatCanyon(y, h, h >= 240); // 로비 상자(높이 240)는 폭포 없이 — 흰 세로 막대가 이상한 선으로 보였다
  p.strokeRoundRect(20, y, W - 40, h, 14, 1.5, C.frame);
}
// 알바트리온 전용 배경: 원작 알바트리온 전장 '깊숙한 골짜기' — 켜켜이 쌓인 주황빛 암벽이 좁은 틈으로 갈라져 하늘의 빛줄기가 쏟아지고,
// 왼쪽 벽에는 폭포와 물안개, 바닥은 모래빛 땅. 칸 안쪽에만 그린다(몬스터는 이 위에 그린다).
function alatCanyon(y, h, fullBleed = false, pal = null) { // pal: { ROCK, SKY, FLOOR } 로 속성 색 골짜기를 칠한다(에스카톤) // fullBleed: 화면 전체 배경이면 폭포를 뺀다(세로로 너무 길어 어색)
  const x0 = 24, x1 = W - 24, top = y + 4, bot = y + h - 4, gy = bot - 44, slitX = 478;
  const ROCK = pal?.ROCK ?? ['#120a08', '#26150f', '#3f2417', '#5e3a22', '#8a5832', '#b97c46', '#dfa468'];
  const k = 7;
  const edgeL = (yy) => slitX - 112 + (yy - top) * 0.2 + (fbm(yy / 18, 1.3, k) - 0.5) * 40; // 틈의 왼쪽 가장자리(들쭉날쭉)
  const edgeR = (yy) => slitX + 120 - (yy - top) * 0.22 + (fbm(yy / 16, 4.1, k + 2) - 0.5) * 40;
  const buf = pixBuf();
  buf.paint(x0, top, x1, bot, (x, yy, i, j) => {
    if (yy > gy + 2) { // 모래빛 바닥: 틈에서 쏟아진 빛 아래가 밝다
      const lit = Math.max(0, 1 - Math.abs(x - slitX) / 330), n = fbm(x / 26, yy / 8, k + 4);
      return ramp(pal?.FLOOR ?? ['#3a2418', '#6a4628', '#a26e3e', '#d49a58', '#f0c47e'], 0.2 + lit * 0.62 + (n - 0.5) * 0.3 - (yy - gy) / 260, i, j);
    }
    const l = edgeL(yy), r = edgeR(yy);
    if (x > l && x < r) { // 하늘: 틈 가운데가 가장 하얗다
      const t = (x - l) / (r - l), c = 1 - Math.abs(t - 0.5) * 2;
      return ramp(pal?.SKY ?? ['#a87a50', '#cfa670', '#e4c690', '#f0dcaa'], 0.35 + c * 0.7 - (yy - top) / (gy - top) * 0.25, i, j);
    }
    const dist = x < l ? l - x : x - r, side = x < l ? 0 : 1; // 암벽: 층리(비스듬한 줄무늬) + 틈에 가까울수록 빛을 받아 밝다
    const strata = Math.sin((yy + dist * (side ? -0.45 : 0.45)) / 5.5 + fbm(x / 40, yy / 30, k + 6) * 6) * 0.5 + 0.5;
    const light = Math.max(0, 1 - dist / 170) * (side ? 0.95 : 0.7), shade = (x < x0 + 120 && !side) || (x > x1 - 90 && side) ? 0.5 : 1; // 맨 왼쪽은 그늘
    const crag = fbm(x / 22, yy / 16, k + 9);
    return ramp(ROCK, (0.08 + light * 0.7 + strata * 0.26 + (crag - 0.5) * 0.4) * shade, i, j);
  });
  buf.flush(null);
  // (왼쪽 폭포와 물안개는 흰 세로 막대가 이상한 선으로 보여서 모든 화면에서 뺐다)
  // 틈에서 내리는 빛 기둥과 바닥의 빛 웅덩이
  if (pal?.clean) { haze(slitX + 4, gy - 60, 130, pal.SKY[3], 0.1); haze(slitX + 4, gy + 6, 160, pal.SKY[2], 0.1); } // 깨끗한 모드: 점 격자 대신 부드러운 빛번짐
  else { dotGlow(slitX + 4, gy - 40, 150, 120, pal?.SKY[3] ?? '#e8c890', 0.4, top); dotGlow(slitX + 4, gy + 6, 210, 34, pal?.SKY[2] ?? '#dcb878', 0.45, top); }
  // (바닥 바위 잔해는 어색해서 뺐다)
  const sd = seeded(31);
  if (!pal?.clean) for (let i = 0; i < 40; i++) p.rect(x0 + sd() * (x1 - x0), top + sd() * (bot - top), 2, 2, i % 3 ? '#f4d8a0' : '#ffffff'); // 빛 속에 떠다니는 먼지
}

// 카드 4장(역할 순서 고정). drawCard(x, y, w, h, roleKey, member)로 안쪽을 채운다.
const CARD_Y = 362, CARD_H = 260, CARD_W = 203, CARD_GAP = 16;
const NAME_SIZE = 28;
// 카드 배경과 빈자리 테두리는 배경 캐시(background)에 이미 있다. 참가자 카드만 테두리를 덧그린다.
// border(m) → { color, width } | null 로 장면마다 테두리를 정할 수 있다(기본: 금색 2px).
let activeRoles = ROLE_ORDER; // 지금 그리는 몬스터의 직업 순서(render 가 정한다)
function cards(members, drawCard, border = () => ({ color: C.gold, width: 2 })) {
  activeRoles.forEach((roleKey, i) => {
    const x = 20 + i * (CARD_W + CARD_GAP);
    const m = members.find(q => q.role === roleKey) || null;
    const b = m && border(m);
    if (b) p.strokeRoundRect(x, CARD_Y, CARD_W, CARD_H, 14, b.width, b.color);
    drawCard(x, CARD_Y, CARD_W, CARD_H, roleKey, m);
  });
}

// 장면마다 변하지 않는 배경(바깥 테두리·몬스터 상자·카드 4장 바탕)을 한 번 그려 저장해 두고,
// 다음부터는 복사만 한다. 큰 도형 칠하기가 그림 시간의 대부분이었다(장면당 약 1.7MB × 3장면).
const backgrounds = new Map();
function background(key, boxY, boxH) {
  key += themeKey;
  const cached = backgrounds.get(key);
  if (cached) { cached.copy(painter.buf); return; }
  frame();
  monsterBox(boxY, boxH);
  ROLE_ORDER.forEach((_, i) => {
    const x = 20 + i * (CARD_W + CARD_GAP);
    p.roundRect(x, CARD_Y, CARD_W, CARD_H, 14, C.card);
    p.strokeRoundRect(x, CARD_Y, CARD_W, CARD_H, 14, 2, C.cardEmpty);
  });
  backgrounds.set(key, Buffer.from(painter.buf));
}

// render 공통: 엔진 준비 → 그리기 → PNG. 실패하면 null(레이드.js가 글자 화면으로 대신).
// 전부 동기라 중간에 다른 처리가 끼지 않고, 호출부(레이드.js의 화면 대기열)가 한 번에 하나씩만 부른다.
// (async인 건 호출부와의 약속일 뿐 — 그리기 시간 측정에 다른 작업이 섞이지 않게 await 없이 끝낸다)
// 오염 테마 색: 화면 틀(배경·테두리·상자·제목·리본)만 붉게. 직업 아이콘(ROLE_SPRITES)·HP 바(hpColor)는 자기 색이라 그대로.
const CORRUPT_C = {
  bg: '#120507', frame: '#8a1c24', gold: '#ff3a4a', box: '#080203', card: '#1e0a0d', cardEmpty: '#3a1418',
  orange: '#ff6a5a', sub: '#f2dada', dim: '#7a5a5e', muted: '#b08a8a', hpBack: '#2e1418',
};
// ── 알바트리온 전용 테마(블랙월의 붉은 오염 테마를 참고): 폭풍을 두른 보랏빛 어둠의 화면 틀 + 지금 속성 색으로 번지는 가장자리 빛과 모서리 균열 ──
const ALAT_C = {
  bg: '#1c120b', frame: '#b07a40', gold: '#f6e0b8', box: '#0d0805', card: '#2c1f14', cardEmpty: '#4c3724',
  orange: '#e8a050', sub: '#f4e8d8', dim: '#8a7260', muted: '#c4ac94', hpBack: '#33241a',
};
let alatThemeEl = null, alatThemeRage = false, alatCalm = false; // alatCalm: 에스카톤 장면 — 후처리 불씨 점을 그리지 않는다
const ALAT_EDGE = { none: [190, 186, 214], fire: [255, 124, 36], water: [70, 190, 255], thunder: [255, 236, 70], ice: [150, 220, 255], dragon: [232, 64, 122] };
// 테두리 전체에 은은하게 흐르는 속성 이펙트(모서리 이펙트와 이어짐): 폭 30px 안쪽으로 옅게, 바깥일수록 짙게. 불=아른거리는 열기 줄 · 물=흐르는 물결 줄 · 번개=깜빡이는 전기 선 · 얼음=서리 결 · 용=번지는 어둠과 붉은 맥
function alatEdges(el, heavy, scene) {
  el = el || 'none'; // 모집·결과 화면엔 지금 속성이 없다 — 무속성(은빛)
  const RM = ALAT_RAMP[el] ?? ALAT_RAMP.dragon, B = heavy ? 20 : 14, k = el.length * 5 + 3, buf = pixBuf();
  const dens = (d) => Math.pow(1 - d / B, 1.7); // 테두리에 가까울수록 짙게
  for (const [x0, y0, x1, y1, horiz] of [[0, 0, W, B, true], [0, H - B, W, H, true], [0, B, B, H - B, false], [W - B, B, W, H - B, false]]) {
    buf.paint(x0, y0, x1, y1, (x, y, i, j) => {
      const d = Math.min(x, W - x, y, H - y); if (d >= B) return null;
      if (scene === '전투' && y < 124 && x > 46 && x < W - 46) return null; // 보스 바·정보가 있는 헤더 구역은 이펙트를 그리지 않는다(가시성)
      const t = horiz ? x : y, dn = dens(d) * 0.2; // 최대 28%만 채움
      if (el === 'fire') { const n = fbm(t / 22, d / 9 - (horiz ? 0 : 0), k); return bay(i, j) < dn * (0.5 + n) ? ramp(RM, 0.25 + (1 - d / B) * 0.55 + n * 0.2, i, j) : null; }
      if (el === 'water') { const w = Math.sin(t / 14 + d / 6 + fbm(t / 40, d / 20, k) * 3); return bay(i, j) < dn * (0.5 + 0.5 * Math.max(0, w)) ? (w > 0.85 ? '#ffffff' : ramp(RM, 0.3 + (1 - d / B) * 0.4 + w * 0.12, i, j)) : null; }
      if (el === 'thunder') { const ridge = 1 - Math.abs(fbm(t / 26, d / 8, k) - 0.5) * 6; return ridge > 0.82 && d < B * 0.8 ? (ridge > 0.9 ? '#ffffff' : RM[4]) : (bay(i, j) < dn * 0.5 ? RM[2] : null); }
      if (el === 'ice') { const ridge = 1 - Math.abs(fbm(t / 20, d / 10, k) - 0.5) * 5.5; return ridge > 0.84 ? '#ffffff' : (bay(i, j) < dn * 0.9 ? ramp(RM, 0.45 + (1 - d / B) * 0.4, i, j) : null); }
      const ridge = 1 - Math.abs(fbm(t / 24, d / 9, k) - 0.5) * 6; return ridge > 0.86 && d < B * 0.85 ? RM[4] : (bay(i, j) < dn * (0.6 + fbm(t / 30, d / 12, k + 3)) ? ramp(RM, 0.05 + (1 - d / B) * 0.25, i, j) : null);
    });
  }
  buf.flush(null);
}
// 네 모서리 이펙트(디자인 좌표): 지금 속성마다 모서리에서 번지는 고밀도 도트 이펙트.
// 불=타오르는 불길과 용암 균열 · 물=겹겹의 물결 마루와 포말·물보라 · 번개=가지 친 번개와 전기 핏줄 · 얼음=가지 뻗는 서리 결정과 얼음 기둥 · 용=검붉은 연기와 균열 핏줄
function alatCorners(el, heavy, rnd, scene) {
  el = el || 'none';
  const S = heavy ? 1.3 : 1, K = scene === '결과' ? 0.62 : 1, Z = Math.round(46 * S * K), RM = ALAT_RAMP[el] ?? ALAT_RAMP.dragon, k0 = Math.floor(rnd() * 40);
  for (const [cx, cy, dx, dy] of [[0, 0, 1, 1], [W, 0, -1, 1], [0, H, 1, -1], [W, H, -1, -1]]) {
    const buf = pixBuf(), kk = k0 + (dx > 0 ? 0 : 7) + (dy > 0 ? 0 : 13);
    const x0 = dx > 0 ? cx : cx - Z, y0 = dy > 0 ? cy : cy - Z;
    const loc = (x, y) => [dx > 0 ? x - cx : cx - x, dy > 0 ? y - cy : cy - y];
    const map = (lx, ly) => [cx + dx * lx, cy + dy * ly];
    buf.paint(x0, y0, x0 + Z, y0 + Z, (x, y, i, j) => {
      const [lx, ly] = loc(x, y), r = Math.hypot(lx, ly), f = 1 - r / Z; if (f <= 0) return null;
      if (scene === '전투' && y < 124 && x > 46 && x < W - 46) return null; // 헤더 정보 구역 제외
      if (bay(i, j) > Math.min(1, f * 1.7) * 0.72) return null; // 바깥으로 갈수록 성기게 사라져 화면에 스며든다
      const edge = Math.max(0, 1 - Math.min(lx, ly) / 26); // 두 테두리에 붙은 정도
      if (el === 'fire') {
        const n = fbm(lx / 15 + ly / 46, ly / 15 - lx / 46 - kk * 0.1, kk), n2 = fbm(lx / 6, ly / 6, kk + 3);
        const I = f * 1.15 + edge * 0.5 * f + (n - 0.5) * 0.95 + (n2 - 0.5) * 0.25;
        if (I > 0.2) return ramp(RM, Math.min(1, (I - 0.1) * 1.25), i, j);
        return I > 0.02 && bay(i, j) < (I - 0.02) * 5 ? '#1a0a07' : null; // 그을음
      }
      if (el === 'water') {
        const wob = fbm(lx / 28, ly / 28, kk) * 5, wave = Math.sin(r / 8 - wob), cr = wave > 0.86;
        if (f + (fbm(lx / 10, ly / 10, kk + 2) - 0.5) * 0.5 < 0.14) return null;
        if (cr) return '#ffffff';
        if (wave > 0.62) return RM[5];
        return ramp(RM, 0.12 + f * 0.5 + wave * 0.12 + (fbm(lx / 7, ly / 7, kk + 5) - 0.5) * 0.25, i, j);
      }
      if (el === 'thunder') {
        const ridge = 1 - Math.abs(fbm(lx / 13, ly / 13, kk) - 0.5) * 6.2, haze = f * f * 0.5 + edge * 0.18 * f;
        if (ridge > 0.9 && f > 0.1) return '#ffffff';
        if (ridge > 0.8 && f > 0.06) return RM[4];
        if (ridge > 0.7 && f > 0.1 && bay(i, j) < 0.6) return RM[2];
        return bay(i, j) < haze * 0.9 ? (hash2(i, j, kk) < 0.3 ? RM[3] : RM[1]) : null;
      }
      if (el === 'ice') {
        const ridge = 1 - Math.abs(fbm(lx / 17, ly / 17, kk) - 0.5) * 5.6, I = f * 1.1 + edge * 0.4 * f + (fbm(lx / 9, ly / 9, kk + 4) - 0.5) * 0.6;
        if (ridge > 0.88 && f > 0.08) return '#ffffff';
        if (I > 0.42) return ramp(RM, 0.4 + I * 0.5 + (ridge > 0.74 ? 0.18 : 0), i, j);
        return I > 0.2 && bay(i, j) < (I - 0.2) * 4 ? RM[3] : null;
      }
      // 용: 검붉은 연기 + 균열 핏줄
      const ridge = 1 - Math.abs(fbm(lx / 12, ly / 12, kk) - 0.5) * 6.5, smoke = f * 1.1 + edge * 0.45 * f + (fbm(lx / 20, ly / 20, kk + 6) - 0.5) * 0.8;
      if (ridge > 0.9 && f > 0.06) return '#ffffff';
      if (ridge > 0.8 && f > 0.04) return RM[4];
      if (ridge > 0.72 && f > 0.04) return RM[3];
      if (smoke > 0.3) return ramp(RM, 0.04 + smoke * 0.3, i, j);
      return smoke > 0.14 && bay(i, j) < (smoke - 0.14) * 5 ? RM[0] : null;
    });
    buf.flush(null);
    // 속성별 덧그림: 모서리 장식
    if (el === 'fire') for (let q = 0; q < 9 * S; q++) { const [px, py] = map(4 + rnd() * Z * 0.9, 4 + rnd() * Z * 0.9); const sz = rnd() < 0.3 ? 4 : 2; p.rect(snap(px), snap(py), sz, sz, ['#fffbe8', '#ffe28a', '#ffb347', '#ff7a2a'][Math.floor(rnd() * 4)]); } // 날리는 불씨
    if (el === 'water') for (let q = 0; q < 8 * S; q++) { const a = rnd() * 1.5, rr = 30 + rnd() * Z * 0.8, [px, py] = map(Math.cos(a) * rr, Math.sin(a) * rr); p.circle(px, py, 1.5 + rnd() * 3, q % 2 ? '#dff4ff' : '#5ab4ff'); p.rect(Math.round(px) - 1, Math.round(py) - 1, 2, 2, '#ffffff'); } // 튀는 물방울
    if (el === 'thunder' && !(scene === '전투' && cy === 0)) {
      const paths = [];
      for (let q = 0; q < 1; q++) {
        const a = Math.atan2(dy, dx) + (rnd() - 0.5) * 1.2, len = (80 + rnd() * 70) * S * K, pts = [[cx, cy]];
        let x = cx, y = cy, ang = a;
        for (let t = 0; t < len; t += 9) { ang += (rnd() - 0.5) * 1.0; x += Math.cos(ang) * 9; y += Math.sin(ang) * 9; pts.push([x, y]); if (t > 20 && rnd() < 0.3) paths.push([zigzag(x, y, x + Math.cos(ang + 1) * 30, y + Math.sin(ang + 1) * 30, rnd, 3, 8), 0]); }
        paths.push([pts, q === 0 ? 1 : 0]);
      }
      pxStrike(paths, RM, '#241a00', 3);
    }
    if (el === 'ice' && !(scene === '전투' && cy === 0)) for (let q = 0; q < 2; q++) { const along = 14 + rnd() * Z * 0.8, [px, py] = rnd() < 0.5 ? map(along, 4) : map(4, along); pxCrystal(buf, px, py + 6, (22 + rnd() * 52) * S * K, 9 + rnd() * 8, (rnd() - 0.5) * 0.9 + (dx < 0 ? 0.2 : -0.2), RM); buf.flush('#0a2440'); } // 테두리에서 자란 얼음 기둥
    if (el === 'ice') for (let q = 0; q < 6; q++) { const [px, py] = map(6 + rnd() * Z * 0.85, 6 + rnd() * Z * 0.85); pxFlake(px, py, rnd() < 0.4); }
    if (el === 'dragon') for (let q = 0; q < 6 * S; q++) { const [px, py] = map(4 + rnd() * Z * 0.8, 4 + rnd() * Z * 0.8); p.rect(snap(px), snap(py), 4, 4, rnd() < 0.5 ? '#ffa0d0' : '#e8407a'); } // 떠다니는 불씨
  }
}
// 후처리: ① 가장자리를 속성 색으로 밝힘(분노면 더 넓고 강하게) ② 네 모서리에서 갈라지는 균열(속성 색 + 하얀 심) ③ 흩날리는 속성 색 불씨 ④ 가는 가로 주사선(폭풍 느낌)
function alatPost(scene, el, heavy) {
  const col = ALAT_EDGE[el] ?? [255, 150, 70], rnd = seeded(scene.length * 41 + 5 + (el ? el.length * 7 : 0));
  const w = p.w, h = p.h, buf = p.buf;
  const inIcon = (x, y) => scene !== '모집' && scene !== '전투' ? false : ICON_KEEP.some(([kx, ky, kw, kh]) => x >= kx && x < kx + kw && y >= ky && y < ky + kh);
  const add = (x, y, c, k = 1) => { if (x < 0 || y < 0 || x >= w || y >= h || inIcon(x, y)) return; const j = (y * w + x) * 3; buf[j] = Math.min(255, buf[j] + Math.round(c[0] * k)); buf[j + 1] = Math.min(255, buf[j + 1] + Math.round(c[1] * k)); buf[j + 2] = Math.min(255, buf[j + 2] + Math.round(c[2] * k)); };
  const set = (x, y, c) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= w || y >= h || inIcon(x, y)) return; const j = (y * w + x) * 3; buf[j] = c[0]; buf[j + 1] = c[1]; buf[j + 2] = c[2]; };
  // 가장자리에 속성색이 은은하게 스며드는 음영만(모서리 효과·불씨 점·주사선은 지저분해 보여 뺐다). 부드럽게 퍼지도록 폭을 넓히고 세기는 낮춘다.
  const band = heavy ? 0.14 : 0.11, gain = heavy ? 0.26 : 0.17;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const e = Math.min(Math.min(x, w - 1 - x) / w, Math.min(y, h - 1 - y) / h);
    if (e >= band) { if (x > w * band && x < w * (1 - band)) x = Math.floor(w * (1 - band)); continue; }
    const t = (band - e) / band;
    add(x, y, col, t * t * (3 - 2 * t) * gain); // 부드러운 곡선(smoothstep)
  }
}
let themeKey = ''; // 배경 캐시 키 뒤에 붙는다(테마마다 배경을 따로 저장)
// 화면 오염 후처리(6번째 시안 그대로, 실제 픽셀 675×480 단위): ① 가장자리 붉은 빛 ② 네 모서리 오염(옆 칸이 붉게 끌려와 어긋난 블록 ·
// 붉은 블록 · 빠진 칸 · 회로 막대, 테두리를 따라 흐르는 세로 줄기) ③ 붉은 잡음 점 ④ 약한 가로 띠 밀림(글자 줄은 피함).
// 직업 아이콘 자리(카드 아이콘 칸)는 건드리지 않는다. 매번 같은 모양(seed).
const ICON_KEEP = [0, 1, 2, 3].map(i => [Math.round((20 + i * (CARD_W + CARD_GAP) + CARD_W / 2 - 34) * RENDER_SCALE), Math.round((CARD_Y + 46) * RENDER_SCALE), Math.round(68 * RENDER_SCALE), Math.round(80 * RENDER_SCALE)]);
// 띠를 밀면 안 되는 줄(실제 픽셀) — 시안과 같게
// 모집은 카드 아이콘 줄(약 280~330)도 피한다(아이콘은 건드리지 않음 — 사용자 요청)
const BAND_SAFE = { 모집: [[15, 60], [145, 240], [270, 480]], 전투: [[10, 80], [150, 240], [260, 480]], 결과: [[10, 140], [150, 480]] };
function corruptPost(scene, seed, heavy = false) { // heavy: 분노 — 모서리 오염이 더 크게 번지고, 가로 띠가 많이·크게 밀리고, 색 분리·블록 어긋남·주사선이 더해진다
  const rnd = seeded(seed);
  const w = p.w, h = p.h, buf = p.buf;
  const inIcon = (x, y, bw, bh) => scene !== '모집' && scene !== '전투' ? false : ICON_KEEP.some(([kx, ky, kw, kh]) => x < kx + kw && x + bw > kx && y < ky + kh && y + bh > ky);
  const setPx = (x, y, c) => { if (x < 0 || y < 0 || x >= w || y >= h || inIcon(x, y, 1, 1)) return; const j = (y * w + x) * 3; buf[j] = c[0]; buf[j + 1] = c[1]; buf[j + 2] = c[2]; };
  // ① 가장자리 붉은 빛
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const e = Math.min(Math.min(x, w - 1 - x) / w, Math.min(y, h - 1 - y) / h);
      if (e >= 0.06) { if (x > w * 0.06 && x < w * 0.94) x = Math.floor(w * 0.94); continue; }
      const k = ((0.06 - e) / 0.06) ** 2, j = (y * w + x) * 3;
      buf[j] = Math.min(255, buf[j] + Math.round(62 * k));
    }
  }
  // ② 모서리 오염
  const src = Buffer.from(buf);
  const B6 = 6;
  for (const [cx, cy, sx, sy] of [[0, 0, 1, 1], [w, 0, -1, 1], [0, h, 1, -1], [w, h, -1, -1]]) {
    const R = (90 + Math.floor(rnd() * 31)) * (heavy ? 1.7 : 1);
    for (let by = 0; by < R; by += B6) for (let bx = 0; bx < R; bx += B6) {
      const d = Math.hypot(bx, by) / R;
      if (d > 1 || rnd() > (1 - d) ** 1.3) continue;
      const x = cx + sx * bx - (sx < 0 ? B6 : 0), y = cy + sy * by - (sy < 0 ? B6 : 0);
      if (x < 0 || y < 0 || x >= w - B6 || y >= h - B6 || inIcon(x, y, B6, B6)) continue;
      const r = rnd();
      if (r < 0.35) { // 옆 칸 내용을 끌어와 붉게
        const ox = Math.max(0, Math.min(w - B6, x + [-2, -1, 1, 2][Math.floor(rnd() * 4)] * B6));
        for (let yy = 0; yy < B6; yy++) for (let xx = 0; xx < B6; xx++) {
          const s = ((y + yy) * w + ox + xx) * 3, dIdx = ((y + yy) * w + x + xx) * 3;
          buf[dIdx] = Math.min(255, src[s] + 60); buf[dIdx + 1] = Math.round(src[s + 1] * 0.35); buf[dIdx + 2] = Math.min(255, Math.round(src[s + 2] * 0.4) + 8);
        }
      } else if (r < 0.6) { const c = [[150, 16, 30], [90, 8, 18], [220, 34, 52]][Math.floor(rnd() * 3)]; for (let yy = 0; yy < B6; yy++) for (let xx = 0; xx < B6; xx++) setPx(x + xx, y + yy, c); }
      else if (r < 0.75) { for (let yy = 0; yy < B6; yy++) for (let xx = 0; xx < B6; xx++) setPx(x + xx, y + yy, [6, 2, 4]); }
      else if (r < 0.9) { const len = B6 * (1 + Math.floor(rnd() * 3)); for (let yy = B6 / 2 - 1; yy <= B6 / 2; yy++) for (let xx = 0; xx < len; xx++) setPx(x + xx, y + yy, [255, 60, 76]); }
    }
    for (let i = 0; i < (heavy ? 9 : 4); i++) { // 테두리를 따라 흐르는 세로 줄기
      const x = cx + sx * (4 + Math.floor(rnd() * (R / 2 - 4))), L = Math.floor(R / 2 + rnd() * (R / 2 + 40));
      for (let tt = 0; tt < L; tt += 2) if (rnd() < 0.85) setPx(x, cy + sy * tt - (sy < 0 ? 1 : 0), rnd() < 0.85 ? [255, 46, 64] : [255, 200, 205]);
    }
  }
  // ③ 붉은 잡음 점
  for (let i = 0, nn = heavy ? 170 : 35; i < nn; i++) {
    const x = Math.floor(rnd() * (w - 2)), y = Math.floor(rnd() * (h - 2)), c = rnd() < 0.5 ? [200, 30, 45] : [120, 14, 24];
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) setPx(x + dx, y + dy, c);
  }
  // ④ 약한 가로 띠 밀림 5줄(글자 줄은 피함)
  const safe = BAND_SAFE[scene] ?? [];
  let n = 0;
  for (let tries = 0, want = heavy ? 15 : 5; n < want && tries < 900; tries++) {
    const y0 = Math.floor(rnd() * (h - 12)), hh = heavy ? 2 + Math.floor(rnd() * 7) : 2 + Math.floor(rnd() * 3);
    if (safe.some(([a, b]) => (a <= y0 && y0 <= b) || (a <= y0 + hh && y0 + hh <= b))) continue;
    const dx = (rnd() < 0.5 ? -1 : 1) * (heavy ? 10 + Math.floor(rnd() * 31) : 4 + Math.floor(rnd() * 7)), rowBytes = w * 3;
    for (let yy = y0; yy < y0 + hh; yy++) {
      const start = yy * rowBytes, row = Buffer.from(buf.subarray(start, start + rowBytes));
      row.copy(buf, start + Math.max(0, dx) * 3, Math.max(0, -dx) * 3, rowBytes - Math.max(0, dx) * 3);
    }
    n++;
  }
  if (!heavy) return;
  // ⑤ 분노 전용: 띠마다 붉은 채널만 따로 밀어 색이 갈라지게 · 블록이 통째로 어긋나 겹치게 · 주사선
  const rowBytes = w * 3;
  for (let i = 0, k = 0, tries = 0; k < 8 && tries < 400; tries++) {
    const y0 = Math.floor(rnd() * (h - 16)), hh = 3 + Math.floor(rnd() * 9);
    if (safe.some(([a, b]) => (a <= y0 && y0 <= b) || (a <= y0 + hh && y0 + hh <= b))) continue;
    k++;
    const d = (rnd() < 0.5 ? -1 : 1) * (6 + Math.floor(rnd() * 14));
    for (let yy = y0; yy < y0 + hh; yy++) {
      const start = yy * rowBytes, row = Buffer.from(buf.subarray(start, start + rowBytes));
      for (let x = 0; x < w; x++) { const sx = Math.max(0, Math.min(w - 1, x - d)); buf[start + x * 3] = row[sx * 3]; }
    }
  }
  for (let i = 0, k = 0, tries = 0; k < 6 && tries < 300; tries++) { // 직사각 블록을 옆으로 옮겨 붙이고 붉게 물들인다
    const bw = 40 + Math.floor(rnd() * 90), bh = 10 + Math.floor(rnd() * 30);
    const x0 = Math.floor(rnd() * (w - bw - 60)) + 30, y0 = Math.floor(rnd() * (h - bh - 10)) + 5;
    if (inIcon(x0, y0, bw + 60, bh) || safe.some(([a, b]) => (a <= y0 && y0 <= b) || (a <= y0 + bh && y0 + bh <= b))) continue;
    k++;
    const mv = (rnd() < 0.5 ? -1 : 1) * (14 + Math.floor(rnd() * 40)), blk = [];
    for (let yy = 0; yy < bh; yy++) blk.push(Buffer.from(buf.subarray(((y0 + yy) * w + x0) * 3, ((y0 + yy) * w + x0 + bw) * 3)));
    blk.forEach((row, yy) => { for (let xx = 0; xx < bw; xx++) { const x = x0 + mv + xx; if (x < 0 || x >= w) continue; const j = ((y0 + yy) * w + x) * 3; buf[j] = Math.min(255, row[xx * 3] + 70); buf[j + 1] = Math.round(row[xx * 3 + 1] * 0.5); buf[j + 2] = Math.round(row[xx * 3 + 2] * 0.5); } });
  }
  for (let y = 0; y < h; y += 4) { // 주사선: 4줄마다 한 줄을 어둡게(아이콘 칸 제외)
    if (safe.some(([a, b]) => a <= y && y <= b)) continue;
    for (let x = 0; x < w; x++) { if (inIcon(x, y, 1, 1)) continue; const j = (y * w + x) * 3; buf[j] = Math.round(buf[j] * 0.78); buf[j + 1] = Math.round(buf[j + 1] * 0.78); buf[j + 2] = Math.round(buf[j + 2] * 0.78); }
  }
}
// ── ??? 기술 연출: 그려 넣는 대신 '화면 자체가 깨지는' 글리치 후처리 ──
// 이미 그려진 장면(buf) 위에서 가로 띠 찢김·RGB 어긋남·블록 뒤섞임·픽셀화·잔상을 만든다. 플레이어 아이콘 칸은 끝에 원본으로 되돌린다(아이콘은 건드리지 않음).
let rageGlitch = 0; // 분노 중인 오염 몬스터 전투 장면이면 턴 번호(>0) — corruptPost 를 heavy 로 부른다
let skillCtx = null; // 이번 장면의 기술 연출 정보 { fx, mx, my, targets: [{x,y,w,h}] } (설계 좌표)
const SKILL_FX = ['crash', 'overclock', 'deadeye', 'vuln', 'killnine', 'gateway'];
function skillGlitch(ctx, seed) {
  const rnd = seeded(seed), w = p.w, h = p.h, buf = p.buf, S = RENDER_SCALE;
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const px = (v) => Math.round(v * S);
  const clampX = (x) => Math.max(0, Math.min(w, x)), clampY = (y) => Math.max(0, Math.min(h, y));
  const saved = ICON_KEEP.map(([x, y, kw, kh]) => { const rows = []; for (let yy = y; yy < Math.min(h, y + kh); yy++) rows.push(Buffer.from(buf.subarray((yy * w + x) * 3, (yy * w + Math.min(w, x + kw)) * 3))); return rows; });
  const grab = (x0, y0, x1, y1) => { x0 = clampX(x0); x1 = clampX(x1); y0 = clampY(y0); y1 = clampY(y1); const rows = []; for (let y = y0; y < y1; y++) rows.push(Buffer.from(buf.subarray((y * w + x0) * 3, (y * w + x1) * 3))); return { x0, y0, x1, y1, rows }; };
  // 가로 띠를 dx 만큼 밀기(밀려 나간 만큼은 반대편에서 돌아 들어옴)
  const shiftRows = (x0, y0, x1, y1, dx) => {
    const g = grab(x0, y0, x1, y1), n = g.x1 - g.x0; if (n <= 0) return;
    g.rows.forEach((row, k) => { const y = g.y0 + k; for (let i = 0; i < n; i++) { const s = (((i - dx) % n) + n) % n; const d = (y * w + g.x0 + i) * 3; buf[d] = row[s * 3]; buf[d + 1] = row[s * 3 + 1]; buf[d + 2] = row[s * 3 + 2]; } });
  };
  // 색 채널 어긋남: 붉은 채널은 왼쪽, 푸른 채널은 오른쪽으로
  const splitRgb = (x0, y0, x1, y1, off) => {
    const g = grab(x0, y0, x1, y1), n = g.x1 - g.x0;
    g.rows.forEach((row, k) => { const y = g.y0 + k; for (let i = 0; i < n; i++) { const d = (y * w + g.x0 + i) * 3; buf[d] = row[Math.min(n - 1, i + off) * 3]; buf[d + 2] = row[Math.max(0, i - off) * 3 + 2]; } });
  };
  // 잔상: 영역을 (dx,dy) 만큼 옮겨 tint 색으로 밝은 부분만 겹친다
  const ghost = (x0, y0, x1, y1, dx, dy, a, tint) => {
    const g = grab(x0, y0, x1, y1), n = g.x1 - g.x0;
    for (let k = 0; k < g.rows.length; k++) for (let i = 0; i < n; i++) {
      const sx = i - dx, sy = k - dy; if (sx < 0 || sx >= n || sy < 0 || sy >= g.rows.length) continue;
      const s = g.rows[sy], lum = Math.max(s[sx * 3], s[sx * 3 + 1], s[sx * 3 + 2]); if (lum < 70) continue;
      const d = ((g.y0 + k) * w + g.x0 + i) * 3;
      for (let c = 0; c < 3; c++) buf[d + c] = Math.max(buf[d + c], Math.round(lum * a * tint[c] / 255));
    }
  };
  // 픽셀화(블록 평균)
  const pixelate = (x0, y0, x1, y1, sz) => {
    x0 = clampX(x0); x1 = clampX(x1); y0 = clampY(y0); y1 = clampY(y1);
    for (let by = y0; by < y1; by += sz) for (let bx = x0; bx < x1; bx += sz) {
      const ex = Math.min(x1, bx + sz), ey = Math.min(y1, by + sz); let r = 0, g2 = 0, b = 0, c = 0;
      for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) { const i = (y * w + x) * 3; r += buf[i]; g2 += buf[i + 1]; b += buf[i + 2]; c++; }
      r = Math.round(r / c); g2 = Math.round(g2 / c); b = Math.round(b / c);
      for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) { const i = (y * w + x) * 3; buf[i] = r; buf[i + 1] = g2; buf[i + 2] = b; }
    }
  };
  // 블록 뒤섞임: 같은 영역 안 다른 곳의 조각을 복사해 붙인다(붉게 물들여)
  const swapBlocks = (x0, y0, x1, y1, n, bw, bh) => {
    const g = grab(x0, y0, x1, y1), gw = g.x1 - g.x0, gh = g.rows.length; if (gw <= bw || gh <= bh) return;
    for (let t = 0; t < n; t++) {
      const sx = ri(0, gw - bw), sy = ri(0, gh - bh), dx = ri(0, gw - bw), dy = ri(0, gh - bh), red = rnd() < 0.6;
      for (let yy = 0; yy < bh; yy++) for (let xx = 0; xx < bw; xx++) {
        const s = g.rows[sy + yy], d = ((g.y0 + dy + yy) * w + g.x0 + dx + xx) * 3, si = (sx + xx) * 3;
        buf[d] = red ? Math.min(255, s[si] + 70) : s[si]; buf[d + 1] = red ? Math.round(s[si + 1] * 0.3) : s[si + 1]; buf[d + 2] = red ? Math.round(s[si + 2] * 0.35) : s[si + 2];
      }
    }
  };
  // 한 점을 옆으로 끌어 늘린 자국(멈춘 픽셀)
  const smearH = (y, x0, len, dir) => {
    const i0 = (y * w + x0) * 3, c = [buf[i0], buf[i0 + 1], buf[i0 + 2]];
    for (let k = 1; k <= len; k++) { const x = x0 + dir * k; if (x < 0 || x >= w) break; const a = 0.85 * (1 - k / len), d = (y * w + x) * 3; for (let q = 0; q < 3; q++) buf[d + q] = Math.round(buf[d + q] * (1 - a) + c[q] * a); }
  };
  const staticNoise = (x0, y0, x1, y1, dens) => {
    for (let y = clampY(y0); y < clampY(y1); y++) for (let x = clampX(x0); x < clampX(x1); x++) { if (rnd() > dens) continue; const v = rnd(), d = (y * w + x) * 3; buf[d] = v < 0.5 ? 255 : 30; buf[d + 1] = v < 0.5 ? 58 : 6; buf[d + 2] = v < 0.5 ? 74 : 14; }
  };
  const fill = (x0, y0, x1, y1, c) => { for (let y = clampY(y0); y < clampY(y1); y++) for (let x = clampX(x0); x < clampX(x1); x++) { const d = (y * w + x) * 3; buf[d] = c[0]; buf[d + 1] = c[1]; buf[d + 2] = c[2]; } };
  const gtxt = (s2, x, y, size, color) => { text(s2, x + 2, y + 1, size, '#2ad0d8'); text(s2, x - 1, y, size, '#ff3a4a'); text(s2, x, y, size, color); }; // 어긋난 색 그림자 글자
  const mon = { x0: px(ctx.mx - 150), x1: px(ctx.mx + 150), y0: px(ctx.my - 84), y1: px(ctx.my + 104) };
  const bandRows = (x0, y0, x1, y1, n, maxH, maxDx) => { for (let i = 0; i < n; i++) { const hh = ri(2, maxH), yy = ri(y0, Math.max(y0, y1 - hh)); shiftRows(x0, yy, x1, yy + hh, (rnd() < 0.5 ? -1 : 1) * ri(6, maxDx)); } };
  const tgts = ctx.targets;

  if (ctx.fx === 'crash') {
    // 데이터 크래시: 몬스터·파티 줄이 찢겨 어긋나고, 조각이 엉뚱한 곳에 붙고, 맞은 카드는 테두리가 두 겹으로 갈라진다
    bandRows(mon.x0, mon.y0, mon.x1, mon.y1, 5, 9, 34);
    splitRgb(mon.x0, mon.y0, mon.x1, mon.y1, 4);
    bandRows(0, px(CARD_Y), w, px(CARD_Y + CARD_H), 9, 12, 46);
    swapBlocks(0, px(CARD_Y), w, px(CARD_Y + CARD_H), 8, px(44), px(20));
    swapBlocks(mon.x0, mon.y0, mon.x1, mon.y1, 4, px(30), px(16));
    splitRgb(0, px(CARD_Y), w, px(CARD_Y + CARD_H), 3);
    for (const t of tgts) {
      p.strokeRoundRect(t.x + 7, t.y + 3, t.w - 8, t.h, 10, 2, '#2ad0d8');
      p.strokeRoundRect(t.x - 5, t.y - 3, t.w, t.h, 10, 2, '#ff3a4a');
      gtxt(['0x7F3A', '0xC0DE', '0xBAD1', '0xDEAD'][ri(0, 3)], t.x + t.w - 46, t.y + t.h - 18, 14, '#ffb0b8');
    }
  } else if (ctx.fx === 'overclock') {
    // 오버클록: 처리가 빨라져 몬스터가 잔상을 끌고 다니고(프레임 겹침), 옆으로 번지며, 줄마다 박자가 어긋난다
    for (const [dx, a] of [[-px(34), 0.28], [-px(18), 0.45], [px(18), 0.45], [px(34), 0.28]]) ghost(mon.x0, mon.y0, mon.x1, mon.y1, dx, 0, a, [255, 40, 56]);
    for (let y = mon.y0; y < mon.y1; y += 3) if ((y >> 1) % 3 === 0) shiftRows(mon.x0, y, mon.x1, y + 1, ri(-6, 6));
    for (let i = 0; i < 14; i++) { const y = ri(mon.y0 + px(10), mon.y1 - px(10)); smearH(y, mon.x1 - px(52), ri(px(30), px(110)), 1); smearH(y, mon.x0 + px(52), ri(px(30), px(110)), -1); }
    splitRgb(mon.x0 - px(20), mon.y0, mon.x1 + px(20), mon.y1, 3);
    gtxt('CLK ▲ 150%', ctx.mx - 215, ctx.my - 40, 17, '#ff6a78');
  } else if (ctx.fx === 'deadeye') {
    // 데드아이: 표적 카드에 끊긴 조준 고리(색 어긋난 복사본) + LOCK
    for (const t of tgts) {
      const x1 = t.x + t.w / 2, y1 = t.y + 86;
      // 끊긴 조준 고리: 조각난 호 네 개 + 어긋난 복사본(아이콘 바깥쪽)
      for (let a = 0; a < 4; a++) {
        const a0 = a * Math.PI / 2 + 0.25 + rnd() * 0.2;
        for (const [off, c] of [[0, '#ff3a4a'], [5, '#2ad0d8']]) { const pts = []; for (let q = 0; q <= 8; q++) { const an = a0 + q * 0.1; pts.push([x1 + off + Math.cos(an) * 62, y1 + Math.sin(an) * 62]); } for (let q = 0; q < 8; q++) p.line(pts[q][0], pts[q][1], pts[q + 1][0], pts[q + 1][1], 4, c); }
      }
      gtxt('LOCK', x1, t.y + 36, 16, '#ff6a78');
    }
  } else if (ctx.fx === 'vuln') {
    // 취약점 분석: 화면 위로 16진 덤프가 흘러가고, 스캔선이 훑은 자리가 어긋나며, 카드엔 '발견된 구멍'이 픽셀 조각으로 생긴다
    for (let row = 0; row < 7; row++) { let line = ''; for (let k = 0; k < 14; k++) line += ('0' + ri(0, 255).toString(16)).slice(-2).toUpperCase() + ' '; text(line, ctx.mx, ctx.my - 100 + row * 22 + (row % 2) * 4, 13, row % 3 === 0 ? '#c81e2d' : '#5a0812'); }
    const sy = px(CARD_Y - 12 + ri(0, 40));
    shiftRows(0, sy, w, sy + px(14), ri(px(14), px(26))); splitRgb(0, sy, w, sy + px(14), 4);
    fill(0, sy + px(14), w, sy + px(16), [255, 58, 74]);
    bandRows(0, sy + px(16), w, px(CARD_Y + CARD_H), 5, 6, 18);
    for (const t of tgts) { pixelate(px(t.x + 4), px(t.y + 4), px(t.x + t.w - 4), px(t.y + 44), px(10)); for (let k = 0; k < 7; k++) { const bx = t.x + 10 + ri(0, t.w - 40), by = t.y + 46 + ri(0, t.h - 70); p.rect(bx, by, 10, 10, k % 2 ? '#ff3a4a' : '#0d0406'); p.rect(bx + 3, by + 3, 4, 4, '#ff3a4a'); } gtxt('0xBUG', t.x + t.w - 40, t.y + 26, 13, '#ffb0b8'); }
  } else if (ctx.fx === 'killnine') {
    // kill -9: 표적 카드가 꺼지는 화면처럼 위아래가 새까맣게 접히고(정적 노이즈) 한 줄만 남아 번쩍, 터미널 문구
    for (const t of tgts) {
      for (const [a0, a1] of [[t.y + 4, t.y + 44], [t.y + 128, t.y + t.h - 4]]) { fill(px(t.x + 4), px(a0), px(t.x + t.w - 4), px(a1), [6, 2, 5]); staticNoise(px(t.x + 4), px(a0), px(t.x + t.w - 4), px(a1), 0.16); }
      const ly = t.y + 86;
      p.rect(t.x + 6, ly - 3, t.w - 12, 6, '#ff3a4a'); p.rect(t.x + 6, ly - 1, t.w - 12, 2, '#ffffff');
      smearH(px(ly), px(t.x + 6), px(70), -1); smearH(px(ly), px(t.x + t.w - 6), px(70), 1);
      text('> kill -9 ' + (1000 + ri(0, 8999)), t.x + t.w / 2, t.y + 28, 15, '#ff6a78');
      text('Killed', t.x + t.w / 2, t.y + t.h - 28, 22, '#ff3a4a'); p.rect(t.x + t.w / 2 + 40, t.y + t.h - 46, 10, 20, '#ff3a4a');
      splitRgb(px(t.x), px(t.y), px(t.x + t.w), px(t.y + t.h), 3);
    }
  } else if (ctx.fx === 'gateway') {
    // 블랙월 게이트웨이: 화면 전체가 세로 조각으로 갈라져 위아래로 어긋나고, 새까만 공허 사각형이 뚫리며 붉은 선이 간다
    const full = grab(0, 0, w, h);
    let x = 0; while (x < w) {
      const cw = ri(px(20), px(70)), dy = ri(-px(26), px(26));
      if (rnd() < 0.75) for (let i = x; i < Math.min(w, x + cw); i++) for (let y = 0; y < h; y++) { const sy = y - dy; const d = (y * w + i) * 3; if (sy < 0 || sy >= h) { buf[d] = 6; buf[d + 1] = 2; buf[d + 2] = 5; continue; } const s = full.rows[sy]; buf[d] = s[i * 3]; buf[d + 1] = s[i * 3 + 1]; buf[d + 2] = s[i * 3 + 2]; }
      x += cw;
    }
    splitRgb(0, 0, w, h, 6);
    bandRows(0, 0, w, h, 8, 8, 60);
    for (let i = 0; i < 5; i++) { const vw = ri(px(70), px(220)), vh = ri(px(24), px(80)), vx = ri(0, w - vw), vy = ri(px(110), h - vh - px(10)); fill(vx, vy, vx + vw, vy + vh, [3, 1, 3]); fill(vx, vy, vx + vw, vy + 2, [255, 58, 74]); fill(vx, vy + vh - 2, vx + vw, vy + vh, [150, 16, 30]); staticNoise(vx, vy, vx + vw, vy + vh, 0.05); }
    gtxt('▓ BLACKWALL GATEWAY ▓', ctx.mx, ctx.my + 138, 26, '#ff6a78');
  }
  // 아이콘 칸 되돌리기
  ICON_KEEP.forEach(([x, y, kw, kh], i) => saved[i].forEach((row, k) => row.copy(buf, ((y + k) * w + x) * 3)));
}
async function render(scene, draw, monster = null) {
  if (!load()) return null;
  p = painter;
  activeRoles = rolesOfMonster(monster);
  const corrupt = isCorrupt(monster), alatTheme = isAlat(monster);
  const savedC = corrupt || alatTheme ? { ...C } : null;
  const savedRibbon = corrupt || alatTheme ? RIBBON.pending.fill : null;
  if (corrupt) { Object.assign(C, CORRUPT_C); RIBBON.pending.fill = '#b81c2a'; themeKey = ':corrupt'; }
  if (alatTheme) { Object.assign(C, ALAT_C); RIBBON.pending.fill = '#a8662c'; themeKey = ':alat'; }
  try {
    const t0 = process.hrtime.bigint();
    skillCtx = null; rageGlitch = false; alatThemeEl = null; alatCalm = false;
    draw();
    if (corrupt && skillCtx && SKILL_FX.includes(skillCtx.fx)) skillGlitch(skillCtx, (skillCtx.fx.length * 977 + 13) >>> 0);
    if (corrupt) corruptPost(scene, scene.length * 31 + 7 + (rageGlitch ? rageGlitch * 53 : 0), !!rageGlitch); // 분노는 턴마다 깨진 모양이 달라진다
    if (alatTheme && scene !== '모집' && !alatCalm) alatPost(scene, alatThemeEl ?? 'none', !!alatThemeRage); // 속성이 없는 결과 화면은 무속성 테두리, 대기 로비(모집)는 테두리 효과 없음
    const t1 = process.hrtime.bigint();
    const png = painter.png();
    logRender(scene, Number(t1 - t0) / 1e6, Number(process.hrtime.bigint() - t1) / 1e6, png.length);
    return png;
  } catch (err) {
    console.error(`레이드 ${scene} 그림 실패:`, err);
    return null;
  } finally {
    if (corrupt || alatTheme) { Object.assign(C, savedC); RIBBON.pending.fill = savedRibbon; themeKey = ''; }
  }
}

// ── 장면별 그림 ────────────────────────────────────────────────
// ── 알바트리온 전용 효과(블랙월처럼 화면 구성은 그대로 두고 효과만 얹는다): 포효 충격파 · 바람 · 후광 · 불씨 ──
const alphaHex = (a) => Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0');
function alatRoarFx(cx, cy, box) { // 몬스터 뒤: 핏빛 후광 + 번져 나가는 충격파 점선 고리 + 바깥으로 쓸리는 바람 줄 + 떠오르는 불씨 (box=[x0,y0,x1,y1] 안에서만)
  const [x0, y0, x1, y1] = box, rnd = seeded(77);
  for (const [rw, rh, al] of [[250, 120, 0.1], [190, 92, 0.12], [130, 64, 0.16]]) p.roundRect(cx - rw, cy - rh * 0.5, rw * 2, rh, rh / 2, '#ff9a50', al);
  for (let i = 0; i < 16; i++) { const left = i % 2 === 0, len = 40 + rnd() * 90, y = y0 + 14 + rnd() * (y1 - y0 - 28), x = left ? x0 + 14 + rnd() * 160 : x1 - 14 - rnd() * 160 - len; p.rect(x, y, len, 2, '#ffe0b0' + alphaHex(0.12 + rnd() * 0.2)); }
  for (let i = 0; i < 26; i++) p.rect(x0 + rnd() * (x1 - x0), y0 + rnd() * (y1 - y0), 3, 3, '#ffb050' + alphaHex(0.35 + rnd() * 0.5));
}
function alatEndFx(clear) { // 결과 화면 위쪽: 클리어는 금빛 후광과 떠오르는 금빛 가루, 전멸·도주는 붉게 달아오른 불씨
  const rnd = seeded(clear ? 5 : 9), col = clear ? '#ffe9b0' : '#ff8a6a';
  for (const [rw, rh, al] of [[300, 96, 0.08], [220, 72, 0.1], [150, 50, 0.12]]) p.roundRect(W / 2 - rw, 70 - rh / 2, rw * 2, rh, rh / 2, clear ? '#ffd870' : '#c83a1c', al);
  for (let i = 0; i < 44; i++) p.rect(30 + rnd() * 840, 16 + rnd() * 124, 3, 3, col + alphaHex(0.3 + rnd() * 0.5));
}
function renderRecruit(r) {
  return render('모집', () => {
    const alat = isAlat(r.monster);
    background('recruit', 102, 240);
    const title = alat ? '천재지변 출현' : '몬스터 출현!';
    const tw = p.textWidth(B(), title, 46);
    if (isCorrupt(r.monster)) glitchText(title, W / 2, 47, 46, C.gold, { seed: 1, off: 5, strips: 6, shift: 9, holes: 6, tint: true });
    else if (alat) engraved(title, W / 2, 47, 46, '#f6e0b8');
    else text(title, W / 2, 47, 46, C.gold);
    if (alat) { // 해골 대신 다섯 속성 색 마름모 세 개씩
      ['#ff8c23', '#46cdff', '#f0c8ff'].forEach((c, i) => { for (const sg of [-1, 1]) { const x = W / 2 + sg * (tw / 2 + 34 + i * 22), y = 47, d = 9 - i * 1.5; p.poly([x, y - d, x + d, y, x, y + d, x - d, y], '#1a0f08'); p.poly([x, y - d + 2.5, x + d - 2.5, y, x, y + d - 2.5, x - d + 2.5, y], c); } });
    } else { titleIcon(W / 2 - tw / 2 - 46, 47); titleIcon(W / 2 + tw / 2 + 46, 47); }
    const sub = alat ? `${r.monster.name}${subjectJosa(r.monster.name)} XP 시스템을 지배 중이다...` : `${r.monster.name}${subjectJosa(r.monster.name)} XP 시스템을 망가뜨렸어요!`;
    if (isCorrupt(r.monster)) glitchText(sub, W / 2, 84, 21, '#ff8f7a', { seed: 2, off: 2, strips: 2, shift: 3, holes: 2, tint: true, maxWidth: W - 120 });
    else if (alat) engraved(sub, W / 2, 84, 21, '#ffb48a', { maxWidth: W - 120 });
    else text(sub, W / 2, 84, 21, '#ff8f7a', { maxWidth: W - 120 });
    if (alat) alatRoarFx(W / 2, 200, [26, 106, W - 26, 340]);
    drawMonster(r.monster, W / 2, 206, 112);
    if (isCorrupt(r.monster)) glitchText(r.monster.name, W / 2, 298, 38, C.gold, { seed: 3, off: 4, strips: 5, shift: 8, holes: 4, tint: true });
    else if (alat) engraved(r.monster.name, W / 2, 298, 38, '#ffd9a0');
    else text(r.monster.name, W / 2, 298, 38, C.gold);
    cards(r.party, (x, y, w, h, roleKey, m) => {
      const role = ROLES[roleKey];
      roleIcon(roleKey, x + w / 2, y + 50, !m);
      // 이름 크기는 모집·전투·결과 모두 NAME_SIZE로 같게 — 모집 때 만든 글자 모양을 전투·결과에서 그대로 재사용한다
      // (크기가 다르면 서버에서 전투 시작 그림이 이름을 다시 그리느라 170ms 걸렸다).
      text(m ? m.name : '-', x + w / 2, y + 116, NAME_SIZE, m ? C.text : C.dim, { maxWidth: w - 20 });
      if (!role.hideName) text(role.name, x + w / 2, y + 152, 22, m ? C.orange : '#8a6a3a');
      pill(x + 14, y + 176, w - 28, 34, role.skill.name, 20);
      text(m ? '참가 완료' : '참가 대기', x + w / 2, y + 234, 22, m ? C.ok : C.muted);
    });
  }, r.monster);
}

// 카드 상태: 아직 고르지 않음(주황 리본·굵은 금테) / 고름(초록 리본·초록테, 고른 행동 표시) / 쓰러짐(회색).
// 동시에 고르는 방식이라 "내 차례 = 아직 안 고름"이 한눈에 보이게 리본을 크게 띄운다.
const RIBBON = {
  pending: { fill: '#c4630f', color: '#ffffff' },
  ready:   { fill: '#1e6b3c', color: '#d9ffe6' },
  down:    { fill: '#3a3530', color: '#b0a89a' },
  stunned: { fill: '#6b5a14', color: '#fff3b0' },
  frozen:  { fill: '#1f5f8a', color: '#e6f8ff' }, // 빙결(행동 불가) — 얼음 색
};
function memberState(b, mem, showingResult) {
  if (mem.hp <= 0) return 'down';
  if (showingResult) return 'result';
  if (isStunned(b, mem)) return 'stunned';
  return mem.choice ? 'ready' : 'pending';
}
function choiceLabel(mem) {
  if (mem.choice === 'skill') return ROLES[mem.role].skill.name;
  return ACTIONS[mem.choice]?.name ?? '';
}
// 지난 턴 행동 말풍선 문구: "회전베기 280", "회복약 +45", "방어"
function actLabel(act) {
  if (!act) return null;
  if (act.value === undefined) return act.label;
  return act.heal ? `${act.label} +${act.value}` : `${act.label} ${act.value}`;
}

// 원숭이 부하(몬스터 minions): 몬스터 양옆에 작게 + 아래 HP 막대. 결과 화면엔 이번 턴 받은 피해(빨강)를 HP 막대 아래에,
// 이번 턴 쓰러진 부하는 회색으로 한 번 더 보여 주고 그다음부턴 그리지 않는다. 부하를 불러낸 턴엔 발밑에 흙먼지.
// 그린 부하가 있으면 true(오른쪽 피해 숫자를 바깥으로 비킨다).
// 방귀 구름(외곽선 있는 겨자색 뭉게구름) · 악취 아이콘(소용돌이 갈색 구름)
const FART_CLOUD = { rows: ['..aaa.aaa..', '.ahhhahhha.', 'ahhoooooooa', 'aoooooooooa', '.aoooooooa.', '..aaaaaaa..'], palette: { a: '#4f441a', h: '#ece2a0', o: '#c2b450' } };
const STENCH_ICON = {
  rows: ['......aaaa......', '.....ahhhha.....', '....ahooooha....', '...ahoodddoha...', '...ahoddoddda...', '..ahoddoooodda..', '..ahoddodooodha.', '.aoooodddooodoa.', '.adooooooooddoa.', '..adooooooddooa.', '...aaaaaaaaaaa..'],
  palette: { a: '#3a1e0a', o: '#c47a32', h: '#eaa860', d: '#6a3812' },
};
const PEEL = { rows: ['y...y', 'yy.yy', '.yyy.', '..d..'], palette: { y: '#f5d040', d: '#7a5410' } };
const BANANA = { rows: ['...y', '..yy', '.yyd', 'yyd.', 'dd..'], palette: { y: '#f5d040', d: '#a8781a' } };
const MINION_SPOTS = [-172, 172, -262];
function drawMinions(b, last, showingResult) {
  const mn = b.monster.minions;
  const list = b.minions ?? [];
  if (!mn || !list.length) return false;
  let shown = false;
  list.forEach((mi, i) => {
    const hitNow = showingResult ? last?.minionHits?.[i] : 0;
    if (mi.hp <= 0 && !hitNow) return;
    shown = true;
    const cx = W / 2 + MINION_SPOTS[i % MINION_SPOTS.length], cy = 222;
    if (showingResult && last?.summoned) {
      for (const [dx, dy, r] of [[-30, 26, 12], [28, 28, 11], [0, 34, 14]]) haze(cx + dx, cy + dy, r, '#c9a27a', 0.45);
      for (const [dx, dy] of [[-40, 10], [42, 6], [-22, -30], [24, -34]]) dot(cx + dx, cy + dy, 4, '#e8d0b0');
    }
    drawPixels(mn.sprite, cx, cy, 6, { dim: mi.hp <= 0, colors: b.rage ? mn.sprite.rageColors : null });
    bar(cx - 36, cy + 42, 72, 10, mi.hp / mi.maxHp, '#f0b232');
    if (hitNow) {
      // 머리 위는 몬스터 기술 말풍선과 겹쳐서 HP 막대 아래에(결과 화면엔 예고 상자가 없음)
      p.roundRect(cx - 34, cy + 58, 68, 28, 8, '#100c09');
      text(`-${hitNow}`, cx, cy + 72, 22, '#ff5a45');
    }
  });
  return shown;
}

// ── 알바트리온 전용 헤더(기본 틀 대신): 갈라진 석판에 뿔 장식, 왼쪽 TURN 메달·오른쪽 속성 메달, 가운데 보스 HP 바(10% 눈금·분노 40% 표식)와 억제 게이지·에스카톤 ──
// 새긴 금속 글자(배경 위에 직접 쓰는 제목용): 어두운 외곽선 → 그림자 → 본색 → 윗면 하이라이트
function engraved(str, x, y, size, color, opt = {}) {
  for (const [ox, oy] of [[-2, 0], [2, 0], [0, -2], [0, 2], [-2, -2], [2, -2], [-2, 2], [2, 2]]) text(str, x + ox, y + oy, size, '#1a0f08', opt);
  text(str, x, y + 3, size, '#000000', opt);
  text(str, x, y, size, color, opt);
  text(str, x, y - 1, size, mixHex(color, '#ffffff', 0.35), opt);
  text(str, x, y + 1, size, color, opt);
}
function alatHeader(b, shownEl) {
  const A = require('./알바트리온'), al = b.alat, el = shownEl ?? al.element,col = ELEMENT_GLOW[el] || '#c8a0ff', rage = b.rage;
  const stone = '#33241a', rim = '#c08a50', rimDark = '#5a3c24';
  // 석판: 양 끝이 비스듬히 잘린 판 + 이중 테두리 + 위아래 균열 줄
  const plate = [30, 22, 56, 14, W - 56, 14, W - 30, 22, W - 22, 60, W - 30, 112, W - 56, 118, 56, 118, 30, 112, 22, 60];
  p.poly(plate, rimDark); p.poly(plate.map((v, i) => (i % 2 ? 66 + (v - 66) * 0.9 : W / 2 + (v - W / 2) * 0.985)), stone);
  { // 석재 질감: 어긋난 벽돌 이음 + 얼룩 + 지금 속성 색으로 빛나는 광물 핏줄
    const tb = pixBuf(), kz = 3;
    tb.paint(36, 20, W - 36, 112, (x, y, i, j) => {
      const row = Math.floor(y / 14), off = (row % 2) * 34, bx = (x + off) % 68, mortar = bx < 2 || (y % 14) < 2;
      const n = fbm(x / 22, y / 14, kz), vein = 1 - Math.abs(fbm(x / 30 + 4, y / 20, kz + 5) - 0.5) * 7.5;
      if (mortar) return '#1c120b';
      return ramp(['#2a1d13', '#3a2a1c', '#4c3824', '#5e4630', '#725a3c'], 0.3 + n * 0.5 + (y < 40 ? 0.08 : 0), i, j);
    });
    tb.flush(null);
  }
  p.line(60, 17, W - 60, 17, 2, rim); p.line(60, 115, W - 60, 115, 2, rim);
  for (const [rx, ry] of [[40, 28], [W - 40, 28], [40, 104], [W - 40, 104], [W / 2 - 150, 112], [W / 2 + 150, 112]]) { p.circle(rx, ry, 5, rimDark); p.circle(rx, ry, 3.5, rim); p.circle(rx - 1, ry - 1, 1.5, '#d8b890'); } // 리벳
  for (let i = 0; i < 17; i++) { const x = 84 + i * 46, hh = 9 + (i % 3) * 4 + (Math.abs(i - 8) < 3 ? 6 : 0); p.poly([x - 8, 16, x, 16 - hh, x + 8, 16], '#d8c8b0'); p.poly([x, 16 - hh, x + 8, 16, x + 2, 16], '#8a7a66'); } // 판 윗선에 줄지은 뼈 가시
  for (let i = 0; i < 14; i++) { const x = 90 + i * 55; p.line(x, 15, x + 7, 21, 1, rimDark); p.line(x + 20, 117, x + 12, 111, 1, rimDark); } // 석판의 잔금
  // 이름 뒤로 그어진 발톱 자국 세 줄 + 이름 + 양옆 뿔 장식
  for (const [dx, c] of [[-46, '#2a140c'], [-18, '#3a1c10'], [10, '#2a140c']]) { p.line(W / 2 + dx, 18, W / 2 + dx + 64, 52, 4, c); p.line(W / 2 + dx + 2, 20, W / 2 + dx + 60, 50, 1, '#7a3a1c'); }
  const name = rage ? b.monster.rageName : b.monster.name, nw = Math.min(p.textWidth(B(), name, 34), 360);
  { // 새긴 금속 글자: 속성 색 후광 → 어두운 외곽선 → 아래 그림자 → 본색 → 윗면 하이라이트
    const nc = rage ? '#ffb090' : '#f6e0b8', ny = 38;
    for (const [ox, oy] of [[-2, 0], [2, 0], [0, -2], [0, 2], [-2, -2], [2, -2], [-2, 2], [2, 2]]) text(name, W / 2 + ox, ny + oy, 27, '#1a0f08', { maxWidth: 360 });
    text(name, W / 2, ny + 3, 27, '#000000', { maxWidth: 360 });
    text(name, W / 2, ny, 27, nc, { maxWidth: 360 });
    text(name, W / 2, ny - 1, 27, mixHex(nc, '#ffffff', 0.35), { maxWidth: 360 }); // 윗면 하이라이트(살짝 위로 겹침)
    text(name, W / 2, ny + 1, 27, nc, { maxWidth: 360 });
  }
  if (rage) { p.roundRect(W / 2 + nw / 2 + 22, 24, 58, 26, 6, '#5c1410'); text('분노', W / 2 + nw / 2 + 51, 37, 18, '#ffb4a8'); }
  // 보스 HP 바: 석재 틀 + 분절된 불씨빛 게이지 + 10% 눈금 + 40%(분노) 표식
  const bx = 140, by = 63, sl0 = 14, bw = W - 280 - sl0, bh = 23, sl = 14, ratio = Math.max(0, Math.min(1, b.hp / b.maxHp));
  const quad = (x, w, y, hh, c) => p.poly([x + sl * (1 - (y - by) / bh), y, x + w + sl * (1 - (y - by) / bh), y, x + w + sl * (1 - (y + hh - by) / bh), y + hh, x + sl * (1 - (y + hh - by) / bh), y + hh], c);
  p.poly([bx + sl - 6, by - 6, bx + bw + sl + 6, by - 6, bx + bw - 6, by + bh + 6, bx - 6, by + bh + 6], rimDark); p.poly([bx + sl - 3, by - 3, bx + bw + sl + 3, by - 3, bx + bw - 3, by + bh + 3, bx - 3, by + bh + 3], '#0a0605');
  const ember = rage ? ['#2a0c20', '#7a1a4a', '#c8307a', '#ff6aa8', '#ffd0e4'] : ['#3a0a08', '#8a1a10', '#c8381c', '#f0661e', '#ffc060'];
  const seg = 4, n = Math.floor(bw / seg);
  for (let i = 0; i < n; i++) {
    const t = i / n, x = bx + i * seg, jag = Math.abs(t - ratio) < 0.05 ? (hash2(i, b.turn, 3) - 0.5) * 0.05 : 0; // 줄어든 끝은 칼로 벤 듯 들쭉날쭉
    if (t >= ratio + jag) { quad(x, seg - 1, by, bh, '#1c130f'); continue; }
    quad(x, seg - 1, by, bh, ramp(ember, 0.25 + 0.5 * (1 - Math.abs(0.5 - (i % 40) / 40) * 1.4) + t * 0.2, i, 0));
    quad(x, seg - 1, by, 5, ember[4]);
  }
  for (let q = 0; q < 6; q++) p.rect(Math.round((bx + bw * ratio + sl * 0.5 + (hash2(q, b.turn, 7) - 0.5) * 30) / 4) * 4, by - 6 - Math.floor(hash2(q, b.turn, 9) * 12), 3, 3, q % 2 ? '#ffd070' : ember[3]); // 끊어진 끝에서 튀는 불씨
  for (let k = 1; k < 10; k++) { const x = bx + Math.round(bw * k / 10), y0 = k === 4 ? by - 2 : by; p.line(x + sl * 0.5 + (k === 4 ? 2 : 0), y0, x - 1, by + bh + (k === 4 ? 6 : 0), k === 4 ? 3 : 2, k === 4 ? '#ff7a5a' : '#0a0605'); }
  p.poly([bx + bw * 0.4 + sl * 0.25 - 6, by + bh + 14, bx + bw * 0.4 + sl * 0.25 + 6, by + bh + 14, bx + bw * 0.4 + sl * 0.25, by + bh + 5], '#ff7a5a');
  for (let i = 0; i < n; i++) { const t = i / n; if (t < ratio) quad(bx + i * seg, seg - 1, by + 1, 3, ember[4]); } // 바 윗면 광택
  p.roundRect(bx + bw / 2 - 70, by + 3, 156, bh - 6, 6, '#050302', 0.62); // 숫자 뒤 어두운 판(눈금과 섞이지 않게)
  text(`${b.hp.toLocaleString()} / ${b.maxHp.toLocaleString()}`, bx + bw / 2 + sl / 2, by + bh / 2 + 1, 18, '#ffffff');
  // 억제 게이지: 방패 라벨 + 비스듬한 10칸 분절 게이지(속성 색, 칸마다 윗면 광택) + 숫자 판. 가득 차면(억제 성공 상태) 테두리가 빛나고 MAX 표시
  const gw = 380, gh = 12, sl2 = 7, gx = Math.round(W / 2 - (gw + sl2) / 2), gy = 96, gr = al.gauge / A.K.GAUGE_MAX, full = al.gauge >= A.K.GAUGE_MAX;
  const gq = (x, w, y, hh, c) => p.poly([x + sl2 * (1 - (y - gy) / gh), y, x + w + sl2 * (1 - (y - gy) / gh), y, x + w + sl2 * (1 - (y + hh - gy) / gh), y + hh, x + sl2 * (1 - (y + hh - gy) / gh), y + hh], c);
  if (full) { p.poly([gx - 6 + sl2, gy - 6, gx + gw + 6 + sl2, gy - 6, gx + gw + 6, gy + gh + 6, gx - 6, gy + gh + 6], mixHex('#0d0805', col, 0.55)); }
  p.poly([gx - 3 + sl2, gy - 3, gx + gw + 3 + sl2, gy - 3, gx + gw + 3, gy + gh + 3, gx - 3, gy + gh + 3], rimDark); gq(gx, gw, gy, gh, '#0a0605');
  const cell = (gw - 9 * 3) / 10;
  for (let q = 0; q < 10; q++) {
    const cx0 = gx + q * (cell + 3), fill = Math.max(0, Math.min(1, gr * 10 - q));
    if (fill <= 0) { gq(cx0, cell, gy + 1, gh - 2, '#1c130f'); continue; }
    gq(cx0, cell * fill, gy + 1, gh - 2, mixHex(col, '#000000', 0.25)); gq(cx0, cell * fill, gy + 1, (gh - 2) * 0.55, col); gq(cx0, cell * fill, gy + 1, 3, mixHex(col, '#ffffff', 0.6));
  }
  // 왼쪽 방패 라벨
  const lx = gx - 26 + 4, ly = gy + gh / 2;
  p.poly([lx - 13, ly - 13, lx + 13, ly - 13, lx + 13, ly + 3, lx, ly + 15, lx - 13, ly + 3], rim); p.poly([lx - 10, ly - 10, lx + 10, ly - 10, lx + 10, ly + 2, lx, ly + 12, lx - 10, ly + 2], '#0d0805'); p.poly([lx - 7, ly - 7, lx + 7, ly - 7, lx + 7, ly + 1, lx, ly + 9, lx - 7, ly + 1], mixHex('#0d0805', col, full ? 0.9 : 0.45));
  // 오른쪽 숫자 판
  const nx = gx + gw + sl2 + 26; // 왼쪽 방패 라벨과 대칭
  p.roundRect(nx - 24, gy - 5, 48, gh + 10, 7, '#0d0805', 0.85); p.strokeRoundRect(nx - 24, gy - 5, 48, gh + 10, 7, 1.5, full ? col : rimDark);
  text(full ? 'MAX' : `${Math.round(al.gauge)}`, nx, gy + gh / 2, 16, full ? '#ffffff' : col);
  // 왼쪽 TURN 메달
  const mx1 = 88, my1 = 66;
  p.circle(mx1, my1, 34, rimDark); p.circle(mx1, my1, 31, '#0a0605'); p.circle(mx1, my1, 28, stone); p.strokeRoundRect(mx1 - 28, my1 - 28, 56, 56, 28, 2, rim);
  text('TURN', mx1, my1 - 13, 12, C.muted); text(String(b.turn), mx1, my1 + 8, 28, C.gold);
  // 오른쪽: 지금 속성 표기 — 방패 문장 안에 속성 아이콘(글자 없음)
  const emblem = (cx, cy, R, e = el, glow = true) => {
    const col = ELEMENT_GLOW[e] || '#c8a0ff';
    if (glow) { p.circle(cx, cy, R + 6, mixHex('#0d0805', col, 0.16)); p.circle(cx, cy, R - 2, mixHex('#0d0805', col, 0.1)); } // 방패 없이 은은한 빛무리만
    const u = R * 0.85, hi = mixHex(col, '#ffffff', 0.6), P = (pts, c, dx = 0, dy = 0) => p.poly(pts.flatMap(([x, y]) => [cx + dx + x * u, cy + dy + y * u]), c);
    { // 도트 비트맵 아이콘(가장자리 어둡게·왼쪽 밝게·오른쪽 어둡게 자동 음영)
      const ICE = (() => { // 눈 결정: 굵은 가로·세로·대각 가지 + 갈라진 곁가지 + 육각 중심(축은 하얗게)
        const N = 9, g = Array.from({ length: 2 * N + 1 }, () => Array(2 * N + 1).fill('.')), put = (x, y, ch) => { if (Math.abs(x) <= N && Math.abs(y) <= N) g[y + N][x + N] = ch; };
        for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) for (let d = 2; d <= N; d++) { // 굵은 가지(끝은 가늘게)
          if (d <= 6) for (const o of [-1, 1]) put(dx ? dx * d : o, dy ? dy * d : o, 'l');
          if (d === 4 || d === 7) for (const sg of [-1, 1]) for (let t = 1; t <= 2; t++) put(dx ? dx * (d + t) : sg * t, dy ? dy * (d + t) : sg * t, 'm'); // V자 곁가지
        }
        for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) for (let d = 2; d <= 6; d++) { put(dx * d, dy * d, 'l'); if (d <= 5) put(dx * d, dy * (d - 1), 'm'); put(dx * 6 + dx, dy * 6, 'm'); }
        for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) if (Math.abs(x) + Math.abs(y) <= 3) put(x, y, 'l'); // 육각 중심
        for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) for (let d = 0; d <= N; d++) put(dx * d, dy * d, 'w'); // 가지 중심선
        put(0, 0, 'w');
        return g.map(r => r.join(''));
      })();
      const FIRE = ['......F........', '......FF.......', '.....FFF....F..', '.....FFOF...FF.', '....FFOOF..FFF..', '....FFOOOF.FFOF.', '...FFFOOOFFFFOF', '...FFOOYOOFFOOF', '..FFFOOYYOOFOOF', '..FFOOOYYYOOOOF', '..FFOOYYYYYOOFF', '..FFOOYYYYYOOFF', '...FFOOYYYOOFF.', '...FFFOOYOOFFF.', '....FFFOOOFFF..', '.....FFFFFFF...'].map(r => r.slice(0, 15).padEnd(15, '.'));
      const WAT = (() => { // 물방울: 둥글게 부푼 방울 + 왼쪽 위 하이라이트 + 오른쪽 아래로 짙어지는 음영
        const hw = [0, 0, 1, 1, 2, 3, 3, 4, 5, 6, 6, 7, 7, 7, 7, 6, 6, 5, 3], H = hw.length;
        return hw.map((w, y) => { let r = ''; for (let x = -8; x <= 8; x++) { if (Math.abs(x) > w) { r += '.'; continue; } const t = (x + 7) / 14 * 0.45 + y / (H - 1) * 0.55; r += ((x <= -3 && x >= -4 && y >= 9 && y <= 13) || (x === -3 && y === 8)) ? 'H' : t < 0.3 ? 'a' : t < 0.48 ? 'b' : t < 0.66 ? 'c' : t < 0.84 ? 'd' : 'e'; } return r; });
      })();
      const THU = ['......TTTTT....', '.....TTTTT.....', '.....TTTT......', '....TTTTT......', '....TTTTTTTT...', '...TTTTTTTT....', '...TTTTTTT.....', '.......TTTT....', '......TTTT.....', '......TTT......', '.....TTT.......', '.....TT........', '....TT.........', '....T..........'];
      const DRG = ['.......P.......', '......PPP......', '..P...PPP...P..', '.PPP..PPP..PPP.', '.PPP..PPP..PPP.', '.LLL..PPL..LLL.', '.LLL..LLL..LLL.', '.LLL..LLL..LLL.', '.LLLL.LLL.LLLL.', '..LLLLLLLLLLL..', '...LLLLLLLLL...', '.....LLLLL.....', '.....LLLLL.....', '.....LLLLL.....', '....LLLLLLL....'];
      const PALS = {
        fire: { F: ['#ff7a2a', '#e03c14', '#8a1a0c'], O: ['#ffc04a', '#ff9a2a', '#e8601a'], Y: ['#fffbe0', '#fff0a0', '#ffd860'], o: '#3a0a05' },
        water: { a: '#c4f2ff', b: '#6cd2ff', c: '#36a4f0', d: '#2074cc', e: '#1850a4', H: '#ffffff', o: '#0a2a58' },
        thunder: { T: ['#fffbb0', '#f6e83a', '#c89a10'], o: '#3a2c00' },
        ice: { w: '#ffffff', l: '#a8e4ff', m: '#5eb2ee', o: '#0c3050' },
        dragon: { L: ['#d6cdf4', '#a69ad8', '#6e5fae'], P: ['#b070ff', '#8a3ae8', '#5a1fb0'], o: '#1e1040' },
      };
      const NEU = Array.from({ length: 15 }, (_, y) => Array.from({ length: 15 }, (_, x) => { const d = Math.hypot(x - 7, y - 7); return (d <= 7 && d >= 5) || d <= 1.7 ? 'N' : '.'; }).join('')); // 무속성: 빈 고리와 가운데 점
      PALS.none = { N: ['#f0eef8', '#c0bad0', '#7e788f'], o: '#1a1626' };
      const rows = { none: NEU, fire: FIRE, water: WAT, thunder: THU, ice: ICE }[e] || DRG, pal = PALS[e] || PALS.dragon;
      const c = R * (glow ? 1.6 : 2) / Math.max(rows.length, rows[0].length), ox = Math.round(cx - rows[0].length * c / 2), oy = Math.round(cy - rows.length * c / 2), at = (r, k) => rows[r]?.[k] ?? '.';
      for (let r = -1; r <= rows.length; r++) for (let k = -1; k <= rows[0].length; k++) {
        const ch = at(r, k); let color = null;
        if (ch === '.') { if (at(r - 1, k) !== '.' || at(r + 1, k) !== '.' || at(r, k - 1) !== '.' || at(r, k + 1) !== '.') color = pal.o; }
        else { let st = 0; while (at(r, k - 1 - st) === ch) st++; let len = st; while (at(r, k + len - st) === ch) len++; const f = st / Math.max(1, len - 1); const e = pal[ch]; color = typeof e === 'string' ? e : (len < 3 ? e[1] : e[f < 0.34 ? 0 : f > 0.67 ? 2 : 1]); }
        if (color) p.rect(ox + k * c, oy + r * c, c, c, color);
      }
    }
  };
  alatEmblem = emblem;
  emblem(W - 88, 66, 30);
}
function renderBattle(r) {
  return render('전투', () => {
    const b = r.battle;
    const m = b.monster;
    const last = b.lastTurn;
    // 습격 착지 결과는 4단계(r.ambushStage): 0 충돌(연기가 헤더를 덮음, 아직 위장 몬스터 이름·HP) → 1 폭발이 잦아듦(헤더는 연기 속에서 흉성으로 바뀜) → 2 연기가 흩어짐 → 3 잔잔
    const ambushStage = r.showingResult && (last?.ambushLanded || last?.cometLanded) ? (r.ambushStage ?? 3) : -1;
    const smokeFrame = ambushStage === 0 && !!last?.ambushLanded; // 헤더가 아직 위장 몬스터 값인 단계(습격 착지만)
    background('battle', 120, 224);
    if (b.rage && isCorrupt(m)) rageGlitch = Math.max(1, b.turn | 0);
    // 속성은 턴 끝에 바뀌지만, 기술이 나간 결과 화면은 쓴 순간의 속성(prev)으로 그린다 — 전환은 다음 선택 화면에서 보여 준다
    const alatShownEl = b.alat ? ((r.showingResult && b.alat.prev && (b.alat.shifted || last?.escaton)) ? b.alat.prev : b.alat.element) : null;
    if (isAlat(m)) { alatThemeEl = alatShownEl; alatThemeRage = b.rage; } // 테마 후처리가 지금 속성 색을 쓴다
    const bodyGone = (m.theme === 'energy' && (r.showingResult ? !!(last?.ambushLanded || last?.cometLanded) : b.intent === 'recharge')) || (!r.showingResult && !isIntentHidden(b) && !!m.moves[b.intent]?.skyDot); // 돌덩이·하늘로 솟은 점(몸 없음)
    if (b.rage && !bodyGone) rageFx(m, W / 2, 196, 112, null, 'box'); // 분노: 바닥 불빛·불씨(몸이 없을 땐 둘 다 그리지 않는다)

    // 상단: TURN 배지 · 몬스터 이름(분노) · HP 바 (알바트리온은 전용 헤더)
    if (isAlat(m)) alatHeader(b, alatShownEl);
    else {
    p.roundRect(30, 20, 118, 42, 10, '#2a2119');
    p.strokeRoundRect(30, 20, 118, 42, 10, 1.5, C.gold);
    text(`TURN ${b.turn}`, 89, 41, 24, C.gold);
    // 몬스터 이름은 정확히 가운데. 왼쪽 TURN 배지와 겹치지 않게 최대 폭을 둔다(분노 표시는 이름 오른쪽).
    const name = smokeFrame ? last.disguiseName : (b.rage ? m.rageName : m.name);
    const NAME_MAX = 420;
    const nw = Math.min(p.textWidth(B(), name, 36), NAME_MAX);
    if (isCorrupt(m) && !smokeFrame) glitchText(name, W / 2, 41, 36, b.rage ? C.red : C.gold, { seed: 4, off: 4, strips: 5, shift: 8, holes: 4, tint: true, maxWidth: NAME_MAX });
    else text(name, W / 2, 41, 36, b.rage && !smokeFrame ? C.red : C.gold, { maxWidth: NAME_MAX });
    if (b.rage && !smokeFrame) {
      p.roundRect(W / 2 + nw / 2 + 12, 24, 64, 34, 8, '#5c1410');
      text('분노', W / 2 + nw / 2 + 44, 41, 22, '#ffb4a8');
    }
    const hpShown = smokeFrame ? last.disguiseHp : b.hp, hpMaxShown = smokeFrame ? last.disguiseMaxHp : b.maxHp;
    bar(50, 74, W - 100, 32, hpShown / hpMaxShown, b.rage && !smokeFrame ? '#e5383b' : '#d94a2b');
    p.strokeRoundRect(50, 74, W - 100, 32, 16, 2, C.gold);
    text(`${hpShown.toLocaleString()} / ${hpMaxShown.toLocaleString()}`, W / 2, 90, 22, '#ffffff');
    }
    if (ambushStage >= 0 && last?.ambushLanded) ambushSmoke(ambushStage); // 착지 연기: 0·1단계는 헤더를 완전히 덮고, 2단계에 흩어지고, 3단계엔 옅게 남는다

    // 몬스터 + 지난 턴 결과: 게임처럼 몬스터가 쓴 기술을 머리 왼쪽 위 말풍선으로 띄운다
    // (파티가 입힌 총피해 숫자는 일단 빼 둠 — 카드마다 행동 수치가 있어 중복이라)
    // 자세: 턴 결과 화면이면 방금 쓴 기술, 큰 한 방 직전 선택 화면이면 부푼 모습(charge), 아니면 평상시
    const usedMove = r.showingResult ? last?.monsterMoveKey : null;
    // 연출 종류(기술의 fx — 예전 저장 기록엔 없을 수 있어 기술 데이터에서 다시 구함)
    const usedFx = usedMove ? (last.monsterFx || moveFx(usedMove, m.moves[usedMove])) : null;
    // 자세: 턴 결과면 방금 쓴 기술(불이 꺼진 턴은 어지러운 dizzy), 선택 화면이면 예고한 기술의 readyPose(연막이면 숨김),
    // 점화 카운트다운 중이면 lit, 아니면 평상시
    const poses = m.sprite?.poses ?? {};
    const pose = (r.showingResult && last?.penalty && poses.cry ? 'cry' : null) // 부하를 다 잃은 턴 결과는 우는 얼굴
      || usedMove
      || (r.showingResult && last?.defused && poses.dizzy ? 'dizzy' : null)
      || (!isIntentHidden(b) ? m.moves[b.intent]?.readyPose : null)
      || (isShielded(b) && poses.shielded ? 'shielded' : null) // 보호막(갑옷)이 남은 턴엔 그 모습
      || (b.fuse && poses.lit ? 'lit' : null)
      || (isWeak(b) && poses.cry ? 'cry' : null); // 우울 상태(부하를 다 잃음) 동안
    // 기술·피격·디버프 연출 색은 분노해도 원래 색(몸 색만 분노 색으로 바뀜 — 사용자 요청)
    const fxColor = m.sprite?.palette?.o || '#7fdc8c';
    const sporeColor = m.sprite?.palette?.x || fxColor; // 포자 연출 색
    const accentColor = m.sprite?.palette?.p || sporeColor; // 반점 색(독기·파편)
    // 박치기·짓누르기는 파티 쪽(아래)으로 몸을 내밀어 그린다
    const monsterY = 196 + (isAlat(m) ? 24 : 0) + ( // 알바트리온은 바닥띠 예고가 없어 몸이 위로 떠 보이므로 전체를 아래로 내린다
usedFx === 'attack' ? 10 : usedFx === 'smash' || usedFx === 'burst' || usedFx === 'icefall' ? 6 : 0);
    // 보호막(단단해지기 다음 턴): 외곽선을 금속빛으로 바꾸고 둘레에 반짝임 + HP 바 왼쪽에 방패 배지
    const shielded = isShielded(b);
    if (shielded) {
      for (const [dx, dy] of [[-88, -40], [92, -30], [-96, 26], [100, 34], [0, -66]]) {
        p.line(W / 2 + dx - 7, monsterY + dy, W / 2 + dx + 7, monsterY + dy, 3, '#cfe8ff');
        p.line(W / 2 + dx, monsterY + dy - 7, W / 2 + dx, monsterY + dy + 7, 3, '#cfe8ff');
      }
    }
    const dormantNow = m.theme === 'energy' && (r.showingResult ? !!(last?.ambushLanded || last?.cometLanded) : b.intent === 'recharge');
    // 필살 혜성 낙하 준비 중(선택 화면): 몬스터는 하늘로 떠올라 보이지 않고, 칸 한가운데에 붉은 점만 떠 있다
    const skyDotNow = !r.showingResult && !isIntentHidden(b) && !!m.moves[b.intent]?.skyDot;
    const hideBody = dormantNow || skyDotNow; // 돌덩이·하늘로 솟은 점일 때는 몸 모양 분노 기운(붉은 덩어리)을 그리지 않는다
    if (b.rage && !hideBody) { if (isAlat(m)) alatRageAura(W / 2, monsterY); else rageFx(m, W / 2, monsterY, 112, pose, 'aura'); } // 알바트리온 분노는 전용 연출(윤곽선 대신 열기·불길·불씨)
    const shaking = !usedMove && isWarnIntent(b); // 필살기·대폭발 예고 중(선택 화면)
    // 흉성(용뢰 테마): 착지한 턴의 결과 화면과 그다음 쉬는 턴(용뢰를 모으는 중)엔 용뢰가 빠진 돌덩이 모습
    if (!r.showingResult && b.intent === 'ambush') ambushSky(W / 2, monsterY); // 습격 예고: 하늘에서 내려오는 붉은 혜성
    if (r.showingResult && (last?.ambushLanded || last?.cometLanded)) ambushImpact(W / 2, monsterY, 'back');
    if (skyDotNow) cometDot(W / 2, monsterY - 20);
    if (usedFx && SKILL_FX.includes(usedFx)) skillCtx = { fx: usedFx, mx: W / 2, my: monsterY, targets: [] };
    alatTargets = ALAT_FX.includes(usedFx) ? b.members.filter(mm => last?.hits?.[mm.userId]).map(mm => [20 + activeRoles.indexOf(mm.role) * (CARD_W + CARD_GAP) + CARD_W / 2, CARD_Y + 86]) : [];
    heungTargets = usedFx === 'lightning' ? b.members.filter(mm => last?.hits?.[mm.userId]).map(mm => 121.5 + activeRoles.indexOf(mm.role) * 219) : []; // 낙뢰가 내려칠 카드 위치
    const preFx = b.alat && ALAT_FX.includes(usedFx) && usedFx !== 'alflame' && usedFx !== 'alice' && usedFx !== 'albolt' ? Buffer.from(p.buf) : null; // 연출(뒤 층)을 그리기 전 화면 — 연출이 어디에 칠해졌는지 알아내려고
    const escCharge0 = b.alat && !r.showingResult && b.intent === 'smash' && !isIntentHidden(b); // 에스카톤 충전(선택 화면)
    const escBlast0 = b.alat && r.showingResult && last?.escaton ? { sup: !!last.escaton.suppressed, stage: Math.min(3, r.escStage ?? 0), el: last.escaton.element } : null; // 에스카톤 결과 화면(임계 → 방출 → 식음 → 여운)
    const escEl = () => 'fire'; // 에스카톤 저지먼트는 속성과 상관없이 하나의 연출(불 연출)로 통일 // 에스카톤이 물들이는 속성(무속성이면 불)
    if (escCharge0 || escBlast0) alatCalm = true; // 에스카톤 장면에서는 흩뿌리는 점 효과를 모두 끈다
    if (escCharge0) escCharge(W / 2, monsterY, escEl(b.alat.element));
    if (escBlast0) escField(escEl(escBlast0.el), W / 2, monsterY, [0.2, 0, 0.18, 0.4][escBlast0.stage], escBlast0.stage, false); // 속성 전장(몬스터 뒤): 임계 → 방출(빛기둥) → 식음 → 여운(전멸이면 어둡게)
    monsterFx(usedFx, W / 2, monsterY, fxColor, 'back', sporeColor, accentColor);
    const shiftNow = b.alat?.shifted && b.alat.prev && !skyDotNow && !r.showingResult ? // 결과 화면(기술 연출 중)에는 띄우지 않는다 — 서리 숨결에 속성 전환 고리가 겹쳐 보이던 문제. 전환은 다음 선택 화면에서 보여 준다
 [b.alat.prev, b.alat.element] : null; // 방금 속성이 바뀐 화면(결과·다음 선택)
    if (shiftNow) alatShiftBack(W / 2, monsterY, shiftNow[0], shiftNow[1]);
    // 투명화(유령): 다음 턴 동안 몸을 흐리게(회색)
    let alatMouth = null, alatBody = null;
    if (!skyDotNow) {
      const mv = b.alat ? alatMotion(r.showingResult ? usedFx : null, b.intent === 'smash' && !r.showingResult, W / 2, monsterY, b.turn) : null; // 알바트리온: 기술마다 움직임(돌진·솟구침·젖힘·떨림)과 잔상
      const ex = { rage: b.rage, pose, outline: shielded ? '#cfe8ff' : null, gray: isPhased(b), dormant: dormantNow, element: alatShownEl };
      const bgSnap = b.alat && ALAT_FX.includes(usedFx) ? Buffer.from(p.buf) : null; // 몸 픽셀을 알아내려고 몬스터를 그리기 전 화면을 기억해 둔다
      if (mv) for (const gh of mv.ghosts) drawMonster(m, gh.x, gh.y, 112 * gh.s, { ...ex, gray: true }); // 잔상(흐린 그림자)
      if (mv) { if (mv.streaks) alatStreaks(mv); drawMonster(m, mv.x, mv.y, 112 * mv.s, ex); } else drawMonster(m, W / 2, monsterY, 112, ex);
      if (b.alat) alatMouth = { x: mv ? mv.x : W / 2, y: (mv ? mv.y : monsterY) - 8 + 6 };
      if (bgSnap && (usedFx === 'alflame' || usedFx === 'alice' || usedFx === 'albolt')) alatBody = { bg: bgSnap, mon: Buffer.from(p.buf) };
      if (bgSnap && preFx) { // 연출(몸 뒤에 그린 것)과 몸이 겹쳐 보이게: 몸 픽셀에 뒤의 연출을 비쳐 섞는다(밝은 연출일수록 더 비침). 연출 모양은 그대로
        for (let yy = 0; yy < p.h; yy++) for (let xx = 0; xx < p.w; xx++) {
          const i = (yy * p.w + xx) * 3; if (p.buf[i] === bgSnap[i] && p.buf[i + 1] === bgSnap[i + 1] && p.buf[i + 2] === bgSnap[i + 2]) continue; // 몸이 아닌 칸
          const dr = bgSnap[i] - preFx[i], dg = bgSnap[i + 1] - preFx[i + 1], db = bgSnap[i + 2] - preFx[i + 2];
          if (Math.abs(dr) + Math.abs(dg) + Math.abs(db) < 12) continue; // 연출이 없는 칸
          const lum = (bgSnap[i] + bgSnap[i + 1] + bgSnap[i + 2]) / 765, w = 0.1 + 0.26 * lum; // 연출 밝기에 따라 10~36%만 몸 위로 비침(몸 모양은 또렷하게)
          p.buf[i] = Math.round(p.buf[i] * (1 - w) + bgSnap[i] * w); p.buf[i + 1] = Math.round(p.buf[i + 1] * (1 - w) + bgSnap[i + 1] * w); p.buf[i + 2] = Math.round(p.buf[i + 2] * (1 - w) + bgSnap[i + 2] * w);
        }
      }
    }
    if (r.showingResult && (last?.ambushLanded || last?.cometLanded)) ambushImpact(W / 2, monsterY, 'front');
    if (shaking && !skyDotNow && !m.ui?.noShake && !isAlat(m)) shakeFx(m, W / 2, monsterY, 112, pose); // ui.noShake 몬스터(???)는 떨림 대신 준비 자세(readyPose)만
    // 점화 카운트다운 중엔 어떤 자세·기술이든 도화선 끝에 불꽃 + 열기(sprite.fuseTip = [칸, 줄])
    if (b.fuse && m.sprite?.fuseTip) {
      const rowsNow = (pose && m.sprite.poses?.[pose]) || m.sprite.rows;
      const px = Math.floor((112 * (m.sprite.scale ?? 1)) / rowsNow.length);
      const [col, row] = m.sprite.fuseTip;
      const tx = W / 2 - (rowsNow[0].length * px) / 2 + (col + 0.5) * px, ty = monsterY - (rowsNow.length * px) / 2 + (row + 0.5) * px;
      haze(tx, ty, 18, '#ff9a3c', 0.35);
      flame(tx + 1, ty - 4, 0.75, [['#4a1206', 1.25], ['#ff6a2c', 1], ['#ffe066', 0.6], ['#ffffff', 0.25]]);
      for (const [dx, dy] of [[-11, -10], [12, -14], [14, 4], [-10, 6]]) dot(tx + dx, ty + dy, 3, '#ffe066');
    }
    if (b.rage && !m.ui?.noRageMark && !hideBody) rageFx(m, W / 2, monsterY, 112, pose, 'mark'); // ui.noRageMark 몬스터(???)는 붉은 핏줄 분노 마크를 그리지 않는다
    monsterFx(usedFx, W / 2, monsterY, fxColor, 'front', sporeColor, accentColor);
    if (escCharge0) escCore(W / 2, monsterY, escEl(b.alat.element), 1); // 몸 한가운데에서 차오르는 핵
    if (shiftNow) alatShiftFront(W / 2, monsterY, shiftNow[0], shiftNow[1]);
    if (alatBody) { // 브레스가 입에서 몸 앞으로 이어지게: 입보다 위(머리·날개)는 몸 그대로, 입 아래는 몸이 브레스에 서서히 묻히고(위에서 아래로 부드럽게), 입에는 브레스 빛이 터진다
      const cutY = Math.round((alatMouth.y + 2) * RENDER_SCALE), wpx = p.w, { bg, mon } = alatBody, fe = 26 * RENDER_SCALE;
      for (let yy = 0; yy < p.h; yy++) for (let xx = 0; xx < wpx; xx++) {
        const i = (yy * wpx + xx) * 3; if (mon[i] === bg[i] && mon[i + 1] === bg[i + 1] && mon[i + 2] === bg[i + 2]) continue;
        if (usedFx === 'albolt') { // 낙뢰: 몸 전체를 또렷하게 두고 번개 연출이 그 위로 얇게(18~48%) 겹치게 — 몸이 묻혀 안 보이지 않도록
          const er = p.buf[i], eg = p.buf[i + 1], eb = p.buf[i + 2], w = 0.18 + 0.3 * ((er + eg + eb) / 765);
          p.buf[i] = Math.round(mon[i] * (1 - w) + er * w); p.buf[i + 1] = Math.round(mon[i + 1] * (1 - w) + eg * w); p.buf[i + 2] = Math.round(mon[i + 2] * (1 - w) + eb * w);
          continue;
        }
        const a = yy < cutY ? 1 : Math.max(0, 1 - (yy - cutY) / fe); // 입 아래로 갈수록 몸이 연출에 묻힘
        if (a <= 0) continue;
        if (a < 1 && bay(xx, yy) > a) continue; // 디더링으로 부드럽게 섞음(반투명 대신 도트 격자)
        p.buf[i] = mon[i]; p.buf[i + 1] = mon[i + 1]; p.buf[i + 2] = mon[i + 2];
      }
      const Bk = BREATH[ALAT_FX_EL[usedFx]]; // 입에서 터지는 빛(브레스 색): 몸이 연출에 묻히는 경계를 가려 이어 준다
      haze(alatMouth.x, alatMouth.y + 4, 30, Bk.glow[1], 0.28); haze(alatMouth.x, alatMouth.y + 4, 18, Bk.glow[1], 0.3); haze(alatMouth.x, alatMouth.y + 4, 8, '#ffffff', 0.5);
    }
    const minionsShown = drawMinions(b, last, r.showingResult);
    // 몬스터 오른쪽: 이번 턴 받은 피해(빨강) · 재생 회복량(초록, 피해 아래). 결과 화면에서만.
    const dealtNow = r.showingResult && !last?.ambushLanded ? last?.monsterDamage : 0; // 습격 착지 턴의 피해는 사라진 위장 몬스터에게 들어간 것이라 보여 주지 않는다
    // 점액 줄기(오른쪽 끝 약 W/2+190)와 오른쪽 위 '방어력 증가' 배지(y 186까지)를 피해 그 오른쪽 아래에,
    // 어두운 바탕을 깔아 연출 위에서도 읽히게 한다.
    const numbers = [];
    if (dealtNow) numbers.push([`-${dealtNow.toLocaleString()}`, '#ff5a45']);
    if (usedMove && (last?.monsterHeal || last?.fizzled)) numbers.push([`+${(last.monsterHeal || 0).toLocaleString()}`, last.fizzled ? '#9a9a9a' : '#7cff9a']); // 독기 흡수 실패는 회색 +0
    numbers.forEach(([label, color], i) => {
      const nx = W / 2 + (minionsShown ? 292 : 250), ny = 212 + i * 38; // 오른쪽 부하가 있으면 더 바깥으로
      p.roundRect(nx - 56, ny - 17, 112, 34, 9, '#100c09');
      text(label, nx, ny, 28, color);
    });
    // 알바트리온 현황(왼쪽 위): 지금 속성 · 억제 게이지 · 에스카톤까지 남은 턴
    if (b.alat && ambushStage < 0 && !isAlat(m)) {
      const A = require('./알바트리온'), al = b.alat, col = ELEMENT_GLOW[al.element] || '#c08aff';
      const left = al.cycleLen - al.cycleTurn;
      p.roundRect(30, 118, 132, 112, 12, '#1a1410');
      p.strokeRoundRect(30, 118, 132, 112, 12, 2, col);
      text('알바트리온 현황', 96, 135, 16, C.gold);
      text(`${A.ELEMENT_NAME[al.element]}속성`, 96, 158, 20, col);
      text(left <= 0 ? '에스카톤 지금!' : `에스카톤 ${left}턴 뒤`, 96, 181, 15, left <= 1 ? '#ff7a6a' : C.muted);
      bar(42, 194, 108, 20, al.gauge / A.K.GAUGE_MAX, col);
      p.strokeRoundRect(42, 194, 108, 20, 10, 1.5, C.gold);
      text(`억제 ${Math.round(al.gauge)}`, 96, 204, 14, '#ffffff');
    }
    // 몬스터 상자 오른쪽 위에 큰 방패 배지 + 문구(방어력 증가 · 받는 피해 -N%, 보호막 기술의 effectRate)
    if (shielded) {
      p.roundRect(W - 216, 132, 180, 54, 12, '#1c2a38');
      p.strokeRoundRect(W - 216, 132, 180, 54, 12, 2, '#8fc4ff');
      drawPixels(STATUS_ICONS.shield, W - 186, 159, 3.4);
      text('방어력 증가', W - 108, 149, 19, '#cfe8ff');
      text(`피해 -${Math.round((1 - (b.shieldRate ?? 0.5)) * 100)}%`, W - 108, 172, 15, '#8fc4ff');
    }
    // 공격력 증가 배지(같은 자리, 방어력 증가와 함께면 그 아래): 다음 공격 피해 +N%
    // 오른쪽 위 배지 칸: 방어력 증가 → 투명화 → 불끄기 → 공격력 증가 순서로 아래로 쌓는다
    let slotY = shielded ? 192 : 132;
    if (isPhased(b)) {
      p.roundRect(W - 216, slotY, 180, 54, 12, '#241c3a');
      p.strokeRoundRect(W - 216, slotY, 180, 54, 12, 2, '#b9a6ff');
      text('투명화', W - 126, slotY + 17, 19, '#e6dcff');
      text('일반 공격 빗나감', W - 126, slotY + 40, 15, '#b9a6ff');
      slotY += 60;
    }
    if (isWeak(b)) {
      // 우울 상태(부하를 다 잃음): 받는 피해 증가 + 남은 턴(이번 턴 포함)
      p.roundRect(W - 216, slotY, 180, 54, 12, '#1e2440');
      p.strokeRoundRect(W - 216, slotY, 180, 54, 12, 2, '#8fd8ff');
      text('우울 상태', W - 126, slotY + 17, 19, '#dff4ff');
      text(`받는 피해 +${Math.round(((b.weakRate ?? 1) - 1) * 100)}%`, W - 126, slotY + 40, 15, '#8fd8ff');
      slotY += 60;
    }
    if (b.fuse) {
      // 불끄기: 쌓인 피해 / 기준 막대 + 남은 턴(이번 턴 포함)
      const left = Math.max(1, b.fuse.until - b.turn + 1);
      p.roundRect(W - 226, slotY, 200, 66, 12, '#3a1712');
      p.strokeRoundRect(W - 226, slotY, 200, 66, 12, 2, '#ff9a3c');
      text(`점화 · ${left}턴 남음`, W - 126, slotY + 17, 19, '#ffd8b0');
      // 남은 불: 가득 찬 막대가 피해를 넣을수록 줄어든다(사용자 요청 — 채우는 방향이 거꾸로였음)
      const fireLeft = Math.max(0, b.fuse.need - b.fuse.dealt);
      bar(W - 214, slotY + 32, 176, 24, fireLeft / b.fuse.need, '#ff9a3c');
      text(`${fireLeft.toLocaleString()} / ${b.fuse.need.toLocaleString()}`, W - 126, slotY + 44, 16, '#ffffff');
      slotY += 72;
    }
    if (isPowered(b)) {
      const by = slotY;
      p.roundRect(W - 216, by, 180, 54, 12, '#3a1712');
      p.strokeRoundRect(W - 216, by, 180, 54, 12, 2, '#ff9a7a');
      drawPixels(STATUS_ICONS.power, W - 186, by + 27, 3.4);
      text('공격력 증가', W - 108, by + 17, 19, '#ffd8cc');
      text(`피해 +${Math.round((b.powerRate - 1) * 100)}%`, W - 108, by + 40, 15, '#ff9a7a');
    }
    // 몬스터 기술 말풍선은 그 기술을 쓴 턴의 결과 화면에서만(다음 턴 선택 화면에는 남기지 않는다)
    if (r.showingResult && (last?.monsterMove || last?.defused) && ambushStage !== 0) { // 습격 폭발 장면(0단계)에는 말풍선을 숨긴다
      const label = last.defused ? '불이 꺼졌다!' : `${last.monsterMove}!`; // 불끄기 성공 턴은 기술 대신
      if (m.ui?.moveBanner === 'terminal' && !last.defused) {
        // 터미널 명령줄 띠: 검은 바탕 + 붉은 테두리, 왼쪽 '>' 프롬프트, 가운데 기술 이름(밝은 붉은색), 오른쪽 위 깜빡이는 커서 블록.
        // 말풍선(크림색 말꼬리)과 달리 몬스터 칸 아래 가운데에 가로로 깔려 몬스터·피해 숫자와 겹치지 않는다(글자는 읽히게 색 어긋남 1px만).
        const word = last.monsterMove;
        const tw = Math.min(p.textWidth(B(), word, 24), 330);
        const bw = tw + 118, bx = W / 2 - bw / 2, by = 290; // 결과 화면엔 예고 상자가 없어 몬스터 아래가 비어 있다
        p.roundRect(bx, by, bw, 38, 4, '#0a0204');
        p.strokeRoundRect(bx, by, bw, 38, 4, 1.5, '#ff2a3c');
        p.rect(bx + 3, by + 3, bw - 6, 4, '#3a0a12'); // 윗줄 제목 띠 느낌
        text('> EXEC', bx + 40, by + 21, 14, '#a8323f');
        glitchText(word, bx + 86 + tw / 2, by + 21, 24, '#ff5a68', { seed: word.length * 7 + 11, off: 1, strips: 0, holes: 0, maxWidth: 330 });
        p.rect(bx + bw - 22, by + 11, 9, 17, '#ff2a3c'); // 커서
      } else if (m.ui?.moveBanner === 'alat' && !last.defused && usedMove === 'smash' && last.escaton) {
        // 에스카톤 전용 띠는 번쩍임 위에 그려야 하므로 맨 마지막(escFlash 뒤)에 그린다
      } else if (m.ui?.moveBanner === 'alat' && !last.defused) {
        // 알바트리온 전용 기술 띠: 몬스터 칸 아래 가운데에 양끝이 뾰족한 어두운 판 + 쓴 기술 속성 색 테두리·화살표·새긴 글자(말풍선 대신)
        const col = ALAT_MOVE_COLOR[usedFx] || '#ffd9a0', word = last.monsterMove;
        const tw = Math.min(p.textWidth(B(), word, 20), 190), c = sideCard('L', 132, Math.min(tw + 86, 300), 38, 18, col); // 왼쪽 옆면에서 밀고 나오는 판(몬스터·연출을 가리지 않게)
        for (let k = 0; k < 3; k++) { const lx = c.x0 + k * 8, al = 1 - k * 0.3; p.line(lx, c.cy - 7, lx + 5, c.cy, 2, mixHex('#120a06', col, al)); p.line(lx + 5, c.cy, lx, c.cy + 7, 2, mixHex('#120a06', col, al)); } // 앞쪽 화살표
        engraved(word, c.x0 + 32 + tw / 2, c.cy + 1, 20, mixHex(col, '#ffffff', 0.45), { maxWidth: 190 });
      } else {
      const bw = Math.min(p.textWidth(B(), label, 22), 200) + 36;
      const bx = W / 2 - 92 - bw, by = 132;
      p.roundRect(bx, by, bw, 44, 14, '#f4e6cf');
      p.poly([bx + bw - 26, by + 40, bx + bw - 6, by + 40, bx + bw + 12, by + 58], '#f4e6cf'); // 말꼬리 → 몬스터
      text(label, bx + bw / 2, by + 22, 22, '#3a1a12', { maxWidth: 200 });
      }
    }

    // 다음 행동 예고 상자 — 왼쪽에 '다음 행동' 칩, 큰 공격(방어해야 할 때)은 빨간 상자 + 경고 삼각형.
    // 턴 결과 화면(3.5초)에서는 그리지 않는다 — 방금 쓴 기술(말풍선·연출)과 다음 예고(예: 필살기 경고)가 한 화면에 겹쳐
    // 두 기술을 같이 쓴 것처럼 보였다(사용자 지적). 다음 행동은 이어지는 선택 화면에서 보인다.
    if (!r.showingResult && b.alat && isAlat(m)) {
      alatNextBox(b, telegraphText(b), isWarnIntent(b), b.intent === 'smash'); // 알바트리온 전용 상자(필살기는 억제 게이지 표시)
    } else if (!r.showingResult) {
      const move = m.moves[b.intent];
      const warn = isWarnIntent(b);
      const tele = telegraphText(b); // 표식 대상 이름·연막을 반영한 예고 문구
      const boxW = 540, boxH = 46, boxX = (W - boxW) / 2, boxY = 276;
      const midY = boxY + boxH / 2;
      // ??? 같은 터미널 몬스터(ui.moveBanner)는 검은 명령줄 칸 + '> NEXT' 칩 + 깜빡이는 커서
      const term = m.ui?.moveBanner === 'terminal';
      p.roundRect(boxX, boxY, boxW, boxH, term ? 3 : 11, term ? '#0a0204' : warn ? '#4a1410' : '#201810');
      p.strokeRoundRect(boxX, boxY, boxW, boxH, term ? 3 : 11, 1.5, term ? (warn ? '#ff2a3c' : '#8a1424') : warn ? C.red : C.frame);
      if (term) p.rect(boxX + 3, boxY + 3, boxW - 6, 3, '#3a0a12');
      p.roundRect(boxX + 9, boxY + 9, 94, 28, term ? 2 : 7, term ? (warn ? '#7a0f1c' : '#3a0a12') : warn ? '#7a1f16' : '#3a2f22');
      text(term ? '> NEXT' : '다음 행동', boxX + 56, midY, 16, term ? '#ff6a78' : warn ? '#ffd0c4' : C.muted);
      const tx = boxX + 112 + (boxW - 120) / 2;
      if (warn) {
        const tw = p.textWidth(B(), tele, 22);
        const ix = tx - Math.min(tw, boxW - 170) / 2 - 20;
        p.poly([ix, midY - 10, ix + 11, midY + 9, ix - 11, midY + 9], '#ffb4a8');
        p.rect(ix - 1.5, midY - 4, 3, 7, '#4a1410');
        p.rect(ix - 1.5, midY + 4, 3, 3, '#4a1410');
      }
      text(tele, tx, midY, tele.length > 26 ? 18 : 22, term ? (warn ? '#ffd0d4' : '#ff8a96') : warn ? '#ffc4b8' : C.sub, { maxWidth: boxW - 170 });
      if (term) { const tw = Math.min(p.textWidth(B(), tele, 22), boxW - 170); p.rect(tx + tw / 2 + 8, midY - 9, 9, 18, '#ff2a3c'); }
    }

    const escPre = r.showingResult && last?.escaton && b.alat && (r.escStage ?? 0) === 0; // 에스카톤을 모으는 중: 카드는 아직 맞기 전 모습이어야 한다(쓰러짐·피해 숫자 숨김)
    const escSaved = escPre ? { hits: last.hits, hp: b.members.map(m => m.hp) } : null;
    if (escPre) { b.members.forEach(m => { m.hp += (last.hits?.[m.userId] || 0); }); last.hits = {}; }
    cards(b.members, (x, y, w, h, roleKey, mem) => {
      const role = ROLES[roleKey];
      if (!mem) {
        roleIcon(roleKey, x + w / 2, y + 72, true);
        text('-', x + w / 2, y + 138, NAME_SIZE, C.dim);
        if (!role.hideName) text(role.name, x + w / 2, y + 172, 20, '#8a6a3a');
        return;
      }
      const state = memberState(b, mem, r.showingResult);
      const down = state === 'down';
      // 리본: 결과 단계(턴 전환 3.5초)에는 띄우지 않는다 — 그림은 평소대로 두고 전환은 글자 제목이 알린다
      if (state !== 'result') {
        const ribbon = state === 'stunned' && isIced(b, mem) ? RIBBON.frozen : RIBBON[state];
        p.roundRect(x + 12, y + 12, w - 24, 30, 8, ribbon.fill);
        text(state === 'pending' ? '행동 선택!' : state === 'ready' ? `준비 · ${choiceLabel(mem)}` : state === 'stunned' ? `${mem.stunStatus?.name ?? '기절'} · 행동 불가` : '쓰러짐',
          x + w / 2, y + 27, 19, ribbon.color, { maxWidth: w - 36 });
      } else if (!down && ['freeze', 'stun'].includes(last?.effects?.[mem.userId])) {
        // 결과 화면: 이번 턴에 막 빙결·기절된 카드는 행동 선택 리본 자리에 "빙결!" / "기절!"(걸린 순간이 보이게, 사용자 요청)
        const iced = isIced(b, mem);
        const ribbon = iced ? RIBBON.frozen : RIBBON.stunned;
        p.roundRect(x + 12, y + 12, w - 24, 30, 8, ribbon.fill);
        text(`${mem.stunStatus?.name ?? (iced ? '빙결' : '기절')}!`, x + w / 2, y + 27, 19, ribbon.color, { maxWidth: w - 36 });
      }

      // 악취(구린 방귀): 맞은 순간은 진하게, 남아 있는 동안은 옅게 — 아이콘 뒤·앞에 나눠 그린다
      const stenchK = down ? 0 : (usedFx === 'fart' && last?.hits[mem.userId]) ? 1 : isStenched(b, mem) ? 0.7 : 0;
      if (stenchK) stenchBehind(roleKey, x + w / 2, y + 86, stenchK);
      roleIcon(roleKey, x + w / 2, y + 86, down);
      if (stenchK) stenchFront(x + w / 2, y + 86, stenchK);
      // 표식(영혼 사냥 예고 대상): 선택 화면에서 카드 오른쪽 위에 빛나는 눈
      if (!down && !r.showingResult && !isIntentHidden(b) && b.marks?.includes(mem.userId)) markEye(x + w - 36, y + 66);
      if (!down && isIced(b, mem)) iceCover(x + w / 2, y + 86); // 빙결: 아이콘이 얼음에 갇힘
      // 점액: 왼쪽 배지와 함께 아이콘 위 점액 얼룩도 그대로(사용자 요청). 이번 턴 맞은 카드는 타격 표시만.
      if (!down && slowTurnsLeft(b, mem) > 0 && !(usedMove && last?.hits[mem.userId])) { if (mem.slowStatus?.fx === 'water') wetIcon(x + w / 2, y + 86); else hitFx('sweep', x + w / 2, y + 86, fxColor); } // 젖음은 점액 덩어리 대신 물막과 흘러내리는 물방울
      const hit = last?.hits[mem.userId];
      if (hit && usedFx && !last?.escaton) hitFx(usedFx, x + w / 2, y + 86, fxColor, sporeColor, accentColor);
      if (hit && skillCtx) skillCtx.targets.push({ x, y, w, h });
      if (r.showingResult && last?.minionTargets?.[mem.userId]) drawPixels(BANANA, x + w / 2 + 40, y + 110, 6); // 부하의 바나나 투척에 맞음
      // 받은 피해 숫자도 그 턴의 결과 화면에서만(다음 턴 선택 화면에는 남기지 않는다)
      if (hit && r.showingResult) text(`-${hit}`, x + w - 38, y + 78, 24, '#ff5a45');
      // 독 피해(아군 행동 뒤)는 보라 숫자로 그 아래에
      const poisonHit = r.showingResult && last?.poison?.[mem.userId];
      if (poisonHit) text(`-${poisonHit}`, x + w - 38, y + 108, 22, mem.poisonStatus?.color ? '#ffb070' : '#d7a3ff'); // 화상은 주황
      // 상태 효과 아이콘(카드 왼쪽, 리본 아래): 점액(남은 턴) · 기절
      if (!down) statusBadges(b, mem, x + 32, y + 66);
      // 환각(최면) 상태는 점액처럼 카드 아이콘 위에 소용돌이로 보여 준다. 최면술에 막 맞은 결과 화면은 타격 표시(작은 최면 물결)만.
      if (!down && isConfused(b, mem) && !(usedFx === 'hypno' && hit)) confuseSwirl(x + w / 2 + 14, y + 98); // 아이콘 오른쪽 아래에 걸쳐 아이콘도 보이게
      // 기절(별): 환각과 같은 자리(아이콘 오른쪽 아래). 빙결은 얼음 덮개라 그리지 않는다.
      // 기절: 아이콘 머리 위를 도는 별(사용자 요청 — 아이콘 옆 별은 점액 얼룩과 겹쳤음)
      if (!down && isStunned(b, mem) && !isIced(b, mem)) stunOrbit(x + w / 2, y + 60);
      // 점액 상태는 아이콘 대신 카드 아이콘에 묻은 점액으로 보여준다. 이번 턴 결과 화면에서 맞은 카드는
      // 타격 표시(할퀸 자국·충격 별·흩뿌리기 얼룩)만 그려 겹치지 않게 하고, 다음 선택 화면부터 다시 점액을 보인다.

      text(mem.name, x + w / 2, y + 138, NAME_SIZE, down ? C.dim : C.text, { maxWidth: w - 20 });
      // HP는 바 안에 숫자로(한 줄 절약)
      const ratio = mem.hp / PLAYER_MAX_HP;
      bar(x + 16, y + 160, w - 32, 22, ratio, poisonStacks(b, mem) ? poisonHpColor(ratio, mem.poisonStatus?.color) : hpColor(ratio));
      // 숫자는 바 가운데 — 그 자리까지 색이 차 있으면 어두운 글씨, 비어 있으면 흰 글씨로 대비를 맞춘다
      text(String(mem.hp), x + w / 2, y + 171, 16, ratio > 0.55 ? '#14110d' : '#ffffff');

      // 지난 턴 행동: 글자만. 치명타면 수치를 밝게 하고 옆에 '치명타' 배지를 붙여 강조한다.
      const actData = last?.acts[mem.userId];
      const act = actLabel(actData);
      if (act && actData.crit) {
        const aw = Math.min(p.textWidth(B(), act, 19), w - 96);
        const bw = p.textWidth(B(), '치명타', 15) + 16, gap = 8;
        const left = x + w / 2 - (aw + gap + bw) / 2;
        text(act, left + aw / 2, y + 204, 19, '#ffe0a8', { maxWidth: w - 96 });
        p.roundRect(left + aw + gap, y + 192, bw, 24, 6, '#e8761c');
        text('치명타', left + aw + gap + bw / 2, y + 204, 15, '#2a1204');
      } else if (act) {
        text(act, x + w / 2, y + 204, 19, '#cbbd9f', { maxWidth: w - 24 });
      }

      // 스킬·회복약: 작은 표시(스킬 칩 + 회복약 동그라미 2개)
      const gx = x + w / 2 - 50;
      const ready = mem.cooldown === 0;
      p.roundRect(gx, y + 228, 60, 22, 11, ready ? C.teal : '#2f2a24');
      text(ready ? '스킬' : `${mem.cooldown}턴`, gx + 30, y + 239, 15, ready ? '#bff4ea' : C.muted);
      for (let k = 0; k < 2; k++) p.circle(gx + 80 + k * 18, y + 239, 6.5, k < mem.potions ? '#7ccf5a' : '#3a3328');
    }, (mem) => {
      const state = memberState(b, mem, r.showingResult);
      if (usedMove && !last?.escaton && last?.hits[mem.userId]) return { color: ALAT_MOVE_COLOR[usedFx] || '#ff4a3a', width: 4 }; // 이번 턴에 맞은 카드(알바트리온 기술은 그 속성색)
      if (state === 'pending') return { color: isCorrupt(m) ? '#ff3a4a' : isAlat(m) ? '#f0a050' : '#ffb52e', width: 4 }; // 오염 테마는 붉은 테두리, 알바트리온은 보랏빛
      if (state === 'ready') return { color: '#3ecf6e', width: 2.5 };
      if (state === 'stunned') return { color: '#ffd23f', width: 2.5 };
      return null;
    });
    if (escSaved) { b.members.forEach((m, i) => { m.hp = escSaved.hp[i]; }); last.hits = escSaved.hits; }
    // 속성 상성 강조(선택 화면): 지금 속성을 억제하는 직업의 카드가 속성 색으로 맥동하고 '효과적!' 칩이 붙는다 — 이번 턴 누가 억제 게이지를 올리는지 한눈에 보이게
    if (b.alat && !r.showingResult && !m.ui?.noCounterMark) {
      const counterRole = require('./알바트리온').COUNTER[b.alat.element], mem = counterRole && b.members.find(q => q.role === counterRole && q.hp > 0);
      if (mem) {
        const col = '#ff4fd0', x = 20 + activeRoles.indexOf(mem.role) * (CARD_W + CARD_GAP), cw = 124;
        p.strokeRoundRect(x - 2, CARD_Y - 2, CARD_W + 4, CARD_H + 4, 13, 1.5, col, 0.45); // 테두리는 얇게(선 한 겹)
        p.strokeRoundRect(x, CARD_Y, CARD_W, CARD_H, 12, 1.5, mixHex(col, '#ffffff', 0.35));
        const icx = x + CARD_W / 2, icy = CARD_Y + 74, mr = seedRng(b.turn * 17 + 5); // 직업 아이콘 뒤 속성 빛무리 + 위로 떠오르는 속성 빛 알갱이
        haze(icx, icy, 62, col, 0.07); haze(icx, icy, 40, col, 0.07);
        for (let q = 0; q < 9; q++) { const a = mr() * 6.28, rr = 30 + mr() * 38; dot(icx + Math.cos(a) * rr, icy + Math.sin(a) * rr * 0.8 - mr() * 14, 3 + Math.floor(mr() * 2), q % 3 ? col : '#ffffff'); }
        p.roundRect(x + CARD_W / 2 - cw / 2, CARD_Y - 12, cw, 24, 12, mixHex(col, '#000000', 0.35)); p.strokeRoundRect(x + CARD_W / 2 - cw / 2, CARD_Y - 12, cw, 24, 12, 1.5, mixHex(col, '#ffffff', 0.5));
        text('▲ 억제력 증가', x + CARD_W / 2, CARD_Y, 16, '#ffffff', { maxWidth: cw - 8 });
      }
    }
    // 영혼 사냥: 결과 화면에서 고스트와 맞은 카드를 잇는다(누구를 노렸는지 보이게)
    if (r.showingResult && usedFx === 'curse') {
      for (const uid of Object.keys(last.hits || {})) {
        const mem = b.members.find(q => q.userId === uid);
        if (!mem) continue;
        const i = activeRoles.indexOf(mem.role);
        curseLink(W / 2, monsterY, 20 + i * (CARD_W + CARD_GAP) + CARD_W / 2, CARD_Y + 86);
      }
    }
    if (r.showingResult && ALAT_FX.includes(usedFx)) alatOverlay(usedFx, W / 2, monsterY, alatTargets, 'hit');
    if (ambushStage >= 0) ambushFlash(ambushStage, W / 2, monsterY);
    if (r.showingResult && last?.escaton && b.alat) escFlash(Math.min(3, r.escStage ?? 0), W / 2, monsterY, false, escEl(last.escaton.element), b.members.map(mm => [20 + activeRoles.indexOf(mm.role) * (CARD_W + CARD_GAP) + CARD_W / 2, CARD_Y + 70]));
    if (r.showingResult && last?.escaton && b.alat && (r.escStage ?? 0) >= 1) escBanner(!!last.escaton.suppressed, escEl(last.escaton.element)); // 에스카톤 전용 스킬 띠(첫 장면은 타이틀 카드가 대신) // 에스카톤: 화면 전체 번쩍임과 다섯 속성 폭발(맨 위에 덮음) // 착지: 화면 전체 붉은 번쩍임과 폭발(맨 위에 덮음)
  }, r.battle?.monster ?? r.monster);
}

// ── 종료 화면 ──────────────────────────────────────────────────
// 게임 결과 화면처럼: 상단 큰 결과 제목 · 왼쪽 몬스터와 전투 기록 · 오른쪽 실제 참가자만 피해량 순 결과표.
// (예전엔 전투 화면 틀을 재활용해 카드 4장을 그렸는데, 참가자가 적으면 '빈자리'만 가득했다)
// outcome: 'clear' | 'wipe' | 'timeout' | 'noshow' | 'restart' | 'admin'
const END_TITLE = {
  clear: 'RAID CLEAR', wipe: 'RAID FAILED', timeout: 'RAID FAILED', noshow: 'RAID FAILED', restart: '레이드 중단', admin: '레이드 종료',
};
const END_SUB = {
  clear: (m) => `${m.name} 토벌 성공!`,
  wipe: (m) => `파티가 전멸하여 ${m.name}${subjectJosa(m.name)} 도망쳤다...`,
  timeout: (m) => `${m.name}${subjectJosa(m.name)} 도망쳤다...`,
  noshow: (m) => `${m.name}${subjectJosa(m.name)} 도망쳤다...`,
  restart: () => '봇 점검으로 레이드가 중단됐다',
  admin: () => '관리자가 레이드를 종료했다',
};
const END_TITLE_COLOR = { clear: '#ffcf5a', wipe: '#ff6b5b', timeout: '#ff6b5b', noshow: '#ff6b5b' };
const LP = { x: 20, y: 150, w: 300, h: 470 };   // 왼쪽 패널(몬스터·기록)
const RP = { x: 340, y: 150, w: 540, h: 470 };  // 오른쪽 패널(결과표)

function endBackground() {
  const cached = backgrounds.get('end-v2' + themeKey);
  if (cached) { cached.copy(painter.buf); return; }
  frame();
  for (const q of [LP, RP]) {
    p.roundRect(q.x, q.y, q.w, q.h, 14, C.box);
    p.strokeRoundRect(q.x, q.y, q.w, q.h, 14, 1.5, C.frame);
  }
  backgrounds.set('end-v2' + themeKey, Buffer.from(painter.buf));
}

function formatDuration(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec >= 60 ? `${Math.floor(sec / 60)}분 ${sec % 60}초` : `${sec}초`;
}

function statRow(label, value, y) {
  text(label, LP.x + 28, y, 20, C.muted, { align: 'left' });
  text(value, LP.x + LP.w - 28, y, 22, C.text, { align: 'right' });
  p.rect(LP.x + 24, y + 20, LP.w - 48, 1, '#2a2218');
}

function renderEnd(r, outcome, rewards = []) {
  return render('결과', () => {
    const clear = outcome === 'clear';
    const fled = outcome === 'wipe' || outcome === 'timeout' || outcome === 'noshow';
    const b = r.battle;
    endBackground();

    // 상단: 결과 제목(그림자) + 한 줄 설명
    const title = END_TITLE[outcome];
    const titleColor = END_TITLE_COLOR[outcome] || C.muted;
    if (isAlat(r.monster)) { // 알바트리온: 구성은 그대로, 글자는 새긴 금속 글자 + 뒤에 효과
      alatEndFx(clear);
      engraved(title, W / 2, 60, 58, titleColor);
      engraved(END_SUB[outcome](r.monster), W / 2, 114, 24, clear ? '#c8f4c0' : '#f4e8d8');
    } else {
      text(title, W / 2 + 3, 63, 58, '#000000');
      text(title, W / 2, 60, 58, titleColor);
      text(END_SUB[outcome](r.monster), W / 2, 114, 24, clear ? C.ok : C.sub);
    }

    // 왼쪽: 몬스터 + 전투 기록
    const mcx = LP.x + LP.w / 2;
    const ms = 116, hw = ms / 2;
    drawMonster(r.monster, mcx, 262, ms, { gray: clear });
    if (clear) {
      p.line(mcx - hw, 262 - hw * 0.83, mcx + hw, 262 + hw * 0.83, 8, C.red);
      p.line(mcx + hw, 262 - hw * 0.83, mcx - hw, 262 + hw * 0.83, 8, C.red);
    } else if (fled) {
      p.roundRect(mcx - 34, 172, 68, 28, 8, '#5c1410');
      text('도주', mcx, 186, 17, '#ffb4a8');
    }
    if (isCorrupt(r.monster)) glitchText(r.monster.name, mcx, 362, 28, C.gold, { seed: 5, off: 3, strips: 4, shift: 6, holes: 3, tint: true, maxWidth: LP.w - 30 });
    else text(r.monster.name, mcx, 362, 28, C.gold, { maxWidth: LP.w - 30 });
    if (b) {
      statRow('턴', `${b.turn}턴`, 420);
      statRow('걸린 시간', r.battleStartedAt ? formatDuration((r.endedAt || Date.now()) - r.battleStartedAt) : '-', 470);
      statRow('남은 HP', `${Math.min(100, Math.round((b.hp / b.maxHp) * 100))}%`, 520);
    } else {
      statRow('참가자', `${(r.party || []).length}명`, 420);
    }

    // 오른쪽: 결과표(피해 많은 순, 실제 참가자만)
    text('파티 결과', RP.x + 26, RP.y + 34, 24, C.gold, { align: 'left' });
    // 방어: 방어·도발로 줄인 피해 — 피해·회복만으로는 안 보이는 수호자·방어의 몫을 보여준다
    // 칸 간격 70씩 같게. 보상 알약(폭 68) 오른쪽 끝이 카드 테두리에서 14 떨어지게(왼쪽 역할 아이콘 여백과 비슷하게).
    const COL = { dmg: RP.x + 268, heal: RP.x + 338, block: RP.x + 408, reward: RP.x + 478 };
    text('피해', COL.dmg, RP.y + 34, 17, C.muted);
    text('회복', COL.heal, RP.y + 34, 17, C.muted);
    text('방어', COL.block, RP.y + 34, 17, C.muted);
    text('보상', COL.reward, RP.y + 34, 17, C.muted);
    const members = (b ? [...b.members] : []).sort((q1, q2) => q2.damage - q1.damage);
    if (!members.length) {
      text('참가자가 없었다', RP.x + RP.w / 2, RP.y + RP.h / 2, 24, C.dim);
      return;
    }
    members.forEach((mem, i) => {
      const y = RP.y + 64 + i * 98;
      const reward = rewards.find(q => q.userId === mem.userId);
      const mvp = !!reward?.mvp;
      const wall = mvp && !!reward.gateway; // 블랙월 게이트웨이를 받은 MVP: 줄이 블랙월에 잠식된 모습(붉은 바탕·어긋난 테두리·찢긴 띠)
      p.roundRect(RP.x + 14, y, RP.w - 28, 86, 12, wall ? '#3e0c16' : mvp ? '#2c2210' : '#1d1711');
      if (wall) {
        const rnd = seeded(y * 31 + 7), rx = RP.x + 14, rw2 = RP.w - 28;
        p.strokeRoundRect(rx - 4, y + 3, rw2, 86, 12, 3, '#b81c2a'); p.strokeRoundRect(rx + 3, y - 2, rw2, 86, 12, 2, '#5a0f1a'); // 어긋난 뒷 테두리
        for (let sy = y + 6; sy < y + 82; sy += 4) p.rect(rx + 4, sy, rw2 - 8, 1, '#340810'); // 모니터 주사선
        // 침식 게이지(위 왼쪽): 10칸 중 마지막 칸만 남기고 붉게 잠식됨
        for (let g = 0; g < 10; g++) p.rect(rx + 16 + g * 7, y + 6, 5, 4, g < 9 ? (g < 6 ? '#b81c2a' : '#ff3a4a') : '#3a0c14');
        // 경고 빗금 띠(아래 양옆, 안내 문구 양쪽): 기울어진 붉은 줄무늬
        for (const hx of [rx + 16, rx + rw2 - 100]) for (let h = 0; h < 7; h++) p.poly([hx + h * 12 + 4, y + 74, hx + h * 12 + 9, y + 74, hx + h * 12 + 5, y + 81, hx + h * 12, y + 81], h % 2 ? '#b81c2a' : '#6a1020');
        p.rect(rx + 1, y + 24, 3, 38, '#ff3a4a'); p.rect(rx + rw2 - 4, y + 24, 3, 38, '#ff3a4a'); // 양옆 신호 막대
        text('ERR 0xB1ACK', COL.dmg + 35, y + 11, 9, '#8a2030'); // 어두운 오류 코드
        // 가로로 찢긴 붉은 띠: 글자·숫자 뒤를 피해 위·아래 여백 띠에만, 아래 줄은 안내 문구 양옆에만(읽기 쉽게)
        const band = (by, bx0, bx1, n) => { for (let k = 0; k < n; k++) {
          const gw = 24 + Math.floor(rnd() * 90), gx = bx0 + Math.floor(rnd() * Math.max(1, bx1 - bx0 - gw));
          p.rect(gx, by + Math.floor(rnd() * 4), gw, 2 + Math.floor(rnd() * 2), rnd() < 0.5 ? '#6a1020' : '#b81c2a');
        } };
        // 오염이 번지는 흔적: 블랙월 이모지(오른쪽)에서 왼쪽으로 퍼질수록 성긴 사각 조각. 글자·숫자 뒤엔 어두운 색만 깔아 읽히게 둔다.
        for (let k = 0; k < 70; k++) {
          const t = Math.pow(rnd(), 1.8), sz = 3 + Math.floor(rnd() * 4);
          const px = rx + rw2 - 10 - t * (rw2 * 0.78), py = y + 4 + rnd() * 74;
          const safe = px > COL.block + 28 || py < y + 15 || py > y + 69; // 글자·숫자 줄 밖이면 밝은 색도 가능
          p.rect(Math.round(px), Math.round(py), sz, sz, safe && rnd() < 0.45 ? (rnd() < 0.3 ? '#ff3a4a' : '#b81c2a') : '#5a0f1a');
        }
        band(y + 5, rx + 14, rx + rw2 - 14, 5);
        p.strokeRoundRect(rx, y, rw2, 86, 12, 2, '#ff3a4a');
        text('▓ BLACKWALL GATEWAY — ACCESS GRANTED ▓', rx + rw2 / 2, y + 78, 11, '#ff6a78');
      } else if (mvp) p.strokeRoundRect(RP.x + 14, y, RP.w - 28, 86, 12, 2, C.gold);
      drawPixels(ROLE_SPRITES[mem.role], RP.x + 52, y + 43, iconPx(ROLE_SPRITES[mem.role], 2.7), { dim: mem.hp <= 0 && !clear });
      const nameX = RP.x + 86;
      const dy = wall ? -5 : 0; // 블랙월 줄은 아래 안내 문구 자리를 위해 이름·역할 줄을 살짝 올린다
      if (wall) { // 이름도 블랙월에 오염돼 청록·붉은 색이 어긋나고 띠가 밀린다
        const nw = Math.min(132, p.textWidth(B(), mem.name, 26));
        glitchText(mem.name, nameX + nw / 2, y + 32 + dy, 26, C.text, { seed: 11, off: 3, strips: 4, shift: 6, holes: 3, tint: true, maxWidth: 132 });
      } else text(mem.name, nameX, y + 32, 26, C.text, { align: 'left', maxWidth: 132 });
      // MVP 배지는 역할 줄 옆에(이름 줄에 두면 긴 이름일 때 피해 숫자와 겹친다)
      const roleName = ROLES[mem.role].hideName ? '' : ROLES[mem.role].name;
      if (roleName) text(roleName, nameX, y + 62 + dy, 18, C.orange, { align: 'left' });
      if (mvp) {
        const rw = p.textWidth(B(), roleName, 18);
        p.roundRect(nameX + rw + 8, y + 51 + dy, 46, 22, 6, wall ? '#ff3a4a' : '#e2b14a');
        text('MVP', nameX + rw + 31, y + 62 + dy, 14, wall ? '#2a0408' : '#2a1a04');
      }
      text(mem.damage.toLocaleString(), COL.dmg, y + 43, 22, C.text);
      text(mem.healing ? mem.healing.toLocaleString() : '-', COL.heal, y + 43, 22, mem.healing ? '#8fe0a8' : C.dim);
      text(mem.blocked ? mem.blocked.toLocaleString() : '-', COL.block, y + 43, 22, mem.blocked ? '#9cc8ff' : C.dim);
      if (wall) { // 블랙월 게이트웨이 이모지: 배선 없이, 이모지 자체가 오염돼 잔상이 어긋나고 가로 띠가 밀리며 조각이 흩어진다
        const gx = COL.reward, gy = y + 43, k = RENDER_SCALE, r2 = seeded(y * 17 + 3);
        drawEmojiFile(p, 'blackwall.png', gx - 5, gy + 1, 58); // 어긋난 붉은 잔상
        drawEmojiFile(p, 'blackwall.png', gx + 4, gy - 1, 52);
        drawEmojiFile(p, 'blackwall.png', gx, gy, 58);
        const bx0 = Math.max(0, Math.round((gx - 36) * k)), bx1 = Math.min(p.w, Math.round((gx + 36) * k));
        for (let n = 0; n < 4; n++) { // 가로 띠 밀림(이모지 영역만)
          const sy = Math.round((gy - 28 + r2() * 52) * k), sh = Math.round((2 + r2() * 4) * k), dx = Math.round((r2() < 0.5 ? -1 : 1) * (4 + r2() * 8) * k);
          for (let yy = sy; yy < sy + sh && yy < p.h; yy++) {
            const st = (yy * p.w + bx0) * 3, len = (bx1 - bx0) * 3, row = Buffer.from(p.buf.subarray(st, st + len));
            const a = Math.abs(dx) * 3;
            if (a >= len) continue;
            if (dx > 0) row.copy(p.buf, st + a, 0, len - a); else row.copy(p.buf, st, a, len);
          }
        }
        for (let n = 0; n < 14; n++) { // 떨어져 나간 조각
          const ang = r2() * Math.PI * 2, d = 26 + r2() * 14, sz = 2 + Math.floor(r2() * 3);
          p.rect(Math.round(gx + Math.cos(ang) * d), Math.round(gy + Math.sin(ang) * d * 0.9), sz, sz, r2() < 0.5 ? '#ff3a4a' : '#7a0c18');
        }
      }
      else if (reward) pill(COL.reward - 34, y + 27, 68, 32, reward.xp > 0 ? `+${reward.xp}` : (reward.gateway ? '아이템' : '+0'), reward.xp > 0 ? 20 : 17, mvp ? '#6b4e12' : '#1f4a2c', mvp ? '#ffe39a' : '#bff0cf');
      else text('-', COL.reward, y + 43, 22, C.dim);
    });
  }, r.monster);
}

// ── 미리 데우기 ────────────────────────────────────────────────
// 서버(CPU 25%)에서 첫 그림이 1.7초, 이벤트 루프 지연이 2.9초까지 났다 — 폰트 로드, 글자 모양 읽기,
// JIT 준비가 첫 레이드 순간 한꺼번에 몰려서다. 봇이 켜진 뒤 한가할 때 그 일을 잘게 나눠(setImmediate로
// 한 조각씩) 미리 해 두어, 레이드 중에도 다른 기능(내전/모집·임시 통화방)을 오래 막지 않게 한다.
// 반복되는 라벨(역할·스킬·몬스터 대사 등)은 글자 모양 캐시에 들어가 이후 그림에서 바로 재사용된다.
function warmUpLabels(monsters) {
  const jobs = [];
  // 장면별 고정 배경도 미리 만들어 둔다(첫 그림에서 큰 도형을 칠하는 비용이 가장 컸다).
  for (const [key, y, h] of [['recruit', 102, 240], ['battle', 120, 224]]) {
    jobs.push(() => { p = painter; background(key, y, h); });
  }
  jobs.push(() => { p = painter; endBackground(); });
  const add = (font, s, size) => jobs.push(() => painter.warmText(fonts[font], s, size));
  add('bold', '몬스터 출현!', 46);
  add('bold', '다음 행동', 16);
  add('bold', '치명타', 15);
  add('bold', '분노', 22);
  add('bold', '보상 없음', 20);
  for (const v of ['참가 완료', '참가 대기']) add('bold', v, 22);
  add('bold', '행동 선택!', 19);
  add('bold', '쓰러짐', 19);
  for (let t = 1; t <= 30; t++) add('bold', `TURN ${t}`, 24);
  for (const v of ['스킬', '1턴', '2턴', '3턴']) add('bold', v, 15);
  for (const a of ['공격', '방어', '회복약']) add('bold', `준비 · ${a}`, 19);
  for (const k of ROLE_ORDER) {
    add('bold', `준비 · ${ROLES[k].skill.name}`, 19);
    add('bold', ROLES[k].name, 22);
    add('bold', ROLES[k].name, 20);
    add('bold', ROLES[k].skill.name, 20);
  }
  add('bold', '-', NAME_SIZE);
  for (const t of new Set(Object.values(END_TITLE))) add('bold', t, 58);
  for (const v of ['파티 결과', '피해', '회복', '방어', '보상', '턴', '걸린 시간', '남은 HP', '도주']) add('bold', v, v === '파티 결과' ? 24 : 17);
  add('bold', 'MVP', 14);
  for (const m of monsters) {
    add('bold', m.name, 38);
    add('bold', m.rageName, 38);
    for (const move of Object.values(m.moves)) { add('bold', move.telegraph, 22); add('bold', `${move.name}!`, 22); }
    add('bold', '💨 연막 때문에 다음 행동이 보이지 않는다...', 22);
  }
  // 마지막으로 장면마다 한 장씩 실제로 그려 본다. 배경·글자 모양만 데워 두니 서버에서 첫 모집 그림이 여전히
  // 그리기 412ms + 압축 298ms(이벤트 루프 지연 826ms)였다 — 글자·픽셀 붙이기와 PNG 만들기 반복문이 처음 돌 때
  // 느린 탓이라, 봇이 한가한 시작 직후에 한 번씩 돌려 둔다. 결과 그림은 버리고 콘솔 기록도 남기지 않는다.
  for (const scene of sampleScenes(monsters[0])) jobs.push(() => { warming = true; try { scene(); } finally { warming = false; } });
  const alatM = monsters.find(mm => mm.alat); // 에스카톤 방출·식음·여운은 처음 계산이 1초 넘게 걸려, 전투 중에 처음 나오면 다음 단계가 밀리므로 시작할 때 미리 계산해 둔다(저장된 칸 목록으로 이후엔 빠르다)
  if (alatM) for (const st of [1, 2, 3]) jobs.push(() => { warming = true; try { escWarmScene(alatM, st); } finally { warming = false; } });
  return jobs;
}

// 에스카톤 결과 장면 하나(단계 st)를 가짜 전투로 그린다 — 미리 데우기 전용
function escWarmScene(monster, st) {
  const party = ROLE_ORDER.map((role, i) => ({ userId: `warm${i}`, name: ['아케이드', '레이드원', 'Player', '테스트'][i], role }));
  const battle = createBattle(monster, party);
  if (!battle.alat) return;
  battle.intent = 'smash'; battle.alat.cycleTurn = battle.alat.cycleLen;
  party.forEach(q => choose(battle, q.userId, 'attack'));
  resolveTurn(battle);
  renderBattle({ monster, party, battle, battleStartedAt: Date.now() - 180000, endedAt: Date.now(), showingResult: true, escStage: st });
}

// 미리 그려 볼 가짜 레이드(4인 파티, 한 턴 진행)
function sampleScenes(monster) {
  const party = ROLE_ORDER.map((role, i) => ({ userId: `warm${i}`, name: ['아케이드', '레이드원', 'Player', '테스트'][i], role }));
  const battle = createBattle(monster, party);
  const r = { monster, party, battle, battleStartedAt: Date.now() - 180000, endedAt: Date.now(), showingResult: false };
  return [
    () => renderRecruit({ monster, party: party.slice(0, 2) }),
    () => {
      ['attack', 'skill', 'guard', 'potion'].forEach((action, i) => choose(battle, party[i].userId, action));
      resolveTurn(battle);
      r.showingResult = true;
      renderBattle(r);
    },
    () => { r.showingResult = false; renderBattle(r); },
    () => renderEnd(r, 'clear', party.map((m, i) => ({ userId: m.userId, xp: 300, mvp: i === 0 }))),
  ];
}

function warmUp(monsters) {
  if (!load()) return;
  const startedAt = Date.now();
  const jobs = warmUpLabels(monsters);
  const step = () => {
    const job = jobs.shift();
    if (!job) {
      console.warn(`🎨 레이드 그림 미리 데우기 완료 — ${Date.now() - startedAt}ms(잘게 나눠 실행) · RSS ${rssMb()}MB`);
      return;
    }
    try { job(); } catch (err) { console.error('레이드 그림 미리 데우기 실패:', err); return; }
    setImmediate(step);
  };
  setImmediate(step);
}

module.exports = { renderRecruit, renderBattle, renderEnd, warmUp };

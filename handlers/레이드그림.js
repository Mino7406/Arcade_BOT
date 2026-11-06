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
const { Painter, loadFont } = require('./그림판');
const { ROLES, ROLE_ORDER, PLAYER_MAX_HP, ACTIONS, createBattle, choose, resolveTurn, isStunned, slowTurnsLeft, isShielded, poisonStacks, isConfused, moveFx } = require('./레이드전투');

const W = 900; // 설계 크기(좌표는 전부 이 기준)
const H = 640;
const RENDER_SCALE = 0.75; // 실제 그림은 675×480 — 디스코드가 어차피 채팅 폭으로 줄여 보여줘 글자 크기는 같고 픽셀은 44% 준다
const C = {
  bg: '#17120e', frame: '#8a6a2c', gold: '#e2b14a', box: '#0c0a08', card: '#2a2119', cardEmpty: '#4a3d2a',
  teal: '#1d4c56', tealText: '#e6f4f6', orange: '#f5ab2e', text: '#ffffff', sub: '#eee6d8', dim: '#7d7466',
  muted: '#a59b8a', ok: '#7ee0a6', red: '#ff4a3a', hpBack: '#3a2f25',
};

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
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
function bar(x, y, w, h, ratio, color) {
  p.roundRect(x, y, w, h, h / 2, C.hpBack);
  const fw = Math.max(0, Math.min(1, ratio)) * w;
  if (fw > 0) p.roundRect(x, y, Math.max(fw, h), h, h / 2, color);
}
const hpColor = (ratio) => (ratio > 0.5 ? '#3ecf6e' : ratio > 0.25 ? '#f0b232' : '#f04b3a');
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
  return `#${g}${g}${g}`;
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
const ROLE_ICON_PX = 3.4; // 16칸 × 3.4 ≈ 54px
function roleIcon(role, cx, cy, dim = false) {
  drawPixels(ROLE_SPRITES[role], cx, cy, ROLE_ICON_PX, { dim });
}

// 몬스터: sprite(픽셀 아트). maxH 안에 맞춘다. gray: 결과 화면용 흑백.
// (그림 파일 몬스터는 PNG 해석기가 필요해 아직 지원하지 않는다 — 넣을 때 그림판.js에 추가)
// pose: 기술 키(sprite.poses) — 없으면 평상시 얼굴(분노면 sprite.rageRows).
// outline: 외곽선(a) 색을 바꿔 칠한다(보호막으로 단단해진 몸).
function drawMonster(monster, cx, cy, maxH, { rage = false, gray = false, pose = null, outline = null } = {}) {
  const sp = monster.sprite;
  if (!sp) return;
  const rows = (pose && sp.poses?.[pose]) || (rage && sp.rageRows) || sp.rows;
  const colors = rage || outline ? { ...(rage ? sp.rageColors : {}), ...(outline ? { a: outline } : {}) } : null;
  // sprite.scale: 몬스터마다 그림 크기 배율(기본 1). 칸 수가 많아 작아 보이는 몬스터를 키울 때 쓴다.
  drawPixels({ ...sp, rows }, cx, cy, Math.floor((maxH * (sp.scale ?? 1)) / rows.length), { dim: gray, colors });
}

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
};
// 카드 왼쪽 위 상태 아이콘: 기절(별). 점액는 아이콘 없이 점액 얼룩으로 표시한다.
// 카드 왼쪽 상태 배지: 기절(별) · 독(거품). 환각은 배지 대신 아이콘 양옆 작은 최면 물결(카드 그리는 곳에서).
function statusBadges(b, mem, x, y) {
  if (isStunned(b, mem)) stunStars(x, y);
  const stacks = poisonStacks(b, mem);
  if (stacks) poisonBadge(x, y + 34, stacks);
}
// 독: 보라 거품 세 개 + 아래에 중첩 수(2 이상일 때)
function poisonBadge(cx, cy, stacks) {
  p.circle(cx - 5, cy + 3, 9, '#9b3fc0');
  p.circle(cx + 7, cy - 4, 7, '#b45fe0');
  p.circle(cx + 4, cy + 9, 5, '#c98af0');
  p.circle(cx - 8, cy, 3, '#f1cdfb');
  if (stacks > 1) text(`×${stacks}`, cx, cy + 22, 15, '#e2b8ff');
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
function monsterFx(move, cx, cy, color, layer, spore = color, accent = spore) {
  if (!move) return;
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
    // 위에서 아래로 내리꽂는 속도선
    for (const [dx, len] of [[-70, 30], [-40, 44], [40, 44], [70, 30]]) p.line(cx + dx, cy - 78, cx + dx, cy - 78 + len, 4, '#f4e6cf');
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
  } else if (move === 'smash' && layer === 'front') {
    // 바닥 충격파 + 흙먼지
    for (const s of [-1, 1]) {
      p.line(cx + s * 86, cy + 48, cx + s * 170, cy + 40, 5, '#ffd166');
      p.line(cx + s * 92, cy + 58, cx + s * 200, cy + 60, 5, '#ffd166');
      p.circle(cx + s * 120, cy + 64, 8, '#8a7a62');
      p.circle(cx + s * 150, cy + 56, 6, '#8a7a62');
    }
  }
}
// 맞은 파티원 카드 아이콘 위 타격 표시: 박치기는 할퀸 자국, 흩뿌리기는 점액 얼룩, 짓누르기는 충격 별.
function hitFx(move, cx, cy, color, spore = color, accent = spore) {
  if (move === 'spore') {
    p.circle(cx - 18, cy - 12, 9, spore); p.circle(cx + 20, cy + 6, 8, spore); p.circle(cx + 2, cy + 22, 6, color); p.circle(cx + 14, cy - 22, 5, color);
  } else if (move === 'hypno') {
    // 몬스터 옆 최면 물결을 줄인 것 — 아이콘 양옆으로 퍼지는 도트 호 세 겹 + 반짝임
    hypnoWaves(cx, cy, 0.27, color, 2);
    sparkle(cx - 26, cy - 30, 3, '#e8fffb');
    sparkle(cx + 26, cy + 30, 3, '#e8fffb');
  } else if (move === 'burst') {
    // 아이콘 네 귀퉁이로 터진 포자 구름(가운데 아이콘은 보이게)
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([i, j], k) => puff(cx + i * 30, cy + j * 26, 5, k % 2 ? accent : spore, '#f1cdfb'));
  } else if (move === 'attack') {
    for (const d of [-14, 0, 14]) p.line(cx - 26 + d, cy - 26, cx + 14 + d, cy + 26, 5, '#ff4a3a');
  } else if (move === 'sweep') {
    p.circle(cx - 18, cy - 12, 10, color); p.circle(cx + 20, cy + 8, 8, color); p.circle(cx + 4, cy + 22, 6, color);
  } else if (move === 'smash') {
    p.poly([cx, cy - 34, cx + 9, cy - 9, cx + 34, cy, cx + 9, cy + 9, cx, cy + 34, cx - 9, cy + 9, cx - 34, cy, cx - 9, cy - 9], '#ffd166');
  }
}

function frame() {
  p.clear(C.bg);
  p.strokeRoundRect(5, 5, W - 10, H - 10, 16, 2, C.frame);
}
function monsterBox(y, h) {
  p.roundRect(20, y, W - 40, h, 14, C.box);
  p.strokeRoundRect(20, y, W - 40, h, 14, 1.5, C.frame);
}

// 카드 4장(역할 순서 고정). drawCard(x, y, w, h, roleKey, member)로 안쪽을 채운다.
const CARD_Y = 362, CARD_H = 260, CARD_W = 203, CARD_GAP = 16;
const NAME_SIZE = 28;
// 카드 배경과 빈자리 테두리는 배경 캐시(background)에 이미 있다. 참가자 카드만 테두리를 덧그린다.
// border(m) → { color, width } | null 로 장면마다 테두리를 정할 수 있다(기본: 금색 2px).
function cards(members, drawCard, border = () => ({ color: C.gold, width: 2 })) {
  ROLE_ORDER.forEach((roleKey, i) => {
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
async function render(scene, draw) {
  if (!load()) return null;
  p = painter;
  try {
    const t0 = process.hrtime.bigint();
    draw();
    const t1 = process.hrtime.bigint();
    const png = painter.png();
    logRender(scene, Number(t1 - t0) / 1e6, Number(process.hrtime.bigint() - t1) / 1e6, png.length);
    return png;
  } catch (err) {
    console.error(`레이드 ${scene} 그림 실패:`, err);
    return null;
  }
}

// ── 장면별 그림 ────────────────────────────────────────────────
function renderRecruit(r) {
  return render('모집', () => {
    background('recruit', 102, 240);
    const title = '몬스터 출현!';
    const tw = p.textWidth(B(), title, 46);
    text(title, W / 2, 47, 46, C.gold);
    titleIcon(W / 2 - tw / 2 - 46, 47); titleIcon(W / 2 + tw / 2 + 46, 47);
    text(`${r.monster.name}${subjectJosa(r.monster.name)} XP 시스템을 망가뜨렸어요!`, W / 2, 84, 21, '#ff8f7a', { maxWidth: W - 120 });
    drawMonster(r.monster, W / 2, 206, 112);
    text(r.monster.name, W / 2, 298, 38, C.gold);
    cards(r.party, (x, y, w, h, roleKey, m) => {
      const role = ROLES[roleKey];
      roleIcon(roleKey, x + w / 2, y + 50, !m);
      // 이름 크기는 모집·전투·결과 모두 NAME_SIZE로 같게 — 모집 때 만든 글자 모양을 전투·결과에서 그대로 재사용한다
      // (크기가 다르면 서버에서 전투 시작 그림이 이름을 다시 그리느라 170ms 걸렸다).
      text(m ? m.name : '-', x + w / 2, y + 116, NAME_SIZE, m ? C.text : C.dim, { maxWidth: w - 20 });
      text(role.name, x + w / 2, y + 152, 22, m ? C.orange : '#8a6a3a');
      pill(x + 14, y + 176, w - 28, 34, role.skill.name, 20);
      text(m ? '참가 완료' : '참가 대기', x + w / 2, y + 234, 22, m ? C.ok : C.muted);
    });
  });
}

// 카드 상태: 아직 고르지 않음(주황 리본·굵은 금테) / 고름(초록 리본·초록테, 고른 행동 표시) / 쓰러짐(회색).
// 동시에 고르는 방식이라 "내 차례 = 아직 안 고름"이 한눈에 보이게 리본을 크게 띄운다.
const RIBBON = {
  pending: { fill: '#c4630f', color: '#ffffff' },
  ready:   { fill: '#1e6b3c', color: '#d9ffe6' },
  down:    { fill: '#3a3530', color: '#b0a89a' },
  stunned: { fill: '#6b5a14', color: '#fff3b0' },
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

function renderBattle(r) {
  return render('전투', () => {
    const b = r.battle;
    const m = b.monster;
    const last = b.lastTurn;
    background('battle', 120, 224);
    if (b.rage) rageFx(m, W / 2, 196, 112, null, 'box'); // 분노: 바닥 불빛·불씨

    // 상단: TURN 배지 · 몬스터 이름(분노) · HP 바
    p.roundRect(30, 20, 118, 42, 10, '#2a2119');
    p.strokeRoundRect(30, 20, 118, 42, 10, 1.5, C.gold);
    text(`TURN ${b.turn}`, 89, 41, 24, C.gold);
    // 몬스터 이름은 정확히 가운데. 왼쪽 TURN 배지와 겹치지 않게 최대 폭을 둔다(분노 표시는 이름 오른쪽).
    const name = b.rage ? m.rageName : m.name;
    const NAME_MAX = 420;
    const nw = Math.min(p.textWidth(B(), name, 36), NAME_MAX);
    text(name, W / 2, 41, 36, b.rage ? C.red : C.gold, { maxWidth: NAME_MAX });
    if (b.rage) {
      p.roundRect(W / 2 + nw / 2 + 12, 24, 64, 34, 8, '#5c1410');
      text('분노', W / 2 + nw / 2 + 44, 41, 22, '#ffb4a8');
    }
    bar(50, 74, W - 100, 32, b.hp / b.maxHp, b.rage ? '#e5383b' : '#d94a2b');
    p.strokeRoundRect(50, 74, W - 100, 32, 16, 2, C.gold);
    text(`${b.hp.toLocaleString()} / ${b.maxHp.toLocaleString()}`, W / 2, 90, 22, '#ffffff');

    // 몬스터 + 지난 턴 결과: 게임처럼 몬스터가 쓴 기술을 머리 왼쪽 위 말풍선으로 띄운다
    // (파티가 입힌 총피해 숫자는 일단 빼 둠 — 카드마다 행동 수치가 있어 중복이라)
    // 자세: 턴 결과 화면이면 방금 쓴 기술, 큰 한 방 직전 선택 화면이면 부푼 모습(charge), 아니면 평상시
    const usedMove = r.showingResult ? last?.monsterMoveKey : null;
    // 연출 종류(기술의 fx — 예전 저장 기록엔 없을 수 있어 기술 데이터에서 다시 구함)
    const usedFx = usedMove ? (last.monsterFx || moveFx(usedMove, m.moves[usedMove])) : null;
    const pose = usedMove || (b.intent === 'smash' ? m.moves.smash?.readyPose : null);
    const fxColor = (b.rage && m.sprite?.rageColors?.o) || m.sprite?.palette?.o || '#7fdc8c';
    const sporeColor = (b.rage && m.sprite?.rageColors?.x) || m.sprite?.palette?.x || fxColor; // 포자 연출 색
    const accentColor = (b.rage && m.sprite?.rageColors?.p) || m.sprite?.palette?.p || sporeColor; // 반점 색(독기·파편)
    // 박치기·짓누르기는 파티 쪽(아래)으로 몸을 내밀어 그린다
    const monsterY = 196 + (usedFx === 'attack' ? 10 : usedFx === 'smash' || usedFx === 'burst' ? 6 : 0);
    // 보호막(단단해지기 다음 턴): 외곽선을 금속빛으로 바꾸고 둘레에 반짝임 + HP 바 왼쪽에 방패 배지
    const shielded = isShielded(b);
    if (shielded) {
      for (const [dx, dy] of [[-88, -40], [92, -30], [-96, 26], [100, 34], [0, -66]]) {
        p.line(W / 2 + dx - 7, monsterY + dy, W / 2 + dx + 7, monsterY + dy, 3, '#cfe8ff');
        p.line(W / 2 + dx, monsterY + dy - 7, W / 2 + dx, monsterY + dy + 7, 3, '#cfe8ff');
      }
    }
    if (b.rage) rageFx(m, W / 2, monsterY, 112, pose, 'aura');
    monsterFx(usedFx, W / 2, monsterY, fxColor, 'back', sporeColor, accentColor);
    drawMonster(m, W / 2, monsterY, 112, { rage: b.rage, pose, outline: shielded ? '#cfe8ff' : null });
    if (b.rage) rageFx(m, W / 2, monsterY, 112, pose, 'mark');
    monsterFx(usedFx, W / 2, monsterY, fxColor, 'front', sporeColor, accentColor);
    // 몬스터 오른쪽: 이번 턴 받은 피해(빨강) · 재생 회복량(초록, 피해 아래). 결과 화면에서만.
    const dealtNow = r.showingResult ? last?.monsterDamage : 0;
    // 점액 줄기(오른쪽 끝 약 W/2+190)와 오른쪽 위 '방어력 증가' 배지(y 186까지)를 피해 그 오른쪽 아래에,
    // 어두운 바탕을 깔아 연출 위에서도 읽히게 한다.
    const numbers = [];
    if (dealtNow) numbers.push([`-${dealtNow.toLocaleString()}`, '#ff5a45']);
    if (usedMove && last?.monsterHeal) numbers.push([`+${last.monsterHeal.toLocaleString()}`, '#7cff9a']);
    numbers.forEach(([label, color], i) => {
      const nx = W / 2 + 250, ny = 212 + i * 38;
      p.roundRect(nx - 56, ny - 17, 112, 34, 9, '#100c09');
      text(label, nx, ny, 28, color);
    });
    // 몬스터 상자 오른쪽 위에 큰 방패 배지 + 문구(방어력 증가 · 받는 피해 -N%, 보호막 기술의 effectRate)
    if (shielded) {
      p.roundRect(W - 216, 132, 180, 54, 12, '#1c2a38');
      p.strokeRoundRect(W - 216, 132, 180, 54, 12, 2, '#8fc4ff');
      drawPixels(STATUS_ICONS.shield, W - 186, 159, 3.4);
      text('방어력 증가', W - 108, 149, 19, '#cfe8ff');
      text(`피해 -${Math.round((1 - (b.shieldRate ?? 0.5)) * 100)}%`, W - 108, 172, 15, '#8fc4ff');
    }
    // 몬스터 기술 말풍선은 그 기술을 쓴 턴의 결과 화면에서만(다음 턴 선택 화면에는 남기지 않는다)
    if (r.showingResult && last?.monsterMove) {
      const label = `${last.monsterMove}!`;
      const bw = Math.min(p.textWidth(B(), label, 22), 200) + 36;
      const bx = W / 2 - 92 - bw, by = 132;
      p.roundRect(bx, by, bw, 44, 14, '#f4e6cf');
      p.poly([bx + bw - 26, by + 40, bx + bw - 6, by + 40, bx + bw + 12, by + 58], '#f4e6cf'); // 말꼬리 → 몬스터
      text(label, bx + bw / 2, by + 22, 22, '#3a1a12', { maxWidth: 200 });
    }

    // 다음 행동 예고 상자 — 왼쪽에 '다음 행동' 칩, 큰 공격(방어해야 할 때)은 빨간 상자 + 경고 삼각형
    const move = m.moves[b.intent];
    const warn = b.intent === 'smash';
    const boxW = 540, boxH = 46, boxX = (W - boxW) / 2, boxY = 276;
    const midY = boxY + boxH / 2;
    p.roundRect(boxX, boxY, boxW, boxH, 11, warn ? '#4a1410' : '#201810');
    p.strokeRoundRect(boxX, boxY, boxW, boxH, 11, 1.5, warn ? C.red : C.frame);
    p.roundRect(boxX + 9, boxY + 9, 94, 28, 7, warn ? '#7a1f16' : '#3a2f22');
    text('다음 행동', boxX + 56, midY, 16, warn ? '#ffd0c4' : C.muted);
    const tx = boxX + 112 + (boxW - 120) / 2;
    if (warn) {
      const tw = p.textWidth(B(), move.telegraph, 22);
      const ix = tx - Math.min(tw, boxW - 170) / 2 - 20;
      p.poly([ix, midY - 10, ix + 11, midY + 9, ix - 11, midY + 9], '#ffb4a8');
      p.rect(ix - 1.5, midY - 4, 3, 7, '#4a1410');
      p.rect(ix - 1.5, midY + 4, 3, 3, '#4a1410');
    }
    text(move.telegraph, tx, midY, 22, warn ? '#ffc4b8' : C.sub, { maxWidth: boxW - 170 });


    cards(b.members, (x, y, w, h, roleKey, mem) => {
      const role = ROLES[roleKey];
      if (!mem) {
        roleIcon(roleKey, x + w / 2, y + 72, true);
        text('-', x + w / 2, y + 138, NAME_SIZE, C.dim);
        text(role.name, x + w / 2, y + 172, 20, '#8a6a3a');
        return;
      }
      const state = memberState(b, mem, r.showingResult);
      const down = state === 'down';
      // 리본: 결과 단계(턴 전환 3.5초)에는 띄우지 않는다 — 그림은 평소대로 두고 전환은 글자 제목이 알린다
      if (state !== 'result') {
        const ribbon = RIBBON[state];
        p.roundRect(x + 12, y + 12, w - 24, 30, 8, ribbon.fill);
        text(state === 'pending' ? '행동 선택!' : state === 'ready' ? `준비 · ${choiceLabel(mem)}` : state === 'stunned' ? `${mem.stunStatus?.name ?? '기절'} · 행동 불가` : '쓰러짐',
          x + w / 2, y + 27, 19, ribbon.color, { maxWidth: w - 36 });
      }

      roleIcon(roleKey, x + w / 2, y + 86, down);
      const hit = last?.hits[mem.userId];
      if (hit && usedFx) hitFx(usedFx, x + w / 2, y + 86, fxColor, sporeColor, accentColor);
      // 받은 피해 숫자도 그 턴의 결과 화면에서만(다음 턴 선택 화면에는 남기지 않는다)
      if (hit && r.showingResult) text(`-${hit}`, x + w - 38, y + 78, 24, '#ff5a45');
      // 독 피해(아군 행동 뒤)는 보라 숫자로 그 아래에
      const poisonHit = r.showingResult && last?.poison?.[mem.userId];
      if (poisonHit) text(`-${poisonHit}`, x + w - 38, y + 108, 22, '#d7a3ff');
      // 상태 효과 아이콘(카드 왼쪽, 리본 아래): 점액(남은 턴) · 기절
      if (!down) statusBadges(b, mem, x + 32, y + 66);
      // 환각(최면술): 아이콘 양옆 작은 최면 물결. 최면술에 막 맞은 결과 화면은 타격 표시가 같은 물결이라 겹쳐 그리지 않는다.
      if (!down && isConfused(b, mem) && !(usedFx === 'hypno' && hit)) hypnoWaves(x + w / 2, y + 86, 0.27, fxColor, 2);
      // 점액 상태는 아이콘 대신 카드 아이콘에 묻은 점액으로 보여준다. 이번 턴 결과 화면에서 맞은 카드는
      // 타격 표시(할퀸 자국·충격 별·흩뿌리기 얼룩)만 그려 겹치지 않게 하고, 다음 선택 화면부터 다시 점액을 보인다.
      if (!down && slowTurnsLeft(b, mem) > 0 && !(usedMove && hit)) hitFx('sweep', x + w / 2, y + 86, fxColor);

      text(mem.name, x + w / 2, y + 138, NAME_SIZE, down ? C.dim : C.text, { maxWidth: w - 20 });
      // HP는 바 안에 숫자로(한 줄 절약)
      const ratio = mem.hp / PLAYER_MAX_HP;
      bar(x + 16, y + 160, w - 32, 22, ratio, hpColor(ratio));
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
      if (usedMove && last?.hits[mem.userId]) return { color: '#ff4a3a', width: 4 }; // 이번 턴에 맞은 카드
      if (state === 'pending') return { color: '#ffb52e', width: 4 };
      if (state === 'ready') return { color: '#3ecf6e', width: 2.5 };
      if (state === 'stunned') return { color: '#ffd23f', width: 2.5 };
      return null;
    });
  });
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
  const cached = backgrounds.get('end-v2');
  if (cached) { cached.copy(painter.buf); return; }
  frame();
  for (const q of [LP, RP]) {
    p.roundRect(q.x, q.y, q.w, q.h, 14, C.box);
    p.strokeRoundRect(q.x, q.y, q.w, q.h, 14, 1.5, C.frame);
  }
  backgrounds.set('end-v2', Buffer.from(painter.buf));
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
    text(title, W / 2 + 3, 63, 58, '#000000');
    text(title, W / 2, 60, 58, titleColor);
    text(END_SUB[outcome](r.monster), W / 2, 114, 24, clear ? C.ok : C.sub);

    // 왼쪽: 몬스터 + 전투 기록
    const mcx = LP.x + LP.w / 2;
    drawMonster(r.monster, mcx, 262, 116, { gray: clear });
    if (clear) {
      p.line(mcx - 58, 214, mcx + 58, 310, 8, C.red);
      p.line(mcx + 58, 214, mcx - 58, 310, 8, C.red);
    } else if (fled) {
      p.roundRect(mcx - 34, 172, 68, 28, 8, '#5c1410');
      text('도주', mcx, 186, 17, '#ffb4a8');
    }
    text(r.monster.name, mcx, 362, 28, C.gold, { maxWidth: LP.w - 30 });
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
      p.roundRect(RP.x + 14, y, RP.w - 28, 86, 12, mvp ? '#2c2210' : '#1d1711');
      if (mvp) p.strokeRoundRect(RP.x + 14, y, RP.w - 28, 86, 12, 2, C.gold);
      drawPixels(ROLE_SPRITES[mem.role], RP.x + 52, y + 43, 2.7, { dim: mem.hp <= 0 && !clear });
      const nameX = RP.x + 86;
      text(mem.name, nameX, y + 32, 26, C.text, { align: 'left', maxWidth: 132 });
      // MVP 배지는 역할 줄 옆에(이름 줄에 두면 긴 이름일 때 피해 숫자와 겹친다)
      const roleName = ROLES[mem.role].name;
      text(roleName, nameX, y + 62, 18, C.orange, { align: 'left' });
      if (mvp) {
        const rw = p.textWidth(B(), roleName, 18);
        p.roundRect(nameX + rw + 8, y + 51, 46, 22, 6, '#e2b14a');
        text('MVP', nameX + rw + 31, y + 62, 14, '#2a1a04');
      }
      text(mem.damage.toLocaleString(), COL.dmg, y + 43, 22, C.text);
      text(mem.healing ? mem.healing.toLocaleString() : '-', COL.heal, y + 43, 22, mem.healing ? '#8fe0a8' : C.dim);
      text(mem.blocked ? mem.blocked.toLocaleString() : '-', COL.block, y + 43, 22, mem.blocked ? '#9cc8ff' : C.dim);
      if (reward) pill(COL.reward - 34, y + 27, 68, 32, `+${reward.xp}`, 20, mvp ? '#6b4e12' : '#1f4a2c', mvp ? '#ffe39a' : '#bff0cf');
      else text('-', COL.reward, y + 43, 22, C.dim);
    });
  });
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
  }
  // 마지막으로 장면마다 한 장씩 실제로 그려 본다. 배경·글자 모양만 데워 두니 서버에서 첫 모집 그림이 여전히
  // 그리기 412ms + 압축 298ms(이벤트 루프 지연 826ms)였다 — 글자·픽셀 붙이기와 PNG 만들기 반복문이 처음 돌 때
  // 느린 탓이라, 봇이 한가한 시작 직후에 한 번씩 돌려 둔다. 결과 그림은 버리고 콘솔 기록도 남기지 않는다.
  for (const scene of sampleScenes(monsters[0])) jobs.push(() => { warming = true; try { scene(); } finally { warming = false; } });
  return jobs;
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

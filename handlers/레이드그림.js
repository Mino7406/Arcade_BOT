// 레이드그림.js — 긴급 퀘스트 패널(모집·전투·결과)을 PNG 한 장으로 그린다.
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
const { ROLES, ROLE_ORDER, PLAYER_MAX_HP } = require('./레이드전투');

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
function logRender(scene, drawMs, pngMs, bytes) {
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

// 경광등(제목 양옆)
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
function drawMonster(monster, cx, cy, maxH, { rage = false, gray = false } = {}) {
  const sp = monster.sprite;
  if (!sp) return;
  drawPixels(sp, cx, cy, Math.floor(maxH / sp.rows.length), { dim: gray, colors: rage ? sp.rageColors : null });
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
// 카드 배경과 빈자리 테두리는 배경 캐시(background)에 이미 있다. 참가자 카드만 금색 테두리를 덧그린다.
function cards(members, drawCard) {
  ROLE_ORDER.forEach((roleKey, i) => {
    const x = 20 + i * (CARD_W + CARD_GAP);
    const m = members.find(q => q.role === roleKey) || null;
    if (m) p.strokeRoundRect(x, CARD_Y, CARD_W, CARD_H, 14, 2, C.gold);
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
    const title = '긴급 퀘스트 발생!';
    const tw = p.textWidth(B(), title, 46);
    text(title, W / 2, 54, 46, C.gold);
    siren(W / 2 - tw / 2 - 50, 56); siren(W / 2 + tw / 2 + 50, 56);
    p.circle(W / 2 - 64, 130, 6, C.red);
    text('타겟 몬스터', W / 2 + 8, 130, 22, C.orange);
    drawMonster(r.monster, W / 2, 218, 112);
    text(r.monster.name, W / 2, 308, 38, C.gold);
    cards(r.party, (x, y, w, h, roleKey, m) => {
      const role = ROLES[roleKey];
      roleIcon(roleKey, x + w / 2, y + 50, !m);
      // 이름 크기는 모집·전투·결과 모두 NAME_SIZE로 같게 — 모집 때 만든 글자 모양을 전투·결과에서 그대로 재사용한다
      // (크기가 다르면 서버에서 전투 시작 그림이 이름을 다시 그리느라 170ms 걸렸다).
      text(m ? m.name : '빈자리', x + w / 2, y + 116, NAME_SIZE, m ? C.text : C.dim, { maxWidth: w - 20 });
      text(role.name, x + w / 2, y + 152, 22, m ? C.orange : '#8a6a3a');
      pill(x + 14, y + 176, w - 28, 34, role.skill.name, 20);
      text(m ? '참가 완료' : '참가 대기', x + w / 2, y + 234, 22, m ? C.ok : C.muted);
    });
  });
}

function renderBattle(r) {
  return render('전투', () => {
    const b = r.battle;
    const m = b.monster;
    background('battle', 120, 224);
    const name = b.rage ? m.rageName : m.name;
    const nw = p.textWidth(B(), name, 38);
    text(name, W / 2 - (b.rage ? 34 : 0), 42, 38, b.rage ? C.red : C.gold);
    if (b.rage) {
      p.roundRect(W / 2 - 34 + nw / 2 + 12, 25, 64, 34, 8, '#5c1410');
      text('분노', W / 2 - 34 + nw / 2 + 44, 42, 22, '#ffb4a8');
    }
    bar(50, 72, W - 100, 34, b.hp / b.maxHp, b.rage ? '#e5383b' : '#d94a2b');
    p.strokeRoundRect(50, 72, W - 100, 34, 17, 2, C.gold);
    text(`${b.hp.toLocaleString()} / ${b.maxHp.toLocaleString()}`, W / 2, 89, 24, '#ffffff');

    drawMonster(m, W / 2, 196, 112, { rage: b.rage });
    const move = m.moves[b.intent];
    const warn = b.intent === 'smash';
    p.roundRect(70, 270, W - 140, 56, 10, warn ? '#4a1410' : '#241c14');
    p.strokeRoundRect(70, 270, W - 140, 56, 10, 1.5, warn ? C.red : C.frame);
    text(`다음 행동 · ${move.telegraph}`, W / 2, 298, 26, warn ? '#ffc4b8' : C.sub, { maxWidth: W - 180 });

    cards(b.members, (x, y, w, h, roleKey, mem) => {
      const role = ROLES[roleKey];
      if (!mem) {
        roleIcon(roleKey, x + w / 2, y + 50, true);
        text('빈자리', x + w / 2, y + 116, NAME_SIZE, C.dim);
        text(role.name, x + w / 2, y + 152, 22, '#8a6a3a');
        return;
      }
      const down = mem.hp <= 0;
      const ratio = mem.hp / PLAYER_MAX_HP;
      roleIcon(roleKey, x + w / 2, y + 46, down);
      text(mem.name, x + w / 2, y + 104, NAME_SIZE, down ? C.dim : C.text, { maxWidth: w - 20 });
      text(role.name, x + w / 2, y + 136, 20, down ? '#8a6a3a' : C.orange);
      bar(x + 14, y + 156, w - 28, 18, ratio, hpColor(ratio));
      text(down ? '쓰러짐' : `HP ${mem.hp}`, x + w / 2, y + 194, 24, down ? '#f04b3a' : C.sub);
      const half = (w - 36) / 2;
      pill(x + 14, y + 214, half, 32, mem.cooldown > 0 ? `스킬 ${mem.cooldown}` : '스킬 OK', 19,
        mem.cooldown > 0 ? '#2f2a24' : C.teal, mem.cooldown > 0 ? C.muted : C.tealText);
      pill(x + 22 + half, y + 214, half, 32, `회복 ${mem.potions}`, 19, '#2f3a1e', '#d8f0b0');
    });
  });
}

// outcome: 'clear' | 'wipe' | 'timeout' | 'noshow' | 'restart' | 'admin'
const END_TITLE = {
  clear: 'QUEST CLEAR', wipe: '파티 전멸', timeout: '시간 초과', noshow: '몬스터가 사라졌다', restart: '몬스터가 사라졌다', admin: '퀘스트 종료',
};
const END_SUB = {
  clear: 'XP 시스템이 복구되었습니다!',
  wipe: '몬스터가 도망쳤다… XP는 복구됨',
  timeout: '몬스터가 도망쳤다… XP는 복구됨',
  noshow: '아무도 오지 않았다',
  restart: '봇 점검으로 사라졌다',
  admin: '관리자가 종료했다',
};
function renderEnd(r, outcome, rewards = []) {
  return render('결과', () => {
    const clear = outcome === 'clear';
    background('end', 126, 216);
    text(END_TITLE[outcome], W / 2, 52, 52, clear ? C.red : C.muted);
    text(END_SUB[outcome], W / 2, 100, 26, clear ? C.ok : C.sub);
    drawMonster(r.monster, W / 2, 214, 112, { gray: clear });
    if (clear) {
      p.line(W / 2 - 64, 164, W / 2 + 64, 264, 9, C.red);
      p.line(W / 2 + 64, 164, W / 2 - 64, 264, 9, C.red);
    }
    const b = r.battle;
    text(b ? `${r.monster.name} · ${b.turn}턴` : r.monster.name, W / 2, 310, 28, C.gold);
    const members = b ? b.members : r.party || [];
    cards(members, (x, y, w, h, roleKey, mem) => {
      const role = ROLES[roleKey];
      roleIcon(roleKey, x + w / 2, y + 50, !mem);
      text(mem ? mem.name : '빈자리', x + w / 2, y + 112, NAME_SIZE, mem ? C.text : C.dim, { maxWidth: w - 20 });
      text(role.name, x + w / 2, y + 146, 20, mem ? C.orange : '#8a6a3a');
      if (!mem || mem.damage === undefined) return;
      text(`피해 ${mem.damage.toLocaleString()}`, x + w / 2, y + 180, 22, C.sub, { maxWidth: w - 20 });
      const reward = rewards.find(q => q.userId === mem.userId);
      if (reward) pill(x + 14, y + 206, w - 28, 38, `+${reward.xp} XP${reward.mvp ? ' MVP' : ''}`, 22, reward.mvp ? '#6b4e12' : '#1f4a2c', reward.mvp ? '#ffe39a' : '#bff0cf');
      else if (clear) text('보상 없음', x + w / 2, y + 225, 20, C.muted);
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
  for (const [key, y, h] of [['recruit', 102, 240], ['battle', 120, 224], ['end', 126, 216]]) {
    jobs.push(() => { p = painter; background(key, y, h); });
  }
  const add = (font, s, size) => jobs.push(() => painter.warmText(fonts[font], s, size));
  add('bold', '긴급 퀘스트 발생!', 46);
  add('bold', '타겟 몬스터', 22);
  add('bold', '분노', 22);
  add('bold', '보상 없음', 20);
  for (const v of ['참가 완료', '참가 대기']) add('bold', v, 22);
  for (const v of ['스킬 OK', '스킬 1', '스킬 2', '스킬 3', '회복 0', '회복 1', '회복 2']) add('bold', v, 19);
  for (const k of ROLE_ORDER) {
    add('bold', ROLES[k].name, 22);
    add('bold', ROLES[k].name, 20);
    add('bold', ROLES[k].skill.name, 20);
  }
  add('bold', '빈자리', NAME_SIZE);
  for (const [k, t] of Object.entries(END_TITLE)) { add('bold', t, 52); add('bold', END_SUB[k], 26); }
  for (const m of monsters) {
    add('bold', m.name, 38);
    add('bold', m.rageName, 38);
    for (const move of Object.values(m.moves)) add('bold', `다음 행동 · ${move.telegraph}`, 26);
  }
  return jobs;
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

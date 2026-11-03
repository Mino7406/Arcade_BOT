// 레이드그림.js — 긴급 퀘스트 패널(모집·전투·결과)을 PNG 한 장으로 그린다.
// 디스코드 V2 컴포넌트로는 카드 가로 배치·가운데 정렬이 안 돼서, 몬스터와 파티 카드 4장이 있는
// "판"만 그림으로 만들고 타이머·버튼·클릭마다 바뀌는 선택 상태는 글자 컴포넌트로 둔다(handlers/레이드.js).
//
// 메모리: 그림 라이브러리(@napi-rs/canvas)는 첫 레이드 때 처음 불러오고, 캔버스는 하나만 만들어 계속
// 재사용한다. 그림마다 새 캔버스를 만들면 네이티브 메모리가 GC를 기다리며 쌓여 80장 만에 RSS가
// 200MB를 넘었다(256MB 요금제에서 강제 종료되는 수준). 재사용하면 수백 장을 그려도 +45MB 근처에서 멈춘다.
// 라이브러리나 폰트를 못 불러오면 render*는 null을 돌려주고, 레이드.js가 글자 화면으로 대신 보여준다.

const fs = require('fs');
const path = require('path');
const { ROLES, ROLE_ORDER, PLAYER_MAX_HP } = require('./레이드전투');

const W = 900;
const H = 600;
const C = {
  bg: '#17120e', frame: '#8a6a2c', gold: '#d9a93f', box: '#0c0a08', card: '#2a2119', cardEmpty: '#5a4a32',
  teal: '#1d4c56', tealText: '#e6f4f6', orange: '#f0a428', text: '#ffffff', sub: '#eee6d8', dim: '#7d7466',
  muted: '#a59b8a', ok: '#7ee0a6', red: '#ff4a3a', hpBack: '#3a2f25',
};

// 한글 폰트: 레포에 같이 둔 파일을 먼저 쓰고, 없으면 개발 PC(윈도우)의 맑은 고딕으로 대신한다.
const FONT_CANDIDATES = {
  regular: [path.join(__dirname, '..', 'assets', 'fonts', 'NanumGothic-Regular.ttf'), 'C:/Windows/Fonts/malgun.ttf'],
  bold: [path.join(__dirname, '..', 'assets', 'fonts', 'NanumGothic-Bold.ttf'), 'C:/Windows/Fonts/malgunbd.ttf'],
};

let lib = null;          // { createCanvas, Image } — 처음 그릴 때 불러온다
let unavailable = false; // 한 번 실패하면 다시 시도하지 않는다(매 턴 require 실패 로그를 피함)
let canvas = null;
const imageCache = new Map();

// 서버(256MB)에서 그림 엔진이 메모리를 얼마나 쓰는지 확인하기 위한 콘솔 기록. 로드 전후와
// 처음 몇 장·이후 10장마다 RSS와 그리는 시간을 남긴다.
const rssMb = () => Math.round(process.memoryUsage().rss / 1048576);
let renderCount = 0;
function logRender(scene, startedAt) {
  renderCount++;
  if (renderCount > 3 && renderCount % 10 !== 0) return;
  console.warn(`🎨 레이드 그림 #${renderCount}(${scene}) ${Date.now() - startedAt}ms · RSS ${rssMb()}MB`);
}

function load() {
  if (lib || unavailable) return lib;
  const before = rssMb();
  const startedAt = Date.now();
  try {
    const { createCanvas, GlobalFonts, Image } = require('@napi-rs/canvas');
    const regular = FONT_CANDIDATES.regular.find(p => fs.existsSync(p));
    const bold = FONT_CANDIDATES.bold.find(p => fs.existsSync(p)) || regular;
    if (!regular) throw new Error('한글 폰트 파일을 찾을 수 없음 (assets/fonts/)');
    GlobalFonts.registerFromPath(regular, 'RaidKR');
    GlobalFonts.registerFromPath(bold, 'RaidKRB');
    lib = { createCanvas, Image };
    canvas = createCanvas(W, H);
    console.warn(`🎨 레이드 그림 엔진 로드 — RSS ${before}→${rssMb()}MB, ${Date.now() - startedAt}ms, 폰트 ${path.basename(regular)}`);
  } catch (err) {
    unavailable = true;
    console.error('레이드 그림 기능을 쓸 수 없어 글자 화면으로 대신합니다:', err.message);
  }
  return lib;
}

// ── 그리기 도구 ────────────────────────────────────────────────
function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
// 이모지는 그림 폰트에 없어 네모로 나오므로 그림에 넣는 글자에서는 뺀다.
const stripEmoji = (s) => String(s).replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '').replace(/ {2,}/g, ' ').trim();
function text(ctx, s, x, y, { size = 16, bold = false, color = C.text, align = 'center', maxWidth } = {}) {
  ctx.font = `${size}px ${bold ? 'RaidKRB' : 'RaidKR'}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(stripEmoji(s), x, y, maxWidth);
}
function textWidth(ctx, s, size, bold) {
  ctx.font = `${size}px ${bold ? 'RaidKRB' : 'RaidKR'}`;
  return ctx.measureText(stripEmoji(s)).width;
}
function bar(ctx, x, y, w, h, ratio, color) {
  rr(ctx, x, y, w, h, h / 2); ctx.fillStyle = C.hpBack; ctx.fill();
  const fw = Math.max(0, Math.min(1, ratio)) * w;
  if (fw > 0) { rr(ctx, x, y, Math.max(fw, h), h, h / 2); ctx.fillStyle = color; ctx.fill(); }
}
const hpColor = (ratio) => (ratio > 0.5 ? '#3ecf6e' : ratio > 0.25 ? '#f0b232' : '#f04b3a');

// 경광등(제목 양옆)
function siren(ctx, cx, cy) {
  ctx.save(); ctx.translate(cx, cy);
  ctx.fillStyle = C.red;
  ctx.beginPath(); ctx.moveTo(-12, 10); ctx.lineTo(-12, -4); ctx.arc(0, -4, 12, Math.PI, 0); ctx.lineTo(12, 10); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#ffd2c8'; ctx.fillRect(-6, -8, 4, 12);
  ctx.fillStyle = C.gold; ctx.fillRect(-17, 10, 34, 6);
  ctx.strokeStyle = C.red; ctx.lineWidth = 3; ctx.lineCap = 'round';
  for (const [x1, y1, x2, y2] of [[-20, -14, -25, -19], [20, -14, 25, -19], [0, -22, 0, -28], [-22, 0, -28, 0], [22, 0, 28, 0]]) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  ctx.restore();
}

function title(ctx, s, color, withSirens) {
  const size = 34;
  const tw = textWidth(ctx, s, size, true);
  text(ctx, s, W / 2, 46, { size, bold: true, color });
  if (withSirens) { siren(ctx, W / 2 - tw / 2 - 44, 46); siren(ctx, W / 2 + tw / 2 + 44, 46); }
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

// 픽셀 아트 한 장을 (cx, cy) 가운데에 칸 크기 px로 그린다. dim이면 어둡게(빈자리·쓰러짐).
function drawPixels(ctx, sp, cx, cy, px, { dim = false, colors = null } = {}) {
  const w = sp.rows[0].length * px;
  const h = sp.rows.length * px;
  const palette = colors ? { ...sp.palette, ...colors } : sp.palette;
  sp.rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === '.') return;
    let color = palette[ch];
    if (dim) color = grayOf(color, 0.45);
    const shift = sp.glitchRows?.includes(y) ? px * 0.6 : 0;
    // 칸 크기가 소수(3.5px 등)여도 칸 사이에 흐린 틈이 생기지 않게 경계를 정수 픽셀로 맞춘다.
    const x0 = Math.round(cx - w / 2 + x * px + shift);
    const y0 = Math.round(cy - h / 2 + y * px);
    ctx.fillStyle = color;
    ctx.fillRect(x0, y0, Math.round(cx - w / 2 + (x + 1) * px + shift) - x0, Math.round(cy - h / 2 + (y + 1) * px) - y0);
  }));
}
function grayOf(hex, k) {
  const v = Math.round((parseInt(hex.slice(1, 3), 16) * 0.3 + parseInt(hex.slice(3, 5), 16) * 0.59 + parseInt(hex.slice(5, 7), 16) * 0.11) * k);
  const g = v.toString(16).padStart(2, '0');
  return `#${g}${g}${g}`;
}

const ROLE_ICON_PX = 3.4; // 16칸 × 3.4 ≈ 54px

function roleIcon(ctx, role, cx, cy, dim = false) {
  drawPixels(ctx, ROLE_SPRITES[role], cx, cy, ROLE_ICON_PX, { dim });
}

// 몬스터: sprite(픽셀 아트) 또는 image(파일). maxH 안에 맞춘다. gray: 도망/전멸 결과 화면용 흑백.
function drawMonster(ctx, monster, cx, cy, maxH, { rage = false, gray = false } = {}) {
  if (monster.image) {
    let img = imageCache.get(monster.image);
    if (!img) {
      img = new lib.Image();
      img.src = fs.readFileSync(path.join(__dirname, '..', monster.image));
      imageCache.set(monster.image, img);
    }
    const scale = maxH / img.height;
    ctx.save();
    if (gray) ctx.filter = 'grayscale(1) brightness(0.6)';
    ctx.drawImage(img, cx - (img.width * scale) / 2, cy - maxH / 2, img.width * scale, maxH);
    ctx.restore();
    return;
  }
  const sp = monster.sprite;
  if (!sp) return;
  drawPixels(ctx, sp, cx, cy, Math.floor(maxH / sp.rows.length), { dim: gray, colors: rage ? sp.rageColors : null });
}

function frame(ctx) {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
  rr(ctx, 4, 4, W - 8, H - 8, 16); ctx.strokeStyle = C.frame; ctx.lineWidth = 2; ctx.stroke();
}
function monsterBox(ctx, y, h) {
  rr(ctx, 20, y, W - 40, h, 14); ctx.fillStyle = C.box; ctx.fill(); ctx.strokeStyle = C.frame; ctx.lineWidth = 1.5; ctx.stroke();
}

// 카드 4장(역할 순서 고정). drawCard(ctx, x, y, w, h, roleKey, member)로 안쪽을 채운다.
const CARD_Y = 360, CARD_H = 218, CARD_W = 203, CARD_GAP = 16;
function cards(ctx, members, drawCard) {
  ROLE_ORDER.forEach((roleKey, i) => {
    const x = 20 + i * (CARD_W + CARD_GAP);
    const m = members.find(p => p.role === roleKey) || null;
    rr(ctx, x, CARD_Y, CARD_W, CARD_H, 14);
    ctx.fillStyle = C.card; ctx.fill();
    ctx.strokeStyle = m ? C.gold : C.cardEmpty; ctx.lineWidth = 2; ctx.stroke();
    drawCard(ctx, x, CARD_Y, CARD_W, CARD_H, roleKey, m);
  });
}
function pill(ctx, x, y, w, label, fill = C.teal, color = C.tealText) {
  rr(ctx, x, y, w, 24, 5); ctx.fillStyle = fill; ctx.fill();
  text(ctx, label, x + w / 2, y + 12, { size: 12, bold: true, color, maxWidth: w - 10 });
}

function finish(scene, startedAt) {
  const png = canvas.encodeSync('png');
  logRender(scene, startedAt);
  return png;
}

// ── 장면별 그림 ────────────────────────────────────────────────
// r: handlers/레이드.js의 레이드 객체(monster, party, battle …). 실패하면 null.
function renderRecruit(r) {
  if (!load()) return null;
  const startedAt = Date.now();
  try {
    const ctx = canvas.getContext('2d');
    frame(ctx);
    title(ctx, '긴급 퀘스트 발생!', C.gold, true);
    text(ctx, '역할 버튼을 눌러 토벌 파티에 참가하세요!', W / 2, 88, { size: 15, color: C.sub });
    monsterBox(ctx, 112, 228);
    ctx.fillStyle = C.red; ctx.beginPath(); ctx.arc(W / 2 - 46, 134, 5, 0, Math.PI * 2); ctx.fill();
    text(ctx, '타겟 몬스터', W / 2 + 6, 134, { size: 14, bold: true, color: C.orange });
    drawMonster(ctx, r.monster, W / 2, 222, 112);
    text(ctx, r.monster.name, W / 2, 310, { size: 28, bold: true, color: C.gold });
    cards(ctx, r.party, (ctx, x, y, w, h, roleKey, m) => {
      const role = ROLES[roleKey];
      roleIcon(ctx, roleKey, x + w / 2, y + 52, !m);
      text(ctx, m ? m.name : '빈자리', x + w / 2, y + 110, { size: 20, bold: true, color: m ? C.text : C.dim, maxWidth: w - 20 });
      text(ctx, role.name, x + w / 2, y + 138, { size: 14, bold: true, color: C.orange });
      pill(ctx, x + 16, y + 156, w - 32, `스킬 · ${role.skill.name}`);
      text(ctx, m ? '참가 완료' : '참가 대기', x + w / 2, y + 198, { size: 13, color: m ? C.ok : C.muted });
    });
    return finish('모집', startedAt);
  } catch (err) {
    console.error('레이드 모집 그림 실패:', err);
    return null;
  }
}

function renderBattle(r) {
  if (!load()) return null;
  const startedAt = Date.now();
  try {
    const b = r.battle;
    const m = b.monster;
    const ctx = canvas.getContext('2d');
    frame(ctx);
    const name = b.rage ? m.rageName : m.name;
    const nw = textWidth(ctx, name, 28, true);
    text(ctx, name, W / 2, 38, { size: 28, bold: true, color: b.rage ? C.red : C.gold });
    if (b.rage) {
      rr(ctx, W / 2 + nw / 2 + 12, 26, 52, 24, 6); ctx.fillStyle = '#5c1410'; ctx.fill();
      text(ctx, '분노', W / 2 + nw / 2 + 38, 38, { size: 13, bold: true, color: '#ffb4a8' });
    }
    bar(ctx, 60, 64, W - 120, 22, b.hp / b.maxHp, b.rage ? '#e5383b' : '#d94a2b');
    rr(ctx, 60, 64, W - 120, 22, 11); ctx.strokeStyle = C.gold; ctx.lineWidth = 1.5; ctx.stroke();
    text(ctx, `${b.hp.toLocaleString()} / ${b.maxHp.toLocaleString()}`, W / 2, 75, { size: 13, bold: true, color: '#fff' });

    monsterBox(ctx, 102, 238);
    drawMonster(ctx, m, W / 2, 192, 120, { rage: b.rage });
    const move = m.moves[b.intent];
    const warn = b.intent === 'smash';
    rr(ctx, 120, 280, W - 240, 40, 8); ctx.fillStyle = warn ? '#4a1410' : '#241c14'; ctx.fill();
    ctx.strokeStyle = warn ? C.red : C.frame; ctx.lineWidth = 1.2; ctx.stroke();
    text(ctx, `다음 행동 · ${move.telegraph}${warn ? '' : b.intent === 'attack' ? ' (한 명을 노린다)' : ''}`, W / 2, 300, {
      size: 16, bold: true, color: warn ? '#ffb4a8' : C.sub, maxWidth: W - 270,
    });

    cards(ctx, b.members, (ctx, x, y, w, h, roleKey, mem) => {
      const role = ROLES[roleKey];
      if (!mem) {
        roleIcon(ctx, roleKey, x + w / 2, y + 52, true);
        text(ctx, '빈자리', x + w / 2, y + 110, { size: 18, bold: true, color: C.dim });
        text(ctx, role.name, x + w / 2, y + 138, { size: 14, bold: true, color: '#8a6a3a' });
        return;
      }
      const down = mem.hp <= 0;
      const ratio = mem.hp / PLAYER_MAX_HP;
      roleIcon(ctx, roleKey, x + w / 2, y + 46, down);
      text(ctx, mem.name, x + w / 2, y + 96, { size: 19, bold: true, color: down ? C.dim : C.text, maxWidth: w - 20 });
      text(ctx, role.name, x + w / 2, y + 120, { size: 13, bold: true, color: down ? '#8a6a3a' : C.orange });
      bar(ctx, x + 16, y + 138, w - 32, 12, ratio, hpColor(ratio));
      text(ctx, down ? '쓰러짐' : `HP ${mem.hp} / ${PLAYER_MAX_HP}`, x + w / 2, y + 164, { size: 13, bold: true, color: down ? '#f04b3a' : C.sub });
      pill(ctx, x + 16, y + 180, (w - 40) / 2, mem.cooldown > 0 ? `스킬 ${mem.cooldown}턴` : '스킬 준비', mem.cooldown > 0 ? '#2f2a24' : C.teal, mem.cooldown > 0 ? C.muted : C.tealText);
      pill(ctx, x + 24 + (w - 40) / 2, y + 180, (w - 40) / 2, `회복약 ${mem.potions}`, '#2f3a1e', '#d8f0b0');
    });
    return finish('전투', startedAt);
  } catch (err) {
    console.error('레이드 전투 그림 실패:', err);
    return null;
  }
}

// outcome: 'clear' | 'wipe' | 'timeout' | 'noshow' | 'restart' | 'admin'
const END_TITLE = {
  clear: 'QUEST CLEAR', wipe: '파티 전멸', timeout: '시간 초과', noshow: '몬스터가 사라졌다', restart: '몬스터가 사라졌다', admin: '퀘스트 종료',
};
const END_SUB = {
  clear: 'XP 시스템이 복구되었습니다!',
  wipe: '몬스터가 도망쳤다… XP 시스템은 복구되었습니다',
  timeout: '몬스터가 도망쳤다… XP 시스템은 복구되었습니다',
  noshow: '아무도 오지 않아 몬스터가 유유히 사라졌다',
  restart: '봇 점검으로 몬스터가 사라졌다',
  admin: '관리자가 긴급 퀘스트를 종료했다',
};
function renderEnd(r, outcome, rewards = []) {
  if (!load()) return null;
  const startedAt = Date.now();
  try {
    const ctx = canvas.getContext('2d');
    const clear = outcome === 'clear';
    frame(ctx);
    title(ctx, END_TITLE[outcome], clear ? C.red : C.muted, false);
    text(ctx, END_SUB[outcome], W / 2, 88, { size: 15, color: clear ? C.ok : C.sub });
    monsterBox(ctx, 112, 228);
    drawMonster(ctx, r.monster, W / 2, 210, 112, { gray: clear });
    if (clear) {
      ctx.strokeStyle = C.red; ctx.lineWidth = 8; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(W / 2 - 60, 160); ctx.lineTo(W / 2 + 60, 260); ctx.moveTo(W / 2 + 60, 160); ctx.lineTo(W / 2 - 60, 260); ctx.stroke();
    }
    const b = r.battle;
    text(ctx, b ? `${r.monster.name} · ${b.turn}턴 · 남은 HP ${b.hp.toLocaleString()}` : r.monster.name, W / 2, 310, {
      size: 20, bold: true, color: C.gold,
    });
    const members = b ? b.members : r.party || [];
    cards(ctx, members, (ctx, x, y, w, h, roleKey, mem) => {
      const role = ROLES[roleKey];
      roleIcon(ctx, roleKey, x + w / 2, y + 48, !mem);
      text(ctx, mem ? mem.name : '빈자리', x + w / 2, y + 100, { size: 19, bold: true, color: mem ? C.text : C.dim, maxWidth: w - 20 });
      text(ctx, role.name, x + w / 2, y + 124, { size: 13, bold: true, color: mem ? C.orange : '#8a6a3a' });
      if (!mem || mem.damage === undefined) return;
      text(ctx, `피해 ${mem.damage.toLocaleString()} · 회복 ${mem.healing}`, x + w / 2, y + 150, { size: 13, color: C.sub, maxWidth: w - 20 });
      const reward = rewards.find(x => x.userId === mem.userId);
      if (reward) pill(ctx, x + 16, y + 168, w - 32, `+${reward.xp} XP${reward.mvp ? ' · MVP' : ''}`, reward.mvp ? '#6b4e12' : '#1f4a2c', reward.mvp ? '#ffe39a' : '#bff0cf');
      else if (clear) text(ctx, '행동하지 않아 보상 없음', x + w / 2, y + 180, { size: 12, color: C.muted });
    });
    return finish('결과', startedAt);
  } catch (err) {
    console.error('레이드 결과 그림 실패:', err);
    return null;
  }
}

module.exports = { renderRecruit, renderBattle, renderEnd };

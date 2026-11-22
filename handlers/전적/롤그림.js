// 롤그림.js — 롤 전적(유저 정보 · 최근 20판 통계 · 최근 5경기)을 PNG 한 장으로 그린다. op.gg 구성에서 10명 표시는 뺐다.
// 그리기는 레이드와 같은 그림판(순수 JS, 네이티브 라이브러리 없음)으로 한다. 폰트·그림판을 못 쓰면 render 는 null 을 돌려주고
// 호출부(handlers/전적/롤.js)가 글자 화면으로 대신 보여 준다.
// 글자 크기: 디스코드가 900px 그림을 채팅 폭(약 500px)으로 줄여 보여주므로 그림 안 글자는 20px 이상으로 둔다.
const path = require('path');
const { Painter, loadFont } = require('../레이드/그림판');
const { drawIconFile } = require('./아이콘');
const { ratio, killParticipation, queueLabel } = require('./집계');
const { timeAgo, ringContours } = require('./표시');

const W = 900;
const H = 900;
const RENDER_SCALE = 0.75; // 실제 그림은 675×675 — 디스코드가 어차피 채팅 폭으로 줄여 보여줘 글자 크기는 같고 픽셀은 44% 준다
const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');

const C = {
  bg: '#14161c', panel: '#1f222b', panel2: '#272b36', text: '#ffffff', muted: '#9aa0ad', gold: '#f2c14e',
  win: '#1d3557', winBar: '#3b82f6', winText: '#7ab8ff', lose: '#44222a', loseBar: '#ff4a3a', loseText: '#ff8a7a',
  empty: '#12141a', hole: '#3a3f4d', red: '#ff6b6b',
};

const TIER_KO = { IRON: '아이언', BRONZE: '브론즈', SILVER: '실버', GOLD: '골드', PLATINUM: '플래티넘', EMERALD: '에메랄드', DIAMOND: '다이아몬드', MASTER: '마스터', GRANDMASTER: '그랜드마스터', CHALLENGER: '챌린저' };
const APEX = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);
const DIVISION = { I: 1, II: 2, III: 3, IV: 4 };
const LANE_KO = { TOP: '탑', JUNGLE: '정글', MIDDLE: '미드', BOTTOM: '원딜', UTILITY: '서폿' };
const QUEUE_TAB = { all: '전체', solo: '솔랭', flex: '자랭', normal: '일반', aram: '칼바람', arena: '아레나' };
const MULTI_KO = { 2: '더블킬', 3: '트리플킬', 4: '쿼드라킬', 5: '펜타킬' };

function tierText(rank) {
  if (!rank) return '언랭크';
  const name = TIER_KO[rank.tier] ?? rank.tier;
  return APEX.has(rank.tier) ? name : `${name} ${DIVISION[rank.rank] ?? rank.rank}`;
}

function ratingText(r) {
  return r === null ? 'Perfect' : `${r.toFixed(2)}:1`;
}

function createLolRenderer({ fontDir = FONT_DIR } = {}) {
  let fonts = null;
  let painter = null;
  let unavailable = false; // 한 번 실패하면 다시 시도하지 않는다

  function load() {
    if (painter || unavailable) return painter;
    try {
      fonts = { regular: loadFont(path.join(fontDir, 'NanumGothic-Regular.ttf')), bold: loadFont(path.join(fontDir, 'NanumGothic-Bold.ttf')) };
      const fallback = loadFont(path.join(fontDir, 'DejaVuSans.ttf')); // 나눔고딕에 없는 글자(그리스 문자 등)는 이 폰트로
      fonts.regular.fallback = fallback; fonts.bold.fallback = fallback;
      painter = new Painter(W, H, RENDER_SCALE);
    } catch (err) {
      unavailable = true;
      console.error('롤 그림을 쓸 수 없어 글자 화면으로 대신합니다:', err.message);
    }
    return painter;
  }

  function draw(p, v) {
    const T = (s, x, y, o = {}) => p.text(o.bold ? fonts.bold : fonts.regular, String(s), x, y, { size: 20, color: C.text, align: 'left', ...o });
    const icons = v.icons ?? {};
    const names = v.names ?? {};
    const icon = (file, cx, cy, size, o) => drawIconFile(p, file, cx, cy, size, o);
    const holder = (cx, cy, size, round) => (round ? p.circle(cx, cy, size / 2, C.hole) : p.roundRect(cx - size / 2, cy - size / 2, size, size, 4, C.empty));
    const sum = v.summary;
    const now = v.now ?? Date.now();

    p.clear(C.bg);

    // ① 유저 정보
    p.roundRect(24, 24, 852, 126, 12, C.panel);
    holder(84, 82, 80, true);
    icon(icons.profile, 84, 82, 80, { circle: true });
    p.roundRect(54, 108, 60, 26, 13, '#0c0d11');
    T(v.level ?? '', 84, 121, { align: 'center', bold: true });
    T(v.name, 140, 64, { size: 34, bold: true, maxWidth: 250 });
    T(`#${v.tag}`, 140, 106, { size: 22, color: C.muted, maxWidth: 250 });
    const rankBox = (x, w, label, rank, emblem, big) => {
      p.roundRect(x, 36, w, 102, 10, C.panel2);
      holder(x + 38, 87, big ? 64 : 56, true);
      icon(emblem ?? (rank ? null : icons.unranked), x + 38, 87, big ? 64 : 56); // 랭크가 없으면 언랭크 엠블럼
      T(label, x + 76, 55, { color: C.muted, maxWidth: w - 84 });
      T(tierText(rank), x + 76, 80, { size: 24, bold: true, maxWidth: w - 84 });
      if (rank) {
        const g = rank.wins + rank.losses;
        T(`${rank.lp ?? 0} LP${g ? ` · ${Math.round(100 * rank.wins / g)}%` : ''}`, x + 76, 102, { maxWidth: w - 84 });
        T(`${rank.wins}승 ${rank.losses}패`, x + 76, 124, { color: C.muted, maxWidth: w - 84 });
      }
    };
    rankBox(400, 240, '솔로랭크', v.solo, icons.solo, true);
    rankBox(650, 226, '자유랭크', v.flex, icons.flex, false);

    // ② 간단 통계
    T(`최근 ${sum.games}판 · ${QUEUE_TAB[v.queue] ?? '전체'}`, 28, 174, { color: C.muted });
    p.roundRect(24, 194, 280, 170, 10, C.panel);
    p.roundRect(314, 194, 300, 170, 10, C.panel);
    p.roundRect(624, 194, 252, 170, 10, C.panel);
    if (sum.games > 0) {
      const frac = sum.wins / sum.games;
      const start = -Math.PI / 2;
      if (sum.wins > 0) p.fill(ringContours(98, 279, 52, 36, start, start + Math.PI * 2 * frac), C.winBar);
      if (sum.losses > 0) p.fill(ringContours(98, 279, 52, 36, start + Math.PI * 2 * frac, start + Math.PI * 2), C.loseBar);
      T(`${Math.round(100 * frac)}%`, 98, 279, { align: 'center', bold: true });
      T(`${sum.games}전 ${sum.wins}승 ${sum.losses}패`, 164, 238, { maxWidth: 134 });
      T(ratingText(sum.rating), 164, 280, { size: 28, bold: true, maxWidth: 134 });
      T(`${sum.avgK.toFixed(1)} / ${sum.avgD.toFixed(1)} / ${sum.avgA.toFixed(1)}`, 164, 322, { color: C.muted, maxWidth: 134 });
    } else {
      p.fill(ringContours(98, 279, 52, 36, 0, Math.PI * 2), C.hole);
      T('기록 없음', 164, 279, { color: C.muted });
    }
    sum.champs.forEach((c, i) => {
      const cy = 234 + i * 47;
      holder(350, cy, 40, true);
      icon(icons.champs?.[c.champ], 350, cy, 40, { circle: true });
      T(names[c.champ] ?? c.champ, 380, cy - 11, { bold: true, maxWidth: 226 });
      T(`${c.games}판 ${Math.round(100 * c.wins / c.games)}% · ${c.rating === null ? 'Perfect' : c.rating.toFixed(2)}`, 380, cy + 12, { color: C.muted, maxWidth: 226 });
    });
    T('선호 포지션', 644, 222, { color: C.muted });
    sum.positions.forEach((pos, i) => {
      const cy = 270 + i * 50;
      icon(icons.positions?.[pos.pos], 650, cy, 36); // 포지션 로고
      T(`${LANE_KO[pos.pos] ?? pos.pos} ${Math.round(100 * pos.games / sum.games)}%`, 676, cy, { size: 22, bold: true, maxWidth: 92 });
      T(`승률 ${Math.round(100 * pos.wins / pos.games)}%`, 862, cy, { align: 'right', color: C.muted, maxWidth: 84 });
    });

    // ③ 경기 목록
    v.matches.slice(0, 5).forEach((m, i) => {
      const y = 376 + i * 96, cy = y + 45;
      p.roundRect(24, y, 852, 90, 10, m.win ? C.win : C.lose);
      p.rect(24, y + 8, 6, 74, m.win ? C.winBar : C.loseBar);
      T(m.win ? '승리' : '패배', 44, cy - 26, { size: 24, bold: true, color: m.win ? C.winText : C.loseText });
      T(`${queueLabel(m.queue)} ${Math.round(m.dur / 60)}분`, 44, cy, { maxWidth: 124 });
      T(timeAgo(m.ts, now), 44, cy + 25, { color: C.muted, maxWidth: 124 });
      holder(222, cy, 60, true);
      icon(icons.champs?.[m.champ], 222, cy, 60, { circle: true });
      if (MULTI_KO[m.multi]) {
        p.roundRect(184, cy + 21, 76, 22, 11, C.loseBar);
        T(MULTI_KO[m.multi], 222, cy + 32, { align: 'center', bold: true, maxWidth: 70 });
      }
      [0, 1].forEach(k => { holder(278, cy - 16 + k * 32, 28, false); icon(icons.spells?.[m.spells?.[k]], 278, cy - 16 + k * 32, 28); });
      holder(314, cy - 16, 28, true); icon(icons.runes?.[m.keystone], 314, cy - 16, 28);
      holder(314, cy + 16, 24, true); icon(icons.styles?.[m.subStyle], 314, cy + 16, 24);
      T(`${m.k} / ${m.d} / ${m.a}`, 410, cy - 14, { align: 'center', size: 26, bold: true, maxWidth: 130 });
      const r = ratio(m.k, m.d, m.a);
      T(ratingText(r), 410, cy + 16, { align: 'center', color: r === null ? C.gold : C.muted, maxWidth: 130 });
      T(`CS ${m.cs} (${(m.cs / Math.max(1, m.dur / 60)).toFixed(1)})`, 480, cy - 26, { maxWidth: 108 });
      T(`킬관여 ${Math.round(100 * killParticipation(m))}%`, 480, cy, { color: C.red, maxWidth: 108 });
      T(`와드 ${m.vision}`, 480, cy + 26, { color: C.muted, maxWidth: 108 });
      for (let k = 0; k < 7; k++) {
        const cx = 614 + k * 39, id = m.items?.[k];
        holder(cx, cy, 36, k === 6);
        if (id) icon(icons.items?.[id], cx, cy, 36, k === 6 ? { circle: true } : undefined);
      }
    });

    T('Riot Games가 보증하지 않음 · 데이터: Riot API', 450, 884, { align: 'center', color: C.muted });
  }

  // PNG 한 장을 돌려준다. 폰트·그림판을 못 쓰거나 그리다 실패하면 null.
  function render(view) {
    const p = load();
    if (!p) return null;
    try {
      draw(p, view);
      return p.png();
    } catch (err) {
      console.error('롤 그림 그리기 실패(글자 화면으로 대신):', err);
      return null;
    }
  }

  return { render };
}

const defaultRenderer = createLolRenderer();
const renderLol = view => defaultRenderer.render(view);

module.exports = { renderLol, createLolRenderer, tierText };

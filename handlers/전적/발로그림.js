// 발로그림.js — 발로란트 경쟁전 전적(헤더 + 통계 격자 + 시즌별 기록)을 PNG 한 장으로 그린다. 롤 그림과 같은 그림판·같은 규칙.
const path = require('path');
const { Painter, loadFont } = require('../레이드/그림판');
const { drawIconFile } = require('./아이콘');

const W = 900;
const H = 860;
const RENDER_SCALE = 0.75;
const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
const C = { bg: '#14161c', panel: '#1f222b', panel2: '#272b36', text: '#ffffff', muted: '#9aa0ad', accent: '#ff4655', hole: '#3a3f4d', bar: '#2c303c' };

const TIER_KO = { iron: '아이언', bronze: '브론즈', silver: '실버', gold: '골드', platinum: '플래티넘', diamond: '다이아몬드', ascendant: '초월자', immortal: '불멸', radiant: '레디언트', unrated: '언랭크', unranked: '언랭크' };

// "Gold 2" → "골드 2", "" → "언랭크"
function tierKo(name) {
  if (!name) return '언랭크';
  const [word, ...rest] = name.trim().split(/\s+/);
  return [TIER_KO[word.toLowerCase()] ?? word, ...rest].join(' ');
}

// "e10a2" → "에피소드 10 · 액트 2" (읽을 수 없으면 그대로)
function seasonLabel(code) {
  const m = /^e(\d+)a(\d+)$/i.exec(String(code));
  return m ? `에피소드 ${m[1]} · 액트 ${m[2]}` : String(code);
}

function createValorantRenderer({ fontDir = FONT_DIR } = {}) {
  let fonts = null, painter = null, unavailable = false;

  function load() {
    if (painter || unavailable) return painter;
    try {
      fonts = { regular: loadFont(path.join(fontDir, 'NanumGothic-Regular.ttf')), bold: loadFont(path.join(fontDir, 'NanumGothic-Bold.ttf')) };
      painter = new Painter(W, H, RENDER_SCALE);
    } catch (err) {
      unavailable = true;
      console.error('발로란트 그림을 쓸 수 없어 글자 화면으로 대신합니다:', err.message);
    }
    return painter;
  }

  function draw(p, v) {
    const T = (s, x, y, o = {}) => p.text(o.bold ? fonts.bold : fonts.regular, String(s), x, y, { size: 20, color: C.text, align: 'left', ...o });
    const prof = v.profile;
    const tierIcon = name => v.tierIcons?.[String(name ?? '').trim().toLowerCase()] ?? null;
    const holder = (cx, cy, size) => p.circle(cx, cy, size / 2, C.hole);
    p.clear(C.bg);

    // 헤더
    p.roundRect(24, 24, 852, 146, 12, C.panel);
    p.rect(24, 40, 6, 114, C.accent);
    holder(100, 97, 104);
    drawIconFile(p, tierIcon(prof.tier), 100, 97, 104);
    T(prof.name || '발로란트', 170, 62, { size: 34, bold: true, maxWidth: 680 });
    T('경쟁전', 170, 100, { size: 22, color: C.muted });
    T(tierKo(prof.tier), 170, 136, { size: 30, bold: true, color: C.accent, maxWidth: 400 });

    // 통계 격자
    const games = prof.seasons.reduce((s, x) => s + x.games, 0);
    const wins = prof.seasons.reduce((s, x) => s + x.wins, 0);
    const stats = [['현재 RR', prof.rr !== null ? String(prof.rr) : '-'], ['최고 티어', prof.peak ? tierKo(prof.peak) : '-'], ['최근 승률', games ? `${Math.round(100 * wins / games)}%` : '-'], ['기록한 판', games ? `${games}판` : '-']];
    stats.forEach(([label, value], i) => {
      const x = 24 + i * 215.5;
      p.roundRect(x, 186, 205.5, 104, 10, C.panel);
      T(label, x + 18, 214, { color: C.muted, maxWidth: 170 });
      T(value, x + 18, 258, { size: 30, bold: true, maxWidth: 170 });
    });

    // 시즌별 기록(최근 시즌부터 5개)
    T('시즌별 기록', 28, 318, { color: C.muted });
    prof.seasons.slice(-5).reverse().forEach((s, i) => {
      const y = 340 + i * 96, cy = y + 45, rate = s.games ? s.wins / s.games : 0;
      p.roundRect(24, y, 852, 90, 10, C.panel2);
      holder(72, cy, 56);
      drawIconFile(p, tierIcon(s.endTier), 72, cy, 56);
      T(seasonLabel(s.season), 118, cy - 14, { size: 24, bold: true, maxWidth: 380 });
      T(`${tierKo(s.endTier)} · ${s.games}판 ${s.wins}승`, 118, cy + 18, { color: C.muted, maxWidth: 380 });
      p.roundRect(520, cy - 8, 200, 16, 8, C.bar);
      if (rate > 0) p.roundRect(520, cy - 8, Math.max(16, 200 * rate), 16, 8, C.accent);
      T(`승률 ${Math.round(100 * rate)}%`, 856, cy, { align: 'right', size: 22, bold: true, maxWidth: 120 });
    });

    T('Riot Games가 보증하지 않음 · 데이터: HenrikDev API · 아이콘: valorant-api.com', 450, 840, { align: 'center', color: C.muted, maxWidth: 840 });
  }

  function render(view) {
    const p = load();
    if (!p) return null;
    try {
      draw(p, view);
      return p.png();
    } catch (err) {
      console.error('발로란트 그림 그리기 실패(글자 화면으로 대신):', err);
      return null;
    }
  }

  return { render };
}

const defaultRenderer = createValorantRenderer();
const renderValorant = view => defaultRenderer.render(view);

module.exports = { renderValorant, createValorantRenderer, seasonLabel, tierKo };

// 발로그림.js — 발로란트 경쟁전 전적(유저 정보 · 최근 20판 통계 · 최근 5경기)을 PNG 한 장으로 그린다. 롤 그림과 같은 그림판·같은 규칙.
// 글자는 20px 이상(디스코드가 900px 그림을 채팅 폭으로 줄여 보여준다). 폰트·그림판을 못 쓰면 render 는 null.
const path = require('path');
const { Painter, loadFont } = require('../레이드/그림판');
const { drawIconFile } = require('./아이콘');
const { timeAgo, ringContours } = require('./표시');
const { summarizeValorant } = require('./발로집계');

const W = 900;
const H = 900;
const RENDER_SCALE = 0.75;
const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
const C = {
  bg: '#14161c', panel: '#1f222b', panel2: '#272b36', text: '#ffffff', muted: '#9aa0ad', accent: '#ff4655',
  win: '#16363a', winBar: '#2dd4bf', winText: '#6ee7d8', lose: '#44222a', loseBar: '#ff4655', loseText: '#ff8a7a', draw: '#2c303c', drawBar: '#9aa0ad',
  hole: '#3a3f4d',
};

const TIER_KO = { iron: '아이언', bronze: '브론즈', silver: '실버', gold: '골드', platinum: '플래티넘', diamond: '다이아몬드', ascendant: '초월자', immortal: '불멸', radiant: '레디언트', unrated: '언랭크', unranked: '언랭크' };
const RESULT = {
  win: { label: '승리', bg: C.win, bar: C.winBar, text: C.winText },
  loss: { label: '패배', bg: C.lose, bar: C.loseBar, text: C.loseText },
  draw: { label: '무승부', bg: C.draw, bar: C.drawBar, text: C.muted },
  none: { label: '', bg: C.draw, bar: C.drawBar, text: C.muted }, // 개인전(데스매치)은 승패가 없다
};

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

const kdText = kd => (kd === null ? 'Perfect' : kd.toFixed(2));

function createValorantRenderer({ fontDir = FONT_DIR } = {}) {
  let fonts = null, painter = null, unavailable = false;

  function load() {
    if (painter || unavailable) return painter;
    try {
      fonts = { regular: loadFont(path.join(fontDir, 'NanumGothic-Regular.ttf')), bold: loadFont(path.join(fontDir, 'NanumGothic-Bold.ttf')) };
      const fallback = loadFont(path.join(fontDir, 'DejaVuSans.ttf')); // 나눔고딕에 없는 글자(그리스 문자 등)는 이 폰트로
      fonts.regular.fallback = fallback; fonts.bold.fallback = fallback;
      painter = new Painter(W, H, RENDER_SCALE);
    } catch (err) {
      unavailable = true;
      console.error('발로란트 그림을 쓸 수 없어 글자 화면으로 대신합니다:', err.message);
    }
    return painter;
  }

  function draw(p, v) {
    const T = (s, x, y, o = {}) => p.text(o.bold ? fonts.bold : fonts.regular, String(s), x, y, { size: 20, color: C.text, align: 'left', ...o });
    const icon = (file, cx, cy, size, o) => drawIconFile(p, file, cx, cy, size, o);
    const holder = (cx, cy, size) => p.circle(cx, cy, size / 2, C.hole);
    const prof = v.profile, sum = v.summary, icons = v.icons ?? {}, names = v.names ?? {};
    const now = v.now ?? Date.now();
    p.clear(C.bg);

    // ① 유저 정보
    p.roundRect(24, 24, 852, 126, 12, C.panel);
    p.rect(24, 40, 6, 94, C.accent);
    holder(88, 87, 92);
    icon(icons.tier, 88, 87, 92);
    T(prof.name || '발로란트', 150, 56, { size: 34, bold: true, maxWidth: 700 });
    T(`${tierKo(prof.tier)}${prof.rr !== null ? ` · ${prof.rr} RR` : ''}`, 150, 94, { size: 28, bold: true, color: C.accent, maxWidth: 700 });
    T(prof.peak ? `경쟁전 · 최고 ${tierKo(prof.peak)}` : '경쟁전', 150, 124, { color: C.muted, maxWidth: 700 });

    // ② 간단 통계
    T(`최근 ${sum.games}판 · ${v.tab ?? '경쟁전'}`, 28, 174, { color: C.muted });
    p.roundRect(24, 194, 280, 170, 10, C.panel);
    p.roundRect(314, 194, 300, 170, 10, C.panel);
    p.roundRect(624, 194, 252, 170, 10, C.panel);
    const decided = sum.wins + sum.losses; // 승패가 있는 판(개인전·무승부는 빠짐)
    if (sum.games > 0) {
      const frac = decided ? sum.wins / decided : 0;
      const start = -Math.PI / 2;
      if (!decided) p.fill(ringContours(98, 279, 52, 36, 0, Math.PI * 2), C.hole);
      else {
        if (sum.wins > 0) p.fill(ringContours(98, 279, 52, 36, start, start + Math.PI * 2 * frac), C.winBar);
        if (sum.losses > 0) p.fill(ringContours(98, 279, 52, 36, start + Math.PI * 2 * frac, start + Math.PI * 2), C.loseBar);
      }
      T(decided ? `${Math.round(100 * frac)}%` : '-', 98, 279, { align: 'center', bold: true });
      T(`${sum.games}전 ${sum.wins}승 ${sum.losses}패`, 164, 238, { maxWidth: 134 });
      T(`K/D ${kdText(sum.kd)}`, 164, 280, { size: 28, bold: true, maxWidth: 134 });
      T(`${sum.avgK.toFixed(1)} / ${sum.avgD.toFixed(1)} / ${sum.avgA.toFixed(1)}`, 164, 322, { color: C.muted, maxWidth: 134 });
    } else {
      p.fill(ringContours(98, 279, 52, 36, 0, Math.PI * 2), C.hole);
      T('기록 없음', 164, 279, { color: C.muted });
    }
    sum.agents.forEach((a, i) => {
      const cy = 234 + i * 47;
      holder(350, cy, 40);
      icon(icons.agents?.[a.id], 350, cy, 40, { circle: true });
      T(names.agents?.[a.id] ?? a.name, 380, cy - 11, { bold: true, maxWidth: 226 });
      T(`${a.games}판 ${Math.round(100 * a.wins / a.games)}% · K/D ${kdText(a.kd)}`, 380, cy + 12, { color: C.muted, maxWidth: 226 });
    });
    [['ACS', Math.round(sum.acs)], ['ADR', Math.round(sum.adr)], ['헤드샷', `${Math.round(100 * sum.hs)}%`]].forEach(([label, value], i) => {
      const cy = 238 + i * 44;
      T(label, 644, cy, { color: C.muted });
      T(sum.games > 0 ? value : '-', 856, cy, { align: 'right', size: 24, bold: true, maxWidth: 120 });
    });

    // ③ 경기 목록
    v.matches.slice(0, 5).forEach((m, i) => {
      const y = 376 + i * 96, cy = y + 45, r = RESULT[m.result] ?? RESULT.draw;
      const rounds = m.rounds[0] + m.rounds[1] || 1;
      const shots = m.head + m.body + m.leg;
      p.roundRect(24, y, 852, 90, 10, r.bg);
      p.rect(24, y + 8, 6, 74, r.bar);
      // 왼쪽 칸: 승패(+스코어) / 모드 / 맵 · 시간. 개인전(승패 없음)은 모드 이름을 크게, 그 밑에 킬·데스.
      if (m.result === 'none') {
        T(m.modeLabel, 44, cy - 26, { size: 24, bold: true, color: r.text, maxWidth: 170 });
        T(`${m.k}킬 ${m.d}데스`, 44, cy, { maxWidth: 170 });
      } else {
        T(r.label, 44, cy - 26, { size: 24, bold: true, color: r.text });
        T(`${m.rounds[0]} : ${m.rounds[1]}`, 44 + p.textWidth(fonts.bold, r.label, 24) + 12, cy - 26, { size: 22, bold: true, maxWidth: 90 });
        T(m.modeLabel, 44, cy, { color: C.muted, maxWidth: 170 });
      }
      T(`${names.maps?.[m.map.id] ?? m.map.name} · ${timeAgo(m.ts, now)}`, 44, cy + 25, { color: C.muted, maxWidth: 170 });
      holder(252, cy, 60);
      icon(icons.agents?.[m.agent.id], 252, cy, 60, { circle: true });
      T(`${m.k} / ${m.d} / ${m.a}`, 380, cy - 14, { align: 'center', size: 26, bold: true, maxWidth: 130 });
      T(`K/D ${kdText(m.d > 0 ? m.k / m.d : null)}`, 380, cy + 16, { align: 'center', color: m.d > 0 ? C.muted : C.winText, maxWidth: 130 });
      T(m.hasRounds ? `ACS ${Math.round(m.score / rounds)}` : 'ACS -', 470, cy - 26, { maxWidth: 118 });
      T(m.hasRounds ? `ADR ${Math.round(m.dmg / rounds)}` : 'ADR -', 470, cy, { maxWidth: 118 });
      T(`HS ${shots ? Math.round(100 * m.head / shots) : 0}%`, 470, cy + 26, { color: C.muted, maxWidth: 118 });
      T(`점수 ${m.score}`, 600, cy - 14, { maxWidth: 130 });
      T(`피해 ${m.dmg}`, 600, cy + 16, { color: C.muted, maxWidth: 130 });
      if (m.tier > 0) { // 일반·데스매치 등은 티어가 없다(0)
        holder(820, cy, 50);
        icon(icons.tiers?.[m.tier], 820, cy, 50);
      }
    });

    T('Riot Games가 보증하지 않음 · 데이터: HenrikDev API', 450, 884, { align: 'center', color: C.muted, maxWidth: 840 });
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

  function warm() {
    return render(sampleView()) !== null;
  }

  return { render, warm };
}

// 미리 데우기용 샘플(아이콘 없이 그린다)
function sampleView() {
  const matches = [0, 1, 2, 3, 4].map(i => ({
    id: `W${i}`, ts: Date.now() - (i + 1) * 3600000, mode: 'Competitive', modeKey: 'comp', modeLabel: '경쟁전', hasRounds: true, map: { id: 'm', name: 'Bind' }, agent: { id: 'a', name: 'Jett' },
    tier: 0, k: 15, d: 12, a: 4, score: 4000, head: 10, body: 30, leg: 5, dmg: 2600, rounds: [13, 9], result: i % 2 ? 'loss' : 'win',
  }));
  return { profile: { name: '미리 데우기#KR1', tier: 'Gold 2', rr: 40, peak: 'Gold 3', seasons: [] }, summary: summarizeValorant(matches), matches, icons: {}, names: {}, tab: '전체' };
}

const defaultRenderer = createValorantRenderer();
const renderValorant = view => defaultRenderer.render(view);
const warmValorantRender = () => defaultRenderer.warm();

module.exports = { renderValorant, createValorantRenderer, seasonLabel, tierKo, warmValorantRender };

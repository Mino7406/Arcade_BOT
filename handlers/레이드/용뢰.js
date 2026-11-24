// 흉성(theme 'energy')의 용뢰 연출: 몸 둘레에 맥동하는 붉은 후광 + 매번 무작위로 튀는 붉은 번개.
// 그림을 그릴 때마다(= 화면마다) 시드가 달라 번개 모양이 바뀐다. 몸 뒤에 그려 몸이 위를 덮는다.
// rect(x, y, w, h, color): 그림 틀의 사각형 채우기. cell: 번개 한 칸 크기(px), bodyR: 몸 반지름(칸 수).
const COLORS = {
  g: '#8a1228', f: '#e8203a', y: '#ff6a6a', s: '#fff0ea', // 번개: 바깥 번짐·붉은 심·밝은 속·가장 밝은 점
  p: '#7a1a34', q: '#4a1230', t: '#2e1228',               // 후광: 안쪽 → 바깥쪽
  m: '#b9a68a', n: '#8d7d66',                            // 모래먼지: 밝은 쪽·어두운 쪽
};
const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

function makeRng(seed) { let s = (seed >>> 0) % 2147483647 || 1; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

// 자연스러운 번개: 중점 분할(큰 꺾임 → 잔 꺾임) + 앞쪽으로 갈라지는 가지
function subdivide(a, b, d, out, rnd) {
  if (d < 0.8 || Math.hypot(b[0] - a[0], b[1] - a[1]) < 2.2) { out.push(b); return; }
  const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy), o = (rnd() - 0.5) * 2 * d;
  const q = [m[0] - dy / L * o, m[1] + dx / L * o];
  subdivide(a, q, d * 0.55, out, rnd); subdivide(q, b, d * 0.55, out, rnd);
}

// 한 장면의 에너지를 만든다. 후광은 몸 픽셀 칸(coarse), 번개는 그 절반 칸(fine)이라 번개가 몸 픽셀보다 가늘게 보인다.
// 좌표는 몸 중심 기준: 후광 칸 단위는 {x,y}, 번개 칸 단위는 fine(= coarse × 2).
function buildEnergy(bodyR, seed, pulseK = 0, style = process.env.ENERGY_STYLE || 'radial', rage = false) {
  const rnd = makeRng(seed * 7919 + 13), glow = new Map(), bolts = new Map();
  const R2 = bodyR * 2; // fine 단위 몸 반지름
  const putB = (x, y, c) => { x = Math.round(x); y = Math.round(y); if (Math.hypot(x + 0.5, y + 0.5) < R2 + 0.5) return; bolts.set(x + ',' + y, c); };
  const seg = (a, b, c) => { const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), 1); for (let t = 0; t <= n; t++) putB(a[0] + (b[0] - a[0]) * t / n, a[1] + (b[1] - a[1]) * t / n, c); };
  // 후광(맥동): 완전한 원이 아니라 울퉁불퉁하고 군데군데 끊긴 기운(태양 고리처럼 보이지 않게)
  const secC = rnd() * Math.PI * 2; // side: 번개가 나오는 쪽의 가운데 각도
  const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28], gap0 = rnd() * 6.28, gapW = 0.5 + rnd() * 0.7;
  const rOf = (th) => bodyR + 4.5 + 1.3 * Math.sin(pulseK * 0.9) + 1.8 * Math.sin(th * 2 + ph[0]) + 1.2 * Math.sin(th * 3 + ph[1]) + 0.8 * Math.sin(th * 5 + ph[2]);
  const r0 = bodyR + 0.5, reach = Math.ceil(bodyR + 10);
  for (let y = -reach; y <= reach; y++) for (let x = -reach; x <= reach; x++) {
    const d = Math.hypot(x + 0.5, y + 0.5), th = Math.atan2(y + 0.5, x + 0.5), r1 = rOf(th); if (d < r0 || d > r1) continue;
    if (style === 'side') { if (Math.abs(Math.atan2(Math.sin(th - secC), Math.cos(th - secC))) > 1.5) continue; } // 한쪽에만
    else if (style === 'crackle') { if (d > bodyR + 3.5) continue; } // 몸에 바짝
    else if (style !== 'radial' && Math.abs(Math.atan2(Math.sin(th - gap0), Math.cos(th - gap0))) < gapW) continue; // 끊긴 부분
    const t = (d - r0) / (r1 - r0), th4 = BAYER[((y % 4) + 4) % 4][((x % 4) + 4) % 4] / 16; if (th4 >= 1 - t) continue;
    glow.set(x + ',' + y, t < 0.25 ? 'p' : t < 0.5 ? 'q' : 't');
  }
  // 번개 한 줄기: 굵은 줄기는 줄기 따라 붉은 번짐(끝으로 갈수록 가늘어짐), 속은 일정하게 밝고 가끔 하얗게 번쩍, 가지는 줄기 앞쪽으로 갈라짐
  function bolt(x0, y0, ang, len, depth) {
    const pts = [[x0, y0]]; subdivide([x0, y0], [x0 + Math.cos(ang) * len, y0 + Math.sin(ang) * len], len * 0.22, pts, rnd);
    const n = pts.length - 1;
    // 굵은 줄기(depth 0)는 2칸 폭의 붉은 줄기 + 가운데 밝은 속, 가지는 1칸 폭 붉은 줄기에 드문 밝은 점
    for (let i = 0; i < n; i++) {
      const t = i / n, a = pts[i], b = pts[i + 1];
      if (depth === 0 && t < 0.8) { seg([a[0] + 1, a[1]], [b[0] + 1, b[1]], 'f'); seg([a[0], a[1] + 1], [b[0], b[1] + 1], 'f'); seg([a[0] - 1, a[1] - 1], [b[0] - 1, b[1] - 1], 'g'); seg([a[0] + 2, a[1] + 1], [b[0] + 2, b[1] + 1], 'g'); }
      else if (depth === 1 && t < 0.7) seg([a[0] + 1, a[1]], [b[0] + 1, b[1]], 'f');
      seg(a, b, 'f');
    }
    for (let i = 0; i < n; i++) {
      const t = i / n;
      if (depth === 0 ? t < 0.85 : (i % 3 === 1)) seg(pts[i], pts[i + 1], (i % 5 === 2 && rnd() < 0.6) ? 's' : 'y');
    }
    if (depth < 2) {
      const nb = depth === 0 ? (rnd() < 0.7 ? 1 + Math.floor(rnd() * 2) : 0) : (rnd() < 0.35 ? 1 : 0);
      for (let k = 0; k < nb; k++) {
        const q = pts[Math.floor(n * (0.2 + 0.55 * rnd()))];
        bolt(q[0], q[1], ang + (rnd() < 0.5 ? -1 : 1) * (0.35 + rnd() * 0.35), len * (0.3 + rnd() * 0.25), depth + 1);
      }
    }
  }
  // 무작위가 자연스럽게 보이도록: ① 화면마다 기세가 다르다(잔잔 / 보통 / 폭주) ② 번개는 한두 군데 "뜨거운 쪽"으로 몰려 튄다
  // ③ 길이는 대부분 짧고 가끔 아주 길다 ④ 위·아래로 뻗는 번개는 패널 밖으로 안 나가게 짧다
  const used = [], mood = rnd(), scaleN = mood < 0.25 ? 0.75 : mood < 0.8 ? 1.15 : 1.6;
  const hot = Array.from({ length: 1 + Math.floor(rnd() * 2) }, () => rnd() * Math.PI * 2);
  const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;
  const pickAngle = (gap) => {
    let t, tries = 0;
    do { t = rnd() < 0.6 ? hot[Math.floor(rnd() * hot.length)] + gauss() * 0.9 : rnd() * Math.PI * 2; tries++; } while (tries < 40 && used.some(u => Math.abs(Math.atan2(Math.sin(t - u), Math.cos(t - u))) < gap));
    used.push(t); return t;
  };
  const lenOf = (base, spread) => { const k = rnd() < 0.15 ? 1.5 : 0.7 + rnd() * 0.5; return (base + rnd() * spread) * k; };
  const squash = (t) => 1 - 0.4 * Math.abs(Math.sin(t)); // 세로 방향일수록 짧게
  const at = (t, d) => [Math.cos(t) * d, Math.sin(t) * d];
  if (style === 'radial') {
    // 몸 둘레에 튀는 번개(사용자가 이상적이라고 고른 모양): 굵고 긴 줄기 몇 가닥이 한두 쪽으로 몰리고, 빈 쪽 몸 가장자리는 후광만 두른다.
    // 기세는 조금만 달라진다(잔잔 0.85 / 보통 1 / 폭주 1.2). 곧게 방사하지 않게 각도를 흔들고, 길이는 줄기마다 다르다.
    const k = (mood < 0.25 ? 0.85 : mood < 0.8 ? 1 : 1.2) * (rage ? 1.35 : 1); // 분노: 용뢰가 더 많이, 더 고르게 퍼져 튄다
    const lenR = (base, spread) => { const m = rnd() < 0.2 ? 1.5 : rnd() < 0.25 ? 0.65 : 0.85 + rnd() * 0.4; return (base + rnd() * spread) * m; };
    const pick = (gap) => { let t, tries = 0; do { t = rnd() < (rage ? 0.5 : 0.75) ? hot[Math.floor(rnd() * hot.length)] + gauss() * 0.75 : rnd() * Math.PI * 2; tries++; } while (tries < 40 && used.some(u => Math.abs(Math.atan2(Math.sin(t - u), Math.cos(t - u))) < (rage ? gap * 0.7 : gap))); used.push(t); return t; };
    const nMain = Math.max(3, Math.round((4 + Math.floor(rnd() * 3)) * k) + (rage ? 2 : 0));
    for (let i = 0; i < nMain; i++) { const t = pick(0.55); const [x, y] = at(t, R2 + 0.5); bolt(x, y, t + (rnd() - 0.5) * 1.0, lenR(16, 10) * squash(t), 0); }
    const nMid = Math.max(2, Math.round((3 + Math.floor(rnd() * 3)) * k) + (rage ? 3 : 0));
    for (let i = 0; i < nMid; i++) { const t = pick(0.35); const [x, y] = at(t, R2 + 0.5); bolt(x, y, t + (rnd() - 0.5) * 1.2, lenR(7, 6) * squash(t), 1); }
    const nArc = rnd() < 0.5 ? 0 : 1;
    for (let i = 0; i < nArc; i++) { const t = hot[0] + gauss() * 0.8, dir = rnd() < 0.5 ? 1 : -1; const [x, y] = at(t, R2 + 2); bolt(x, y, t + dir * (Math.PI / 2 - 0.25), 7 + rnd() * 6, 1); }
    if (rnd() < 0.4) { const t = rnd() * Math.PI * 2; const [x, y] = at(t, R2 + 5 + rnd() * 6); bolt(x, y, rnd() * Math.PI * 2, 3 + rnd() * 3, 2); }
  } else if (style === 'side') {
    // 한쪽 몰림: 번개가 몸의 한쪽 부채꼴에서만 길게 뻗고 갈라진다. 반대쪽 몸은 깨끗.
    const n = 4 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) { const t = secC + (rnd() - 0.5) * 2.2; const [x, y] = at(t, R2 + 0.5); bolt(x, y, t + (rnd() - 0.5) * 0.7, lenOf(14, 12) * squash(t), 0); }
    const m = 3 + Math.floor(rnd() * 3);
    for (let i = 0; i < m; i++) { const t = secC + (rnd() - 0.5) * 2.6; const [x, y] = at(t, R2 + 0.5); bolt(x, y, t + (rnd() - 0.5) * 1.0, lenOf(6, 6) * squash(t), 1); }
  } else if (style === 'wrap') {
    // 몸을 감싸는 번개: 몸 표면을 따라 길게 휘감아 돌고, 군데군데 바깥으로 가지가 튄다.
    const n = 3 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) { const t = rnd() * Math.PI * 2, dir = rnd() < 0.5 ? 1 : -1, g0 = R2 + 1.5 + rnd() * 5; const [x, y] = at(t, g0); bolt(x, y, t + dir * (Math.PI / 2 - 0.15), 14 + rnd() * 12, 1); }
    for (let i = 0; i < 2; i++) { const t = rnd() * Math.PI * 2; const [x, y] = at(t, R2 + 0.5); bolt(x, y, t, lenOf(8, 6) * squash(t), 1); }
  } else if (style === 'crackle') {
    // 정전기: 몸 표면에서 짧고 잦게 파직거리는 방전. 길게 뻗는 줄기는 없다.
    const n = Math.round((14 + Math.floor(rnd() * 8)) * scaleN * 0.8);
    for (let i = 0; i < n; i++) { const t = rnd() < 0.5 ? hot[Math.floor(rnd() * hot.length)] + gauss() * 1.3 : rnd() * Math.PI * 2; const [x, y] = at(t, R2 + 0.3); bolt(x, y, t + (rnd() - 0.5) * 2.2, 4 + rnd() * 5, 2); }
    for (let i = 0; i < 3; i++) { const t = rnd() * Math.PI * 2; const [x, y] = at(t, R2 + 0.5); bolt(x, y, t + (rnd() - 0.5), 8 + rnd() * 4, 1); }
  }
  return { glow, bolts, intensity: Math.min(1, Math.max(0, (scaleN - 0.6) / 1.0)) }; // 0(잔잔) ~ 1(폭주): 몸 색 변화에 쓴다
}

function drawEnergy(rect, cx, cy, bodyR, cell, seed, rage = false) {
  const { glow, bolts, intensity } = buildEnergy(bodyR, seed, seed, undefined, rage), half = cell / 2;
  const paint = (cells, size, keys) => { for (const key of keys) for (const [k, c] of cells) { if (c !== key) continue; const [x, y] = k.split(',').map(Number); const x0 = Math.round(cx + x * size), y0 = Math.round(cy + y * size); rect(x0, y0, Math.round(cx + (x + 1) * size) - x0, Math.round(cy + (y + 1) * size) - y0, COLORS[c]); } };
  paint(glow, cell, ['p', 'q', 't']);       // 후광 먼저
  paint(bolts, half, ['g', 'f', 'y', 's']); // 그 위에 번개(번짐 → 심 → 속 → 번쩍)
  return intensity;
}

// 번개가 퍼질 때 몸 색이 아주 조금 붉게 달아오른다: 몸 팔레트 글자(base)를 붉은빛과 섞은 색으로 돌려준다(약 12~20%, 밝아지지 않게 어두운 자줏빛과 섞음).
function bodyTint(palette, keys, intensity, boost = 1) {
  const k = Math.min(0.5, 0.2 * (0.6 + 0.4 * intensity) * boost), red = [150, 30, 70], out = {};
  for (const ch of keys) {
    const hex = palette[ch]; if (!hex) continue;
    const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    out[ch] = '#' + c.map((v, i) => Math.round(v + (red[i] - v) * k).toString(16).padStart(2, '0')).join('');
  }
  return out;
}


// 돌덩이(용뢰를 모으는 중): 아주 은은한 연출 — 몸 가까이 희미한 후광만 두르고(불씨·방전은 사용자 요청으로 뺌),
// 충돌한 자리에서 아주 살짝 피어오르는 모래먼지. (groundDy: 몸 중심에서 땅(밑동)까지 칸 수)
function drawFaint(rect, cx, cy, bodyR, cell, seed, groundDy = bodyR * 0.8) {
  const rnd = makeRng(seed * 4813 + 7), half = cell / 2, gy = groundDy * 2; // gy: 땅 윗면 높이(fine 칸) — 그 아래(땅속)엔 아무것도 그리지 않는다
  const put = (x, y, c, size = half) => { if (y * size / half >= gy) return; const x0 = Math.round(cx + x * size), y0 = Math.round(cy + y * size); rect(x0, y0, Math.round(cx + (x + 1) * size) - x0, Math.round(cy + (y + 1) * size) - y0, c); };
  // 희미한 후광: 몸 바로 바깥 두 칸, 성긴 디더링
  const r0 = bodyR + 0.3, r1 = bodyR + 2.6 + 0.6 * Math.sin(seed * 0.9);
  for (let y = -Math.ceil(r1); y <= Math.ceil(r1); y++) for (let x = -Math.ceil(r1); x <= Math.ceil(r1); x++) {
    const d = Math.hypot(x + 0.5, y + 0.5); if (d < r0 || d > r1) continue;
    const t = (d - r0) / (r1 - r0), th = BAYER[((y % 4) + 4) % 4][((x % 4) + 4) % 4] / 16; if (th >= 0.55 * (1 - t)) continue;
    put(x, y, t < 0.5 ? COLORS.q : COLORS.t, cell);
  }
  // 모래먼지: 땅과 돌이 만나는 자리에서 아주 살짝, 성긴 점으로 위·바깥으로 번진다(그릴 때마다 모양이 다름)
  const puffs = 3 + Math.floor(rnd() * 3);
  for (let i = 0; i < puffs; i++) {
    const side = rnd() < 0.5 ? -1 : 1, px = Math.round(side * (bodyR * 1.1 + rnd() * bodyR * 1.3)), py = Math.round(gy - 1 - rnd() * 5), size = 1 + Math.floor(rnd() * 2);
    for (let a = 0; a < size + 1; a++) for (let b = 0; b < size + 1; b++) if (rnd() < 0.5) put(px + a * side, py - b, rnd() < 0.5 ? COLORS.m : COLORS.n);
  }
}

module.exports = {drawFaint,  drawEnergy, buildEnergy, bodyTint };

// 표시.js — 롤·발로란트 이미지가 같이 쓰는 그리기 도구(몇 분/시간 전 글자, 승패 도넛 조각 윤곽선).
const { Painter } = require('../레이드/그림판');

function timeAgo(ts, now) {
  const min = Math.max(0, (now - ts) / 60000);
  if (min < 60) return `${Math.max(1, Math.round(min))}분 전`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}시간 전`;
  if (min < 30 * 24 * 60) return `${Math.floor(min / 1440)}일 전`;
  return `${Math.floor(min / 43200)}달 전`;
}

// 도넛 한 조각의 윤곽선(a0~a1 라디안). 한 바퀴면 바깥 원 + 거꾸로 감은 안쪽 원(구멍).
function ringContours(cx, cy, ro, ri, a0, a1) {
  const sweep = a1 - a0;
  const n = Math.max(8, Math.ceil(Math.abs(sweep) * 20));
  const pts = (r, from, to, steps) => { const out = []; for (let k = 0; k <= steps; k++) { const a = from + (to - from) * (k / steps); out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r); } return out; };
  if (sweep >= Math.PI * 2 - 1e-6) return [pts(ro, a0, a0 + Math.PI * 2, 48), Painter.reversed(pts(ri, a0, a0 + Math.PI * 2, 48))];
  return [[...pts(ro, a0, a1, n), ...Painter.reversed(pts(ri, a0, a1, n))]];
}

module.exports = { timeAgo, ringContours };

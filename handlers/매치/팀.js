// 팀.js — 내전 "팀 짜기" 카드(팀표).
//
// 사람들은 내전이 마감되면 내전채팅으로 넘어가 메모장에 팀을 짜서 붙여넣는다(윤진-승훈-시형-연우-강현 / ...).
// 승패나 판 번호는 귀찮아서 안 쓰니, 카드는 "지금 팀" 하나와 작게 보이는 "이전 팀표"만 둔다.
//  - 📝 팀 입력: 칸 하나짜리 입력창. 지금 팀(처음엔 마감 때 자동으로 나눈 팀)이 채워져 있어 바꿀 사람만 고치면 된다.
//  - ⚖️ 밸런스: 저장된 티어로 두 팀 점수 차가 가장 작게 나눈다(롤·발로만).
//  - 🎲 랜덤: 무작위로 두 팀.
//  - 🏅 내 티어 설정: 내 티어를 골라 저장한다(롤·발로만). 팀 입력에 "승훈 불2"처럼 적어도 자동으로 저장된다.
// 팀이 바뀔 때마다 카드는 지우고 맨 아래에 다시 올린다(채팅에 묻히지 않게). 티어만 바뀌면 그 자리에서 고친다.
//
// 카드는 내전이 마감되면 자동으로 올라가고(공용.js markClosed → setCloseHook), 주최자 관리 메뉴의 📌 팀 불러오기로 끌어올릴 수 있다.
// 기록: match.board = { channelId, messageId, current: { teams, at, by, how } | null, history: [같은 모양 …] }
// 팀원은 사람이 적은 이름 글자 그대로 두고, 그릴 때 참가자 이름과 맞춰 보며 티어를 붙인다.

const fs = require('fs');
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
} = require('discord.js');
const {
  ADMIN_IDS,
  getNaejeonMatches: getMatches,
  gameThumb,
  deleteBoardShortcut,
  setCloseHook,
  saveNow,
} = require('./공용');
const { card, notice, payload, emojiUrl, COLORS } = require('../공통/카드');
const { logError } = require('../공통/로그');
const { displayNameFromInteraction } = require('../공통/이름');
const { NAEJEON_CHAT_CHANNEL_IDS = {}, GAME_EMOJIS = {} } = require('../../config');
const tiers = require('./티어');
const maps = require('./맵');
const mapReel = require('./맵연출');

const MAX_TEAMS = 10;
const MAX_MEMBERS = 15;
const HISTORY_KEPT = 10;
const TEAM_ICONS = ['🔵', '🔴', '🟢', '🟡', '🟣', '🟠', '⚪', '🟤', '⚫', '🩷'];
const OLD_UI_NOTE = '⚠️ **팀 짜기 방식이 바뀌었어요.** 내전이 마감되면 내전채팅에 팀 짜기 카드가 자동으로 올라가요.';
const HOW_TEXT = { input: '✏️ 직접 입력', balance: '⚖️ 밸런스', random: '🎲 랜덤' };

// ── 이름 ────────────────────────────────────────────────────

// 이름을 입력창에 넣을 때 구분 기호(띄어쓰기·- 등)와 겹치지 않게 지운다: "코리안갱씥 이경민" → "코리안갱씥이경민"
function nameToken(name) {
  return String(name).replace(/[\s,，\-·|/]+/g, '') || '?';
}

// 적힌 이름 → 참가자. 정확히 같거나, 아니면 그 글자를 포함하는 참가자가 딱 한 명일 때(강현 → 강현숭이).
function resolveMember(name, participants) {
  const key = nameToken(name).replace(/\(.*\)$/, '');
  const exact = participants.filter(u => nameToken(u.displayName) === key);
  if (exact.length === 1) return exact[0];
  if (key.length < 2) return null;
  const partial = participants.filter(u => nameToken(u.displayName).includes(key));
  return partial.length === 1 ? partial[0] : null;
}

// ── 붙여넣은 글 읽기 ─────────────────────────────────────────

// 롤·발로가 아닌 게임에서 티어처럼 생긴 글자(불2·다3 …)는 이름이 아니라 바로 앞 사람에게 글자로 붙인다: "승훈(불2)"
const GENERIC_TIER_RE = /^(아|브|실|골|플|에|다|초|불|레|마|그|챌)[1-5]$/;
// 줄 맨 앞의 팀 이름: [공수] / 1팀 / 팀1 / 1팀: / A팀 - 같은 것
const BRACKET_NAME_RE = /^\[([^\]]{1,20})\]\s*/;
const NUMBERED_NAME_RE = /^(\d{1,2}\s*팀|팀\s*\d{1,2}|[A-Za-z]\s*팀)\s*[:：\-]?\s*/;
const COLON_NAME_RE = /^([^\s:：]{1,10})\s*[:：]\s*/;
// "1." "2)" 처럼 번호만 있는 줄(로비 구분)은 건너뛴다
const LOBBY_LINE_RE = /^\d{1,2}\s*[.)]?$/;

function parseTeamLine(line, game, hints) {
  let rest = line;
  let name = null;
  let m;
  if ((m = BRACKET_NAME_RE.exec(rest))) { name = m[1].trim(); rest = rest.slice(m[0].length); }
  else if ((m = NUMBERED_NAME_RE.exec(rest))) { rest = rest.slice(m[0].length); }
  else if ((m = COLON_NAME_RE.exec(rest))) { name = m[1].trim(); rest = rest.slice(m[0].length); }

  const members = [];
  for (const token of rest.split(/[\s,，\-·|]+/).filter(Boolean)) {
    const tier = tiers.parseTierToken(game, token);
    if (tier && members.length > 0) { hints.push({ name: members[members.length - 1], tier }); continue; }
    if (!tiers.hasTiers(game) && GENERIC_TIER_RE.test(token) && members.length > 0) { members[members.length - 1] += `(${token})`; continue; }
    // "승훈(불2)"처럼 이름에 붙여 쓴 티어
    const glued = /^(.+?)\(([^()]+)\)$/.exec(token);
    const gluedTier = glued && tiers.parseTierToken(game, glued[2]);
    if (gluedTier) { members.push(glued[1]); hints.push({ name: glued[1], tier: gluedTier }); continue; }
    members.push(token);
  }
  return { name, members };
}

// 성공: { teams: [{ name, members }], hints: [{ name, tier }] } / 실패: { error: '안내 문구' }
function parseTeamsText(raw, { game } = {}) {
  const segments = String(raw || '')
    .split(/\r?\n/)
    .flatMap(line => line.split(/\s*\/\s*|\s+vs\s+/i))
    .map(s => s.trim())
    .filter(s => s && !LOBBY_LINE_RE.test(s));

  const hints = [];
  let teams = segments.map(s => parseTeamLine(s, game, hints)).filter(t => t.members.length > 0);

  // 줄을 안 나누고 한 줄에 전원을 적었으면 앞에서부터 반씩 두 팀으로 나눈다(홀수면 앞 팀이 한 명 더).
  if (teams.length === 1 && teams[0].members.length >= 2) {
    const all = teams[0].members;
    const half = Math.ceil(all.length / 2);
    teams = [{ name: null, members: all.slice(0, half) }, { name: null, members: all.slice(half) }];
  }

  const error = validateTeams(teams);
  return error ? { error } : { teams, hints };
}

// 팀 수·인원·겹친 이름 확인. 문제 있으면 안내 문구, 없으면 null.
function validateTeams(teams) {
  if (teams.length < 2) return '팀을 나누려면 이름이 **두 명 이상** 있어야 해요.\n예)\n```\n윤진-승훈-시형-연우-강현\n현호-찬영-찬우-승민-채원\n```';
  if (teams.length > MAX_TEAMS) return `팀은 최대 ${MAX_TEAMS}개까지 적을 수 있어요.`;
  const big = teams.find(t => t.members.length > MAX_MEMBERS);
  if (big) return `한 팀은 최대 ${MAX_MEMBERS}명까지예요. (\`${big.members.slice(0, 3).join(' ')} …\` 줄 확인)`;

  const seen = new Set();
  const dups = new Set();
  for (const t of teams) for (const n of t.members) {
    const key = n.replace(/\(.*?\)$/, '');
    if (seen.has(key)) dups.add(key);
    seen.add(key);
  }
  if (dups.size > 0) return `두 번 적힌 이름이 있어요: **${[...dups].join(', ')}**`;
  return null;
}

// ✏️ 직접 입력의 팀별 칸(칸 하나 = 팀 하나, 한 줄에 한 명)을 읽는다.
//   탑 승훈 다2   ← 역할(그 자리로 고정) · 이름 · 티어(저장). 역할·티어는 둘 다 빼도 된다.
//   구분은 띄어쓰기·없음·- , / · | : . 괄호 등 아무거나: "탑승훈다2" "탑-승훈-다2" "탑,승훈" "승훈(다2)" "승훈 탑"(역할을 뒤에)
//   [공수]        ← 첫 줄을 대괄호로 쓰면 팀 이름
// 참가자 이름과 정확히 같은 글자는 쪼개지 않는다(이름이 "미드라"여도 미드+라 로 읽지 않게).
// 한 칸에만 "윤진-승훈-…"처럼 한 줄에 여러 명씩 예전 방식으로 붙여넣으면 줄마다 한 팀으로 예전처럼 읽는다.
// 성공: { teams: [{ name, members, pos? }], hints } / 실패: { error }
const LINE_SPLIT_RE = /[\s,，、\-–—·•|/:：.~=()（）]+/;

// 역할 글자 목록(긴 것부터) — 붙여 쓴 "탑승훈"에서 앞을 떼어 낼 때
function positionAliases(game) {
  const list = game === 'overwatch' ? tiers.OW_ROLES : tiers.POSITIONS[game] || [];
  return list.flatMap(p => p.aliases.map(a => ({ alias: a, key: p.key }))).sort((a, b) => b.alias.length - a.alias.length);
}

// 낱말 하나 → { name, slot, tier }. 앞에 붙은 역할, 뒤에 붙은 티어를 떼어 낸다(참가자 이름과 같으면 그대로).
function splitGlued(token, game, isName) {
  let name = token; let slot = null; let tier = null;
  if (isName(name)) return { name, slot, tier };
  if (tiers.hasPositions(game)) {
    const hit = positionAliases(game).find(({ alias }) => name.startsWith(alias) && name.length > alias.length);
    if (hit) { slot = hit.key; name = name.slice(hit.alias.length); }
  }
  if (!isName(name) && tiers.hasTiers(game)) {
    for (let i = 1; i < name.length; i++) { // 가장 긴 티어 꼬리부터: "승훈다이아2" → 승훈 + 다이아2
      const tr = tiers.parseTierToken(game, name.slice(i));
      if (tr) { tier = tr; name = name.slice(0, i); break; }
    }
  }
  return { name, slot, tier };
}

// 한 줄 → [{ name, slot }] (보통 한 명, "윤진 승훈"처럼 여러 명이면 여러 개). 티어는 hints 에 쌓는다.
function parseMemberLine(line, game, hints, isName, isKnown = isName) {
  const words = line.split(LINE_SPLIT_RE).filter(Boolean);
  const out = [];
  let pendingSlot = null;
  words.forEach((w, i) => {
    const asSlot = tiers.hasPositions(game) && !isName(w) ? tiers.parsePositionToken(game, w) : null;
    if (asSlot && (words.length > 1)) { // 따로 적은 역할: 이름 앞이면 다음 사람, 뒤면 바로 앞 사람
      const last = out[out.length - 1];
      if (last && !last.slot && i > 0 && !pendingSlot) last.slot = asSlot; else pendingSlot = asSlot;
      return;
    }
    const asTier = !isName(w) ? tiers.parseTierToken(game, w) : null;
    if (asTier && out.length) { hints.push({ name: out[out.length - 1].name, tier: asTier }); return; }
    const g = splitGlued(w, game, isKnown);
    if (!g.name) return;
    out.push({ name: g.name, slot: pendingSlot || g.slot });
    pendingSlot = null;
    if (g.tier) hints.push({ name: g.name, tier: g.tier });
  });
  return out;
}

function parseTeamBoxes(boxes, { game, participants = [] } = {}) {
  const names = new Set(participants.map(u => nameToken(u.displayName)));
  const isName = w => names.has(w); // 참가자 이름과 정확히 같음(역할·티어 낱말과 헷갈릴 때 이름으로 침)
  // 붙여 쓴 글자를 쪼갤지 정할 땐 별명 줄임(김잔우 → 잔우)도 이름으로 친다 — resolveMember 와 같은 기준(포함하는 참가자가 한 명)
  const isKnown = w => isName(w) || !!resolveMember(w, participants);
  const filled = boxes.map(b => String(b || '').trim()).filter(Boolean);
  // 예전 방식: 칸 하나에만 적었고, 줄마다 이름이 둘 이상(팀 한 줄)이거나 / vs 로 팀을 나눴을 때
  if (filled.length === 1) {
    const lines = filled[0].split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^\[[^\]]+\]$/.test(l));
    const teamLike = lines.length > 0 && lines.every(l => parseMemberLine(l, game, [], isName, isKnown).length >= 2);
    if (teamLike || /\s\/\s|\svs\s/i.test(filled[0])) return parseTeamsText(filled[0], { game });
  }

  const hints = [];
  const teams = filled.map(box => {
    const lines = box.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let name = null;
    const head = /^\[([^\]]{1,20})\]$/.exec(lines[0] || '');
    if (head) { name = head[1].trim(); lines.shift(); }
    const members = [];
    const pos = [];
    for (const line of lines) {
      for (const m of parseMemberLine(line, game, hints, isName, isKnown)) { members.push(m.name); pos.push(m.slot); }
    }
    return { name, members, ...(pos.some(Boolean) ? { pos } : {}) };
  }).filter(t => t.members.length > 0);

  const error = validateTeams(teams);
  return error ? { error } : { teams, hints };
}

// 입력창에 채워 줄 글(한 줄에 한 팀).
function teamsToText(teams) {
  return teams.map(t => `${t.name ? `[${t.name}] ` : ''}${t.members.join('-')}`).join('\n');
}

// ── 팀 나누기 ───────────────────────────────────────────────

function splitHalf(names) {
  const half = Math.ceil(names.length / 2);
  return [{ name: null, members: names.slice(0, half) }, { name: null, members: names.slice(half) }];
}

// 참가자 → 입력창에 쓸 이름. 표시 이름이 같은 사람이 있으면 뒤에 숫자를 붙여 구분한다(윤진, 윤진2).
// 그대로 두면 입력창을 제출할 때 "두 번 적힌 이름" 오류가 난다.
function participantTokens(participants) {
  const seen = new Map();
  const out = new Map();
  for (const u of participants) {
    const base = nameToken(u.displayName);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    out.set(u.id, n === 1 ? base : `${base}${n}`);
  }
  return out;
}

// 첫 초안: 마감된 참가자를 참가 순서대로 앞에서부터 반씩.
function draftTeams(participants) {
  const tok = participantTokens(participants);
  return splitHalf(participants.map(u => tok.get(u.id)));
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomTeams(participants) {
  const tok = participantTokens(participants);
  return splitHalf(shuffle(participants).map(u => tok.get(u.id)));
}

// 참가자마다 점수. 티어를 모르는 사람은 아는 사람들의 중간값(아무도 모르면 0)으로 친다.
// open: 오버워치 6vs6(자유) — 자유 티어를 먼저 쓴다
function participantScores(participants, game, { open = false } = {}) {
  const known = participants.map(u => tiers.tierScore(game, open ? tiers.openTier(u.id) : tiers.getTier(u.id, game)));
  const sorted = known.filter(s => s !== null).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  return known.map(s => (s === null ? median : s));
}

// ── 포지션 배정 ─────────────────────────────────────────────
// 롤·오버워치에서 팀 인원이 맞으면 자리를 하나씩 맡긴다.
//  - 롤 5명: 탑~서폿
//  - 오버워치 5명(5vs5): 돌격1·공격2·지원2
//  - 오버워치 6명(6vs6)은 자유(오픈 큐)라 역할을 정해 주지 않고, 사람마다 자유 티어(없으면 가장 높은 역할 티어)로 계산한다
// 맡긴 자리가 그 사람 생각과 얼마나 다른지를 "비용"으로 매겨, 밸런스 때 티어 차이에 더해 함께 줄인다(티어 한 단계 = 1).
const LINEUP_SLOTS = {
  lol: { 5: ['top', 'jungle', 'mid', 'adc', 'support'] },
  overwatch: { 5: ['tank', 'damage', 'damage', 'support', 'support'] },
};
const isOwOpen = (game, size) => game === 'overwatch' && size === 6; // 6vs6 자유
const slotsFor = (game, size) => LINEUP_SLOTS[game]?.[size] ?? null;
const POS_SUB_COST = 1;   // 롤: 부 포지션을 맡음(포지션을 더 중요하게 보려고 티어 한 단계만큼)
const POS_OFF_COST = 2.5; // 롤: 주·부 둘 다 아닌 자리 / 오버워치: 티어를 저장 안 한 롤
const POS_DUP_COST = 2;   // 자리 배정이 없는 경우(롤 5명이 아닌 팀·발로란트): 한 팀에 같은 주 포지션이 겹칠 때 겹친 사람마다
const POS_CAP_COST = 20;  // 발로란트: 한 팀에 같은 역할이 2명을 넘으면 넘친 사람마다(밸런스보다 훨씬 중요하게 — 피할 방법이 없을 때만 생김)
const OW_OFF_ROLE = 2;    // 오버워치: 저장 안 한 롤을 맡으면 가장 높은 롤 티어에서 이만큼 낮춰 계산

function uniquePerms(list) {
  const out = [];
  const walk = (rest, acc) => {
    if (!rest.length) { out.push(acc); return; }
    const used = new Set();
    rest.forEach((x, i) => {
      if (used.has(x)) return;
      used.add(x);
      walk([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, x]);
    });
  };
  walk(list, []);
  return out;
}
const SLOT_PERMS = new Map(); // 'overwatch:6' → 자리 순열(처음 쓸 때 한 번 만든다)
function slotPerms(game, size) {
  const slots = slotsFor(game, size);
  if (!slots) return null;
  const key = `${game}:${size}`;
  if (!SLOT_PERMS.has(key)) SLOT_PERMS.set(key, uniquePerms(slots));
  return SLOT_PERMS.get(key);
}

// 자리 하나에서의 { cost, score }. base 는 그 사람의 기본 점수(티어 모르면 중간값).
function slotFit(user, game, slot, base) {
  if (game === 'lol') {
    const prefs = user?.id ? tiers.getPositions(user.id, 'lol') : [];
    const cost = !prefs.length || prefs[0] === slot ? 0 : prefs[1] === slot ? POS_SUB_COST : POS_OFF_COST;
    return { cost, score: base };
  }
  const roleTier = user?.id ? tiers.getTier(user.id, `overwatch.${slot}`) : null;
  if (roleTier) return { cost: 0, score: tiers.tierScore(game, roleTier) };
  const hasRoles = !!user?.id && tiers.hasRoleQueueTier(user.id);
  return hasRoles ? { cost: POS_OFF_COST, score: base - OW_OFF_ROLE } : { cost: 0, score: base };
}

// 한 팀(users, 같은 순서의 기본 점수 bases)의 가장 잘 맞는 자리 배정. 해당 없으면 null.
// → { slots: [사람마다 자리], cost, sum: 그 자리 기준 점수 합 }
// pins: 사람마다 ✏️ 직접 입력으로 고정한 자리(없으면 null). 고정이 서로 부딪혀(탑 둘 등) 맞는 배정이 없으면 고정을 무시한다.
function lineup(users, game, bases, pins = []) {
  const all = slotPerms(game, users.length);
  if (!all) return null;
  const pinned = all.filter(perm => perm.every((slot, i) => !pins[i] || pins[i] === slot));
  const perms = pinned.length ? pinned : all;
  const fits = users.map((u, i) => Object.fromEntries(slotsFor(game, users.length).map(slot => [slot, slotFit(u, game, slot, bases[i])])));
  let best = null;
  for (const perm of perms) {
    let cost = 0; let sum = 0;
    perm.forEach((slot, i) => { cost += fits[i][slot].cost; sum += fits[i][slot].score; });
    if (!best || cost < best.cost - 1e-9) best = { slots: perm, cost, sum };
  }
  return best;
}

// 두 팀 점수 합 차이(+ 포지션 비용)가 가장 작은 조합(같은 값이 여럿이면 그중 무작위). 20명까지는 전부 비교한다.
function balanceTeams(participants, game) {
  const n = participants.length;
  const order = shuffle(participants.map((u, i) => i)); // 같은 차이 중 고를 때 매번 다르게
  const users = order.map(i => participants[i]);
  const scores = participantScores(users, game, { open: isOwOpen(game, Math.ceil(n / 2)) }); // 오버워치 6vs6 은 자유 티어로
  const total = scores.reduce((a, b) => a + b, 0);
  const size = Math.ceil(n / 2);
  // 포지션을 저장한 사람이 있는 롤·발로란트는 자리 배정이 없는 팀(인원이 5명이 아니거나 발로)도 주 포지션이 겹치지 않게 맞춘다.
  const posGame = (game === 'lol' || game === 'valorant') && participants.some(u => tiers.getPositions(u.id, game).length);
  const withLineup = !!(slotsFor(game, size) || slotsFor(game, n - size)) || posGame;

  // 한 팀의 { sum, cost }: 5명이면 자리를 맡긴 기준(오버워치는 그 롤 티어), 아니면 그냥 합
  const evalTeam = idxs => {
    const lu = lineup(idxs.map(i => users[i]), game, idxs.map(i => scores[i]));
    if (lu) return { sum: lu.sum, cost: lu.cost };
    const sum = idxs.reduce((a, i) => a + scores[i], 0);
    if (!posGame) return { sum, cost: 0 };
    const seen = new Map();
    for (const i of idxs) {
      const main = tiers.getPositions(users[i].id, game)[0];
      if (main) seen.set(main, (seen.get(main) || 0) + 1);
    }
    let dup = 0;
    for (const c of seen.values()) if (c > slotCap(game)) dup += c - slotCap(game); // 발로란트는 같은 역할 2명까지는 겹쳐도 됨, 3명째부터가 넘침
    return { sum, cost: dup * (game === 'valorant' ? POS_CAP_COST : POS_DUP_COST) };
  };

  let best = [];
  let bestDiff = Infinity;
  if (n <= 20) {
    const pick = [];
    const walk = (start, sum) => {
      if (pick.length === size) {
        let diff;
        if (withLineup) {
          const inA = new Set(pick);
          const a = evalTeam(pick);
          const b = evalTeam(users.map((u, i) => i).filter(i => !inA.has(i)));
          diff = Math.abs(a.sum - b.sum) + a.cost + b.cost;
        } else {
          diff = Math.abs(total - 2 * sum);
        }
        if (diff < bestDiff - 1e-9) { bestDiff = diff; best = [[...pick]]; }
        else if (Math.abs(diff - bestDiff) < 1e-9 && best.length < 50) best.push([...pick]);
        return;
      }
      for (let i = start; i <= n - (size - pick.length); i++) {
        if (pick.length === 0 && i > 0 && n % 2 === 0) break; // 짝수면 첫 사람을 늘 팀 1에 둬서 거울 조합을 건너뛴다
        pick.push(i);
        walk(i + 1, sum + scores[i]);
        pick.pop();
      }
    };
    walk(0, 0);
  } else {
    // 많으면 점수 높은 순으로 합이 작은 팀에 넣는다
    const a = []; const b = []; let sa = 0; let sb = 0;
    for (const i of users.map((u, i) => i).sort((x, y) => scores[y] - scores[x])) {
      if ((sa <= sb && a.length < size) || b.length >= n - size) { a.push(i); sa += scores[i]; } else { b.push(i); sb += scores[i]; }
    }
    best = [a];
  }
  const chosen = new Set(best[Math.floor(Math.random() * best.length)]);
  const t1 = users.filter((u, i) => chosen.has(i));
  const t2 = users.filter((u, i) => !chosen.has(i));
  const tok = participantTokens(participants);
  return [{ name: null, members: t1.map(u => tok.get(u.id)) }, { name: null, members: t2.map(u => tok.get(u.id)) }];
}

// ── 카드 ────────────────────────────────────────────────────

function normalizeBoard(match) {
  if (!match.board) match.board = { channelId: null, messageId: null, current: null, history: [] };
  const b = match.board;
  if (Array.isArray(b.rounds)) { // 판 번호를 쓰던 첫 버전에서 옮겨 오기
    b.current = b.rounds.at(-1) ?? null;
    b.history = b.rounds.slice(0, -1).reverse();
    delete b.rounds;
  }
  if (!Array.isArray(b.history)) b.history = [];
  if (b.current === undefined) b.current = null;
  // 아직 아무도 팀을 안 정했으면 초안을 만들어 둔다(한 번 만들면 그대로, 참가자가 바뀌었으면 다시).
  // 자동으로 나눈 팀도 #1 처럼 순번을 받고, 다음에 팀을 바꾸면 내전 내역에 남는다.
  if (!b.current) {
    b.count = (b.count || 0) + 1;
    b.current = { ...makeDraft(match), no: b.count };
  } else if (b.current.draft && !sameMembers(b.current.teams, match.participants)) {
    b.current = { ...makeDraft(match), no: b.current.no ?? ((b.count = (b.count || 0) + 1)) }; // 참가자가 바뀌면 같은 순번으로 다시 나눔
  }
  return b;
}

function sameMembers(teams, participants) {
  const a = teams.flatMap(t => t.members).sort().join('|');
  const b = [...participantTokens(participants).values()].sort().join('|');
  return a === b;
}

// 초안: 티어가 절반 이상 저장돼 있으면 ⚖️ 밸런스, 아니면(또는 티어 없는 게임이면) 🎲 랜덤.
function makeDraft(match) {
  const game = match.data.game;
  const ps = match.participants;
  const known = tiers.hasTiers(game) ? ps.filter(u => tiers.getTier(u.id, game)).length : 0;
  const canBalance = tiers.hasTiers(game) && ps.length >= 2 && known >= Math.ceil(ps.length / 2);
  const teams = ps.length < 2 ? draftTeams(ps) : canBalance ? balanceTeams(ps, game) : randomTeams(ps);
  return { teams, how: canBalance ? 'balance' : 'random', at: Date.now(), draft: true };
}

// 카드에 보여 줄 팀의 자리 배정. 롤·오버워치 팀 인원이 맞고, 누구라도 포지션(오버워치는 역할 티어)을 저장했거나 직접 고정한 자리가 있을 때만.
function teamLineup(resolved, game, match, pins = []) {
  if (!slotsFor(game, resolved.length)) return null;
  const hasData = pins.some(Boolean) || resolved.some(u => u && (game === 'lol' ? tiers.getPositions(u.id, 'lol').length : tiers.hasRoleQueueTier(u.id)));
  if (!hasData) return null;
  const allScores = participantScores(match.participants, game);
  const byId = new Map(match.participants.map((u, i) => [u.id, allScores[i]]));
  const median = [...allScores].sort((a, b) => a - b)[Math.floor(allScores.length / 2)] ?? 0;
  return lineup(resolved, game, resolved.map(u => (u ? byId.get(u.id) ?? median : median)), pins);
}

// 팀원마다 맡은 자리 키(자리 배정 → 직접 고정 → 롤·발로는 저장한 주 포지션 순서로). 없으면 null.
// 롤도 팀 인원이 5명이 아니면 자리 배정이 없어서, 저장한 주 포지션을 보여 준다.
// 발로란트는 역할이 고정이 아니라(들어가서 겹치면 누군가 맞춰 줌) 자리 배정을 하지 않는다: 직접 입력으로 고정한 것만 자리로 치고,
// 카드에는 저장한 주·부 역할(가능한 역할 2개)을 티어 앞에 보여 준다(teamBlocks).
function memberSlots(t, resolved, game, lu) {
  if (lu) return t.members.map((n, k) => lu.slots[k]);
  const pins = t.pos || [];
  if (game === 'valorant') return t.members.map((n, k) => pins[k] || null);
  const slots = t.members.map((n, k) => {
    if (pins[k]) return pins[k];
    if (game === 'lol' && resolved[k]) return tiers.getPositions(resolved[k].id, game)[0] ?? null;
    return null;
  });
  return autoFillSlots(slots, game);
}

// 한 팀에 같은 자리를 맡을 수 있는 최대 인원: 발로란트는 역할마다 2명까지, 롤은 자리마다 1명
const slotCap = (game) => (game === 'valorant' ? 2 : 1);

// 비어 있는 사람에게 줄 자리: 자리가 남은 것 중 맡은 사람이 가장 적은 것(동률이면 포지션 목록 순서). 다 찼으면(6명 이상 등) 가장 적은 것.
function pickSlot(list, count, game) {
  const open = list.filter(p => count.get(p.key) < slotCap(game));
  const pool = open.length ? open : list;
  return pool.reduce((best, p) => (count.get(p.key) < count.get(best.key) ? p : best), pool[0]).key;
}

// 포지션(역할)을 안 정한 사람은 자동으로 정해 준다: 팀에서 아직 맡은 사람이 적은 자리부터 채워 한 팀에 같은 자리가 몰리지 않게 한다.
// 포지션을 비워 둔 건 "아무거나 좋다"는 뜻이라, 팀에 아무도 안 정했어도 전부 정해 준다. 롤만.
function autoFillSlots(slots, game) {
  const list = game === 'lol' ? tiers.POSITIONS?.[game] : null;
  if (!list?.length || slots.every(Boolean)) return slots;
  const count = new Map(list.map(p => [p.key, 0]));
  for (const s of slots) if (s && count.has(s)) count.set(s, count.get(s) + 1);
  return slots.map(s => {
    if (s) return s;
    const key = pickSlot(list, count, game);
    count.set(key, count.get(key) + 1);
    return key;
  });
}

// 자리 표시: 포지션 아이콘. 아이콘 이모지가 있으면 아이콘만(카드가 짧게), 없으면 글자(오버워치는 🛡️ 돌격처럼)
function slotLabel(game, slot) {
  if (!slot || !tiers.hasPositions(game)) return '';
  const name = tiers.positionName(game, slot);
  if (!name) return '';
  return tiers.positionEmojiId(game, slot) ? tiers.positionIcon(game, slot) : `${tiers.positionIcon(game, slot)} ${name}`.trim();
}

// 팀 하나 = 카드 한 칸. 큰 팀 제목 옆에 팀 평균 티어(이모지 + 티어) → 한 명씩 한 줄(티어 이모지 + 굵은 이름 + 티어 + 자리).
// 롤·오버워치 5명 팀은 맡은 자리 순서(탑→서폿, 탱→딜→힐)로 줄을 세우고, 오버워치는 맡은 롤의 티어를 보여 준다.
// 팀이 많으면(5팀 이상) 카드 부품 수 제한에 걸리지 않게 한 칸에 몰아 짧게 쓴다.
function teamBlocks(teams, match) {
  const game = match.data.game;
  const withTiers = tiers.hasTiers(game);
  const compact = teams.length > 4;
  const texts = teams.map((t, i) => {
    const resolved = t.members.map(n => resolveMember(n, match.participants));
    const lu = withTiers && !compact ? teamLineup(resolved, game, match, t.pos || []) : null;
    const slots = memberSlots(t, resolved, game, lu);
    const memberTiers = resolved.map((u, k) => {
      if (!withTiers || !u) return null;
      if (game === 'overwatch' && slots[k]) return tiers.getTier(u.id, `overwatch.${slots[k]}`) ?? tiers.getTier(u.id, game); // 맡은 역할의 티어
      if (isOwOpen(game, t.members.length)) return tiers.openTier(u.id); // 6vs6 자유: 자유 티어(없으면 가장 높은 역할 티어)
      return tiers.getTier(u.id, game);
    });
    const scores = memberTiers.map(tr => tiers.tierScore(game, tr)).filter(x => x !== null && x !== undefined);
    const avgTier = scores.length ? tiers.tierFromScore(game, scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    const avgEmoji = avgTier && tiers.tierEmojiTag(game, avgTier);
    const avg = avgTier ? `${avgEmoji ? `${avgEmoji} ` : ''}${tiers.tierLabel(game, avgTier)}` : ''; // 팀 평균 티어: <이모지> 다이아몬드4
    const title = `${TEAM_ICONS[i] ?? '▫️'} ${t.name ? escapeMarkdown(t.name) : `${i + 1} 팀`}`;
    if (compact) {
      const names = t.members.map((n, k) => `${memberTiers[k] ? `${tiers.tierBadge(game, memberTiers[k])} ` : ''}${escapeMarkdown(n)}`);
      return `**${title}**${avg ? `　·　${avg}` : ''}\n${names.join(' · ')}`;
    }
    const order = t.members.map((n, k) => k);
    if (lu) { const order0 = slotsFor(game, t.members.length); order.sort((a, b) => order0.indexOf(lu.slots[a]) - order0.indexOf(lu.slots[b])); }
    // 역할 아이콘은 맨 앞 한 칸에 세로로 맞춘다: [역할] [티어] 이름 · 티어
    // 역할이 없는 사람(발로 미저장 등)은 투명 아이콘으로 칸을 채워 줄이 들쭉날쭉하지 않게 한다.
    // 아이콘 이모지가 아직 없으면(봇 등록 전) 예전처럼 이름 뒤에 글자로 붙인다.
    const blank = tiers.blankIcon();
    // 발로란트: 역할이 고정이 아니라 가능한 역할 2개(주·부)를 티어 앞에 나란히 보여 준다(직접 입력으로 고정한 건 그 하나). 한 칸이 모자라면 투명 아이콘으로 맞춘다.
    const valRoles = game === 'valorant' ? t.members.map((n, k) => (slots[k] ? [slots[k]] : resolved[k] ? tiers.getPositions(resolved[k].id, game).slice(0, 2) : [])) : null;
    const iconCol = valRoles
      ? valRoles.some(r => r.length) && valRoles.every(r => r.every(x => tiers.positionEmojiId(game, x)))
      : slots.some(Boolean) && slots.every(s => (s ? tiers.positionEmojiId(game, s) : blank));
    const lines = order.map(k => {
      const n = t.members[k];
      const tr = memberTiers[k];
      const slot = valRoles ? valRoles[k].map(x => slotLabel(game, x)).filter(Boolean).join(' ') : slotLabel(game, slots[k]);
      const lead = !iconCol ? '' : valRoles ? `${[0, 1].map(r => (valRoles[k][r] ? slotLabel(game, valRoles[k][r]) : blank)).join('')} ` : `${slots[k] ? slot : blank} `;
      const tail = slot && !iconCol ? ` · ${slot}` : '';
      if (!withTiers) return `▸ **${escapeMarkdown(n)}**`;
      if (!tr) return `${lead}❓ **${escapeMarkdown(n)}**${tail}`;
      const emoji = tiers.tierEmojiTag(game, tr);
      return `${lead}${emoji || '▸'} **${escapeMarkdown(n)}** · *${tiers.tierLabel(game, tr)}*${tail}`; // [자리] [티어] 이름 · 기울임 티어
    });
    return `### ${title}${avg ? `　·　${avg}` : ''}\n${lines.length ? `>>> ${lines.join('\n')}` : '-# 없음'}`; // 팀원은 인용 블록(왼쪽 세로 막대)으로 묶는다, 빈 팀은 "없음"
  });
  return compact ? [texts.join('\n\n')] : texts;
}

function buildBoardRows(match, matchMsgId) {
  const game = match.data.game;
  const board = normalizeBoard(match);
  const buttons = [new ButtonBuilder().setCustomId(`team:input:${matchMsgId}`).setLabel('✏️ 직접 입력').setStyle(ButtonStyle.Primary)];
  if (tiers.hasTiers(game)) buttons.push(new ButtonBuilder().setCustomId(`team:balance:${matchMsgId}`).setLabel('⚖️ 밸런스').setStyle(ButtonStyle.Secondary));
  buttons.push(new ButtonBuilder().setCustomId(`team:random:${matchMsgId}`).setLabel('🎲 랜덤').setStyle(ButtonStyle.Secondary));
  // 내전 내역(나만 보이는 창으로 열림): 첫 줄 맨 끝. 내역이 없으면 눌러지지 않는다.
  const n = board.history.length;
  buttons.push(new ButtonBuilder().setCustomId(`team:hist:${matchMsgId}`).setLabel(n ? `📜 내전 내역 (${n})` : '📜 내전 내역').setStyle(ButtonStyle.Secondary).setDisabled(!n));
  // 두 번째 줄: 내 티어 설정(롤·발로·오버워치·배그), 🗺️ 맵 뽑기(발로란트·오버워치)
  const second = [];
  if (tiers.hasTiers(game)) second.push(new ButtonBuilder().setCustomId(`team:tier:${game}:${matchMsgId}`).setLabel('🏅 내 티어 설정').setStyle(ButtonStyle.Success));
  if (maps.hasMapPool(game)) {
    // 맵 뽑기는 누르는 순간부터 5분간 잠긴다(연출 중 포함). 풀리는 시각에 카드가 스스로 고쳐진다(scheduleMapUnlock).
    const spinning = mapSpin.has(matchMsgId);
    const locked = spinning || mapLocked(match);
    const label = `${locked ? '🔒' : '🎰'} 맵 뽑기`; // 글자는 그대로, 앞 이모지만 바뀐다(평소 🎰, 뽑는 중·5분 잠금 🔒)
    second.push(new ButtonBuilder().setCustomId(`team:map:${matchMsgId}`).setLabel(label).setStyle(ButtonStyle.Secondary).setDisabled(locked));
  }
  return [new ActionRowBuilder().addComponents(...buttons), ...(second.length ? [new ActionRowBuilder().addComponents(...second)] : [])];
}

// 🗺️ 맵 뽑기 연출 중인 매치: matchMsgId → { key, n }(지금 보이는 프레임). 카드가 연출 도중 다시 그려져도(티어 변경 등) 같은 프레임을 그린다.
const mapSpin = new Map();

const MAP_LOCK_MS = 5 * 60 * 1000; // 맵 뽑기 버튼은 누른 때부터 5분간 잠긴다
let mapNow = () => Date.now();      // 테스트에서 시계를 바꿀 수 있게
let mapSleep = (ms) => new Promise(r => setTimeout(r, ms));
const mapLocked = (match) => !!match.board?.map && mapNow() - match.board.map.at < MAP_LOCK_MS;

// 카드의 맵 구역이 지금 보여 줄 것: 연출 중이면 그 프레임(첫 프레임 전엔 없음), 아니면 저장된 결과(final), 없으면 null.
function mapFrameOf(matchMsgId, match) {
  const game = match.data.game;
  if (!maps.hasMapPool(game)) return null;
  const spin = mapSpin.get(matchMsgId);
  if (spin) return spin.key ? { key: spin.key, n: spin.n, png: spin.png, final: false } : null;
  const saved = match.board?.map;
  return saved && saved.game === game ? { key: saved.key, n: 0, final: true } : null;
}

function buildBoardPayload(match, matchMsgId) {
  const { gameInfo, title, game } = match.data;
  const board = normalizeBoard(match);
  const cur = board.current;
  const blocks = [];

  // 지금 팀의 순번·방식·시각은 카드 맨 위 부제 줄에 붙인다(따로 "팀 현황" 제목을 두지 않아 카드가 짧아지게).
  // 마감 때 자동으로 나눈 팀(draft)도 똑같이 보여 주고, 티어가 부족해 랜덤으로 나눈 경우만 이유를 한 줄 덧붙인다.
  const when = cur.at ? ` <t:${Math.floor(cur.at / 1000)}:t>` : '';
  const status = `${cur.no ? `**#${cur.no}** ` : ''}${HOW_TEXT[cur.how] ?? HOW_TEXT.input}${when}`;
  if (cur.draft && cur.how === 'random' && tiers.hasTiers(game)) blocks.push('-# 티어가 저장된 사람이 적어서 무작위로 나눴어요. 🏅 내 티어 설정 후 ⚖️ 밸런스를 눌러 보세요.');
  blocks.push(...teamBlocks(cur.teams, match));

  if (tiers.hasTiers(game)) {
    const unknown = match.participants.filter(u => !tiers.getTier(u.id, game)).map(u => escapeMarkdown(u.displayName));
    // 누가 미지정인지 잘 보이게 이름은 보통 크기·굵게, 안내만 작은 글씨로
    if (unknown.length) blocks.push({ text: `❓ 티어 미지정 : ${unknown.map(n => `**${n}**`).join(' · ')}\n-# (⚖️ 티어를 저장하면 밸런스가 정확해져요)`, noDivider: true });
  }

  // 내전 내역은 카드가 길어지지 않게 두 번째 줄의 📜 버튼으로 따로 본다(buildHistoryPayload).

  // 🗺️ 맵 구역: 이미지(연출 중엔 이름 없는 원본, 확정되면 이름이 박힌 결과) + 한 줄 글. 이미지 파일이 없으면 글만 보인다.
  // 이미지는 카드를 고칠 때마다 다시 보내야 하고(안 보내면 사라짐), 파일명이 같으면 디스코드가 옛 그림을 재사용해서 프레임마다 다르게 한다.
  const files = [];
  const frame = mapFrameOf(matchMsgId, match);
  if (frame) {
    const file = frame.final ? maps.mapResultFile(game, frame.key) : null;
    const attName = frame.final ? 'map-final.jpg' : `map-${frame.n}.png`;
    const hasImage = frame.final ? fs.existsSync(file) : !!frame.png;
    blocks.push(frame.final ? '## 맵 뽑기 완료' : '## 🎰 맵 뽑는 중...'); // 구역 맨 위 헤더(이미지 위)
    if (hasImage) {
      blocks.push({ image: `attachment://${attName}`, noDivider: true });
      files.push(new AttachmentBuilder(frame.final ? file : frame.png, { name: attName }));
    }
    // 맵 이름은 결과 이미지에 박혀 있어서 따로 글을 붙이지 않는다. 이미지가 없을 때만 이름 한 줄.
    if (frame.final && !hasImage) blocks.push({ text: `🗺️ **${maps.mapName(game, frame.key)}**` });
  }

  return payload(card({
    color: gameInfo.color,
    header: title,
    sub: [gameInfo.name, status],
    thumb: gameThumb(gameInfo),
    thumbAlt: gameInfo.name,
    blocks,
    footer: '✏️ 직접 입력에 지금 팀과 역할이 채워져 있어요 · 바꿀 사람만 고치면 돼요',
    rows: buildBoardRows(match, matchMsgId),
  }), files.length ? { files } : {});
}

// 📜 내전 내역(나만 보이는 메시지): 순번(#3)·직전 표시·시각(몇 분 전)·방식 한 줄 + 팀별 인용 줄. 내역마다 칸을 띄워 구분한다.
// 나만 보이는 창이라 내역은 지우는 버튼 없이, 새로 나눌 때마다 쌓이다가 가장 오래된 것부터 밀려난다(HISTORY_KEPT).
function buildHistoryPayload(match, matchMsgId) {
  const { gameInfo, title } = match.data;
  const board = normalizeBoard(match);
  const blocks = [];
  if (!board.history.length) {
    blocks.push('-# 아직 내전 내역이 없어요. 팀을 다시 나누면 이전 팀이 여기에 쌓여요.');
  } else {
    blocks.push({ text: `### 📜 내전 내역 (${board.history.length})` });
    board.history.forEach((h, k) => {
      const no = h.no ? `#${h.no}` : '이전';
      const tag = k === 0 ? ' · 직전 팀' : '';
      const sec = h.at ? Math.floor(h.at / 1000) : null;
      const when = sec ? ` · <t:${sec}:t> (<t:${sec}:R>)` : '';
      const how = HOW_TEXT[h.how] ? ` · ${HOW_TEXT[h.how]}` : '';
      const teams = h.teams.map((t, i) => `> ${TEAM_ICONS[i] ?? '▫️'} : ${t.members.length ? t.members.map(n => `**${escapeMarkdown(n)}**`).join(' · ') : '없음'}`).join('\n'); // 🔵 : **이름** · **이름**
      blocks.push({ text: `**${no}${tag}**${when}${how}\n${teams}`, noDivider: true });
    });
  }
  return payload(card({
    color: gameInfo.color,
    header: '📜 내전 내역',
    sub: [title],
    blocks,
  }), { ephemeral: true });
}

// ── 카드 올리기 ─────────────────────────────────────────────

async function fetchChannel(client, id) {
  return client.channels.cache.get(id) || await client.channels.fetch(id).catch(() => null);
}

async function resolveBoardChannel(client, match) {
  const configured = NAEJEON_CHAT_CHANNEL_IDS[match.guildId];
  if (configured) {
    const ch = await fetchChannel(client, configured);
    if (ch?.isTextBased?.()) return ch;
  }
  const guild = client.guilds?.cache?.get(match.guildId);
  const byName = guild?.channels?.cache?.find?.(c => c.isTextBased?.() && c.name?.includes('내전채팅'));
  if (byName) return byName;
  return match.message?.channel ?? null;
}

// 카드를 (지우고) 맨 아래에 새로 올린다. 올린 메시지를 돌려준다.
// 두 사람이 동시에 눌러도 옛 카드를 둘 다 못 지우고 새 카드가 두 장 생기지 않게, 매치마다 한 번에 하나씩 처리한다.
const boardQueues = new Map();
function postBoard(client, matchMsgId, match) {
  const prev = boardQueues.get(matchMsgId) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => postBoardNow(client, matchMsgId, match));
  boardQueues.set(matchMsgId, run);
  run.finally(() => { if (boardQueues.get(matchMsgId) === run) boardQueues.delete(matchMsgId); }).catch(() => {});
  return run;
}

async function postBoardNow(client, matchMsgId, match) {
  const board = normalizeBoard(match);
  if (board.channelId && board.messageId) {
    const oldCh = await fetchChannel(client, board.channelId);
    const old = oldCh && await oldCh.messages.fetch(board.messageId).catch(() => null);
    if (old) await old.delete().catch(() => {});
  }
  const channel = await resolveBoardChannel(client, match);
  if (!channel) throw new Error('팀 짜기 카드를 올릴 채널을 찾지 못함');
  const msg = await channel.send(buildBoardPayload(match, matchMsgId));
  board.channelId = msg.channelId;
  board.messageId = msg.id;
  saveNow(client);
  await postBoardShortcut(client, match, msg);
  return msg;
}

// 게임모집 채널의 내전 게시글에 "팀 설정이 올라왔어요" 바로가기를 답장으로 단다(내전채팅이 다른 채널일 때만).
// 처음 한 번만 새로 달고, 팀 카드가 다시 올라갈 때(밸런스·랜덤·직접 입력)는 이미 단 바로가기의 링크만 새 카드로 고쳐 둔다
// (새 메시지로 또 달면 게임모집 채널에 같은 안내가 계속 쌓인다). 실패해도 팀 짜기 카드에는 영향이 없다.
async function postBoardShortcut(client, match, boardMsg) {
  try {
    if (!match.message || match.message.channelId === boardMsg.channelId) return;
    const payload = buildBoardShortcutPayload(match, boardMsg, { style: 'plain' });
    if (match.boardShortcutId) {
      const ch = client.channels.cache.get(match.message.channelId) || await client.channels.fetch(match.message.channelId).catch(() => null);
      const old = ch && await ch.messages.fetch(match.boardShortcutId).catch(() => null);
      if (old) {
        await old.edit(payload);
        return;
      }
    }
    const reply = await match.message.reply({ ...payload, failIfNotExists: false });
    match.boardShortcutId = reply.id;
    saveNow(client);
  } catch (err) {
    console.error('팀 짜기 바로가기 게시 실패:', err);
  }
}

// 누가 티어·포지션을 바꾸면(내 티어 설정·/티어·초기화 어디서든) 그 사람이 들어 있는 팀 짜기 카드를 바로 고친다.
// 한 번 설정에 저장이 여러 번 일어나도(오버워치 역할 등) 카드는 한 번만 고치도록 사람마다 잠깐 모았다가 처리한다.
// 클라이언트는 팀·티어 화면을 처음 누른 순간 기억해 둔다(그 화면을 통해서만 티어가 바뀌므로 빠질 일이 없다).
let boardClient = null;
const tierRefreshTimers = new Map();
const TIER_REFRESH_DELAY_MS = 700;
function rememberClient(interaction) {
  if (interaction?.client) boardClient = interaction.client;
}
tiers.onChange(userId => {
  if (!boardClient || tierRefreshTimers.has(userId)) return;
  const client = boardClient;
  tierRefreshTimers.set(userId, setTimeout(async () => {
    tierRefreshTimers.delete(userId);
    for (const [id, m] of getMatches(client)) {
      if (!m.board?.messageId || !m.participants?.some(u => u.id === userId)) continue;
      rebalanceForTierChange(m);
      await refreshBoard(client, id, m).catch(() => {});
    }
  }, TIER_REFRESH_DELAY_MS));
});

// 티어가 바뀌면 자동으로 나눈 팀(자동 초안·⚖️ 밸런스)은 새 티어로 밸런스를 다시 맞춘다. 순번·내역은 그대로 두고 지금 팀만 바꾼다.
// 직접 입력한 팀(✏️)과 🎲 랜덤으로 나눈 팀은 사람이 정한 것이라 건드리지 않고 표시(티어 배지)만 새로 그린다.
function rebalanceForTierChange(match) {
  const cur = match.board?.current;
  const game = match.data.game;
  if (!cur || !tiers.hasTiers(game) || match.participants.length < 2) return;
  if (cur.how === 'input' || (cur.how === 'random' && !cur.draft)) return;
  if (cur.draft) {
    match.board.current = { ...makeDraft(match), no: cur.no }; // 티어가 모이면 랜덤 초안이 밸런스로 바뀐다
    return;
  }
  cur.teams = balanceTeams(match.participants, game);
  cur.at = Date.now();
}

// 카드 내용만 고친다(자리는 그대로).
async function refreshBoard(client, matchMsgId, match) {
  const board = match?.board;
  if (!board?.channelId || !board.messageId) return;
  const ch = await fetchChannel(client, board.channelId);
  const msg = ch && await ch.messages.fetch(board.messageId).catch(() => null);
  if (msg) await msg.edit(buildBoardPayload(match, matchMsgId)).catch(() => {});
}

// 봇이 켜질 때: 이미 올라가 있는 팀 짜기 카드를 지금 티어 DB·지금 디자인으로 다시 그린다(꺼져 있던 동안 바뀐 티어도 반영).
// 한꺼번에 고치면 디스코드 제한에 걸리므로 하나씩 천천히 처리하고, 실패한 카드는 건너뛴다.
async function refreshAllBoards(client) {
  boardClient = client;
  for (const [id, m] of getMatches(client)) {
    if (!m.board?.messageId) continue;
    await refreshBoard(client, id, m).catch(() => {});
    if (mapLocked(m)) scheduleMapUnlock(client, id, m); // 재시작 전에 뽑은 맵의 5분 잠금이 남아 있으면 풀리는 시각에 카드를 다시 고친다
    await new Promise(r => setTimeout(r, 300));
  }
}

// 마감되면 자동으로 한 번 올린다. 마감 해제 후 다시 마감돼도 이미 있으면 그대로 둔다.
setCloseHook('내전', async (matchMsgId, match) => {
  if (match.board?.messageId) return;
  if ((match.participants?.length ?? 0) < 2) return; // 혼자·빈 내전은 팀을 나눌 게 없다(필요하면 📌 팀 불러오기)
  const client = match.message?.client;
  if (!client) return;
  await postBoard(client, matchMsgId, match);
});

// ── 권한 ────────────────────────────────────────────────────

// 카드 메시지를 지금 상태로 한 번 고친다(연출 한 프레임). 메시지를 못 찾으면 던진다 — 연출을 멈추게.
async function editBoardNow(client, matchMsgId, match) {
  const board = match.board;
  if (!board?.channelId || !board?.messageId) throw new Error('카드 메시지를 모름');
  const ch = await fetchChannel(client, board.channelId);
  const msg = ch && await ch.messages.fetch(board.messageId).catch(() => null);
  if (!msg) throw new Error('카드 메시지를 못 찾음');
  await msg.edit(buildBoardPayload(match, matchMsgId));
}

// 🗺️ 맵 뽑기 연출: 결과를 먼저 저장(연출 중 봇이 꺼져도 다음 카드에 보임)하고, 돌아가는 프레임을 점점 느리게 보여 준 뒤 이름이 박힌 확정 이미지로 끝낸다.
// 카드 수정이 실패하면(메시지가 지워짐 등) 연출만 멈추고 결과는 그대로 둔다. 끝나면 잠금이 풀리는 시각에 카드를 한 번 고친다.
// 맵 뽑기 미리 데우기: "돌리겠습니까?" 확인 창이 떠 있는 동안 당첨 맵을 정하고 연출 프레임을 미리 그려 둬서, "돌리기"를 누르면 바로 돈다.
// 확인 창을 닫거나 3분이 지나면 버린다(프레임 8~10장 ≈ 5MB + 카드 그림 캐시).
const mapPrep = new Map(); // matchMsgId → { picked, strip, offsets, frames, ready }
function dropMapPrep(matchMsgId) {
  const prep = mapPrep.get(matchMsgId);
  if (!prep) return null;
  clearTimeout(prep.timer);
  mapPrep.delete(matchMsgId);
  return prep;
}
function prepareMapSpin(matchMsgId, game) {
  dropMapPrep(matchMsgId);
  const picked = maps.pickMap(game);
  const { strip, offsets } = maps.reelPlan(game, picked.key);
  const prep = { game, picked, strip, offsets, frames: [] };
  prep.ready = (async () => {
    for (const off of offsets) { await new Promise(r => setImmediate(r)); prep.frames.push(mapReel.frame(game, strip, off)); } // 프레임 사이에 숨을 돌려 다른 요청을 막지 않는다
  })().catch(() => {});
  prep.timer = setTimeout(() => { if (mapPrep.get(matchMsgId) === prep) { mapPrep.delete(matchMsgId); if (!mapSpin.has(matchMsgId)) mapReel.clearReelCache(); } }, 3 * 60 * 1000);
  prep.timer.unref?.();
  mapPrep.set(matchMsgId, prep);
}

async function runMapSpin(client, matchMsgId, match, ack = null) {
  const game = match.data.game;
  try {
    let prep = dropMapPrep(matchMsgId);
    if (prep && prep.game !== game) prep = null;
    const picked = prep?.picked ?? maps.pickMap(game);
    normalizeBoard(match).map = { game, key: picked.key, at: mapNow() };
    saveNow(client);
    const plan = prep ?? { ...maps.reelPlan(game, picked.key), frames: [] };
    await prep?.ready;
    for (let i = 0; i < plan.offsets.length; i++) {
      const png = plan.frames[i] ?? mapReel.frame(game, plan.strip, plan.offsets[i]); // 카드가 다시 그려져도 같은 그림이 나오게 프레임을 들고 있는다
      mapSpin.set(matchMsgId, { key: picked.key, n: i + 1, png });
      await editBoardNow(client, matchMsgId, match);
      await mapSleep(maps.SPIN_DELAYS_MS[i]);
    }
    mapSpin.delete(matchMsgId);
    await editBoardNow(client, matchMsgId, match);
  } catch (err) {
    logError('팀 카드', `맵 뽑기 연출 중 카드 수정 실패 — ${err?.message ?? err}`, err);
    mapSpin.delete(matchMsgId);
    await refreshBoard(client, matchMsgId, match).catch(() => {}); // 카드가 살아 있으면 새 결과가 바로 보이게 한 번 더 시도
  } finally {
    mapSpin.delete(matchMsgId);
    mapReel.clearReelCache();
    scheduleMapUnlock(client, matchMsgId, match);
    if (ack?.deleteReply) await ack.deleteReply().catch(() => {}); // 나만 보이던 "돌리는 중" 확인 창은 연출이 끝나면 지운다
  }
}

// 잠금(5분)이 풀리는 시각에 카드를 한 번 고쳐 버튼을 다시 켠다. 같은 매치는 타이머를 하나만 둔다.
const mapUnlockTimers = new Map();
function scheduleMapUnlock(client, matchMsgId, match) {
  const at = match.board?.map?.at;
  if (!at) return;
  clearTimeout(mapUnlockTimers.get(matchMsgId));
  const wait = Math.max(0, at + MAP_LOCK_MS - mapNow()) + 500;
  const t = setTimeout(() => { mapUnlockTimers.delete(matchMsgId); refreshBoard(client, matchMsgId, match).catch(() => {}); }, wait);
  t.unref?.();
  mapUnlockTimers.set(matchMsgId, t);
}

function canEdit(match, userId) {
  return match.data.organizer.id === userId || ADMIN_IDS.includes(userId); // 팀 입력·밸런스·랜덤·불러오기는 주최자·관리자만
}

async function getEditableMatch(interaction, matchMsgId) {
  const match = getMatches(interaction.client).get(matchMsgId);
  if (!match) {
    await interaction.reply(notice('⚠️ **끝났거나 취소된 내전이에요.**', { ephemeral: true }));
    return null;
  }
  if (!canEdit(match, interaction.user.id)) {
    await interaction.reply(notice('❌ **팀은 이 내전의 주최자·관리자만 바꿀 수 있어요.**', { ephemeral: true }));
    return null;
  }
  return match;
}

// 내전채팅에 팀 짜기 카드가 올라가면 게임모집 채널의 내전 게시글에 답장으로 다는 바로가기 카드(시안).
// style 'game': 게임 색 띠 + 게임 아이콘 / 'plain': 아이콘 없이 한 줄짜리 작은 카드
function buildBoardShortcutPayload(match, boardMessage, { style = 'game' } = {}) {
  const { gameInfo, title } = match.data;
  const link = new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(boardMessage.url).setLabel('바로가기').setEmoji('🔗');
  const where = `<#${boardMessage.channelId}>`;
  if (style === 'plain') {
    return payload(card({
      color: COLORS.info,
      blocks: [{ text: `📌 **팀 설정**이 ${where} 에 올라왔어요.`, button: link }],
    }), { allowedMentions: { parse: [] } });
  }
  return payload(card({
    color: gameInfo.color,
    header: '📌 팀 짜기 카드가 올라왔어요',
    sub: ['내전', title],
    thumb: gameThumb(gameInfo),
    thumbAlt: gameInfo.name,
    blocks: [{ text: `### 🔗 ${where}
누르면 팀 짜기 카드로 이동해요. 팀 확인·변경은 거기서 해요.`, button: link }],
  }), { allowedMentions: { parse: [] } });
}

function linkRow(url) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel('바로가기').setEmoji('🔗'),
  );
}

// ── 팀 바꾸기 ───────────────────────────────────────────────

async function commitTeams(interaction, matchMsgId, match, teams, how, extraNote = '') {
  const board = normalizeBoard(match);
  if (board.current) board.history = [board.current, ...board.history].slice(0, HISTORY_KEPT); // 자동으로 나눈 #1 도 내역에 남긴다
  board.count = (board.count || 0) + 1; // 내역 순번(#1, #2 …)
  board.current = { teams, at: Date.now(), by: interaction.user.id, how, no: board.count };
  try {
    await postBoard(interaction.client, matchMsgId, match);
  } catch (err) {
    logError('처리 오류', `팀 짜기 카드 다시 올리기 실패 (${matchMsgId})`, err);
    await interaction.editReply(notice('⚠️ **팀은 저장했지만 카드를 다시 올리지 못했어요.** 주최자 관리 메뉴의 📌 팀 불러오기를 눌러 주세요.'));
    return;
  }
  const head = { input: '✅ **팀을 올렸어요.**', balance: '⚖️ **티어로 밸런스를 맞춰 나눴어요.**', random: '🎲 **무작위로 나눴어요.**' }[how];
  await interaction.editReply(notice(`${head}${extraNote}`));
}

// 팀 입력에 적힌 티어를 참가자에게 저장한다. 저장한 것/못 찾은 것을 안내 문구로 돌려준다.
function learnTiers(match, hints) {
  const game = match.data.game;
  if (!tiers.hasTiers(game) || hints.length === 0) return '';
  const saved = [];
  const missed = [];
  for (const { name, tier } of hints) {
    const user = resolveMember(name, match.participants);
    if (!user) { missed.push(name); continue; }
    tiers.setName(user.id, user.displayName);
    tiers.setTier(user.id, game, tier);
    saved.push(`${user.displayName} ${tiers.tierLabel(game, tier)}`);
  }
  let note = '';
  if (saved.length) note += `\n🏅 티어 저장: ${saved.join(', ')}`;
  if (missed.length) note += `\n-# 참가자 중에 못 찾아서 티어를 저장 안 한 이름: ${missed.join(', ')}`;
  return note;
}

// 직접 입력 칸에 채울 팀 하나의 글: 한 줄에 한 명, 맡은 자리가 있으면 맨 앞에(탑 민호), 카드에 보이는 순서대로.
function teamToLines(t, match) {
  const game = match.data.game;
  const resolved = t.members.map(n => resolveMember(n, match.participants));
  const lu = tiers.hasTiers(game) ? teamLineup(resolved, game, match, t.pos || []) : null;
  // 발로는 저장한 주 역할을 채우면 그대로 고정돼 버리니, 직접 고정한 것만 채운다
  const slots = t.members.map((n, k) => (lu ? lu.slots[k] : (t.pos || [])[k] || null));
  const order = t.members.map((n, k) => k);
  if (lu) { const order0 = slotsFor(game, t.members.length); order.sort((a, b) => order0.indexOf(slots[a]) - order0.indexOf(slots[b])); }
  const lines = order.map(k => `${slots[k] ? `${tiers.positionName(game, slots[k])} ` : ''}${t.members[k]}`);
  return [...(t.name ? [`[${t.name}]`] : []), ...lines].join('\n');
}

const INPUT_PLACEHOLDER = {
  lol: '탑 승훈 다2\n정글 윤진\n미드 시형\n바텀 연우\n서포터 강현',
  overwatch: '돌격 승훈 다2\n공격 윤진\n공격 시형\n지원 연우\n지원 강현',
  valorant: '타격대 승훈 불2\n감시자 윤진\n시형\n연우\n강현',
};

// ✏️ 직접 입력: 팀마다 칸 하나(디스코드 입력창은 칸이 최대 5개라 팀이 6개 이상이면 예전처럼 칸 하나에 한 줄 한 팀).
function buildInputModal(match, matchMsgId) {
  const cur = normalizeBoard(match).current;
  const game = match.data.game;
  if (cur.teams.length <= 5) {
    const teams = cur.teams.length >= 2 ? cur.teams : [...cur.teams, { name: null, members: [] }, { name: null, members: [] }].slice(0, 2);
    const hint = tiers.hasPositions(game) ? '한 줄에 한 명 (역할 이름 티어)' : tiers.hasTiers(game) ? '한 줄에 한 명 (이름 티어)' : '한 줄에 한 명';
    const rows = teams.map((t, i) => {
      const input = new TextInputBuilder()
        .setCustomId(`team${i}`)
        .setLabel(`${TEAM_ICONS[i] ?? ''} ${t.name || `${i + 1} 팀`} · ${hint}`.trim().slice(0, 45))
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder((INPUT_PLACEHOLDER[game] ?? '승훈\n윤진\n시형\n연우\n강현').slice(0, 100))
        .setRequired(false)
        .setMaxLength(1000);
      const value = teamToLines(t, match);
      if (value) input.setValue(value.slice(0, 1000));
      return new ActionRowBuilder().addComponents(input);
    });
    return new ModalBuilder().setCustomId(`team:modal:${matchMsgId}`).setTitle('직접 입력').addComponents(...rows);
  }
  const prefill = teamsToText(cur.teams);
  const input = new TextInputBuilder()
    .setCustomId('teams')
    .setLabel(tiers.hasTiers(match.data.game) ? '한 줄에 한 팀 · (ex.승훈 불2)처럼 쓰면 티어도 저장' : '한 줄에 한 팀 (- 나 띄어쓰기로 구분)')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('윤진-승훈-시형-연우-강현\n현호-찬영-찬우-승민-채원')
    .setRequired(true)
    .setMaxLength(1000);
  if (prefill) input.setValue(prefill.slice(0, 1000));
  return new ModalBuilder()
    .setCustomId(`team:modal:${matchMsgId}`)
    .setTitle('직접 입력')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

// ── 🏅 내 티어 설정 ──────────────────────────────────────────────
// 나만 보이는 카드들: (패널에서) 게임 고르기 → 티어 고르기 → 단계 고르기 / 점수 적기 → 저장 완료.
// 단계마다 ↩️ 뒤로 버튼이 있다(이름은 모두 '↩️ 뒤로'). matchMsgId 가 'panel' 이면 게임모집 패널에서 연 것이라 게임 고르기로 돌아갈 수 있다.

const GAME_COLORS = { lol: 0xC89B3C, valorant: 0xFF4655, overwatch: 0xF99E1A, pubg: 0xC8A96E };

function tierOptionEmoji(game, tier) {
  const id = tiers.tierEmojiId(game, tier);
  return id ? { id } : undefined;
}

function gameIconUrl(game) {
  return GAME_EMOJIS[game] ? gameThumb({ emoji: `<:g:${GAME_EMOJIS[game]}>` }) : undefined;
}

function tierIconUrl(game, tier) {
  const id = tier && tiers.tierEmojiId(game, tier);
  return id ? emojiUrl(id) : gameIconUrl(game);
}

// 저장된 티어 한 줄: "<이모지> **에메랄드4**" / 없으면 "아직 저장 안 함"
function tierLine(game, tier) {
  if (!tier) return '*아직 저장 안 함*'; // 줄 중간에도 들어가서 -# (줄 맨 앞에서만 작동) 대신 기울임
  const emoji = tiers.tierEmojiTag(game, tier);
  return `${emoji ? `${emoji} ` : ''}**${tiers.tierLabel(game, tier)}**`;
}

// 버튼 줄: 기능 버튼들은 첫 줄, ↩️ 뒤로는 늘 따로 둘째 줄(내 티어 설정 모든 화면 공통)
function buttonRows(main = [], back = null) {
  const rows = [];
  if (main.length) rows.push(new ActionRowBuilder().addComponents(...main));
  if (back) rows.push(new ActionRowBuilder().addComponents(back));
  return rows;
}

function backButton(id, label) {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Secondary);
}

// gk 는 'lol' 같은 게임 키, 또는 오버워치 롤별 티어면 'overwatch.tank'
function tierCard(gk, { header, thumbTier = null, blocks, rows, footer }) {
  const { game, role } = tiers.splitKey(gk);
  const r = role && tiers.owRole(role);
  return card({
    color: GAME_COLORS[game] ?? 0x5865F2,
    header,
    sub: [`${tiers.LADDERS[game]?.name ?? ''}${r ? ` · ${tiers.positionIcon(game, r.key)} ${r.name}` : ''}`, '🏅 내 티어 설정'],
    thumb: tierIconUrl(gk, thumbTier) ?? gameIconUrl(game),
    blocks,
    footer,
    rows,
  });
}

// 저장된 포지션 한 줄: "미드 · 정글(부)" / 없으면 "아직 저장 안 함"
function positionLine(game, userId) {
  const [main, sub] = tiers.getPositions(userId, game);
  if (!main) return '*아직 저장 안 함*';
  const icon = k => { const t = tiers.positionIcon(game, k); return t ? `${t} ` : ''; };
  return `${icon(main)}**${tiers.positionName(game, main)}**${sub ? ` · ${icon(sub)}${tiers.positionName(game, sub)}(부)` : ''}`;
}

// 오버워치 역할별 티어 한 줄 요약(저장한 역할만): "<돌격> <이모지> **다이아몬드2**　<지원> <이모지> **골드1**"
function roleSummary(userId) {
  const rt = tiers.getRoleTiers(userId);
  const saved = tiers.OW_ROLES.filter(r => rt[r.key]);
  if (!saved.length) return null;
  return saved.map(r => `${tiers.positionIcon('overwatch', r.key)} ${tierLine(`overwatch.${r.key}`, rt[r.key])}`).join('　');
}

// 지금 저장된 티어·포지션을 라벨 + 값 두 줄로: "🏅 티어　<이모지> **다이아몬드4**" / "🧭 포지션　<아이콘> **정글** · …"
function savedSummary(gk, userId) {
  const { game } = tiers.splitKey(gk);
  const lines = [`🏅 **티어**　${tierLine(gk, tiers.getTier(userId, gk))}`];
  if (tiers.POSITIONS[game]) lines.push(`🧭 **${tiers.POSITION_WORD[game]}**　${positionLine(game, userId)}`);
  return lines.join('\n');
}

// 📋 내 티어 정보의 게임 하나: 게임 이름 줄 + 인용 줄(티어 · 포지션). 아무것도 없으면 "아직 저장 안 함".
function gameInfoBlock(g, userId) {
  const head = `${GAME_EMOJIS[g] ? `<:g:${GAME_EMOJIS[g]}> ` : ''}**${tiers.LADDERS[g].name}**`;
  const parts = [];
  if (g === 'overwatch') {
    const roles = roleSummary(userId);
    const legacy = tiers.getTier(userId, g);
    if (roles) parts.push(roles); else if (legacy) parts.push(tierLine(g, legacy));
  } else {
    const tier = tiers.getTier(userId, g);
    const pos = tiers.POSITIONS[g] ? tiers.getPositions(userId, g) : [];
    if (tier) parts.push(tierLine(g, tier));
    if (pos.length) parts.push(positionLine(g, userId));
  }
  return `${head}\n> ${parts.length ? parts.join('　·　') : '*아직 저장 안 함*'}`;
}

// 게임모집 패널의 🏅 내 티어 설정: 저장된 티어가 있으면 바로 보여 주고, 아래에서 게임을 고른다.
// note: 맨 위에 붙일 안내(전체 초기화 후 등)
function buildTierGamePayload(userId, note = null) {
  const games = Object.keys(tiers.LADDERS);
  const saved = games.filter(g => userId && (tiers.getTier(userId, g) || (tiers.POSITIONS[g] && tiers.getPositions(userId, g).length)));
  const blocks = [note];
  if (saved.length) {
    // 제목 줄 오른쪽에 빨간 🗑️ 전체 초기화(한 번 더 묻는다), 아래로 게임마다 이름 줄 + 인용 줄
    const resetAll = new ButtonBuilder().setCustomId('team:tier_resetall:panel').setLabel('🗑️ 전체 초기화').setStyle(ButtonStyle.Danger);
    blocks.push({ text: '### 📋 내 티어 정보', button: resetAll });
    blocks.push({ text: games.map(g => gameInfoBlock(g, userId)).join('\n'), noDivider: true });
  } else {
    blocks.push('티어를 저장해 두면 내전 팀 설정에서 **⚖️ 밸런스**로 팀을 고르게 나눠 줘요.');
  }
  // 안내를 질문과 같은 칸에 넣어 사이 구분선을 없앤다
  const hint = saved.length ? '초록색은 저장된 게임이에요' : '한 번 저장하면 계속 써요';
  blocks.push(`**어느 게임 티어를 설정할까요?**\n-# ${hint}`);
  const buttons = games.map(g => {
    const b = new ButtonBuilder().setCustomId(`team:tier:${g}:panel`).setLabel(tiers.LADDERS[g].name).setStyle(saved.includes(g) ? ButtonStyle.Success : ButtonStyle.Secondary);
    return GAME_EMOJIS[g] ? b.setEmoji({ id: GAME_EMOJIS[g] }) : b;
  });
  return payload(card({
    color: 0x5865F2,
    header: '🏅 내 티어 설정',
    sub: '내전 팀 설정에 쓰일 티어를 직접 정할 수 있어요',
    blocks,
    rows: [new ActionRowBuilder().addComponents(...buttons)],
  }), { ephemeral: true });
}

// 🗑️ 전체 초기화 확인
function buildResetAllConfirmPayload() {
  return payload(card({
    color: 0xED4245,
    header: '🗑️ 전체 초기화',
    sub: '🏅 내 티어 설정',
    blocks: ['저장한 **모든 게임의 티어와 포지션(역할)** 을 지울까요?\n-# 지우면 되돌릴 수 없어요.'],
    rows: buttonRows(
      [new ButtonBuilder().setCustomId('team:tier_resetall_ok:panel').setLabel('🗑️ 모두 지우기').setStyle(ButtonStyle.Danger)],
      backButton('team:tier_games:panel', '↩️ 뒤로'),
    ),
  }), { ephemeral: true });
}

// 오버워치: 역할(돌격·공격·지원)마다 랭크가 따로라 먼저 롤을 고른다.
function buildOwRolesPayload(matchMsgId, userId) {
  const rt = tiers.getRoleTiers(userId);
  const buttons = tiers.OW_ROLES.map(r => {
    const emoji = tiers.positionEmoji('overwatch', r.key); // 롤 아이콘 이모지가 있으면 버튼 아이콘으로, 없으면 🛡️⚔️💉 글자
    const b = new ButtonBuilder()
      .setCustomId(`team:tier:overwatch.${r.key}:${matchMsgId}`)
      .setLabel(emoji ? r.name : `${r.icon} ${r.name}`)
      .setStyle(rt[r.key] ? ButtonStyle.Success : ButtonStyle.Secondary);
    return emoji ? b.setEmoji(emoji) : b;
  });
  const back = matchMsgId === 'panel' ? backButton('team:tier_games:panel', '↩️ 뒤로') : null;
  return payload(tierCard('overwatch', {
    header: '🏅 내 티어 설정',
    thumbTier: tiers.getTier(userId, 'overwatch'),
    blocks: [
      `**역할별 티어**\n${tiers.OW_ROLES.map(r => `${tiers.positionIcon('overwatch', r.key)} **${r.name}**　${tierLine(`overwatch.${r.key}`, rt[r.key])}`).join('\n')}`,
      `**어느 역할 티어를 설정할까요?**\n-# 하는 역할만 저장하면 돼요 · 6vs6은 ${tiers.positionIcon('overwatch', 'open')} 자유 티어를 써요`, // 안내를 질문과 같은 칸에(사이 구분선 없이)
    ],
    rows: buttonRows(buttons, back),
  }), { ephemeral: true });
}

// 롤·발로: 주/부 포지션(역할) 고르기. 고르면 바로 저장되고 이 화면이 새로 그려진다.
function buildPositionPayload(game, matchMsgId, userId) {
  const word = tiers.POSITION_WORD[game];
  const [main, sub] = tiers.getPositions(userId, game);
  const opts = (current, extra) => [
    ...tiers.POSITIONS[game].map(p => {
      const emoji = tiers.positionEmoji(game, p.key);
      return { label: p.name, value: p.key, default: p.key === current, ...(emoji ? { emoji } : {}) };
    }),
    extra,
  ];
  const mainMenu = new StringSelectMenuBuilder()
    .setCustomId(`team:tier_pos:main:${game}:${matchMsgId}`)
    .setPlaceholder(`주 ${word}을 고르세요`)
    .addOptions(opts(main, { label: '상관없음(지우기)', value: 'none', emoji: '🗑️' }));
  const subMenu = new StringSelectMenuBuilder()
    .setCustomId(`team:tier_pos:sub:${game}:${matchMsgId}`)
    .setPlaceholder(main ? `부 ${word}을 고르세요(선택)` : `주 ${word}을 먼저 골라 주세요`)
    .setDisabled(!main)
    .addOptions(opts(sub, { label: '없음', value: 'none' }).filter(o => o.value !== main));
  const note = game === 'lol'
    ? '팀을 나눌 때 포지션이 겹치지 않게 맞춰 줘요.'
    : '팀 카드에 내 역할 아이콘이 보여요.';
  return payload(tierCard(game, {
    header: `🧭 ${word} 설정`,
    thumbTier: tiers.getTier(userId, game),
    blocks: [`🧭 **${word}**　${positionLine(game, userId)}\n-# ${note}`],
    rows: [
      new ActionRowBuilder().addComponents(mainMenu),
      new ActionRowBuilder().addComponents(subMenu),
      new ActionRowBuilder().addComponents(backButton(`team:tier_back:${game}:${matchMsgId}`, '↩️ 뒤로')),
    ],
  }), { ephemeral: true });
}

function buildTierPickPayload(gk, matchMsgId, userId) {
  const { game, role } = tiers.splitKey(gk);
  const ladder = tiers.ladderOf(gk);
  const mine = tiers.getTier(userId, gk);
  const options = [...ladder.tiers].reverse().map(t => {
    const o = { label: t.name, value: t.key };
    const desc = t.scored ? `점수(${ladder.scoreUnit})로 순위` : t.divs ? `${t.divs}단계` : null;
    if (desc) o.description = desc;
    const emoji = tierOptionEmoji(game, { tier: t.key, div: t.divs ? (ladder.divOrder === 'desc' ? 1 : t.divs) : undefined });
    if (emoji) o.emoji = emoji;
    return o;
  });
  if (mine) options.push({ label: '저장한 티어 지우기', value: 'none', emoji: '🗑️' });
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`team:tier_pick:${gk}:${matchMsgId}`)
    .setPlaceholder('티어를 고르세요')
    .addOptions(options);
  const rows = [new ActionRowBuilder().addComponents(menu)];
  const buttons = [];
  if (tiers.POSITIONS[game]) buttons.push(new ButtonBuilder().setCustomId(`team:tier_posset:${game}:${matchMsgId}`).setLabel(`🧭 ${tiers.POSITION_WORD[game]} 설정`).setStyle(ButtonStyle.Primary));
  // 🔄 초기화: 이 게임(오버워치는 이 롤)의 티어와 포지션을 한 번에 지운다. 저장된 게 있을 때만.
  const hasSaved = mine || (tiers.POSITIONS[game] && tiers.getPositions(userId, game).length);
  if (hasSaved) buttons.push(new ButtonBuilder().setCustomId(`team:tier_reset:${gk}:${matchMsgId}`).setLabel('🔄 초기화').setStyle(ButtonStyle.Danger));
  const back = role ? backButton(`team:tier_roles:${matchMsgId}`, '↩️ 뒤로')
    : matchMsgId === 'panel' ? backButton('team:tier_games:panel', '↩️ 뒤로') : null;
  rows.push(...buttonRows(buttons, back));
  const blocks = [savedSummary(gk, userId)];
  return payload(tierCard(gk, {
    header: '🏅 내 티어 설정',
    thumbTier: mine,
    blocks,
    rows,
    footer: '한 번 저장하면 계속 써요',
  }), { ephemeral: true });
}

function buildTierDivPayload(game, tierKey, matchMsgId) {
  const ladder = tiers.ladderOf(game);
  const t = tiers.findTier(game, tierKey);
  const divs = Array.from({ length: t.divs }, (_, i) => (ladder.divOrder === 'desc' ? i + 1 : t.divs - i)); // 높은 단계부터
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`team:tier_div:${game}:${tierKey}:${matchMsgId}`)
    .setPlaceholder(`${t.name} 세부 티어를 고르세요`)
    .addOptions(divs.map(d => {
      const emoji = tierOptionEmoji(game, { tier: tierKey, div: d });
      return { label: `${t.name} ${d}`, value: String(d), ...(emoji ? { emoji } : {}) };
    }));
  return payload(tierCard(game, {
    header: '티어 세부 설정',
    thumbTier: { tier: tierKey, div: divs[0] },
    blocks: [],
    rows: [
      new ActionRowBuilder().addComponents(menu),
      new ActionRowBuilder().addComponents(backButton(`team:tier_back:${game}:${matchMsgId}`, '↩️ 뒤로')),
    ],
  }));
}

// 점수제 티어(마스터 이상·레디언트 등): 점수를 적을지 묻는다. 안 적어도 저장된다.
function buildTierScoreAskPayload(game, key, matchMsgId) {
  const t = tiers.findTier(game, key);
  const unit = tiers.ladderOf(game).scoreUnit || '점';
  return payload(tierCard(game, {
    header: t.name,
    thumbTier: { tier: key },
    blocks: [`점수(${unit})를 적으면 팀이 더 고르게 나뉘어요.\n-# 안 적어도 돼요.`],
    rows: buttonRows([
      new ButtonBuilder().setCustomId(`team:tier_score:${game}:${key}:${matchMsgId}`).setLabel(`✏️ ${unit} 적기`).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`team:tier_save:${game}:${key}:${matchMsgId}`).setLabel('점수 없이 저장').setStyle(ButtonStyle.Primary),
    ], backButton(`team:tier_back:${game}:${matchMsgId}`, '↩️ 뒤로')),
  }));
}

function buildTierScoreModal(game, key, matchMsgId) {
  const t = tiers.findTier(game, key);
  const unit = tiers.ladderOf(game).scoreUnit || '점';
  return new ModalBuilder()
    .setCustomId(`team:tier_modal:${game}:${key}:${matchMsgId}`)
    .setTitle(`${t.name} 점수`)
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('score').setLabel(`${unit} (숫자만)`).setStyle(TextInputStyle.Short).setPlaceholder('예: 350').setRequired(true).setMaxLength(5),
    ));
}

function buildTierSavedPayload(gk, tier, matchMsgId, userId) {
  const { game, role } = tiers.splitKey(gk);
  // 뒤로: 오버워치 롤 티어면 롤 고르기로, 패널에서 열었으면 게임 고르기(내 티어 목록)로, 카드에서 열었으면 티어 고르기로
  const backId = role ? `team:tier_roles:${matchMsgId}` : matchMsgId === 'panel' ? 'team:tier_games:panel' : `team:tier_back:${game}:${matchMsgId}`;
  const buttons = [];
  const askPos = tier && tiers.POSITIONS[game];
  if (askPos) buttons.push(new ButtonBuilder().setCustomId(`team:tier_posset:${game}:${matchMsgId}`).setLabel(`🧭 ${tiers.POSITION_WORD[game]} 설정`).setStyle(ButtonStyle.Primary));
  const back = backButton(backId, '↩️ 뒤로');
  const blocks = [tier ? `## ${tierLine(gk, tier)}` : '-# 다시 설정하려면 ↩️ 뒤로를 눌러 주세요.'];
  if (askPos && !tiers.getPositions(userId, game).length) blocks.push(`-# 🧭 ${tiers.POSITION_WORD[game]}도 정해 두면 ${game === 'lol' ? '팀을 나눌 때 겹치지 않게 맞춰 줘요' : '팀 카드에 보여요'}.`);
  return payload(tierCard(gk, {
    header: tier ? '✅ 티어를 저장했어요' : '🗑️ 저장한 티어를 지웠어요',
    thumbTier: tier,
    blocks,
    footer: tier ? '내전 팀 설정에 바로 적용돼요' : undefined,
    rows: buttonRows(buttons, back),
  }));
}

async function saveMyTier(interaction, gk, tier, matchMsgId) {
  tiers.setName(interaction.user.id, displayNameFromInteraction(interaction)); // 파일에서 누군지 알아보게
  tiers.setTier(interaction.user.id, gk, tier);
  await interaction.update(buildTierSavedPayload(gk, tier, matchMsgId, interaction.user.id));
}

// 🏅 내 티어 설정 선택 메뉴
async function handleTeamSelect(interaction) {
  rememberClient(interaction);
  const { customId } = interaction;
  if (customId.startsWith('team:tier')) tiers.setName(interaction.user.id, displayNameFromInteraction(interaction));

  if (customId.startsWith('team:tier_pick:')) {
    const [, , game, matchMsgId] = customId.split(':');
    const key = interaction.values[0];
    if (key === 'none') return saveMyTier(interaction, game, null, matchMsgId);
    const t = tiers.findTier(game, key);
    if (!t) return interaction.update(notice('⚠️ **알 수 없는 티어예요.**'));
    if (t.scored) return interaction.update(buildTierScoreAskPayload(game, key, matchMsgId));
    if (!t.divs) return saveMyTier(interaction, game, { tier: key }, matchMsgId);
    return interaction.update(buildTierDivPayload(game, key, matchMsgId));
  }

  if (customId.startsWith('team:tier_div:')) {
    const [, , game, key, matchMsgId] = customId.split(':');
    const div = Number(interaction.values[0]);
    return saveMyTier(interaction, game, { tier: key, div }, matchMsgId);
  }

  // 🧭 포지션(역할) 고르기: team:tier_pos:<main|sub>:<게임>:<매치>
  if (customId.startsWith('team:tier_pos:')) {
    const [, , which, game, matchMsgId] = customId.split(':');
    if (!tiers.POSITIONS[game]) return interaction.update(notice('⚠️ **이 게임은 포지션을 저장하지 않아요.**'));
    const value = interaction.values[0];
    const [main, sub] = tiers.getPositions(interaction.user.id, game);
    let next;
    if (which === 'main') next = value === 'none' ? [] : [value, sub === value ? null : sub]; // 주를 지우면 부도 같이 지운다
    else next = [main, value === 'none' ? null : value];
    tiers.setName(interaction.user.id, displayNameFromInteraction(interaction));
    tiers.setPositions(interaction.user.id, game, next.filter(Boolean));
    await interaction.update(buildPositionPayload(game, matchMsgId, interaction.user.id));
    return;
  }

  // 예전 팀 관리 화면의 선택 메뉴
  await interaction.reply(notice(OLD_UI_NOTE, { ephemeral: true }));
}

// ── 카드 버튼 ───────────────────────────────────────────────

async function handleTeamButton(interaction) {
  rememberClient(interaction);
  const { customId } = interaction;
  if (customId.startsWith('team:tier')) tiers.setName(interaction.user.id, displayNameFromInteraction(interaction)); // 티어 파일에 이름 채우기(이미 저장된 사람만 기록됨)

  if (customId.startsWith('team:input:')) {
    const matchMsgId = customId.slice('team:input:'.length);
    const match = await getEditableMatch(interaction, matchMsgId);
    if (!match) return;
    await interaction.showModal(buildInputModal(match, matchMsgId));
    return;
  }

  // 🗺️ 맵 뽑기: 주최자만. 버튼을 누르면 나만 보이는 "맵을 돌리겠습니까?" 확인 창이 뜨고, 확인하면 카드의 맵 구역에서 연출이 돈다.
  // 한 번 돌리면 누른 때부터 5분간 잠긴다. 연출 중·잠금 중에 누르면 안내만.
  if (customId.startsWith('team:map:') || customId.startsWith('team:map_ok:') || customId.startsWith('team:map_no:')) {
    const kind = customId.startsWith('team:map_ok:') ? 'ok' : customId.startsWith('team:map_no:') ? 'no' : 'ask';
    const matchMsgId = customId.slice(customId.indexOf(':', 'team:map'.length) + 1);
    if (kind === 'no') { if (dropMapPrep(matchMsgId)) mapReel.clearReelCache(); await interaction.deferUpdate(); await interaction.deleteReply().catch(() => {}); return; }
    const match = getMatches(interaction.client).get(matchMsgId);
    const say = (text) => (kind === 'ok' ? interaction.update(notice(text, { ephemeral: true })) : interaction.reply(notice(text, { ephemeral: true })));
    if (!match) { await say('⚠️ **끝났거나 취소된 내전이에요.**'); return; }
    if (!maps.hasMapPool(match.data.game)) { await say('⚠️ **이 게임은 맵 뽑기를 지원하지 않아요.**'); return; }
    if (match.data.organizer.id !== interaction.user.id) { await say('⚠️ **일반 참가자는 주최자만 가능합니다.**'); return; }
    if (mapSpin.has(matchMsgId)) { await say('🎲 **지금 맵을 뽑는 중이에요.**'); return; }
    if (mapLocked(match)) {
      const at = Math.floor((match.board.map.at + MAP_LOCK_MS) / 1000);
      await say(`🔒 **맵 뽑기는 <t:${at}:R> 다시 할 수 있어요.**\n-# 한 번 뽑으면 5분간 잠겨요.`);
      return;
    }
    if (kind === 'ask') {
      prepareMapSpin(matchMsgId, match.data.game); // 확인 창이 떠 있는 동안 연출 프레임을 미리 그린다
      await interaction.reply(notice('🗺️ **맵을 돌리겠습니까?**\n-# 한 번 돌리면 5분간 다시 돌릴 수 없어요.', {
        ephemeral: true,
        rows: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`team:map_ok:${matchMsgId}`).setLabel('돌리기').setEmoji('🎲').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`team:map_no:${matchMsgId}`).setLabel('취소').setStyle(ButtonStyle.Secondary),
        )],
      }));
      return;
    }
    mapSpin.set(matchMsgId, { key: null, n: 0 }); // 동시에 두 번 눌려도 한 번만 돌도록 바로 잠근다
    try {
      await interaction.update(notice('🎲 **맵을 돌리는 중이에요.**\n-# 카드에서 확인하세요.', { ephemeral: true }));
    } catch (err) {
      mapSpin.delete(matchMsgId);
      throw err;
    }
    await runMapSpin(interaction.client, matchMsgId, match, interaction);
    return;
  }

  // 📜 내전 내역 보기: 누구나 볼 수 있고 나만 보이는 메시지로 연다.
  if (customId.startsWith('team:hist:')) {
    const matchMsgId = customId.slice('team:hist:'.length);
    const match = getMatches(interaction.client).get(matchMsgId);
    if (!match) { await interaction.reply(notice('⚠️ **끝났거나 취소된 내전이에요.**', { ephemeral: true })); return; }
    await interaction.reply(buildHistoryPayload(match, matchMsgId));
    return;
  }

  if (customId.startsWith('team:random:') || customId.startsWith('team:balance:')) {
    const how = customId.startsWith('team:random:') ? 'random' : 'balance';
    const matchMsgId = customId.slice(`team:${how}:`.length);
    const match = await getEditableMatch(interaction, matchMsgId);
    if (!match) return;
    if (match.participants.length < 2) {
      await interaction.reply(notice('⚠️ **팀을 나누려면 참가자가 2명 이상이어야 해요.**', { ephemeral: true }));
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const teams = how === 'random' ? randomTeams(match.participants) : balanceTeams(match.participants, match.data.game);
    await commitTeams(interaction, matchMsgId, match, teams, how);
    return;
  }

  if (customId === 'team:tier_games:panel') return interaction.update(buildTierGamePayload(interaction.user.id));
  if (customId === 'team:tier_resetall:panel') return interaction.update(buildResetAllConfirmPayload());
  if (customId === 'team:tier_resetall_ok:panel') {
    const userId = interaction.user.id;
    tiers.resetAll(userId);
    await interaction.update(buildTierGamePayload(userId, '🗑️ **모든 티어와 포지션을 지웠어요.**'));
    return;
  }
  if (customId.startsWith('team:tier_back:')) {
    const [, , game, matchMsgId] = customId.split(':');
    if (!tiers.hasTiers(game)) return interaction.update(notice('⚠️ **이 게임은 티어를 저장하지 않아요.**'));
    if (game === 'overwatch') return interaction.update(buildOwRolesPayload(matchMsgId, interaction.user.id)); // 오버워치는 롤 고르기부터
    return interaction.update(buildTierPickPayload(game, matchMsgId, interaction.user.id));
  }
  if (customId.startsWith('team:tier_roles:')) {
    const matchMsgId = customId.slice('team:tier_roles:'.length);
    return interaction.update(buildOwRolesPayload(matchMsgId, interaction.user.id));
  }
  if (customId.startsWith('team:tier_reset:')) {
    const [, , gk, matchMsgId] = customId.split(':');
    const { game, role } = tiers.splitKey(gk);
    if (!tiers.hasTiers(game) || (role && !tiers.owRole(role))) return interaction.update(notice('⚠️ **이 게임은 티어를 저장하지 않아요.**'));
    tiers.setTier(interaction.user.id, gk, null);
    if (tiers.POSITIONS[game]) tiers.setPositions(interaction.user.id, game, []);
    await interaction.update(buildTierPickPayload(gk, matchMsgId, interaction.user.id));
    return;
  }
  if (customId.startsWith('team:tier_posset:')) {
    const [, , game, matchMsgId] = customId.split(':');
    if (!tiers.POSITIONS[game]) return interaction.update(notice('⚠️ **이 게임은 포지션을 저장하지 않아요.**'));
    return interaction.update(buildPositionPayload(game, matchMsgId, interaction.user.id));
  }
  if (customId.startsWith('team:tier_score:') || customId.startsWith('team:tier_save:')) {
    const [, action, game, key, matchMsgId] = customId.split(':');
    if (!tiers.findTier(game, key)) return interaction.update(notice('⚠️ **알 수 없는 티어예요.**'));
    if (action === 'tier_score') return interaction.showModal(buildTierScoreModal(game, key, matchMsgId));
    return saveMyTier(interaction, game, { tier: key }, matchMsgId);
  }

  if (customId.startsWith('team:tier:')) {
    const [, , game, matchMsgId] = customId.split(':');
    if (!tiers.hasTiers(game)) {
      await interaction.reply(notice('⚠️ **이 게임은 티어를 저장하지 않아요.**', { ephemeral: true }));
      return;
    }
    const { role } = tiers.splitKey(game);
    if (role && !tiers.owRole(role)) return interaction.update(notice('⚠️ **알 수 없는 역할이에요.**'));
    // 오버워치는 롤 고르기부터, 롤을 고른 뒤엔 그 롤 티어 고르기
    const view = game === 'overwatch' ? buildOwRolesPayload(matchMsgId, interaction.user.id) : buildTierPickPayload(game, matchMsgId, interaction.user.id);
    // 게임모집 패널에서 게임을 고른 경우(matchMsgId 'panel')나 롤 고르기 화면에서 누른 경우엔 그 메시지를 그대로 바꾼다
    if (matchMsgId === 'panel' || role) await interaction.update(view);
    else await interaction.reply(view);
    return;
  }

  // 주최자 관리 메뉴의 ⚔️ 팀 짜기: 카드를 (다시) 맨 아래에 올린다
  if (customId.startsWith('team:open:')) {
    const matchMsgId = customId.slice('team:open:'.length);
    const match = await getEditableMatch(interaction, matchMsgId);
    if (!match) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const msg = await postBoard(interaction.client, matchMsgId, match);
      await interaction.editReply(notice('✅ **팀 짜기 카드를 올렸어요.**', { rows: [linkRow(msg.url)] }));
    } catch (err) {
      logError('처리 오류', `팀 짜기 카드 게시 실패 (${matchMsgId})`, err);
      await interaction.editReply(notice('⚠️ **팀 짜기 카드를 올리지 못했어요.** 잠시 뒤 다시 시도해 주세요.'));
    }
    return;
  }

  // 예전 팀 관리 화면(임시 메시지)에 남아 있던 버튼
  await interaction.reply(notice(OLD_UI_NOTE, { ephemeral: true }));
}

async function handleTeamModal(interaction) {
  rememberClient(interaction);
  if (interaction.customId.startsWith('team:tier_modal:')) {
    const [, , game, key, matchMsgId] = interaction.customId.split(':');
    const raw = interaction.fields.getTextInputValue('score').replace(/[^0-9]/g, '');
    const score = Number(raw);
    if (!raw || !Number.isFinite(score)) {
      await interaction.reply(notice('⚠️ **점수는 숫자로 적어 주세요.** (예: 350)', { ephemeral: true }));
      return;
    }
    return saveMyTier(interaction, game, { tier: key, score }, matchMsgId);
  }
  const matchMsgId = interaction.customId.slice('team:modal:'.length);
  const match = await getEditableMatch(interaction, matchMsgId);
  if (!match) return;
  // 팀별 칸(team0~team4)이 있으면 그걸로, 없으면 예전 한 칸짜리(teams). 없는 칸을 읽으면 discord.js 가 오류를 내서 감싼다.
  const field = id => { try { return interaction.fields.getTextInputValue(id) ?? ''; } catch { return ''; } };
  const boxes = [0, 1, 2, 3, 4].map(i => field(`team${i}`));
  const parsed = boxes.some(b => b.trim())
    ? parseTeamBoxes(boxes, { game: match.data.game, participants: match.participants })
    : parseTeamsText(field('teams'), { game: match.data.game });
  if (parsed.error) {
    await interaction.reply(notice(`⚠️ ${parsed.error}`, { ephemeral: true }));
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const note = learnTiers(match, parsed.hints);
  await commitTeams(interaction, matchMsgId, match, parsed.teams, 'input', note);
}

// 예전 팀 관리 화면의 선택 메뉴(index.js 가 예전 customId 를 여기로 보낸다)
async function handleTeamAssignSelect(interaction) {
  await interaction.reply(notice(OLD_UI_NOTE, { ephemeral: true }));
}

module.exports = {
  parseTeamsText, // 테스트용
  autoFillSlots, // 테스트용
  parseTeamBoxes,
  buildInputModal,
  teamsToText,
  draftTeams,
  balanceTeams,
  resolveMember,
  buildBoardPayload, // 화면 모음·테스트용
  buildHistoryPayload, // 화면 모음·테스트용
  __mapSpin: mapSpin, // 화면 모음·테스트용(연출 중 프레임)
  __mapUnlockTimers: mapUnlockTimers, // 테스트용
  __setMapSleep: (fn) => { mapSleep = fn; }, // 테스트용
  __setMapClock: (fn) => { mapNow = fn; }, // 테스트용
  MAP_LOCK_MS,
  buildBoardShortcutPayload, // 화면 모음용(시안)
  buildTierGamePayload,
  buildTierPickPayload, // 화면 모음용
  buildPositionPayload,
  buildOwRolesPayload,
  buildResetAllConfirmPayload,
  postBoard,
  refreshAllBoards,
  handleTeamSelect,
  handleTeamButton,
  handleTeamModal,
  handleTeamAssignSelect,
};

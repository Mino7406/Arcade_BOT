// 패치노트.js — 롤·발로란트·오버워치·배틀그라운드 공식 홈페이지를 지켜보다가 "새 패치노트"나 "새 점검 공지"가 올라오면
// 지정 채널(PATCHNOTE_CHANNEL_ID)에 컴포넌트 v2 카드로 알린다.
// (점검: 롤·발로란트는 라이엇 서버 상태 JSON, 배그는 공지 중 "점검" 제목. 오버워치 점검은 공식 목록을 못 찾아 아직 없음)
//
// 호스팅(CPU 25% / RAM 256MB)에 맞춘 설계:
//  - 추가 패키지 없음(Node 내장 fetch + JSON/정규식만).
//  - 게임 4개를 동시에 읽지 않고 시작 시각을 엇갈리게 한 뒤 하나씩 차례로 읽는다(10분 간격).
//  - 이미 알린 글은 게임당 최대 300개 키만 DB/patchnote.json에 기록(수 KB).
//  - 읽기에 실패하면 간격을 점점 늘리고(최대 6배) 오류는 로그만 남긴다. 실패해도 공지는 나가지 않는다.
//
// "새 패치노트가 올라왔을 때만" 알리기 위한 안전장치:
//  - 처음 보는 게임은 지금 올라와 있는 글을 전부 '이미 본 것'으로만 기억하고 알리지 않는다(재시작·저장 파일 유실 때 도배 방지).
//  - 목록이 비어 읽히면(사이트 구조 변경) 실패로 취급한다 — 빈 목록을 기억하면 다음에 전부 '새 글'로 보인다.
//  - 한 번에 새 글이 4개 이상이면 구조 변경으로 보고, 알리지 않고 조용히 기억만 한다.
//  - 전송에 성공한 글만 '알림 완료'로 기록한다(실패하면 다음 확인 때 다시 시도).
//  - 게시 시각이 아직 안 된 예약 글은 건너뛴다.

const fs = require('fs');
const path = require('path');
const {
  ContainerBuilder, SectionBuilder, TextDisplayBuilder, ThumbnailBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');
const { PATCHNOTE_CHANNEL_ID, PATCHNOTE_EMOJIS } = require('../config');
const { logSystem, logErrorThrottled } = require('./로그');
const { writeJsonIfChanged } = require('./저장');

const STORE_PATH = path.join(__dirname, '..', 'DB', 'patchnote.json');

const POLL_MS = 10 * 60_000;          // 게임마다 이 간격으로 확인(패치는 1~2주에 한 번이라 충분)
const TICK_MS = 60_000;               // 어느 게임이 확인할 차례인지 보는 주기(비교만 해서 거의 공짜)
const STAGGER_MS = 30_000;            // 시작 직후 게임 간 확인 시각 간격
const MAX_BACKOFF = 6;                // 연속 실패 시 간격 최대 배수
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_CHARS = 3_000_000;     // 이보다 큰 응답은 읽지 않는다(메모리 보호)
const MAX_SEEN = 300;                 // 게임당 기억할 '이미 알린 글' 키 개수
const MAX_FRESH = 3;                  // 한 번에 이보다 많은 새 글이 보이면 구조 변경으로 본다
const KST_MS = 9 * 60 * 60_000;

const LOL_BASE = 'https://www.leagueoflegends.com';
const VALO_BASE = 'https://playvalorant.com';
const OW_BASE = 'https://overwatch.blizzard.com';
const PUBG_API = 'https://api-foc.krafton.com/content/post/news?lang=ko&displayLocationType=NORMAL&category=patch_notes&size=5&page=1';
const PUBG_NEWS = 'https://www.pubg.com/ko/news';

class EmptyListError extends Error {}

// ── 가져오기 ───────────────────────────────────────────────────
async function fetchText(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR,ko;q=0.9', ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} (${url})`);
    err.status = res.status;
    throw err;
  }
  if (Number(res.headers.get('content-length')) > MAX_BODY_CHARS) throw new Error(`응답이 너무 큼 (${url})`);
  const text = await res.text();
  if (text.length > MAX_BODY_CHARS) throw new Error(`응답이 너무 큼 (${url})`);
  return text;
}

// ── 파싱(순수 함수 — 테스트 대상) ─────────────────────────────────
// 글 하나: { key, title, url, at(ms 또는 null) }

// 롤·발로란트(라이엇 뉴스 페이지): 페이지에 박힌 __NEXT_DATA__ JSON 안에서 "패치 노트" 제목의 글을 찾는다.
function parseRiotPatches(html, base) {
  const start = html.indexOf('<script id="__NEXT_DATA__"');
  if (start < 0) return [];
  const open = html.indexOf('>', start);
  const end = html.indexOf('</script>', open);
  if (open < 0 || end < 0) return [];
  let data;
  try { data = JSON.parse(html.slice(open + 1, end)); } catch { return []; }
  const found = new Map();
  const stack = [data];
  while (stack.length) {
    const x = stack.pop();
    if (Array.isArray(x)) { for (const v of x) stack.push(v); continue; }
    if (!x || typeof x !== 'object') continue;
    const url = x.action?.payload?.url;
    if (typeof x.title === 'string' && x.title.includes('패치 노트') && typeof url === 'string') {
      const full = url.startsWith('http') ? url : base + url;
      const stamp = Date.parse(x.analytics?.publishDate ?? '');
      const at = Number.isNaN(stamp) ? null : stamp;
      const prev = found.get(full);
      // 같은 글이 목록에 여러 번 나올 수 있다(그중 일부만 게시 시각을 가짐) — 비어 있던 시각을 채운다
      if (!prev) found.set(full, { key: full, title: x.title.trim(), url: full, at });
      else if (prev.at == null && at != null) prev.at = at;
    }
    for (const v of Object.values(x)) if (v && typeof v === 'object') stack.push(v);
  }
  return [...found.values()];
}

// 오버워치: 월별 페이지 한 장에 날짜별 "오버워치 패치 노트 - YYYY년 M월 D일" 제목이 여러 개 들어 있다.
const OW_HEADING = /오버워치 패치 노트\s*-\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/g;
function parseOverwatchPatches(html, pageUrl) {
  const found = new Map();
  for (const m of html.matchAll(OW_HEADING)) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const key = `ow-${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (!found.has(key)) found.set(key, { key, title: `오버워치 패치 노트 - ${y}년 ${mo}월 ${d}일`, url: pageUrl, at: Date.UTC(y, mo - 1, d) - KST_MS });
  }
  return [...found.values()];
}

// 배틀그라운드: 공식 사이트가 쓰는 JSON 목록(category로 분류가 나뉘어 온다). 예약 글(displayStartTime 미래)은 뺀다.
// 패치노트는 category=patch_notes 그대로, 점검은 category=notice(공지) 중 제목에 "점검"이 든 글만 쓴다.
const PUBG_LABELS = { label_pc: 'PC', label_console: '콘솔' };
function parsePubgPatches(jsonText, now = Date.now(), { category = 'patch_notes', titleHas = null } = {}) {
  let posts;
  try { posts = JSON.parse(jsonText)?._embedded?.post; } catch { return []; }
  if (!Array.isArray(posts)) return [];
  const out = [];
  for (const p of posts) {
    if (!p || p.postId == null || typeof p.title !== 'string') continue;
    if (p.category && p.category !== category) continue;
    if (titleHas && !p.title.includes(titleHas)) continue;
    const at = Date.parse(String(p.displayStartTime ?? '').replace(' ', 'T') + '+09:00');
    if (!Number.isNaN(at) && at > now) continue; // 아직 공개 전인 예약 글
    const platforms = (p.labels ?? []).map(l => PUBG_LABELS[l]).filter(Boolean);
    out.push({
      key: `pubg-${p.postId}`, title: p.title.trim(), url: `${PUBG_NEWS}/${p.postId}`,
      at: Number.isNaN(at) ? null : at, note: platforms.join(' · ') || null,
    });
  }
  return out;
}

// 롤·발로란트 점검: 라이엇이 공개한 서버 상태 JSON의 maintenances 목록(점검이 없으면 비어 있는 게 정상).
// 글 번호(id)로 새 점검을 구분하고 제목은 한국어 > 영어 > 첫 번째 순으로 고른다. 장애(incidents)는 점검이 아니라 다루지 않는다.
function parseRiotMaintenances(jsonText, statusUrl) {
  let list;
  try { list = JSON.parse(jsonText)?.maintenances; } catch { return []; }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const m of list) {
    if (!m || m.id == null) continue;
    const titles = Array.isArray(m.titles) ? m.titles : [];
    const t = titles.find(x => x?.locale === 'ko_KR') ?? titles.find(x => x?.locale === 'en_US') ?? titles[0];
    const title = typeof t?.content === 'string' && t.content.trim() ? t.content.trim() : '점검 안내';
    const at = Date.parse(m.created_at ?? '');
    out.push({ key: `maint-${m.id}`, title, url: statusUrl, at: Number.isNaN(at) ? null : at });
  }
  return out;
}

// ── 게임별 로더 ────────────────────────────────────────────────
async function loadOverwatch(now = Date.now()) {
  const kst = new Date(now + KST_MS);
  const monthUrl = (y, m) => `${OW_BASE}/ko-kr/news/patch-notes/live/${y}/${String(m).padStart(2, '0')}/`;
  const y = kst.getUTCFullYear(), m = kst.getUTCMonth() + 1;
  const pages = [monthUrl(y, m), m === 1 ? monthUrl(y - 1, 12) : monthUrl(y, m - 1)];
  const out = [];
  for (let i = 0; i < pages.length; i++) {
    try {
      out.push(...parseOverwatchPatches(await fetchText(pages[i]), pages[i]));
    } catch (err) {
      if (err.status !== 404) throw err; // 이번 달 페이지가 아직 없으면(월초) 지난달 페이지로 넘어간다
    }
    if (out.length) break; // 이번 달에 글이 있으면 지난달은 읽지 않는다
  }
  return out;
}

const PATCH = 'patch', MAINTENANCE = 'maintenance';
const PUBG_HEADERS = { 'Service-Namespace': 'PUBG_OFFICIAL', 'Service-Game': 'pubg' };
const LOL_STATUS = 'https://lol.secure.dyn.riotcdn.net/channels/public/x/status/kr1.json';
const VALO_STATUS = 'https://valorant.secure.dyn.riotcdn.net/channels/public/x/status/kr.json';
const PUBG_NOTICE_API = 'https://api-foc.krafton.com/content/post/news?lang=ko&displayLocationType=NORMAL&category=notice&size=10&page=1';

// 확인 대상(게임 × 종류). id는 저장 기록의 키라서 바꾸면 처음부터 다시 기억만 한다.
// allowEmpty: 점검처럼 "비어 있는 게 정상"인 목록은 빈 결과를 오류로 보지 않는다.
const GAMES = [
  { id: 'lol', kind: PATCH, name: '리그 오브 레전드', color: 0xc89b3c, emojiId: PATCHNOTE_EMOJIS.lol,
    load: async () => parseRiotPatches(await fetchText(`${LOL_BASE}/ko-kr/news/tags/patch-notes/`), LOL_BASE) },
  { id: 'lol-maint', kind: MAINTENANCE, allowEmpty: true, name: '리그 오브 레전드', color: 0xc89b3c, emojiId: PATCHNOTE_EMOJIS.lol,
    load: async () => parseRiotMaintenances(await fetchText(LOL_STATUS), 'https://status.riotgames.com/lol?region=kr1&locale=ko_KR') },
  { id: 'valorant', kind: PATCH, name: '발로란트', color: 0xff4655, emojiId: PATCHNOTE_EMOJIS.valorant,
    load: async () => parseRiotPatches(await fetchText(`${VALO_BASE}/ko-kr/news/tags/patch-notes/`), VALO_BASE) },
  { id: 'valorant-maint', kind: MAINTENANCE, allowEmpty: true, name: '발로란트', color: 0xff4655, emojiId: PATCHNOTE_EMOJIS.valorant,
    load: async () => parseRiotMaintenances(await fetchText(VALO_STATUS), 'https://status.riotgames.com/valorant?region=kr&locale=ko_KR') },
  { id: 'overwatch', kind: PATCH, name: '오버워치', color: 0xf99e1a, emojiId: PATCHNOTE_EMOJIS.overwatch, load: () => loadOverwatch() },
  { id: 'pubg', kind: PATCH, name: '배틀그라운드', color: 0xf2a900, emojiId: PATCHNOTE_EMOJIS.pubg,
    load: async () => parsePubgPatches(await fetchText(PUBG_API, PUBG_HEADERS)) },
  { id: 'pubg-maint', kind: MAINTENANCE, allowEmpty: true, name: '배틀그라운드', color: 0xf2a900, emojiId: PATCHNOTE_EMOJIS.pubg,
    load: async () => parsePubgPatches(await fetchText(PUBG_NOTICE_API, PUBG_HEADERS), Date.now(), { category: 'notice', titleHas: '점검' }) },
];

// ── 공지 카드(컴포넌트 v2) ──────────────────────────────────────
function kstDayText(at) {
  if (at == null) return null;
  const d = new Date(at + KST_MS);
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 게시`;
}

function buildPatchNotePayload(game, entry) {
  const title = entry.title.length > 200 ? `${entry.title.slice(0, 199)}…` : entry.title;
  const head = game.kind === MAINTENANCE ? `🛠️ **${game.name}** · 점검 공지` : `📢 **${game.name}** · 새 패치노트`;
  const lines = [
    new TextDisplayBuilder().setContent(`-# ${head}`),
    new TextDisplayBuilder().setContent(`### ${title}`),
  ];
  const sub = [kstDayText(entry.at), entry.note].filter(Boolean).join(' · ');
  if (sub) lines.push(new TextDisplayBuilder().setContent(`-# ${sub}`));

  const container = new ContainerBuilder().setAccentColor(game.color);
  if (game.emojiId) {
    // 아케이드 봇에 올려둔 게임 이모지를 썸네일로 쓴다(이미지 파일을 따로 들고 있거나 업로드할 필요 없음)
    const thumb = new ThumbnailBuilder().setURL(`https://cdn.discordapp.com/emojis/${game.emojiId}.png?size=128`).setDescription(game.name);
    container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(...lines).setThumbnailAccessory(thumb));
  } else {
    container.addTextDisplayComponents(...lines);
  }
  container.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('내용 보기').setEmoji('🔗').setURL(entry.url),
  ));
  return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

// ── 감시 ───────────────────────────────────────────────────────
// deps: games(로더 목록), send(game, entry), storePath, now(), logFail(game, err) — 테스트에서 바꿔 끼운다.
function createWatcher({ games, send, storePath = STORE_PATH, now = Date.now, logFail = () => {}, logInfo = () => {} }) {
  let state = {};
  try {
    if (fs.existsSync(storePath)) state = JSON.parse(fs.readFileSync(storePath, 'utf8')) || {};
  } catch (err) {
    // 기록이 없어져도 괜찮다 — 게임마다 처음 읽을 때 '이미 본 것'으로만 기억하고 공지하지 않는다.
    logInfo(`패치노트 기록 읽기 실패(다시 기억만 하고 공지는 하지 않음): ${err?.message ?? err}`);
    state = {};
  }
  const save = () => {
    try { writeJsonIfChanged(storePath, state); } catch (err) { logInfo(`패치노트 기록 저장 실패: ${err?.message ?? err}`); }
  };
  const runtime = new Map(games.map((g, i) => [g.id, { nextAt: now() + i * STAGGER_MS, fails: 0 }]));

  // 한 게임을 한 번 확인한다. 알린 개수를 돌려준다(처음 기억만 한 경우 0).
  async function checkGame(game) {
    const entries = await game.load();
    if (!entries.length && !game.allowEmpty) throw new EmptyListError('패치노트 목록이 비어 있음(사이트 구조가 바뀌었을 수 있음)');
    const st = state[game.id] ??= { seeded: false, seen: [] };
    const seen = new Set(st.seen);
    if (!st.seeded) {
      st.seen = entries.map(e => e.key).slice(-MAX_SEEN);
      st.seeded = true;
      save();
      return 0;
    }
    const fresh = entries.filter(e => !seen.has(e.key)).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    if (!fresh.length) return 0;
    if (fresh.length > MAX_FRESH) {
      for (const e of fresh) seen.add(e.key);
      st.seen = [...seen].slice(-MAX_SEEN);
      save();
      logInfo(`${game.name}: 새 글이 한꺼번에 ${fresh.length}개 보여 구조 변경으로 판단, 공지 없이 기억만 함`);
      return 0;
    }
    let sent = 0;
    for (const e of fresh) {
      await send(game, e); // 실패하면 여기서 던져 이 글은 '알림 완료'로 기록되지 않는다
      seen.add(e.key);
      st.seen = [...seen].slice(-MAX_SEEN);
      save();
      sent++;
    }
    return sent;
  }

  let running = false;
  // 차례가 된 게임을 하나씩 확인한다(동시에 읽지 않음).
  async function tick() {
    if (running) return;
    running = true;
    try {
      for (const game of games) {
        const rt = runtime.get(game.id);
        if (now() < rt.nextAt) continue;
        try {
          await checkGame(game);
          rt.fails = 0;
        } catch (err) {
          rt.fails++;
          logFail(game, err);
        }
        // 연속 실패하면 1배 → 2배 → 4배 → 최대 6배까지 간격을 늘린다
        rt.nextAt = now() + (rt.fails ? POLL_MS * Math.min(MAX_BACKOFF, 2 ** (rt.fails - 1)) : POLL_MS);
      }
    } finally {
      running = false;
    }
  }

  return { checkGame, tick, state: () => state };
}

let timer = null;
function startPatchNoteWatcher(client) {
  if (timer) return;
  const send = async (_game, entry) => {
    const channel = await client.channels.fetch(PATCHNOTE_CHANNEL_ID);
    if (!channel?.isTextBased()) throw new Error(`패치노트 채널을 찾을 수 없음(${PATCHNOTE_CHANNEL_ID})`);
    await channel.send(buildPatchNotePayload(_game, entry));
    logSystem({ 유형: '패치노트', 내용: `${_game.name} 새 패치노트 공지 — ${entry.title}` });
  };
  const watcher = createWatcher({
    games: GAMES,
    send,
    logFail: (game, err) => logErrorThrottled(`patchnote-${game.id}`, '패치노트', `${game.name} 패치노트 확인 실패`, err, {}, 60 * 60_000),
    logInfo: msg => logSystem({ 유형: '패치노트', 내용: msg }),
  });
  timer = setInterval(() => { watcher.tick().catch(err => console.error('패치노트 확인 오류:', err)); }, TICK_MS);
  timer.unref?.();
  watcher.tick().catch(err => console.error('패치노트 확인 오류:', err));
}

module.exports = {
  startPatchNoteWatcher, createWatcher, buildPatchNotePayload,
  parseRiotPatches, parseOverwatchPatches, parsePubgPatches, parseRiotMaintenances, GAMES, POLL_MS, MAX_BACKOFF,
};

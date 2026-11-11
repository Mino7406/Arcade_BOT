// handlers/로그.js — 명령어 실행, 버튼 클릭, 선택 메뉴, 모달 제출 등 봇에서 일어나는
// 모든 상호작용을 DB/log/날짜.json(KST 하루 한 파일)에 기록하는 모듈. (예전 이름: 명령어로그.js, command-log.json —
// 슬래시 커맨드만 남기다가, 버튼·선택 메뉴·모달까지 전부 남기도록 넓히면서 이름도 바꿈)
//
// 예전 방식은 필드명이 영어 축약어라(timestamp/userId/options...) 코드를 모르는 사람이
// 파일만 열어봤을 땐 무슨 일이 있었는지 바로 읽기 어려웠다. 그래서 필드명을 한글로 쓰고,
// 어떤 상호작용이든 "누가 · 어디서 · 무엇을" 한 문장으로 요약하는 `내용` 필드를 함께 남긴다.
//
// 예)
// {
//   "시각": "2026-08-28 11:32:05",
//   "유형": "명령어",
//   "유저": "Mino_7406(457437911869161472)",
//   "채널": "#놀이터",
//   "내용": "/끝말잇기 명령어 사용"
// }

const fs = require('fs');
const path = require('path');
const { KST_OFFSET_MS, kstDateString } = require('./시간');
const { displayNameFromInteraction } = require('./이름');

// 로그는 날짜별 파일로 나눠 저장한다: DB/log/2026-11-12.json (KST 날짜).
// 예전엔 DB/log.json 하나에 최근 10000개를 담았는데, pretty-print로 2MB를 넘기면서 호스팅 사이트
// 파일 편집기(2MB 초과 파일은 못 엶)에서 열 수 없게 됐고, 클릭마다 2MB를 통째로 다시 쓰는 부담도 컸다.
// 지금은 오늘 파일만 메모리에 들고 그 파일만 다시 쓴다. 파일 안에서는 최신 기록이 맨 위(내림차순).
const LOG_DIR = path.join(__dirname, '..', 'DB', 'log');
const LEGACY_PATH = path.join(__dirname, '..', 'DB', 'log.json'); // 예전 단일 파일 — 처음 한 번 날짜별로 옮기고 지운다
fs.mkdirSync(LOG_DIR, { recursive: true });

// 하루 기록이 이만큼을 넘으면 같은 날짜의 다음 파일(2026-11-12_2.json, _3 …)로 이어 쓴다.
// 8000개 ≈ 1.6MB라 파일 하나가 사이트 편집기 한도(2MB) 안에 든다. _2가 앞 파일보다 나중 기록이다.
const PART_MAX = 8000;
// 오늘 포함 최근 이만큼의 날짜 파일만 남기고, 날짜가 바뀔 때 그보다 오래된 파일은 지운다.
const KEEP_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

function nowKstStr() {
  const kst = new Date(Date.now() + KST_OFFSET_MS);
  const YYYY = kst.getUTCFullYear();
  const MM = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const DD = String(kst.getUTCDate()).padStart(2, '0');
  const HH = String(kst.getUTCHours()).padStart(2, '0');
  const mm = String(kst.getUTCMinutes()).padStart(2, '0');
  const ss = String(kst.getUTCSeconds()).padStart(2, '0');
  return `${YYYY}-${MM}-${DD} ${HH}:${mm}:${ss}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^(\d{4}-\d{2}-\d{2})(?:_(\d+))?\.json$/;
const partPath = (date, part) => path.join(LOG_DIR, part > 1 ? `${date}_${part}.json` : `${date}.json`);
const serialize = (arr) => JSON.stringify(arr, null, 2); // 사람이 읽는 감사 로그라 pretty-print 유지

function listLogFiles() {
  return fs.readdirSync(LOG_DIR)
    .map(name => { const m = FILE_RE.exec(name); return m && { name, date: m[1], part: m[2] ? Number(m[2]) : 1 }; })
    .filter(Boolean);
}

function readArray(file) {
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// 임시 파일에 다 쓴 뒤 rename으로 교체한다(내전/모집 저장과 같은 방식). 쓰는 도중 프로세스가
// 죽어도 기존 파일이 반쪽짜리로 깨지지 않는다.
function writeAtomicSync(file, arr, tmpSuffix = '.tmp') {
  fs.writeFileSync(file + tmpSuffix, serialize(arr), 'utf8');
  fs.renameSync(file + tmpSuffix, file);
}

// 오래된 순으로 정렬된 하루치 기록을 PART_MAX씩 끊어 날짜 파일(들)로 쓴다. 각 파일 안은 최신이 위.
function writeDayParts(date, entriesAsc) {
  for (let i = 0; i * PART_MAX < entriesAsc.length; i++) {
    writeAtomicSync(partPath(date, i + 1), entriesAsc.slice(i * PART_MAX, (i + 1) * PART_MAX).reverse());
  }
}

// 예전 DB/log.json을 날짜별 파일로 옮긴다. 다 옮긴 뒤에만 지우므로, 도중에 꺼지면 다음 시작 때
// 처음부터 다시 옮긴다(그 사이 반쯤 써진 날짜 파일은 지우고 새로 씀 — 옛 파일이 원본이라 겹치지 않게).
function migrateLegacy() {
  if (!fs.existsSync(LEGACY_PATH)) return;
  const old = readArray(LEGACY_PATH);
  // 옛 파일은 최신→오래된 순(아주 옛날 형식은 반대). 시각 오름차순으로 맞춘다(같은 초는 원래 순서 유지).
  if (old.length >= 2 && String(old[0]?.시각) > String(old[old.length - 1]?.시각)) old.reverse();
  old.sort((a, b) => String(a?.시각).localeCompare(String(b?.시각)));
  const byDate = new Map();
  for (const e of old) {
    const date = String(e?.시각 ?? '').slice(0, 10);
    if (!DATE_RE.test(date)) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(e);
  }
  const existing = listLogFiles();
  for (const [date, entries] of byDate) {
    for (const f of existing) if (f.date === date) fs.unlinkSync(path.join(LOG_DIR, f.name));
    writeDayParts(date, entries);
  }
  fs.unlinkSync(LEGACY_PATH);
  console.log(`로그 이전: DB/log.json ${old.length}개 → DB/log/ 날짜별 ${byDate.size}개 날짜`);
}

function pruneOld(today) {
  const cutoff = kstDateString(Date.parse(`${today}T00:00:00Z`) - KST_OFFSET_MS - (KEEP_DAYS - 1) * DAY_MS);
  for (const f of listLogFiles()) {
    if (f.date < cutoff) {
      try { fs.unlinkSync(path.join(LOG_DIR, f.name)); } catch (err) { console.error('오래된 로그 삭제 실패:', err); }
    }
  }
}

// 지금 쓰고 있는 날짜 파일 하나만 메모리에 둔다: { date, part, arr(최신이 맨 앞) }.
let cur = null;
let initialized = false;

function openDay(date) {
  const parts = listLogFiles().filter(f => f.date === date).map(f => f.part);
  const part = parts.length ? Math.max(...parts) : 1;
  cur = { date, part, arr: readArray(partPath(date, part)) };
}

// 파일 쓰기는 비동기 루프 하나만 돌리고, 저장할 파일들을 dirtyFiles(경로 → 배열)에 모아 둔다.
// 첫 기록 후 LOG_FLUSH_DELAY_MS 동안 들어온 기록을 한 번에 저장한다(클릭마다 쓰면 CPU 25% 호스팅에서
// 응답이 밀린다). 강제 종료(SIGKILL) 시 최대 그만큼의 로그만 잃고, 정상 종료는 flushLogsSync가 마저 저장한다.
// 날짜가 바뀌거나 다음 파일로 넘어가도 이전 파일 배열은 dirtyFiles에 남아 있다가 같이 저장된다.
const LOG_FLUSH_DELAY_MS = 10_000;
const dirtyFiles = new Map();
let inFlight = new Map();
let writing = false;
let flushTimer = null;

async function flushLoop() {
  while (dirtyFiles.size) {
    inFlight = new Map(dirtyFiles);
    dirtyFiles.clear();
    for (const [file, arr] of inFlight) {
      await fs.promises.writeFile(`${file}.tmp`, serialize(arr), 'utf8');
      await fs.promises.rename(`${file}.tmp`, file);
      inFlight.delete(file);
    }
  }
}

function startFlush() {
  flushTimer = null;
  if (writing) return; // 이미 도는 루프가 방금 바뀐 내용까지 같이 저장한다
  writing = true;
  flushLoop()
    .catch(err => console.error('로그 파일 저장 실패:', err))
    .finally(() => {
      for (const [file, arr] of inFlight) if (!dirtyFiles.has(file)) dirtyFiles.set(file, arr); // 실패한 건 다음에 다시
      inFlight = new Map();
      writing = false;
      if (dirtyFiles.size) scheduleWrite(); // 루프가 끝난 직후~여기 사이에 들어온 기록도 놓치지 않게
    });
}

function scheduleWrite() {
  if (flushTimer || writing) return;
  flushTimer = setTimeout(startFlush, LOG_FLUSH_DELAY_MS);
  flushTimer.unref(); // 이 타이머 하나 때문에 프로세스가 종료를 미루지 않게
}

// 종료 직전 한 번만 동기로 저장한다. shutdown()이 process.exit()을 부르면 진행 중이던
// 비동기 쓰기가 그대로 끊겨 마지막 몇 줄이 날아가므로, 여기서 확실히 밀어 넣는다.
function flushLogsSync() {
  const all = new Map([...inFlight, ...dirtyFiles]);
  if (cur) all.set(partPath(cur.date, cur.part), cur.arr);
  for (const [file, arr] of all) {
    try {
      writeAtomicSync(file, arr, '.exit.tmp'); // 끊긴 비동기 쓰기의 .tmp와 겹치지 않게 다른 이름
    } catch (err) {
      console.error('로그 종료 저장 실패:', err);
    }
  }
  dirtyFiles.clear();
}

function writeEntry(entry) {
  if (!initialized) {
    initialized = true;
    try { migrateLegacy(); } catch (err) { console.error('예전 로그(DB/log.json) 이전 실패:', err); }
  }
  const date = String(entry.시각).slice(0, 10);
  if (!cur || cur.date !== date) {
    openDay(date);
    try { pruneOld(date); } catch (err) { console.error('오래된 로그 정리 실패:', err); }
  }
  if (cur.arr.length >= PART_MAX) cur = { date, part: cur.part + 1, arr: [] }; // 하루치가 많으면 다음 파일로
  cur.arr.unshift(entry); // 최신 로그를 맨 위에
  dirtyFiles.set(partPath(cur.date, cur.part), cur.arr);
  scheduleWrite();
}


// 명령어 옵션(/틱택토 상대방:@누구 등)을 "이름=값, 이름=값" 형태로 짧게 풀어 쓴다.
function describeOptions(interaction) {
  const options = interaction.options?.data || [];
  if (!options.length) return '';
  return ` (${options.map(opt => `${opt.name}=${opt.value}`).join(', ')})`;
}

// 로그에는 커스텀ID 대신 버튼에 실제로 보이는 글자(이모지 + 라벨)를 남긴다.
// interaction.component는 눌린 버튼 컴포넌트다(메시지에서 customId로 찾아옴).
// 이모지만 있고 라벨이 없는 버튼(예: 틱택토 칸 ⬜)도 있으므로, 둘 다 없으면 커스텀ID로 fallback.
function buttonName(interaction) {
  const c = interaction.component;
  const parts = [c?.emoji?.name, c?.label].filter(Boolean);
  return parts.length ? parts.join(' ') : interaction.customId;
}

// interaction 하나를 보고 "무엇을 했는지"를 유형 + 사람이 읽을 수 있는 한 줄로 정리한다.
function describeInteraction(interaction) {
  if (interaction.isChatInputCommand()) {
    return { 유형: '명령어', 내용: `/${interaction.commandName} 명령어 사용${describeOptions(interaction)}` };
  }
  if (interaction.isButton()) {
    return { 유형: '버튼', 내용: `'${buttonName(interaction)}' 버튼 클릭` };
  }
  if (interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) {
    const values = interaction.values?.length ? ` → ${interaction.values.join(', ')}` : '';
    return { 유형: '선택 메뉴', 내용: `${interaction.customId} 선택${values}` };
  }
  if (interaction.isModalSubmit()) {
    return { 유형: '모달 제출', 내용: `${interaction.customId} 모달 제출` };
  }
  return { 유형: '기타', 내용: interaction.customId || interaction.commandName || '알 수 없는 상호작용' };
}

// interaction이 아예 없는 곳(타이머로 도는 DM 발송 등)에서 봇이 스스로 겪은 일을 남긴다.
// logAction은 interaction.user/channel에서 유저·채널을 뽑아 쓰므로 그런 경로에서는 못 쓴다.
// 필드 구성(시각/유형/유저/채널/내용)은 동일하게 맞추고, 해당 없는 값만 '-'로 채운다.
// 수준('경고'/'오류')은 지정했을 때만 필드로 남긴다 — 평소 기록의 모양은 그대로 두고,
// 파일에서 "수준" 으로 검색하면 문제 상황만 골라볼 수 있게 하기 위함.
function logSystem({ 유형, 내용, 유저 = '-', 채널 = '-', 수준 }) {
  const entry = { 시각: nowKstStr(), 유형, 유저, 채널, 내용 };
  if (수준) entry.수준 = 수준;
  writeEntry(entry);
}

// console.error만 하던 오류를 파일 로그에도 남긴다(봇이 꺼지면 콘솔은 사라지므로).
// 로그 기록 자체가 또 다른 오류를 만들어 원래 처리 흐름을 깨면 안 되므로 여기서 삼킨다.
function logError(유형, 내용, err, extra = {}) {
  try {
    const detail = err ? ` — ${err?.code ? `${err.code}: ` : ''}${err?.message ?? err}` : '';
    logSystem({ 유형, 내용: `${내용}${detail}`, 수준: '오류', ...extra });
  } catch (e) {
    console.error('오류 로그 기록 실패:', e);
  }
}

// 게임 3종(끝말잇기·오목·틱택토)의 내기/봇전 정산 결과(game.xpResult)를 한 줄 문구로 바꾼다.
// XP가 실제로 오간 내역은 applyXp의 reason 로그가 유저별로 따로 남기므로, 여기서는 "정산이 어떻게
// 처리됐는지"(내기 성사 / 봇전 보상 / 쿨다운·한도·정지로 보류)만 요약한다.
function describeXpResult(r) {
  if (!r) return '정산 없음';
  switch (r.type) {
    case 'wager': return `내기 정산 ${r.wager}XP`;
    case 'bot_win': return `봇전 보상 지급${r.capped ? '(일일 한도로 일부 삭감)' : ''}`;
    case 'cooldown': return '정산 보류 — 같은 유저 연속 정산 쿨다운';
    case 'bot_daily_cap': return '정산 보류 — 봇전 일일 XP 한도';
    case 'user_frozen': return '정산 보류 — XP 지급 정지 유저';
    case 'frozen': return r.raid ? '정산 생략 — 레이드로 XP 정지 중' : '정산 생략 — 미니게임 XP 긴급정지';
    default: return `정산 ${r.type}`;
  }
}

// 게임이 끝날 때 "누가 · 누구랑 · 어떻게 끝났는지"를 한 줄로 남긴다.
// players: [{ id, name }], 결과: 사람이 읽는 승패/종료 사유 문구.
function logGameResult(게임, { channel, players = [], 결과, xpResult }) {
  const names = players.map(p => (p.id === 'BOT' ? '봇' : p.name ? `${p.name}(${p.id})` : userLabel(p.id))).join(', ');
  logSystem({
    유형: '게임 결과',
    채널: channel?.name ? `#${channel.name}` : '-',
    내용: `${게임} 종료 — 참가자: ${names || '-'} / ${결과} / ${describeXpResult(xpResult)}`,
  });
}

// 30초 자동 저장처럼 반복되는 곳에서 같은 오류가 계속 나면 로그가 그것만으로 가득 찬다.
// key별로 minIntervalMs 안에 다시 오는 건 건너뛰고, 건너뛴 횟수는 다음 기록에 함께 적는다.
const throttleState = new Map(); // key → { last, skipped }
function logErrorThrottled(key, 유형, 내용, err, extra = {}, minIntervalMs = 10 * 60 * 1000) {
  const st = throttleState.get(key) || { last: 0, skipped: 0 };
  const now = Date.now();
  if (now - st.last < minIntervalMs) {
    st.skipped++;
    throttleState.set(key, st);
    return;
  }
  const suffix = st.skipped ? ` (그동안 같은 오류 ${st.skipped}회 생략)` : '';
  throttleState.set(key, { last: now, skipped: 0 });
  logError(유형, `${내용}${suffix}`, err, extra);
}

// interaction이 없는 경로(XP 지급, 게임 정산 등)에서 유저를 "이름(ID)"로 적기 위한 조회.
// 캐시에 없으면 ID만 적는다. index.js가 준비되면 setLogClient(client)로 클라이언트를 넘겨둔다.
let logClient = null;
function setLogClient(client) { logClient = client; }
function userLabel(userId) {
  if (!userId) return '-';
  const u = logClient?.users?.cache?.get(userId);
  const name = u ? (u.globalName || u.username) : null;
  return name ? `${name}(${userId})` : `(${userId})`;
}

// 로그를 남기지 않을 상호작용의 customId 접두사.
// 틱택토 칸(ttt:move:...)은 한 판에 수십 번 눌려 로그가 ⬜ 클릭으로만 가득 차고, 정작
// 봐야 할 명령어·관리 버튼이 묻힌다. 게임 진행 자체는 승패
// 결과와 XP 지급 기록으로 충분히 추적되므로 칸 클릭은 남기지 않는다.
const SKIP_LOG_PREFIXES = ['ttt:move:', 'raid:act:']; // 레이드 행동 버튼도 한 판에 수십 번 눌려 같은 이유로 뺀다(결과는 '레이드' 로그로 남음)

// 명령어/버튼/선택 메뉴/모달 제출 등 모든 상호작용을 기록한다.
// (index.js의 interactionCreate 맨 앞에서, 채널 제한 등 다른 처리보다 먼저 호출 —
//  막힌 시도까지 포함해 실제로 무슨 입력이 들어왔는지 전부 남기기 위함)
function logInteraction(interaction) {
  if (!interaction.user) return;
  if (SKIP_LOG_PREFIXES.some(prefix => interaction.customId?.startsWith(prefix))) return;

  const { 유형, 내용 } = describeInteraction(interaction);
  logAction(interaction, 유형, 내용);
}

// interactionCreate 자동 로그(logInteraction) 말고, 핸들러가 "실제로 무슨 일이 일어났는지"를
// 직접 한 줄로 남기고 싶을 때 쓴다. 예: /xp가 조정에 성공하면 대상·증감·전후값을 기록.
function logAction(interaction, 유형, 내용) {
  if (!interaction?.user) return;

  const channel = interaction.channel;
  const 채널 = interaction.guildId ? `#${channel?.name ?? interaction.channelId}` : 'DM';

  writeEntry({
    시각: nowKstStr(),
    유형,
    유저: `${displayNameFromInteraction(interaction)}(${interaction.user.id})`,
    채널,
    내용,
  });
}

module.exports = { logInteraction, logAction, logSystem, logError, logErrorThrottled, logGameResult, setLogClient, userLabel, flushLogsSync };

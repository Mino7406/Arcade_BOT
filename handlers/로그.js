// handlers/로그.js — 명령어 실행, 버튼 클릭, 선택 메뉴, 모달 제출 등 봇에서 일어나는
// 모든 상호작용을 DB/log.json에 기록하는 모듈. (예전 이름: 명령어로그.js, command-log.json —
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
const { KST_OFFSET_MS } = require('./시간');
const { displayNameFromInteraction } = require('./이름');

const LOG_PATH = path.join(__dirname, '..', 'DB', 'log.json');
const TMP_PATH = `${LOG_PATH}.tmp`;
fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

// 로그가 무한정 커져 파일이 무거워지지 않도록 최근 이만큼만 보관한다(오래된 것부터 버림).
const MAX_ENTRIES = 5000;

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

// 로그 배열을 메모리에 들고 있는다. 예전엔 상호작용 한 번마다 log.json 전체(최대 5000개)를
// 다시 읽고 파싱했는데(writeEntry → readLogs), 버튼을 누를 때마다 수천 개 객체를 파싱/직렬화하는
// 낭비였다. 시작 시 한 번만 읽고, 이후로는 메모리 배열 맨 앞에 넣은 뒤 파일로 덮어쓴다
// (파일이 사람이 읽는 감사 로그라 pretty-print는 유지, 크래시 대비 write-through도 유지).
// 파일은 최신 로그가 맨 위에 오도록 저장한다(내림차순).
let logs = null;

function readLogs() {
  if (logs) return logs;
  try {
    logs = fs.existsSync(LOG_PATH) ? JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')) : [];
    if (!Array.isArray(logs)) logs = [];
  } catch {
    logs = [];
  }
  // 예전엔 오래된→최신(오름차순)으로 쌓았다. 그런 파일이면 한 번 뒤집어 최신→오래된 순으로 맞춘다.
  // (이미 내림차순인 파일은 그대로 둔다 — 재시작해도 다시 뒤집히지 않도록 시각으로 판별)
  if (logs.length >= 2 && String(logs[0].시각) <= String(logs[logs.length - 1].시각)) {
    logs.reverse();
  }
  return logs;
}

// 파일 쓰기는 비동기 1건만 돌리고, 그 사이 들어온 기록은 dirty 플래그로 합친다.
// 예전엔 상호작용 한 번마다 writeFileSync로 전체(최대 5000개, 약 700KB)를 동기 저장했다.
// 직렬화 1.4ms + 동기 쓰기 0.9ms가 매 클릭마다 이벤트 루프를 통째로 멈춰, 여러 명이 동시에
// 버튼을 누르면 그만큼 봇 응답이 밀린다. 지금은 (1) 쓰기가 비동기라 루프를 막지 않고,
// (2) 쓰기가 도는 동안 쌓인 기록들이 한 번의 저장으로 합쳐진다.
// 저장을 미루지는 않으므로(요청 즉시 시작) 크래시 대비 write-through 성격은 그대로다.
let writing = false;
let dirty = false;

function serialize() {
  return JSON.stringify(logs, null, 2); // 사람이 읽는 감사 로그라 pretty-print 유지
}

// 임시 파일에 다 쓴 뒤 rename으로 교체한다(내전/모집 저장과 같은 방식). 쓰는 도중 프로세스가
// 죽어도 기존 log.json이 반쪽짜리로 깨지지 않는다 — 깨지면 readLogs가 통째로 버린다.
async function flushLoop() {
  while (dirty) {
    dirty = false;
    await fs.promises.writeFile(TMP_PATH, serialize(), 'utf8');
    await fs.promises.rename(TMP_PATH, LOG_PATH);
  }
}

function scheduleWrite() {
  dirty = true;
  if (writing) return; // 이미 도는 루프가 방금 바뀐 내용까지 같이 저장한다
  writing = true;
  flushLoop()
    .catch(err => console.error('로그 파일 저장 실패:', err))
    .finally(() => { writing = false; });
}

// 종료 직전 한 번만 동기로 저장한다. shutdown()이 process.exit()을 부르면 진행 중이던
// 비동기 쓰기가 그대로 끊겨 마지막 몇 줄이 날아가므로, 여기서 확실히 밀어 넣는다.
function flushLogsSync() {
  if (!logs) return; // 한 번도 읽지 않았으면 저장할 것도 없다
  try {
    fs.writeFileSync(TMP_PATH, serialize(), 'utf8');
    fs.renameSync(TMP_PATH, LOG_PATH);
  } catch (err) {
    console.error('로그 종료 저장 실패:', err);
  }
}

function writeEntry(entry) {
  const arr = readLogs();
  arr.unshift(entry); // 최신 로그를 맨 위에
  if (arr.length > MAX_ENTRIES) arr.length = MAX_ENTRIES; // 넘치면 오래된(맨 아래)부터 버림
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
function logSystem({ 유형, 내용, 유저 = '-', 채널 = '-' }) {
  writeEntry({ 시각: nowKstStr(), 유형, 유저, 채널, 내용 });
}

// 로그를 남기지 않을 상호작용의 customId 접두사.
// 틱택토 칸(ttt:move:...)은 한 판에 수십 번 눌려 로그가 ⬜ 클릭으로만 가득 차고, 정작
// 봐야 할 명령어·관리 버튼이 5000개 보관 한도 밖으로 밀려난다. 게임 진행 자체는 승패
// 결과와 XP 지급 기록으로 충분히 추적되므로 칸 클릭은 남기지 않는다.
const SKIP_LOG_PREFIXES = ['ttt:move:'];

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

module.exports = { logInteraction, logAction, logSystem, flushLogsSync };

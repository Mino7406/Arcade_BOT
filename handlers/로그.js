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

const LOG_PATH = path.join(__dirname, '..', 'DB', 'log.json');
fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

// 로그가 무한정 커져 파일이 무거워지지 않도록 최근 이만큼만 보관한다(오래된 것부터 버림).
const MAX_ENTRIES = 5000;

function nowKstStr() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const YYYY = kst.getUTCFullYear();
  const MM = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const DD = String(kst.getUTCDate()).padStart(2, '0');
  const HH = String(kst.getUTCHours()).padStart(2, '0');
  const mm = String(kst.getUTCMinutes()).padStart(2, '0');
  const ss = String(kst.getUTCSeconds()).padStart(2, '0');
  return `${YYYY}-${MM}-${DD} ${HH}:${mm}:${ss}`;
}

function readLogs() {
  try {
    if (!fs.existsSync(LOG_PATH)) return [];
    return JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function writeEntry(entry) {
  const logs = readLogs();
  logs.push(entry);
  if (logs.length > MAX_ENTRIES) logs.splice(0, logs.length - MAX_ENTRIES);
  fs.writeFileSync(LOG_PATH, JSON.stringify(logs, null, 2), 'utf8');
}

// 다른 게임 핸들러들과 같은 규칙: 서버 별명 → 글로벌 표시 이름 → 유저명 순으로 사용.
function getDisplayName(interaction) {
  return interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
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

// 명령어/버튼/선택 메뉴/모달 제출 등 모든 상호작용을 기록한다.
// (index.js의 interactionCreate 맨 앞에서, 채널 제한 등 다른 처리보다 먼저 호출 —
//  막힌 시도까지 포함해 실제로 무슨 입력이 들어왔는지 전부 남기기 위함)
function logInteraction(interaction) {
  if (!interaction.user) return;

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
    유저: `${getDisplayName(interaction)}(${interaction.user.id})`,
    채널,
    내용,
  });
}

module.exports = { logInteraction, logAction };

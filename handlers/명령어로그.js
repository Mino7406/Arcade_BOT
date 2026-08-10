// handlers/명령어로그.js — 누가 언제 어떤 명령어를 썼는지 command-log.json에 기록하는 모듈

const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '..', 'command-log.json');

function readLogs() {
  try {
    if (!fs.existsSync(LOG_PATH)) return [];
    return JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
  } catch {
    return [];
  }
}

// 로그를 KST 기준 "YYYY-MM-DD HH:mm:ss" 형태로 남겨, 파일을 열어봤을 때 시:분:초까지 바로 보이게 함.
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

// 슬래시 커맨드 실행 정보를 기록합니다. (interactionCreate에서 execute 직전/직후 호출)
function logCommandUsage(interaction) {
  const options = (interaction.options?.data || []).map(opt => ({
    name: opt.name,
    value: opt.value,
  }));

  const entry = {
    timestamp: nowKstStr(),
    userId: interaction.user.id,
    username: interaction.user.tag,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    command: interaction.commandName,
    options,
  };

  const logs = readLogs();
  logs.push(entry);
  fs.writeFileSync(LOG_PATH, JSON.stringify(logs, null, 2), 'utf8');
}

module.exports = { logCommandUsage };

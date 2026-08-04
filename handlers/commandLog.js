// handlers/commandLog.js — 누가 언제 어떤 명령어를 썼는지 command-log.json에 기록하는 모듈

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

// 슬래시 커맨드 실행 정보를 기록합니다. (interactionCreate에서 execute 직전/직후 호출)
function logCommandUsage(interaction) {
  const options = (interaction.options?.data || []).map(opt => ({
    name: opt.name,
    value: opt.value,
  }));

  const entry = {
    timestamp: new Date().toISOString(),
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

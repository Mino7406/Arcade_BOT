// db.js — 내전/모집 데이터를 JSON 파일에 영속화(저장)하는 모듈
// better-sqlite3 대신 Node.js 내장 fs를 사용해 별도 설치 없이 동작합니다.

const fs   = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');

// match 객체 안의 직렬화 불가 객체(Discord 객체)를 제거하고 JSON 문자열로 변환
function matchToJSON(match) {
  const { message, data, ...rest } = match;
  const { _previewInteraction, ...cleanData } = data || {};
  return JSON.stringify({ ...rest, data: cleanData });
}

// 현재 메모리의 모든 내전/모집을 data.json에 저장
function saveAll(client) {
  const rows = [];
  const dump = (map, type) => {
    if (!map) return;
    for (const [messageId, match] of map) {
      if (!match.message) continue;
      rows.push({
        message_id: messageId,
        channel_id: match.message.channelId,
        type,
        data: matchToJSON(match),
      });
    }
  };
  dump(client.naejeonMatches, 'naejeon');
  dump(client.mojipMatches,   'mojip');
  fs.writeFileSync(DB_PATH, JSON.stringify(rows), 'utf8');
}

// 저장된 모든 행을 읽어옴 (봇 시작 시 복원할 때 사용)
function loadRows() {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return [];
  }
}

module.exports = { saveAll, loadRows };

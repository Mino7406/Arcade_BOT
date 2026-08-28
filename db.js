// db.js — 내전/모집 데이터를 JSON 파일에 영속화(저장)하는 모듈
// better-sqlite3 대신 Node.js 내장 fs를 사용해 별도 설치 없이 동작합니다.

const fs   = require('fs');
const path = require('path');

// 흩어져 있던 JSON 저장 파일들을 DB/ 폴더 하나로 모아둔다(다른 모듈들도 동일).
// 파일명 N-M.json은 이 파일이 담는 두 매치 타입, 내전(N)/모집(M)의 앞글자를 딴 것.
const DB_DIR  = path.join(__dirname, 'DB');
const DB_PATH = path.join(DB_DIR, 'N-M.json');
const TMP_PATH = DB_PATH + '.tmp';

fs.mkdirSync(DB_DIR, { recursive: true });

// match 객체 안의 직렬화 불가 객체(Discord 객체)를 제거하고 JSON 문자열로 변환
function matchToJSON(match) {
  const { message, data, _autoEndTimer, _notifyTimer, ...rest } = match;
  const { _previewInteraction, ...cleanData } = data || {};
  return JSON.stringify({ ...rest, data: cleanData });
}

// 현재 메모리의 모든 내전/모집을 N-M.json에 저장
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
  if (client.cancelledDeletions) {
    for (const [messageId, entry] of client.cancelledDeletions) {
      rows.push({
        message_id: messageId,
        channel_id: entry.channelId,
        type: 'cancelled_delete',
        data: JSON.stringify({ cancelledAt: entry.cancelledAt }),
      });
    }
  }
  if (client.pendingMessageDeletions) {
    for (const [messageId, entry] of client.pendingMessageDeletions) {
      rows.push({
        message_id: messageId,
        channel_id: entry.channelId,
        type: 'pending_msg_delete',
        data: JSON.stringify({ deleteAt: entry.deleteAt }),
      });
    }
  }
  // 30초마다 파일 전체를 덮어쓰기 때문에, 쓰는 도중에 죽으면 N-M.json이 잘린 채 남아
  // 다음 재시작 때 loadRows()가 파싱에 실패(→ [] 반환)하며 전체 데이터가 날아간다.
  // 임시 파일에 먼저 다 쓰고 rename으로 교체해, 실패해도 기존 파일이 그대로 남게 한다.
  fs.writeFileSync(TMP_PATH, JSON.stringify(rows), 'utf8');
  fs.renameSync(TMP_PATH, DB_PATH);
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

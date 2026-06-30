// db.js — 내전/모집 데이터를 SQLite에 영속화(저장)하는 모듈
// 봇이 재시작돼도 진행 중인 내전/모집이 사라지지 않게 해줍니다.

const Database = require('better-sqlite3');
const path = require('path');

// data.db 라는 파일을 봇 폴더에 만듭니다. (파일이 없으면 자동 생성)
// 이 파일 하나가 데이터베이스 전체입니다. 서버 같은 거 따로 안 띄워도 됩니다.
const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL'); // 안정성과 속도를 높여주는 설정 (그냥 켜두면 됨)

// 테이블(=엑셀 시트 같은 것) 생성.
// 한 줄(row) = 내전 하나 또는 모집 하나.
// 복잡하게 쪼개지 않고, match 객체 전체를 JSON 문자열로 'data' 칸에 통째로 넣습니다.
db.exec(`
  CREATE TABLE IF NOT EXISTS matches (
    message_id  TEXT PRIMARY KEY,   -- 디스코드 메시지 ID (메모리 Map의 key와 동일)
    channel_id  TEXT NOT NULL,      -- 그 메시지가 있는 채널 ID (재시작 시 메시지 다시 찾을 때 필요)
    type        TEXT NOT NULL,      -- 'naejeon'(내전) 또는 'mojip'(모집)
    data        TEXT NOT NULL,      -- match 객체를 JSON으로 변환한 것
    updated_at  INTEGER NOT NULL    -- 마지막 저장 시각
  )
`);

// match 객체 안에는 '살아있는 디스코드 객체'가 들어있는데, 이건 JSON으로 저장할 수 없습니다.
//  - match.message            → 디스코드 메시지 객체 (재시작 시 다시 불러올 거라 저장 X)
//  - match.data._previewInteraction → 살아있는 인터랙션 (저장하면 안 됨)
// 이 둘을 떼어내고 나머지만 JSON 문자열로 만듭니다.
function matchToJSON(match) {
  const { message, data, ...rest } = match;
  const { _previewInteraction, ...cleanData } = data || {};
  return JSON.stringify({ ...rest, data: cleanData });
}

// 미리 준비해두는 SQL 문장들 (prepare = 미리 컴파일해두면 빠르고 안전)
const _clear  = db.prepare('DELETE FROM matches');
const _insert = db.prepare(
  'INSERT INTO matches (message_id, channel_id, type, data, updated_at) VALUES (?, ?, ?, ?, ?)'
);

// 현재 메모리에 있는 모든 내전/모집을 통째로 DB에 다시 씁니다.
// transaction = 여러 작업을 '한 묶음'으로 처리 (중간에 멈춰도 데이터가 깨지지 않음)
const saveAll = db.transaction((client) => {
  _clear.run(); // 기존 내용을 다 지우고
  const now = Date.now();
  const dump = (map, type) => {
    if (!map) return;
    for (const [messageId, match] of map) {
      if (!match.message) continue; // 메시지가 없는 항목은 건너뜀
      _insert.run(messageId, match.message.channelId, type, matchToJSON(match), now);
    }
  };
  dump(client.naejeonMatches, 'naejeon'); // 내전 전부 저장
  dump(client.mojipMatches,   'mojip');   // 모집 전부 저장
});

// 저장된 모든 행을 읽어옵니다. (봇 시작 시 복원할 때 사용)
function loadRows() {
  return db.prepare('SELECT message_id, channel_id, type, data FROM matches').all();
}

module.exports = { saveAll, loadRows };
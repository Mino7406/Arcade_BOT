// 썸네일.js — 카드 오른쪽 위 게임 썸네일을 조금 작게 보이게 한다.
// 디스코드는 썸네일 칸 크기를 정해 두어 코드로 줄일 수 없으므로, 둘레에 투명 여백을 넣은 그림
// (assets/썸네일/*.png, 로고 65%)을 봇의 앱 이모지로 등록해 두고 그 주소를 썸네일로 쓴다.
// 봇이 켜질 때 한 번 ensureThumbEmojis 로 확인하고(없으면 그때 등록), 준비되기 전이나 실패하면 원래 이모지 그림을 쓴다.

const path = require('path');
const { emojiUrl } = require('./카드');
const { logSystem, logError } = require('./로그');

// 원래 게임 이모지 ID → 여백 넣은 그림 파일 이름. 그림 크기를 바꾸면 PREFIX 를 바꿔 새로 등록되게 한다.
const PREFIX = 't65c_'; // 시각 중심 보정판(이전 t65_ 앱 이모지와 구분)
const SOURCES = {
  '1510933684750913626': 'lol',
  '1510933698349109268': 'valorant',
  '1510933569554612324': 'overwatch',
  '1510933567646203964': 'pubg',
  '1562830370368528384': 'cobblemon',
};
const DIR = path.join(__dirname, '..', '..', 'assets', '썸네일');

const padded = new Map(); // 원래 이모지 ID → 여백 넣은 앱 이모지 ID
let lastError = null;      // 마지막 준비 실패 이유(/관리 새로고침 안내에 보여 줌)

// 앱 이모지 목록을 한 번 불러와 없는 것만 등록한다(이미 있으면 API 호출은 목록 조회 1번뿐).
async function ensureThumbEmojis(client) {
  const manager = client.application?.emojis;
  if (!manager) { lastError = '봇 앱 정보를 아직 못 불러옴'; return 0; }
  let list;
  try {
    list = await manager.fetch();
  } catch (err) {
    lastError = `앱 이모지 목록 조회 실패: ${err?.message ?? err}`;
    logError('처리 오류', '썸네일 앱 이모지 목록 조회 실패', err);
    return padded.size;
  }
  lastError = null;
  let created = 0;
  for (const [srcId, name] of Object.entries(SOURCES)) {
    const emojiName = `${PREFIX}${name}`;
    let emoji = list.find(e => e.name === emojiName);
    if (!emoji) {
      emoji = await manager.create({ attachment: path.join(DIR, `${name}.png`), name: emojiName }).catch(err => {
        lastError = `${emojiName} 등록 실패: ${err?.message ?? err}`;
        logError('처리 오류', `썸네일 이모지 등록 실패 (${emojiName})`, err);
        return null;
      });
      if (emoji) created++;
    }
    if (emoji) padded.set(srcId, emoji.id);
  }
  if (created) logSystem({ 유형: '봇 상태', 내용: `카드 썸네일용 앱 이모지 ${created}개 등록` });
  return padded.size;
}

// 준비 상태: 여백 그림 몇 개가 준비됐는지와 마지막 실패 이유.
function thumbStatus() {
  return { ready: padded.size, total: Object.keys(SOURCES).length, error: lastError };
}

// 게임 이모지 ID 로 썸네일 주소. 여백 넣은 그림이 준비됐으면 그 주소, 아니면 원래 이모지 그림.
function thumbUrlFor(emojiId) {
  if (!emojiId) return undefined;
  const id = padded.get(String(emojiId));
  return emojiUrl(id || emojiId);
}

// 이미 올라간 카드의 썸네일 주소를 새 그림 주소로 바꿀 때(/관리 새로고침). 바꿀 게 없으면 null.
function upgradeThumbUrl(url) {
  const m = /\/emojis\/(\d+)\./.exec(url || '');
  if (!m) return null;
  const id = padded.get(m[1]);
  return id ? emojiUrl(id) : null;
}

module.exports = { ensureThumbEmojis, thumbStatus, thumbUrlFor, upgradeThumbUrl, SOURCES, PREFIX };

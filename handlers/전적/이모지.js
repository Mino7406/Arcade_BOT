// 이모지.js — 전적 이미지 아래 탭 버튼에 붙는 앱 이모지(발로란트 모드 로고).
// 그림은 assets/이모지/rec_*.png (valorant-api.com 의 게임 모드·티어 아이콘을 128px 로 줄인 것).
// 봇이 켜질 때 ensureRecordEmojis 로 없는 것만 앱 이모지로 등록하고, 준비되기 전이나 실패하면 호출부가 기본 이모지를 쓴다.
const path = require('path');
const { logSystem, logError } = require('../공통/로그');

const DIR = path.join(__dirname, '..', '..', 'assets', '이모지');
// val_rank 경쟁전(불멸 티어 배지) · val_standard 일반전(기본 모드) · val_swift 신속 플레이 · val_spike 스파이크 돌격
// lol_rift 롤 일반(소환사의 협곡) · lol_aram 칼바람
// val_tdm 팀 데스매치 · val_dm 데스매치
const EMOJI_FILES = ['val_rank', 'val_standard', 'val_swift', 'val_spike', 'lol_rift', 'lol_aram', 'val_tdm', 'val_dm'];

const emojis = new Map(); // 'val_rank' → { id, name }

async function ensureRecordEmojis(client) {
  const manager = client.application?.emojis;
  if (!manager) return 0;
  let list;
  try {
    list = await manager.fetch();
  } catch (err) {
    logError('처리 오류', '전적 앱 이모지 목록 조회 실패', err);
    return emojis.size;
  }
  let created = 0;
  for (const key of EMOJI_FILES) {
    const name = `rec_${key}`;
    let emoji = list.find(e => e.name === name);
    if (!emoji) {
      emoji = await manager.create({ attachment: path.join(DIR, `${name}.png`), name }).catch(err => {
        logError('처리 오류', `전적 이모지 등록 실패 (${name})`, err);
        return null;
      });
      if (emoji) created++;
    }
    if (emoji) emojis.set(key, { id: emoji.id, name });
  }
  if (created) logSystem({ 유형: '봇 상태', 내용: `전적 탭용 앱 이모지 ${created}개 등록` });
  return emojis.size;
}

// 준비된 앱 이모지({ id, name }) 또는 null.
const recordEmoji = key => emojis.get(key) ?? null;

module.exports = { ensureRecordEmojis, recordEmoji, EMOJI_FILES };

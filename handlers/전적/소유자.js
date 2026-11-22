// 소유자.js — 채널에 공개된 전적 이미지를 "누가 띄웠는지" 기억한다(그 사람만 이미지 아래 탭 버튼을 누를 수 있게).
// customId 는 100자 제한이고 롤은 puuid 만으로 96자라 사람 id 를 못 넣어서, 메시지 id → 사람 id 표를 따로 둔다.
// 봇을 재시작해도 유지되게 파일에 저장하고, 오래된 것부터 keep 개만 남긴다.
const fs = require('fs');
const { writeJsonIfChanged } = require('../공통/저장');

function createOwnerStore({ file, keep = 500 }) {
  let data = {}; // { [messageId]: userId }
  let dirty = false;

  function load() {
    try {
      if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.error('전적 메시지 주인 기록 읽기 실패(옛 메시지는 누구나 누를 수 있게 됨):', err);
      data = {};
    }
  }

  function save() {
    if (!dirty) return;
    writeJsonIfChanged(file, data);
    dirty = false;
  }

  const get = messageId => data[messageId];

  function set(messageId, userId) {
    delete data[messageId]; // 다시 넣으면 가장 최근으로
    data[messageId] = userId;
    const ids = Object.keys(data);
    if (ids.length > keep) ids.slice(0, ids.length - keep).forEach(id => delete data[id]); // 객체 키는 넣은 순서대로 돈다(숫자꼴 키는 예외라 id 앞에 접두사를 붙이지 않고 문자열로 다룬다)
    dirty = true;
  }

  return { load, save, get, set };
}

module.exports = { createOwnerStore };

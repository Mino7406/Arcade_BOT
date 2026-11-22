// 경기저장.js — 추린 경기(집계.js의 compactMatch)를 사람별로 디스크에 쌓아 두는 저장소.
// 끝난 경기는 바뀌지 않으므로 한 번 받은 경기는 다시 받지 않는다. 사람당 keep 판을 넘으면 오래된 것부터 지운다.
const fs = require('fs');
const { writeJsonIfChanged } = require('../공통/저장');

function createMatchStore({ file, keep = 100 }) {
  let data = {}; // { [puuid]: { [matchId]: compact } }

  function load() {
    try {
      if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.error('전적 경기 저장소 읽기 실패(처음부터 다시 받음):', err);
      data = {};
    }
  }

  function save() {
    writeJsonIfChanged(file, data);
  }

  function has(puuid, id) {
    return !!data[puuid]?.[id];
  }

  function add(puuid, compact) {
    const mine = (data[puuid] ??= {});
    mine[compact.id] = compact;
    const ids = Object.keys(mine);
    if (ids.length > keep) {
      ids.sort((x, y) => mine[y].ts - mine[x].ts).slice(keep).forEach(id => delete mine[id]);
    }
  }

  // 최근 경기부터. queue 를 주면 그 큐만.
  function list(puuid, queue) {
    const all = Object.values(data[puuid] ?? {}).filter(m => !m.skip).sort((x, y) => y.ts - x.ts); // skip: 기록하지 않는 경기(다시하기)의 표시
    return queue ? all.filter(m => m.queue === queue) : all;
  }

  return { load, save, has, add, list };
}

module.exports = { createMatchStore };

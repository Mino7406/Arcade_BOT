// 경기저장.js — 추린 경기(집계.js의 compactMatch)를 사람별로 디스크에 쌓아 두는 저장소.
// 끝난 경기는 바뀌지 않으므로 한 번 받은 경기는 다시 받지 않는다. 사람당 keep 판을 넘으면 오래된 것부터 지운다.
const fs = require('fs');
const { writeJsonIfChanged } = require('../공통/저장');

function createMatchStore({ file, keep = 100, maxPlayers = 60 }) {
  let data = {}; // { [puuid]: { [matchId]: compact } }
  let dirty = false; // 마지막 저장 뒤 바뀌었나(자동 저장이 큰 JSON 을 매번 직렬화하지 않게)

  function load() {
    try {
      if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.error('전적 경기 저장소 읽기 실패(처음부터 다시 받음):', err);
      data = {};
    }
  }

  function save() {
    if (!dirty) return;
    writeJsonIfChanged(file, data);
    dirty = false;
  }

  function has(puuid, id) {
    return !!data[puuid]?.[id];
  }

  function add(puuid, compact) {
    const mine = (data[puuid] ??= {});
    mine[compact.id] = compact;
    dirty = true;
    const ids = Object.keys(mine);
    if (ids.length > keep) {
      ids.sort((x, y) => mine[y].ts - mine[x].ts).slice(keep).forEach(id => delete mine[id]);
    }
    // 사람 수에도 상한을 둔다(닉네임 조회가 쌓여 서버 메모리를 먹지 않게): 가장 오래 안 쓴 사람(가장 최근 경기가 제일 오래된 사람)부터 지운다
    const players = Object.keys(data);
    if (players.length > maxPlayers) {
      const newest = id => Math.max(0, ...Object.values(data[id]).map(m => m.ts));
      players.filter(id => id !== puuid).sort((x, y) => newest(x) - newest(y)).slice(0, players.length - maxPlayers).forEach(id => delete data[id]);
    }
  }

  // 최근 경기부터. queue(번호 또는 번호 배열)를 주면 그 큐만.
  function list(puuid, queue) {
    const all = Object.values(data[puuid] ?? {}).filter(m => !m.skip).sort((x, y) => y.ts - x.ts); // skip: 기록하지 않는 경기(다시하기)의 표시
    const queues = queue === undefined || queue === null ? null : [].concat(queue);
    return queues ? all.filter(m => queues.includes(m.queue)) : all;
  }

  return { load, save, has, add, list };
}

module.exports = { createMatchStore };

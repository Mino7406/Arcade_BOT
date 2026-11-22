// 실제 Riot API·HenrikDev 로 한 번 조회해 보는 수동 스크립트(기본 테스트에 포함 안 됨).
//   node tests/전적/실계정.js lol Mino#KR1       → tests/전적/out/real-lol.png
//   node tests/전적/실계정.js val Mino#KR1       → tests/전적/out/real-val.png
// env 파일의 RIOT_API_KEY / HENRIK_API_KEY 를 쓴다. 키 값은 출력하지 않는다.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
require('dotenv').config({ path: path.join(root, 'env') });
const { createLimiter } = require(path.join(root, 'handlers', '전적', '요청대기열.js'));
const { createRiotClient } = require(path.join(root, 'handlers', '전적', '리오트.js'));
const { createMatchStore } = require(path.join(root, 'handlers', '전적', '경기저장.js'));
const { createStatic } = require(path.join(root, 'handlers', '전적', '정적데이터.js'));
const { createLolService } = require(path.join(root, 'handlers', '전적', '롤.js'));
const { createValorantService } = require(path.join(root, 'handlers', '전적', '발로.js'));
const { parseRiotId } = require(path.join(root, 'handlers', '전적', '계정.js'));

(async () => {
  const [game, riotId] = process.argv.slice(2);
  const id = parseRiotId(riotId ?? '');
  if (!['lol', 'val'].includes(game) || !id) return console.log('사용법: node tests/전적/실계정.js <lol|val> <이름#태그>');
  const key = game === 'lol' ? process.env.RIOT_API_KEY : process.env.HENRIK_API_KEY;
  if (!key) return console.log(`env 파일에 ${game === 'lol' ? 'RIOT_API_KEY' : 'HENRIK_API_KEY'} 가 없어서 건너뜁니다.`);
  const statics = createStatic({
    fetchJson: async u => (await fetch(u)).json(),
    fetchBuffer: async u => { const r = await fetch(u); if (!r.ok) throw new Error(u + ' ' + r.status); return Buffer.from(await r.arrayBuffer()); },
    dir: path.join(root, 'assets', '전적'),
  });
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  const t0 = Date.now();
  let res, calls = 0;
  if (game === 'lol') {
    const limiter = createLimiter();
    const counting = { schedule: f => limiter.schedule(() => { calls++; return f(); }), penalize: ms => limiter.penalize(ms) };
    const riot = createRiotClient({ key, limiter: counting });
    const store = createMatchStore({ file: path.join(__dirname, 'out', 'real-matches.json') });
    store.load();
    const svc = createLolService({ riot, store, statics });
    for (let round = 1; round <= 2; round++) { // 두 번째 조회는 경기 호출이 없어야 한다
      calls = 0;
      res = await svc.lookup(id, 'all');
      console.log(`${round}번째 조회: ${res.ok ? '성공' : '실패 — ' + res.message} · Riot 호출 ${calls}번 · ${Date.now() - t0}ms · RSS ${Math.round(process.memoryUsage().rss / 1048576)}MB`);
      if (!res.ok) break;
    }
  } else {
    res = await createValorantService({ key, statics }).lookup(id);
    console.log(res.ok ? `성공 · ${Date.now() - t0}ms` : '실패 — ' + res.message);
  }
  if (res.ok && res.png) {
    const out = path.join(__dirname, 'out', `real-${game}.png`);
    fs.writeFileSync(out, res.png);
    console.log('저장:', out);
  } else if (res.ok) console.log(res.text);
})();

// 맵 뽑기 모듈 테스트: node tests/맵테스트.js (실패하면 오류로 끝난다)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const maps = require(path.join(__dirname, '..', 'handlers', '매치', '맵.js'));
const { MAP_POOLS, hasMapPool, pickMap, mapName, mapImageFile, mapResultFile, SPIN_DELAYS_MS, spinFrames } = maps;

// 풀 크기·이름·이미지 파일
assert.strictEqual(MAP_POOLS.valorant.length, 13, '발로란트는 13개');
assert.strictEqual(MAP_POOLS.overwatch.length, 31, '오버워치는 31개');
for (const game of ['valorant', 'overwatch']) {
  const keys = MAP_POOLS[game].map(m => m.key);
  assert.strictEqual(new Set(keys).size, keys.length, `${game} key 중복`);
  for (const m of MAP_POOLS[game]) {
    assert.ok(m.key && m.name, `${game} 항목에 key·name 이 있어야 함`);
    assert.ok(fs.existsSync(mapImageFile(game, m.key)), `${game}/${m.key} 이미지 파일이 없음`);
  }
}
for (const bad of ['place-lacroix', 'arena-victoriae', 'gogadoro', 'wuxing-university', 'redwood-dam']) {
  assert.ok(!MAP_POOLS.overwatch.some(m => m.key === bad), `스타디움 맵 ${bad} 는 풀에 없어야 함`);
}

// 추첨
assert.strictEqual(hasMapPool('valorant'), true);
assert.strictEqual(hasMapPool('overwatch'), true);
assert.strictEqual(hasMapPool('lol'), false);
assert.strictEqual(pickMap('valorant', () => 0).key, MAP_POOLS.valorant[0].key);
assert.strictEqual(pickMap('valorant', () => 0.999999).key, MAP_POOLS.valorant.at(-1).key);
assert.strictEqual(pickMap('lol'), null);
for (const game of ['valorant', 'overwatch']) { // 균등: 난수를 구간 가운데로 주면 모든 맵이 정확히 한 번씩
  const n = MAP_POOLS[game].length;
  const got = Array.from({ length: n }, (_, i) => pickMap(game, () => (i + 0.5) / n).key);
  assert.deepStrictEqual(got, MAP_POOLS[game].map(m => m.key), `${game} 균등 추첨`);
}

// 이름
assert.strictEqual(mapName('overwatch', 'grimsvotn'), '감시 기지: 그림스뵈튼');
assert.strictEqual(mapName('overwatch', 'esperanca'), '이스페란사');
assert.strictEqual(mapName('overwatch', 'neon-junction'), '네온 교차로');
assert.strictEqual(mapName('overwatch', 'nope'), '');

// 연출 프레임
assert.deepStrictEqual(SPIN_DELAYS_MS, [600, 700, 900, 1200, 1600]);
assert.strictEqual(SPIN_DELAYS_MS.reduce((a, b) => a + b, 0), 5000);
for (let t = 0; t < 20; t++) {
  let s = t + 1;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (const game of ['valorant', 'overwatch']) {
    const final = MAP_POOLS[game][t % MAP_POOLS[game].length].key;
    const frames = spinFrames(game, final, rnd);
    assert.strictEqual(frames.length, SPIN_DELAYS_MS.length, '프레임 수');
    assert.ok(frames.every(k => MAP_POOLS[game].some(m => m.key === k)), '프레임 key 가 풀 안에 있어야 함');
    for (let i = 1; i < frames.length; i++) assert.notStrictEqual(frames[i], frames[i - 1], '이웃 프레임은 달라야 함');
    assert.notStrictEqual(frames.at(-1), final, '마지막 돌아가는 프레임은 당첨 맵이 아니어야 함');
  }
}
// 이름이 박힌 결과 이미지(scripts/맵결과이미지.py 로 만든다): 모든 맵에 있고 400KB 이하
for (const game of ['valorant', 'overwatch']) {
  for (const x of MAP_POOLS[game]) {
    const f = mapResultFile(game, x.key);
    assert.ok(fs.existsSync(f), `${game}/${x.key} 결과 이미지가 없음`);
    assert.ok(fs.statSync(f).size < 400 * 1024, `${game}/${x.key} 결과 이미지가 400KB 를 넘음`);
  }
}
console.log('맵 테스트 통과');

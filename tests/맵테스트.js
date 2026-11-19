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
assert.deepStrictEqual(SPIN_DELAYS_MS, [450, 500, 550, 650, 800, 1000, 1300, 1750]);
assert.strictEqual(SPIN_DELAYS_MS.reduce((a, b) => a + b, 0), 7000);
for (const game of ['valorant', 'overwatch']) {
  MAP_POOLS[game].forEach((x, idx) => {
    for (let t = 0; t < 3; t++) {
      let sd = idx * 7 + t + 1;
      const rnd = () => ((sd = (sd * 1103515245 + 12345) % 2147483648) / 2147483648);
      const { strip, offsets } = maps.reelPlan(game, x.key, rnd);
      assert.strictEqual(offsets.length, SPIN_DELAYS_MS.length, '프레임 수');
      assert.strictEqual(strip[maps.REEL_STOP], x.key, '당첨 맵이 멈추는 자리에 있어야 함');
      assert.strictEqual(offsets.at(-1), maps.REEL_STOP, '마지막 프레임은 당첨 맵이 가운데');
      for (let i = 1; i < offsets.length; i++) assert.ok(offsets[i] > offsets[i - 1], '위치는 계속 앞으로');
      const steps = offsets.map((o, i) => o - (offsets[i - 1] ?? 0));
      for (let i = 1; i < steps.length; i++) assert.ok(steps[i] <= steps[i - 1] + 1e-9, '점점 느려져야 함');
      for (let k = 1; k < strip.length; k++) assert.notStrictEqual(strip[k], strip[k - 1], '이웃 카드는 달라야 함');
      assert.ok(strip.every(k => MAP_POOLS[game].some(m => m.key === k)), '카드 key 가 풀 안에 있어야 함');
      assert.ok(strip.filter(k => k === x.key).length === 1, '당첨 맵은 줄에 한 번만');
    }
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'assets', '맵', '카드', game, `${x.key}.png`)), `${game}/${x.key} 맵 카드 이미지가 없음`);
  });
}
// 프레임 그리기: 유효한 PNG(960x540)이고 위치마다 그림이 다르며 카드는 매번 다르게 섞인다
{
  const reel = require('../handlers/매치/맵연출');
  const a = maps.reelPlan('overwatch', 'busan'), b = maps.reelPlan('overwatch', 'busan');
  const png = reel.frame('overwatch', a.strip, a.offsets[0]);
  assert.deepStrictEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [960, 540], '프레임 크기');
  assert.ok(!png.equals(reel.frame('overwatch', a.strip, a.offsets[3])), '위치가 다르면 그림도 달라야 함');
  assert.ok(png.length < 2 * 1024 * 1024, '프레임이 2MB 를 넘음');
  reel.clearReelCache();
  assert.ok(a.strip.join() !== b.strip.join(), '뽑을 때마다 카드 순서가 달라야 함(랜덤)');
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

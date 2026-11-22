// 요청 대기열 테스트: node tests/전적/대기열테스트.js
const assert = require('assert');
const path = require('path');
const { createLimiter } = require(path.join(__dirname, '..', '..', 'handlers', '전적', '요청대기열.js'));

(async () => {
  let t = 1_000_000;
  const now = () => t;
  const sleep = ms => { t += ms; return Promise.resolve(); };

  // 200번을 한꺼번에 걸어도 어느 1초 구간에 18회, 어느 120초 구간에 90회를 넘지 않고 순서가 유지된다
  const limiter = createLimiter({ now, sleep });
  const started = [];
  const results = await Promise.all(Array.from({ length: 200 }, (_, i) => limiter.schedule(async () => { started.push(t); return i; })));
  assert.deepStrictEqual(results, Array.from({ length: 200 }, (_, i) => i), '호출 순서대로 끝나야 함');
  for (let i = 0; i < started.length; i++) {
    assert.ok(started.filter(x => x > started[i] - 1000 && x <= started[i]).length <= 18, '1초 18회 초과');
    assert.ok(started.filter(x => x > started[i] - 120000 && x <= started[i]).length <= 90, '2분 90회 초과');
  }

  // penalize: 그 시간 동안 새 호출이 멈춘다(429 대응)
  t = 5_000_000;
  const l2 = createLimiter({ now, sleep });
  l2.penalize(5000);
  const before = t;
  await l2.schedule(async () => {});
  assert.ok(t - before >= 5000, `5000ms 뒤에 실행돼야 함(실제 ${t - before}ms)`);

  // 실패한 호출이 뒤 호출을 막지 않는다
  const l3 = createLimiter({ now, sleep });
  await assert.rejects(l3.schedule(async () => { throw new Error('boom'); }), /boom/);
  assert.strictEqual(await l3.schedule(async () => 'ok'), 'ok');
  console.log('대기열 테스트 통과');
})();

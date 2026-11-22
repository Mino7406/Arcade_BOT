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
  // 줄이 너무 길어지면(maxQueue) 더 받지 않고 바로 거절한다 — 몰렸을 때 마지막 사람이 몇 분씩 기다리지 않게
  const l4 = createLimiter({ perSecond: 1, perWindow: 1, windowMs: 1e9, maxQueue: 3, now: () => 0, sleep: () => new Promise(() => {}) });
  const first4 = [1, 2, 3].map(() => { const p = l4.schedule(async () => 'x'); p.catch(() => {}); return p; });
  await assert.rejects(l4.schedule(async () => 'late'), e => e.queueFull === true, '줄이 가득 차면 거절');
  assert.strictEqual(first4.length, 3);
  console.log('대기열 테스트 통과');
})();

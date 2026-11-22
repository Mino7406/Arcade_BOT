// 랭킹 이름 조회 동시성 테스트: node tests/랭킹동시테스트.js
// 캐시가 비었을 때 여러 명이 동시에 /랭킹을 열어도 멤버 조회(게이트웨이 요청)가 사람 수만큼 늘지 않아야 한다.
const assert = require('assert');
const path = require('path');
const ranking = require(path.join(__dirname, '..', 'handlers', '레벨', '랭킹.js'));
const { getMemberNames } = ranking;

(async () => {
  assert.strictEqual(typeof getMemberNames, 'function', 'getMemberNames 가 테스트용으로 내보내져야 함');
  let fetches = 0;
  const guild = {
    id: 'G1',
    members: { fetch: async ({ user }) => { fetches++; await new Promise(r => setTimeout(r, 20)); return new Map(user.map(id => [id, { displayName: 'n' + id }])); } },
  };
  const ids = Array.from({ length: 250 }, (_, i) => String(i));
  const results = await Promise.all(Array.from({ length: 10 }, () => getMemberNames(guild, ids)));
  assert.strictEqual(fetches, 3, `250명을 100명씩 3번만 조회해야 함(실제 ${fetches}번)`);
  for (const names of results) assert.strictEqual(names.get('249'), 'n249', '모두 이름을 받는다');

  // 이미 조회한 사람은 다시 조회하지 않고, 새로 들어온 사람만 추가로 조회한다
  fetches = 0;
  await getMemberNames(guild, ids);
  assert.strictEqual(fetches, 0, '캐시 적중');
  await getMemberNames(guild, [...ids.slice(0, 5), '999']);
  assert.strictEqual(fetches, 1, '새 사람 1명만 추가 조회');

  // 조회에 실패한 묶음은 기억하지 않아 다음에 다시 조회한다(기존 동작 유지)
  let fail = true; let calls = 0;
  const flaky = { id: 'G2', members: { fetch: async ({ user }) => { calls++; if (fail) throw new Error('gateway'); return new Map(user.map(id => [id, { displayName: 'x' + id }])); } } };
  await getMemberNames(flaky, ['1', '2']);
  fail = false;
  const names = await getMemberNames(flaky, ['1', '2']);
  assert.strictEqual(names.get('1'), 'x1', '실패 뒤 다시 조회해 이름을 받는다');
  assert.strictEqual(calls, 2);
  console.log('랭킹 동시성 테스트 통과');
})();

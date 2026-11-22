// 전적 계정 저장소 테스트: node tests/전적/계정테스트.js (실패하면 오류로 끝난다)
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const { parseRiotId, getLinked, setLinked, canUseRecordSearch } = require(path.join(root, 'handlers', '전적', '계정.js'));
const { TEST_GUILD_IDS } = require(path.join(root, 'config.js'));

assert.deepStrictEqual(parseRiotId('Hide on bush#KR1'), { name: 'Hide on bush', tag: 'KR1' });
assert.deepStrictEqual(parseRiotId('  불꽃이#1234 '), { name: '불꽃이', tag: '1234' });
for (const bad of ['abc', 'a#b', '', '이름#', '#KR1', 'ab#KR1', 'name#TOOLONG', null, undefined]) {
  assert.strictEqual(parseRiotId(bad), null, `잘못된 Riot ID: ${bad}`);
}

assert.strictEqual(getLinked('nobody'), null);
setLinked('u1', { lol: { puuid: 'p', name: 'A bc', tag: 'B1X' } });
assert.strictEqual(getLinked('u1').lol.puuid, 'p');
assert.strictEqual(getLinked('u1').valorant, undefined);

assert.strictEqual(canUseRecordSearch(TEST_GUILD_IDS[0]), true, '테스트 길드는 허용');
assert.strictEqual(canUseRecordSearch('999'), false, '다른 길드는 막힘');
assert.strictEqual(canUseRecordSearch(null), false, 'DM은 막힘');
console.log('계정 테스트 통과');

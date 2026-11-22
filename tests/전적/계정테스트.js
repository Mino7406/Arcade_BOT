// 전적 계정 저장소 테스트: node tests/전적/계정테스트.js (실패하면 오류로 끝난다)
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const { parseRiotId, getLinked, setLinked, canUseRecordSearch, canUseRecordChannel } = require(path.join(root, 'handlers', '전적', '계정.js'));
const { TEST_GUILD_IDS } = require(path.join(root, 'config.js'));

assert.deepStrictEqual(parseRiotId('Mino#KR1'), { name: 'Mino', tag: 'KR1' });
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
// 채널 규칙: 테스트 서버는 어디서나, 그 밖에는 메인·TTS 채팅(임시 음성채널 채팅은 별도 확인)에서만
for (const ch of ['1340523443413844048', '1374679502394884178', '1522575222589620254']) assert.strictEqual(canUseRecordChannel('999', ch), true, `${ch} 는 허용`);
assert.strictEqual(canUseRecordChannel('999', '1'), false, '다른 채널은 막힘');
assert.strictEqual(canUseRecordChannel('999', undefined), false);
assert.strictEqual(canUseRecordChannel(TEST_GUILD_IDS[0], '1'), true, '테스트 서버는 어느 채널에서나');
console.log('계정 테스트 통과');

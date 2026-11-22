// 전적 결과 메시지의 주인(요청한 사람) 기록 테스트: node tests/전적/소유자테스트.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOwnerStore } = require(path.join(__dirname, '..', '..', 'handlers', '전적', '소유자.js'));

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'own-')), 'owners.json');
const store = createOwnerStore({ file, keep: 3 });
assert.strictEqual(store.get('M1'), undefined, '모르는 메시지는 주인 없음');
store.save();
assert.ok(!fs.existsSync(file), '바뀐 게 없으면 파일을 만들지 않음');

store.set('M1', 'U1'); store.set('M2', 'U2'); store.set('M3', 'U3');
assert.strictEqual(store.get('M2'), 'U2');
store.set('M4', 'U4'); // keep=3 이라 가장 오래된 M1 이 밀려난다
assert.strictEqual(store.get('M1'), undefined, '오래된 것부터 지운다');
assert.strictEqual(store.get('M4'), 'U4');

store.save();
assert.ok(fs.existsSync(file), '바뀌었으면 저장');
const again = createOwnerStore({ file, keep: 3 }); again.load();
assert.strictEqual(again.get('M3'), 'U3', '다시 읽어도 그대로(봇을 재시작해도 유지)');
assert.strictEqual(again.get('M1'), undefined);
fs.unlinkSync(file);
again.save();
assert.ok(!fs.existsSync(file), '바뀐 게 없으면 다시 쓰지 않음');
console.log('소유자 기록 테스트 통과');

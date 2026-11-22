// 전적 탭 버튼용 앱 이모지 테스트: node tests/전적/이모지테스트.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const { ensureRecordEmojis, recordEmoji, EMOJI_FILES } = require(path.join(root, 'handlers', '전적', '이모지.js'));
const { decodePng } = require(path.join(root, 'handlers', '공통', '이모지그림.js'));

assert.ok(EMOJI_FILES.includes('lol_rift') && EMOJI_FILES.includes('lol_aram'), '롤 일반(협곡)·칼바람 이모지');
// 그림 파일: 앱 이모지는 PNG, 128px 이하
for (const key of EMOJI_FILES) {
  const file = path.join(root, 'assets', '이모지', `rec_${key}.png`);
  assert.ok(fs.existsSync(file), `${key} 그림 파일`);
  const img = decodePng(fs.readFileSync(file));
  assert.ok(img.w <= 128 && img.h <= 128, `${key} 크기 ${img.w}x${img.h}`);
}

(async () => {
  assert.strictEqual(recordEmoji('val_rank'), null, '준비 전에는 null(호출부가 기본 이모지를 쓴다)');

  // 이미 있는 건 다시 만들지 않고, 없는 것만 등록한다
  const created = [];
  const client = { application: { emojis: {
    fetch: async () => [{ name: 'rec_val_rank', id: 'EXIST' }],
    create: async ({ attachment, name }) => { assert.ok(fs.existsSync(attachment), '등록할 그림 파일이 있어야 함'); created.push(name); return { id: `ID_${name}`, name }; },
  } } };
  const ready = await ensureRecordEmojis(client);
  assert.strictEqual(ready, EMOJI_FILES.length);
  assert.deepStrictEqual(created.sort(), EMOJI_FILES.filter(k => k !== 'val_rank').map(k => `rec_${k}`).sort());
  assert.deepStrictEqual(recordEmoji('val_rank'), { id: 'EXIST', name: 'rec_val_rank' });
  assert.deepStrictEqual(recordEmoji('val_swift'), { id: 'ID_rec_val_swift', name: 'rec_val_swift' });
  assert.strictEqual(recordEmoji('nope'), null);

  // 등록이 실패해도 예외 없이 넘어간다(그 이모지만 기본 이모지로 표시)
  const failing = { application: { emojis: { fetch: async () => [], create: async () => { throw new Error('Maximum number of emojis reached'); } } } };
  assert.strictEqual(typeof await ensureRecordEmojis(failing), 'number');
  assert.strictEqual(await ensureRecordEmojis({}), 0, '봇 앱 정보가 없으면 0');
  console.log('전적 이모지 테스트 통과');
})();

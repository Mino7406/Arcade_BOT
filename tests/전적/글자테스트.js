// 그림판 글자 대체 폰트 테스트: node tests/전적/글자테스트.js
// 나눔고딕에 없는 글자(예: 그리스 문자 ω)가 물음표 대신 대체 폰트(DejaVu Sans)로 그려지는지 확인한다.
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const { Painter, loadFont } = require(path.join(root, 'handlers', '레이드', '그림판.js'));

const FONTS = path.join(root, 'assets', 'fonts');
const draw = (font, text) => {
  const p = new Painter(120, 40, 1);
  p.clear('#000000');
  p.text(font, text, 8, 20, { size: 28, color: '#ffffff', align: 'left' });
  return Buffer.from(p.buf);
};

// 대체 폰트가 없으면 ω 는 ? 로 바뀐다(예전 동작)
const plain = loadFont(path.join(FONTS, 'NanumGothic-Regular.ttf'));
assert.ok(draw(plain, 'ω').equals(draw(plain, '?')), '대체 폰트 없이는 ω 가 ? 와 같게 그려짐');

// 대체 폰트를 달면 ω 가 자기 모양으로 그려진다
const withFallback = loadFont(path.join(FONTS, 'NanumGothic-Bold.ttf'));
withFallback.fallback = loadFont(path.join(FONTS, 'DejaVuSans.ttf'));
assert.ok(!draw(withFallback, 'ω').equals(draw(withFallback, '?')), '대체 폰트가 있으면 ω 는 ? 가 아님');
assert.ok(!draw(withFallback, 'OωO').equals(draw(withFallback, 'O?O')), '섞인 글자도 ω 만 대체 폰트로');
assert.ok(draw(withFallback, 'OωO').some(v => v > 0), '비어 있지 않음');

// 한글·영문은 원래 폰트 그대로(대체 폰트를 달아도 모양이 바뀌지 않는다)
const same = loadFont(path.join(FONTS, 'NanumGothic-Regular.ttf'));
const before = draw(same, '전적 Mino 123');
same.fallback = loadFont(path.join(FONTS, 'DejaVuSans.ttf'));
assert.ok(draw(same, '전적 Mino 123').equals(before), '원래 폰트에 있는 글자는 그대로');
// 어느 폰트에도 없는 글자는 여전히 ?
assert.ok(draw(same, '\u{1F600}').equals(draw(same, '?')) || draw(same, '\u{1F600}').every(v => v === 0), '이모지는 그리지 않거나 ?');
console.log('글자 대체 폰트 테스트 통과');

// 알바트리온 직업 아이콘 변환: 확정된 그림(JSON 격자)을 레이드 그림이 읽는 { rows, palette } 로 바꿔 파일로 쓴다.
// 입력:  docs/superpowers/specs/assets/알바트리온-아이콘-확정.json  ([화, 수, 번개, 얼음] 순서, 32×32, 칸은 '.' 또는 '#rrggbb')
// 출력:  handlers/레이드/알바트리온아이콘.js  (이 스크립트가 만든 파일 — 직접 고치지 말고 입력을 고친 뒤 다시 실행)
// 실행:  node scripts/아이콘변환.js
// 오라 칸은 확정 그림에서 미리보기 배경 (43,45,49)과 50% 섞인 값으로 들어 있다. 그 칸을 속성 오라색 + 알파 0x80(#rrggbb80)으로 되돌려
// 실제 카드 위에서도 배경이 비쳐 보이게 한다.
const fs = require('fs');
const path = require('path');

const INPUT = path.join(__dirname, '..', 'docs', 'superpowers', 'specs', 'assets', '알바트리온-아이콘-확정.json');
const OUTPUT = path.join(__dirname, '..', 'handlers', '레이드', '알바트리온아이콘.js');
const ORDER = ['fire', 'water', 'thunder', 'ice'];
const AURA = { fire: [255, 140, 35], water: [70, 205, 255], thunder: [240, 245, 70], ice: [130, 215, 255] };
const BG = [43, 45, 49];
const CODES = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', ...Array.from({ length: 400 }, (_, i) => String.fromCharCode(0x100 + i))]; // 색이 많아 ASCII 밖 글자도 쓴다
const hex2 = (n) => n.toString(16).padStart(2, '0');
const toHex = (rgb) => '#' + rgb.map(hex2).join('');
const mixed = (aura) => aura.map((v, i) => Math.floor(BG[i] + (v - BG[i]) * 0.5 + 0.5)); // 반올림(0.5는 올림)

const grids = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
if (grids.length !== ORDER.length) throw new Error(`아이콘이 ${ORDER.length}개여야 하는데 ${grids.length}개`);

const result = {};
grids.forEach((grid, gi) => {
  const el = ORDER[gi];
  const auraMixed = toHex(mixed(AURA[el]));
  const auraAlpha = toHex(AURA[el]) + '80';
  const palette = {};
  const codeOf = new Map();
  const rows = grid.map(line => line.map(cell => {
    if (cell === '.') return '.';
    const color = cell === auraMixed ? auraAlpha : cell;
    if (!codeOf.has(color)) {
      if (codeOf.size >= CODES.length) throw new Error(`${el}: 색이 ${CODES.length}개를 넘음`);
      codeOf.set(color, CODES[codeOf.size]);
      palette[CODES[codeOf.size - 1]] = color;
    }
    return codeOf.get(color);
  }).join(''));
  result[el] = { rows, palette };
});

const body = Object.entries(result).map(([el, sp]) =>
  `  ${el}: {\n    rows: [\n${sp.rows.map(r => `      '${r}',`).join('\n')}\n    ],\n    palette: ${JSON.stringify(sp.palette)},\n  },`).join('\n');
const header = `// 자동 생성 파일 — scripts/아이콘변환.js 가 docs/superpowers/specs/assets/알바트리온-아이콘-확정.json 에서 만든다. 직접 고치지 마세요.\n// 각 아이콘은 32×32 { rows, palette }('.'는 투명, #rrggbb80 은 반투명 오라).\n`;
fs.writeFileSync(OUTPUT, `${header}module.exports = {\n${body}\n};\n`);
console.log('알바트리온 아이콘 생성:', path.relative(process.cwd(), OUTPUT));

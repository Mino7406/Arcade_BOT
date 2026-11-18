"""맵 뽑기 결과 이미지 만들기 (개발용 일회성): python -I scripts/맵결과이미지.py

assets/맵/<게임>/<키>.jpg 원본 위에 한국어 맵 이름을 중앙 하단에 박아
assets/맵/결과/<게임>/<키>.jpg (1200x675) 로 저장한다. 봇은 이 파일을 그대로 첨부만 한다.
맵 이름은 handlers/매치/맵.js 의 MAP_POOLS 에서 노드로 읽어 온다(한 곳에서만 관리).
필요: Python + Pillow, Node.
"""
import json
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
W, H = 1200, 675
FONT = os.path.join(ROOT, 'assets', 'fonts', 'NanumGothic-Bold.ttf')


def load_pools():
    out = subprocess.run(
        ['node', '-e', "console.log(JSON.stringify(require('./handlers/매치/맵.js').MAP_POOLS))"],
        cwd=ROOT, capture_output=True, check=True, encoding='utf-8',
    ).stdout
    return json.loads(out)


def render(src, dst, name):
    im = Image.open(src).convert('RGB').resize((W, H), Image.LANCZOS).convert('RGBA')

    # 아래쪽 40% 에 투명 → 어두운(알파 약 0.75) 세로 그라데이션
    grad = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    top = int(H * 0.6)
    gd = ImageDraw.Draw(grad)
    for y in range(top, H):
        a = int(190 * (y - top) / (H - top))
        gd.line([(0, y), (W, y)], fill=(0, 0, 0, a))
    im = Image.alpha_composite(im, grad)

    # 이름: 흰 글씨 + 어두운 외곽선 2px, 폭이 이미지의 85% 를 넘으면 글자 크기를 줄인다
    size = 56
    draw = ImageDraw.Draw(im)
    while size > 24:
        font = ImageFont.truetype(FONT, size)
        box = draw.textbbox((0, 0), name, font=font, stroke_width=2)
        if box[2] - box[0] <= W * 0.85:
            break
        size -= 2
    x = (W - (box[2] - box[0])) / 2 - box[0]
    y = H - 70 - (box[3] - box[1]) - box[1]
    draw.text((x, y), name, font=font, fill=(255, 255, 255, 255), stroke_width=2, stroke_fill=(10, 10, 14, 255))

    os.makedirs(os.path.dirname(dst), exist_ok=True)
    im.convert('RGB').save(dst, 'JPEG', quality=85, optimize=True, progressive=True)


def main():
    count = 0
    for game, maps in load_pools().items():
        for m in maps:
            src = os.path.join(ROOT, 'assets', '맵', game, m['key'] + '.jpg')
            dst = os.path.join(ROOT, 'assets', '맵', '결과', game, m['key'] + '.jpg')
            render(src, dst, m['name'])
            count += 1
    print(f'결과 이미지 {count}개 생성')


if __name__ == '__main__':
    sys.exit(main())

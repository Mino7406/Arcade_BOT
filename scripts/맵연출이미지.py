"""맵 뽑기 연출(슬롯처럼 흘러가는 맵 카드) 재료 이미지 만들기 (개발용 일회성): python -I scripts/맵연출이미지.py

봇이 뽑기마다 카드 여러 장을 옆으로 흘려 보내며 프레임을 직접 그린다(handlers/매치/맵연출.js). 그 재료를 만든다:
 - assets/맵/카드/<게임>/<키>.png : 맵 카드(225x279, 아래에 한국어 이름판이 박힘)
 - assets/맵/연출/배경_<게임>.png : 720x405 배경(제목 MAP DRAW · 맵 뽑기 · 추첨 중...)
필요: Python + Pillow, Node.  글꼴: assets/fonts/BlackHanSans-Regular.ttf(OFL), BebasNeue-Regular.ttf(OFL)
"""
import json
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
CW, CH = 225, 279
W, H = 720, 405
ACCENT = {'valorant': (253, 69, 86), 'overwatch': (250, 156, 30)}
FONT_KO = os.path.join(ROOT, 'assets', 'fonts', 'BlackHanSans-Regular.ttf')
FONT_EN = os.path.join(ROOT, 'assets', 'fonts', 'BebasNeue-Regular.ttf')


def load_pools():
    out = subprocess.run(
        ['node', '-e', "console.log(JSON.stringify(require('./handlers/매치/맵.js').MAP_POOLS))"],
        cwd=ROOT, capture_output=True, check=True, encoding='utf-8').stdout
    return json.loads(out)


def card(game, key, name):
    im = Image.open(os.path.join(ROOT, 'assets', '맵', game, key + '.jpg')).convert('RGB')
    im = ImageOps.fit(im, (CW, CH), Image.LANCZOS, centering=(0.5, 0.5)).convert('RGBA')
    ov = Image.new('RGBA', (CW, CH), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    for i in range(105):  # 아래쪽 이름판 그라데이션
        d.line([(0, CH - 105 + i), (CW, CH - 105 + i)], fill=(8, 10, 16, int(220 * (i / 105) ** 1.4)))
    f = ImageFont.truetype(FONT_KO, 26 if len(name) <= 9 else 21)
    d.text(((CW - d.textlength(name, font=f)) / 2, CH - 47), name, font=f, fill=(255, 255, 255, 255))
    out = Image.alpha_composite(im, ov).convert('RGB')
    dst = os.path.join(ROOT, 'assets', '맵', '카드', game, key + '.png')
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    out.save(dst, 'PNG', optimize=True)


def background(game):
    acc = ACCENT[game]
    bg = Image.new('RGB', (W, H), (12, 15, 22))
    d = ImageDraw.Draw(bg)
    for y in range(H):
        c = int(10 + 18 * (y / H))
        d.line([(0, y), (W, y)], fill=(c, c + 3, c + 12))
    big = ImageFont.truetype(FONT_EN, 42)
    d.text((30, 27), 'MAP DRAW', font=big, fill=(255, 255, 255))
    d.rectangle([30, 78, 105, 81], fill=acc)
    ko = ImageFont.truetype(FONT_KO, 17)
    d.text((30 + d.textlength('MAP DRAW', font=big) + 14, 46), '맵 뽑기', font=ko, fill=acc)
    sm = ImageFont.truetype(FONT_KO, 17)
    msg = '추첨 중...'
    d.text((W - 30 - d.textlength(msg, font=sm), 50), msg, font=sm, fill=(190, 198, 212))
    dst = os.path.join(ROOT, 'assets', '맵', '연출', f'배경_{game}.png')
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    bg.save(dst, 'PNG', optimize=True)


def main():
    n = 0
    for game, pool in load_pools().items():
        background(game)
        for m in pool:
            card(game, m['key'], m['name'])
            n += 1
    print(f'맵 카드 {n}개 + 배경 생성')


if __name__ == '__main__':
    sys.exit(main())

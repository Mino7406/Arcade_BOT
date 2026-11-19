"""맵 뽑기 결과 이미지 만들기 (개발용 일회성): python -I scripts/맵결과이미지.py

assets/맵/<게임>/<키>.jpg 원본 위에 맵 이름을 게임 로딩 화면 느낌으로 박아
assets/맵/결과/<게임>/<키>.jpg (1200x675) 로 저장한다. 봇은 이 파일을 그대로 첨부만 한다.
 - 오버워치: 오른쪽 아래에 크게 기울어진(이탤릭) 흰 이름(로딩 화면의 맵 이름 자리)
 - 발로란트: 왼쪽 위에 굵은 대문자 영문 이름 + 아래에 자간 넓은 작은 글줄(한국어 이름·STANDARD) + 작은 청록 점
맵 이름은 handlers/매치/맵.js 의 MAP_POOLS 에서 노드로 읽어 온다(한 곳에서만 관리).
글꼴: 두 게임의 공식 글꼴(Big Noodle Titling·Tungsten)은 상용이라 쓰지 않고, 비슷한 무료(OFL) 글꼴을 assets/fonts/ 에 두고 쓴다.
 - 오버워치 이름: Black Han Sans(굵은 한국어, 기울여서)  - 발로란트 큰 영문 이름: Bebas Neue  - 작은 글줄: Windows 의 Bahnschrift(DIN 계열)·맑은 고딕
필요: Python + Pillow, Node.
"""
import json
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
W, H = 1200, 675
WIN = 'C:/Windows/Fonts/'
FONT_KO_BOLD = WIN + 'malgunbd.ttf'          # 한국어(굵게) — 발로란트 작은 글줄
FONT_KOVER = os.path.join(ROOT, 'assets', 'fonts', 'koverwatch', 'Koverwatch.ttf')   # 오버워치 이름(한글 포함). 저장소에는 올리지 않는 로컬 파일(.gitignore)
FONT_OW_FALLBACK = os.path.join(ROOT, 'assets', 'fonts', 'BlackHanSans-Regular.ttf')  # Koverwatch 가 없으면 쓰는 굵은 한국어
FONT_OW = FONT_KOVER if os.path.exists(FONT_KOVER) else FONT_OW_FALLBACK
LOGO_OW = os.path.join(ROOT, 'assets', '맵', '로고', 'overwatch.png')  # 오버워치 로고(투명 배경 PNG)
FONT_VAL_BIG = os.path.join(ROOT, 'assets', 'fonts', 'BebasNeue-Regular.ttf')  # 발로란트 큰 영문 이름
FONT_KO_REG = WIN + 'malgun.ttf'
FONT_DIN = WIN + 'bahnschrift.ttf'           # DIN 계열(발로란트 영문)
FALLBACK_KO = os.path.join(ROOT, 'assets', 'fonts', 'NanumGothic-Bold.ttf')


def ko_font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.truetype(FALLBACK_KO, size)


def din_font(size, variation='Bold Condensed'):
    f = ImageFont.truetype(FONT_DIN, size)
    try:
        f.set_variation_by_name(variation)
    except Exception:
        pass
    return f


def load_pools():
    out = subprocess.run(
        ['node', '-e', "console.log(JSON.stringify(require('./handlers/매치/맵.js').MAP_POOLS))"],
        cwd=ROOT, capture_output=True, check=True, encoding='utf-8',
    ).stdout
    return json.loads(out)


def spaced(draw, xy, text, font, fill, tracking):
    """글자 사이를 tracking(px) 만큼 벌려 그린다. 그린 폭을 돌려준다."""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + tracking
    return x - xy[0] - tracking


def spaced_width(draw, text, font, tracking):
    return sum(draw.textlength(ch, font=font) + tracking for ch in text) - tracking


def overwatch(im, name):
    """오른쪽 아래, 크게 기울어진 흰 이름 + 그림자. 바닥에 어두운 그라데이션(글자 가독성)."""
    grad = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    top = int(H * 0.62)
    for y in range(top, H):
        gd.line([(0, y), (W, y)], fill=(8, 12, 24, int(185 * (y - top) / (H - top))))
    im = Image.alpha_composite(im, grad)

    size = 140
    shear = 0.22  # 기울기(이탤릭)
    while size > 40:
        font = ko_font(FONT_OW, size)
        probe = ImageDraw.Draw(im).textbbox((0, 0), name, font=font)
        if (probe[2] - probe[0]) * 1.0 + size * shear <= W * 0.62:
            break
        size -= 4
    tw, th = probe[2] - probe[0], probe[3] - probe[1]
    pad = 40
    layer = Image.new('RGBA', (tw + pad * 2 + int(size * shear), th + pad * 2), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    ld.text((pad - probe[0] + 5, pad - probe[1] + 5), name, font=font, fill=(0, 0, 0, 150), stroke_width=3, stroke_fill=(0, 0, 0, 150))   # 그림자
    ld.text((pad - probe[0], pad - probe[1]), name, font=font, fill=(255, 255, 255, 255))
    # x' = x + shear*(h - y): 아래쪽을 기준으로 윗부분이 오른쪽으로 기운다
    lh = layer.size[1]
    layer = layer.transform(layer.size, Image.AFFINE, (1, shear, -shear * lh, 0, 1, 0), Image.BICUBIC)
    # 로고: 이름 오른쪽(로딩 화면처럼). 글자 높이에 맞춰 키우고 세로 가운데를 이름과 맞춘다.
    right = W - 64
    cy = H - 56 - th / 2
    if os.path.exists(LOGO_OW):
        L = int(min(150, max(96, th * 1.5)))
        logo = Image.open(LOGO_OW).convert('RGBA').resize((L, L), Image.LANCZOS)
        im.alpha_composite(logo, (right - L, int(cy - L / 2)))
        right -= L + 18
    x = right - layer.size[0] + pad
    y = cy - layer.size[1] / 2
    im.alpha_composite(layer, (max(0, int(x)), max(0, int(y))))
    return im


def valorant(im, key, name):
    """왼쪽 위, 굵은 대문자 영문 이름 + 자간 넓은 작은 글줄 + 청록 점. 왼쪽 위에 부드러운 어두운 번짐."""
    shade = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shade)
    # 왼쪽→오른쪽으로 옅어지는 어두운 번짐에, 위→아래로 옅어지는 마스크를 곱한다
    for x in range(0, 760):
        a = int(130 * (1 - x / 760) ** 1.5)
        sd.line([(x, 0), (x, 330)], fill=(8, 10, 16, a))
    fade = Image.new('L', (W, H), 0)
    fd = ImageDraw.Draw(fade)
    for y in range(0, 330):
        fd.line([(0, y), (W, y)], fill=int(255 * (1 - y / 330) ** 0.9))
    alpha = shade.getchannel('A')
    from PIL import ImageChops
    shade.putalpha(ImageChops.multiply(alpha, fade))
    im = Image.alpha_composite(im, shade)

    draw = ImageDraw.Draw(im)
    en = key.replace('-', ' ').upper()
    size = 190
    while size > 60:
        font = ko_font(FONT_VAL_BIG, size)
        w = spaced_width(draw, en, font, 3)
        if w <= 620:
            break
        size -= 6
    bb = draw.textbbox((0, 0), en, font=font)
    x0, y0 = 64, 54
    spaced(draw, (x0, y0 - bb[1]), en, font, (255, 255, 255, 255), 3)
    base = y0 + (bb[3] - bb[1]) + 34
    sub = din_font(22, 'Regular')
    kofont = ko_font(FONT_KO_BOLD, 26)
    spaced(draw, (x0 + 4, base), name, kofont, (236, 244, 244, 235), 6)               # 한국어 이름(자간 넓게)
    spaced(draw, (x0 + 4, base + 44), 'STANDARD', sub, (214, 232, 232, 200), 8)
    draw.rectangle([x0 + 4, base + 90, x0 + 16, base + 102], fill=(150, 232, 232, 235))  # 작은 청록 점(참고 화면의 표식)
    return im


def render(game, key, src, dst, name):
    im = Image.open(src).convert('RGB').resize((W, H), Image.LANCZOS).convert('RGBA')
    im = overwatch(im, name) if game == 'overwatch' else valorant(im, key, name)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    im.convert('RGB').save(dst, 'JPEG', quality=86, optimize=True, progressive=True)


def main():
    count = 0
    for game, maps in load_pools().items():
        for m in maps:
            src = os.path.join(ROOT, 'assets', '맵', game, m['key'] + '.jpg')
            dst = os.path.join(ROOT, 'assets', '맵', '결과', game, m['key'] + '.jpg')
            render(game, m['key'], src, dst, m['name'])
            count += 1
    print(f'결과 이미지 {count}개 생성')


if __name__ == '__main__':
    sys.exit(main())

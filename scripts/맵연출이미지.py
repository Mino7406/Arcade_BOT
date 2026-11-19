"""맵 뽑기 연출(맵 투표 화면) 이미지 만들기 (개발용 일회성): python -I scripts/맵연출이미지.py

오버워치 맵 투표 화면처럼 맵 카드 3장이 나란히 놓이고 하이라이트가 한 장에 켜진 모습을
assets/맵/연출/<게임>/<당첨키>_<하이라이트칸>.jpg (1200x675) 로 저장한다. 맵마다 3장(칸 0·1·2).
카드 구성은 규칙으로 정해 둔다(봇의 handlers/매치/맵.js voteCards 와 같아야 한다):
  당첨 맵은 (풀 안 순번 % 3) 번째 칸, 나머지 두 칸은 풀에서 순번+1·순번+5 번째 맵(차례대로 빈 칸에).
필요: Python + Pillow, Node.  글꼴: assets/fonts/BlackHanSans-Regular.ttf(OFL), BebasNeue-Regular.ttf(OFL)
"""
import json
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
W, H = 1200, 675
CW, CH, GAP = 340, 420, 40          # 카드 크기·간격
X0, Y0 = (W - (3 * CW + 2 * GAP)) // 2, 168
ACCENT = {'valorant': (253, 69, 86), 'overwatch': (250, 156, 30)}
FONT_KO = os.path.join(ROOT, 'assets', 'fonts', 'BlackHanSans-Regular.ttf')
FONT_EN = os.path.join(ROOT, 'assets', 'fonts', 'BebasNeue-Regular.ttf')


def load_pools():
    out = subprocess.run(
        ['node', '-e', "console.log(JSON.stringify(require('./handlers/매치/맵.js').MAP_POOLS))"],
        cwd=ROOT, capture_output=True, check=True, encoding='utf-8').stdout
    return json.loads(out)


def vote_cards(pool, idx):
    """[칸0, 칸1, 칸2] 의 풀 순번. 당첨은 idx % 3 칸."""
    n = len(pool)
    others = [(idx + 1) % n, (idx + 5) % n]
    p = idx % 3
    cards, o = [None] * 3, iter(others)
    for s in range(3):
        cards[s] = idx if s == p else next(o)
    return cards


def card_img(game, key, name, lit, acc):
    im = Image.open(os.path.join(ROOT, 'assets', '맵', game, key + '.jpg')).convert('RGB')
    im = ImageOps.fit(im, (CW, CH), Image.LANCZOS, centering=(0.5, 0.5))
    if not lit:  # 꺼진 카드: 어둡고 흐릿한 색
        im = ImageEnhance.Color(im).enhance(0.45)
        im = ImageEnhance.Brightness(im).enhance(0.42)
    ov = Image.new('RGBA', (CW, CH), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    for i in range(150):  # 아래쪽 이름판 그라데이션
        a = int(215 * (i / 150) ** 1.4)
        d.line([(0, CH - 150 + i), (CW, CH - 150 + i)], fill=(8, 10, 16, a))
    f = ImageFont.truetype(FONT_KO, 34 if len(name) <= 9 else 28)
    tw = d.textlength(name, font=f)
    d.text(((CW - tw) / 2, CH - 70), name, font=f, fill=(255, 255, 255, 255 if lit else 150))
    d.rectangle([CW // 2 - 22, CH - 22, CW // 2 + 22, CH - 18], fill=acc + (255,) if lit else (255, 255, 255, 60))
    im = Image.alpha_composite(im.convert('RGBA'), ov).convert('RGB')
    return im


def render(game, pool, idx, slot):
    acc = ACCENT[game]
    bg = Image.new('RGB', (W, H), (12, 15, 22))
    d = ImageDraw.Draw(bg)
    for y in range(H):  # 은은한 세로 그라데이션
        c = int(10 + 18 * (y / H))
        d.line([(0, y), (W, y)], fill=(c, c + 3, c + 12))
    cards = vote_cards(pool, idx)
    # 하이라이트 빛 번짐
    glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    gx = X0 + slot * (CW + GAP)
    ImageDraw.Draw(glow).rectangle([gx - 14, Y0 - 14, gx + CW + 14, Y0 + CH + 14], fill=acc + (170,))
    glow = glow.filter(ImageFilter.GaussianBlur(26))
    bg = Image.alpha_composite(bg.convert('RGBA'), glow).convert('RGB')
    for s, pi in enumerate(cards):
        m = pool[pi]
        lit = s == slot
        im = card_img(game, m['key'], m['name'], lit, acc)
        x, y = X0 + s * (CW + GAP), Y0
        if lit:  # 켜진 카드는 살짝 크게 + 굵은 테두리
            big = (int(CW * 1.06), int(CH * 1.06))
            im = im.resize(big, Image.LANCZOS)
            x, y = x - (big[0] - CW) // 2, y - (big[1] - CH) // 2
            ImageDraw.Draw(im).rectangle([0, 0, big[0] - 1, big[1] - 1], outline=acc, width=6)
        else:
            ImageDraw.Draw(im).rectangle([0, 0, im.width - 1, im.height - 1], outline=(70, 78, 92), width=2)
        bg.paste(im, (x, y))
    d = ImageDraw.Draw(bg)
    big = ImageFont.truetype(FONT_EN, 64)
    d.text((X0, 52), 'MAP VOTE', font=big, fill=(255, 255, 255))
    d.rectangle([X0, 128, X0 + 120, 133], fill=acc)
    ko = ImageFont.truetype(FONT_KO, 24)
    d.text((X0 + d.textlength('MAP VOTE', font=big) + 22, 78), '맵 투표', font=ko, fill=acc)
    sm = ImageFont.truetype(FONT_KO, 26)
    msg = '투표 집계 중...'
    d.text((W - X0 - d.textlength(msg, font=sm), 84), msg, font=sm, fill=(190, 198, 212))
    dst = os.path.join(ROOT, 'assets', '맵', '연출', game, f"{pool[idx]['key']}_{slot}.jpg")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    bg.save(dst, 'JPEG', quality=84, optimize=True, progressive=True)


def main():
    n = 0
    for game, pool in load_pools().items():
        for idx in range(len(pool)):
            for slot in range(3):
                render(game, pool, idx, slot)
                n += 1
    print(f'맵 투표 프레임 {n}개 생성')


if __name__ == '__main__':
    sys.exit(main())

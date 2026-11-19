"""맵 뽑기 결과 이미지 만들기 (개발용 일회성): python -I scripts/맵결과이미지.py

assets/맵/<게임>/<키>.jpg 원본 위에 맵 이름을 게임 로딩 화면 느낌으로 박아
assets/맵/결과/<게임>/<키>.jpg (1200x675) 로 저장한다. 봇은 이 파일을 그대로 첨부만 한다.
 - 오버워치: 오른쪽 아래에 크게 기울어진(이탤릭) 흰 이름(로딩 화면의 맵 이름 자리)
 - 발로란트: 왼쪽 위에 굵은 대문자 영문 이름 + 아래에 자간 넓은 작은 글줄(한국어 이름·ARCADE MATCH — CUSTOM / 5 VS 5) + 작은 흰 점
맵 이름은 handlers/매치/맵.js 의 MAP_POOLS 에서 노드로 읽어 온다(한 곳에서만 관리).
글꼴: 두 게임의 공식 글꼴(Big Noodle Titling·Tungsten)은 상용이라 쓰지 않고, 비슷한 무료(OFL) 글꼴을 assets/fonts/ 에 두고 쓴다.
 - 오버워치 이름: Black Han Sans(굵은 한국어, 기울여서)  - 발로란트 큰 영문 이름: Bebas Neue  - 작은 글줄: Windows 의 Bahnschrift(DIN 계열)·맑은 고딕
필요: Python + Pillow, Node.
"""
import json
import math
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
W, H = 1200, 675
WIN = 'C:/Windows/Fonts/'
FONT_KO_BOLD = WIN + 'malgunbd.ttf'          # 한국어(굵게) — 발로란트 작은 글줄
FONT_KOVER = os.path.join(ROOT, 'assets', 'fonts', 'koverwatch', 'Koverwatch.ttf')   # 오버워치 이름(한글 포함). 저장소에는 올리지 않는 로컬 파일(.gitignore)
FONT_OW_FALLBACK = os.path.join(ROOT, 'assets', 'fonts', 'BlackHanSans-Regular.ttf')  # Koverwatch 가 없으면 쓰는 굵은 한국어
FONT_OW = FONT_KOVER if os.path.exists(FONT_KOVER) else FONT_OW_FALLBACK
LOGO_OW = os.path.join(ROOT, 'assets', '맵', '로고', 'overwatch.png')  # 오버워치 로고(투명 배경 PNG)
# 오버워치 맵이 있는 나라(맵 정보의 위치 기준) → assets/맵/국기/<코드>.png (flagcdn.com). 나라가 없는 맵(남극 반도·눔바니)은 국기 대신 로고 태그.
FLAG_OF = {
    'circuit-royal': 'mc', 'dorado': 'mx', 'grimsvotn': 'is', 'havana': 'cu', 'junkertown': 'au', 'rialto': 'it',
    'route-66': 'us', 'shambali-monastery': 'np', 'watchpoint-gibraltar': 'gi',
    'blizzard-world': 'us', 'eichenwalde': 'de', 'hollywood': 'us', 'kings-row': 'gb', 'midtown': 'us',
    'neon-junction': 'jp', 'paraiso': 'br',
    'colosseo': 'it', 'esperanca': 'pt', 'new-queen-street': 'ca', 'runasapi': 'pe',
    'busan': 'kr', 'ilios': 'gr', 'lijiang-tower': 'cn', 'nepal': 'np', 'oasis': 'iq', 'samoa': 'ws',
    'aatlis': 'ma', 'new-junk-city': 'au', 'suravasa': 'in',
}
FLAG_DIR = os.path.join(ROOT, 'assets', '맵', '국기')
ARC_START = -69  # 주황 4분의 1 원의 시작 각도
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


# 오버워치 인게임 한국어 로딩 화면(1687x841)에서 잰 비율. 모든 길이는 화면 높이 841 기준 px 이고 SC 로 우리 이미지(높이 675)에 맞춘다.
SC = H / 841
REF = {
    'name_h': 97,       # "남극 반도" 글자 높이
    'logo': 100,        # 로고 지름
    'ring': 128,        # 로고 둘레 얇은 원 지름
    'arc_w': 7.4,       # 주황 4분의 1 원 굵기(얇은 원 위에 겹쳐 그린다)
    'mode_h': 36,       # 주황 모드 글씨("빠른 대전") 높이
    'mode_over': 19,    # 주황 글씨가 이름 오른쪽 끝보다 더 나간 거리
    'mode_gap': 3,      # 주황 글씨 아래 ~ 이름 위 간격
    'tag_w': 54, 'tag_h': 32,
    'tag_gap': 2,       # 태그 오른쪽 ~ 이름 왼쪽
    'tag_drop': 30,     # 이름 위에서 태그 가운데까지
    'flag_h': 40, 'flag_w_max': 62,   # 국기 크기(높이·최대 폭)
    'flag_drop': 46,    # 이름 위에서 국기 가운데까지
    'name_gap': 30,     # 이름 오른쪽 ~ 둘레 원 왼쪽
    'right': 52,        # 둘레 원 오른쪽 ~ 화면 오른쪽
    'bottom': 24,       # 둘레 원 아래 ~ 화면 아래
    'name_up': 6,       # 이름 세로 가운데가 로고 가운데보다 위로 올라간 정도
}


def whiten(logo):
    """로고의 연회색 부분을 순백으로(주황은 그대로) — 인게임 로고는 흰색이다."""
    px = logo.load()
    for y in range(logo.size[1]):
        for x in range(logo.size[0]):
            r, g, b, a = px[x, y]
            if a and max(r, g, b) - min(r, g, b) < 28:  # 거의 무채색 = 흰 링·가운데 모양
                px[x, y] = (255, 255, 255, a)
    return logo


def ring_overlay(size, cx, cy, ring, arc_r, arc_w, line_w):
    """로고 둘레: 오른쪽 아래로 갈수록 흐려지는 얇은 원 + 굵기가 일정하고 끝이 평평한 주황 호. 4배로 그려 줄여 매끈하게."""
    K = 4
    pad = int(ring) + 8
    box = (int(cx - pad), int(cy - pad), int(cx + pad), int(cy + pad))
    big = Image.new('RGBA', ((box[2] - box[0]) * K, (box[3] - box[1]) * K), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    ox, oy = (cx - box[0]) * K, (cy - box[1]) * K
    R = ring / 2 * K

    # 얇은 원: 3° 마다 끊어 그리며 알파를 바꾼다(위·왼쪽은 진하게, 아래→오른쪽 아래로 흐려져 20° 근처에서 사라진다. 각도는 3시 0°·시계 방향)
    for deg in range(0, 360, 3):
        a = ((deg % 360) - 20) / 70.0 if 20 <= deg % 360 <= 90 else (0.0 if 0 <= deg % 360 < 20 else 1.0)
        if a <= 0:
            continue
        d.arc([ox - R, oy - R, ox + R, oy + R], deg, deg + 3.5, fill=(255, 255, 255, int(95 * min(1.0, a))), width=max(1, int(line_w * K)))

    # 주황 호: 굵기 일정, 시작·끝은 평평하게 잘림(인게임 그대로)
    ar = arc_r * K
    end = ARC_START + 98
    pts_out, pts_in = [], []
    n = 80
    for k in range(n + 1):
        t = k / n
        ang = math.radians(ARC_START + (end - ARC_START) * t)
        w = arc_w * K  # 인게임 호는 굵기가 일정하고 시작·끝이 평평하게 잘려 있다
        pts_out.append((ox + (ar + w / 2) * math.cos(ang), oy + (ar + w / 2) * math.sin(ang)))
        pts_in.append((ox + (ar - w / 2) * math.cos(ang), oy + (ar - w / 2) * math.sin(ang)))
    d.polygon(pts_out + pts_in[::-1], fill=(242, 106, 36, 255))
    small = big.resize((box[2] - box[0], box[3] - box[1]), Image.LANCZOS)
    layer = Image.new('RGBA', size, (0, 0, 0, 0))
    layer.alpha_composite(small, (box[0], box[1]))
    return layer


def fit_font(path, sample, target_h):
    """sample 글자의 높이(bbox)가 target_h px 가 되는 글꼴 크기를 찾는다."""
    d = ImageDraw.Draw(Image.new('RGB', (10, 10)))
    best = 20
    for size in range(20, 320):
        f = ko_font(path, size)
        b = d.textbbox((0, 0), sample, font=f)
        if b[3] - b[1] > target_h:
            break
        best = size
    return best


def overwatch(im, name, mode='ARCADE 내전', flag=None):
    """오버워치 한국어 인게임 화면과 같은 비율(오른쪽 아래): [로고 태그] 이름(바로 선 흰 글씨) [로고+얇은 원+주황 4분의 1 원], 이름 위 주황 모드 글씨."""
    r = {k: v * SC for k, v in REF.items()}
    size = fit_font(FONT_OW, '남극 반도', r['name_h'])
    d0 = ImageDraw.Draw(im)
    while size > 40:  # 이름이 너무 길면(예: 감시 기지: 그림스뵈튼) 줄인다
        font = ko_font(FONT_OW, size)
        probe = d0.textbbox((0, 0), name, font=font)
        if probe[2] - probe[0] <= W * 0.52:
            break
        size -= 2
    font = ko_font(FONT_OW, size)
    probe = d0.textbbox((0, 0), name, font=font)
    tw, th = probe[2] - probe[0], probe[3] - probe[1]

    ring = r['ring']
    L = r['logo']
    cx = W - r['right'] - ring / 2
    cy = H - r['bottom'] - ring / 2          # 로고·둘레 원의 가운데
    name_cy = cy - r['name_up']
    name_right = cx - ring / 2 - r['name_gap']
    name_left = name_right - tw
    name_top = name_cy - th / 2

    # 얇은 원 + 주황 4분의 1 원 + 로고
    im = Image.alpha_composite(im, ring_overlay(im.size, cx, cy, ring, ring / 2 - r['arc_w'] / 2 - 0.5, r['arc_w'], 1.2 * SC))
    logo = None
    if os.path.exists(LOGO_OW):
        logo = whiten(Image.open(LOGO_OW).convert('RGBA')).resize((int(L), int(L)), Image.LANCZOS)
        im.alpha_composite(logo, (int(cx - L / 2), int(cy - L / 2)))

    # 이름: 은은한 그림자 + 살짝 푸른 흰색(바로 선 글씨)
    pad = 30
    layer = Image.new('RGBA', (int(tw + pad * 2), int(th + pad * 2)), (0, 0, 0, 0))
    sh = Image.new('RGBA', layer.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).text((pad - probe[0], pad - probe[1] + 3), name, font=font, fill=(10, 24, 48, 170), stroke_width=1, stroke_fill=(10, 24, 48, 170))
    layer.alpha_composite(sh.filter(ImageFilter.GaussianBlur(5)))
    mask = Image.new('L', layer.size, 0)
    ImageDraw.Draw(mask).text((pad - probe[0], pad - probe[1]), name, font=font, fill=255, stroke_width=1, stroke_fill=255)
    grad = Image.new('RGBA', layer.size, (0, 0, 0, 0))
    gp = grad.load()
    top_y, bot_y = pad, pad + th
    for y in range(layer.size[1]):
        t = min(1.0, max(0.0, (y - top_y) / max(1, bot_y - top_y)))
        col = (int(252 - 44 * t), int(253 - 38 * t), int(255 - 22 * t), 255)  # 순백 → (208,215,233)
        for x in range(layer.size[0]):
            gp[x, y] = col
    grad.putalpha(mask)
    layer.alpha_composite(grad)
    im.alpha_composite(layer, (int(name_left - pad), int(name_top - pad)))

    # 주황 작은 모드 글씨: 이름 오른쪽 끝보다 조금 더 나가고, 이름 바로 위
    msz = fit_font(FONT_OW, mode, r['mode_h'] * (1.2 if len(mode) <= 2 else 1.0))
    mf = ko_font(FONT_OW, msz)
    mb = ImageDraw.Draw(im).textbbox((0, 0), mode, font=mf)
    mx = name_right + r['mode_over'] - (mb[2] - mb[0]) - mb[0]
    my = name_top - r['mode_gap'] - (mb[3] - mb[1]) - mb[1]
    ImageDraw.Draw(im).text((mx, my), mode, font=mf, fill=(247, 130, 62, 255))

    flag_file = os.path.join(FLAG_DIR, f'{flag}.png') if flag else None
    if flag_file and os.path.exists(flag_file):
        # 이름 왼쪽의 나라 국기(얇은 흰 테두리). 비율은 그대로, 높이 flag_h 에 맞추되 너무 넓으면 폭에 맞춘다.
        fl = Image.open(flag_file).convert('RGBA')
        fh = r['flag_h']
        fw = fh * fl.size[0] / fl.size[1]
        if fw > r['flag_w_max']:
            fw, fh = r['flag_w_max'], r['flag_w_max'] * fl.size[1] / fl.size[0]
        fl = fl.resize((int(fw), int(fh)), Image.LANCZOS)
        fx = int(name_left - r['tag_gap'] - 6 * SC - fw)
        fy = int(name_top + r['flag_drop'] - fh / 2)
        edge = Image.new('RGBA', im.size, (0, 0, 0, 0))
        ImageDraw.Draw(edge).rectangle([fx - 1, fy - 1, fx + fw, fy + fh], outline=(255, 255, 255, 190), width=max(1, round(1.4 * SC)))
        im = Image.alpha_composite(im, edge)
        im.alpha_composite(fl, (fx, fy))
        return im

    # 국기가 없는 맵(남극 반도·눔바니): 이름 왼쪽 위쪽의 작은 태그: 남색 사각형 안에 작은 로고(모서리는 각짐)
    bw, bh = r['tag_w'], r['tag_h']
    bx = name_left - r['tag_gap'] - bw
    by = name_top + r['tag_drop'] - bh / 2
    tag = Image.new('RGBA', im.size, (0, 0, 0, 0))
    ImageDraw.Draw(tag).rectangle([bx, by, bx + bw, by + bh], fill=(22, 44, 76, 235))
    im = Image.alpha_composite(im, tag)
    if logo is not None:
        sm = int(bh * 0.78)
        im.alpha_composite(logo.resize((sm, sm), Image.LANCZOS), (int(bx + (bw - sm) / 2), int(by + (bh - sm) / 2)))
    return im


# 발로란트 로딩 화면 좌표(맵의 실제 위치). 도·분은 나무위키 값, 인게임에서 글자가 섞여 읽히지 않는 초 단위는 임의 숫자로 채웠다(스플릿·펄·로터스·어비스는 위키의 완전한 값).
COORDS = {
    'bind': '''34°02'11"N, 6°51'27"W''',
    'haven': '''27°28'41"N, 89°38'27"E''',
    'split': '''35°41'23"N, 139°41'32"E''',
    'ascent': '''45°26'18"N, 12°20'09"E''',
    'icebox': '''76°44'32"N, 149°30'06"E''',
    'breeze': '''26°11'47"N, 71°10'38"W''',
    'fracture': '''35°48'52"N, 106°08'14"W''',
    'pearl': '''38°42'43"N, 9°08'27"W''',
    'lotus': '''14°07'03"N, 74°53'21"E''',
    'sunset': '''34°02'51"N, 118°12'36"W''',
    'abyss': '''70°50'09"N, 9°00'42"W''',
    'corrode': '''48°38'12"N, 1°33'05"W''',
    'summit': '''29°18'42"N, 110°25'19"E''',
}


def valorant(im, key, name):
    """왼쪽 위, 굵은 대문자 영문 이름 + 자간 넓은 작은 글줄 + 흰 점. 왼쪽 위에 부드러운 어두운 번짐."""
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
    y = base + 44
    if key in COORDS:                                                                          # 로딩 화면의 좌표 줄(맵의 실제 위치)
        w = spaced(draw, (x0 + 4, y), COORDS[key], sub, (214, 232, 232, 215), 8)
        draw.rectangle([x0 + 4, y + 36, x0 + 4 + 96, y + 37], fill=(214, 232, 232, 120))  # 좌표 밑 짧은 구분선(좌표 글줄 너비의 1/4쯤)
        y += 52
    spaced(draw, (x0 + 4, y), 'ARCADE MATCH — CUSTOM', sub, (214, 232, 232, 200), 8)  # 인게임의 "STANDARD — CUSTOM" 자리
    spaced(draw, (x0 + 4, y + 34), '5 VS 5', sub, (214, 232, 232, 150), 8)                 # 인게임의 서버 이름(FRANKFURT) 자리, 윗줄보다 살짝 흐리게
    y += 80
    draw.rectangle([x0 + 4, y, x0 + 16, y + 12], fill=(255, 255, 255, 240))  # 작은 흰 점(인게임 화면의 표식)
    return im


def render(game, key, src, dst, name):
    im = Image.open(src).convert('RGB').resize((W, H), Image.LANCZOS).convert('RGBA')
    im = overwatch(im, name, flag=FLAG_OF.get(key)) if game == 'overwatch' else valorant(im, key, name)
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

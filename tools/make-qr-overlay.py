#!/usr/bin/env python3
# The show's QR overlays (gpu/sun-qr.js), made in the style of the original
# slides/qr_overlay_TSC2026@2x.png: 980 x 1105, a 41-module code (version 6)
# at 20 px a module inside a 4-module border, the label's letters at the
# original's spacing (its label spans the code's width, x 80 to 899), centred
# on the code, on a baseline at y 1022. Ink is
# black at alpha 241; the code's dark modules and the letters are cut out of
# it (alpha 0), so the sun shows through them and Lighten fills them with
# white.
#
# The label's face was matched to the original's letters glyph by glyph
# (ink widths of m e d i: 43 27 29 9 px against the original's 43 28 30 9,
# x-height 28 against 27): Avenir Next Demi Bold at 56.5 px.
#
#   python3 -I tools/make-qr-overlay.py <url> <label> <out.png>
#   python3 -I tools/make-qr-overlay.py https://presence.now.audio/?follow=win \
#       presence.now.audio slides/qr_overlay_follow@2x.png
#   python3 -I tools/make-qr-overlay.py --check   the original's label, redrawn
#       beside the original's own (scratch file printed), to see the match
import sys
import qrcode
from PIL import Image, ImageDraw, ImageFont

W, H = 980, 1105
INK = 241
MOD, BORDER, VERSION = 20, 4, 6
TEXT_X0, TEXT_X1 = 80, 899      # the label's ink, left and right, inclusive
BASELINE = 1022
FONT = ('/System/Library/Fonts/Avenir Next.ttc', 2, 56.5)   # Demi Bold
ORIGINAL = 'slides/qr_overlay_TSC2026@2x.png'


def spread(f, text):
    """The text's ink width with no extra spacing, and the one extra spacing
    between letters that lays its first letter's ink at TEXT_X0 and its
    last's at TEXT_X1."""
    first, last = f.getbbox(text[0], anchor='ls'), f.getbbox(text[-1], anchor='ls')
    ink = sum(f.getlength(ch) for ch in text[:-1]) + last[2] - first[0]
    return ink, (TEXT_X1 + 1 - TEXT_X0 - ink) / (len(text) - 1)


def label_mask(text):
    """The label as an L mask (255 = letter). The original's letter spacing,
    centred on the code; a label too long for that spacing is tightened to
    span the code's width exactly."""
    path, index, size = FONT
    f = ImageFont.truetype(path, size, index=index)
    ink, gap = spread(f, text)
    gap = min(gap, spread(f, 'meditatewiththesun.com')[1])
    width = ink + gap * (len(text) - 1)
    adv = [f.getlength(ch) for ch in text]
    m = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(m)
    x = (TEXT_X0 + TEXT_X1 + 1 - width) / 2 - f.getbbox(text[0], anchor='ls')[0]
    for ch, a in zip(text, adv):
        d.text((x, BASELINE), ch, font=f, fill=255, anchor='ls')
        x += a + gap
    return m, gap


def check():
    orig = Image.open(ORIGINAL).split()[3].point(lambda v: 255 - v)
    box = (60, 960, 920, 1060)
    side = Image.new('L', (860, 200))
    side.paste(orig.crop(box), (0, 0))
    side.paste(label_mask('meditatewiththesun.com')[0].crop(box), (0, 100))
    out = 'sun-video/qr-label-check.png'
    side.save(out)
    print('original above, redrawn below:', out)


def main():
    if sys.argv[1:] == ['--check']:
        return check()
    if len(sys.argv) != 4:
        sys.exit('usage: make-qr-overlay.py <url> <label> <out.png>  |  --check')
    url, label, out = sys.argv[1:]
    qr = qrcode.QRCode(version=VERSION, error_correction=qrcode.constants.ERROR_CORRECT_H,
                       box_size=1, border=0)
    qr.add_data(url)
    qr.make(fit=False)
    grid = qr.get_matrix()
    assert len(grid) == 41, 'expected version 6 (41 modules), got %d' % len(grid)

    cut = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(cut)
    off = BORDER * MOD
    for r, row in enumerate(grid):
        for c, dark in enumerate(row):
            if dark:
                d.rectangle([off + c * MOD, off + r * MOD, off + (c + 1) * MOD - 1, off + (r + 1) * MOD - 1], fill=255)
    text, gap = label_mask(label)
    print('label: %r, %.1f px between letters' % (label, gap))
    cut.paste(255, mask=text)
    alpha = cut.point(lambda v: round(INK * (255 - v) / 255))
    img = Image.merge('RGBA', (Image.new('L', (W, H), 0),) * 3 + (alpha,))
    img.save(out, optimize=True)
    print('wrote', out)


if __name__ == '__main__':
    main()

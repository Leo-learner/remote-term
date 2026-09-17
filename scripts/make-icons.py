# Placeholder app icons until the design delivers real ones: a ">_" prompt on Catppuccin Mocha.
# Pure Python (zlib + struct), 4x supersampled for smooth edges.
import math, struct, sys, zlib
from pathlib import Path

BASE = (0x1e, 0x1e, 0x2e)
MAUVE = (0xcb, 0xa6, 0xf7)
BLUE = (0x89, 0xb4, 0xfa)

def distance_to_segment(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

def render(size, scale=0.62):
    ss = 4
    # glyph in a 40-unit box, like mark.svg, centred and scaled
    unit = size * scale / 40
    off = (size - 40 * unit) / 2
    strokes = [((8, 13, 16, 20), MAUVE), ((16, 20, 8, 27), MAUVE), ((20, 28, 32, 28), BLUE)]
    half = 1.6 * unit
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            acc = [0.0, 0.0, 0.0]
            for sy in range(ss):
                for sx in range(ss):
                    px = x + (sx + 0.5) / ss
                    py = y + (sy + 0.5) / ss
                    color = BASE
                    for (ax, ay, bx, by), stroke in strokes:
                        d = distance_to_segment(px, py, off + ax * unit, off + ay * unit, off + bx * unit, off + by * unit)
                        if d <= half:
                            color = stroke
                    for i in range(3):
                        acc[i] += color[i]
            row.extend(int(round(c / (ss * ss))) for c in acc)
        rows.append(bytes(row))
    raw = b''.join(rows)
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
for name, size, scale in [('favicon.png', 64, 0.8), ('apple-touch-icon.png', 180, 0.62), ('icon-192.png', 192, 0.62), ('icon-512.png', 512, 0.62), ('icon-512-maskable.png', 512, 0.5)]:
    (out / name).write_bytes(render(size, scale))
    print('wrote', out / name)

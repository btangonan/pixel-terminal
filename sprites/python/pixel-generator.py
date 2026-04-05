from PIL import Image
import base64
from io import BytesIO

# --- FRAME DESCRIPTIONS (16x16) ---
# . = Transparent
# O = Dark Outline
# B = Main Brown Body
# L = Light Tan Snout/Ears

FRAME_1 = [
    "................",
    "....OO.....OO...",
    "...OBLO...OLBO..",
    "...OBBBOOOBBBO..",
    "..OBBBBBBBBBBBO.",
    "..OBBOBBBBBOBBO.",
    "..OBBBLLLLLBBBO.",
    "..OBBLLLOLLLBBBO.",
    "..OBBBLLLLLBBBO.",
    "..OBBBBBBBBBBBO.",
    "..OBBBBBBBBBBBO.",
    "..OOOBBBOBBBOOO.",
    "....OBBBOBBBO...",
    ".....OOO.OOO....",
    "................",
    "................"
]

FRAME_2 = [
    "................",
    "................",
    "....OO.....OO...",
    "...OBLO...OLBO..",
    "...OBBBOOOBBBO..",
    "..OBBBBBBBBBBBO.",
    "..OBBOBBBBBOBBO.",
    "..OBBBLLLLLBBBO.",
    "..OBBLLLOLLLBBBO.",
    "..OBBBLLLLLBBBO.",
    "..OBBBBBBBBBBBO.",
    "..OBBBBBBBBBBBO.",
    "..OOOBBBOBBBOOO.",
    "...OBBBOOBBBO...",
    "....OOO..OOO....",
    "................"
]

FRAME_3 = [
    "................",
    "....OO.....OO...",
    "...OBLO...OLBO..",
    "...OBBBOOOBBBO..",
    "..OBBBBBBBBBBBO.",
    "..OBBOBBBBBOBBO.",
    "..OBBBLLLLLBBBO.",
    "..OBBLLLOLLLBBBO.",
    "..OBBBLLLLLBBBO.",
    "..OBBBBBBBBBBBO.",
    "..OBBBBBBBBBBBO.",
    "..OOOBBBOBBBOOO.",
    "....OBBBOBBBO...",
    ".....OOO.OOO....",
    "................",
    "................"
]

FRAME_4 = [
    "................",
    "................",
    "....OO.....OO...",
    "...OBLO...OLBO..",
    "...OBBBOOOBBBO..",
    "..OBBBBBBBBBBBO.",
    "..OBBOBBBBBOBBO.",
    "..OBBBLLLLLBBBO.",
    "..OBBLLLOLLLBBBO.",
    "..OBBBLLLLLBBBO.",
    "..OBBBBBBBBBBBO.",
    "..OBBBBBBBBBBBO.",
    "..OOOBBBOBBBOOO.",
    "....OBBBOOBBBO..",
    ".....OOO..OOO...",
    "................"
]

# --- PALETTE ---
color_map = {
    'O': (25, 20, 20, 255),    # Dark outline (almost black)
    'B': (150, 90, 50, 255),   # Warm brown body
    'L': (240, 190, 140, 255)  # Light tan details
}

# --- BUILD PIXEL DICT ---
frames = [FRAME_1, FRAME_2, FRAME_3, FRAME_4]
pixels = {}

for frame_idx, frame_data in enumerate(frames):
    offset_x = frame_idx * 16
    for y, row in enumerate(frame_data):
        for x, char in enumerate(row):
            if char in color_map:
                pixels[(offset_x + x, y)] = color_map[char]

# --- GENERATE & SAVE IMAGE ---
img = Image.new("RGBA", (64, 16), (0, 0, 0, 0))

# Draw the pixel dictionary
for coords, color in pixels.items():
    img.putpixel(coords, color)

# Save to disk
out_path = "/tmp/new_sprite.png"
img.save(out_path)
print(f"Saved sprite sheet to: {out_path}\n")

# --- EXPORT BASE64 URI ---
buffer = BytesIO()
img.save(buffer, format="PNG")
b64_str = base64.b64encode(buffer.getvalue()).decode("utf-8")
print(f"data:image/png;base64,{b64_str}")
#!/usr/bin/env python3
"""
Build dock icon, .icns, and all Tauri PNGs for pixel-terminal.

Source: ASCII art 'a' from sprites/logos/a.txt rendered in Menlo, orange #d87756, dark #0d0d0d bg.
Outputs TWO master PNGs — do not conflate them:
  icon_master_1024.png         flat square  → used for .icns + Tauri bundle (macOS squircles it)
  icon_master_1024_rounded.png pre-squircle → used by lib.rs include_bytes! → NSDockTile.contentView

After running this script: `touch ../src/lib.rs` then rebuild.
See CLAUDE.md §"Dock Icon System" for full lifecycle explanation.
"""

import math
import os
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path
from PIL import Image, ImageDraw

ICONS_DIR = Path(__file__).parent

# Apple squircle: continuous-curvature rounded rect, ~22.37% corner radius
CORNER_RADIUS_RATIO = 0.2237


def render_svg_to_image(svg_path: Path, size: int) -> Image.Image:
    """Render the 16x16 pixel-art SVG to an image at `size` using nearest neighbor."""
    tree = ET.parse(svg_path)
    root = tree.getroot()

    # Parse viewBox
    vb = root.get("viewBox", "0 0 16 16").split()
    vb_w, vb_h = float(vb[2]), float(vb[3])
    scale = size / vb_w

    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    for rect in root.iter("{http://www.w3.org/2000/svg}rect"):
        x = float(rect.get("x", 0)) * scale
        y = float(rect.get("y", 0)) * scale
        w = float(rect.get("width", 0)) * scale
        h = float(rect.get("height", 0)) * scale
        fill = rect.get("fill", "#000000")

        # Parse hex color
        fill = fill.lstrip("#")
        r, g, b = int(fill[0:2], 16), int(fill[2:4], 16), int(fill[4:6], 16)
        draw.rectangle([x, y, x + w, y + h], fill=(r, g, b, 255))

    return img


def make_squircle_mask(size: int) -> Image.Image:
    """Create Apple-style continuous-curvature squircle mask."""
    mask = Image.new("L", (size, size), 0)
    radius = size * CORNER_RADIUS_RATIO
    cx, cy = size / 2, size / 2
    half = size / 2

    for y in range(size):
        for x in range(size):
            # Distance from each edge
            dx = max(0, abs(x - cx) - (half - radius))
            dy = max(0, abs(y - cy) - (half - radius))

            if dx == 0 or dy == 0:
                # Inside the straight-edge region
                if abs(x - cx) <= half and abs(y - cy) <= half:
                    mask.putpixel((x, y), 255)
            else:
                # Corner region — use superellipse (n~5 for Apple squircle)
                n = 5.0
                dist = (dx / radius) ** n + (dy / radius) ** n
                if dist <= 1.0:
                    # Anti-alias the edge
                    edge = 1.0 - max(0, min(1, (dist - 0.95) / 0.05))
                    mask.putpixel((x, y), int(edge * 255))

    return mask


def make_squircle_mask_fast(size: int) -> Image.Image:
    """Faster squircle mask using Pillow rounded_rectangle as base, then refine corners."""
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    radius = int(size * CORNER_RADIUS_RATIO)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def center_content(img: Image.Image, bg_color: tuple = (24, 24, 24)) -> Image.Image:
    """Shift non-background content to the true center of the canvas."""
    size = img.size[0]
    pixels = img.load()

    # Find bounding box of non-background pixels
    min_x, min_y, max_x, max_y = size, size, 0, 0
    for y in range(size):
        for x in range(size):
            r, g, b, a = pixels[x, y]
            if a > 0 and (r, g, b) != bg_color:
                min_x = min(min_x, x)
                min_y = min(min_y, y)
                max_x = max(max_x, x)
                max_y = max(max_y, y)

    if max_x < min_x:
        return img  # no content found

    content_w = max_x - min_x + 1
    content_h = max_y - min_y + 1
    content_cx = (min_x + max_x) / 2
    content_cy = (min_y + max_y) / 2
    canvas_c = size / 2

    dx = int(round(canvas_c - content_cx))
    dy = int(round(canvas_c - content_cy))

    if dx == 0 and dy == 0:
        print(f"  Content already centered ({content_w}x{content_h})")
        return img

    print(f"  Content bbox: ({min_x},{min_y})-({max_x},{max_y}) = {content_w}x{content_h}")
    print(f"  Shifting by ({dx}, {dy}) to center")

    # Extract content, paste onto fresh background
    content = img.crop((min_x, min_y, max_x + 1, max_y + 1))
    centered = Image.new("RGBA", (size, size), (*bg_color, 255))
    paste_x = min_x + dx
    paste_y = min_y + dy
    centered.paste(content, (paste_x, paste_y), content)
    return centered


def render_ascii_art_logo(canvas_size: int) -> Image.Image:
    """Render the ASCII art 'a' from a.txt in orange on dark background."""
    from PIL import ImageFont

    lines = [
        "   __ _ ",
        "  / _` |",
        " | (_| |",
        "  \\__,_|",
    ]

    font_path = "/System/Library/Fonts/Menlo.ttc"
    bg_color = (13, 13, 13, 255)

    # Measure at reference size to compute scale
    ref_size = 100
    ref_font = ImageFont.truetype(font_path, ref_size)
    ref_bbox = ref_font.getbbox("M")
    ref_char_w = ref_bbox[2] - ref_bbox[0]  # ~60px at size 100

    # Scale so the 8-char wide text fills 68% of canvas
    target_w = canvas_size * 0.62
    font_size = int(ref_size * target_w / (8 * ref_char_w))
    font = ImageFont.truetype(font_path, font_size)

    # Advance width (includes inter-char spacing) via getlength — NOT getbbox width.
    # getbbox returns ink bounds only; getlength returns true layout advance.
    block_w = int(font.getlength("M" * 8))
    start_x = (canvas_size - block_w) // 2

    # Line height via font metrics (ascent+descent) + leading.
    # draw.text(y) places the ink starting at y + bbox_top, so compensate.
    ascent, descent = font.getmetrics()
    line_h = ascent + descent + int(font_size * 0.08)

    # Vertical: center the ink block, not the layout block.
    # Ink top of first line = start_y + bbox[1]; ink bottom of last line = start_y + (n-1)*line_h + bbox[3]
    sample_bbox = font.getbbox("Mg_|/(\\`")
    ink_h = (len(lines) - 1) * line_h + (sample_bbox[3] - sample_bbox[1])
    start_y = (canvas_size - ink_h) // 2 - sample_bbox[1]

    orange = (216, 119, 86, 255)  # #d87756
    stroke = max(1, font_size // 33)  # slightly lighter than before

    def _render(ox, oy):
        img = Image.new("RGBA", (canvas_size, canvas_size), bg_color)
        draw = ImageDraw.Draw(img)
        for i, line in enumerate(lines):
            draw.text((ox, oy + i * line_h), line, fill=orange, font=font,
                      stroke_width=stroke, stroke_fill=orange)
        return img

    # Pass 1 — render at computed position
    img = _render(start_x, start_y)

    # Pass 2 — measure actual ink center and correct for ASCII art asymmetry.
    # The figlet 'a' is right-heavy (3 '|' chars on right, 1 on left),
    # so layout-centering leaves ink center right of canvas center.
    # Apply a small extra left nudge to compensate for the visual weight of leading spaces.
    import numpy as np
    arr = np.array(img)
    mask = (arr[:, :, 0] > 150) & (arr[:, :, 1] < 150)
    if mask.any():
        ys, xs = np.where(mask)
        dx = canvas_size // 2 - int((int(xs.min()) + int(xs.max())) // 2) - 25
        dy = canvas_size // 2 - int((int(ys.min()) + int(ys.max())) // 2)
        img = _render(start_x + dx, start_y + dy)

    return img


def build_icons():
    canvas_size = 1024

    print("Rendering ASCII art logo...")
    master = render_ascii_art_logo(canvas_size)

    # TWO SEPARATE PNG FILES — do not conflate them:
    #
    # icon_master_1024.png       — flat square, NO squircle mask.
    #   Used for: icon.icns, bundle PNGs, Tauri icon table.
    #   macOS applies the squircle automatically to .app bundle icons in Dock/Finder.
    #   Baking it here would double-squircle in production.
    #
    # icon_master_1024_rounded.png — squircle mask BAKED IN (transparent corners).
    #   Used by: lib.rs `include_bytes!("../icons/icon_master_1024_rounded.png")`
    #            → NSApplication.setApplicationIconImage (tauri dev mode).
    #   setApplicationIconImage bypasses macOS automatic squircle treatment.
    #   Without baking, the dev-mode dock icon appears as a flat square.
    #   DO NOT overwrite this with the flat master.

    # Save flat master (used for .icns + bundle)
    master.save(ICONS_DIR / "icon_master_1024.png")
    print("Saved icon_master_1024.png")

    # Save rounded master (used by lib.rs programmatic dock icon in dev mode)
    rounded = master.copy()
    mask = make_squircle_mask_fast(1024)
    r, g, b, a = rounded.split()
    from PIL import ImageChops
    new_alpha = ImageChops.multiply(a, mask)
    rounded = Image.merge("RGBA", (r, g, b, new_alpha))
    rounded.save(ICONS_DIR / "icon_master_1024_rounded.png")
    print("Saved icon_master_1024_rounded.png (squircle baked for setApplicationIconImage)")

    # Generate .iconset directory
    iconset_dir = ICONS_DIR / "icon.iconset"
    iconset_dir.mkdir(exist_ok=True)

    # macOS required sizes: name -> pixel size
    iconset_sizes = {
        "icon_16x16.png": 16,
        "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32,
        "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128,
        "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256,
        "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512,
        "icon_512x512@2x.png": 1024,
    }

    for name, px in iconset_sizes.items():
        resized = master.resize((px, px), Image.NEAREST)
        resized.save(iconset_dir / name)
        print(f"  {name} ({px}x{px})")

    # Build .icns with iconutil
    icns_path = ICONS_DIR / "icon.icns"
    print(f"\nBuilding {icns_path}...")
    result = subprocess.run(
        ["iconutil", "-c", "icns", str(iconset_dir), "-o", str(icns_path)],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"ERROR: iconutil failed: {result.stderr}")
        return
    print(f"Built icon.icns ({icns_path.stat().st_size:,} bytes)")

    # Generate Tauri-referenced PNGs (also with squircle mask)
    tauri_sizes = {
        "32x32.png": 32,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon.png": 512,
    }

    print("\nTauri PNGs:")
    for name, px in tauri_sizes.items():
        resized = master.resize((px, px), Image.NEAREST)
        resized.save(ICONS_DIR / name)
        print(f"  {name} ({px}x{px})")

    # Generate .ico for Windows (with squircle mask baked in)
    ico_sizes = [16, 32, 48, 256]
    ico_images = []
    for px in ico_sizes:
        resized = master.resize((px, px), Image.NEAREST)
        ico_images.append(resized)
    ico_images[0].save(ICONS_DIR / "icon.ico", format="ICO", sizes=[(s, s) for s in ico_sizes], append_images=ico_images[1:])
    print(f"  icon.ico ({(ICONS_DIR / 'icon.ico').stat().st_size:,} bytes)")

    # Cleanup iconset directory
    import shutil
    shutil.rmtree(iconset_dir)
    print("\nCleaned up icon.iconset/")
    print("Done! Rebuild the app with `npm run tauri dev` or `cargo tauri build`.")


if __name__ == "__main__":
    build_icons()

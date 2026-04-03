#!/usr/bin/env python3
"""Build macOS .icns + Tauri PNGs from logo.svg with Apple squircle mask."""

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


def build_icons():
    svg_path = ICONS_DIR / "logo.svg"
    if not svg_path.exists():
        print(f"ERROR: {svg_path} not found")
        return

    # Render pixel art at 75% of canvas, centered on 1024x1024 background.
    # macOS Big Sur+ applies a squircle mask that clips ~10% from edges,
    # so content needs padding to avoid being cut off in Dock/Cmd+Tab.
    canvas_size = 1024
    content_size = int(canvas_size * 0.80)  # 816px — leaves ~10% padding per side
    # Round to nearest multiple of 16 so pixel grid stays crisp
    content_size = (content_size // 16) * 16  # 768

    print(f"Rendering SVG at {content_size}x{content_size} (padded to {canvas_size})...")
    content = render_svg_to_image(svg_path, content_size)

    # Center on full canvas with background fill
    bg_color = (24, 24, 24, 255)  # #181818
    master = Image.new("RGBA", (canvas_size, canvas_size), bg_color)
    offset = (canvas_size - content_size) // 2  # 128px padding
    master.paste(content, (offset, offset), content)

    # Fine-tune centering based on actual content bounds
    print("Centering content...")
    master = center_content(master)

    # Do NOT apply squircle mask or border — macOS Big Sur+ applies its own
    # squircle mask to all app icons in Dock and Cmd+Tab. Baking transparency
    # into the .icns bypasses the OS treatment (shadow, highlight border).
    # Full-square icons get the standard macOS squircle automatically.

    # Save master
    master.save(ICONS_DIR / "icon_master_1024.png")
    print("Saved icon_master_1024.png")

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

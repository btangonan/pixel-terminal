# Session Checkpoint — pixel-terminal
**Date**: 2026-03-31
**Commit**: 2c08fcc

## Decisions Made
- Bake squircle corners (22.37% radius) + 100px padding into icon PNG instead of relying on macOS mask
- Programmatic dock icon via cocoa/objc NSApplication.setApplicationIconImage for `tauri dev`
- Sidebar header buttons: borderless, gray (--text-mid, 0.65 opacity), white on hover
- Active session card: white left bar + CSS `outline` (not border) to avoid voice log divider collision
- Active tab border: gray (--border-hi) not white
- Octopus sprite source: octopus-04.2.png (64x16 native frame)

## Fixes Applied
- Octopus sprite base64 was corrupt (broken PNG data stream from bad padding attempt). Regenerated all 4 variants from octopus-04.2.png
- Voice log divider flickering on hover: caused by active card border colliding with adjacent border-top. Fixed by switching to CSS outline

## Progress
- All octopus sprites replaced: base + 3 hue variants (90/180/270)
- App icon rebuilt with rounded corners and macOS-standard padding
- Sidebar UI unified: search icon, plus button, tabs all share borderless style

## Tips & Gotchas Discovered
- CSS `outline` + `outline-offset: -1px` avoids layout collision that `border` causes with adjacent elements
- Sprite base64 corruption: always verify with PIL `.load()` after encoding — header can say valid dimensions while pixel data is broken

## Memories Logged
- 5 new → pixel_terminal
- 1 new → claude_global_knowledge

## Next Session Suggested Start
→ Production PATH fix (get_shell_path() Rust command for packaged .app)

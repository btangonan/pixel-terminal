# STATE.md — Working State (re-read after compaction)
## Updated: 2026-03-28 01:45

### Active Work
- Sprite identity system: round-robin sequencer, 9 animals × 4 hues = 36 combos
- k-whale shifted 1px up (k-whale-shifted.png → SPRITE_DATA, commit 18290a2)
- Per-animal hue subsetting: still pending

### Key IDs
- Collection: pixel_terminal (gemini-memory)
- localStorage key: 'pixel-terminal-identity-seq-v7'
- ANIMALS: ['cat','rabbit','penguin','rat','seal','snake','k-whale','cat2','frog2']
- HUES: [0, 120, 195, 270]

### Decisions This Session
- k-whale sprite shifted 1px up via Pillow paste(src,(0,-1)) on transparent canvas
- frog2 → frog3.png, penguin → penguin2.png (previous commit 911223c)
- All sprites verified byte-exact before commit

### Blockers
- Per-animal hue subsetting not yet implemented

### Last Session Snapshot
Date: 2026-03-28
Open actions:
- [ ] Per-animal hue subsets — context: ANIMAL_HUES map, each animal cycles only its picker-selected hues
Decisions: 46 | Fixes: 37
Next: → implement ANIMAL_HUES map in getNextIdentity()

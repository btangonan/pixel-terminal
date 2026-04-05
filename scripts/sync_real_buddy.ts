#!/usr/bin/env bun
/**
 * sync_real_buddy.ts — Sync pixel-terminal buddy.json from Claude Code account data.
 *
 * Reads ~/.claude.json (soul: name, personality) and computes bones
 * (species, rarity, stats, eyes, hat, shiny) using the exact Claude Code
 * wyhash + Mulberry32 algorithm. Writes merged result to buddy.json.
 *
 * Staleness guard: skips re-roll if buddy.syncedAt matches claude.companion.hatchedAt.
 * Sets buddy.syncedFrom = 'claude-code' so companion.js skips FNV-1a overwrite.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const HOME      = homedir();
const CLAUDE_JSON = join(HOME, '.claude.json');
const BUDDY_PATH  = join(HOME, '.config', 'pixel-terminal', 'buddy.json');
const SALT        = 'friend-2026-401';

// ── Mulberry32 PRNG (exact port of Claude Code's implementation) ──────────────

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Roll tables ───────────────────────────────────────────────────────────────

const RARITIES = [
  { name: 'Common',    weight: 60, floor: 5,  peakMin: 55,  peakMax: 84,  dumpMin: 1,  dumpMax: 19 },
  { name: 'Uncommon',  weight: 25, floor: 15, peakMin: 65,  peakMax: 94,  dumpMin: 5,  dumpMax: 29 },
  { name: 'Rare',      weight: 10, floor: 25, peakMin: 75,  peakMax: 100, dumpMin: 15, dumpMax: 39 },
  { name: 'Epic',      weight: 4,  floor: 35, peakMin: 85,  peakMax: 100, dumpMin: 25, dumpMax: 49 },
  { name: 'Legendary', weight: 1,  floor: 50, peakMin: 100, peakMax: 100, dumpMin: 40, dumpMax: 64 },
];

const SPECIES = [
  'duck','goose','blob','cat','dragon','octopus','owl','penguin',
  'turtle','snail','ghost','axolotl','capybara','cactus','robot',
  'rabbit','mushroom','chonk',
];

const EYES = ['dot','star','x','circle','at','degree'];  // matches EYE_CHARS in ascii-sprites.js
const HATS = ['none','crown','tophat','propeller','halo','wizard','beanie','tinyduck'];  // matches HATS in ascii-sprites.js
const STATS = ['debugging','patience','chaos','wisdom','snark'];

const SPECIES_HUE: Record<string, string> = {
  dragon: '#FF4422', cat: '#FF8844',    rabbit:  '#FFB3BA', penguin: '#88BBFF',
  frog:   '#44FF88', octopus: '#CC44FF', rat:    '#CCAA88', seal:    '#88CCDD',
  snake:  '#44CC44', crab: '#FF6644',   duck:    '#FFDD44', goose:   '#EEDDAA',
  blob:   '#AA88FF', owl:  '#CC9966',   turtle:  '#66AA66', snail:   '#AABB88',
  ghost:  '#DDDDFF', axolotl: '#FFAACC', capybara: '#CCAA77', cactus: '#66BB66',
  robot:  '#88AACC', mushroom: '#CC8877', chonk:  '#BBAACC',
};

// ── Roll bones from UUID ───────────────────────────────────────────────────────

function rollBones(uuid: string) {
  const seed = Number(BigInt(Bun.hash(uuid + SALT)) & 0xFFFFFFFFn) >>> 0;
  const rand = mulberry32(seed);

  // Roll 1: Rarity (weighted)
  const totalWeight = RARITIES.reduce((s, r) => s + r.weight, 0);
  let rarityRoll = rand() * totalWeight;
  let rarity = RARITIES[0];
  for (const r of RARITIES) { rarityRoll -= r.weight; if (rarityRoll <= 0) { rarity = r; break; } }

  // Roll 2: Species (uniform 1/18)
  const species = SPECIES[Math.floor(rand() * SPECIES.length)];

  // Roll 3: Eyes (uniform 1/6)
  const eyes = EYES[Math.floor(rand() * EYES.length)];

  // Roll 4: Hat (Common always none; else 1/8)
  const hat = rarity.name === 'Common' ? 'none' : HATS[Math.floor(rand() * HATS.length)];

  // Roll 5: Shiny (1% independent)
  const shiny = rand() < 0.01;

  // Roll 6+: Stats — peak pick, dump pick, then 5 values
  const peakIdx = Math.floor(rand() * STATS.length);
  let dumpIdx   = Math.floor(rand() * (STATS.length - 1));
  if (dumpIdx >= peakIdx) dumpIdx++;

  const stats: Record<string, number> = {};
  for (let i = 0; i < STATS.length; i++) {
    let raw: number;
    if (i === peakIdx) {
      raw = rarity.peakMin === rarity.peakMax
        ? rarity.peakMin
        : Math.floor(rand() * (rarity.peakMax - rarity.peakMin + 1)) + rarity.peakMin;
    } else if (i === dumpIdx) {
      raw = Math.floor(rand() * (rarity.dumpMax - rarity.dumpMin + 1)) + rarity.dumpMin;
    } else {
      raw = Math.floor(rand() * (100 - rarity.floor + 1)) + rarity.floor;
    }
    // Normalize 0-100 → 1-10
    stats[STATS[i]] = Math.max(1, Math.min(10, Math.round(raw / 10)));
  }

  return { rarity: rarity.name, species, eyes, hat, shiny, stats };
}

// ── Voice derivation (matches generate-buddy.js thresholds) ──────────────────

function deriveVoice(stats: Record<string, number>): string {
  if (stats.snark >= 7)                             return 'sarcastic';
  if (stats.chaos >= 7)                             return 'excitable';
  if (stats.wisdom >= 7 && stats.snark < 5)        return 'measured';
  if (stats.debugging >= 8)                         return 'technical';
  if (stats.patience <= 3)                          return 'impatient';
  return 'default';
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  // Read Claude Code account data
  let claudeData: any;
  try {
    claudeData = JSON.parse(readFileSync(CLAUDE_JSON, 'utf8'));
  } catch {
    console.error('[sync-buddy] ~/.claude.json not found — skipping sync');
    process.exit(0);
  }

  const soul      = claudeData.companion ?? {};
  const uuid      = claudeData.oauthAccount?.accountUuid ?? claudeData.userID ?? 'anon';
  const hatchedAt = soul.hatchedAt ?? 0;

  // Staleness guard — skip re-roll if already synced for this hatch
  let existing: any = {};
  if (existsSync(BUDDY_PATH)) {
    try { existing = JSON.parse(readFileSync(BUDDY_PATH, 'utf8')); } catch { /* fresh file */ }
  }
  if (existing.syncedAt === hatchedAt && existing.syncedFrom === 'claude-code') {
    console.log(`[sync-buddy] up to date — ${existing.name} (${existing.species}, ${existing.rarity})`);
    process.exit(0);
  }

  // Roll bones from UUID
  const bones = rollBones(uuid);
  const voice = deriveVoice(bones.stats);

  // Merge: bones + soul over existing (preserve seed, generated, companionSeed)
  const updated = {
    ...existing,
    name:        soul.name        ?? existing.name ?? 'Buddy',
    personality: soul.personality ?? existing.personality ?? '',
    species:     bones.species,
    rarity:      bones.rarity,
    eyes:        bones.eyes,
    hat:         bones.hat,
    shiny:       bones.shiny,
    stats:       bones.stats,
    voice,
    hue:         SPECIES_HUE[bones.species] ?? existing.hue ?? '#FFFFFF',
    syncedFrom:  'claude-code',
    syncedAt:    hatchedAt,
  };

  writeFileSync(BUDDY_PATH, JSON.stringify(updated, null, 2));
  console.log(`[sync-buddy] synced → ${updated.name} (${updated.species}, ${updated.rarity}, ${updated.voice})`);
}

main();

//! companion.rs — sync_buddy Tauri command
//!
//! Ports sync_real_buddy.ts to Rust. Reads ~/.claude.json, derives buddy bones
//! from the account UUID using wyhash + Mulberry32, and writes buddy.json.
//!
//! Algorithm is identical to sync_real_buddy.ts — changes here must be mirrored there.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

const DEFAULT_SALT: &str = "friend-2026-401";

// ── Zig std.hash.Wyhash (matches Bun.hash exactly) ───────────────────────────
//
// Bun.hash() calls std.hash.Wyhash.hash(0, bytes) from Zig's stdlib.
// This is NOT the standard C wyhash — same secret constants but different
// algorithm structure (especially smallKey read order and final1 loop).
//
// Verified against 6 known Bun.hash() values before generating 1000 test vectors.

const WY_SECRET: [u64; 4] = [
    0xa0761d6478bd642f,
    0xe7037ed1a0b428db,
    0x8ebc6af09c88c6e3,
    0x589965cc75374cc3,
];

#[inline]
fn wy_mum(a: u64, b: u64) -> (u64, u64) {
    let r = (a as u128).wrapping_mul(b as u128);
    (r as u64, (r >> 64) as u64)
}

#[inline]
fn wy_mix(a: u64, b: u64) -> u64 {
    let (lo, hi) = wy_mum(a, b);
    lo ^ hi
}

#[inline]
fn wy_read(data: &[u8], offset: usize, n: usize) -> u64 {
    let mut val = 0u64;
    for i in 0..n {
        val |= (data[offset + i] as u64) << (8 * i);
    }
    val
}

fn zig_wyhash(data: &[u8], seed: u64) -> u64 {
    let n = data.len();
    let state0 = seed ^ wy_mix(seed ^ WY_SECRET[0], WY_SECRET[1]);
    let mut state = [state0, state0, state0];

    let (mut a, mut b) = if n <= 16 {
        // smallKey
        if n >= 4 {
            let end = n - 4;
            let quarter = (n >> 3) << 2;
            let a = (wy_read(data, 0, 4) << 32) | wy_read(data, quarter, 4);
            let b = (wy_read(data, end, 4) << 32) | wy_read(data, end - quarter, 4);
            (a, b)
        } else if n > 0 {
            let a = ((data[0] as u64) << 16)
                  | ((data[n >> 1] as u64) << 8)
                  | (data[n - 1] as u64);
            (a, 0u64)
        } else {
            (0u64, 0u64)
        }
    } else {
        let mut i = 0usize;
        // process full 48-byte blocks if input >= 48
        if n >= 48 {
            while i + 48 < n {
                for j in 0..3 {
                    let ra = wy_read(data, i + 8 * (2 * j),     8);
                    let rb = wy_read(data, i + 8 * (2 * j + 1), 8);
                    state[j] = wy_mix(ra ^ WY_SECRET[j + 1], rb ^ state[j]);
                }
                i += 48;
            }
            // final0
            state[0] ^= state[1] ^ state[2];
        }
        // final1: process 16-byte chunks from i
        let remainder = &data[i..];
        let mut j = 0usize;
        while j + 16 < remainder.len() {
            state[0] = wy_mix(
                wy_read(remainder, j,     8) ^ WY_SECRET[1],
                wy_read(remainder, j + 8, 8) ^ state[0],
            );
            j += 16;
        }
        // last 16 bytes of the full input
        let a = wy_read(data, n - 16, 8);
        let b = wy_read(data, n - 8,  8);
        (a, b)
    };

    // final2
    a ^= WY_SECRET[1];
    b ^= state[0];
    let (a2, b2) = wy_mum(a, b);
    wy_mix(a2 ^ WY_SECRET[0] ^ n as u64, b2 ^ WY_SECRET[1])
}

// ── Roll tables (must stay in sync with sync_real_buddy.ts) ──────────────────

struct Rarity {
    name:     &'static str,
    weight:   u32,
    floor:    i32,
    peak_min: i32,
    peak_max: i32,
    dump_min: i32,
    dump_max: i32,
}

const RARITIES: &[Rarity] = &[
    Rarity { name: "Common",    weight: 60, floor: 5,  peak_min: 55,  peak_max: 84,  dump_min: 1,  dump_max: 19 },
    Rarity { name: "Uncommon",  weight: 25, floor: 15, peak_min: 65,  peak_max: 94,  dump_min: 5,  dump_max: 29 },
    Rarity { name: "Rare",      weight: 10, floor: 25, peak_min: 75,  peak_max: 100, dump_min: 15, dump_max: 39 },
    Rarity { name: "Epic",      weight: 4,  floor: 35, peak_min: 85,  peak_max: 100, dump_min: 25, dump_max: 49 },
    Rarity { name: "Legendary", weight: 1,  floor: 50, peak_min: 100, peak_max: 100, dump_min: 40, dump_max: 64 },
];

const SPECIES: &[&str] = &[
    "duck", "goose", "blob", "cat", "dragon", "octopus", "owl", "penguin",
    "turtle", "snail", "ghost", "axolotl", "capybara", "cactus", "robot",
    "rabbit", "mushroom", "chonk",
];

const EYES: &[&str] = &["dot", "star", "x", "circle", "at", "degree"];
const HATS: &[&str] = &["none", "crown", "tophat", "propeller", "halo", "wizard", "beanie", "tinyduck"];
const STATS: &[&str] = &["debugging", "patience", "chaos", "wisdom", "snark"];

fn species_hue(species: &str) -> &'static str {
    match species {
        "dragon"   => "#FF4422", "cat"      => "#FF8844", "rabbit"   => "#FFB3BA",
        "penguin"  => "#88BBFF", "frog"     => "#44FF88", "octopus"  => "#CC44FF",
        "rat"      => "#CCAA88", "seal"     => "#88CCDD", "snake"    => "#44CC44",
        "crab"     => "#FF6644", "duck"     => "#FFDD44", "goose"    => "#EEDDAA",
        "blob"     => "#AA88FF", "owl"      => "#CC9966", "turtle"   => "#66AA66",
        "snail"    => "#AABB88", "ghost"    => "#DDDDFF", "axolotl"  => "#FFAACC",
        "capybara" => "#CCAA77", "cactus"   => "#66BB66", "robot"    => "#88AACC",
        "mushroom" => "#CC8877", "chonk"    => "#BBAACC",
        _          => "#FFFFFF",
    }
}

// ── Mulberry32 PRNG (exact port of JS implementation) ────────────────────────
//
// JS: `a |= 0; a = (a + 0x6d2b79f5) | 0;` — wrapping i32 arithmetic.
// Rust: use wrapping_add on i32 to match the JS `| 0` truncation behaviour.

struct Mulberry32 {
    a: i32,
}

impl Mulberry32 {
    fn new(seed: u32) -> Self {
        Mulberry32 { a: seed as i32 }
    }

    fn next(&mut self) -> f64 {
        self.a = self.a.wrapping_add(0x6d2b79f5u32 as i32);
        let mut t = (self.a ^ ((self.a as u32 >> 15) as i32)).wrapping_mul(1i32 | self.a);
        t = t.wrapping_add(
            (t ^ ((t as u32 >> 7) as i32)).wrapping_mul(61i32 | t)
        ) ^ t;
        ((t ^ ((t as u32 >> 14) as i32)) as u32) as f64 / 4294967296.0
    }
}

// ── wyhash seed derivation ────────────────────────────────────────────────────
//
// JS: `Number(BigInt(Bun.hash(uuid + SALT)) & 0xFFFFFFFFn) >>> 0`
// Bun.hash() = wyhash with seed 0. Take lower 32 bits.

pub fn wyhash_seed(uuid: &str, salt: &str) -> u32 {
    let input = format!("{}{}", uuid, salt);
    let h = zig_wyhash(input.as_bytes(), 0);
    (h & 0xFFFF_FFFF) as u32
}

// ── Bones ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct Bones {
    pub rarity:  String,
    pub species: String,
    pub eyes:    String,
    pub hat:     String,
    pub shiny:   bool,
    pub stats:   HashMap<String, i32>,
}

pub fn roll_bones(uuid: &str) -> Bones {
    roll_bones_with_salt(uuid, DEFAULT_SALT)
}

pub fn roll_bones_with_salt(uuid: &str, salt: &str) -> Bones {
    let seed = wyhash_seed(uuid, salt);
    let mut rand = Mulberry32::new(seed);

    // Roll 1: Rarity (weighted)
    let total_weight: u32 = RARITIES.iter().map(|r| r.weight).sum();
    let mut rarity_roll = rand.next() * total_weight as f64;
    let mut rarity = &RARITIES[0];
    for r in RARITIES {
        rarity_roll -= r.weight as f64;
        if rarity_roll <= 0.0 {
            rarity = r;
            break;
        }
    }

    // Roll 2: Species (uniform)
    let species = SPECIES[(rand.next() * SPECIES.len() as f64) as usize];

    // Roll 3: Eyes (uniform)
    let eyes = EYES[(rand.next() * EYES.len() as f64) as usize];

    // Roll 4: Hat (Common always none)
    let hat = if rarity.name == "Common" {
        "none"
    } else {
        HATS[(rand.next() * HATS.len() as f64) as usize]
    };

    // Roll 5: Shiny (1%)
    let shiny = rand.next() < 0.01;

    // Roll 6+: Stats
    let peak_idx = (rand.next() * STATS.len() as f64) as usize;
    let mut dump_idx = (rand.next() * (STATS.len() - 1) as f64) as usize;
    if dump_idx >= peak_idx {
        dump_idx += 1;
    }

    let mut stats = HashMap::new();
    for (i, &stat) in STATS.iter().enumerate() {
        let raw = if i == peak_idx {
            if rarity.peak_min == rarity.peak_max {
                rarity.peak_min
            } else {
                (rand.next() * (rarity.peak_max - rarity.peak_min + 1) as f64) as i32 + rarity.peak_min
            }
        } else if i == dump_idx {
            (rand.next() * (rarity.dump_max - rarity.dump_min + 1) as f64) as i32 + rarity.dump_min
        } else {
            (rand.next() * (100 - rarity.floor + 1) as f64) as i32 + rarity.floor
        };
        // Normalize 0-100 → 1-10
        let val = ((raw as f64 / 10.0).round() as i32).max(1).min(10);
        stats.insert(stat.to_string(), val);
    }

    Bones {
        rarity:  rarity.name.to_string(),
        species: species.to_string(),
        eyes:    eyes.to_string(),
        hat:     hat.to_string(),
        shiny,
        stats,
    }
}

// ── Voice derivation ──────────────────────────────────────────────────────────

pub fn derive_voice(stats: &HashMap<String, i32>) -> &'static str {
    let snark     = stats.get("snark").copied().unwrap_or(0);
    let chaos     = stats.get("chaos").copied().unwrap_or(0);
    let wisdom    = stats.get("wisdom").copied().unwrap_or(0);
    let debugging = stats.get("debugging").copied().unwrap_or(0);
    let patience  = stats.get("patience").copied().unwrap_or(10);

    if snark >= 7                        { return "sarcastic"; }
    if chaos >= 7                        { return "excitable"; }
    if wisdom >= 7 && snark < 5         { return "measured"; }
    if debugging >= 8                    { return "technical"; }
    if patience <= 3                     { return "impatient"; }
    "default"
}

// ── Salt generator (no external deps) ────────────────────────────────────────
// Uses fmix64 bit-mixing on nanosecond timestamp for good entropy distribution.

fn generate_salt() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    let a = nanos ^ (nanos >> 33);
    let b = a.wrapping_mul(0xff51_afd7_ed55_8ccd_u64);
    let c = b ^ (b >> 33);
    let d = c.wrapping_mul(0xc4ce_b9fe_1a85_ec53_u64);
    let e = d ^ (d >> 33);
    format!("{:015x}", e & 0x0fff_ffff_ffff_ffff_u64)
}

// ── Shared roll+write logic ───────────────────────────────────────────────────
// Rolls bones with the given salt and soul, writes buddy.json atomically,
// returns the full buddy JSON. Preserves manual fields (ttsEnabled, etc.)
// that live in buddy.json but are not owned by sync.

fn write_buddy_bones(
    home: &str,
    uuid: &str,
    salt: &str,
    soul: &Value,
    hatched_at: i64,
) -> Result<Value, String> {
    let buddy_path = PathBuf::from(home).join(".config/pixel-terminal/buddy.json");

    let bones = roll_bones_with_salt(uuid, salt);
    let voice = derive_voice(&bones.stats);
    let hue   = species_hue(&bones.species).to_string();

    // Load existing buddy.json to preserve manual fields (ttsEnabled, ttsVoice, etc.)
    let mut updated: Value = if buddy_path.exists() {
        fs::read_to_string(&buddy_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Object(Default::default()))
    } else {
        Value::Object(Default::default())
    };

    let obj = updated.as_object_mut().ok_or("buddy.json is not a JSON object")?;

    // Soul fields from claude.json — personality is LLM-generated and precious.
    if let Some(name) = soul.get("name").and_then(|v| v.as_str()) {
        obj.insert("name".to_string(), Value::String(name.to_string()));
    } else if !obj.contains_key("name") {
        obj.insert("name".to_string(), Value::String("Buddy".to_string()));
    }
    if let Some(personality) = soul.get("personality").and_then(|v| v.as_str()) {
        // Always preserve the user's unique LLM-generated personality from Claude Code.
        // The soul is the companion's voice — it may mention a species from a previous
        // hatch, but the character identity is what matters, not species accuracy.
        obj.insert("personality".to_string(), Value::String(personality.to_string()));
    }

    // Rolled bones
    obj.insert("species".to_string(),  Value::String(bones.species));
    obj.insert("rarity".to_string(),   Value::String(bones.rarity));
    obj.insert("eyes".to_string(),     Value::String(bones.eyes));
    obj.insert("hat".to_string(),      Value::String(bones.hat));
    obj.insert("shiny".to_string(),    Value::Bool(bones.shiny));
    obj.insert("stats".to_string(),    serde_json::to_value(&bones.stats).unwrap());
    obj.insert("voice".to_string(),    Value::String(voice.to_string()));
    obj.insert("hue".to_string(),      Value::String(hue));
    obj.insert("companionSeed".to_string(), Value::String(salt.to_string()));
    obj.insert("syncedFrom".to_string(), Value::String("claude-code".to_string()));
    obj.insert("syncedAt".to_string(), Value::Number(hatched_at.into()));

    // Atomic write via temp file
    if let Some(parent) = buddy_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp_path = buddy_path.with_extension("json.tmp");
    let out = serde_json::to_string_pretty(&updated).map_err(|e| e.to_string())?;
    fs::write(&tmp_path, &out).map_err(|e| e.to_string())?;
    fs::rename(&tmp_path, &buddy_path).map_err(|e| e.to_string())?;

    Ok(updated)
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct SyncResult {
    pub status:  String,   // "synced" | "up_to_date" | "no_claude_json"
    pub message: String,
}

#[tauri::command]
pub fn sync_buddy() -> Result<SyncResult, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;

    // Read ~/.claude.json
    let claude_path = PathBuf::from(&home).join(".claude.json");
    let claude_raw = match fs::read_to_string(&claude_path) {
        Ok(s) => s,
        Err(_) => return Ok(SyncResult {
            status:  "no_claude_json".to_string(),
            message: "~/.claude.json not found — skipping sync".to_string(),
        }),
    };
    let claude: Value = serde_json::from_str(&claude_raw)
        .map_err(|e| format!("Failed to parse ~/.claude.json: {}", e))?;

    let soul       = claude.get("companion").cloned().unwrap_or(Value::Object(Default::default()));
    let uuid       = claude.pointer("/oauthAccount/accountUuid")
        .or_else(|| claude.get("userID"))
        .and_then(|v| v.as_str())
        .unwrap_or("anon")
        .to_string();
    let hatched_at = soul.get("hatchedAt").and_then(|v| v.as_i64()).unwrap_or(0);

    // Resolve salt: any-buddy override or default
    let salt = {
        let ab_path = PathBuf::from(&home).join(".claude-code-any-buddy.json");
        fs::read_to_string(&ab_path)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.get("salt").and_then(|s| s.as_str()).map(String::from))
            .unwrap_or_else(|| DEFAULT_SALT.to_string())
    };

    // Staleness guard
    let buddy_path = PathBuf::from(&home).join(".config/pixel-terminal/buddy.json");
    if buddy_path.exists() {
        if let Ok(existing_raw) = fs::read_to_string(&buddy_path) {
            if let Ok(existing) = serde_json::from_str::<Value>(&existing_raw) {
                let synced_at   = existing.get("syncedAt").and_then(|v| v.as_i64()).unwrap_or(-1);
                let synced_from = existing.get("syncedFrom").and_then(|v| v.as_str()).unwrap_or("");
                let existing_salt = existing.get("companionSeed").and_then(|v| v.as_str()).unwrap_or(DEFAULT_SALT);
                // Compare hatchedAt + name + personality + salt — catches re-rolls, renames,
                // personality edits, and any-buddy salt changes
                let existing_name = existing.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let soul_name     = soul.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let existing_pers = existing.get("personality").and_then(|v| v.as_str()).unwrap_or("");
                let soul_pers     = soul.get("personality").and_then(|v| v.as_str()).unwrap_or("");
                if synced_at == hatched_at && synced_from == "claude-code"
                    && existing_salt == salt
                    && (soul_name.is_empty() || existing_name == soul_name)
                    && (soul_pers.is_empty() || existing_pers == soul_pers)
                {
                    let name    = existing.get("name").and_then(|v| v.as_str()).unwrap_or("Buddy");
                    let species = existing.get("species").and_then(|v| v.as_str()).unwrap_or("?");
                    let rarity  = existing.get("rarity").and_then(|v| v.as_str()).unwrap_or("?");
                    return Ok(SyncResult {
                        status:  "up_to_date".to_string(),
                        message: format!("up to date — {} ({}, {})", name, species, rarity),
                    });
                }
            }
        }
    }

    let buddy = write_buddy_bones(&home, &uuid, &salt, &soul, hatched_at)?;
    let name    = buddy.get("name").and_then(|v| v.as_str()).unwrap_or("Buddy");
    let species = buddy.get("species").and_then(|v| v.as_str()).unwrap_or("?");
    let rarity  = buddy.get("rarity").and_then(|v| v.as_str()).unwrap_or("?");
    let voice   = buddy.get("voice").and_then(|v| v.as_str()).unwrap_or("?");

    Ok(SyncResult {
        status:  "synced".to_string(),
        message: format!("synced → {} ({}, {}, {})", name, species, rarity, voice),
    })
}

/// Re-rolls the Oracle's visual identity (species, stats, eyes, hat, shiny, hue, voice)
/// by generating a new random salt. Name and personality (LLM-generated soul) are
/// preserved. The new salt is written to ~/.claude-code-any-buddy.json so it persists
/// across restarts — sync_buddy() will see the salt match on next launch and skip re-sync.
/// Returns the full buddy JSON so the frontend can update the Oracle card immediately.
#[tauri::command]
pub fn reroll_oracle() -> Result<Value, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;

    // Generate new salt and persist it so restarts stay rolled
    let salt = generate_salt();
    let ab_path = PathBuf::from(&home).join(".claude-code-any-buddy.json");
    let ab_json = serde_json::json!({ "salt": &salt });
    fs::write(&ab_path, serde_json::to_string_pretty(&ab_json).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    // Read soul from ~/.claude.json — best-effort, falls back to empty soul
    let (uuid, soul, hatched_at) = {
        let claude_path = PathBuf::from(&home).join(".claude.json");
        match fs::read_to_string(&claude_path)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        {
            Some(claude) => {
                let soul = claude.get("companion").cloned()
                    .unwrap_or(Value::Object(Default::default()));
                let uuid = claude.pointer("/oauthAccount/accountUuid")
                    .or_else(|| claude.get("userID"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("anon")
                    .to_string();
                let hatched_at = soul.get("hatchedAt").and_then(|v| v.as_i64()).unwrap_or(0);
                (uuid, soul, hatched_at)
            }
            None => ("anon".to_string(), Value::Object(Default::default()), 0),
        }
    };

    write_buddy_bones(&home, &uuid, &salt, &soul, hatched_at)
}


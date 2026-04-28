// models_manifest.rs — versioned catalogue of model artifacts.
//
// The bootstrap state machine (`commands/model_bootstrap.rs`) consults
// this manifest at start-up to know what to download, where to put it,
// and which SHA-256 proves integrity. Extending to a new model is a
// one-entry addition here plus a path hookup in `model_bootstrap.rs`.

use serde::{Deserialize, Serialize};

pub const MOONSHINE_MODEL_ID: &str = "moonshine_onnx";
pub const QWEN3_TTS_MODEL_ID: &str = "qwen3_tts_mlx";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelEntry {
    pub id: String,
    pub version: String,
    pub cdn_url: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub cache_subdir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelsManifest {
    pub version: u32,
    pub entries: Vec<ModelEntry>,
}

impl ModelsManifest {
    pub fn bundled() -> Self {
        // Versions + SHA sums are placeholders for the scaffolding PR.
        // PR-A / PR-B replace these with real CDN URLs and pinned digests
        // before the probes go live.
        Self {
            version: 1,
            entries: vec![
                ModelEntry {
                    id: MOONSHINE_MODEL_ID.into(),
                    version: "0.1.0-pending".into(),
                    cdn_url: "https://models.pixel-terminal.local/moonshine_onnx/0.1.0.tar.gz"
                        .into(),
                    sha256: "0".repeat(64),
                    size_bytes: 31 * 1024 * 1024,
                    cache_subdir: "moonshine_onnx".into(),
                },
                ModelEntry {
                    id: QWEN3_TTS_MODEL_ID.into(),
                    version: "0.1.0-pending".into(),
                    cdn_url: "https://models.pixel-terminal.local/qwen3_tts_mlx/0.1.0.tar.gz"
                        .into(),
                    sha256: "0".repeat(64),
                    size_bytes: 1_280 * 1024 * 1024,
                    cache_subdir: "qwen3_tts_mlx".into(),
                },
            ],
        }
    }

    pub fn find(&self, id: &str) -> Option<&ModelEntry> {
        self.entries.iter().find(|e| e.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_contains_both_models() {
        let m = ModelsManifest::bundled();
        assert!(m.find(MOONSHINE_MODEL_ID).is_some());
        assert!(m.find(QWEN3_TTS_MODEL_ID).is_some());
    }

    #[test]
    fn find_returns_none_for_unknown_id() {
        let m = ModelsManifest::bundled();
        assert!(m.find("totally_made_up").is_none());
    }

    #[test]
    fn sha256_placeholders_are_64_hex_chars() {
        for e in ModelsManifest::bundled().entries {
            assert_eq!(e.sha256.len(), 64, "sha256 must be 64 hex chars");
        }
    }

    #[test]
    fn roundtrip_through_serde() {
        let m = ModelsManifest::bundled();
        let s = serde_json::to_string(&m).expect("serialize");
        let back: ModelsManifest = serde_json::from_str(&s).expect("deserialize");
        assert_eq!(back.entries.len(), m.entries.len());
    }
}

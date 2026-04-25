// host_check.rs — Apple-Silicon macOS 14+ precondition gate.
//
// Returns a HostCheckReport that the frontend consults on startup:
//   - supported == true  → voice panel enabled
//   - supported == false → banner + hard disable (see docs/unsupported-hosts.md)
//
// arm64 macOS runs real probes (uname, sw_vers, mlx+onnxruntime version
// sniff via `python3 -c`). Other targets short-circuit to unsupported
// with a reason string so non-Mac CI stays green on the mocked lane.

use serde::{Deserialize, Serialize};

pub const MIN_MACOS_MAJOR: u32 = 14;
pub const MIN_MLX_VERSION: &str = "0.15";
pub const MIN_ONNXRUNTIME_VERSION: &str = "1.17";
pub const MIN_FREE_DISK_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2 GB

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HostCheckReport {
    pub supported: bool,
    pub arch: String,
    pub os: String,
    pub os_version: Option<String>,
    pub mlx_version: Option<String>,
    pub onnxruntime_version: Option<String>,
    pub disk_free_bytes: Option<u64>,
    pub failure_reason: Option<String>,
}

impl HostCheckReport {
    pub fn unsupported(reason: impl Into<String>, arch: &str, os: &str) -> Self {
        Self {
            supported: false,
            arch: arch.into(),
            os: os.into(),
            os_version: None,
            mlx_version: None,
            onnxruntime_version: None,
            disk_free_bytes: None,
            failure_reason: Some(reason.into()),
        }
    }
}

// Semantic version compare — lossy but good enough for MIN_* threshold
// checks. Treats non-numeric components as 0 and truncates to 3 parts.
pub fn semver_gte(got: &str, min: &str) -> bool {
    fn parts(s: &str) -> [u32; 3] {
        let mut out = [0u32; 3];
        for (i, seg) in s.split('.').take(3).enumerate() {
            out[i] = seg
                .split(|c: char| !c.is_ascii_digit())
                .next()
                .and_then(|p| p.parse().ok())
                .unwrap_or(0);
        }
        out
    }
    parts(got) >= parts(min)
}

// Test-facing input shape — real probes populate this via sys calls on
// arm64; mocked lane feeds a crafted struct to exercise each branch.
#[derive(Debug, Clone)]
pub struct ProbeInputs {
    pub arch: String,
    pub os: String,
    pub os_version: Option<String>,
    pub mlx_version: Option<String>,
    pub onnxruntime_version: Option<String>,
    pub disk_free_bytes: Option<u64>,
}

pub fn evaluate(inputs: &ProbeInputs) -> HostCheckReport {
    if inputs.arch != "aarch64" && inputs.arch != "arm64" {
        return HostCheckReport::unsupported(
            format!("voice requires arm64; got {}", inputs.arch),
            &inputs.arch,
            &inputs.os,
        );
    }
    if inputs.os != "macos" {
        return HostCheckReport::unsupported(
            format!("voice requires macOS; got {}", inputs.os),
            &inputs.arch,
            &inputs.os,
        );
    }

    let macos_ok = inputs
        .os_version
        .as_deref()
        .and_then(|v| v.split('.').next())
        .and_then(|maj| maj.parse::<u32>().ok())
        .map(|m| m >= MIN_MACOS_MAJOR)
        .unwrap_or(false);
    if !macos_ok {
        return HostCheckReport {
            supported: false,
            arch: inputs.arch.clone(),
            os: inputs.os.clone(),
            os_version: inputs.os_version.clone(),
            mlx_version: inputs.mlx_version.clone(),
            onnxruntime_version: inputs.onnxruntime_version.clone(),
            disk_free_bytes: inputs.disk_free_bytes,
            failure_reason: Some(format!(
                "voice requires macOS {}+; got {:?}",
                MIN_MACOS_MAJOR, inputs.os_version
            )),
        };
    }

    if let Some(mlx) = inputs.mlx_version.as_deref() {
        if !semver_gte(mlx, MIN_MLX_VERSION) {
            return HostCheckReport {
                supported: false,
                arch: inputs.arch.clone(),
                os: inputs.os.clone(),
                os_version: inputs.os_version.clone(),
                mlx_version: inputs.mlx_version.clone(),
                onnxruntime_version: inputs.onnxruntime_version.clone(),
                disk_free_bytes: inputs.disk_free_bytes,
                failure_reason: Some(format!(
                    "voice requires MLX >= {}; got {}",
                    MIN_MLX_VERSION, mlx
                )),
            };
        }
    } else {
        return HostCheckReport {
            supported: false,
            arch: inputs.arch.clone(),
            os: inputs.os.clone(),
            os_version: inputs.os_version.clone(),
            mlx_version: None,
            onnxruntime_version: inputs.onnxruntime_version.clone(),
            disk_free_bytes: inputs.disk_free_bytes,
            failure_reason: Some("MLX not installed (pip install mlx)".into()),
        };
    }

    if let Some(onnx) = inputs.onnxruntime_version.as_deref() {
        if !semver_gte(onnx, MIN_ONNXRUNTIME_VERSION) {
            return HostCheckReport {
                supported: false,
                arch: inputs.arch.clone(),
                os: inputs.os.clone(),
                os_version: inputs.os_version.clone(),
                mlx_version: inputs.mlx_version.clone(),
                onnxruntime_version: inputs.onnxruntime_version.clone(),
                disk_free_bytes: inputs.disk_free_bytes,
                failure_reason: Some(format!(
                    "voice requires onnxruntime >= {}; got {}",
                    MIN_ONNXRUNTIME_VERSION, onnx
                )),
            };
        }
    } else {
        return HostCheckReport {
            supported: false,
            arch: inputs.arch.clone(),
            os: inputs.os.clone(),
            os_version: inputs.os_version.clone(),
            mlx_version: inputs.mlx_version.clone(),
            onnxruntime_version: None,
            disk_free_bytes: inputs.disk_free_bytes,
            failure_reason: Some("onnxruntime not installed (pip install onnxruntime)".into()),
        };
    }

    if let Some(disk) = inputs.disk_free_bytes {
        if disk < MIN_FREE_DISK_BYTES {
            return HostCheckReport {
                supported: false,
                arch: inputs.arch.clone(),
                os: inputs.os.clone(),
                os_version: inputs.os_version.clone(),
                mlx_version: inputs.mlx_version.clone(),
                onnxruntime_version: inputs.onnxruntime_version.clone(),
                disk_free_bytes: Some(disk),
                failure_reason: Some(format!(
                    "voice requires >= 2 GB free; have {} bytes",
                    disk
                )),
            };
        }
    }

    HostCheckReport {
        supported: true,
        arch: inputs.arch.clone(),
        os: inputs.os.clone(),
        os_version: inputs.os_version.clone(),
        mlx_version: inputs.mlx_version.clone(),
        onnxruntime_version: inputs.onnxruntime_version.clone(),
        disk_free_bytes: inputs.disk_free_bytes,
        failure_reason: None,
    }
}

// ── Real probes (arm64 macOS only) ─────────────────────────────────────
//
// Shells out to minimal system commands + python3 to sniff versions.
// Keeping these gated on target_arch prevents the mocked CI lane from
// accidentally trying to import MLX on an Intel runner.

#[cfg(all(target_arch = "aarch64", target_os = "macos"))]
pub fn probe_real() -> HostCheckReport {
    use std::process::Command;

    fn py_version(pkg: &str) -> Option<String> {
        let out = Command::new("python3")
            .args([
                "-c",
                &format!(
                    "import importlib, sys; \
                     m=importlib.import_module('{}'); \
                     v=getattr(m, '__version__', None); \
                     print(v if v else '0.0.0')",
                    pkg
                ),
            ])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8(out.stdout).ok()?;
        let v = s.trim().to_string();
        if v.is_empty() || v == "0.0.0" {
            None
        } else {
            Some(v)
        }
    }

    fn macos_version() -> Option<String> {
        let out = Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        Some(String::from_utf8(out.stdout).ok()?.trim().to_string())
    }

    fn disk_free_bytes(path: &str) -> Option<u64> {
        let out = Command::new("df")
            .args(["-k", path])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8(out.stdout).ok()?;
        // second line, 4th column = available 1K blocks
        let line = text.lines().nth(1)?;
        let col = line.split_whitespace().nth(3)?;
        col.parse::<u64>().ok().map(|kb| kb * 1024)
    }

    let inputs = ProbeInputs {
        arch: "arm64".into(),
        os: "macos".into(),
        os_version: macos_version(),
        mlx_version: py_version("mlx"),
        onnxruntime_version: py_version("onnxruntime"),
        disk_free_bytes: disk_free_bytes("/"),
    };
    evaluate(&inputs)
}

#[cfg(not(all(target_arch = "aarch64", target_os = "macos")))]
pub fn probe_real() -> HostCheckReport {
    HostCheckReport::unsupported(
        "voice pipeline runs arm64 macOS only; this build target is unsupported",
        std::env::consts::ARCH,
        std::env::consts::OS,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn baseline_inputs() -> ProbeInputs {
        ProbeInputs {
            arch: "arm64".into(),
            os: "macos".into(),
            os_version: Some("14.4".into()),
            mlx_version: Some("0.15.2".into()),
            onnxruntime_version: Some("1.17.0".into()),
            disk_free_bytes: Some(10 * 1024 * 1024 * 1024),
        }
    }

    #[test]
    fn semver_gte_handles_trailing_tags() {
        assert!(semver_gte("0.15.0", "0.15"));
        assert!(semver_gte("0.16.0", "0.15"));
        assert!(semver_gte("1.17.0", "1.17"));
        assert!(!semver_gte("0.14.99", "0.15"));
        assert!(semver_gte("1.17.1-rc1", "1.17"));
    }

    #[test]
    fn baseline_passes() {
        let r = evaluate(&baseline_inputs());
        assert!(r.supported, "{:?}", r);
        assert!(r.failure_reason.is_none());
    }

    #[test]
    fn mocked_unsupported_arch() {
        let mut i = baseline_inputs();
        i.arch = "x86_64".into();
        let r = evaluate(&i);
        assert!(!r.supported);
        assert!(r.failure_reason.as_ref().unwrap().contains("arm64"));
    }

    #[test]
    fn mocked_unsupported_os() {
        let mut i = baseline_inputs();
        i.os = "linux".into();
        let r = evaluate(&i);
        assert!(!r.supported);
        assert!(r.failure_reason.as_ref().unwrap().contains("macOS"));
    }

    #[test]
    fn mocked_old_macos_rejected() {
        let mut i = baseline_inputs();
        i.os_version = Some("13.5".into());
        let r = evaluate(&i);
        assert!(!r.supported);
        assert!(r.failure_reason.as_ref().unwrap().contains("macOS"));
    }

    #[test]
    fn mocked_missing_mlx_rejected() {
        let mut i = baseline_inputs();
        i.mlx_version = None;
        let r = evaluate(&i);
        assert!(!r.supported);
        assert!(r.failure_reason.as_ref().unwrap().contains("MLX"));
    }

    #[test]
    fn mocked_old_mlx_rejected() {
        let mut i = baseline_inputs();
        i.mlx_version = Some("0.14.9".into());
        let r = evaluate(&i);
        assert!(!r.supported);
        assert!(r.failure_reason.as_ref().unwrap().contains("MLX"));
    }

    #[test]
    fn mocked_missing_onnxruntime_rejected() {
        let mut i = baseline_inputs();
        i.onnxruntime_version = None;
        let r = evaluate(&i);
        assert!(!r.supported);
        assert!(r
            .failure_reason
            .as_ref()
            .unwrap()
            .contains("onnxruntime"));
    }

    #[test]
    fn mocked_old_onnxruntime_rejected() {
        let mut i = baseline_inputs();
        i.onnxruntime_version = Some("1.16.0".into());
        let r = evaluate(&i);
        assert!(!r.supported);
        assert!(r
            .failure_reason
            .as_ref()
            .unwrap()
            .contains("onnxruntime"));
    }

    #[test]
    fn mocked_insufficient_disk_rejected() {
        let mut i = baseline_inputs();
        i.disk_free_bytes = Some(100 * 1024 * 1024); // 100 MB
        let r = evaluate(&i);
        assert!(!r.supported);
        assert!(r.failure_reason.as_ref().unwrap().contains("2 GB"));
    }

    #[test]
    fn unsupported_helper_roundtrips() {
        let r = HostCheckReport::unsupported("mock reason", "arm64", "macos");
        assert!(!r.supported);
        assert_eq!(r.failure_reason.as_deref(), Some("mock reason"));
        let s = serde_json::to_string(&r).expect("serialize");
        let back: HostCheckReport = serde_json::from_str(&s).expect("deserialize");
        assert_eq!(back.failure_reason.as_deref(), Some("mock reason"));
    }
}

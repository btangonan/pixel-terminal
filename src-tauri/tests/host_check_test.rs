// Integration test for host_check — asserts the public contract the
// frontend and the onboarding wizard depend on.
//
// cfg-split:
//   - aarch64 targets run the real probe (macOS-only code path)
//   - everything else runs mocked fixtures so ubuntu-latest CI stays green

use pixel_terminal_lib::commands::host_check::{
    self, HostCheckReport, ProbeInputs, MIN_MACOS_MAJOR, MIN_MLX_VERSION, MIN_ONNXRUNTIME_VERSION,
};

#[test]
fn public_constants_are_documented_in_spec() {
    // Paranoia against silent constant drift. These match the values in
    // docs/unsupported-hosts.md and acceptance.yaml.
    assert_eq!(MIN_MACOS_MAJOR, 14);
    assert_eq!(MIN_MLX_VERSION, "0.15");
    assert_eq!(MIN_ONNXRUNTIME_VERSION, "1.17");
}

#[test]
fn report_serializes_to_stable_shape() {
    let r = HostCheckReport::unsupported("x", "arm64", "macos");
    let s = serde_json::to_string(&r).expect("serialize");
    // Frontend relies on these field names.
    assert!(s.contains("\"supported\""));
    assert!(s.contains("\"failure_reason\""));
    assert!(s.contains("\"arch\""));
}

#[cfg(all(target_arch = "aarch64", target_os = "macos"))]
#[test]
fn real_probe_arm64() {
    // On the native CI lane (macos-14) this exercises the actual system
    // probes. We cannot assert `supported == true` universally because
    // the runner may be missing MLX or onnxruntime — we DO assert the
    // report is structurally valid and arch/OS reported truthfully.
    let r = host_check::probe_real();
    assert_eq!(r.arch, "arm64");
    assert_eq!(r.os, "macos");
    if !r.supported {
        // Every unsupported path must carry a human-readable reason.
        assert!(
            r.failure_reason.is_some(),
            "unsupported report missing failure_reason: {:?}",
            r
        );
    }
}

#[cfg(not(all(target_arch = "aarch64", target_os = "macos")))]
#[test]
fn mocked_probe_reports_unsupported() {
    // On the mocked lane (ubuntu-latest or Intel Mac), probe_real short-
    // circuits and returns an unsupported report without shelling out.
    let r = host_check::probe_real();
    assert!(!r.supported, "expected unsupported on non-arm64 target");
    assert!(r.failure_reason.is_some());
}

#[test]
fn mocked_evaluate_rejects_each_failure_mode() {
    // A compact integration check that evaluate() honors each rejection
    // reason when given crafted inputs.
    let base = ProbeInputs {
        arch: "arm64".into(),
        os: "macos".into(),
        os_version: Some("14.0".into()),
        mlx_version: Some("0.15.0".into()),
        onnxruntime_version: Some("1.17.0".into()),
        disk_free_bytes: Some(10 * 1024 * 1024 * 1024),
    };

    // Baseline passes
    assert!(host_check::evaluate(&base).supported);

    // Each failure mode flips supported=false + sets failure_reason
    let mut bad = base.clone();
    bad.arch = "x86_64".into();
    let r = host_check::evaluate(&bad);
    assert!(!r.supported);
    assert!(r.failure_reason.is_some());

    let mut bad = base.clone();
    bad.os_version = Some("13.9".into());
    assert!(!host_check::evaluate(&bad).supported);

    let mut bad = base.clone();
    bad.mlx_version = None;
    assert!(!host_check::evaluate(&bad).supported);

    let mut bad = base.clone();
    bad.onnxruntime_version = Some("1.16.0".into());
    assert!(!host_check::evaluate(&bad).supported);

    let mut bad = base.clone();
    bad.disk_free_bytes = Some(100 * 1024 * 1024);
    assert!(!host_check::evaluate(&bad).supported);
}

// clippy complains about needless clone in the test above, but the
// ergonomics win out for readability.

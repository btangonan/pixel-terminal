import { describe, it } from 'vitest';

/*
 * TODO: Install and wire tauri-driver before enabling these.
 * Required setup:
 * - cargo install tauri-driver
 * - add a CI job that builds the Tauri app bundle before this suite
 * - add a WebDriver client dependency such as webdriverio
 * - launch tauri-driver on a random port and point the client at the built app
 */

describe('WKWebView user-facing flows', () => {
  it.skip('real keyboard push-to-talk sends ptt_start and ptt_release through OS event injection', 'REASON: tauri-driver not installed in this pass');

  it.skip('oracle card and pre-chat input remain visible after WKWebView layout and paint', 'REASON: tauri-driver not installed in this pass');

  it.skip('multi-window focus restoration after macOS folder picker returns to live session tab', 'REASON: tauri-driver not installed in this pass');

  it.skip('permission prompts and degraded-mode banners are visible in the rendered webview', 'REASON: tauri-driver not installed in this pass');
});

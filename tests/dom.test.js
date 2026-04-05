import { beforeEach, test, expect } from 'vitest';

// Mock window.marked and window.DOMPurify before importing dom.js
// (module scope no longer touches these — deferred to mdParse() call)
beforeEach(() => {
  global.window.marked = {
    setOptions: () => {},
    parse: (text) => text, // pass-through; DOMPurify does the sanitizing
  };
  global.window.DOMPurify = {
    sanitize: (html) =>
      html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ''),
  };
});

// Dynamic import inside tests — ensures mocks are in place before module executes
async function getDom() {
  // Reset module cache so each test group gets a fresh import with the mock globals
  return import('../src/dom.js?t=' + Date.now());
}

test('mdParse strips <script> tags from LLM output', async () => {
  const { mdParse } = await getDom();
  const result = mdParse('<script>alert(1)</script>hello');
  expect(result).not.toContain('<script>');
  expect(result).toContain('hello');
});

test('esc() escapes HTML special chars', async () => {
  const { esc } = await getDom();
  expect(esc('<b>&"')).toBe('&lt;b&gt;&amp;&quot;');
});

test('esc(null) does not throw', async () => {
  const { esc } = await getDom();
  expect(() => esc(null)).not.toThrow();
  expect(esc(null)).toBe('');
});

test('toolHint extracts file_path basename', async () => {
  const { toolHint } = await getDom();
  expect(toolHint('Read', '{"file_path":"/foo/bar.js"}')).toBe('bar.js');
});

test('toolHint extracts query_texts[0]', async () => {
  const { toolHint } = await getDom();
  expect(toolHint('memory_query', '{"query_texts":["security hardening"]}')).toBe('security hardening');
});

test('toolHint returns truncated string on non-JSON', async () => {
  const { toolHint } = await getDom();
  expect(toolHint('x', 'not json')).toBe('not json');
});

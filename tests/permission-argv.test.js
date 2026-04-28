// Exercises: /Users/bradleytangonan/Projects/pixel-terminal/src/permission-args.js
// Failure trigger: permission-mode default resolves to bypassPermissions or any other permission bypass flag.
// Mocked boundaries (only): none

import { test, expect } from 'vitest';
import { buildPermissionModeArgs } from '../src/permission-args.js';

test("permission-mode default does not launch with bypassPermissions", () => {
  const { args, spawnMode } = buildPermissionModeArgs('default');

  expect(spawnMode).toBe('default');
  expect(args).toContain('--permission-mode');
  expect(args).toContain('default');
  expect(args).not.toContain('bypassPermissions');
  expect(args).not.toContain('--dangerously-skip-permissions');
});

test("unknown permission mode fails closed to default", () => {
  const { args, spawnMode } = buildPermissionModeArgs('surprise-me');

  expect(spawnMode).toBe('default');
  expect(args).toEqual(['--permission-mode', 'default']);
  expect(args).not.toContain('bypassPermissions');
  expect(args).not.toContain('--dangerously-skip-permissions');
});

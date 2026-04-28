export function buildPermissionModeArgs(permissionMode) {
  const mode = String(permissionMode || 'default').toLowerCase();
  if (mode === 'bypass') {
    return { args: ['--permission-mode', 'bypassPermissions'], spawnMode: 'bypass' };
  }
  return { args: ['--permission-mode', 'default'], spawnMode: 'default' };
}

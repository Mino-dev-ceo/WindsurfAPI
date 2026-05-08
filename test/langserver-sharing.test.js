import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function probeMode(extraEnv = {}) {
  const script = `
    import { isPerAccountLanguageServerMode } from './src/langserver.js';
    process.stdout.write(String(isPerAccountLanguageServerMode()));
  `;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
  });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim();
}

describe('language server sharing mode', () => {
  it('defaults to shared LS instances per proxy', () => {
    assert.equal(probeMode(), 'false');
  });

  it('can opt back into per-account LS mode with WINDSURFAPI_PER_ACCOUNT_LS=1', () => {
    assert.equal(probeMode({ WINDSURFAPI_PER_ACCOUNT_LS: '1' }), 'true');
  });
});

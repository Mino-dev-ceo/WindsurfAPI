import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLIENT_JS = readFileSync(`${ROOT}/src/client.js`, 'utf8');
const LANGSERVER_JS = readFileSync(`${ROOT}/src/langserver.js`, 'utf8');

describe('shared LS account session isolation', () => {
  it('uses account-scoped LS state for session/workspace init', () => {
    assert.match(LANGSERVER_JS, /export function getLsAccountStateByPort\(port, apiKey\)/);
    assert.match(CLIENT_JS, /getLsAccountStateByPort\(this\.port, this\.apiKey\)/);
    assert.match(CLIENT_JS, /lsState\.workspaceInit/);
    assert.match(CLIENT_JS, /lsState\.sessionId/);
  });
});

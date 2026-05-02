import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '..', 'src', 'server.js'), 'utf8');

describe('Anthropic/OpenAI signature headers', () => {
  it('uses provider-shaped request ids and echoes anthropic-version', () => {
    assert.match(src, /function makeProviderRequestId\(\)\s*\{\s*return 'req_'/);
    assert.match(src, /'request-id':\s*makeProviderRequestId\(\)/);
    assert.match(src, /'x-request-id':\s*makeProviderRequestId\(\)/);
    assert.match(src, /'anthropic-version':\s*String\(req\.headers\['anthropic-version'\] \|\| '2023-06-01'\)/);
    assert.match(src, /'anthropic-organization-id':\s*makeSyntheticOrgId\(reqToken\)/);
  });
});

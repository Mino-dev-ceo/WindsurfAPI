import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const src = readFileSync(join(root, 'src/handlers/chat.js'), 'utf8');

test('non-stream cache lookup is bypassed for thinking requests', () => {
  assert.match(
    src,
    /const cached = !wantThinking \? cacheGet\(ckey\) : null;/,
    'thinking requests should skip non-stream cache replays so stale no-thinking results do not get replayed',
  );
});

test('stream cache lookup is bypassed for thinking requests', () => {
  const matches = src.match(/const cached = !wantThinking \? cacheGet\(ckey\) : null;/g) || [];
  assert.ok(
    matches.length >= 2,
    'thinking requests should skip stream cache replays as well as non-stream ones',
  );
});

test('streamResponse binds wantThinking from deps before using it', () => {
  assert.match(
    src,
    /function streamResponse\([\s\S]*?const wantThinking = !!deps\.wantThinking;[\s\S]*?const cached = !wantThinking \? cacheGet\(ckey\) : null;/m,
    'streamResponse must bind wantThinking from deps before using it in cache bypass logic',
  );
});

test('thinking requests are not written into the response cache', () => {
  assert.match(
    src,
    /if \(!wantThinking && ckey && !toolCalls\.length\) cacheSet\(ckey, \{ text: allText, thinking: allThinking \}\);/,
    'non-stream thinking requests should not write stale reasoning-free responses into cache',
  );
  assert.match(
    src,
    /if \(!wantThinking && ckey && !collectedToolCalls\.length && \(accText \|\| accThinking\)\) \{\s*cacheSet\(ckey, \{ text: accText, thinking: accThinking \}\);/m,
    'stream thinking requests should not write stale reasoning-free responses into cache',
  );
});

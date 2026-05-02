import test from 'node:test';
import assert from 'node:assert/strict';
import { applyThinkingChannelHint } from '../src/handlers/chat.js';

test('applyThinkingChannelHint prepends a system hint when reasoning is requested', () => {
  const msgs = [{ role: 'user', content: 'hi' }];
  const out = applyThinkingChannelHint(msgs, true);
  assert.equal(out[0].role, 'system');
  assert.match(out[0].content, /separate thinking\/reasoning channel/i);
  assert.deepEqual(out[1], msgs[0]);
});

test('applyThinkingChannelHint folds into the existing first system message', () => {
  const msgs = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'hi' },
  ];
  const out = applyThinkingChannelHint(msgs, true);
  assert.equal(out.length, 2);
  assert.match(out[0].content, /Keep the final visible answer concise/i);
  assert.match(out[0].content, /You are helpful\./);
});

test('applyThinkingChannelHint is a no-op when reasoning is disabled', () => {
  const msgs = [{ role: 'user', content: 'hi' }];
  assert.deepEqual(applyThinkingChannelHint(msgs, false), msgs);
});

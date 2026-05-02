import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { humanizeModelName, providerForModelName } from '../src/model-identity.js';

describe('model identity helpers', () => {
  it('humanizes common model slugs into branded names', () => {
    assert.equal(humanizeModelName('claude-opus-4-7'), 'Claude Opus 4.7');
    assert.equal(humanizeModelName('claude-opus-4.6-thinking'), 'Claude Opus 4.6 Thinking');
    assert.equal(humanizeModelName('gpt-5.2-high'), 'GPT-5.2 High');
  });

  it('maps provider names for known model families', () => {
    assert.equal(providerForModelName('claude-opus-4.6'), 'Anthropic');
    assert.equal(providerForModelName('gpt-5.2-high'), 'OpenAI');
    assert.equal(providerForModelName('mystery-model'), '');
  });
});

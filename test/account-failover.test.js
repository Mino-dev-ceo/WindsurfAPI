import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldFailoverStrictReuse,
  smartAccountAttemptLimit,
} from '../src/handlers/chat.js';

describe('smart account failover', () => {
  it('caps default failover so one request cannot burn the whole pool', () => {
    assert.equal(smartAccountAttemptLimit(28, 0), 8);
    assert.equal(smartAccountAttemptLimit(5, 0), 5);
    assert.equal(smartAccountAttemptLimit(1, 0), 1);
  });

  it('honours an explicit attempt cap without exceeding the pool size', () => {
    assert.equal(smartAccountAttemptLimit(28, 10), 10);
    assert.equal(smartAccountAttemptLimit(5, 20), 5);
  });

  it('falls over strict reuse before any streaming content is emitted', () => {
    assert.equal(shouldFailoverStrictReuse({ strictReuse: true, enabled: true }), true);
    assert.equal(shouldFailoverStrictReuse({ strictReuse: true, hadSuccess: true, enabled: true }), false);
    assert.equal(shouldFailoverStrictReuse({ strictReuse: false, enabled: true }), false);
    assert.equal(shouldFailoverStrictReuse({ strictReuse: true, enabled: false }), false);
  });
});

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey,
  getAccountList,
  getApiKey,
  getRpmStats,
  markRateLimited,
  releaseAccount,
  removeAccount,
  setAccountTier,
} from '../src/auth.js';
import { handleChatCompletions, rateLimitCooldownMs } from '../src/handlers/chat.js';
import { getStats } from '../src/dashboard/stats.js';
import { getExperimental, setExperimental } from '../src/runtime-config.js';

const createdAccountIds = [];
const originalExperimental = getExperimental();

function addTestAccount(label = 'test-account') {
  const account = addAccountByKey(`test-key-${Date.now()}-${Math.random().toString(36).slice(2)}`, label);
  createdAccountIds.push(account.id);
  return account;
}

afterEach(() => {
  setExperimental(originalExperimental);
  while (createdAccountIds.length) {
    removeAccount(createdAccountIds.pop());
  }
});

describe('rate-limit handling', () => {
  it('does not poison local cooldowns when preflight has no retryAfter hint', async () => {
    const account = addTestAccount('preflight-no-hint');
    let checks = 0;
    setExperimental({ preflightRateLimit: true });

    const request = {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const context = {
      async checkMessageRateLimit() {
        checks++;
        return { hasCapacity: false, messagesRemaining: 0, maxMessages: 1, retryAfterMs: null };
      },
      async waitForAccount(tried, signal, maxWaitMs, modelKey) {
        return tried.length === 0 ? getApiKey(tried, modelKey) : null;
      },
    };

    const first = await handleChatCompletions(request, context);
    const second = await handleChatCompletions(request, context);
    const listed = getAccountList().find(a => a.id === account.id);

    assert.equal(first.status, 503);
    assert.equal(second.status, 503);
    assert.equal(checks, 2);
    assert.deepEqual(listed.modelRateLimits, {});
  });

  it('parses explicit retry-after seconds instead of defaulting to five minutes', () => {
    assert.equal(rateLimitCooldownMs('Please retry after 117 seconds'), 117000);
    assert.equal(rateLimitCooldownMs('quota hit'), 60000);
  });

  it('parses Cascade reset windows into real model cooldowns', () => {
    assert.equal(
      rateLimitCooldownMs('Reached message rate limit for this model. Please try again later. Resets in: 2h59m58s (trace ID: abc)'),
      (2 * 60 * 60 * 1000) + (59 * 60 * 1000) + (58 * 1000)
    );
    assert.equal(rateLimitCooldownMs('Resets in: 59s'), 59000);
    assert.equal(rateLimitCooldownMs('resets in 3h'), 3 * 60 * 60 * 1000);
  });

  it('does not extend an existing cooldown when a later 429 arrives for the same model', async () => {
    const account = addTestAccount('max-extend');
    const modelKey = 'gemini-2.5-flash';

    markRateLimited(account.apiKey, 2000, modelKey);
    const firstUntil = getAccountList().find(a => a.id === account.id).modelRateLimits[modelKey];
    await new Promise(resolve => setTimeout(resolve, 250));
    markRateLimited(account.apiKey, 1750, modelKey);
    const secondUntil = getAccountList().find(a => a.id === account.id).modelRateLimits[modelKey];

    assert.ok(secondUntil >= firstUntil);
    assert.ok(secondUntil - firstUntil < 120, `expected max-extend semantics, got delta ${secondUntil - firstUntil}ms`);
  });

  it('surfaces real model cooldown expiries in account list state', () => {
    const account = addTestAccount('real-expiry');
    const modelKey = 'gemini-2.5-flash';
    const now = Date.now();

    markRateLimited(account.apiKey, 1200, modelKey);
    const until = getAccountList().find(a => a.id === account.id).modelRateLimits[modelKey];

    assert.ok(until >= now + 1000, `expected near-real expiry, got ${until - now}ms`);
    assert.ok(until <= now + 2500, `expected short cooldown, got ${until - now}ms`);
  });

  it('returns 429 when every eligible account is locally RPM-exhausted', async () => {
    const account = addTestAccount('rpm-full');
    setAccountTier(account.id, 'free');

    for (let i = 0; i < 10; i++) {
      const checkedOut = getApiKey([], 'gemini-2.5-flash');
      assert.equal(checkedOut?.apiKey, account.apiKey);
      releaseAccount(account.apiKey);
    }

    const result = await handleChatCompletions({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async waitForAccount() {
        return null;
      },
    });

    assert.equal(result.status, 429);
    assert.equal(result.body.error.type, 'rate_limit_exceeded');
    assert.match(result.headers['Retry-After'], /^\d+$/);
  });

  it('refunds RPM reservations when preflight skips the upstream request', async () => {
    const account = addTestAccount('refund-preflight');
    setExperimental({ preflightRateLimit: true });

    const result = await handleChatCompletions({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async checkMessageRateLimit() {
        return { hasCapacity: false, messagesRemaining: 0, maxMessages: 1, retryAfterMs: null };
      },
      async waitForAccount(tried, signal, maxWaitMs, modelKey) {
        return tried.length === 0 ? getApiKey(tried, modelKey) : null;
      },
    });

    assert.equal(result.status, 503);
    assert.equal(getRpmStats()[account.id].used, 0);
  });

  it('counts account failover as one success and zero errors when a later account succeeds', async () => {
    const accounts = [
      addTestAccount('failover-rate-limited-1'),
      addTestAccount('failover-rate-limited-2'),
      addTestAccount('failover-success'),
    ];
    const attempts = [];
    const before = getStats();
    const beforeModel = before.modelCounts['gemini-2.5-flash'] || { requests: 0, success: 0, errors: 0 };

    const result = await handleChatCompletions({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: `failover stats ${Date.now()}` }],
    }, {
      async waitForAccount(tried, signal, maxWaitMs, modelKey) {
        return getApiKey(tried, modelKey);
      },
      async ensureLs() {},
      getLsFor() {
        return { port: 12345, csrfToken: 'csrf-token' };
      },
      createClient(apiKey) {
        return {
          async cascadeChat() {
            attempts.push(apiKey);
            if (apiKey !== accounts[2].apiKey) {
              throw new Error('Reached message rate limit for this model. Please try again later. Resets in: 10m16s');
            }
            const chunks = [{ text: 'ok' }];
            chunks.cascadeId = 'cascade-id';
            chunks.sessionId = 'session-id';
            chunks.stepOffset = 0;
            chunks.generatorOffset = 0;
            return chunks;
          },
        };
      },
    });

    const after = getStats();
    const afterModel = after.modelCounts['gemini-2.5-flash'];

    assert.equal(result.status, 200);
    assert.deepEqual(attempts, accounts.map(a => a.apiKey));
    assert.equal(after.totalRequests - before.totalRequests, 1);
    assert.equal(after.successCount - before.successCount, 1);
    assert.equal(after.errorCount - before.errorCount, 0);
    assert.equal(afterModel.requests - beforeModel.requests, 1);
    assert.equal(afterModel.success - beforeModel.success, 1);
    assert.equal(afterModel.errors - beforeModel.errors, 0);
  });

  it('counts exhausted account failover as one final error', async () => {
    const accounts = [
      addTestAccount('final-rate-limited-1'),
      addTestAccount('final-rate-limited-2'),
    ];
    const attempts = [];
    const before = getStats();
    const beforeModel = before.modelCounts['gemini-2.5-flash'] || { requests: 0, success: 0, errors: 0 };

    const result = await handleChatCompletions({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: `final failover stats ${Date.now()}` }],
    }, {
      async waitForAccount(tried, signal, maxWaitMs, modelKey) {
        return getApiKey(tried, modelKey);
      },
      async ensureLs() {},
      getLsFor() {
        return { port: 12345, csrfToken: 'csrf-token' };
      },
      createClient(apiKey) {
        return {
          async cascadeChat() {
            attempts.push(apiKey);
            throw new Error('Reached message rate limit for this model. Please try again later. Resets in: 10m16s');
          },
        };
      },
    });

    const after = getStats();
    const afterModel = after.modelCounts['gemini-2.5-flash'];

    assert.equal(result.status, 429);
    assert.deepEqual(attempts, accounts.map(a => a.apiKey));
    assert.equal(after.totalRequests - before.totalRequests, 1);
    assert.equal(after.successCount - before.successCount, 0);
    assert.equal(after.errorCount - before.errorCount, 1);
    assert.equal(afterModel.requests - beforeModel.requests, 1);
    assert.equal(afterModel.success - beforeModel.success, 0);
    assert.equal(afterModel.errors - beforeModel.errors, 1);
  });
});

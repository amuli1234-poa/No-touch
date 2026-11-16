import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isRateLimitError,
  nextReconnectDelay,
  nextSendDelayMs,
  rateLimitBackoffMs,
  SlidingWindowLimiter,
} from './connectionPacing';
import {
  WS_MAX_RECONNECT_DELAY_MS,
  WS_RATE_LIMIT_BACKOFF_MS,
} from '../config/deriv';

test('isRateLimitError recognises Deriv rate-limit codes and messages', () => {
  assert.equal(isRateLimitError('RateLimit', 'Rate limit exceeded'), true);
  assert.equal(isRateLimitError(undefined, 'Rate limit exceeded'), true);
  assert.equal(isRateLimitError(undefined, 'too many requests'), true);
  assert.equal(isRateLimitError('InputValidationFailed', 'Invalid symbol'), false);
  assert.equal(isRateLimitError(undefined, 'Unknown symbol'), false);
});

test('rateLimitBackoffMs honours the server remaining_seconds (capped)', () => {
  assert.equal(rateLimitBackoffMs({ rate_limit: { remaining_seconds: 3 } }), 3000);
  assert.equal(rateLimitBackoffMs({ rate_limit: 2 }), 2000);
  // Never pause for longer than the hard cap, even if the server asks for more.
  assert.equal(rateLimitBackoffMs({ rate_limit: { remaining_seconds: 999 } }), 30_000);
});

test('rateLimitBackoffMs falls back to a fixed backoff when the server gives none', () => {
  assert.equal(rateLimitBackoffMs({}), WS_RATE_LIMIT_BACKOFF_MS);
  assert.equal(rateLimitBackoffMs({ rate_limit: { remaining_seconds: 0 } }), WS_RATE_LIMIT_BACKOFF_MS);
  assert.equal(rateLimitBackoffMs({ rate_limit: -5 }), WS_RATE_LIMIT_BACKOFF_MS);
});

test('nextReconnectDelay grows exponentially and is capped', () => {
  // With rand()===1 the jitter term is at its maximum, so the delay equals the base.
  assert.equal(nextReconnectDelay(0, () => 1), 1000);
  assert.equal(nextReconnectDelay(1, () => 1), 2000);
  assert.equal(nextReconnectDelay(2, () => 1), 4000);
  assert.equal(nextReconnectDelay(20, () => 1), WS_MAX_RECONNECT_DELAY_MS);
});

test('nextReconnectDelay always applies at least half-base jitter', () => {
  const min = nextReconnectDelay(3, () => 0);
  const max = nextReconnectDelay(3, () => 1);
  assert.equal(min, 4000); // half of the 8000ms base
  assert.equal(max, 8000);
  assert.ok(min <= max);
});

test('nextSendDelayMs returns 0 when a send slot is free', () => {
  assert.equal(
    nextSendDelayMs({ now: 10_000, lastSendAt: 9_000, minIntervalMs: 120, rateLimitedUntil: 0 }),
    0
  );
});

test('nextSendDelayMs waits out the minimum interval between sends', () => {
  assert.equal(
    nextSendDelayMs({ now: 9_050, lastSendAt: 9_000, minIntervalMs: 120, rateLimitedUntil: 0 }),
    70
  );
});

test('nextSendDelayMs honours the rate-limit gate over the interval', () => {
  assert.equal(
    nextSendDelayMs({
      now: 9_000,
      lastSendAt: 8_990,
      minIntervalMs: 120,
      rateLimitedUntil: 9_500,
    }),
    500
  );
});

test('SlidingWindowLimiter allows up to the budget immediately, then holds', () => {
  const limiter = new SlidingWindowLimiter(3, 1000);
  const t = 10_000;
  assert.equal(limiter.delayMs(t), 0);
  limiter.record(t);
  assert.equal(limiter.delayMs(t), 0);
  limiter.record(t);
  assert.equal(limiter.delayMs(t), 0);
  limiter.record(t);
  // Budget exhausted — the next slot opens exactly one window after the oldest stamp.
  assert.equal(limiter.delayMs(t), 1000);
  assert.equal(limiter.delayMs(t + 400), 600);
  assert.equal(limiter.delayMs(t + 1000), 0);
});

test('SlidingWindowLimiter frees a slot as each stamp ages out of the window', () => {
  const limiter = new SlidingWindowLimiter(2, 1000);
  limiter.record(0);
  limiter.record(500);
  assert.equal(limiter.delayMs(500), 500);
  assert.equal(limiter.delayMs(1000), 0);
  limiter.record(1000);
  assert.equal(limiter.used(1000), 2);
  assert.equal(limiter.used(1501), 1);
});

test('SlidingWindowLimiter.exhaust blocks the whole window after a server rate limit', () => {
  const limiter = new SlidingWindowLimiter(40, 25_000);
  assert.equal(limiter.delayMs(0), 0);
  limiter.exhaust(1000);
  assert.equal(limiter.used(1000), 40);
  assert.ok(limiter.delayMs(1000) > 0);
  assert.equal(limiter.delayMs(26_000), 0);
});

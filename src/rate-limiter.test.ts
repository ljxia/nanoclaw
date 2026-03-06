import { describe, it, expect, vi, afterEach } from 'vitest';

import { RateLimiter } from './rate-limiter.js';

describe('RateLimiter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows requests within the limit', () => {
    const limiter = new RateLimiter(3, 60000);
    expect(limiter.check('key1')).toBe(true);
    expect(limiter.check('key1')).toBe(true);
    expect(limiter.check('key1')).toBe(true);
  });

  it('blocks requests exceeding the limit', () => {
    const limiter = new RateLimiter(2, 60000);
    expect(limiter.check('key1')).toBe(true);
    expect(limiter.check('key1')).toBe(true);
    expect(limiter.check('key1')).toBe(false);
  });

  it('tracks keys independently', () => {
    const limiter = new RateLimiter(1, 60000);
    expect(limiter.check('a')).toBe(true);
    expect(limiter.check('b')).toBe(true);
    expect(limiter.check('a')).toBe(false);
    expect(limiter.check('b')).toBe(false);
  });

  it('allows requests after the window expires', () => {
    const limiter = new RateLimiter(1, 1000);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    expect(limiter.check('key1')).toBe(true);
    expect(limiter.check('key1')).toBe(false);

    // Advance time past the window
    vi.spyOn(Date, 'now').mockReturnValue(now + 1001);
    expect(limiter.check('key1')).toBe(true);
  });

  it('reset clears the key', () => {
    const limiter = new RateLimiter(1, 60000);
    expect(limiter.check('key1')).toBe(true);
    expect(limiter.check('key1')).toBe(false);

    limiter.reset('key1');
    expect(limiter.check('key1')).toBe(true);
  });
});

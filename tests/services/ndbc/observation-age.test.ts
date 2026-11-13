/**
 * @fileoverview Tests for the NDBC observation age and stale notice threshold.
 * @module tests/services/ndbc/observation-age.test
 */

import { describe, expect, it } from 'vitest';
import { getObservationAge } from '@/services/ndbc/observation-age.js';

describe('getObservationAge', () => {
  it.each([
    { now: '2026-11-13T11:59:59.999Z', minutes: 179, stale: false },
    { now: '2026-11-13T12:00:00.000Z', minutes: 180, stale: false },
    { now: '2026-11-13T12:00:00.001Z', minutes: 180, stale: true },
    { now: '2026-11-13T09:00:00.000Z', minutes: 0, stale: false },
    { now: '2026-11-13T08:59:59.999Z', minutes: -1, stale: false },
  ])('returns $minutes minutes and stale=$stale at $now', ({ now, minutes, stale }) => {
    const age = getObservationAge('2026-11-13T09:00:00Z', 'met', () => Date.parse(now));
    expect(age.minutes).toBe(minutes);
    if (stale) {
      expect(age.notice).toContain('180 minutes old');
      expect(age.notice).toContain('may have stopped reporting');
    } else {
      expect(age.notice).toBeUndefined();
    }
  });
});

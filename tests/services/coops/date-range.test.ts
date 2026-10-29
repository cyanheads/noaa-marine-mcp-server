/**
 * @fileoverview Tests for the shared CO-OPS date-range validator, the verification-lag window
 * rule, and the rule for a window that starts after the station's current date.
 * @module tests/services/coops/date-range.test
 */

import { describe, expect, it, vi } from 'vitest';
import {
  awaitsVerification,
  beginsAfterStationDate,
  type StationClock,
  validateCoopsDateRange,
} from '@/services/coops/date-range.js';

describe('validateCoopsDateRange', () => {
  it('accepts a valid same-day range with span 0', () => {
    const result = validateCoopsDateRange('20250115', '20250115');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spanDays).toBe(0);
  });

  it('computes span in whole days across a multi-day range', () => {
    const result = validateCoopsDateRange('20250101', '20250131');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spanDays).toBe(30);
  });

  it('computes span across a year boundary', () => {
    const result = validateCoopsDateRange('20240101', '20250101');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spanDays).toBe(366); // 2024 is a leap year
  });

  it('rejects Feb 31 (normalization) as an invalid begin_date', () => {
    const result = validateCoopsDateRange('20250231', '20250302');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/begin_date.*20250231.*calendar date/i);
  });

  it('rejects month 13 as an invalid date', () => {
    const result = validateCoopsDateRange('20251301', '20251305');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a real/i);
  });

  it('rejects day 00 as an invalid date', () => {
    const result = validateCoopsDateRange('20250100', '20250105');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a real/i);
  });

  it('rejects month 00 as an invalid date', () => {
    const result = validateCoopsDateRange('20250001', '20250105');
    expect(result.ok).toBe(false);
  });

  it('rejects an invalid end_date after a valid begin_date', () => {
    const result = validateCoopsDateRange('20250101', '20250230');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/end_date.*20250230/i);
  });

  it('rejects a reversed range (begin after end)', () => {
    const result = validateCoopsDateRange('20250110', '20250101');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/begin_date.*after.*end_date/i);
  });

  it('rejects a string in neither accepted form', () => {
    for (const malformed of ['2025/01/15', '2025-1-15', '20250115T00', '01-15-2025', '202501']) {
      const result = validateCoopsDateRange(malformed, '20250116');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(`begin_date "${malformed}"`);
    }
  });

  it('returns the compact YYYYMMDD strings CO-OPS takes', () => {
    const result = validateCoopsDateRange('20250115', '20250116');
    expect(result).toMatchObject({ ok: true, beginDate: '20250115', endDate: '20250116' });
  });

  it('accepts YYYY-MM-DD and compacts it, measuring the same span', () => {
    const iso = validateCoopsDateRange('2024-01-01', '2025-01-01');
    expect(iso).toMatchObject({
      ok: true,
      beginDate: '20240101',
      endDate: '20250101',
      spanDays: 366,
    });
  });

  it('reads each field on its own when the pair mixes forms', () => {
    expect(validateCoopsDateRange('20250115', '2025-01-20')).toMatchObject({
      ok: true,
      beginDate: '20250115',
      endDate: '20250120',
      spanDays: 5,
    });
  });

  it('runs the calendar check on the hyphenated form and names the date as given', () => {
    const result = validateCoopsDateRange('2025-02-31', '2025-03-02');
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toBe('begin_date "2025-02-31" is not a real calendar date.');
  });

  it('names a reversed hyphenated range as given', () => {
    const result = validateCoopsDateRange('2025-01-10', '20250101');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('"2025-01-10" is after end_date "20250101"');
  });
});

describe('awaitsVerification', () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
  const NOW = new Date('2026-09-22T12:00:00Z');

  it('is true for a window ending on the first day of the prior month', () => {
    expect(awaitsVerification(day('2026-08-01'), NOW)).toBe(true);
  });

  it('is false for a window ending the day before the prior month', () => {
    expect(awaitsVerification(day('2026-07-31'), NOW)).toBe(false);
  });

  it('is true for a window ending in the current month or the future', () => {
    expect(awaitsVerification(day('2026-09-22'), NOW)).toBe(true);
    expect(awaitsVerification(day('2027-01-01'), NOW)).toBe(true);
  });

  it('is false for a window centuries before the station record', () => {
    expect(awaitsVerification(day('1850-01-31'), NOW)).toBe(false);
  });

  it('crosses the year boundary in January, whose prior month is December', () => {
    const january = new Date('2027-01-05T08:00:00Z');
    expect(awaitsVerification(day('2026-12-01'), january)).toBe(true);
    expect(awaitsVerification(day('2026-11-30'), january)).toBe(false);
  });

  it('reads the clock when no now is given', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      expect(awaitsVerification(day('2026-08-01'))).toBe(true);
      expect(awaitsVerification(day('2026-07-31'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('beginsAfterStationDate', () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
  const at = (iso: string) => new Date(iso);

  /** Kwajalein (1820000): UTC+12, no daylight time. */
  const KWAJALEIN: StationClock = { utcOffsetHours: 12, observesDst: false };
  /** USCG Station Hatteras (8654467): UTC−5, keeps daylight time. */
  const HATTERAS: StationClock = { utcOffsetHours: -5, observesDst: true };

  /** A station-clock source that counts its reads. */
  function clockOf(clock: StationClock | undefined) {
    return vi.fn(async () => clock);
  }

  describe('gmt', () => {
    it('refuses a begin_date after the UTC date and keeps one on it, at both ends of the day', async () => {
      for (const now of [at('2026-10-29T00:00:00Z'), at('2026-10-29T23:59:59Z')]) {
        const clock = clockOf(KWAJALEIN);
        expect(await beginsAfterStationDate(day('2026-10-30'), 'gmt', clock, now)).toBe(true);
        expect(await beginsAfterStationDate(day('2026-10-29'), 'gmt', clock, now)).toBe(false);
        // The UTC date is exact; no station is consulted.
        expect(clock).not.toHaveBeenCalled();
      }
    });

    it('refuses the day after at Kwajalein, whose local date is already there', async () => {
      // Under gmt CO-OPS reads the dates as UTC, and it has no rows for a UTC date not yet begun.
      const now = at('2026-10-29T15:59:00Z');
      expect(await beginsAfterStationDate(day('2026-10-30'), 'gmt', clockOf(KWAJALEIN), now)).toBe(
        true,
      );
    });
  });

  describe('lst and lst_ldt', () => {
    it('keeps the window at Kwajalein on its local date while that date is ahead of UTC', async () => {
      // 15:59 UTC on Oct 29 is 03:59 on Oct 30 at UTC+12, where CO-OPS returned rows live.
      const now = at('2026-10-29T15:59:00Z');
      const clock = clockOf(KWAJALEIN);
      expect(await beginsAfterStationDate(day('2026-10-30'), 'lst_ldt', clock, now)).toBe(false);
      expect(clock).toHaveBeenCalledTimes(1);
    });

    it('refuses the Kwajalein local date one minute before local midnight and keeps it at midnight', async () => {
      const before = at('2026-10-29T11:59:00Z'); // 23:59 Oct 29 local
      const midnight = at('2026-10-29T12:00:00Z'); // 00:00 Oct 30 local
      expect(
        await beginsAfterStationDate(day('2026-10-30'), 'lst', clockOf(KWAJALEIN), before),
      ).toBe(true);
      expect(
        await beginsAfterStationDate(day('2026-10-30'), 'lst', clockOf(KWAJALEIN), midnight),
      ).toBe(false);
    });

    it('refuses tomorrow at Hatteras, whose local date trails UTC', async () => {
      const now = at('2026-10-29T16:00:00Z'); // 12:00 EDT
      expect(
        await beginsAfterStationDate(day('2026-10-30'), 'lst_ldt', clockOf(HATTERAS), now),
      ).toBe(true);
      expect(
        await beginsAfterStationDate(day('2026-10-29'), 'lst_ldt', clockOf(HATTERAS), now),
      ).toBe(false);
    });

    it('adds the daylight hour under lst_ldt only, so the local date can only be read later', async () => {
      // 04:00 UTC: 00:00 Oct 30 at UTC−4 (lst_ldt with DST), 23:00 Oct 29 at UTC−5 (lst).
      const midnightDst = at('2026-10-30T04:00:00Z');
      const minuteBefore = at('2026-10-30T03:59:00Z');
      const midnightLst = at('2026-10-30T05:00:00Z');
      const oct30 = day('2026-10-30');
      expect(await beginsAfterStationDate(oct30, 'lst_ldt', clockOf(HATTERAS), midnightDst)).toBe(
        false,
      );
      expect(await beginsAfterStationDate(oct30, 'lst_ldt', clockOf(HATTERAS), minuteBefore)).toBe(
        true,
      );
      expect(await beginsAfterStationDate(oct30, 'lst', clockOf(HATTERAS), midnightDst)).toBe(true);
      expect(await beginsAfterStationDate(oct30, 'lst', clockOf(HATTERAS), midnightLst)).toBe(
        false,
      );
    });

    it('never refuses a begin_date on or before the date at UTC−12, and reads no clock for it', async () => {
      // 12:00 UTC on Oct 29 is 00:00 Oct 29 at UTC−12 — every station has reached Oct 29.
      const clock = clockOf(KWAJALEIN);
      const now = at('2026-10-29T12:00:00Z');
      expect(await beginsAfterStationDate(day('2026-10-29'), 'lst_ldt', clock, now)).toBe(false);
      expect(await beginsAfterStationDate(day('1996-01-01'), 'lst', clock, now)).toBe(false);
      expect(clock).not.toHaveBeenCalled();
    });

    it('reads the clock for a begin_date one past the date at UTC−12', async () => {
      // 11:59 UTC on Oct 29 is 23:59 Oct 28 at UTC−12, so Oct 29 is in the band.
      const clock = clockOf(HATTERAS);
      const now = at('2026-10-29T11:59:00Z');
      expect(await beginsAfterStationDate(day('2026-10-29'), 'lst_ldt', clock, now)).toBe(false);
      expect(clock).toHaveBeenCalledTimes(1);
    });

    it('refuses a begin_date past the date at UTC+14 without reading a clock', async () => {
      // 09:59 UTC on Oct 29 is 23:59 Oct 29 at UTC+14 — no station has reached Oct 30.
      const clock = clockOf(undefined);
      const now = at('2026-10-29T09:59:00Z');
      expect(await beginsAfterStationDate(day('2026-10-30'), 'lst_ldt', clock, now)).toBe(true);
      expect(clock).not.toHaveBeenCalled();
    });

    it('keeps a band window when the station clock is unavailable, the UTC+14 bound', async () => {
      // 10:00 UTC on Oct 29 is 00:00 Oct 30 at UTC+14, so Oct 30 has begun somewhere.
      const clock = clockOf(undefined);
      const now = at('2026-10-29T10:00:00Z');
      expect(await beginsAfterStationDate(day('2026-10-30'), 'lst_ldt', clock, now)).toBe(false);
      expect(clock).toHaveBeenCalledTimes(1);
    });

    it('reads the system clock when no now is given', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(at('2026-10-29T15:59:00Z'));
      try {
        const oct30 = day('2026-10-30');
        expect(await beginsAfterStationDate(oct30, 'lst', clockOf(KWAJALEIN))).toBe(false);
        expect(await beginsAfterStationDate(oct30, 'gmt', clockOf(KWAJALEIN))).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

/**
 * @fileoverview Tests for the shared CO-OPS date-range validator.
 * @module tests/services/coops/date-range.test
 */

import { describe, expect, it } from 'vitest';
import { validateCoopsDateRange } from '@/services/coops/date-range.js';

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

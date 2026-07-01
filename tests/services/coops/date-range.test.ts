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

  it('rejects a malformed (non-8-digit) string', () => {
    const result = validateCoopsDateRange('2025-01-15', '20250116');
    expect(result.ok).toBe(false);
  });
});

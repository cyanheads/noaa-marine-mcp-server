/**
 * @fileoverview Tests for the byte-bounded row pager shared by the CO-OPS time-series tools.
 * @module tests/services/coops/row-page.test
 */

import { describe, expect, it } from 'vitest';
import {
  pagePairedRows,
  pageRows,
  ROW_PAGE_BUDGET_BYTES,
  serializedBytes,
} from '@/services/coops/row-page.js';

/** A 6-minute observation row at its real width — the shape the byte bound is tuned against. */
function obsRow(index: number): { quality: string; sigma: number; time: string; value: number } {
  const minutes = index * 6;
  const day = String(1 + Math.floor(minutes / 1440)).padStart(2, '0');
  const hour = String(Math.floor((minutes % 1440) / 60)).padStart(2, '0');
  const minute = String(minutes % 60).padStart(2, '0');
  return {
    quality: 'p',
    sigma: 0.014,
    time: `2026-09-${day} ${hour}:${minute}`,
    value: Number((8 + (index % 100) / 100).toFixed(3)),
  };
}

function predRow(index: number): { time: string; value: number } {
  const { time } = obsRow(index);
  return { time, value: Number((8 + (index % 90) / 100).toFixed(3)) };
}

describe('serializedBytes', () => {
  it('measures the row as JSON.stringify renders it', () => {
    expect(serializedBytes({ a: 1 })).toBe(JSON.stringify({ a: 1 }).length);
  });

  it('reports zero for a value JSON.stringify drops', () => {
    expect(serializedBytes(undefined)).toBe(0);
  });
});

describe('pageRows', () => {
  const rows = Array.from({ length: 720 }, (_, i) => obsRow(i));

  it('returns a short series whole, with no next page', () => {
    const page = pageRows(rows.slice(0, 10), { offset: 0 });
    expect(page.rows).toHaveLength(10);
    expect(page.matched).toBe(10);
    expect(page.nextOffset).toBeNull();
    expect(page.whole).toBe(true);
  });

  it('bounds the page by serialized bytes, not a row count', () => {
    const page = pageRows(rows, { offset: 0 });
    expect(page.whole).toBe(false);
    expect(serializedBytes(page.rows)).toBeLessThanOrEqual(ROW_PAGE_BUDGET_BYTES);
    // One more row would have crossed the budget — the page is maximal, not arbitrary.
    const oneMore = rows.slice(0, page.rows.length + 1);
    expect(serializedBytes(oneMore)).toBeGreaterThan(ROW_PAGE_BUDGET_BYTES);
  });

  it('walks first page to empty page and concatenates to the whole series with nothing lost', () => {
    const walked: ReturnType<typeof obsRow>[] = [];
    const offsets: number[] = [];
    let offset = 0;
    let pages = 0;

    for (;;) {
      const page = pageRows(rows, { offset });
      offsets.push(page.offset);
      walked.push(...page.rows);
      pages += 1;
      expect(pages).toBeLessThan(50);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }

    expect(pages).toBeGreaterThanOrEqual(3);
    expect(walked).toEqual(rows);
    expect(offsets[0]).toBe(0);

    // The page after the last one is empty rather than an error or a repeat.
    const past = pageRows(rows, { offset: rows.length });
    expect(past.rows).toEqual([]);
    expect(past.nextOffset).toBeNull();
    expect(past.matched).toBe(720);
    expect(past.whole).toBe(false);
  });

  it('treats an offset beyond the end as an empty page, not a clamp to the last page', () => {
    const page = pageRows(rows, { offset: 5000 });
    expect(page.rows).toEqual([]);
    expect(page.offset).toBe(5000);
    expect(page.nextOffset).toBeNull();
  });

  it('lets limit lower the page below the byte bound', () => {
    const bounded = pageRows(rows, { offset: 0 });
    const capped = pageRows(rows, { limit: 5, offset: 0 });
    expect(capped.rows).toHaveLength(5);
    expect(capped.nextOffset).toBe(5);
    expect(capped.rows.length).toBeLessThan(bounded.rows.length);
  });

  it('never lets limit raise the page past the byte bound', () => {
    const bounded = pageRows(rows, { offset: 0 });
    const raised = pageRows(rows, { limit: 10_000, offset: 0 });
    expect(raised.rows).toHaveLength(bounded.rows.length);
    expect(serializedBytes(raised.rows)).toBeLessThanOrEqual(ROW_PAGE_BUDGET_BYTES);
  });

  it('returns one row even when that row alone is wider than the budget, so paging still advances', () => {
    const wide = [{ blob: 'x'.repeat(ROW_PAGE_BUDGET_BYTES * 2) }, { blob: 'y' }];
    const page = pageRows(wide, { offset: 0 });
    expect(page.rows).toHaveLength(1);
    expect(page.nextOffset).toBe(1);
  });

  it('pages an empty series as an empty whole page', () => {
    const page = pageRows([], { offset: 0 });
    expect(page.rows).toEqual([]);
    expect(page.matched).toBe(0);
    expect(page.nextOffset).toBeNull();
    expect(page.whole).toBe(true);
  });
});

describe('pagePairedRows', () => {
  const observations = Array.from({ length: 720 }, (_, i) => obsRow(i));
  const predictions = Array.from({ length: 720 }, (_, i) => predRow(i));

  it('charges both series to one budget, so the pair fits where each alone would not', () => {
    const paired = pagePairedRows(observations, predictions, { offset: 0 });
    const bytes = serializedBytes(paired.page.rows) + serializedBytes(paired.companion);
    expect(bytes).toBeLessThanOrEqual(ROW_PAGE_BUDGET_BYTES);
    // The primary-only page would have been longer — proof the companion is charged.
    const primaryOnly = pageRows(observations, { offset: 0 });
    expect(paired.page.rows.length).toBeLessThan(primaryOnly.rows.length);
  });

  it('walks every page and reassembles both series with nothing dropped or duplicated', () => {
    const obsWalk: ReturnType<typeof obsRow>[] = [];
    const predWalk: ReturnType<typeof predRow>[] = [];
    let offset = 0;
    let pages = 0;

    for (;;) {
      const paired = pagePairedRows(observations, predictions, { offset });
      obsWalk.push(...paired.page.rows);
      predWalk.push(...paired.companion);
      pages += 1;
      expect(pages).toBeLessThan(80);
      if (paired.page.nextOffset === null) break;
      offset = paired.page.nextOffset;
    }

    expect(pages).toBeGreaterThanOrEqual(3);
    expect(obsWalk).toEqual(observations);
    expect(predWalk).toEqual(predictions);
  });

  it('keeps the companion window time-aligned with the page when gap rows shorten the primary', () => {
    // The 6-minute grid with the sensor silent for three slots: predictions still cover them.
    const gapped = observations.filter((_, i) => i < 4 || i > 6);
    const paired = pagePairedRows(gapped.slice(0, 8), predictions.slice(0, 11), { offset: 0 });
    expect(paired.page.rows).toHaveLength(8);
    // The window runs from the first page row's time through the last, inclusive — the three
    // gap slots' predictions are inside it and are returned.
    expect(paired.companion[0]?.time).toBe(gapped[0]?.time);
    expect(paired.companion.at(-1)?.time).toBe(predictions[10]?.time);
    expect(paired.companion.length).toBeGreaterThan(paired.page.rows.length);
  });

  it('carries no companion rows on a page past the end of the primary series', () => {
    const paired = pagePairedRows(observations, predictions, { offset: 720 });
    expect(paired.page.rows).toEqual([]);
    expect(paired.companion).toEqual([]);
  });

  it('leaves trailing companion rows on the last real page, not on the empty page after it', () => {
    // A sensor that goes silent at the end of the range: the observed series stops while
    // CO-OPS still predicts the remaining slots.
    const primary = observations.slice(0, 5);
    const companion = predictions.slice(0, 8);

    const last = pagePairedRows(primary, companion, { offset: 0 });
    expect(last.page.rows).toHaveLength(5);
    expect(last.companion).toEqual(companion);

    // The page after it covers no span of its own, so it repeats none of them.
    const past = pagePairedRows(primary, companion, { offset: primary.length });
    expect(past.page.rows).toEqual([]);
    expect(past.companion).toEqual([]);
  });

  it('returns the whole pair when the primary series has no companion at all', () => {
    const paired = pagePairedRows(observations.slice(0, 5), [], { offset: 0 });
    expect(paired.page.rows).toHaveLength(5);
    expect(paired.companion).toEqual([]);
    expect(paired.page.whole).toBe(true);
  });
});

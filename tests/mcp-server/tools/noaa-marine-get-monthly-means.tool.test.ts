/**
 * @fileoverview Tests for noaa_marine_get_monthly_means, driven end to end through the real
 * `CoopsService` against a fake CO-OPS upstream — the seam is HTTP, never a service method.
 * @module tests/mcp-server/tools/noaa-marine-get-monthly-means.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaMarineGetMonthlyMeans } from '@/mcp-server/tools/definitions/noaa-marine-get-monthly-means.tool.js';
import { initCoopsService } from '@/services/coops/coops-service.js';
import { type CoopsResponder, callsTo, installCoopsFake } from '../../support/coops-http.js';

type Result = Awaited<ReturnType<typeof runToolContract>>;
type ErrorEnvelope = { code: number; data?: Record<string, unknown>; message: string };
type Month = Record<string, number | string>;
type Structured = Record<string, unknown> & { months: Month[] };

/** "Today" for every case — the prior month starts 2026-08-01. */
const TODAY = new Date('2026-09-22T12:00:00Z');

const NOT_OFFERED =
  'No data was found. This product may not be offered at this station at the requested time.';

/** A coastal station-month with every one of the 15 value columns populated, each distinct. */
function coastalRow(year: number, month: number, inferred = '0'): Record<string, string> {
  return {
    year: String(year),
    month: String(month),
    highest: '12.512',
    MHHW: '9.012',
    MHW: '8.201',
    MSL: '6.643',
    MTL: '6.617',
    MLW: '5.033',
    MLLW: '2.349',
    DTL: '5.681',
    GT: '6.663',
    MN: '3.168',
    DHQ: '0.811',
    DLQ: '2.684',
    HWI: '4.52',
    LWI: '10.83',
    lowest: '-1.918',
    inferred,
  };
}

/** A Great Lakes station-month at IGLD, as CO-OPS sends it: only three values populated. */
function greatLakesRow(year: number, month: number): Record<string, string> {
  return {
    year: String(year),
    month: String(month),
    highest: '579.117',
    MHHW: '',
    MHW: '',
    MSL: '578.061',
    MTL: '',
    MLW: '',
    MLLW: '',
    DTL: '',
    GT: '',
    MN: '',
    DHQ: '',
    DLQ: '',
    HWI: '',
    LWI: '',
    lowest: '576.978',
    inferred: '0',
  };
}

/** `count` consecutive coastal months starting at `year`-`month`. */
function coastalSeries(year: number, month: number, count: number): Record<string, string>[] {
  return Array.from({ length: count }, (_, i) => {
    const index = year * 12 + (month - 1) + i;
    return coastalRow(Math.floor(index / 12), (index % 12) + 1);
  });
}

/** CO-OPS answering `monthly_mean` with these rows. Any other request fails the test. */
function monthlyCoops(rows: readonly Record<string, string>[], name = 'Seattle'): CoopsResponder {
  return (endpoint, url) => {
    if (endpoint !== 'data' || url.searchParams.get('product') !== 'monthly_mean') {
      throw new Error(`Unexpected CO-OPS ${endpoint} request: ${url}`);
    }
    return Response.json({ metadata: { id: '9447130', name }, data: rows });
  };
}

/** CO-OPS answering every data request with this status and error message. */
function coopsError(message: string, status = 200): CoopsResponder {
  return () => new Response(JSON.stringify({ error: { message } }), { status });
}

const errorOf = (r: Result) => (r.structuredContent as { error: ErrorEnvelope }).error;
const textOf = (r: Result) => r.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
const hintOf = (r: Result) =>
  (errorOf(r).data?.recovery as { hint?: string } | undefined)?.hint ?? '';
const declared = (reason: string) =>
  noaaMarineGetMonthlyMeans.errors?.find((e) => e.reason === reason)?.recovery ?? '';

/** The failure envelope on both surfaces: code, reason, and the declared recovery. */
function expectFailure(result: Result, code: number, reason: string): void {
  expect(result.isError).toBe(true);
  expect(errorOf(result).code).toBe(code);
  expect(errorOf(result).data?.reason).toBe(reason);
  expect(hintOf(result)).toBe(declared(reason));
  const text = textOf(result);
  expect(text).toContain(`Recovery: ${declared(reason)}`);
  expect(text).toContain(`(reason ${reason}`);
}

let http: ReturnType<typeof installCoopsFake> | undefined;

function fake(respond: CoopsResponder): NonNullable<typeof http> {
  http = installCoopsFake(respond);
  return http;
}

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initCoopsService(null as any, null as any, { applicationId: 'test' });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TODAY);
});

afterEach(() => {
  vi.useRealTimers();
  http?.restore();
  http = undefined;
});

describe('noaa_marine_get_monthly_means', () => {
  describe('the monthly series', () => {
    it('returns one row per month in range and drops the month CO-OPS overruns end_date with', async () => {
      // 2025-01-01 → 2025-12-31 at 9447130 answers 13 rows, the last one 2026-01.
      const upstream = fake(monthlyCoops(coastalSeries(2025, 1, 13)));
      const result = await runToolContract(noaaMarineGetMonthlyMeans, {
        station_id: '9447130',
        begin_date: '2025-01-01',
        end_date: '2025-12-31',
      });
      const structured = result.structuredContent as Structured;

      expect(result.isError).toBeFalsy();
      expect(structured.months.map((m) => `${m.year}-${m.month}`)).toEqual(
        Array.from({ length: 12 }, (_, i) => `2025-${i + 1}`),
      );
      const text = textOf(result);
      expect(text).toContain('**Months** (12 records)');
      expect(text).toContain('2025-12:');
      expect(text).not.toContain('2026-01');
      // A range that fits comes back whole, with no paging disclosure.
      expect(structured).not.toHaveProperty('truncated');
      expect(structured).not.toHaveProperty('notice');

      const [request] = callsTo(upstream, 'data');
      expect(callsTo(upstream, 'data')).toHaveLength(1);
      expect(Object.fromEntries(request?.searchParams ?? [])).toMatchObject({
        station: '9447130',
        product: 'monthly_mean',
        begin_date: '20250101',
        end_date: '20251231',
        datum: 'MLLW',
        time_zone: 'lst',
        units: 'english',
        format: 'json',
      });
    });

    it('keeps the partial months at both ends of a mid-month range', async () => {
      fake(monthlyCoops(coastalSeries(2025, 1, 4)));
      const result = await runToolContract(noaaMarineGetMonthlyMeans, {
        station_id: '9447130',
        begin_date: '20250115',
        end_date: '20250310',
      });
      const structured = result.structuredContent as Structured;

      expect(structured.months.map((m) => m.month)).toEqual([1, 2, 3]);
    });

    it('maps all 18 CO-OPS keys onto the row, on both surfaces', async () => {
      fake(monthlyCoops([coastalRow(2025, 3)]));
      const result = await runToolContract(noaaMarineGetMonthlyMeans, {
        station_id: '9447130',
        begin_date: '20250301',
        end_date: '20250331',
      });
      const structured = result.structuredContent as Structured;

      expect(structured).toMatchObject({
        station_id: '9447130',
        station_name: 'Seattle',
        datum: 'MLLW',
        units: 'english',
        begin_date: '20250301',
        end_date: '20250331',
      });
      expect(structured.months).toEqual([
        {
          year: 2025,
          month: 3,
          highest: 12.512,
          mhhw: 9.012,
          mhw: 8.201,
          msl: 6.643,
          mtl: 6.617,
          mlw: 5.033,
          mllw: 2.349,
          dtl: 5.681,
          gt: 6.663,
          mn: 3.168,
          dhq: 0.811,
          dlq: 2.684,
          hwi: 4.52,
          lwi: 10.83,
          lowest: -1.918,
          inferred: '0',
        },
      ]);

      const text = textOf(result);
      expect(text).toContain('## Monthly Means — Seattle (9447130)');
      expect(text).toContain('**Datum:** MLLW · **Units:** english · **Range:** 20250301–20250331');
      expect(text).toBe(
        [
          '## Monthly Means — Seattle (9447130)',
          '**Datum:** MLLW · **Units:** english · **Range:** 20250301–20250331',
          '',
          '**Months** (1 records):',
          '2025-03: highest 12.512 ft · MHHW 9.012 ft · MHW 8.201 ft · MSL 6.643 ft · MTL 6.617 ft · MLW 5.033 ft · MLLW 2.349 ft · DTL 5.681 ft · GT 6.663 ft · MN 3.168 ft · DHQ 0.811 ft · DLQ 2.684 ft · HWI 4.52 h · LWI 10.83 h · lowest -1.918 ft · inferred 0',
        ].join('\n'),
      );
    });

    it('labels heights in meters under metric and keeps the intervals in hours', async () => {
      const upstream = fake(monthlyCoops([coastalRow(2025, 3)]));
      const result = await runToolContract(noaaMarineGetMonthlyMeans, {
        station_id: '9447130',
        begin_date: '20250301',
        end_date: '20250331',
        units: 'metric',
      });

      expect(callsTo(upstream, 'data')[0]?.searchParams.get('units')).toBe('metric');
      const text = textOf(result);
      expect(text).toContain('MSL 6.643 m ·');
      expect(text).toContain('HWI 4.52 h');
    });

    it('omits every value sent as an empty string — a Great Lakes station at IGLD', async () => {
      const upstream = fake(
        monthlyCoops([greatLakesRow(2025, 1), greatLakesRow(2025, 2)], 'Calumet Harbor'),
      );
      const result = await runToolContract(noaaMarineGetMonthlyMeans, {
        station_id: '9087044',
        begin_date: '20250101',
        end_date: '20250228',
        datum: 'IGLD',
      });
      const structured = result.structuredContent as Structured;

      expect(callsTo(upstream, 'data')[0]?.searchParams.get('datum')).toBe('IGLD');
      for (const month of structured.months) {
        expect(Object.keys(month).sort()).toEqual(
          ['highest', 'inferred', 'lowest', 'month', 'msl', 'year'].sort(),
        );
      }
      expect(structured.months[0]).toEqual({
        year: 2025,
        month: 1,
        highest: 579.117,
        msl: 578.061,
        lowest: 576.978,
        inferred: '0',
      });

      const text = textOf(result);
      expect(text).toContain('2025-01: highest 579.117 ft · MSL 578.061 ft · lowest 576.978 ft');
      expect(text).not.toContain('NaN');
      expect(text).not.toContain('MHHW');
    });

    it('omits a value per field, never zeroing it', async () => {
      const sparse = { ...coastalRow(2025, 5), GT: '', HWI: '', lowest: '' };
      fake(monthlyCoops([sparse]));
      const result = await runToolContract(noaaMarineGetMonthlyMeans, {
        station_id: '9447130',
        begin_date: '20250501',
        end_date: '20250531',
      });
      const month = (result.structuredContent as Structured).months[0] ?? {};

      expect(month).not.toHaveProperty('gt');
      expect(month).not.toHaveProperty('hwi');
      expect(month).not.toHaveProperty('lowest');
      expect(month.mn).toBe(3.168);
      expect(textOf(result)).not.toContain('GT ');
    });

    it('passes the inferred code through verbatim', async () => {
      fake(
        monthlyCoops([
          coastalRow(2025, 1, '0'),
          coastalRow(2025, 2, '1'),
          coastalRow(2025, 3, '11'),
        ]),
      );
      const result = await runToolContract(noaaMarineGetMonthlyMeans, {
        station_id: '9447130',
        begin_date: '20250101',
        end_date: '20250331',
      });
      const structured = result.structuredContent as Structured;

      expect(structured.months.map((m) => m.inferred)).toEqual(['0', '1', '11']);
      const text = textOf(result);
      expect(text).toContain('2025-02:');
      expect(text).toMatch(/2025-03: .* · inferred 11$/m);
    });
  });

  describe('paging', () => {
    // 1975–2025 at 9447130 answers 613 rows: 612 in range plus the overrun month.
    const FIFTY_ONE_YEARS = coastalSeries(1975, 1, 613);
    const RANGE = { station_id: '9447130', begin_date: '19750101', end_date: '20251231' };

    it('returns the leading page with rows_matched and next_offset, on both surfaces', async () => {
      fake(monthlyCoops(FIFTY_ONE_YEARS));
      const result = await runToolContract(noaaMarineGetMonthlyMeans, RANGE);
      const structured = result.structuredContent as Structured;

      expect(result.isError).toBeFalsy();
      expect(structured.rows_matched).toBe(612);
      expect(structured.months.length).toBeLessThan(612);
      expect(structured.rows_returned).toBe(structured.months.length);
      expect(structured.page_offset).toBe(0);
      expect(structured.next_offset).toBe(structured.rows_returned);
      expect(structured.truncated).toBe(true);
      expect(JSON.stringify(structured.months).length).toBeLessThanOrEqual(24_000);

      const text = textOf(result);
      expect(text).toContain('612');
      expect(text).toContain(`offset=${structured.next_offset}`);
      expect(String(structured.notice)).toContain('months 1–');
    });

    it('walks every page to the end and reassembles the 612 months in order', async () => {
      fake(monthlyCoops(FIFTY_ONE_YEARS));
      const seen: string[] = [];
      let offset: number | null = 0;
      let pages = 0;

      while (offset !== null) {
        const result = await runToolContract(noaaMarineGetMonthlyMeans, { ...RANGE, offset });
        const structured = result.structuredContent as Structured & { next_offset?: number | null };
        seen.push(...structured.months.map((m) => `${m.year}-${m.month}`));
        offset = structured.next_offset ?? null;
        pages += 1;
        expect(pages).toBeLessThan(40);
      }

      expect(pages).toBeGreaterThanOrEqual(3);
      expect(seen).toHaveLength(612);
      expect(seen[0]).toBe('1975-1');
      expect(seen.at(-1)).toBe('2025-12');
      expect(new Set(seen).size).toBe(612);
    });

    it('returns an empty page, not an error, for an offset past the end', async () => {
      fake(monthlyCoops(FIFTY_ONE_YEARS));
      const result = await runToolContract(noaaMarineGetMonthlyMeans, { ...RANGE, offset: 612 });
      const structured = result.structuredContent as Structured;

      expect(result.isError).toBeFalsy();
      expect(structured.months).toEqual([]);
      expect(structured.rows_matched).toBe(612);
      expect(structured.rows_returned).toBe(0);
      expect(structured.next_offset).toBeNull();
      expect(structured.truncated).toBe(false);
      expect(textOf(result)).toContain('past the last of 612 months');
    });

    it('lets limit lower the page and never raise it past the byte bound', async () => {
      fake(monthlyCoops(FIFTY_ONE_YEARS));
      const small = await runToolContract(noaaMarineGetMonthlyMeans, { ...RANGE, limit: 3 });
      const bounded = await runToolContract(noaaMarineGetMonthlyMeans, RANGE);
      const raised = await runToolContract(noaaMarineGetMonthlyMeans, { ...RANGE, limit: 10_000 });

      expect((small.structuredContent as Structured).months).toHaveLength(3);
      expect((small.structuredContent as Structured).next_offset).toBe(3);
      expect((raised.structuredContent as Structured).months).toHaveLength(
        (bounded.structuredContent as Structured).months.length,
      );
    });
  });

  describe('local validation', () => {
    it.each(['HWI', 'LWI'])(
      'rejects datum %s at the schema — a lunitidal interval is not a reference plane',
      async (datum) => {
        const upstream = fake(monthlyCoops([coastalRow(2025, 1)]));
        const result = await runToolContract(noaaMarineGetMonthlyMeans, {
          station_id: '9447130',
          begin_date: '20250101',
          end_date: '20250131',
          datum,
        } as never);

        expect(result.isError).toBe(true);
        expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(textOf(result)).toContain('datum');
        expect(
          noaaMarineGetMonthlyMeans.input.safeParse({
            station_id: '9447130',
            begin_date: '20250101',
            end_date: '20250131',
            datum,
          }).success,
        ).toBe(false);
        expect(callsTo(upstream, 'data')).toHaveLength(0);
      },
    );

    it('accepts every reference plane the schema advertises', () => {
      const datum = noaaMarineGetMonthlyMeans.input.shape.datum.unwrap();
      expect(datum.options).toEqual([
        'MLLW',
        'MHHW',
        'MHW',
        'MTL',
        'MSL',
        'MLW',
        'NAVD',
        'STND',
        'IGLD',
        'LWD',
        'CRD',
      ]);
    });

    it('describes the four ranges as datum-independent differences, not datum-relative heights', () => {
      const month = noaaMarineGetMonthlyMeans.output.shape.months.element.shape;
      for (const key of ['gt', 'mn', 'dhq', 'dlq'] as const) {
        const description = month[key].description ?? '';
        expect(description).toContain('in the requested units');
        expect(description).toContain('difference between two tidal planes');
        expect(description).toContain('same under every datum');
        expect(description).toContain('Omitted when CO-OPS publishes no value for the month');
        expect(description).not.toContain('relative to the requested datum');
      }
      expect(month.msl.description).toContain('relative to the requested datum');
    });

    it('rejects an impossible calendar date without calling CO-OPS', async () => {
      const upstream = fake(monthlyCoops([]));
      const result = await runToolContract(noaaMarineGetMonthlyMeans, {
        station_id: '9447130',
        begin_date: '20250231',
        end_date: '20250331',
      });

      expectFailure(result, JsonRpcErrorCode.ValidationError, 'invalid_date_range');
      expect(errorOf(result).message).toContain('"20250231"');
      expect(callsTo(upstream, 'data')).toHaveLength(0);
    });

    it('rejects a reversed range without calling CO-OPS', async () => {
      const upstream = fake(monthlyCoops([]));
      const result = await runToolContract(noaaMarineGetMonthlyMeans, {
        station_id: '9447130',
        begin_date: '20250401',
        end_date: '20250301',
      });

      expectFailure(result, JsonRpcErrorCode.ValidationError, 'invalid_date_range');
      expect(callsTo(upstream, 'data')).toHaveLength(0);
    });

    it('rejects a span over 73,000 days, naming the limit, without calling CO-OPS', async () => {
      const upstream = fake(monthlyCoops([]));
      // 1826-01-01 + 73,001 days = 2025-11-14.
      const result = await runToolContract(noaaMarineGetMonthlyMeans, {
        station_id: '9447130',
        begin_date: '18260101',
        end_date: '20251114',
      });

      expectFailure(result, JsonRpcErrorCode.ValidationError, 'date_range_exceeded');
      expect(errorOf(result).message).toContain('73,000');
      expect(errorOf(result).message).toContain('73001');
      expect(callsTo(upstream, 'data')).toHaveLength(0);
    });

    it('accepts a span of exactly 73,000 days', async () => {
      const upstream = fake(monthlyCoops([coastalRow(2025, 11)]));
      // 1826-01-01 + 73,000 days = 2025-11-13.
      const result = await runToolContract(noaaMarineGetMonthlyMeans, {
        station_id: '9447130',
        begin_date: '18260101',
        end_date: '20251113',
      });

      expect(result.isError).toBeFalsy();
      expect(callsTo(upstream, 'data')).toHaveLength(1);
    });
  });

  describe('upstream failures', () => {
    it('maps the CO-OPS invalid-station 400 to station_not_found', async () => {
      // The body CO-OPS sends, leading space included.
      fake(coopsError(' The station is not a valid station or there is system error.', 400));
      const result = await runToolContract(noaaMarineGetMonthlyMeans, {
        station_id: '0000000',
        begin_date: '20250101',
        end_date: '20250131',
      });

      expectFailure(result, JsonRpcErrorCode.NotFound, 'station_not_found');
      expect(errorOf(result).message).toContain('0000000');
    });

    it('maps a datum the station does not carry to datum_unavailable', async () => {
      fake(coopsError('There is no IGLD for the station: 9447130', 400));
      const result = await runToolContract(noaaMarineGetMonthlyMeans, {
        station_id: '9447130',
        begin_date: '20250101',
        end_date: '20250131',
        datum: 'IGLD',
      });

      expectFailure(result, JsonRpcErrorCode.InvalidParams, 'datum_unavailable');
      expect(errorOf(result).message).toContain('IGLD');
    });

    it.each([
      ['ending on the first day of the prior month', '20260701', '20260801'],
      ['reaching into the current month', '20260801', '20260930'],
    ])('reports verified_data_lag for a window %s', async (_label, begin, end) => {
      fake(coopsError(NOT_OFFERED));
      const result = await runToolContract(noaaMarineGetMonthlyMeans, {
        station_id: '9447130',
        begin_date: begin,
        end_date: end,
      });

      expectFailure(result, JsonRpcErrorCode.NotFound, 'verified_data_lag');
    });

    it.each([
      ['in 1850, before the station record', '18500101', '18501231'],
      ['ending the day before the prior month', '20260101', '20260731'],
    ])('reports no_data for a window %s', async (_label, begin, end) => {
      fake(coopsError(NOT_OFFERED));
      const result = await runToolContract(noaaMarineGetMonthlyMeans, {
        station_id: '9447130',
        begin_date: begin,
        end_date: end,
      });

      expectFailure(result, JsonRpcErrorCode.NotFound, 'no_data');
      expect(hintOf(result)).not.toContain('verif');
    });

    it('applies the same window rule when CO-OPS returns only the overrun month', async () => {
      fake(monthlyCoops([coastalRow(2026, 10)]));
      const lag = await runToolContract(noaaMarineGetMonthlyMeans, {
        station_id: '9447130',
        begin_date: '20260901',
        end_date: '20260930',
      });
      expectFailure(lag, JsonRpcErrorCode.NotFound, 'verified_data_lag');

      http?.restore();
      fake(monthlyCoops([]));
      const early = await runToolContract(noaaMarineGetMonthlyMeans, {
        station_id: '9447130',
        begin_date: '19000101',
        end_date: '19001231',
      });
      expectFailure(early, JsonRpcErrorCode.NotFound, 'no_data');
    });
  });
});

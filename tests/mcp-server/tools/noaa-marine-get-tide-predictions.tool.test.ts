/**
 * @fileoverview Tests for noaa_marine_get_tide_predictions tool.
 * @module tests/mcp-server/tools/noaa-marine-get-tide-predictions.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaMarineGetTidePredictions } from '@/mcp-server/tools/definitions/noaa-marine-get-tide-predictions.tool.js';
import { CoopsBodyError, initCoopsService } from '@/services/coops/coops-service.js';

const TIDE_PREDICTIONS = [
  { t: '2025-01-15 06:23', v: '5.42', type: 'H' },
  { t: '2025-01-15 12:51', v: '-0.31', type: 'L' },
];

function setupCoops() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initCoopsService(null as any, null as any, { applicationId: 'test' });
}

describe('noaaMarineGetTidePredictions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setupCoops();
  });

  it('returns tide predictions for a valid station and date range', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetTidePredictions.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    // Station list lookup for name resolution — returns the matching station
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(svc, 'getStations').mockResolvedValue([
      { id: '9447130', name: 'Seattle', lat: 47.6, lng: -122.33, state: 'WA', type: 'R' },
    ] as any);
    vi.spyOn(svc, 'fetchTidePredictions').mockResolvedValue({
      predictions: TIDE_PREDICTIONS,
      stationName: 'Seattle',
    });

    const input = noaaMarineGetTidePredictions.input.parse({
      station_id: '9447130',
      begin_date: '20250115',
      end_date: '20250115',
    });
    const result = await noaaMarineGetTidePredictions.handler(input, ctx);

    expect(result.station_id).toBe('9447130');
    expect(result.station_name).toBe('Seattle');
    expect(result.datum).toBe('MLLW');
    expect(result.units).toBe('english');
    expect(result.predictions).toHaveLength(2);
    expect(result.predictions[0]).toMatchObject({
      time: '2025-01-15 06:23',
      height: 5.42,
      type: 'H',
    });
    expect(result.predictions[1]).toMatchObject({
      time: '2025-01-15 12:51',
      height: -0.31,
      type: 'L',
    });
  });

  it('throws ctx.fail("date_range_exceeded") for range > 365 days', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetTidePredictions.errors });
    const input = noaaMarineGetTidePredictions.input.parse({
      station_id: '9447130',
      begin_date: '20230101',
      end_date: '20250101',
    });
    await expect(noaaMarineGetTidePredictions.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'date_range_exceeded' },
    });
  });

  it('throws ctx.fail("invalid_date_range") for an impossible calendar date, without calling CO-OPS', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetTidePredictions.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    const fetchSpy = vi
      .spyOn(svc, 'fetchTidePredictions')
      .mockResolvedValue({ predictions: [], stationName: 'x' });

    const input = noaaMarineGetTidePredictions.input.parse({
      station_id: '9447130',
      begin_date: '20250231', // Feb 31 — does not exist
      end_date: '20250302',
    });
    await expect(noaaMarineGetTidePredictions.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_date_range' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws ctx.fail("invalid_date_range") for a reversed range, without calling CO-OPS', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetTidePredictions.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    const fetchSpy = vi
      .spyOn(svc, 'fetchTidePredictions')
      .mockResolvedValue({ predictions: [], stationName: 'x' });

    const input = noaaMarineGetTidePredictions.input.parse({
      station_id: '9447130',
      begin_date: '20250110',
      end_date: '20250101', // before begin_date
    });
    await expect(noaaMarineGetTidePredictions.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_date_range' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws ctx.fail("station_not_found") on CO-OPS station error', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetTidePredictions.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(svc, 'getStations').mockResolvedValue([] as any);
    // CO-OPS returns HTTP 400 for invalid station IDs — simulate with McpError + status
    vi.spyOn(svc, 'fetchTidePredictions').mockRejectedValue(
      new McpError(JsonRpcErrorCode.InvalidParams, 'CO-OPS fetch failed', { status: 400 }),
    );

    const input = noaaMarineGetTidePredictions.input.parse({
      station_id: '0000000',
      begin_date: '20250115',
      end_date: '20250115',
    });
    await expect(noaaMarineGetTidePredictions.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'station_not_found' },
    });
  });

  it('throws ctx.fail("no_predictions") when predictions array is empty', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetTidePredictions.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    vi.spyOn(getCoopsService(), 'fetchTidePredictions').mockResolvedValue({
      predictions: [],
      stationName: 'Inactive',
    });

    const input = noaaMarineGetTidePredictions.input.parse({
      station_id: '9999999',
      begin_date: '20250115',
      end_date: '20250115',
    });
    await expect(noaaMarineGetTidePredictions.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_predictions' },
    });
  });

  it('throws ctx.fail("no_predictions") on CoopsBodyError with no_predictions reason', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetTidePredictions.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    vi.spyOn(svc, 'getStations').mockResolvedValue([] as never);
    vi.spyOn(svc, 'fetchTidePredictions').mockRejectedValue(
      new CoopsBodyError('no_predictions', 'CO-OPS error: No Predictions data was found.'),
    );

    const input = noaaMarineGetTidePredictions.input.parse({
      station_id: '9447130',
      begin_date: '20250115',
      end_date: '20250115',
      interval: '6min',
    });
    await expect(noaaMarineGetTidePredictions.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_predictions' },
    });
  });

  it('throws ctx.fail("station_not_found") on CoopsBodyError with station_error reason', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetTidePredictions.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    vi.spyOn(svc, 'getStations').mockResolvedValue([] as never);
    vi.spyOn(svc, 'fetchTidePredictions').mockRejectedValue(
      new CoopsBodyError('station_error', 'CO-OPS error: Station not available.'),
    );

    const input = noaaMarineGetTidePredictions.input.parse({
      station_id: '9999999',
      begin_date: '20250115',
      end_date: '20250115',
    });
    await expect(noaaMarineGetTidePredictions.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'station_not_found' },
    });
  });

  // --- #26: a subordinate tide station publishes no 6-minute curve ---

  /** Hungry Harbor — catalog `type: "S"`, deriving its events from Astoria (Tongue Point). */
  const SUBORDINATE_STATION = {
    id: '9440563',
    name: 'Hungry Harbor, Wash.',
    lat: 46.2583,
    lng: -123.848,
    state: 'WA',
    type: 'S',
    reference_id: '9439040',
  };

  /** Seattle — catalog `type: "R"`, published from its own harmonic analysis. */
  const REFERENCE_STATION = {
    id: '9447130',
    name: 'Seattle',
    lat: 47.6,
    lng: -122.33,
    state: 'WA',
    type: 'R',
    reference_id: '',
  };

  const SIX_MIN_CURVE = [
    { t: '2025-01-15 00:00', v: '3.21' },
    { t: '2025-01-15 00:06', v: '3.24' },
  ];

  it('rejects interval 6min on a subordinate station before calling CO-OPS, naming hilo and its reference station', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetTidePredictions.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(svc, 'getStations').mockResolvedValue([SUBORDINATE_STATION] as any);
    const fetchSpy = vi
      .spyOn(svc, 'fetchTidePredictions')
      .mockResolvedValue({ predictions: [], stationName: 'x' });

    const input = noaaMarineGetTidePredictions.input.parse({
      station_id: '9440563',
      begin_date: '20250115',
      end_date: '20250115',
      interval: '6min',
    });
    const err = await Promise.resolve(noaaMarineGetTidePredictions.handler(input, ctx)).catch(
      (e: unknown) => e,
    );

    expect(err).toMatchObject({ data: { reason: 'subordinate_no_6min' } });
    const hint = (err as { data: { recovery?: { hint?: string } } }).data.recovery?.hint ?? '';
    expect(hint).toContain('hilo');
    expect(hint).toContain('9439040');
    // CO-OPS answers this request with the same message an unaccepted datum produces, so the
    // point of reading the class is not spending the call at all.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('omits the reference station from the recovery when the catalog row carries none', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetTidePredictions.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    vi.spyOn(svc, 'getStations').mockResolvedValue([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { ...SUBORDINATE_STATION, reference_id: '' } as any,
    ]);
    vi.spyOn(svc, 'fetchTidePredictions').mockResolvedValue({
      predictions: [],
      stationName: 'x',
    });

    const input = noaaMarineGetTidePredictions.input.parse({
      station_id: '9440563',
      begin_date: '20250115',
      end_date: '20250115',
      interval: '6min',
    });
    const err = await Promise.resolve(noaaMarineGetTidePredictions.handler(input, ctx)).catch(
      (e: unknown) => e,
    );

    const hint = (err as { data: { recovery?: { hint?: string } } }).data.recovery?.hint ?? '';
    expect(hint).toContain('hilo');
    expect(hint).not.toContain('reference station ');
  });

  it('still serves a subordinate station its hilo events', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetTidePredictions.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(svc, 'getStations').mockResolvedValue([SUBORDINATE_STATION] as any);
    vi.spyOn(svc, 'fetchTidePredictions').mockResolvedValue({
      predictions: TIDE_PREDICTIONS,
      stationName: 'Hungry Harbor, Wash.',
    });

    const input = noaaMarineGetTidePredictions.input.parse({
      station_id: '9440563',
      begin_date: '20250115',
      end_date: '20250115',
    });
    const result = await noaaMarineGetTidePredictions.handler(input, ctx);

    expect(result.predictions).toHaveLength(2);
  });

  it('still serves a reference station its 6-minute curve', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetTidePredictions.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(svc, 'getStations').mockResolvedValue([REFERENCE_STATION] as any);
    vi.spyOn(svc, 'fetchTidePredictions').mockResolvedValue({
      predictions: SIX_MIN_CURVE,
      stationName: 'Seattle',
    });

    const input = noaaMarineGetTidePredictions.input.parse({
      station_id: '9447130',
      begin_date: '20250115',
      end_date: '20250115',
      interval: '6min',
    });
    const result = await noaaMarineGetTidePredictions.handler(input, ctx);

    expect(result.predictions).toHaveLength(2);
    expect(result.predictions[0]).toMatchObject({ time: '2025-01-15 00:00', height: 3.21 });
  });

  it('asks CO-OPS anyway when the catalog could not be read, rather than blocking the request', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetTidePredictions.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    vi.spyOn(svc, 'getStations').mockRejectedValue(new Error('CO-OPS catalog down'));
    vi.spyOn(svc, 'fetchTidePredictions').mockResolvedValue({
      predictions: SIX_MIN_CURVE,
      stationName: 'Seattle',
    });

    const input = noaaMarineGetTidePredictions.input.parse({
      station_id: '9447130',
      begin_date: '20250115',
      end_date: '20250115',
      interval: '6min',
    });
    const result = await noaaMarineGetTidePredictions.handler(input, ctx);

    expect(result.predictions).toHaveLength(2);
    expect(result.station_name).toBe('Seattle');
  });

  // --- #25: the datum enum matches what the predictions product accepts, and a datum the
  // station does not carry is reported as such rather than as a bad station ID ---

  describe('datum', () => {
    /** The byte-identical sentence CO-OPS returns for an unaccepted datum and for other causes. */
    const AMBIGUOUS =
      'CO-OPS error: No Predictions data was found. Please make sure the Datum input is valid.';

    it('accepts every datum the predictions product serves', () => {
      for (const datum of [
        'MLLW',
        'MHHW',
        'MHW',
        'MTL',
        'MSL',
        'MLW',
        'DTL',
        'NAVD',
        'STND',
        'CRD',
      ]) {
        const parsed = noaaMarineGetTidePredictions.input.parse({
          station_id: '9447130',
          begin_date: '20260918',
          end_date: '20260918',
          datum,
        });
        expect(parsed.datum).toBe(datum);
      }
    });

    it('rejects CD at the schema, which CO-OPS accepts at no station', () => {
      expect(() =>
        noaaMarineGetTidePredictions.input.parse({
          station_id: '9447130',
          begin_date: '20260918',
          end_date: '20260918',
          datum: 'CD',
        }),
      ).toThrow();
    });

    it('reports a datum the station does not carry as datum_unavailable, naming MLLW and STND', async () => {
      const ctx = createMockContext({ errors: noaaMarineGetTidePredictions.errors });

      const { getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      vi.spyOn(svc, 'getStations').mockResolvedValue([] as never);
      vi.spyOn(svc, 'fetchTidePredictions').mockRejectedValue(
        new CoopsBodyError('datum_unavailable', AMBIGUOUS),
      );

      const input = noaaMarineGetTidePredictions.input.parse({
        station_id: '9439040',
        begin_date: '20260918',
        end_date: '20260918',
        datum: 'NAVD',
      });
      const err = await Promise.resolve(noaaMarineGetTidePredictions.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).toMatchObject({ data: { reason: 'datum_unavailable' } });
      const hint = (err as { data: { recovery?: { hint?: string } } }).data.recovery?.hint ?? '';
      expect(hint).toContain('NAVD88');
      expect(hint).toContain('MLLW');
      expect(hint).toContain('STND');
      // The station ID came from find_stations and is fine — do not send the caller back to it.
      expect(hint).not.toContain('noaa_marine_find_stations');
    });

    it('keeps no_predictions for the same sentence when MLLW was requested', async () => {
      const ctx = createMockContext({ errors: noaaMarineGetTidePredictions.errors });

      const { getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      vi.spyOn(svc, 'getStations').mockResolvedValue([] as never);
      // The service arm resolves the ambiguity from the requested datum; MLLW yields no_predictions.
      vi.spyOn(svc, 'fetchTidePredictions').mockRejectedValue(
        new CoopsBodyError('no_predictions', AMBIGUOUS),
      );

      const input = noaaMarineGetTidePredictions.input.parse({
        station_id: '9447130',
        begin_date: '20260918',
        end_date: '20260918',
      });
      await expect(noaaMarineGetTidePredictions.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'no_predictions' },
      });
    });

    it('does not report the Great Lakes predictions refusal as station_not_found', async () => {
      const ctx = createMockContext({ errors: noaaMarineGetTidePredictions.errors });

      const { getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      vi.spyOn(svc, 'getStations').mockResolvedValue([] as never);
      vi.spyOn(svc, 'fetchTidePredictions').mockRejectedValue(
        new CoopsBodyError(
          'great_lakes_no_predictions',
          "CO-OPS error: Great Lakes stations don't have Predictions data.",
        ),
      );

      const input = noaaMarineGetTidePredictions.input.parse({
        station_id: '9087044',
        begin_date: '20260918',
        end_date: '20260918',
      });
      const err = await Promise.resolve(noaaMarineGetTidePredictions.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).not.toMatchObject({ data: { reason: 'station_not_found' } });
      expect(err).toMatchObject({ data: { reason: 'no_predictions' } });
      const hint = (err as { data: { recovery?: { hint?: string } } }).data.recovery?.hint ?? '';
      // A Great Lakes station has no prediction series at any datum; observed levels are the answer.
      expect(hint).toContain('noaa_marine_get_water_level');
    });
  });

  // --- #18: the page is bounded by serialized payload size, identical on both surfaces ---

  describe('paging', () => {
    /** Four hilo events a day at their real width — 31 days fits the budget, a year does not. */
    function hiloDays(days: number, month = '07'): { t: string; type: string; v: string }[] {
      const rows: { t: string; type: string; v: string }[] = [];
      for (let d = 0; d < days; d += 1) {
        const day = String((d % 31) + 1).padStart(2, '0');
        const year = 2025 + Math.floor(d / 31);
        rows.push({ t: `${year}-${month}-${day} 02:14`, type: 'H', v: '10.42' });
        rows.push({ t: `${year}-${month}-${day} 08:51`, type: 'L', v: '1.07' });
        rows.push({ t: `${year}-${month}-${day} 15:03`, type: 'H', v: '11.86' });
        rows.push({ t: `${year}-${month}-${day} 21:37`, type: 'L', v: '-0.34' });
      }
      return rows;
    }

    /** A 6-minute curve row: `{"time":"…","height":…}` — narrow, so pages are long. */
    function sixMin(count: number): { t: string; v: string }[] {
      return Array.from({ length: count }, (_, i) => {
        const minutes = i * 6;
        const day = String(1 + Math.floor(minutes / 1440)).padStart(2, '0');
        const hour = String(Math.floor((minutes % 1440) / 60)).padStart(2, '0');
        const minute = String(minutes % 60).padStart(2, '0');
        return { t: `2025-07-${day} ${hour}:${minute}`, v: (3 + (i % 100) / 100).toFixed(3) };
      });
    }

    async function mockPredictions(rows: readonly { t: string; v: string }[]) {
      const { getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      vi.spyOn(svc, 'getStations').mockResolvedValue([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: '9447130', lat: 47.6, lng: -122.33, name: 'Seattle', state: 'WA', type: 'R' } as any,
      ]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(svc, 'fetchTidePredictions').mockResolvedValue({
        predictions: rows as any,
        stationName: 'Seattle',
      });
      return svc;
    }

    it('returns a 31-day hilo call byte-identical to the unpaged output, with no disclosure', async () => {
      await mockPredictions(hiloDays(31));
      const result = await runToolContract(noaaMarineGetTidePredictions, {
        begin_date: '20250701',
        end_date: '20250731',
        station_id: '9447130',
      });
      const structured = result.structuredContent as Record<string, unknown>;

      // Captured against the pre-paging tool for this exact fixture: 124 events, 6,763 bytes of
      // structuredContent and 4,200 bytes of text. Both surfaces must stay on those numbers.
      expect((structured.predictions as unknown[]).length).toBe(124);
      expect(JSON.stringify(structured).length).toBe(6763);
      expect(result.content).toHaveLength(1);
      expect(result.content.map((b) => (b as { text?: string }).text ?? '').join('').length).toBe(
        4200,
      );
      expect(structured).not.toHaveProperty('truncated');
      expect(structured).not.toHaveProperty('rows_matched');
      expect(structured).not.toHaveProperty('next_offset');
      expect(structured).not.toHaveProperty('notice');
    });

    it('pages a year of hilo events, which does not fit the budget', async () => {
      await mockPredictions(hiloDays(365));
      const result = await runToolContract(noaaMarineGetTidePredictions, {
        begin_date: '20250101',
        end_date: '20251231',
        station_id: '9447130',
      });
      const structured = result.structuredContent as Record<string, unknown>;

      expect(structured.rows_matched).toBe(1460);
      expect((structured.predictions as unknown[]).length).toBeLessThan(1460);
      expect(JSON.stringify(structured.predictions).length).toBeLessThanOrEqual(24_000);
      expect(structured.truncated).toBe(true);
      expect(structured.next_offset).toBe(structured.rows_returned);

      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain('1460');
      expect(text).toContain('offset');
    });

    it('walks a 6-minute curve first page to empty page and reassembles the whole series', async () => {
      const rows = sixMin(2400);
      await mockPredictions(rows);
      const times: string[] = [];
      let offset: number | null = 0;
      let pages = 0;

      while (offset !== null) {
        const result = await runToolContract(noaaMarineGetTidePredictions, {
          begin_date: '20250701',
          end_date: '20250710',
          interval: '6min',
          offset,
          station_id: '9447130',
        });
        const structured = result.structuredContent as {
          next_offset?: number | null;
          predictions: { time: string }[];
        };
        times.push(...structured.predictions.map((p) => p.time));
        pages += 1;
        offset = structured.next_offset ?? null;
        expect(pages).toBeLessThan(40);
      }

      expect(pages).toBeGreaterThanOrEqual(3);
      expect(times).toEqual(rows.map((r) => r.t));
    });

    it('returns an empty page past the last one rather than an error', async () => {
      await mockPredictions(hiloDays(365));
      const result = await runToolContract(noaaMarineGetTidePredictions, {
        begin_date: '20250101',
        end_date: '20251231',
        offset: 1460,
        station_id: '9447130',
      });
      const structured = result.structuredContent as Record<string, unknown>;

      expect(result.isError).toBeFalsy();
      expect(structured.predictions).toEqual([]);
      expect(structured.rows_returned).toBe(0);
      expect(structured.next_offset).toBeNull();
      expect(structured.truncated).toBe(false);
    });

    it('renders exactly the page, with no head slice', async () => {
      await mockPredictions(hiloDays(365));
      const result = await runToolContract(noaaMarineGetTidePredictions, {
        begin_date: '20250101',
        end_date: '20251231',
        station_id: '9447130',
      });
      const structured = result.structuredContent as { predictions: { time: string }[] };
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');

      for (const p of structured.predictions) expect(text).toContain(p.time);
    });

    it('lets limit lower the page', async () => {
      await mockPredictions(hiloDays(365));
      const result = await runToolContract(noaaMarineGetTidePredictions, {
        begin_date: '20250101',
        end_date: '20251231',
        limit: 4,
        station_id: '9447130',
      });
      const structured = result.structuredContent as Record<string, unknown>;

      expect(structured.predictions).toHaveLength(4);
      expect(structured.next_offset).toBe(4);
    });

    it('still reports an empty upstream series as no_predictions rather than an empty page', async () => {
      const ctx = createMockContext({ errors: noaaMarineGetTidePredictions.errors });
      await mockPredictions([]);
      const input = noaaMarineGetTidePredictions.input.parse({
        begin_date: '20250101',
        end_date: '20250101',
        station_id: '9447130',
      });
      await expect(noaaMarineGetTidePredictions.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'no_predictions' },
      });
    });
  });

  it('format renders station name, datum, and at least one prediction entry', () => {
    const output = {
      station_id: '9447130',
      station_name: 'Seattle',
      datum: 'MLLW',
      units: 'english',
      predictions: [
        { time: '2025-01-15 06:23', height: 5.42, type: 'H' },
        { time: '2025-01-15 12:51', height: -0.31, type: 'L' },
      ],
    };
    const blocks = noaaMarineGetTidePredictions.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Seattle');
    expect(text).toContain('9447130');
    expect(text).toContain('MLLW');
    expect(text).toContain('5.42');
    expect(text).toContain('HIGH');
  });
});

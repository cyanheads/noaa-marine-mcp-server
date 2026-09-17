/**
 * @fileoverview Tests for noaa_marine_get_water_level tool.
 * @module tests/mcp-server/tools/noaa-marine-get-water-level.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaMarineGetWaterLevel } from '@/mcp-server/tools/definitions/noaa-marine-get-water-level.tool.js';
import { initCoopsService } from '@/services/coops/coops-service.js';

const OBS_ROWS = [
  { t: '2025-01-15 12:00', v: '8.23', s: '0.01', f: '0,0,0,0', q: 'p' },
  { t: '2025-01-15 12:06', v: '8.31', s: '0.01', f: '0,0,0,0', q: 'p' },
];

const PRED_ROWS = [
  { t: '2025-01-15 12:00', v: '8.20' },
  { t: '2025-01-15 12:06', v: '8.28' },
];

function setupCoops() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initCoopsService(null as any, null as any, { applicationId: 'test' });
}

describe('noaaMarineGetWaterLevel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setupCoops();
  });

  it('returns observations with paired predictions and residual_summary', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetWaterLevel.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    vi.spyOn(svc, 'fetchWaterLevel').mockResolvedValue({ data: OBS_ROWS, stationName: 'Seattle' });
    vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue(PRED_ROWS);

    const input = noaaMarineGetWaterLevel.input.parse({
      station_id: '9447130',
      begin_date: '20250115',
      end_date: '20250115',
    });
    const result = await noaaMarineGetWaterLevel.handler(input, ctx);

    expect(result.station_id).toBe('9447130');
    expect(result.station_name).toBe('Seattle');
    expect(result.datum).toBe('MLLW');
    expect(result.observations).toHaveLength(2);
    expect(result.observations[0]).toMatchObject({
      time: '2025-01-15 12:00',
      value: 8.23,
      quality: 'p',
    });
    expect(result.predictions).toHaveLength(2);
    expect(result.residual_summary).toBeDefined();
    // residual: 8.23 - 8.20 = 0.03 max surge (english units → feet)
    expect(result.residual_summary!.max_surge).toBeCloseTo(0.03, 1);
  });

  it('throws ctx.fail("date_range_exceeded") for range > 31 days', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetWaterLevel.errors });
    const input = noaaMarineGetWaterLevel.input.parse({
      station_id: '9447130',
      begin_date: '20250101',
      end_date: '20250301',
    });
    await expect(noaaMarineGetWaterLevel.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'date_range_exceeded' },
    });
  });

  it('throws ctx.fail("invalid_date_range") for an impossible calendar date, without calling CO-OPS', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetWaterLevel.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    const fetchSpy = vi
      .spyOn(svc, 'fetchWaterLevel')
      .mockResolvedValue({ data: [], stationName: 'x' });

    const input = noaaMarineGetWaterLevel.input.parse({
      station_id: '9447130',
      begin_date: '20250231', // Feb 31 — does not exist
      end_date: '20250302',
    });
    await expect(noaaMarineGetWaterLevel.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_date_range' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws ctx.fail("invalid_date_range") for a reversed range, without calling CO-OPS', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetWaterLevel.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    const fetchSpy = vi
      .spyOn(svc, 'fetchWaterLevel')
      .mockResolvedValue({ data: [], stationName: 'x' });

    const input = noaaMarineGetWaterLevel.input.parse({
      station_id: '9447130',
      begin_date: '20250310',
      end_date: '20250301', // before begin_date
    });
    await expect(noaaMarineGetWaterLevel.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_date_range' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws ctx.fail("station_not_found") on CO-OPS station error', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetWaterLevel.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    // CO-OPS returns HTTP 400 for invalid station IDs — simulate with McpError + status
    vi.spyOn(getCoopsService(), 'fetchWaterLevel').mockRejectedValue(
      new McpError(JsonRpcErrorCode.InvalidParams, 'CO-OPS fetch failed', { status: 400 }),
    );

    const input = noaaMarineGetWaterLevel.input.parse({
      station_id: '0000000',
      begin_date: '20250115',
      end_date: '20250115',
    });
    await expect(noaaMarineGetWaterLevel.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'station_not_found' },
    });
  });

  it('throws ctx.fail("no_data") when observation array is empty', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetWaterLevel.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    vi.spyOn(svc, 'fetchWaterLevel').mockResolvedValue({ data: [], stationName: 'Empty' });
    vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue([]);

    const input = noaaMarineGetWaterLevel.input.parse({
      station_id: '9999999',
      begin_date: '20250115',
      end_date: '20250115',
    });
    await expect(noaaMarineGetWaterLevel.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_data' },
    });
  });

  // --- #21: a failed prediction fetch is not the same fact as "CO-OPS has no predictions" ---

  it('returns the observed series when the prediction fetch fails, and says the series is unavailable', async () => {
    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    vi.spyOn(svc, 'fetchWaterLevel').mockResolvedValue({ data: OBS_ROWS, stationName: 'Seattle' });
    vi.spyOn(svc, 'fetchWaterLevelPredictions').mockRejectedValue(new Error('pred fetch failed'));

    const result = await runToolContract(noaaMarineGetWaterLevel, {
      station_id: '9447130',
      begin_date: '20250115',
      end_date: '20250115',
    });
    const structured = result.structuredContent as Record<string, unknown>;

    // The observed series still returns, and no residual is computed without predictions.
    expect(structured.observations).toHaveLength(2);
    expect(structured.predictions).toHaveLength(0);
    expect(structured.residual_summary).toBeUndefined();
    // The reason the comparison series is missing reaches both surfaces, not just the log.
    expect(structured.predictions_status).toBe('unavailable');
    expect(structured.notice).toContain('prediction');

    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('unavailable');
  });

  it('distinguishes a failed prediction fetch from a genuinely empty prediction series', async () => {
    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    vi.spyOn(svc, 'fetchWaterLevel').mockResolvedValue({ data: OBS_ROWS, stationName: 'Seattle' });
    vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue([]);

    const empty = await runToolContract(noaaMarineGetWaterLevel, {
      station_id: '9447130',
      begin_date: '20250115',
      end_date: '20250115',
    });
    const emptyStructured = empty.structuredContent as Record<string, unknown>;

    // Same predictions: [] and same absent residual_summary as the failed fetch — the two are
    // told apart by predictions_status alone.
    expect(emptyStructured.predictions).toHaveLength(0);
    expect(emptyStructured.residual_summary).toBeUndefined();
    expect(emptyStructured.predictions_status).toBe('empty');
    expect(emptyStructured.predictions_status).not.toBe('unavailable');

    const emptyText = empty.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(emptyText).toContain('empty');
  });

  it('marks no prediction status when the prediction series came back populated', async () => {
    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const svc = getCoopsService();
    vi.spyOn(svc, 'fetchWaterLevel').mockResolvedValue({ data: OBS_ROWS, stationName: 'Seattle' });
    vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue(PRED_ROWS);

    const result = await runToolContract(noaaMarineGetWaterLevel, {
      station_id: '9447130',
      begin_date: '20250115',
      end_date: '20250115',
    });
    const structured = result.structuredContent as Record<string, unknown>;

    expect(structured.predictions).toHaveLength(2);
    expect(structured).not.toHaveProperty('predictions_status');
    expect(structured).not.toHaveProperty('notice');
  });

  it('format renders station name, datum, and observation values', () => {
    const output = {
      station_id: '9447130',
      station_name: 'Seattle',
      datum: 'MLLW',
      units: 'english',
      interval: '6min' as const,
      observations: [{ time: '2025-01-15 12:00', value: 8.23, sigma: 0.01, quality: 'p' }],
      predictions: [{ time: '2025-01-15 12:00', value: 8.2 }],
      residual_summary: { max_surge: 0.03, max_drawdown: 0 },
    };
    const blocks = noaaMarineGetWaterLevel.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Seattle');
    expect(text).toContain('MLLW');
    expect(text).toContain('8.23');
    expect(text).toContain('9447130');
  });

  // --- #25: the datum enum matches what the water_level product accepts, and a datum a station
  // does not carry is its own reason rather than a bogus instruction to re-verify the ID ---

  describe('datum', () => {
    /** Calumet Harbor — the `waterlevels` catalog marks it `greatlakes: true`. */
    const GREAT_LAKES_STATION = {
      id: '9087044',
      name: 'Calumet Harbor',
      lat: 41.72972,
      lng: -87.53833,
      state: 'IL',
      greatlakes: true,
    };

    const COASTAL_STATION = {
      id: '9447130',
      name: 'Seattle',
      lat: 47.6,
      lng: -122.33,
      state: 'WA',
      greatlakes: false,
    };

    it('accepts every datum the water_level product serves', () => {
      for (const datum of [
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
        'LWI',
        'HWI',
      ]) {
        const parsed = noaaMarineGetWaterLevel.input.parse({
          station_id: '9447130',
          begin_date: '20260916',
          end_date: '20260916',
          datum,
        });
        expect(parsed.datum).toBe(datum);
      }
    });

    it('rejects CD at the schema, which CO-OPS accepts at no station', () => {
      expect(() =>
        noaaMarineGetWaterLevel.input.parse({
          station_id: '9447130',
          begin_date: '20260916',
          end_date: '20260916',
          datum: 'CD',
        }),
      ).toThrow();
    });

    it('reports a datum the station does not carry as datum_unavailable, naming the Great Lakes datums', async () => {
      const ctx = createMockContext({ errors: noaaMarineGetWaterLevel.errors });
      const { CoopsBodyError, getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(svc, 'getStations').mockResolvedValue([GREAT_LAKES_STATION] as any);
      vi.spyOn(svc, 'fetchWaterLevel').mockRejectedValue(
        new CoopsBodyError(
          'datum_unavailable',
          'CO-OPS error:  There is no MLLW for the station: 9087044',
        ),
      );
      vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue([]);

      const input = noaaMarineGetWaterLevel.input.parse({
        station_id: '9087044',
        begin_date: '20260916',
        end_date: '20260916',
      });
      const err = await Promise.resolve(noaaMarineGetWaterLevel.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).toMatchObject({ data: { reason: 'datum_unavailable' } });
      const hint = (err as { data: { recovery?: { hint?: string } } }).data.recovery?.hint ?? '';
      expect(hint).toContain('STND');
      expect(hint).toContain('IGLD');
      expect(hint).toContain('LWD');
      // The station ID is good — nothing in the recovery sends the caller back to find_stations.
      expect(hint).not.toContain('noaa_marine_find_stations');
    });

    it('says a station rejecting NAVD has no NAVD88 tie and names MLLW and STND', async () => {
      const ctx = createMockContext({ errors: noaaMarineGetWaterLevel.errors });
      const { CoopsBodyError, getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(svc, 'getStations').mockResolvedValue([COASTAL_STATION] as any);
      vi.spyOn(svc, 'fetchWaterLevel').mockRejectedValue(
        new CoopsBodyError(
          'datum_unavailable',
          'CO-OPS error:  The supported Datum values are: MHHW, MHW, MTL, MSL, MLW, MLLW, LWI, HWI',
        ),
      );
      vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue([]);

      const input = noaaMarineGetWaterLevel.input.parse({
        station_id: '9447130',
        begin_date: '20260916',
        end_date: '20260916',
        datum: 'NAVD',
      });
      const err = await Promise.resolve(noaaMarineGetWaterLevel.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).toMatchObject({ data: { reason: 'datum_unavailable' } });
      const hint = (err as { data: { recovery?: { hint?: string } } }).data.recovery?.hint ?? '';
      expect(hint).toContain('NAVD88');
      expect(hint).toContain('MLLW');
      expect(hint).toContain('STND');
    });

    it('never echoes the CO-OPS supported-datum list, which is station-specific and incomplete', async () => {
      const ctx = createMockContext({ errors: noaaMarineGetWaterLevel.errors });
      const { CoopsBodyError, getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(svc, 'getStations').mockResolvedValue([COASTAL_STATION] as any);
      vi.spyOn(svc, 'fetchWaterLevel').mockRejectedValue(
        new CoopsBodyError(
          'datum_unavailable',
          'CO-OPS error:  The supported Datum values are: MHHW, MHW, MTL, MSL, MLW, MLLW, LWI, HWI',
        ),
      );
      vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue([]);

      const input = noaaMarineGetWaterLevel.input.parse({
        station_id: '9447130',
        begin_date: '20260916',
        end_date: '20260916',
        datum: 'CRD',
      });
      const err = await Promise.resolve(noaaMarineGetWaterLevel.handler(input, ctx)).catch(
        (e: unknown) => e,
      );
      const hint = (err as { data: { recovery?: { hint?: string } } }).data.recovery?.hint ?? '';
      expect(hint).not.toContain('supported Datum values');
    });

    it('still reports a genuinely unknown station ID as station_not_found', async () => {
      const ctx = createMockContext({ errors: noaaMarineGetWaterLevel.errors });
      const { CoopsBodyError, getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      vi.spyOn(svc, 'fetchWaterLevel').mockRejectedValue(
        new CoopsBodyError(
          'station_error',
          'CO-OPS error:  Wrong Station ID: Please submit a valid station ID ',
        ),
      );
      vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue([]);

      const input = noaaMarineGetWaterLevel.input.parse({
        station_id: '0000000',
        begin_date: '20260916',
        end_date: '20260916',
      });
      await expect(noaaMarineGetWaterLevel.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'station_not_found' },
      });
    });

    it('reports a prediction series CO-OPS does not publish as empty rather than a failed fetch', async () => {
      const { CoopsBodyError, getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      vi.spyOn(svc, 'fetchWaterLevel').mockResolvedValue({
        data: OBS_ROWS,
        stationName: 'Calumet Harbor',
      });
      vi.spyOn(svc, 'fetchWaterLevelPredictions').mockRejectedValue(
        new CoopsBodyError(
          'great_lakes_no_predictions',
          "CO-OPS error: Great Lakes stations don't have Predictions data.",
        ),
      );

      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '9087044',
        begin_date: '20260916',
        end_date: '20260916',
        datum: 'STND',
      });
      const structured = result.structuredContent as Record<string, unknown>;

      expect(structured.observations).toHaveLength(2);
      // Not 'unavailable' — CO-OPS answered, and its answer was "none exist". Telling the caller
      // to retry would be advice for a condition that will never change.
      expect(structured.predictions_status).toBe('empty');
    });
  });

  // --- #22: CO-OPS gap rows (`v: ""`) must not sink an otherwise complete response ---

  describe('gap rows', () => {
    /** Verbatim from CO-OPS: `v` and `s` empty, `f` all-ones, `q` preliminary. */
    const GAP_ROWS = [
      { t: '2026-09-10 14:06', v: '8.11', s: '0.01', f: '0,0,0,0', q: 'p' },
      { t: '2026-09-10 14:12', v: '', s: '', f: '1,1,1,1', q: 'p' },
      { t: '2026-09-10 14:18', v: '', s: '', f: '1,1,1,1', q: 'p' },
      { t: '2026-09-10 14:24', v: '', s: '', f: '1,1,1,1', q: 'p' },
      { t: '2026-09-10 14:30', v: '8.44', s: '0.02', f: '0,0,0,0', q: 'p' },
    ];

    const GAP_PRED_ROWS = [
      { t: '2026-09-10 14:06', v: '8.00' },
      { t: '2026-09-10 14:12', v: '8.10' },
      { t: '2026-09-10 14:18', v: '8.20' },
      { t: '2026-09-10 14:24', v: '8.30' },
      { t: '2026-09-10 14:30', v: '8.40' },
    ];

    it('returns every parseable observation instead of failing the whole call', async () => {
      const ctx = createMockContext({ errors: noaaMarineGetWaterLevel.errors });
      const { getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      vi.spyOn(svc, 'fetchWaterLevel').mockResolvedValue({
        data: GAP_ROWS,
        stationName: 'Boston',
      });
      vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue(GAP_PRED_ROWS);

      const input = noaaMarineGetWaterLevel.input.parse({
        station_id: '8443970',
        begin_date: '20260910',
        end_date: '20260916',
      });
      const result = await noaaMarineGetWaterLevel.handler(input, ctx);

      expect(result.observations).toHaveLength(2);
      expect(result.observations.map((o) => o.value)).toEqual([8.11, 8.44]);
      for (const obs of result.observations) expect(Number.isFinite(obs.value)).toBe(true);
    });

    it('computes the residual summary only from the finite pairs', async () => {
      const ctx = createMockContext({ errors: noaaMarineGetWaterLevel.errors });
      const { getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      vi.spyOn(svc, 'fetchWaterLevel').mockResolvedValue({
        data: GAP_ROWS,
        stationName: 'Boston',
      });
      vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue(GAP_PRED_ROWS);

      const input = noaaMarineGetWaterLevel.input.parse({
        station_id: '8443970',
        begin_date: '20260910',
        end_date: '20260916',
      });
      const result = await noaaMarineGetWaterLevel.handler(input, ctx);

      // Only the two finite pairs join: 8.11 − 8.00 = 0.11 and 8.44 − 8.40 = 0.04. The three
      // gap slots have a prediction but no observation, so they contribute no residual at all.
      expect(result.residual_summary).toEqual({ max_surge: 0.11, max_drawdown: 0.04 });
    });

    it('discloses the dropped-gap count on both consumption surfaces', async () => {
      const { getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      vi.spyOn(svc, 'fetchWaterLevel').mockResolvedValue({
        data: GAP_ROWS,
        stationName: 'Boston',
      });
      vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue(GAP_PRED_ROWS);

      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '8443970',
        begin_date: '20260910',
        end_date: '20260916',
      });
      const structured = result.structuredContent as Record<string, unknown>;

      // structuredContent clients: the count is a declared field.
      expect(structured.gaps_dropped).toBe(3);
      expect(structured.observations).toHaveLength(2);
      // format()-only clients: the same fact rides the content[] trailer, so neither surface can
      // read two returned rows as five slots of continuous coverage.
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      // The count in its sentence — a bare "3" would match any timestamp in the rendered rows.
      expect(text).toContain('3 of the 5 sample slots');
      expect(text).toContain('Sensor gaps');
    });

    it('says nothing about gaps when the response carried none', async () => {
      const { getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      vi.spyOn(svc, 'fetchWaterLevel').mockResolvedValue({
        data: OBS_ROWS,
        stationName: 'Seattle',
      });
      vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue(PRED_ROWS);

      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '9447130',
        begin_date: '20250115',
        end_date: '20250115',
      });
      const structured = result.structuredContent as Record<string, unknown>;

      // Regression pin: a gap-free response is byte-for-byte what it returns today.
      expect(structured).not.toHaveProperty('gaps_dropped');
      expect(structured).not.toHaveProperty('notice');
      expect(structured.observations).toEqual([
        { time: '2025-01-15 12:00', value: 8.23, sigma: 0.01, quality: 'p' },
        { time: '2025-01-15 12:06', value: 8.31, sigma: 0.01, quality: 'p' },
      ]);
      expect(structured.residual_summary).toEqual({ max_surge: 0.03, max_drawdown: 0.03 });
    });

    it('reports no_data when every row CO-OPS sent was a gap', async () => {
      const ctx = createMockContext({ errors: noaaMarineGetWaterLevel.errors });
      const { getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      vi.spyOn(svc, 'fetchWaterLevel').mockResolvedValue({
        data: GAP_ROWS.filter((row) => row.v === ''),
        stationName: 'East Bay',
      });
      vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue([]);

      const input = noaaMarineGetWaterLevel.input.parse({
        station_id: '8726674',
        begin_date: '20260910',
        end_date: '20260916',
      });
      await expect(noaaMarineGetWaterLevel.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'no_data' },
      });
    });

    it('keeps sigma off a gap row and on the rows that carry one', async () => {
      const ctx = createMockContext({ errors: noaaMarineGetWaterLevel.errors });
      const { getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      vi.spyOn(svc, 'fetchWaterLevel').mockResolvedValue({
        data: GAP_ROWS,
        stationName: 'Boston',
      });
      vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue([]);

      const input = noaaMarineGetWaterLevel.input.parse({
        station_id: '8443970',
        begin_date: '20260910',
        end_date: '20260916',
      });
      const result = await noaaMarineGetWaterLevel.handler(input, ctx);

      expect(result.observations[0]?.sigma).toBe(0.01);
      expect(result.observations[1]?.sigma).toBe(0.02);
    });
  });

  // --- #18: the page is bounded by serialized payload size, identical on both surfaces ---

  describe('paging', () => {
    /** A 6-minute slot at its real CO-OPS width, three days of them — enough for several pages. */
    function slot(index: number): { f: string; q: string; s: string; t: string; v: string } {
      const minutes = index * 6;
      const day = String(1 + Math.floor(minutes / 1440)).padStart(2, '0');
      const hour = String(Math.floor((minutes % 1440) / 60)).padStart(2, '0');
      const minute = String(minutes % 60).padStart(2, '0');
      return {
        f: '0,0,0,0',
        q: 'p',
        s: '0.014',
        t: `2026-09-${day} ${hour}:${minute}`,
        v: (8 + (index % 100) / 100).toFixed(3),
      };
    }

    const THREE_DAYS = Array.from({ length: 720 }, (_, i) => slot(i));
    const THREE_DAYS_PRED = THREE_DAYS.map((row) => ({
      t: row.t,
      v: (Number.parseFloat(row.v) - 0.05).toFixed(3),
    }));

    async function mockThreeDays() {
      const { getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      vi.spyOn(svc, 'fetchWaterLevel').mockResolvedValue({
        data: THREE_DAYS,
        stationName: 'Seattle',
      });
      vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue(THREE_DAYS_PRED);
    }

    const BUDGET = 24_000;

    it('bounds the page by serialized payload size rather than returning every row', async () => {
      await mockThreeDays();
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '9447130',
        begin_date: '20260901',
        end_date: '20260903',
      });
      const structured = result.structuredContent as {
        observations: unknown[];
        predictions: unknown[];
      };

      expect(structured.observations.length).toBeLessThan(720);
      expect(
        JSON.stringify(structured.observations).length +
          JSON.stringify(structured.predictions).length,
      ).toBeLessThanOrEqual(BUDGET);
    });

    it('discloses the row accounting and the next offset on both consumption surfaces', async () => {
      await mockThreeDays();
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '9447130',
        begin_date: '20260901',
        end_date: '20260903',
      });
      const structured = result.structuredContent as Record<string, unknown>;

      expect(structured.truncated).toBe(true);
      expect(structured.rows_matched).toBe(720);
      expect(structured.rows_returned).toBe((structured.observations as unknown[]).length);
      expect(structured.page_offset).toBe(0);
      expect(structured.next_offset).toBe(structured.rows_returned);

      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain('720');
      expect(text).toContain(String(structured.next_offset));
      expect(text).toContain('offset');
    });

    it('renders exactly the page it was given, with no head slice', async () => {
      await mockThreeDays();
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '9447130',
        begin_date: '20260901',
        end_date: '20260903',
      });
      const structured = result.structuredContent as {
        observations: { time: string }[];
        predictions: { time: string }[];
      };
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');

      // Every row on the page appears in the text surface, first and last included.
      for (const obs of structured.observations) expect(text).toContain(obs.time);
      expect(text).not.toContain('more observations');
      expect(text).not.toContain('more predictions');
      expect(structured.predictions.length).toBeGreaterThan(10);
    });

    it('walks first page to empty page and reassembles the whole series', async () => {
      await mockThreeDays();
      const times: string[] = [];
      const predTimes: string[] = [];
      let offset: number | null = 0;
      let pages = 0;

      while (offset !== null) {
        const result = await runToolContract(noaaMarineGetWaterLevel, {
          begin_date: '20260901',
          end_date: '20260903',
          offset,
          station_id: '9447130',
        });
        const structured = result.structuredContent as {
          next_offset?: number | null;
          observations: { time: string }[];
          predictions: { time: string }[];
        };
        times.push(...structured.observations.map((o) => o.time));
        predTimes.push(...structured.predictions.map((p) => p.time));
        pages += 1;
        offset = structured.next_offset ?? null;
        expect(pages).toBeLessThan(40);
      }

      expect(pages).toBeGreaterThanOrEqual(3);
      expect(times).toEqual(THREE_DAYS.map((r) => r.t));
      expect(predTimes).toEqual(THREE_DAYS_PRED.map((r) => r.t));
    });

    it('returns an empty page past the last one rather than an error', async () => {
      await mockThreeDays();
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        begin_date: '20260901',
        end_date: '20260903',
        offset: 720,
        station_id: '9447130',
      });
      const structured = result.structuredContent as Record<string, unknown>;

      expect(result.isError).toBeFalsy();
      expect(structured.observations).toEqual([]);
      expect(structured.predictions).toEqual([]);
      expect(structured.rows_returned).toBe(0);
      expect(structured.rows_matched).toBe(720);
      expect(structured.next_offset).toBeNull();
      expect(structured.truncated).toBe(false);
    });

    it('repeats no prediction on the empty page when the observed series ends before them', async () => {
      // A sensor silent for the last stretch of the range: the gap rows drop out of the
      // observed series while CO-OPS still predicts those slots, so the prediction series
      // runs past the last observation.
      const { getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      const observed = THREE_DAYS.slice(0, 700);
      vi.spyOn(svc, 'fetchWaterLevel').mockResolvedValue({
        data: observed,
        stationName: 'Seattle',
      });
      vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue(THREE_DAYS_PRED);

      const past = await runToolContract(noaaMarineGetWaterLevel, {
        begin_date: '20260901',
        end_date: '20260903',
        offset: observed.length,
        station_id: '9447130',
      });
      const structured = past.structuredContent as Record<string, unknown>;

      expect(past.isError).toBeFalsy();
      expect(structured.observations).toEqual([]);
      expect(structured.predictions).toEqual([]);
      expect(structured.rows_returned).toBe(0);
      expect(structured.next_offset).toBeNull();
    });

    it('lets limit lower the page and reports the smaller next offset', async () => {
      await mockThreeDays();
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        begin_date: '20260901',
        end_date: '20260903',
        limit: 3,
        station_id: '9447130',
      });
      const structured = result.structuredContent as Record<string, unknown>;

      expect(structured.observations).toHaveLength(3);
      expect(structured.rows_returned).toBe(3);
      expect(structured.next_offset).toBe(3);
    });

    it('never lets limit raise the page past the byte bound', async () => {
      await mockThreeDays();
      const bounded = await runToolContract(noaaMarineGetWaterLevel, {
        begin_date: '20260901',
        end_date: '20260903',
        station_id: '9447130',
      });
      const raised = await runToolContract(noaaMarineGetWaterLevel, {
        begin_date: '20260901',
        end_date: '20260903',
        limit: 10_000,
        station_id: '9447130',
      });

      expect((raised.structuredContent as { observations: unknown[] }).observations).toHaveLength(
        (bounded.structuredContent as { observations: unknown[] }).observations.length,
      );
    });

    it('computes the residual summary from the full matched series, not the page', async () => {
      const { getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      // The only surge in the range sits on the last slot, far past the first page.
      const spike = THREE_DAYS.map((row, i) =>
        i === 719 ? { ...row, v: (Number.parseFloat(row.v) + 4).toFixed(3) } : row,
      );
      vi.spyOn(svc, 'fetchWaterLevel').mockResolvedValue({ data: spike, stationName: 'Seattle' });
      vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue(THREE_DAYS_PRED);

      const result = await runToolContract(noaaMarineGetWaterLevel, {
        begin_date: '20260901',
        end_date: '20260903',
        station_id: '9447130',
      });
      const structured = result.structuredContent as {
        residual_summary?: { max_surge: number };
      };

      expect(structured.residual_summary?.max_surge).toBeCloseTo(4.05, 2);
    });

    it('returns a fitting range whole, with no paging disclosure at all', async () => {
      const { getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      vi.spyOn(svc, 'fetchWaterLevel').mockResolvedValue({
        data: OBS_ROWS,
        stationName: 'Seattle',
      });
      vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue(PRED_ROWS);

      const result = await runToolContract(noaaMarineGetWaterLevel, {
        begin_date: '20250115',
        end_date: '20250115',
        station_id: '9447130',
      });
      const structured = result.structuredContent as Record<string, unknown>;

      expect(structured).not.toHaveProperty('truncated');
      expect(structured).not.toHaveProperty('rows_matched');
      expect(structured).not.toHaveProperty('rows_returned');
      expect(structured).not.toHaveProperty('page_offset');
      expect(structured).not.toHaveProperty('next_offset');
      expect(structured).not.toHaveProperty('notice');
    });
  });

  // --- #30: the coarser CO-OPS water-level products ---

  describe('interval products', () => {
    /** Live `hourly_height` rows — `{t,v,s,f}`, no `q`. */
    const HOURLY_ROWS = [
      { t: '2025-01-01 00:00', v: '10.94', s: '0.026', f: '0,0' },
      { t: '2025-01-01 01:00', v: '10.12', s: '0.031', f: '0,0' },
    ];
    const HOURLY_PRED = [
      { t: '2025-01-01 00:00', v: '10.80' },
      { t: '2025-01-01 01:00', v: '10.02' },
    ];

    /** Live `high_low` rows — `{t,v,ty,f}`, `ty` space-padded on the singles. */
    const HIGH_LOW_ROWS = [
      { t: '2025-01-01 00:06', v: '10.956', ty: 'H ', f: '0,0' },
      { t: '2025-01-01 06:42', v: '1.204', ty: 'LL', f: '0,0' },
      { t: '2025-01-01 13:18', v: '11.803', ty: 'HH', f: '0,0' },
      { t: '2025-01-01 19:54', v: '2.017', ty: 'L ', f: '0,0' },
    ];
    const HIGH_LOW_PRED = [
      { t: '2025-01-01 00:11', v: '10.91', type: 'H' },
      { t: '2025-01-01 06:48', v: '1.25', type: 'L' },
      { t: '2025-01-01 13:24', v: '11.77', type: 'H' },
      { t: '2025-01-01 19:59', v: '2.06', type: 'L' },
    ];

    /** Live `daily_mean` rows — `{t,v,f}`, no `q`, no `s`. */
    const DAILY_MEAN_ROWS = [
      { t: '2025-01-01 00:00', v: '578.281', f: '0,0' },
      { t: '2025-01-02 00:00', v: '578.143', f: '0,0' },
      { t: '2025-01-03 00:00', v: '578.232', f: '0,0' },
    ];

    const GREAT_LAKES = {
      greatlakes: true,
      id: '9087044',
      lat: 41.72972,
      lng: -87.53833,
      name: 'Calumet Harbor',
      state: 'IL',
    };
    const COASTAL = {
      greatlakes: false,
      id: '9447130',
      lat: 47.6,
      lng: -122.33,
      name: 'Seattle',
      state: 'WA',
    };

    async function mockProduct(
      rows: readonly Record<string, string>[],
      predictions: readonly Record<string, string>[] = [],
      stations: readonly Record<string, unknown>[] = [COASTAL],
    ) {
      const { getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(svc, 'getStations').mockResolvedValue(stations as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(svc, 'fetchWaterLevel').mockResolvedValue({ data: rows as any, stationName: 'X' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue(predictions as any);
      return svc;
    }

    it('asks CO-OPS for the hourly_height product and the hourly prediction series', async () => {
      const svc = await mockProduct(HOURLY_ROWS, HOURLY_PRED);
      const input = noaaMarineGetWaterLevel.input.parse({
        begin_date: '20250101',
        end_date: '20250101',
        interval: 'hourly',
        station_id: '9447130',
      });
      await noaaMarineGetWaterLevel.handler(
        input,
        createMockContext({ errors: noaaMarineGetWaterLevel.errors }),
      );

      expect(svc.fetchWaterLevel).toHaveBeenCalledWith(
        expect.objectContaining({ product: 'hourly_height' }),
        expect.anything(),
      );
      expect(svc.fetchWaterLevelPredictions).toHaveBeenCalledWith(
        expect.objectContaining({ interval: 'h' }),
        expect.anything(),
      );
    });

    it('echoes the interval and computes the residual from the full matched hourly series', async () => {
      await mockProduct(HOURLY_ROWS, HOURLY_PRED);
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        begin_date: '20250101',
        end_date: '20250101',
        interval: 'hourly',
        station_id: '9447130',
      });
      const structured = result.structuredContent as {
        interval: string;
        observations: { quality?: string }[];
        residual_summary?: { max_surge: number };
      };

      expect(structured.interval).toBe('hourly');
      expect(structured.residual_summary?.max_surge).toBeCloseTo(0.14, 2);
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain('hourly');
    });

    it('represents the absent quality flag instead of labelling verified data preliminary', async () => {
      await mockProduct(HOURLY_ROWS, HOURLY_PRED);
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        begin_date: '20250101',
        end_date: '20250101',
        interval: 'hourly',
        station_id: '9447130',
      });
      const structured = result.structuredContent as { observations: { quality?: string }[] };

      for (const obs of structured.observations) expect(obs.quality).toBeUndefined();
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).not.toContain('[p]');
    });

    it('still reports the 6-minute quality flag', async () => {
      await mockProduct(
        [{ f: '0,0,0,0', q: 'v', s: '0.01', t: '2025-01-15 12:00', v: '8.23' }],
        [{ t: '2025-01-15 12:00', v: '8.20' }],
      );
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        begin_date: '20250115',
        end_date: '20250115',
        station_id: '9447130',
      });
      const structured = result.structuredContent as { observations: { quality?: string }[] };
      expect(structured.observations[0]?.quality).toBe('v');
    });

    it('keeps all four high_low classifications with the trailing space trimmed', async () => {
      await mockProduct(HIGH_LOW_ROWS, HIGH_LOW_PRED);
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        begin_date: '20250101',
        end_date: '20250101',
        interval: 'high_low',
        station_id: '9447130',
      });
      const structured = result.structuredContent as { observations: { type?: string }[] };

      expect(structured.observations.map((o) => o.type)).toEqual(['H', 'LL', 'HH', 'L']);
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain('HH');
      expect(text).toContain('LL');
    });

    it('reports no residual for high_low, whose extrema do not fall on predicted extreme times', async () => {
      await mockProduct(HIGH_LOW_ROWS, HIGH_LOW_PRED);
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        begin_date: '20250101',
        end_date: '20250101',
        interval: 'high_low',
        station_id: '9447130',
      });
      const structured = result.structuredContent as Record<string, unknown>;

      expect(structured).not.toHaveProperty('residual_summary');
      expect(structured.predictions).toHaveLength(4);
      expect(String(structured.notice)).toContain('residual');
    });

    it('asks CO-OPS for the daily_mean product, whose LST-only constraint the transport applies', async () => {
      const svc = await mockProduct(DAILY_MEAN_ROWS, [], [GREAT_LAKES]);
      const input = noaaMarineGetWaterLevel.input.parse({
        begin_date: '20250101',
        datum: 'IGLD',
        end_date: '20250105',
        interval: 'daily_mean',
        station_id: '9087044',
        time_zone: 'lst_ldt',
      });
      await noaaMarineGetWaterLevel.handler(
        input,
        createMockContext({ errors: noaaMarineGetWaterLevel.errors }),
      );

      // The tool selects the product and passes the caller's zone through untouched; the
      // service rewrites it to lst on the wire, which its own suite asserts against the URL.
      expect(svc.fetchWaterLevel).toHaveBeenCalledWith(
        expect.objectContaining({ product: 'daily_mean', time_zone: 'lst_ldt' }),
        expect.anything(),
      );
    });

    it('fetches no prediction series for daily_mean and says why no residual is reported', async () => {
      const svc = await mockProduct(DAILY_MEAN_ROWS, [], [GREAT_LAKES]);
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        begin_date: '20250101',
        datum: 'IGLD',
        end_date: '20250105',
        interval: 'daily_mean',
        station_id: '9087044',
      });
      const structured = result.structuredContent as Record<string, unknown>;

      expect(svc.fetchWaterLevelPredictions).not.toHaveBeenCalled();
      expect(structured.predictions).toEqual([]);
      expect(structured).not.toHaveProperty('residual_summary');
      // Not "CO-OPS returned no prediction rows" — the product has no paired series at all.
      expect(structured).not.toHaveProperty('predictions_status');
      expect(String(structured.notice)).toContain('daily_mean');
      expect((structured.observations as { time: string }[]).map((o) => o.time)).toEqual([
        '2025-01-01 00:00',
        '2025-01-02 00:00',
        '2025-01-03 00:00',
      ]);
    });

    it('rejects daily_mean at a coastal station naming the Great Lakes restriction', async () => {
      const svc = await mockProduct(DAILY_MEAN_ROWS, [], [COASTAL]);
      const ctx = createMockContext({ errors: noaaMarineGetWaterLevel.errors });
      const input = noaaMarineGetWaterLevel.input.parse({
        begin_date: '20250101',
        end_date: '20250105',
        interval: 'daily_mean',
        station_id: '9447130',
        datum: 'STND',
      });
      const err = await Promise.resolve(noaaMarineGetWaterLevel.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).toMatchObject({ data: { reason: 'great_lakes_only' } });
      const hint = (err as { data: { recovery?: { hint?: string } } }).data.recovery?.hint ?? '';
      expect(hint).toContain('Great Lakes');
      expect(hint).not.toContain('noaa_marine_find_stations with types');
      expect(svc.fetchWaterLevel).not.toHaveBeenCalled();
    });

    it('maps the CO-OPS Great Lakes daily-mean refusal to the same reason when the catalog is unread', async () => {
      const { CoopsBodyError, getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      vi.spyOn(svc, 'getStations').mockRejectedValue(new Error('catalog down'));
      vi.spyOn(svc, 'fetchWaterLevel').mockRejectedValue(
        new CoopsBodyError(
          'great_lakes_only',
          'CO-OPS error: Water Level Daily Mean Data is only available for Great Lakes stations, and not for coastal stations.',
        ),
      );
      vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue([]);

      const ctx = createMockContext({ errors: noaaMarineGetWaterLevel.errors });
      const input = noaaMarineGetWaterLevel.input.parse({
        begin_date: '20250101',
        end_date: '20250105',
        interval: 'daily_mean',
        station_id: '9447130',
        datum: 'STND',
      });
      await expect(noaaMarineGetWaterLevel.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'great_lakes_only' },
      });
    });

    it('names the verified-data lag when a coarse product has not been published for the window', async () => {
      const { CoopsBodyError, getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(svc, 'getStations').mockResolvedValue([COASTAL] as any);
      vi.spyOn(svc, 'fetchWaterLevel').mockRejectedValue(
        new CoopsBodyError(
          'product_not_offered',
          'CO-OPS error: No data was found. This product may not be offered at this station at the requested time.',
        ),
      );
      vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue([]);

      const ctx = createMockContext({ errors: noaaMarineGetWaterLevel.errors });
      const input = noaaMarineGetWaterLevel.input.parse({
        begin_date: '20260901',
        end_date: '20260910',
        interval: 'hourly',
        station_id: '9447130',
      });
      const err = await Promise.resolve(noaaMarineGetWaterLevel.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).toMatchObject({ data: { reason: 'verified_data_lag' } });
      const hint = (err as { data: { recovery?: { hint?: string } } }).data.recovery?.hint ?? '';
      expect(hint).toContain('verif');
      expect(hint).not.toContain('may be offline');
      expect(hint).not.toContain('in the future');
    });

    it('enforces each interval CO-OPS range limit locally, naming that interval limit', async () => {
      const svc = await mockProduct(HOURLY_ROWS, HOURLY_PRED);
      const ctx = createMockContext({ errors: noaaMarineGetWaterLevel.errors });

      for (const [interval, begin, end, limit] of [
        ['6min', '20250101', '20250301', '31'],
        ['hourly', '20240101', '20260101', '365'],
        ['high_low', '20240101', '20260101', '365'],
        ['daily_mean', '20100101', '20260101', '3655'],
      ] as const) {
        const input = noaaMarineGetWaterLevel.input.parse({
          begin_date: begin,
          end_date: end,
          interval,
          station_id: '9447130',
        });
        const err = await Promise.resolve(noaaMarineGetWaterLevel.handler(input, ctx)).catch(
          (e: unknown) => e,
        );
        expect(err).toMatchObject({ data: { reason: 'date_range_exceeded' } });
        expect((err as Error).message).toContain(limit);
        expect((err as Error).message).toContain(interval);
      }

      expect(svc.fetchWaterLevel).not.toHaveBeenCalled();
    });

    it('accepts a year of hourly data, which the byte bound then pages', async () => {
      const rows = Array.from({ length: 8760 }, (_, i) => ({
        f: '0,0',
        s: '0.026',
        t: `2025-01-01 ${String(i % 24).padStart(2, '0')}:00`,
        v: (10 + (i % 100) / 100).toFixed(3),
      }));
      await mockProduct(rows, []);
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        begin_date: '20250101',
        end_date: '20251231',
        interval: 'hourly',
        station_id: '9447130',
      });
      const structured = result.structuredContent as Record<string, unknown>;

      expect(result.isError).toBeFalsy();
      expect(structured.rows_matched).toBe(8760);
      expect((structured.observations as unknown[]).length).toBeLessThan(8760);
      expect(structured.truncated).toBe(true);
    });
  });
});

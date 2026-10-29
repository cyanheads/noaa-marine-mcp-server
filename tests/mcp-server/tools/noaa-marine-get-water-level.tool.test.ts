/**
 * @fileoverview Tests for noaa_marine_get_water_level tool.
 * @module tests/mcp-server/tools/noaa-marine-get-water-level.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { noaaMarineGetWaterLevel } from '@/mcp-server/tools/definitions/noaa-marine-get-water-level.tool.js';
import { type CoopsService, initCoopsService } from '@/services/coops/coops-service.js';
import type { CoopsStation, CoopsStationType } from '@/services/coops/types.js';
import {
  type CoopsResponder,
  callsTo,
  coopsEndpoint,
  healthyCoops,
  installCoopsFake,
} from '../../support/coops-http.js';

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

    /** Serves each catalog type its own list, as CO-OPS does — never one list for every type. */
    function mockCatalogs(
      svc: CoopsService,
      lists: Partial<Record<CoopsStationType, CoopsStation[]>>,
    ) {
      return vi.spyOn(svc, 'getStations').mockImplementation(async (type) => {
        const list = lists[type];
        if (!list) throw new Error(`Unexpected catalog read: ${type}`);
        return list;
      });
    }

    it('reports a datum the station does not carry as datum_unavailable, naming the Great Lakes datums', async () => {
      const ctx = createMockContext({ errors: noaaMarineGetWaterLevel.errors });
      const { CoopsBodyError, getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      mockCatalogs(svc, { waterlevels: [GREAT_LAKES_STATION] });
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
      mockCatalogs(svc, { waterlevels: [COASTAL_STATION] });
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
      mockCatalogs(svc, { waterlevels: [COASTAL_STATION] });
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

  // --- #50: a station that has never had a gauge is not a datum problem ---

  describe('station with no gauge', () => {
    /** Live catalog rows, trimmed to the fields the tool reads. */
    const HONOLULU = {
      id: '1612340',
      name: 'Honolulu',
      lat: 21.303333,
      lng: -157.86453,
      greatlakes: false,
      timezonecorr: -10,
      observedst: false,
    };
    /** Port Allen: a retired gauge (1988–1997), in `historicwl` but not `waterlevels`. */
    const PORT_ALLEN = {
      id: '1611347',
      name: 'PORT ALLEN, HANAPEPE BAY, KAUAI ISLAND',
      lat: 21.9033,
      lng: -159.592,
      greatlakes: false,
      timezonecorr: -10,
      observedst: false,
    };
    /** Waimea Bay: a subordinate tide-prediction station that has never had a gauge. */
    const WAIMEA_TIDE = {
      id: '1611401',
      name: 'Waimea Bay',
      lat: 21.9567,
      lng: -159.673,
      type: 'S',
      reference_id: '1611400',
    };
    const CATALOGS: Record<string, readonly Record<string, unknown>[] | number> = {
      waterlevels: [HONOLULU],
      historicwl: [HONOLULU, PORT_ALLEN],
      tidepredictions: [WAIMEA_TIDE, { ...PORT_ALLEN, type: 'R' }, { ...HONOLULU, type: 'R' }],
    };

    /** The HTTP 400 CO-OPS sends when the station has no row at the requested datum. */
    const noDatum = (datum: string, station: string) => () =>
      new Response(
        JSON.stringify({ error: { message: ` There is no ${datum} for the station: ${station}` } }),
        { status: 400 },
      );
    /** The HTTP 400 CO-OPS sends for NAVD at a station with no NAVD88 tie. */
    const supportedDatums = () =>
      new Response(
        JSON.stringify({
          error: {
            message: ' The supported Datum values are: MHHW, MHW, MTL, MSL, MLW, MLLW, LWI, HWI',
          },
        }),
        { status: 400 },
      );

    /** Catalogs per type (a number fails that read), and the observed product's answer. */
    function upstream(
      observed: () => Response,
      catalogs: Record<string, readonly Record<string, unknown>[] | number> = CATALOGS,
    ): CoopsResponder {
      return (endpoint, url) => {
        if (endpoint === 'catalog') {
          const list = catalogs[url.searchParams.get('type') ?? ''];
          if (list === undefined) throw new Error(`Unexpected catalog read: ${url}`);
          return typeof list === 'number'
            ? new Response('catalog error', { status: list })
            : Response.json({ stations: list });
        }
        if (url.searchParams.get('product') === 'predictions') {
          return Response.json({ predictions: [] });
        }
        return observed();
      };
    }

    type Result = Awaited<ReturnType<typeof runToolContract>>;
    const errorOf = (r: Result) =>
      (r.structuredContent as { error: { code: number; data?: Record<string, unknown> } }).error;
    const hintOf = (r: Result) =>
      (errorOf(r).data?.recovery as { hint?: string } | undefined)?.hint ?? '';
    const textOf = (r: Result) =>
      r.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    /** The retry clause of a datum hint — where a rejected datum must never reappear. */
    const retryClause = (hint: string) => hint.slice(hint.indexOf('Retry with'));
    const catalogTypes = (h: FetchMockHarness) =>
      callsTo(h, 'catalog').map((u) => u.searchParams.get('type'));

    let http: FetchMockHarness | undefined;
    afterEach(() => {
      http?.restore();
      http = undefined;
    });

    it('fails no_gauge at a tide-prediction station with no gauge, on both surfaces', async () => {
      http = installCoopsFake(upstream(noDatum('MLLW', '1611401')));
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '1611401',
        begin_date: '20261028',
        end_date: '20261028',
      });
      const error = errorOf(result);
      const hint = hintOf(result);

      expect(result.isError).toBe(true);
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data?.reason).toBe('no_gauge');
      expect(hint).toContain('noaa_marine_find_stations');
      expect(hint).toContain('latitude 21.9567, longitude -159.673');
      expect(hint).toContain('noaa_marine_get_tide_predictions');
      expect(hint).toContain('1611401');
      // Not the datum retry: no datum reads a station with no gauge.
      expect(hint).not.toContain('Retry with datum');

      const text = textOf(result);
      expect(text).toContain('no water-level gauge');
      expect(text).toContain('noaa_marine_find_stations');
      expect(text).toContain('noaa_marine_get_tide_predictions');
      expect(text).toContain('(reason no_gauge');
      expect(catalogTypes(http)).toEqual(['waterlevels', 'historicwl', 'tidepredictions']);
    });

    it('names no tide-prediction tool for a no-gauge station absent from tidepredictions', async () => {
      http = installCoopsFake(
        upstream(noDatum('MLLW', '1611401'), { ...CATALOGS, tidepredictions: [] }),
      );
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '1611401',
        begin_date: '20261028',
        end_date: '20261028',
      });

      expect(errorOf(result).data?.reason).toBe('no_gauge');
      expect(hintOf(result)).toContain('noaa_marine_find_stations');
      expect(hintOf(result)).not.toContain('noaa_marine_get_tide_predictions');
    });

    it('returns rows at Port Allen in its record years, reading no catalog', async () => {
      http = installCoopsFake(
        upstream(() =>
          Response.json({
            metadata: { name: 'Port Allen' },
            data: [{ t: '1996-01-01 00:00', v: '1.23', s: '0.01', f: '0,0,0,0', q: 'v' }],
          }),
        ),
      );
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '1611347',
        begin_date: '19960101',
        end_date: '19960101',
      });

      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as { observations: unknown[] }).observations).toHaveLength(
        1,
      );
      expect(callsTo(http, 'catalog')).toHaveLength(0);
    });

    it('keeps datum_unavailable and the NAVD88 hint at Port Allen, a retired gauge absent from waterlevels', async () => {
      http = installCoopsFake(upstream(supportedDatums));
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '1611347',
        begin_date: '19960101',
        end_date: '19960101',
        datum: 'NAVD',
      });

      expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(errorOf(result).data?.reason).toBe('datum_unavailable');
      expect(hintOf(result)).toContain('NAVD88');
      expect(retryClause(hintOf(result))).toContain('MLLW');
      expect(retryClause(hintOf(result))).not.toContain('NAVD');
      // historicwl settled it; tidepredictions was never needed.
      expect(catalogTypes(http)).toEqual(['waterlevels', 'historicwl']);
    });

    it('keeps datum_unavailable at Honolulu, an active gauge, from waterlevels alone', async () => {
      http = installCoopsFake(upstream(supportedDatums));
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '1612340',
        begin_date: '20261028',
        end_date: '20261028',
        datum: 'NAVD',
      });

      expect(errorOf(result).data?.reason).toBe('datum_unavailable');
      expect(hintOf(result)).toContain('NAVD88');
      expect(catalogTypes(http)).toEqual(['waterlevels']);
    });

    it('names STND, not MLLW, when a gauge rejects MLLW', async () => {
      http = installCoopsFake(upstream(noDatum('MLLW', '1612340')));
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '1612340',
        begin_date: '20261028',
        end_date: '20261028',
      });
      const retry = retryClause(hintOf(result));

      expect(errorOf(result).data?.reason).toBe('datum_unavailable');
      expect(retry).toContain('STND');
      expect(retry).not.toContain('MLLW');
      expect(textOf(result)).toContain(retry);
    });

    it('leaves the datum retry standing when historicwl cannot be read', async () => {
      http = installCoopsFake(
        upstream(noDatum('MLLW', '1611401'), { ...CATALOGS, historicwl: 404 }),
      );
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '1611401',
        begin_date: '20261028',
        end_date: '20261028',
      });

      expect(errorOf(result).data?.reason).toBe('datum_unavailable');
      expect(retryClause(hintOf(result))).toContain('STND');
      expect(retryClause(hintOf(result))).not.toContain('MLLW');
    });

    it("rethrows the caller's cancellation during the catalog lookup instead of answering a hint", async () => {
      const caller = new AbortController();
      http = installCoopsFake((endpoint, url) => {
        if (endpoint === 'catalog' && url.searchParams.get('type') === 'historicwl') {
          caller.abort(new DOMException('Client cancelled', 'AbortError'));
          return new Response('upstream down', { status: 503 });
        }
        return upstream(noDatum('MLLW', '1611401'))(endpoint, url);
      });
      const ctx = createMockContext({
        errors: noaaMarineGetWaterLevel.errors,
        signal: caller.signal,
      });
      const input = noaaMarineGetWaterLevel.input.parse({
        station_id: '1611401',
        begin_date: '20261028',
        end_date: '20261028',
      });
      const err = await Promise.resolve(noaaMarineGetWaterLevel.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(Error);
      // A swallowed cancellation would read as an unreadable catalog and answer datum_unavailable.
      expect((err as McpError).data?.reason).toBeUndefined();
      expect(catalogTypes(http)).toEqual(['waterlevels', 'historicwl']);
    });
  });

  // --- #45: a window that starts after the station's current date fails before any request ---

  describe('window in the future', () => {
    /** Live `waterlevels` rows, trimmed to the fields the check reads. */
    const WATERLEVELS = [
      {
        id: '8654467',
        name: 'USCG Station Hatteras',
        lat: 35.2086,
        lng: -75.7042,
        greatlakes: false,
        timezonecorr: -5,
        observedst: true,
      },
      {
        id: '1820000',
        name: 'Kwajalein, Marshall Islands',
        lat: 8.731667,
        lng: 167.73611,
        greatlakes: false,
        timezonecorr: 12,
        observedst: false,
      },
      {
        id: '9087044',
        name: 'Calumet Harbor',
        lat: 41.72972,
        lng: -87.53833,
        greatlakes: true,
        timezonecorr: -6,
        observedst: true,
      },
    ];
    const OBSERVED = {
      metadata: { name: 'Station' },
      data: [{ t: '2026-10-30 00:00', v: '1.230', s: '0.010', f: '0,0,0,0', q: 'p' }],
    };

    let http: FetchMockHarness | undefined;

    /**
     * The catalog answers by `catalog`; a catch-all route answers — and records — every other
     * request, so a request that should never be sent is counted rather than thrown.
     */
    function upstream(catalog: () => Response = () => Response.json({ stations: WATERLEVELS })) {
      http = createFetchMock([
        { match: (request) => coopsEndpoint(request.url) === 'catalog', respond: catalog },
        { match: () => true, respond: () => Response.json(OBSERVED) },
      ]);
      http.install();
      return http;
    }
    const nonCatalogCalls = (h: FetchMockHarness) =>
      h.calls.filter((call) => coopsEndpoint(call.request.url) !== 'catalog');

    function now(iso: string): void {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(iso));
    }

    afterEach(() => {
      vi.useRealTimers();
      http?.restore();
      http = undefined;
    });

    type Result = Awaited<ReturnType<typeof runToolContract>>;
    const errorOf = (r: Result) =>
      (r.structuredContent as { error: { code: number; data?: Record<string, unknown> } }).error;
    const hintOf = (r: Result) =>
      (errorOf(r).data?.recovery as { hint?: string } | undefined)?.hint ?? '';
    const textOf = (r: Result) =>
      r.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    const declared = noaaMarineGetWaterLevel.errors?.find(
      (e) => e.reason === 'future_window',
    )?.recovery;

    it('refuses tomorrow at Hatteras before any CO-OPS data request, on both surfaces', async () => {
      now('2026-10-29T16:00:00Z'); // 12:00 EDT
      const h = upstream();
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '8654467',
        begin_date: '20261030',
        end_date: '20261031',
      });
      const error = errorOf(result);

      expect(result.isError).toBe(true);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data?.reason).toBe('future_window');
      expect(hintOf(result)).toBe(declared);
      expect(hintOf(result)).toContain('noaa_marine_get_tide_predictions');
      const text = textOf(result);
      expect(text).toContain('8654467');
      expect(text).toContain('noaa_marine_get_tide_predictions');
      expect(text).toContain('(reason future_window');
      expect(nonCatalogCalls(h)).toHaveLength(0);
      expect(callsTo(h, 'catalog').map((u) => u.searchParams.get('type'))).toEqual(['waterlevels']);
    });

    it('refuses the same window on hourly, instead of naming a verification lag', async () => {
      now('2026-10-29T16:00:00Z');
      const h = upstream();
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '8654467',
        begin_date: '20261030',
        end_date: '20261031',
        interval: 'hourly',
      });

      expect(errorOf(result).data?.reason).toBe('future_window');
      expect(nonCatalogCalls(h)).toHaveLength(0);
    });

    it('refuses a begin_date after the UTC date under gmt, sending no request at all', async () => {
      now('2026-10-29T23:59:00Z');
      const h = upstream();
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '1820000',
        begin_date: '20261030',
        end_date: '20261030',
        time_zone: 'gmt',
      });

      expect(errorOf(result).data?.reason).toBe('future_window');
      expect(textOf(result)).toContain('gmt');
      expect(h.calls).toHaveLength(0);
    });

    it('sends a begin_date on the UTC date under gmt to CO-OPS', async () => {
      now('2026-10-29T00:00:00Z');
      const h = upstream();
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '8654467',
        begin_date: '20261029',
        end_date: '20261029',
        time_zone: 'gmt',
      });

      expect(result.isError).toBeFalsy();
      expect(nonCatalogCalls(h).length).toBeGreaterThan(0);
    });

    it('returns rows at Kwajalein on its local date while that date is ahead of UTC', async () => {
      // 15:59 UTC on Oct 29 is 03:59 on Oct 30 at UTC+12 — CO-OPS returned 39 rows live.
      now('2026-10-29T15:59:00Z');
      const h = upstream();
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '1820000',
        begin_date: '20261030',
        end_date: '20261030',
      });

      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as { observations: unknown[] }).observations).toHaveLength(
        1,
      );
      const observed = callsTo(h, 'data').find(
        (u) => u.searchParams.get('product') === 'water_level',
      );
      expect(observed?.searchParams.get('begin_date')).toBe('20261030');
    });

    it('refuses the Kwajalein local date one minute before its midnight', async () => {
      now('2026-10-29T11:59:00Z'); // 23:59 Oct 29 at UTC+12
      const h = upstream();
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '1820000',
        begin_date: '20261030',
        end_date: '20261030',
      });

      expect(errorOf(result).data?.reason).toBe('future_window');
      expect(nonCatalogCalls(h)).toHaveLength(0);
    });

    it('leaves a window beginning today and ending in the future unchanged, reading no catalog', async () => {
      now('2026-10-29T16:00:00Z');
      const h = upstream();
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '8654467',
        begin_date: '20261029',
        end_date: '20261031',
      });

      expect(result.isError).toBeFalsy();
      expect(nonCatalogCalls(h).length).toBeGreaterThan(0);
      expect(callsTo(h, 'catalog')).toHaveLength(0);
    });

    it('reads no catalog for a historical window', async () => {
      now('2026-10-29T16:00:00Z');
      const h = upstream();
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '8654467',
        begin_date: '20250115',
        end_date: '20250115',
        interval: 'hourly',
      });

      expect(result.isError).toBeFalsy();
      expect(callsTo(h, 'catalog')).toHaveLength(0);
    });

    it('reads daily_mean dates in LST, where the daylight hour does not apply', async () => {
      // 05:30 UTC on Jul 15 is 00:30 Jul 15 at Calumet's daylight time, 23:30 Jul 14 in LST.
      now('2026-07-15T05:30:00Z');
      const h = upstream();
      const daily = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '9087044',
        begin_date: '20260715',
        end_date: '20260715',
        interval: 'daily_mean',
        datum: 'IGLD',
      });
      expect(errorOf(daily).data?.reason).toBe('future_window');
      expect(textOf(daily)).toContain('lst');
      expect(nonCatalogCalls(h)).toHaveLength(0);

      const sixMinute = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '9087044',
        begin_date: '20260715',
        end_date: '20260715',
        datum: 'IGLD',
      });
      expect(sixMinute.isError).toBeFalsy();
    });

    it('leaves a window in the band to CO-OPS when the catalog cannot be read', async () => {
      now('2026-10-29T16:00:00Z');
      const h = upstream(() => new Response('catalog error', { status: 404 }));
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '8654467',
        begin_date: '20261030',
        end_date: '20261030',
      });

      expect(result.isError).toBeFalsy();
      expect(nonCatalogCalls(h).length).toBeGreaterThan(0);
    });

    it("rethrows the caller's cancellation during the catalog read, sending no data request", async () => {
      now('2026-10-29T16:00:00Z');
      const caller = new AbortController();
      const h = upstream(() => {
        caller.abort(new DOMException('Client cancelled', 'AbortError'));
        return new Response('upstream down', { status: 503 });
      });
      const ctx = createMockContext({
        errors: noaaMarineGetWaterLevel.errors,
        signal: caller.signal,
      });
      const input = noaaMarineGetWaterLevel.input.parse({
        station_id: '8654467',
        begin_date: '20261030',
        end_date: '20261030',
      });

      await expect(noaaMarineGetWaterLevel.handler(input, ctx)).rejects.toBeInstanceOf(Error);
      expect(nonCatalogCalls(h)).toHaveLength(0);
    });

    it('leaves no future-window clause in the generic no_data recovery', async () => {
      http = createFetchMock([{ match: () => true, respond: () => Response.json({ data: [] }) }]);
      http.install();
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '8654467',
        begin_date: '20250115',
        end_date: '20250115',
      });

      expect(errorOf(result).data?.reason).toBe('no_data');
      expect(hintOf(result)).toBe(
        'The station may be offline, or its record may begin after the window. Try a different date range or station.',
      );
      expect(hintOf(result)).not.toContain('future');
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
      // Both pairs sit above prediction, so there is no drawdown.
      expect(result.residual_summary).toEqual({ max_surge: 0.11, max_drawdown: 0 });
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
      expect(structured.residual_summary).toEqual({ max_surge: 0.03, max_drawdown: 0 });
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

  // --- #35: a side of the residual that never occurred in the window reports 0, not a signed value ---

  describe('residual sign convention', () => {
    /** Six 6-minute slots with a fixed prediction, so each residual is exactly obs − 5.00. */
    function window(residuals: number[]) {
      const times = residuals.map((_, i) => `2026-09-16 00:${String(i * 6).padStart(2, '0')}`);
      return {
        obs: residuals.map((r, i) => ({
          t: times[i]!,
          v: (5 + r).toFixed(3),
          s: '0.01',
          f: '0,0,0,0',
          q: 'p',
        })),
        pred: times.map((t) => ({ t, v: '5.000' })),
      };
    }

    async function residualFor(residuals: number[], units: 'english' | 'metric' = 'english') {
      const { getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      const { obs, pred } = window(residuals);
      vi.spyOn(svc, 'fetchWaterLevel').mockResolvedValue({ data: obs, stationName: 'Vancouver' });
      vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue(pred);
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '9440083',
        begin_date: '20260916',
        end_date: '20260916',
        datum: 'CRD',
        units,
      });
      return {
        structured: result.structuredContent as {
          residual_summary?: { max_surge: number; max_drawdown: number };
        },
        text: result.content.map((b) => (b as { text?: string }).text ?? '').join('\n'),
      };
    }

    it('reports no surge on a window that sat below prediction throughout', async () => {
      const { structured, text } = await residualFor([-0.03, -0.4, -1.62, -0.9, -0.2, -0.05]);

      expect(structured.residual_summary).toEqual({ max_surge: 0, max_drawdown: 1.62 });
      expect(text).toContain('**Max surge:** 0 ft · **Max drawdown:** 1.62 ft');
      expect(text).not.toContain('-0.03 ft');
    });

    it('reports no drawdown on a window that sat above prediction throughout', async () => {
      const { structured, text } = await residualFor([1.99, 2.4, 2.83, 2.1, 2.05, 2.2]);

      expect(structured.residual_summary).toEqual({ max_surge: 2.83, max_drawdown: 0 });
      expect(text).toContain('**Max surge:** 2.83 ft · **Max drawdown:** 0 ft');
    });

    it('leaves a mixed-sign window at its true magnitudes on both sides', async () => {
      const { structured, text } = await residualFor([0.3, -0.12, 0.47, -0.25, 0.01, -0.04]);

      expect(structured.residual_summary).toEqual({ max_surge: 0.47, max_drawdown: 0.25 });
      expect(text).toContain('**Max surge:** 0.47 ft · **Max drawdown:** 0.25 ft');
    });

    it('applies the same convention in metric units', async () => {
      const { structured, text } = await residualFor(
        [-0.2, -0.5, -0.1, -0.3, -0.45, -0.05],
        'metric',
      );

      expect(structured.residual_summary).toEqual({ max_surge: 0, max_drawdown: 0.5 });
      expect(text).toContain('**Max surge:** 0 m · **Max drawdown:** 0.5 m');
    });

    it('reports 0 on both sides when every observation equals its prediction', async () => {
      const { structured } = await residualFor([0, 0, 0, 0, 0, 0]);

      expect(structured.residual_summary).toEqual({ max_surge: 0, max_drawdown: 0 });
    });
  });

  // --- #18, #49: the page is limit observations from offset, identical on both surfaces ---

  describe('paging', () => {
    it('describes paging by count, with no response-size budget anywhere on the surface', () => {
      const surface = JSON.stringify([
        noaaMarineGetWaterLevel.description,
        z.toJSONSchema(noaaMarineGetWaterLevel.input, { io: 'input' }),
        z.toJSONSchema(noaaMarineGetWaterLevel.output),
        z.toJSONSchema(z.object(noaaMarineGetWaterLevel.enrichment ?? {})),
      ]);

      expect(surface).not.toMatch(/budget|response size|fits? one response|largest page|byte/i);
    });

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

    it('returns the default 50 observations and the predictions in their span when limit is omitted', async () => {
      await mockThreeDays();
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '9447130',
        begin_date: '20260901',
        end_date: '20260903',
      });
      const structured = result.structuredContent as Record<string, unknown> & {
        observations: { time: string }[];
        predictions: { time: string }[];
      };

      expect(structured.observations.map((o) => o.time)).toEqual(
        THREE_DAYS.slice(0, 50).map((r) => r.t),
      );
      expect(structured.predictions.map((p) => p.time)).toEqual(
        THREE_DAYS_PRED.slice(0, 50).map((r) => r.t),
      );
      expect(structured.rows_matched).toBe(720);
      expect(structured.next_offset).toBe(50);

      // tools/list advertises the default and no ceiling on either count input.
      const schema = z.toJSONSchema(noaaMarineGetWaterLevel.input, { io: 'input' }) as {
        properties: Record<string, Record<string, unknown>>;
      };
      expect(schema.properties.limit).toMatchObject({ default: 50, minimum: 1 });
      expect(schema.properties.limit).not.toHaveProperty('maximum');
      expect(schema.properties.offset).toMatchObject({ default: 0, minimum: 0 });
      expect(schema.properties.offset).not.toHaveProperty('maximum');
    });

    it('clamps limit 1001 to 1,000 observations and leads the notice with it on both surfaces', async () => {
      const { getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      const week = Array.from({ length: 1680 }, (_, i) => slot(i));
      vi.spyOn(svc, 'fetchWaterLevel').mockResolvedValue({ data: week, stationName: 'Seattle' });
      vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue(
        week.map((row) => ({ t: row.t, v: row.v })),
      );

      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '9447130',
        begin_date: '20260901',
        end_date: '20260907',
        limit: 1001,
      });
      const structured = result.structuredContent as Record<string, unknown> & {
        observations: unknown[];
        predictions: unknown[];
      };

      expect(result.isError).toBeFalsy();
      expect(structured.observations).toHaveLength(1000);
      expect(structured.predictions).toHaveLength(1000);
      expect(structured.rows_matched).toBe(1680);
      expect(structured.next_offset).toBe(1000);
      const clamp = 'Requested limit 1001; applied limit 1000, the per-call cap.';
      expect(String(structured.notice).startsWith(`${clamp} `)).toBe(true);
      expect(String(structured.notice)).toContain('offset=1000');
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain(clamp);
    });

    it('says it clamped limit on a whole page, ahead of the gap notice', async () => {
      const { getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      const rows = THREE_DAYS.slice(0, 5).map((row, i) =>
        i === 2 ? { ...row, v: '', s: '' } : row,
      );
      vi.spyOn(svc, 'fetchWaterLevel').mockResolvedValue({ data: rows, stationName: 'Seattle' });
      vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue(THREE_DAYS_PRED.slice(0, 5));

      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '9447130',
        begin_date: '20260901',
        end_date: '20260901',
        limit: 1001,
      });
      const structured = result.structuredContent as Record<string, unknown>;

      expect(structured.observations).toHaveLength(4);
      expect(structured).not.toHaveProperty('next_offset');
      expect(structured).not.toHaveProperty('rows_matched');
      expect(structured.notice).toMatch(
        /^Requested limit 1001; applied limit 1000, the per-call cap\. 1 of the 5 sample slots /,
      );
    });

    it('partitions the prediction series across an observation gap, counting only observations', async () => {
      const { getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      // A 60-slot sensor outage (slots 40–99) inside the first page's span: CO-OPS sends those
      // slots with no reading, and still predicts them.
      const outage = THREE_DAYS.map((row, i) =>
        i >= 40 && i < 100 ? { ...row, v: '', s: '' } : row,
      );
      vi.spyOn(svc, 'fetchWaterLevel').mockResolvedValue({ data: outage, stationName: 'Seattle' });
      vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue(THREE_DAYS_PRED);

      const obsTimes: string[] = [];
      const predTimes: string[] = [];
      const pages: { obs: number; pred: number }[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const result = await runToolContract(noaaMarineGetWaterLevel, {
          station_id: '9447130',
          begin_date: '20260901',
          end_date: '20260903',
          offset,
        });
        const structured = result.structuredContent as {
          next_offset?: number | null;
          observations: { time: string }[];
          predictions: { time: string }[];
        };
        obsTimes.push(...structured.observations.map((o) => o.time));
        predTimes.push(...structured.predictions.map((p) => p.time));
        pages.push({ obs: structured.observations.length, pred: structured.predictions.length });
        offset = structured.next_offset ?? null;
        expect(pages.length).toBeLessThan(40);
      }

      // limit bounds observations only: the first page's 50 readings end at slot 109, so it
      // carries every prediction through slot 109 — the outage's 60 included.
      expect(pages[0]).toEqual({ obs: 50, pred: 110 });
      expect(pages[1]).toEqual({ obs: 50, pred: 50 });
      expect(obsTimes).toHaveLength(660);
      expect(new Set(obsTimes).size).toBe(660);
      expect(predTimes).toEqual(THREE_DAYS_PRED.map((r) => r.t));
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
      expect(structured.rows_returned).toBe(50);
      expect(structured.page_offset).toBe(0);
      expect(structured.next_offset).toBe(50);

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
        // Each page steps the offset by exactly the rows it carried, 50 until the last.
        const next = structured.next_offset ?? null;
        if (next !== null) expect(next).toBe(offset + 50);
        offset = next;
        expect(pages).toBeLessThan(40);
      }

      expect(pages).toBe(15);
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

    it('clamps across the full matched series on every page, not only the first', async () => {
      const { getCoopsService } = await import('@/services/coops/coops-service.js');
      const svc = getCoopsService();
      // Every slot sits 0.05 below prediction, and the deepest drawdown is the last slot.
      const below = THREE_DAYS.map((row) => ({
        t: row.t,
        v: (Number.parseFloat(row.v) + 0.05).toFixed(3),
      }));
      const dip = THREE_DAYS.map((row, i) =>
        i === 719 ? { ...row, v: (Number.parseFloat(row.v) - 3).toFixed(3) } : row,
      );
      vi.spyOn(svc, 'fetchWaterLevel').mockResolvedValue({ data: dip, stationName: 'Seattle' });
      vi.spyOn(svc, 'fetchWaterLevelPredictions').mockResolvedValue(below);

      const summaries: unknown[] = [];
      for (const offset of [0, 300, 719]) {
        const result = await runToolContract(noaaMarineGetWaterLevel, {
          begin_date: '20260901',
          end_date: '20260903',
          offset,
          station_id: '9447130',
        });
        summaries.push(
          (result.structuredContent as { residual_summary?: unknown }).residual_summary,
        );
      }

      for (const summary of summaries) {
        expect(summary).toEqual({ max_surge: 0, max_drawdown: 3.05 });
      }
    });

    it('returns a range of at most limit observations whole, with no paging disclosure at all', async () => {
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
      // The window ends inside the prior month relative to this pinned "today".
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-22T12:00:00Z'));
      onTestFinished(() => {
        vi.useRealTimers();
      });
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

      // Through the contract runner, which fills the declared recovery as production does.
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        begin_date: '20260901',
        end_date: '20260910',
        interval: 'hourly',
        station_id: '9447130',
      });
      const error = (
        result.structuredContent as {
          error: { data?: { reason?: string; recovery?: { hint?: string } } };
        }
      ).error;

      expect(result.isError).toBe(true);
      expect(error.data?.reason).toBe('verified_data_lag');
      expect(error.data?.recovery?.hint).toBe(
        'CO-OPS verifies these products monthly, for the prior month, so request a window ending before the first day of the prior month — or use interval "6min", whose preliminary data reaches the present.',
      );
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

    it('accepts a year of hourly data, which then pages at the default count', async () => {
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
      expect(structured.observations).toHaveLength(50);
      expect(structured.next_offset).toBe(50);
      expect(structured.truncated).toBe(true);
    });
  });

  // --- #41: the "may not be offered" sentence is decided by window, not by the sentence alone ---

  describe('product not offered for the window', () => {
    /** "Today" for every case below — the prior month starts 2026-08-01. */
    const TODAY = new Date('2026-09-22T12:00:00Z');
    const NOT_OFFERED = Response.json({
      error: {
        message:
          'No data was found. This product may not be offered at this station at the requested time.',
      },
    });

    /** CO-OPS answering the observed product with the "may not be offered" sentence. */
    function notOffered(product: string): CoopsResponder {
      return (endpoint, url) =>
        endpoint === 'data' && url.searchParams.get('product') === product
          ? NOT_OFFERED.clone()
          : healthyCoops(endpoint, url);
    }

    type Result = Awaited<ReturnType<typeof runToolContract>>;
    type ErrorEnvelope = { code: number; data?: Record<string, unknown>; message: string };
    const errorOf = (r: Result) => (r.structuredContent as { error: ErrorEnvelope }).error;
    const textOf = (r: Result) =>
      r.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    const hintOf = (r: Result) =>
      (errorOf(r).data?.recovery as { hint?: string } | undefined)?.hint ?? '';

    let http: ReturnType<typeof installCoopsFake> | undefined;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(TODAY);
    });

    afterEach(() => {
      vi.useRealTimers();
      http?.restore();
      http = undefined;
    });

    it('fails no_data for an 1850 hourly window, which predates the station record', async () => {
      http = installCoopsFake(notOffered('hourly_height'));
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '9447130',
        begin_date: '18500101',
        end_date: '18500131',
        interval: 'hourly',
      });
      const error = errorOf(result);

      expect(result.isError).toBe(true);
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data?.reason).toBe('no_data');
      // Waiting for verification cannot help a window this old, so the recovery never says to.
      expect(hintOf(result)).not.toContain('verif');
      expect(hintOf(result)).toContain('later window');
      expect(textOf(result)).toContain('(reason no_data');
      expect(textOf(result)).toContain(`Recovery: ${hintOf(result)}`);

      const observed = callsTo(http, 'data').find(
        (u) => u.searchParams.get('product') === 'hourly_height',
      );
      expect(observed?.searchParams.get('begin_date')).toBe('18500101');
    });

    it('fails no_data for a coarse window ending the day before the prior month', async () => {
      http = installCoopsFake(notOffered('high_low'));
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '9447130',
        begin_date: '2026-07-01',
        end_date: '2026-07-31',
        interval: 'high_low',
      });

      expect(errorOf(result).data?.reason).toBe('no_data');
    });

    it.each([
      ['hourly', 'hourly_height', '20260801', '20260801'],
      ['high_low', 'high_low', '20260815', '20260910'],
      ['hourly', 'hourly_height', '20260901', '20260922'],
    ] as const)(
      'keeps verified_data_lag for %s ending %s–%s, on or after the prior month',
      async (interval, product, begin, end) => {
        http = installCoopsFake(notOffered(product));
        const result = await runToolContract(noaaMarineGetWaterLevel, {
          station_id: '9447130',
          begin_date: begin,
          end_date: end,
          interval,
        });
        const error = errorOf(result);

        expect(error.code).toBe(JsonRpcErrorCode.NotFound);
        expect(error.data?.reason).toBe('verified_data_lag');
        expect(hintOf(result)).toContain('verif');
        expect(textOf(result)).toContain('(reason verified_data_lag');
      },
    );

    it('keeps verified_data_lag for a daily_mean window reaching into the current month', async () => {
      http = installCoopsFake((endpoint) =>
        endpoint === 'catalog'
          ? Response.json({
              stations: [
                {
                  id: '9087044',
                  name: 'Calumet Harbor',
                  lat: 41.73,
                  lng: -87.54,
                  greatlakes: true,
                },
              ],
            })
          : NOT_OFFERED.clone(),
      );
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '9087044',
        begin_date: '20260801',
        end_date: '20260915',
        interval: 'daily_mean',
        datum: 'IGLD',
      });

      expect(errorOf(result).data?.reason).toBe('verified_data_lag');
    });

    it('leaves 6min unchanged: the sentence is no_data whatever the window', async () => {
      http = installCoopsFake(notOffered('water_level'));
      const result = await runToolContract(noaaMarineGetWaterLevel, {
        station_id: '9447130',
        begin_date: '20260915',
        end_date: '20260916',
      });

      expect(errorOf(result).data?.reason).toBe('no_data');
    });
  });
});

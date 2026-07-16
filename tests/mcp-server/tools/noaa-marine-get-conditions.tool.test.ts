/**
 * @fileoverview Tests for noaa_marine_get_conditions tool.
 * @module tests/mcp-server/tools/noaa-marine-get-conditions.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaMarineGetConditions } from '@/mcp-server/tools/definitions/noaa-marine-get-conditions.tool.js';
import { initNdbcService } from '@/services/ndbc/ndbc-service.js';

const NDBC_STATION = {
  id: '46041',
  name: 'Cape Elizabeth',
  lat: 47.35,
  lon: -124.73,
  hasMet: true,
  hasCurrents: false,
};

const FULL_OBS = {
  observedAt: '2025-01-15T12:00:00Z',
  windDirectionDeg: 270,
  windSpeedMs: 5.2,
  gustSpeedMs: 7.1,
  waveHeightM: 2.1,
  dominantPeriodSec: 14,
  averagePeriodSec: 9.0,
  meanWaveDirectionDeg: 275,
  pressureHpa: 1013.5,
  airTempC: 12.3,
  waterTempC: 11.0,
  dewPointC: 8.5,
  visibilityNmi: null,
  tideFt: null,
};

/** Sparse observation: only water temp reported, rest null (MM in source). */
const SPARSE_OBS = {
  observedAt: '2025-01-15T12:00:00Z',
  windDirectionDeg: null,
  windSpeedMs: null,
  gustSpeedMs: null,
  waveHeightM: null,
  dominantPeriodSec: null,
  averagePeriodSec: null,
  meanWaveDirectionDeg: null,
  pressureHpa: null,
  airTempC: null,
  waterTempC: 11.0,
  dewPointC: null,
  visibilityNmi: null,
  tideFt: null,
};

function setupNdbc() {
  initNdbcService();
}

describe('noaaMarineGetConditions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setupNdbc();
  });

  it('returns full observation for a valid NDBC buoy', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetConditions.errors });

    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    const svc = getNdbcService();
    vi.spyOn(svc, 'getActiveStations').mockResolvedValue([NDBC_STATION]);
    vi.spyOn(svc, 'fetchObservation').mockResolvedValue(FULL_OBS);

    const input = noaaMarineGetConditions.input.parse({ station_id: '46041' });
    const result = await noaaMarineGetConditions.handler(input, ctx);

    expect(result.station_id).toBe('46041');
    expect(result.station_name).toBe('Cape Elizabeth');
    expect(result.latitude).toBe(47.35);
    expect(result.longitude).toBe(-124.73);
    expect(result.observed_at).toBe('2025-01-15T12:00:00Z');
    expect(result.source).toBe('ndbc');
    expect(result.wind_speed_ms).toBe(5.2);
    expect(result.wave_height_m).toBe(2.1);
    expect(result.water_temp_c).toBe(11.0);
    // MM fields are null
    expect(result.visibility_nmi).toBeNull();
    expect(result.tide_ft).toBeNull();
  });

  it('preserves null sensor values for sparse upstream observations (MM fields)', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetConditions.errors });

    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    const svc = getNdbcService();
    vi.spyOn(svc, 'getActiveStations').mockResolvedValue([NDBC_STATION]);
    vi.spyOn(svc, 'fetchObservation').mockResolvedValue(SPARSE_OBS);

    const input = noaaMarineGetConditions.input.parse({ station_id: '46041' });
    const result = await noaaMarineGetConditions.handler(input, ctx);

    // Output schema validates null values for all optional sensor fields
    expect(result.wind_speed_ms).toBeNull();
    expect(result.wave_height_m).toBeNull();
    expect(result.pressure_hpa).toBeNull();
    expect(result.water_temp_c).toBe(11.0); // sole non-null sensor
  });

  it('throws ctx.fail("buoy_not_found") when NDBC returns 404', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetConditions.errors });

    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    const svc = getNdbcService();
    vi.spyOn(svc, 'getActiveStations').mockResolvedValue([]);

    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    vi.spyOn(svc, 'fetchObservation').mockRejectedValue(
      notFound('NDBC buoy XXXXX not found — verify the station ID.', {
        stationId: 'XXXXX',
        reason: 'buoy_not_found',
      }),
    );

    const input = noaaMarineGetConditions.input.parse({ station_id: 'XXXXX' });
    await expect(noaaMarineGetConditions.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('preserves no_sensor_data when the buoy file exists but all sensors are missing', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetConditions.errors });

    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    const svc = getNdbcService();
    vi.spyOn(svc, 'getActiveStations').mockResolvedValue([]);

    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    // Service-level notFound for an existing-but-empty file carries reason: 'no_sensor_data'.
    vi.spyOn(svc, 'fetchObservation').mockRejectedValue(
      notFound('NDBC buoy TEST1 has all sensor fields missing — buoy offline or sensor failure.', {
        stationId: 'TEST1',
        reason: 'no_sensor_data',
      }),
    );

    const input = noaaMarineGetConditions.input.parse({ station_id: 'TEST1' });
    await expect(noaaMarineGetConditions.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_sensor_data' },
    });
  });

  it('maps a bare NotFound 404 (no reason) to buoy_not_found', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetConditions.errors });

    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    const svc = getNdbcService();
    vi.spyOn(svc, 'getActiveStations').mockResolvedValue([]);

    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    // fetchWithTimeout throws a 404 before the service's own check runs: statusCode, no reason.
    vi.spyOn(svc, 'fetchObservation').mockRejectedValue(notFound('HTTP 404', { statusCode: 404 }));

    const input = noaaMarineGetConditions.input.parse({ station_id: 'ZZZZZ' });
    await expect(noaaMarineGetConditions.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'buoy_not_found' },
    });
  });

  it('falls back to station_id as name when station not found in active list', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetConditions.errors });

    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    const svc = getNdbcService();
    vi.spyOn(svc, 'getActiveStations').mockResolvedValue([]); // station not in list
    vi.spyOn(svc, 'fetchObservation').mockResolvedValue(FULL_OBS);

    const input = noaaMarineGetConditions.input.parse({ station_id: '46041' });
    const result = await noaaMarineGetConditions.handler(input, ctx);

    // No match in active stations → station_id used as fallback name
    expect(result.station_name).toBe('46041');
    expect(result.latitude).toBe(0); // fallback
    expect(result.longitude).toBe(0);
  });

  // --- #11: discovery guidance must not route callers back to the failing search ---

  it('points every recovery path at a capability-filtered NDBC search', () => {
    const recoveries = noaaMarineGetConditions.errors!.map((e) => e.recovery);
    expect(recoveries).toHaveLength(2);
    for (const recovery of recoveries) {
      expect(recovery).toContain('noaa_marine_find_stations');
      expect(recovery).toContain('types=["met"]');
    }
  });

  it('does not advertise an unfiltered NDBC search as the way to find station IDs', () => {
    const surfaces = [
      noaaMarineGetConditions.description,
      ...noaaMarineGetConditions.errors!.map((e) => e.recovery),
    ];
    for (const text of surfaces) {
      // The circular guidance was a bare source="ndbc" pointer with no capability filter.
      const pointers = text!.match(/source="ndbc"(?!\s+and\s+types)/g) ?? [];
      expect(pointers).toEqual([]);
    }
  });

  it('names the met filter in the buoy_not_found message, not just the recovery', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetConditions.errors });
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    const svc = getNdbcService();
    vi.spyOn(svc, 'getActiveStations').mockResolvedValue([]);
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    vi.spyOn(svc, 'fetchObservation').mockRejectedValue(notFound('HTTP 404', { statusCode: 404 }));

    const input = noaaMarineGetConditions.input.parse({ station_id: 'EBSW1' });
    const err = await noaaMarineGetConditions.handler(input, ctx).catch((e: unknown) => e);

    // Sibling tools already name the capability filter in the message — match them, so the
    // message cannot send a caller back to the unfiltered search that produced the bad ID.
    expect((err as Error).message).toContain('types=["met"]');
    expect((err as Error).message).not.toMatch(/noaa_marine_find_stations\.$/);
  });

  it('carries the met caveat rather than promising conditions data', () => {
    // hasMet is a strong but imperfect predictor — station 44033 is flagged met="n" and
    // still serves live wind/air-temp. The description must not overpromise.
    expect(noaaMarineGetConditions.description).toContain('most likely');
  });

  it('format renders station name, observation timestamp, and sensor values', () => {
    const output = {
      station_id: '46041',
      station_name: 'Cape Elizabeth',
      latitude: 47.35,
      longitude: -124.73,
      observed_at: '2025-01-15T12:00:00Z',
      source: 'ndbc',
      wind_direction_deg: 270,
      wind_speed_ms: 5.2,
      gust_speed_ms: 7.1,
      wave_height_m: 2.1,
      dominant_period_sec: 14,
      average_period_sec: 9.0,
      mean_wave_direction_deg: 275,
      pressure_hpa: 1013.5,
      air_temp_c: 12.3,
      water_temp_c: 11.0,
      dew_point_c: 8.5,
      visibility_nmi: null,
      tide_ft: null,
    };
    const blocks = noaaMarineGetConditions.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Cape Elizabeth');
    expect(text).toContain('46041');
    expect(text).toContain('2025-01-15T12:00:00Z');
    expect(text).toContain('5.2 m/s');
    expect(text).toContain('2.1 m');
    // JS renders 11.0 as '11', then ' °C' is appended
    expect(text).toContain('11');
    expect(text).toContain('°C');
  });

  it('format marks null sensor values as "not reported"', () => {
    const output = {
      station_id: '46041',
      station_name: 'Cape Elizabeth',
      latitude: 47.35,
      longitude: -124.73,
      observed_at: '2025-01-15T12:00:00Z',
      source: 'ndbc',
      wind_direction_deg: null,
      wind_speed_ms: null,
      gust_speed_ms: null,
      wave_height_m: null,
      dominant_period_sec: null,
      average_period_sec: null,
      mean_wave_direction_deg: null,
      pressure_hpa: null,
      air_temp_c: null,
      water_temp_c: 11.0,
      dew_point_c: null,
      visibility_nmi: null,
      tide_ft: null,
    };
    const blocks = noaaMarineGetConditions.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('not reported');
    expect(text).not.toContain('null');
  });
});

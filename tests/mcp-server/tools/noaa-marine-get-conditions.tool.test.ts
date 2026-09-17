/**
 * @fileoverview Tests for noaa_marine_get_conditions tool.
 * @module tests/mcp-server/tools/noaa-marine-get-conditions.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
  hasWaterQuality: false,
};

/** Equatorial mooring: the catalog reports a real lat="0" that must survive as 0, not null. */
const EQUATORIAL_STATION = {
  id: '15002',
  name: 'Java',
  lat: 0,
  lon: 95.28,
  hasMet: true,
  hasCurrents: false,
  hasWaterQuality: false,
};

const FULL_OBS = {
  observedAt: '2025-01-15T12:00:00Z',
  staleGroups: [],
  wavesObservedAt: '2025-01-15T12:00:00Z',
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
  staleGroups: [],
  wavesObservedAt: null,
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

/** All-null sensor output — the base every `format()` case overrides a field or two on. */
const NULL_OUTPUT = {
  station_id: '46041',
  station_name: 'Cape Elizabeth',
  latitude: 47.35 as number | null,
  longitude: -124.73 as number | null,
  observed_at: '2025-01-15T12:00:00Z',
  waves_observed_at: '2025-01-15T12:00:00Z' as string | null,
  source: 'ndbc',
  wind_direction_deg: null as number | null,
  wind_speed_ms: null as number | null,
  gust_speed_ms: null as number | null,
  wave_height_m: null as number | null,
  dominant_period_sec: null as number | null,
  average_period_sec: null as number | null,
  mean_wave_direction_deg: null as number | null,
  pressure_hpa: null as number | null,
  air_temp_c: null as number | null,
  water_temp_c: 11.0 as number | null,
  dew_point_c: null as number | null,
  visibility_nmi: null as number | null,
  tide_ft: null as number | null,
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
    // fetchWithTimeout throws a 404 before the service's own check runs: status, no reason.
    vi.spyOn(svc, 'fetchObservation').mockRejectedValue(notFound('HTTP 404', { status: 404 }));

    const input = noaaMarineGetConditions.input.parse({ station_id: 'ZZZZZ' });
    await expect(noaaMarineGetConditions.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'buoy_not_found' },
    });
  });

  // --- #17: a station with no active-stations entry has unknown coordinates, not 0, 0 ---

  it('falls back to station_id as name and null coordinates when station not in active list', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetConditions.errors });

    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    const svc = getNdbcService();
    vi.spyOn(svc, 'getActiveStations').mockResolvedValue([]); // station not in list
    vi.spyOn(svc, 'fetchObservation').mockResolvedValue(FULL_OBS);

    // OSTF1 serves a live .txt file and is absent from activestations.xml.
    const input = noaaMarineGetConditions.input.parse({ station_id: 'OSTF1' });
    const result = await noaaMarineGetConditions.handler(input, ctx);

    // A station ID is an honest label for a station; 0, 0 is a point in the Gulf of Guinea.
    expect(result.station_name).toBe('OSTF1');
    expect(result.latitude).toBeNull();
    expect(result.longitude).toBeNull();
    expect(Object.values(result)).not.toContain(0);
  });

  it('keeps a real catalog zero on one axis as 0, not null', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetConditions.errors });

    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    const svc = getNdbcService();
    vi.spyOn(svc, 'getActiveStations').mockResolvedValue([EQUATORIAL_STATION]);
    vi.spyOn(svc, 'fetchObservation').mockResolvedValue(FULL_OBS);

    const input = noaaMarineGetConditions.input.parse({ station_id: '15002' });
    const result = await noaaMarineGetConditions.handler(input, ctx);

    expect(result.latitude).toBe(0);
    expect(result.longitude).toBe(95.28);
  });

  it('returns catalog coordinates unchanged for a station present in the list', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetConditions.errors });

    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    const svc = getNdbcService();
    vi.spyOn(svc, 'getActiveStations').mockResolvedValue([NDBC_STATION]);
    vi.spyOn(svc, 'fetchObservation').mockResolvedValue(FULL_OBS);

    const input = noaaMarineGetConditions.input.parse({ station_id: '46041' });
    const result = await noaaMarineGetConditions.handler(input, ctx);

    expect(result.latitude).toBe(47.35);
    expect(result.longitude).toBe(-124.73);
  });

  it('declares nullable coordinates the same way the sibling NDBC tools do', async () => {
    const { noaaMarineGetCurrentProfile } = await import(
      '@/mcp-server/tools/definitions/noaa-marine-get-current-profile.tool.js'
    );
    const { noaaMarineGetOceanObservations } = await import(
      '@/mcp-server/tools/definitions/noaa-marine-get-ocean-observations.tool.js'
    );

    for (const axis of ['latitude', 'longitude'] as const) {
      for (const sibling of [noaaMarineGetCurrentProfile, noaaMarineGetOceanObservations]) {
        expect(noaaMarineGetConditions.output.shape[axis].safeParse(null).success).toBe(
          sibling.output.shape[axis].safeParse(null).success,
        );
      }
      expect(noaaMarineGetConditions.output.shape[axis].safeParse(null).success).toBe(true);
    }
  });

  // --- #20: a malformed-upstream failure is not reclassified as a NotFound reason ---

  it('lets a ServiceUnavailable from the parser pass through unreclassified', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetConditions.errors });

    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    const svc = getNdbcService();
    vi.spyOn(svc, 'getActiveStations').mockResolvedValue([]);

    const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
    vi.spyOn(svc, 'fetchObservation').mockRejectedValue(
      serviceUnavailable(
        "NDBC realtime file for BADTS carries no row with a valid observation timestamp — every row's time columns are malformed upstream.",
        { stationId: 'BADTS' },
      ),
    );

    const input = noaaMarineGetConditions.input.parse({ station_id: 'BADTS' });
    const err = await Promise.resolve(noaaMarineGetConditions.handler(input, ctx)).catch(
      (e: unknown) => e,
    );

    expect((err as { code: number }).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    // Distinct from both declared NotFound reasons (#6).
    expect((err as { data?: { reason?: string } }).data?.reason).toBeUndefined();
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
    vi.spyOn(svc, 'fetchObservation').mockRejectedValue(notFound('HTTP 404', { status: 404 }));

    const input = noaaMarineGetConditions.input.parse({ station_id: 'EBSW1' });
    const err = await Promise.resolve(noaaMarineGetConditions.handler(input, ctx)).catch(
      (e: unknown) => e,
    );

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
      waves_observed_at: '2025-01-15T12:00:00Z',
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
    const blocks = noaaMarineGetConditions.format!(NULL_OUTPUT);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('not reported');
    expect(text).not.toContain('null');
  });

  // --- #17: unknown coordinates render as unknown, never as a coordinate pair ---

  it('format renders unknown coordinates rather than a fabricated position', () => {
    const blocks = noaaMarineGetConditions.format!({
      ...NULL_OUTPUT,
      latitude: null,
      longitude: null,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Location:** unknown, unknown');
    expect(text).not.toContain('**Location:** 0, 0');
  });

  it('format renders both coordinates when the catalog has them', () => {
    const blocks = noaaMarineGetConditions.format!(NULL_OUTPUT);
    expect((blocks[0] as { text: string }).text).toContain('**Location:** 47.35, -124.73');
  });

  // --- #24: the resolved wave block carries its own timestamp on both surfaces ---

  it('returns the wave block timestamp in structuredContent', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetConditions.errors });

    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    const svc = getNdbcService();
    vi.spyOn(svc, 'getActiveStations').mockResolvedValue([NDBC_STATION]);
    vi.spyOn(svc, 'fetchObservation').mockResolvedValue({
      ...FULL_OBS,
      observedAt: '2026-09-17T15:10:00Z',
      wavesObservedAt: '2026-09-17T14:50:00Z',
    });

    const input = noaaMarineGetConditions.input.parse({ station_id: '46041' });
    const result = await noaaMarineGetConditions.handler(input, ctx);

    expect(result.observed_at).toBe('2026-09-17T15:10:00Z');
    expect(result.waves_observed_at).toBe('2026-09-17T14:50:00Z');
    expect(noaaMarineGetConditions.output.safeParse(result).success).toBe(true);
  });

  it('returns a null wave timestamp when no wave sample resolved', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetConditions.errors });

    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    const svc = getNdbcService();
    vi.spyOn(svc, 'getActiveStations').mockResolvedValue([NDBC_STATION]);
    vi.spyOn(svc, 'fetchObservation').mockResolvedValue(SPARSE_OBS);

    const input = noaaMarineGetConditions.input.parse({ station_id: '46041' });
    const result = await noaaMarineGetConditions.handler(input, ctx);

    expect(result.waves_observed_at).toBeNull();
    expect(result.wave_height_m).toBeNull();
  });

  it('format renders the wave block timestamp beside the wave values', () => {
    const blocks = noaaMarineGetConditions.format!({
      ...NULL_OUTPUT,
      observed_at: '2026-09-17T15:10:00Z',
      waves_observed_at: '2026-09-17T14:50:00Z',
      wave_height_m: 1.5,
      dominant_period_sec: 9,
      average_period_sec: 6.4,
      mean_wave_direction_deg: 306,
    });
    const text = (blocks[0] as { text: string }).text;

    expect(text).toContain('2026-09-17T14:50:00Z');
    expect(text).toContain('1.5 m');
    // A caller must not read the 14:50 wave sample as a 15:10 value.
    expect(text).toContain('2026-09-17T15:10:00Z');
  });

  it('format marks a missing wave timestamp rather than omitting the line', () => {
    const blocks = noaaMarineGetConditions.format!({ ...NULL_OUTPUT, waves_observed_at: null });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toMatch(/Sampled at: not reported/);
    expect(text).not.toContain('null');
  });

  // --- #24 disclosure: a block older than observed_at that no output field dates ---

  it('carries the stale-reading notice on structuredContent and content[]', async () => {
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    const svc = getNdbcService();
    vi.spyOn(svc, 'getActiveStations').mockResolvedValue([NDBC_STATION]);
    // Live 46119 shape: wind resolved from the row 10 minutes before the newest.
    vi.spyOn(svc, 'fetchObservation').mockResolvedValue({
      ...FULL_OBS,
      observedAt: '2026-09-17T15:55:00Z',
      wavesObservedAt: null,
      waveHeightM: null,
      dominantPeriodSec: null,
      averagePeriodSec: null,
      meanWaveDirectionDeg: null,
      staleGroups: [{ group: 'wind', observedAt: '2026-09-17T15:45:00Z' }],
    });

    const result = await runToolContract(noaaMarineGetConditions, { station_id: '46119' });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    // The notice names the output fields the caller holds, not the internal block name.
    expect(structured.notice).toContain('wind_speed_ms');
    expect(structured.notice).toContain('2026-09-17T15:45:00Z');
    expect(structured.notice).toContain('2026-09-17T15:55:00Z');

    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('wind_speed_ms');
    expect(text).toContain('2026-09-17T15:45:00Z');
  });

  it('leaves the wave block out of the notice — waves_observed_at already dates it', async () => {
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    const svc = getNdbcService();
    vi.spyOn(svc, 'getActiveStations').mockResolvedValue([NDBC_STATION]);
    vi.spyOn(svc, 'fetchObservation').mockResolvedValue({
      ...FULL_OBS,
      observedAt: '2026-09-17T15:10:00Z',
      wavesObservedAt: '2026-09-17T14:50:00Z',
      staleGroups: [{ group: 'wave', observedAt: '2026-09-17T14:50:00Z' }],
    });

    const result = await runToolContract(noaaMarineGetConditions, { station_id: '46041' });
    const structured = result.structuredContent as Record<string, unknown>;

    expect(structured.waves_observed_at).toBe('2026-09-17T14:50:00Z');
    expect(structured.notice).toBeUndefined();
  });

  it('emits no notice when every block came from the newest row', async () => {
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    const svc = getNdbcService();
    vi.spyOn(svc, 'getActiveStations').mockResolvedValue([NDBC_STATION]);
    vi.spyOn(svc, 'fetchObservation').mockResolvedValue(FULL_OBS);

    const result = await runToolContract(noaaMarineGetConditions, { station_id: '46041' });

    expect((result.structuredContent as Record<string, unknown>).notice).toBeUndefined();
  });

  it('does not claim a fixed ten-minute observation cadence', () => {
    // Measured row cadence across the live draw: 5, 6, 10, 15, 20, 30, and 60 minutes.
    expect(noaaMarineGetConditions.description).not.toMatch(/every 10 minutes/);
    expect(noaaMarineGetConditions.description).not.toMatch(/10–20 minutes old/);
    expect(noaaMarineGetConditions.description).toContain('waves_observed_at');
  });
});

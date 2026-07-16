/**
 * @fileoverview Tests for noaa_marine_get_ocean_observations tool.
 * @module tests/mcp-server/tools/noaa-marine-get-ocean-observations.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaMarineGetOceanObservations } from '@/mcp-server/tools/definitions/noaa-marine-get-ocean-observations.tool.js';
import { initNdbcService } from '@/services/ndbc/ndbc-service.js';

const NDBC_STATION = {
  id: 'TIBC1',
  name: 'Tiburon Pier, San Francisco Bay, CA',
  lat: 37.892,
  lon: -122.447,
  hasMet: true,
  hasCurrents: false,
  type: 'fixed',
};

/**
 * A realistic observation: a fully-populated reading (rich water-quality sensors) plus a second
 * depth reporting only temp/conductivity/salinity — exercises reading_count and null preservation.
 */
const OCEAN_OBS = {
  observedAt: '2026-07-16T09:30:00Z',
  readings: [
    {
      depthM: 0.0,
      waterTempC: 15.68,
      conductivityMsCm: null,
      salinityPsu: 31.24,
      oxygenPercent: 65.8,
      oxygenPpm: 5.41,
      chlorophyllUgL: 2.3,
      turbidityFtu: 112,
      ph: 7.99,
      redoxMv: null,
    },
    {
      depthM: 3.0,
      waterTempC: 15.5,
      conductivityMsCm: 50.34,
      salinityPsu: 33.0,
      oxygenPercent: null,
      oxygenPpm: null,
      chlorophyllUgL: null,
      turbidityFtu: null,
      ph: null,
      redoxMv: null,
    },
  ],
};

function setupNdbc() {
  initNdbcService();
}

describe('noaaMarineGetOceanObservations', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setupNdbc();
  });

  it('returns per-depth readings for a valid NDBC ocean station, preserving MM-as-null', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetOceanObservations.errors });

    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    const svc = getNdbcService();
    vi.spyOn(svc, 'getActiveStations').mockResolvedValue([NDBC_STATION]);
    vi.spyOn(svc, 'fetchOceanObservations').mockResolvedValue(OCEAN_OBS);

    const input = noaaMarineGetOceanObservations.input.parse({ station_id: 'TIBC1' });
    const result = await noaaMarineGetOceanObservations.handler(input, ctx);

    expect(result.station_id).toBe('TIBC1');
    expect(result.station_name).toBe('Tiburon Pier, San Francisco Bay, CA');
    expect(result.latitude).toBe(37.892);
    expect(result.longitude).toBe(-122.447);
    expect(result.observed_at).toBe('2026-07-16T09:30:00Z');
    expect(result.source).toBe('ndbc');
    expect(result.reading_count).toBe(2);
    // Every sensor column maps to its snake_case field; MM stays null, never a fabricated 0.
    expect(result.readings[0]).toEqual({
      depth_m: 0.0,
      water_temp_c: 15.68,
      conductivity_ms_cm: null,
      salinity_psu: 31.24,
      oxygen_percent: 65.8,
      oxygen_ppm: 5.41,
      chlorophyll_ug_l: 2.3,
      turbidity_ftu: 112,
      ph: 7.99,
      redox_mv: null,
    });
    expect(result.readings[1]!.conductivity_ms_cm).toBe(50.34);
    expect(result.readings[1]!.oxygen_percent).toBeNull();
  });

  it('throws ctx.fail("observations_not_found") on a bare 404 (no .ocean file)', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetOceanObservations.errors });

    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    const svc = getNdbcService();
    vi.spyOn(svc, 'getActiveStations').mockResolvedValue([]);

    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    // fetchWithTimeout throws a bare 404 (statusCode, no reason) before the service's own check.
    vi.spyOn(svc, 'fetchOceanObservations').mockRejectedValue(
      notFound('HTTP 404', { statusCode: 404 }),
    );

    const input = noaaMarineGetOceanObservations.input.parse({ station_id: 'ZZZZZ' });
    await expect(noaaMarineGetOceanObservations.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'observations_not_found' },
    });
  });

  it('preserves no_ocean_data when the .ocean file exists but every depth row is missing', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetOceanObservations.errors });

    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    const svc = getNdbcService();
    vi.spyOn(svc, 'getActiveStations').mockResolvedValue([]);

    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    vi.spyOn(svc, 'fetchOceanObservations').mockRejectedValue(
      notFound('NDBC station T1 reported no usable oceanographic readings — station offline.', {
        stationId: 'T1',
        reason: 'no_ocean_data',
      }),
    );

    const input = noaaMarineGetOceanObservations.input.parse({ station_id: 'T1' });
    await expect(noaaMarineGetOceanObservations.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_ocean_data' },
    });
  });

  it('reports id-as-name and null coordinates when the station is not in the active list', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetOceanObservations.errors });

    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    const svc = getNdbcService();
    vi.spyOn(svc, 'getActiveStations').mockResolvedValue([]); // station not in list
    vi.spyOn(svc, 'fetchOceanObservations').mockResolvedValue(OCEAN_OBS);

    const input = noaaMarineGetOceanObservations.input.parse({ station_id: 'TIBC1' });
    const result = await noaaMarineGetOceanObservations.handler(input, ctx);

    // The .ocean feed serves real observations but carries no coordinates; a station absent
    // from the active-stations list has none to borrow, so coords are null — never 0,0.
    expect(result.station_name).toBe('TIBC1');
    expect(result.latitude).toBeNull();
    expect(result.longitude).toBeNull();
    expect(result.latitude).not.toBe(0);
  });

  // --- discovery guidance must stay honest: no .ocean catalog flag exists to filter on ---

  it('gives honest best-effort discovery guidance without fabricating an ocean capability filter', () => {
    const recoveries = noaaMarineGetOceanObservations.errors!.map((e) => e.recovery);
    expect(recoveries).toHaveLength(2);
    for (const recovery of recoveries) {
      expect(recovery).toContain('noaa_marine_find_stations');
      expect(recovery).toContain('source="ndbc"');
    }
    // There is no .ocean capability flag in the station catalog, so no surface may claim a
    // types filter for it — that would route the caller at a filter that does not exist.
    const surfaces = [noaaMarineGetOceanObservations.description, ...recoveries];
    for (const text of surfaces) {
      expect(text).not.toContain('types=[');
    }
  });

  it('distinguishes itself from noaa_marine_get_conditions in its description', () => {
    // get_conditions (surface met/wave) vs this tool (sub-surface water column) is the trip hazard —
    // the description must name the sibling and the axis (below-surface) that separates them.
    expect(noaaMarineGetOceanObservations.description).toContain('noaa_marine_get_conditions');
    expect(noaaMarineGetOceanObservations.description).toMatch(
      /sub-surface|water-column|below the surface/i,
    );
  });

  it('format renders per-depth readings, marking missing sensors as not reported', () => {
    const output = {
      station_id: 'TIBC1',
      station_name: 'Tiburon Pier, San Francisco Bay, CA',
      latitude: 37.892,
      longitude: -122.447,
      observed_at: '2026-07-16T09:30:00Z',
      source: 'ndbc',
      reading_count: 1,
      readings: [
        {
          depth_m: 0.0,
          water_temp_c: 15.68,
          conductivity_ms_cm: null,
          salinity_psu: 31.24,
          oxygen_percent: 65.8,
          oxygen_ppm: 5.41,
          chlorophyll_ug_l: 2.3,
          turbidity_ftu: 112,
          ph: 7.99,
          redox_mv: null,
        },
      ],
    };
    const blocks = noaaMarineGetOceanObservations.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Tiburon Pier, San Francisco Bay, CA');
    expect(text).toContain('TIBC1');
    expect(text).toContain('2026-07-16T09:30:00Z');
    expect(text).toContain('15.68 °C');
    expect(text).toContain('Salinity: 31.24 psu');
    expect(text).toContain('7.99'); // pH
    // Null sensors (conductivity, redox) render as "not reported", never null or a fabricated 0.
    expect(text).toContain('not reported');
    expect(text).not.toContain('null');
  });
});

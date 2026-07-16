/**
 * @fileoverview Tests for noaa_marine_get_current_profile tool.
 * @module tests/mcp-server/tools/noaa-marine-get-current-profile.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaMarineGetCurrentProfile } from '@/mcp-server/tools/definitions/noaa-marine-get-current-profile.tool.js';
import { initNdbcService } from '@/services/ndbc/ndbc-service.js';

const NDBC_STATION = {
  id: '44033',
  name: 'Buoy F01 - Penobscot Bay',
  lat: 44.05,
  lon: -68.11,
  hasMet: false,
  hasCurrents: true,
  type: 'buoy',
};

/** A realistic profile: multiple depth bins, the deepest one missing both components. */
const FULL_PROFILE = {
  observedAt: '2026-07-16T00:00:00Z',
  bins: [
    { depthM: 2, directionDeg: 210, speedCmS: 19 },
    { depthM: 4, directionDeg: 300, speedCmS: 8 },
    { depthM: 6, directionDeg: null, speedCmS: null },
  ],
};

function setupNdbc() {
  initNdbcService();
}

describe('noaaMarineGetCurrentProfile', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setupNdbc();
  });

  it('returns the depth-binned profile for a valid NDBC ADCP station', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrentProfile.errors });

    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    const svc = getNdbcService();
    vi.spyOn(svc, 'getActiveStations').mockResolvedValue([NDBC_STATION]);
    vi.spyOn(svc, 'fetchCurrentProfile').mockResolvedValue(FULL_PROFILE);

    const input = noaaMarineGetCurrentProfile.input.parse({ station_id: '44033' });
    const result = await noaaMarineGetCurrentProfile.handler(input, ctx);

    expect(result.station_id).toBe('44033');
    expect(result.station_name).toBe('Buoy F01 - Penobscot Bay');
    expect(result.latitude).toBe(44.05);
    expect(result.longitude).toBe(-68.11);
    expect(result.observed_at).toBe('2026-07-16T00:00:00Z');
    expect(result.source).toBe('ndbc');
    expect(result.bin_count).toBe(3);
    expect(result.bins[0]).toEqual({ depth_m: 2, direction_deg: 210, speed_cm_s: 19 });
    // Missing components stay null — never fabricated to 0.
    expect(result.bins[2]).toEqual({ depth_m: 6, direction_deg: null, speed_cm_s: null });
  });

  it('throws ctx.fail("profile_not_found") on a bare 404 (no ADCP file)', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrentProfile.errors });

    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    const svc = getNdbcService();
    vi.spyOn(svc, 'getActiveStations').mockResolvedValue([]);

    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    // fetchWithTimeout throws a bare 404 (statusCode, no reason) before the service's own check.
    vi.spyOn(svc, 'fetchCurrentProfile').mockRejectedValue(
      notFound('HTTP 404', { statusCode: 404 }),
    );

    const input = noaaMarineGetCurrentProfile.input.parse({ station_id: 'ZZZZZ' });
    await expect(noaaMarineGetCurrentProfile.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'profile_not_found' },
    });
  });

  it('preserves no_current_data when the ADCP file exists but every bin is missing', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrentProfile.errors });

    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    const svc = getNdbcService();
    vi.spyOn(svc, 'getActiveStations').mockResolvedValue([]);

    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    vi.spyOn(svc, 'fetchCurrentProfile').mockRejectedValue(
      notFound('NDBC station T1 reported no usable current bins — profiler offline.', {
        stationId: 'T1',
        reason: 'no_current_data',
      }),
    );

    const input = noaaMarineGetCurrentProfile.input.parse({ station_id: 'T1' });
    await expect(noaaMarineGetCurrentProfile.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_current_data' },
    });
  });

  it('reports id-as-name and null coordinates when the station is not in the active list', async () => {
    const ctx = createMockContext({ errors: noaaMarineGetCurrentProfile.errors });

    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    const svc = getNdbcService();
    vi.spyOn(svc, 'getActiveStations').mockResolvedValue([]); // station not in list
    vi.spyOn(svc, 'fetchCurrentProfile').mockResolvedValue(FULL_PROFILE);

    const input = noaaMarineGetCurrentProfile.input.parse({ station_id: '44033' });
    const result = await noaaMarineGetCurrentProfile.handler(input, ctx);

    // The ADCP feed serves real current data but carries no coordinates; a station
    // absent from the active-stations list has none to borrow, so coords are null —
    // never a fabricated 0,0.
    expect(result.station_name).toBe('44033');
    expect(result.latitude).toBeNull();
    expect(result.longitude).toBeNull();
  });

  // --- #11 guard: discovery guidance must route to the capability filter, not the failing search ---

  it('points every recovery path at a current_profile-filtered NDBC search', () => {
    const recoveries = noaaMarineGetCurrentProfile.errors!.map((e) => e.recovery);
    expect(recoveries).toHaveLength(2);
    for (const recovery of recoveries) {
      expect(recovery).toContain('noaa_marine_find_stations');
      expect(recovery).toContain('types=["current_profile"]');
    }
  });

  it('does not advertise an unfiltered NDBC search as the way to find station IDs', () => {
    const surfaces = [
      noaaMarineGetCurrentProfile.description,
      ...noaaMarineGetCurrentProfile.errors!.map((e) => e.recovery),
    ];
    for (const text of surfaces) {
      const pointers = text!.match(/source="ndbc"(?!\s+and\s+types)/g) ?? [];
      expect(pointers).toEqual([]);
    }
  });

  it('distinguishes itself from the CO-OPS current-predictions tool in its description', () => {
    // The one-letter get_currents / get_current_profile collision is the #15 trip hazard —
    // the description must name the sibling and the axis (observed vs predicted) that separate them.
    expect(noaaMarineGetCurrentProfile.description).toContain('noaa_marine_get_currents');
    expect(noaaMarineGetCurrentProfile.description).toMatch(/observed/i);
  });

  it('format renders the profile as a depth table, marking missing components as not reported', () => {
    const output = {
      station_id: '44033',
      station_name: 'Buoy F01 - Penobscot Bay',
      latitude: 44.05,
      longitude: -68.11,
      observed_at: '2026-07-16T00:00:00Z',
      source: 'ndbc',
      bin_count: 2,
      bins: [
        { depth_m: 2, direction_deg: 210, speed_cm_s: 19 },
        { depth_m: 6, direction_deg: null, speed_cm_s: null },
      ],
    };
    const blocks = noaaMarineGetCurrentProfile.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Buoy F01 - Penobscot Bay');
    expect(text).toContain('44033');
    expect(text).toContain('2026-07-16T00:00:00Z');
    expect(text).toContain('| 2 | 210 | 19 |');
    // Null components render as "not reported", never null or 0.
    expect(text).toContain('not reported');
    expect(text).not.toContain('null');
  });
});

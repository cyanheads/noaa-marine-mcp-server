/**
 * @fileoverview Tests for noaa-marine://station/{station_id} resource.
 * @module tests/mcp-server/resources/noaa-marine-station.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaMarineStationResource } from '@/mcp-server/resources/definitions/noaa-marine-station.resource.js';
import { initCoopsService } from '@/services/coops/coops-service.js';
import { getNdbcService, initNdbcService } from '@/services/ndbc/ndbc-service.js';
import { callsTo, installCoopsFake } from '../../support/coops-http.js';

const COOPS_TIDE_STATION = {
  id: '9447130',
  name: 'Seattle',
  lat: 47.6,
  lng: -122.3,
  state: 'WA',
  type: 'R',
};

const NDBC_BUOY = {
  id: '46041',
  name: 'Cape Elizabeth',
  lat: 47.35,
  lon: -124.73,
  hasMet: true,
  hasCurrents: false,
  hasWaterQuality: false,
  type: 'buoy',
  owner: 'NOAA',
};

/** A fixed platform reporting no data capability — platform class is its only identity. */
const NDBC_FIXED_PLATFORM = {
  id: 'SANF1',
  name: 'Sand Key, FL',
  lat: 24.45,
  lon: -81.88,
  hasMet: false,
  hasCurrents: false,
  hasWaterQuality: false,
  type: 'fixed',
};

/** A currents-capable NDBC buoy — exercises the current_profile capability. */
const NDBC_CURRENTS = {
  id: '44033',
  name: 'Buoy F01 - Penobscot Bay',
  lat: 44.05,
  lon: -68.11,
  hasMet: false,
  hasCurrents: true,
  hasWaterQuality: false,
  type: 'buoy',
};

/**
 * A waterquality="y" station reporting neither met nor currents — the capability that reaches
 * noaa_marine_get_ocean_observations, and the only one this station has.
 */
const NDBC_WATER_QUALITY_ONLY = {
  id: 'WQON1',
  name: 'Water-quality only station',
  lat: 38.0,
  lon: -76.0,
  hasMet: false,
  hasCurrents: false,
  hasWaterQuality: true,
  type: 'fixed',
};

function setupServices() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initCoopsService(null as any, null as any, { applicationId: 'test' });
  initNdbcService();
}

describe('noaaMarineStationResource', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setupServices();
  });

  it('returns CO-OPS station metadata for a numeric tide station ID', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: noaaMarineStationResource.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockImplementation(async (type) => {
      if (type === 'tidepredictions') return [COOPS_TIDE_STATION];
      return [];
    });
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([]);

    const params = noaaMarineStationResource.params!.parse({ station_id: '9447130' });
    const result = (await noaaMarineStationResource.handler(params, ctx)) as Record<
      string,
      unknown
    >;

    expect(result).toMatchObject({
      station_id: '9447130',
      name: 'Seattle',
      source: 'coops',
      latitude: 47.6,
      longitude: -122.3,
    });
    // #14: type is the primary DATA capability, matching find_stations. The CO-OPS catalog
    // class is a different axis and reports under its own name on both surfaces.
    expect(result.type).toBe('tide');
    expect(result.prediction_class).toBe('reference');
    expect(result.capabilities).toEqual(['tide']);
    // CO-OPS publishes no platform taxonomy.
    expect(result).not.toHaveProperty('platform');
  });

  it('returns NDBC buoy metadata with platform class and capability-axis type', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: noaaMarineStationResource.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockResolvedValue([]);
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([NDBC_BUOY]);

    const params = noaaMarineStationResource.params!.parse({ station_id: '46041' });
    const result = (await noaaMarineStationResource.handler(params, ctx)) as Record<
      string,
      unknown
    >;

    expect(result).toMatchObject({
      station_id: '46041',
      name: 'Cape Elizabeth',
      source: 'ndbc',
      latitude: 47.35,
      longitude: -124.73,
    });
    // #14: platform class lives under `platform`; type is the data capability (same axis both surfaces).
    expect(result.platform).toBe('buoy');
    expect(result.type).toBe('met');
    expect(result.capabilities).toEqual(['met']);
  });

  it('is case-insensitive for station ID lookup', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: noaaMarineStationResource.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockResolvedValue([]);
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([NDBC_BUOY]);

    const params = noaaMarineStationResource.params!.parse({ station_id: '46041' });
    const result = await noaaMarineStationResource.handler(params, ctx);
    expect(result).toMatchObject({ station_id: '46041' });
  });

  it('throws NotFound when station ID is not in CO-OPS or NDBC', async () => {
    const ctx = createMockContext({
      tenantId: 'test',
      errors: noaaMarineStationResource.errors,
    });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockResolvedValue([]);
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([]);

    const params = noaaMarineStationResource.params!.parse({ station_id: 'NOSUCHSTATION' });
    await expect(noaaMarineStationResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  // --- #21: a rejected fan-out leg must not be reported as "the ID is in neither catalog" ---

  it('answers with an unavailability error naming the unread source when a leg rejected', async () => {
    const ctx = createMockContext({
      tenantId: 'test',
      errors: noaaMarineStationResource.errors,
    });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockRejectedValue(new Error('CO-OPS down'));
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([NDBC_BUOY]);

    const params = noaaMarineStationResource.params!.parse({ station_id: '9447130' });
    const err = await Promise.resolve(noaaMarineStationResource.handler(params, ctx)).catch(
      (e: unknown) => e,
    );

    // CO-OPS was never read, so "not found in CO-OPS or NDBC" would be a fabricated fact.
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'source_unavailable' },
    });
    expect((err as Error).message).toContain('coops');
    expect((err as Error).message).not.toContain('not found in CO-OPS or NDBC');
  });

  it('still returns the station when a leg rejected but the surviving catalog carries the ID', async () => {
    const ctx = createMockContext({
      tenantId: 'test',
      errors: noaaMarineStationResource.errors,
    });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockRejectedValue(new Error('CO-OPS down'));
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([NDBC_BUOY]);

    const params = noaaMarineStationResource.params!.parse({ station_id: '46041' });
    const result = (await noaaMarineStationResource.handler(params, ctx)) as Record<
      string,
      unknown
    >;

    expect(result).toMatchObject({ station_id: '46041', source: 'ndbc', type: 'met' });
  });

  it('reports NDBC as the unread source when the NDBC leg rejected', async () => {
    const ctx = createMockContext({
      tenantId: 'test',
      errors: noaaMarineStationResource.errors,
    });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockResolvedValue([]);
    vi.spyOn(getNdbcService(), 'getActiveStations').mockRejectedValue(new Error('NDBC down'));

    const params = noaaMarineStationResource.params!.parse({ station_id: '46041' });
    const err = await Promise.resolve(noaaMarineStationResource.handler(params, ctx)).catch(
      (e: unknown) => e,
    );

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'source_unavailable' },
    });
    expect((err as Error).message).toContain('ndbc');
  });

  it('reports both sources as unread when both legs rejected', async () => {
    const ctx = createMockContext({
      tenantId: 'test',
      errors: noaaMarineStationResource.errors,
    });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockRejectedValue(new Error('CO-OPS down'));
    vi.spyOn(getNdbcService(), 'getActiveStations').mockRejectedValue(new Error('NDBC down'));

    const params = noaaMarineStationResource.params!.parse({ station_id: '9447130' });
    const err = await Promise.resolve(noaaMarineStationResource.handler(params, ctx)).catch(
      (e: unknown) => e,
    );

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'source_unavailable' },
    });
    expect((err as Error).message).toContain('coops');
    expect((err as Error).message).toContain('ndbc');
  });

  // --- #28: the waterquality flag reads the same on this surface as on find_stations (#14) ---

  it('reports water_quality as the capability for a waterquality-flagged NDBC station', async () => {
    const ctx = createMockContext({
      tenantId: 'test',
      errors: noaaMarineStationResource.errors,
    });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockResolvedValue([]);
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([NDBC_WATER_QUALITY_ONLY]);

    const params = noaaMarineStationResource.params!.parse({ station_id: 'WQON1' });
    const result = (await noaaMarineStationResource.handler(params, ctx)) as Record<
      string,
      unknown
    >;

    expect(result.capabilities).toEqual(['water_quality']);
    expect(result.type).toBe('water_quality');
    expect(result.platform).toBe('fixed');
  });

  it('lists water_quality alongside met for a station carrying both flags', async () => {
    const ctx = createMockContext({
      tenantId: 'test',
      errors: noaaMarineStationResource.errors,
    });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockResolvedValue([]);
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([
      { ...NDBC_BUOY, hasWaterQuality: true },
    ]);

    const params = noaaMarineStationResource.params!.parse({ station_id: '46041' });
    const result = (await noaaMarineStationResource.handler(params, ctx)) as Record<
      string,
      unknown
    >;

    expect(result.capabilities).toEqual(['met', 'water_quality']);
    expect(result.type).toBe('met');
  });

  it('does not give a waterquality="n" station the water_quality capability', async () => {
    const ctx = createMockContext({
      tenantId: 'test',
      errors: noaaMarineStationResource.errors,
    });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockResolvedValue([]);
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([NDBC_FIXED_PLATFORM]);

    const params = noaaMarineStationResource.params!.parse({ station_id: 'SANF1' });
    const result = (await noaaMarineStationResource.handler(params, ctx)) as Record<
      string,
      unknown
    >;

    expect(result.capabilities).toEqual([]);
  });

  it('deduplicates capabilities when station appears multiple times in a CO-OPS list', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: noaaMarineStationResource.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    // Simulate PUG1616 appearing 3 times in currentpredictions (different current bins)
    const PUG1616 = { id: 'PUG1616', name: 'Admiralty Inlet', lat: 48.03, lng: -122.64, type: 'H' };
    vi.spyOn(getCoopsService(), 'getStations').mockImplementation(async (type) => {
      if (type === 'currentpredictions') return [PUG1616, PUG1616, PUG1616];
      return [];
    });
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([]);

    const params = noaaMarineStationResource.params!.parse({ station_id: 'PUG1616' });
    const result = (await noaaMarineStationResource.handler(params, ctx)) as Record<
      string,
      unknown
    >;

    expect(result.capabilities).toEqual(['current']);
  });

  // --- #26/#27: the CO-OPS prediction class and current-prediction bins on this surface ---

  it('reports the tide prediction class and reference station for a subordinate tide station', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: noaaMarineStationResource.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockImplementation(async (type) =>
      type === 'tidepredictions'
        ? [
            {
              id: '9440563',
              name: 'Hungry Harbor, Wash.',
              lat: 46.2583,
              lng: -123.848,
              state: 'WA',
              type: 'S',
              reference_id: '9439040',
            },
          ]
        : [],
    );
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([]);

    const params = noaaMarineStationResource.params!.parse({ station_id: '9440563' });
    const result = (await noaaMarineStationResource.handler(params, ctx)) as Record<
      string,
      unknown
    >;

    expect(result.prediction_class).toBe('subordinate');
    expect(result.reference_id).toBe('9439040');
    expect(result).not.toHaveProperty('bins');
  });

  it('reports every current-prediction bin with its own class', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: noaaMarineStationResource.errors });

    const base = { id: 'BOS1104', name: 'Boston Harbor Approach', lat: 42.33, lng: -70.9 };
    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockImplementation(async (type) =>
      type === 'currentpredictions'
        ? [
            { ...base, currbin: 1, depth: 12, depthType: 'B', type: 'H' },
            { ...base, currbin: 2, depth: null, depthType: 'U', type: 'W' },
          ]
        : [],
    );
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([]);

    const params = noaaMarineStationResource.params!.parse({ station_id: 'BOS1104' });
    const result = (await noaaMarineStationResource.handler(params, ctx)) as Record<
      string,
      unknown
    >;

    expect(result.capabilities).toEqual(['current']);
    expect(result.bins).toEqual([
      { bin: 1, depth: 12, depth_type: 'B', prediction_class: 'harmonic' },
      { bin: 2, depth: null, depth_type: 'U', prediction_class: 'weak_and_variable' },
    ]);
    // A current station's class is per bin, so the row carries none.
    expect(result).not.toHaveProperty('prediction_class');
  });

  it('includes owner field for NDBC stations that have one', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: noaaMarineStationResource.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockResolvedValue([]);
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([NDBC_BUOY]);

    const params = noaaMarineStationResource.params!.parse({ station_id: '46041' });
    const result = (await noaaMarineStationResource.handler(params, ctx)) as Record<
      string,
      unknown
    >;
    expect(result.owner).toBe('NOAA');
  });

  it('does not fabricate a buoy capability for a bare platform (#13)', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: noaaMarineStationResource.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockResolvedValue([]);
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([NDBC_FIXED_PLATFORM]);

    const params = noaaMarineStationResource.params!.parse({ station_id: 'SANF1' });
    const result = (await noaaMarineStationResource.handler(params, ctx)) as Record<
      string,
      unknown
    >;

    // The old fallback asserted capabilities:["buoy"] and type:"buoy" for a fixed platform.
    expect(result.capabilities).toEqual([]);
    expect(result).not.toHaveProperty('type');
    // Platform class is reported honestly — a fixed platform, not a buoy.
    expect(result.platform).toBe('fixed');
  });

  it('reports current_profile as the capability for an NDBC currents station', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: noaaMarineStationResource.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockResolvedValue([]);
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([NDBC_CURRENTS]);

    const params = noaaMarineStationResource.params!.parse({ station_id: '44033' });
    const result = (await noaaMarineStationResource.handler(params, ctx)) as Record<
      string,
      unknown
    >;

    expect(result.capabilities).toEqual(['current_profile']);
    expect(result.type).toBe('current_profile');
    expect(result.platform).toBe('buoy');
  });

  // --- #20: a decoded owner must reach the resource surface ---

  it('surfaces a decoded owner from the live catalog feed', async () => {
    // Drives the real XML parser through the service rather than a pre-decoded fixture —
    // a mocked getActiveStations would never run the decode this pins.
    const ctx = createMockContext({ tenantId: 'test', errors: noaaMarineStationResource.errors });
    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockResolvedValue([]);

    const http = createFetchMock([
      {
        match: (request) => request.url.includes('activestations.xml'),
        respond: new Response(
          `<?xml version="1.0"?><ActiveStations>` +
            `<Station id="42092" lat="27.639" lon="-97.012" name="Aransas Pass Channel Entrance S, TX (252)" ` +
            `owner="Conrad Blucher Institute (CBI) for Surveying and Science, Texas A&amp;M University-Corpus Christi" ` +
            `type="buoy" met="y" currents="n" waterquality="n"/>` +
            `</ActiveStations>`,
          { headers: { 'content-type': 'text/xml' } },
        ),
      },
    ]);

    http.install();
    try {
      const params = noaaMarineStationResource.params!.parse({ station_id: '42092' });
      const result = (await noaaMarineStationResource.handler(params, ctx)) as Record<
        string,
        unknown
      >;

      expect(result.owner).toBe(
        'Conrad Blucher Institute (CBI) for Surveying and Science, Texas A&M University-Corpus Christi',
      );
      expect(JSON.stringify(result)).not.toContain('&amp;');
    } finally {
      http.restore();
    }
  });
});

// --- #37: a throttled CO-OPS catalog clears after a couple of minutes, not "a few moments" ---

describe('noaaMarineStationResource under a CO-OPS throttle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initCoopsService(null as any, null as any, { applicationId: 'test' });
    initNdbcService();
  });

  /** Reads the station through the real CO-OPS service against a fake upstream. */
  async function readStation(stationId: string, coopsStatus: number) {
    const ctx = createMockContext({ tenantId: 'test', errors: noaaMarineStationResource.errors });
    const http = installCoopsFake(
      () => new Response('{"message":"refused"}', { status: coopsStatus }),
    );
    try {
      const params = noaaMarineStationResource.params!.parse({ station_id: stationId });
      let outcome: { error?: unknown; value?: unknown };
      try {
        outcome = { value: await noaaMarineStationResource.handler(params, ctx) };
      } catch (error) {
        outcome = { error };
      }
      return { ...outcome, catalogCalls: callsTo(http, 'catalog').length };
    } finally {
      http.restore();
    }
  }

  function hintOf(error: unknown): string {
    const hint = (error as { data?: { recovery?: { hint?: unknown } } }).data?.recovery?.hint;
    if (typeof hint !== 'string') throw new Error('The error carries no recovery hint.');
    return hint;
  }

  it('names the wait in source_unavailable when the CO-OPS catalog was throttled', async () => {
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([NDBC_BUOY]);

    const { error, catalogCalls } = await readStation('9447130', 403);

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'source_unavailable', unread_sources: ['coops'] },
    });
    expect(hintOf(error)).toContain('couple of minutes');
    expect(hintOf(error)).not.toContain('a few moments');
    // One request per catalog, none re-sent into the block.
    expect(catalogCalls).toBe(3);
  });

  it('names the wait when both catalogs failed and CO-OPS was the throttle', async () => {
    vi.spyOn(getNdbcService(), 'getActiveStations').mockRejectedValue(new Error('NDBC down'));

    const { error } = await readStation('9447130', 403);

    expect(error).toMatchObject({
      data: { reason: 'source_unavailable', unread_sources: ['coops', 'ndbc'] },
    });
    expect(hintOf(error)).toContain('couple of minutes');
  });

  it('keeps the original recovery for a CO-OPS catalog failure that is not the throttle', async () => {
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([NDBC_BUOY]);

    const { error } = await readStation('9447130', 404);

    expect(error).toMatchObject({ data: { reason: 'source_unavailable' } });
    expect(hintOf(error)).toBe(
      'Retry in a few moments — the station catalogs are cached for six hours once a fetch succeeds.',
    );
  });

  it('still answers from NDBC when CO-OPS is throttled and NDBC carries the ID', async () => {
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([NDBC_BUOY]);

    const { value, error } = await readStation('46041', 403);

    expect(error).toBeUndefined();
    expect(value).toMatchObject({ station_id: '46041', source: 'ndbc' });
  });
});

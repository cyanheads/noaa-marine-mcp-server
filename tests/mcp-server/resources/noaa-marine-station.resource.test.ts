/**
 * @fileoverview Tests for noaa-marine://station/{station_id} resource.
 * @module tests/mcp-server/resources/noaa-marine-station.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaMarineStationResource } from '@/mcp-server/resources/definitions/noaa-marine-station.resource.js';
import { initCoopsService } from '@/services/coops/coops-service.js';
import { initNdbcService } from '@/services/ndbc/ndbc-service.js';

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
  type: 'buoy',
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
    const ctx = createMockContext({ tenantId: 'test' });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockImplementation(async (type) => {
      if (type === 'tidepredictions') return [COOPS_TIDE_STATION];
      return [];
    });
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([]);

    const params = noaaMarineStationResource.params.parse({ station_id: '9447130' });
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
    // #14: type is the primary DATA capability, matching find_stations — not the CO-OPS R/T/S
    // catalog code ('R'), which is a different axis and is not surfaced.
    expect(result.type).toBe('tide');
    expect(result.capabilities).toEqual(['tide']);
    // CO-OPS publishes no platform taxonomy.
    expect(result).not.toHaveProperty('platform');
  });

  it('returns NDBC buoy metadata with platform class and capability-axis type', async () => {
    const ctx = createMockContext({ tenantId: 'test' });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockResolvedValue([]);
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([NDBC_BUOY]);

    const params = noaaMarineStationResource.params.parse({ station_id: '46041' });
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
    const ctx = createMockContext({ tenantId: 'test' });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockResolvedValue([]);
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([NDBC_BUOY]);

    const params = noaaMarineStationResource.params.parse({ station_id: '46041' });
    const result = await noaaMarineStationResource.handler(params, ctx);
    expect(result).toMatchObject({ station_id: '46041' });
  });

  it('throws NotFound when station ID is not in CO-OPS or NDBC', async () => {
    const ctx = createMockContext({ tenantId: 'test' });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockResolvedValue([]);
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([]);

    const params = noaaMarineStationResource.params.parse({ station_id: 'NOSUCHSTATION' });
    await expect(noaaMarineStationResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('deduplicates capabilities when station appears multiple times in a CO-OPS list', async () => {
    const ctx = createMockContext({ tenantId: 'test' });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    // Simulate PUG1616 appearing 3 times in currentpredictions (different current bins)
    const PUG1616 = { id: 'PUG1616', name: 'Admiralty Inlet', lat: 48.03, lng: -122.64, type: 'H' };
    vi.spyOn(getCoopsService(), 'getStations').mockImplementation(async (type) => {
      if (type === 'currentpredictions') return [PUG1616, PUG1616, PUG1616];
      return [];
    });
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([]);

    const params = noaaMarineStationResource.params.parse({ station_id: 'PUG1616' });
    const result = (await noaaMarineStationResource.handler(params, ctx)) as Record<
      string,
      unknown
    >;

    expect(result.capabilities).toEqual(['current']);
  });

  it('includes owner field for NDBC stations that have one', async () => {
    const ctx = createMockContext({ tenantId: 'test' });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockResolvedValue([]);
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([NDBC_BUOY]);

    const params = noaaMarineStationResource.params.parse({ station_id: '46041' });
    const result = (await noaaMarineStationResource.handler(params, ctx)) as Record<
      string,
      unknown
    >;
    expect(result.owner).toBe('NOAA');
  });

  it('does not fabricate a buoy capability for a bare platform (#13)', async () => {
    const ctx = createMockContext({ tenantId: 'test' });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockResolvedValue([]);
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([NDBC_FIXED_PLATFORM]);

    const params = noaaMarineStationResource.params.parse({ station_id: 'SANF1' });
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
    const ctx = createMockContext({ tenantId: 'test' });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockResolvedValue([]);
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([NDBC_CURRENTS]);

    const params = noaaMarineStationResource.params.parse({ station_id: '44033' });
    const result = (await noaaMarineStationResource.handler(params, ctx)) as Record<
      string,
      unknown
    >;

    expect(result.capabilities).toEqual(['current_profile']);
    expect(result.type).toBe('current_profile');
    expect(result.platform).toBe('buoy');
  });
});

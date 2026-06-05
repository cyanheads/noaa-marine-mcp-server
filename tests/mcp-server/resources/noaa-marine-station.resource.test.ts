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

function setupServices() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initCoopsService(null as any, null as any, { applicationId: 'test' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initNdbcService(null as any, null as any);
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
    const result = await noaaMarineStationResource.handler(params, ctx);

    expect(result).toMatchObject({
      station_id: '9447130',
      name: 'Seattle',
      source: 'coops',
      latitude: 47.6,
      longitude: -122.3,
    });
  });

  it('returns NDBC buoy metadata for an NDBC station ID', async () => {
    const ctx = createMockContext({ tenantId: 'test' });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockResolvedValue([]);
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([NDBC_BUOY]);

    const params = noaaMarineStationResource.params.parse({ station_id: '46041' });
    const result = await noaaMarineStationResource.handler(params, ctx);

    expect(result).toMatchObject({
      station_id: '46041',
      name: 'Cape Elizabeth',
      source: 'ndbc',
      latitude: 47.35,
      longitude: -124.73,
    });
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
});

/**
 * @fileoverview Tests for noaa_marine_find_stations tool.
 * @module tests/mcp-server/tools/noaa-marine-find-stations.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaMarineFindStations } from '@/mcp-server/tools/definitions/noaa-marine-find-stations.tool.js';
import { initCoopsService } from '@/services/coops/coops-service.js';
import { initNdbcService } from '@/services/ndbc/ndbc-service.js';

// Minimal CO-OPS station fixture
const COOPS_TIDE_STATION = {
  id: '9447130',
  name: 'Seattle',
  lat: 47.6,
  lng: -122.3,
  state: 'WA',
  type: 'R',
};

// Minimal NDBC buoy fixture
const NDBC_BUOY = {
  id: '46041',
  name: 'Cape Elizabeth',
  lat: 47.35,
  lon: -124.73,
  hasMet: true,
  hasCurrents: false,
};

describe('noaaMarineFindStations', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns stations matching a name query (CO-OPS)', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });

    // Mock getStations on the singleton
    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initCoopsService(null as any, null as any, { applicationId: 'test' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initNdbcService(null as any, null as any);

    const coopsSvc = getCoopsService();
    const ndbcSvc = getNdbcService();
    vi.spyOn(coopsSvc, 'getStations').mockImplementation(async (type) => {
      if (type === 'tidepredictions') return [COOPS_TIDE_STATION];
      return [];
    });
    vi.spyOn(ndbcSvc, 'getActiveStations').mockResolvedValue([]);

    const input = noaaMarineFindStations.input.parse({ query: 'seattle', source: 'coops' });
    const result = await noaaMarineFindStations.handler(input, ctx);

    expect(result.stations).toHaveLength(1);
    expect(result.stations[0]!.station_id).toBe('9447130');
    expect(result.stations[0]!.source).toBe('coops');
    expect(result.total_found).toBe(1);
  });

  it('returns NDBC buoys when source=ndbc', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initCoopsService(null as any, null as any, { applicationId: 'test' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initNdbcService(null as any, null as any);

    vi.spyOn(getCoopsService(), 'getStations').mockResolvedValue([]);
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([NDBC_BUOY]);

    const input = noaaMarineFindStations.input.parse({ source: 'ndbc', limit: 10 });
    const result = await noaaMarineFindStations.handler(input, ctx);

    expect(result.stations.length).toBeGreaterThanOrEqual(1);
    expect(result.stations[0]!.source).toBe('ndbc');
    expect(result.stations[0]!.station_id).toBe('46041');
  });

  it('throws ctx.fail("no_results") when nothing matches', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initCoopsService(null as any, null as any, { applicationId: 'test' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initNdbcService(null as any, null as any);
    vi.spyOn(getCoopsService(), 'getStations').mockResolvedValue([]);
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([]);

    const input = noaaMarineFindStations.input.parse({ query: 'nonexistent_xyz', source: 'all' });
    await expect(noaaMarineFindStations.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_results' },
    });
  });

  it('computes distance and filters by radius when lat/lon provided', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initCoopsService(null as any, null as any, { applicationId: 'test' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initNdbcService(null as any, null as any);
    vi.spyOn(getCoopsService(), 'getStations').mockImplementation(async (type) =>
      type === 'tidepredictions' ? [COOPS_TIDE_STATION] : [],
    );
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([]);

    // Seattle is at ~47.6, -122.3 — search from very close by with small radius
    const input = noaaMarineFindStations.input.parse({
      latitude: 47.61,
      longitude: -122.31,
      radius_km: 10,
      source: 'coops',
    });
    const result = await noaaMarineFindStations.handler(input, ctx);

    expect(result.stations[0]!.distance_km).toBeDefined();
    expect(result.stations[0]!.distance_km!).toBeLessThan(10);
  });

  it('deduplicates capabilities when station appears multiple times in a list', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initCoopsService(null as any, null as any, { applicationId: 'test' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initNdbcService(null as any, null as any);
    // Simulate current station appearing 3 times (different bins) in currentpredictions
    vi.spyOn(getCoopsService(), 'getStations').mockImplementation(async (type) => {
      if (type === 'currentpredictions') {
        return [
          { ...COOPS_TIDE_STATION, id: 'PUG1616', state: undefined },
          { ...COOPS_TIDE_STATION, id: 'PUG1616', state: undefined },
          { ...COOPS_TIDE_STATION, id: 'PUG1616', state: undefined },
        ];
      }
      return [];
    });
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([]);

    const input = noaaMarineFindStations.input.parse({ query: 'seattle', source: 'coops' });
    const result = await noaaMarineFindStations.handler(input, ctx);

    expect(result.stations).toHaveLength(1);
    expect(result.stations[0]!.capabilities).toEqual(['current']);
  });

  it('format renders station_id, name, source, and capabilities', () => {
    const output = {
      total_found: 1,
      stations: [
        {
          station_id: '9447130',
          name: 'Seattle',
          source: 'coops' as const,
          type: 'tide',
          latitude: 47.6,
          longitude: -122.3,
          capabilities: ['tide', 'water_level'],
        },
      ],
    };
    const blocks = noaaMarineFindStations.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('9447130');
    expect(text).toContain('Seattle');
    expect(text).toContain('tide');
    expect(text).toContain('water_level');
  });
});

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

/**
 * TFBLK shape — NDBC flags it met="n", but its platform `type` string contains "buoy".
 * 126 of the 1359 currently-active NDBC stations look like this.
 */
const NDBC_NON_MET_BUOY = {
  id: 'TFBLK',
  name: '10.0 nm WNW on Blakknes, Iceland',
  lat: 65.6,
  lon: -24.3,
  type: 'buoy',
  hasMet: false,
  hasCurrents: false,
};

/** 44033 shape — the only active NDBC station whose sole capability is currents. */
const NDBC_CURRENTS_ONLY = {
  id: '44033',
  name: 'Buoy F01 - Penobscot Bay',
  lat: 44.05,
  lon: -68.11,
  type: 'buoy',
  hasMet: false,
  hasCurrents: true,
};

/** 32489 shape — a real station name carrying the run of spaces a blank query used to match. */
const NDBC_SPACED_NAME = {
  id: '32489',
  name: 'Colombia   121NM SW of Buenaventura, Colombia',
  lat: 3.0,
  lon: -78.4,
  type: 'dart',
  hasMet: false,
  hasCurrents: false,
};

/** Wires both service singletons to fixed catalogs, keyed by CO-OPS station-list type. */
async function mockCatalog(coops: Record<string, unknown[]>, ndbc: unknown[] = []): Promise<void> {
  const { getCoopsService } = await import('@/services/coops/coops-service.js');
  const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initCoopsService(null as any, null as any, { applicationId: 'test' });
  initNdbcService();
  vi.spyOn(getCoopsService(), 'getStations').mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (type) => (coops[type] ?? []) as any,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue(ndbc as any);
}

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
    initNdbcService();

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
    initNdbcService();

    vi.spyOn(getCoopsService(), 'getStations').mockResolvedValue([]);
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([NDBC_BUOY]);

    const input = noaaMarineFindStations.input.parse({ source: 'ndbc', limit: 10 });
    const result = await noaaMarineFindStations.handler(input, ctx);

    expect(result.stations.length).toBeGreaterThanOrEqual(1);
    expect(result.stations[0]!.source).toBe('ndbc');
    expect(result.stations[0]!.station_id).toBe('46041');
  });

  it('excludes NDBC buoys when a state filter is set and source=all', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initCoopsService(null as any, null as any, { applicationId: 'test' });
    initNdbcService();

    vi.spyOn(getCoopsService(), 'getStations').mockImplementation(async (type) =>
      type === 'tidepredictions' ? [COOPS_TIDE_STATION] : [],
    );
    const ndbcSpy = vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([NDBC_BUOY]);

    const input = noaaMarineFindStations.input.parse({ state: 'WA', source: 'all', limit: 20 });
    const result = await noaaMarineFindStations.handler(input, ctx);

    // Only the WA CO-OPS station — no state-less NDBC buoys leak in.
    expect(result.stations.every((s) => s.source === 'coops')).toBe(true);
    expect(result.stations.some((s) => s.source === 'ndbc')).toBe(false);
    expect(result.stations[0]!.station_id).toBe('9447130');
    // NDBC list is not even fetched when a state filter is present.
    expect(ndbcSpy).not.toHaveBeenCalled();
  });

  it('includes NDBC buoys with source=all when no state filter is set', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initCoopsService(null as any, null as any, { applicationId: 'test' });
    initNdbcService();

    vi.spyOn(getCoopsService(), 'getStations').mockImplementation(async (type) =>
      type === 'tidepredictions' ? [COOPS_TIDE_STATION] : [],
    );
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([NDBC_BUOY]);

    const input = noaaMarineFindStations.input.parse({ source: 'all', limit: 20 });
    const result = await noaaMarineFindStations.handler(input, ctx);

    expect(result.stations.some((s) => s.source === 'ndbc')).toBe(true);
    expect(result.stations.some((s) => s.source === 'coops')).toBe(true);
  });

  it('throws ctx.fail("no_results") when nothing matches', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initCoopsService(null as any, null as any, { applicationId: 'test' });
    initNdbcService();
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
    initNdbcService();
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
    initNdbcService();
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

  // --- #9: incomplete coordinates / blank query ---

  it('rejects a latitude-only search naming the missing longitude', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    await mockCatalog({ tidepredictions: [COOPS_TIDE_STATION] }, [NDBC_BUOY]);

    const input = noaaMarineFindStations.input.parse({ latitude: 47.6, limit: 3 });
    const err = await noaaMarineFindStations.handler(input, ctx).catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'incomplete_coordinates' },
    });
    expect((err as Error).message).toContain('longitude');
  });

  it('rejects a longitude-only search naming the missing latitude', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    await mockCatalog({ tidepredictions: [COOPS_TIDE_STATION] }, [NDBC_BUOY]);

    const input = noaaMarineFindStations.input.parse({ longitude: -122.33, limit: 3 });
    const err = await noaaMarineFindStations.handler(input, ctx).catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'incomplete_coordinates' },
    });
    expect((err as Error).message).toContain('latitude');
  });

  it('treats a whitespace-only query as omitted instead of matching runs of spaces', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    await mockCatalog({}, [NDBC_SPACED_NAME, NDBC_BUOY]);

    const input = noaaMarineFindStations.input.parse({ query: '   ', source: 'ndbc', limit: 10 });
    const result = await noaaMarineFindStations.handler(input, ctx);

    // Blank query = no name filter, so the run-of-spaces name gets no special standing.
    expect(result.total_found).toBe(2);
    expect(result.stations.map((s) => s.station_id).sort()).toEqual(['32489', '46041']);
  });

  it('still applies a query that is only padded with whitespace', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    await mockCatalog({}, [NDBC_SPACED_NAME, NDBC_BUOY]);

    const input = noaaMarineFindStations.input.parse({
      query: '  cape  ',
      source: 'ndbc',
      limit: 10,
    });
    const result = await noaaMarineFindStations.handler(input, ctx);

    expect(result.stations).toHaveLength(1);
    expect(result.stations[0]!.station_id).toBe('46041');
  });

  // --- #10: NDBC met filter must require the met flag ---

  it('excludes met=false buoy-typed stations from a types:["met"] filter', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    await mockCatalog({}, [NDBC_NON_MET_BUOY, NDBC_BUOY]);

    const input = noaaMarineFindStations.input.parse({
      source: 'ndbc',
      types: ['met'],
      limit: 5,
    });
    const result = await noaaMarineFindStations.handler(input, ctx);

    expect(result.stations.map((s) => s.station_id)).toEqual(['46041']);
    expect(result.stations.every((s) => s.capabilities.includes('met'))).toBe(true);
  });

  it('matches a met=false buoy-typed station on a types:["buoy"] filter', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    await mockCatalog({}, [NDBC_NON_MET_BUOY, NDBC_BUOY]);

    const input = noaaMarineFindStations.input.parse({
      source: 'ndbc',
      types: ['buoy'],
      limit: 5,
    });
    const result = await noaaMarineFindStations.handler(input, ctx);

    // Met-capable rows are no longer a catch-all match for `buoy`.
    expect(result.stations.map((s) => s.station_id)).toEqual(['TFBLK']);
    expect(result.stations[0]!.capabilities).toEqual(['buoy']);
  });

  it('leaves a currents-only NDBC station out of every types filter but reachable unfiltered', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });

    for (const t of ['tide', 'current', 'water_level', 'buoy', 'met'] as const) {
      await mockCatalog({}, [NDBC_CURRENTS_ONLY]);
      const filtered = noaaMarineFindStations.input.parse({
        source: 'ndbc',
        types: [t],
        limit: 5,
      });
      await expect(noaaMarineFindStations.handler(filtered, ctx)).rejects.toMatchObject({
        data: { reason: 'no_results' },
      });
    }

    // The documented escape hatch: no types filter.
    await mockCatalog({}, [NDBC_CURRENTS_ONLY]);
    const unfiltered = noaaMarineFindStations.input.parse({ source: 'ndbc', limit: 5 });
    const result = await noaaMarineFindStations.handler(unfiltered, ctx);
    expect(result.stations[0]!.station_id).toBe('44033');
    expect(result.stations[0]!.capabilities).toEqual(['currents']);
  });

  // --- #12: `type` must not contradict the requested capability ---

  it('reports the filter-matched capability as type for CO-OPS rows', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    await mockCatalog({
      tidepredictions: [COOPS_TIDE_STATION],
      waterlevels: [COOPS_TIDE_STATION],
    });

    const input = noaaMarineFindStations.input.parse({
      query: 'seattle',
      types: ['water_level'],
      source: 'coops',
      limit: 3,
    });
    const result = await noaaMarineFindStations.handler(input, ctx);

    // capabilities order is ['tide', 'water_level'] — type must follow the filter, not the array.
    expect(result.stations[0]!.capabilities).toEqual(['tide', 'water_level']);
    expect(result.stations[0]!.type).toBe('water_level');
  });

  it('falls back to the first capability as type when CO-OPS rows are unfiltered', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    await mockCatalog({
      tidepredictions: [COOPS_TIDE_STATION],
      waterlevels: [COOPS_TIDE_STATION],
    });

    const input = noaaMarineFindStations.input.parse({ query: 'seattle', source: 'coops' });
    const result = await noaaMarineFindStations.handler(input, ctx);

    expect(result.stations[0]!.type).toBe('tide');
  });

  it('derives type from capabilities for NDBC rows rather than hardcoding buoy', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    await mockCatalog({}, [NDBC_BUOY]);

    const input = noaaMarineFindStations.input.parse({ source: 'ndbc', limit: 5 });
    const result = await noaaMarineFindStations.handler(input, ctx);

    // 46041 is met-capable — the old code rendered `type: 'buoy'` regardless.
    expect(result.stations[0]!.capabilities).toEqual(['met']);
    expect(result.stations[0]!.type).toBe('met');
  });

  it('never reports a type outside the station capabilities', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    await mockCatalog({ tidepredictions: [COOPS_TIDE_STATION] }, [
      NDBC_BUOY,
      NDBC_NON_MET_BUOY,
      NDBC_CURRENTS_ONLY,
    ]);

    const input = noaaMarineFindStations.input.parse({ source: 'all', limit: 50 });
    const result = await noaaMarineFindStations.handler(input, ctx);

    expect(result.stations).toHaveLength(4);
    for (const s of result.stations) {
      expect(s.capabilities).toContain(s.type);
    }
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

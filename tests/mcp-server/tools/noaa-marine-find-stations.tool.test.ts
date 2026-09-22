/**
 * @fileoverview Tests for noaa_marine_find_stations tool.
 * @module tests/mcp-server/tools/noaa-marine-find-stations.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noaaMarineFindStations } from '@/mcp-server/tools/definitions/noaa-marine-find-stations.tool.js';
import { getCoopsService, initCoopsService } from '@/services/coops/coops-service.js';
import { getNdbcService, initNdbcService } from '@/services/ndbc/ndbc-service.js';
import { callsTo, installCoopsFake, stateCatalogCoops } from '../../support/coops-http.js';

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
  hasWaterQuality: false,
};

/**
 * TFBLK shape — NDBC flags both met="n" and currents="n", with platform `type` "buoy".
 * Under the platform/capability split it has NO data capability; its identity is the platform class.
 */
const NDBC_NON_MET_BUOY = {
  id: 'TFBLK',
  name: '10.0 nm WNW on Blakknes, Iceland',
  lat: 65.6,
  lon: -24.3,
  type: 'buoy',
  hasMet: false,
  hasCurrents: false,
  hasWaterQuality: false,
};

/**
 * 44033 shape — a currents-capable NDBC station (currents flag set, met off), platform "buoy".
 * Exercises the current_profile capability path. (The live catalog's currents flags drift; this
 * fixture pins the capable case.)
 */
const NDBC_CURRENTS_ONLY = {
  id: '44033',
  name: 'Buoy F01 - Penobscot Bay',
  lat: 44.05,
  lon: -68.11,
  type: 'buoy',
  hasMet: false,
  hasCurrents: true,
  hasWaterQuality: false,
};

/**
 * 9447130 under its full CO-OPS name — the ID NDBC mirrors, and a name that only a
 * name-substring query reaches.
 */
const COOPS_SEATTLE_NAMED = {
  id: '9447130',
  name: 'SEATTLE (Madison St.), Elliott Bay',
  lat: 47.6,
  lng: -122.3,
  state: 'WA',
  type: 'R',
};

/**
 * A CO-OPS current station — alphanumeric ID, no NDBC mirror, so an ID query has only this row
 * to find. `currentpredictions` rows carry a null state, as CO-OPS publishes them.
 */
const COOPS_CURRENT_STATION = {
  id: 'ACT4176',
  name: 'Bowlers Wharf, Rappahannock River',
  lat: 37.8,
  lng: -76.7,
  state: null,
  type: 'H',
};

/**
 * EBSW1 shape — NDBC's mirror of CO-OPS 9447130. Its name opens with the CO-OPS digits, so a
 * plain name sort ranks it ahead of the station that actually carries the queried ID.
 */
const NDBC_COOPS_MIRROR = {
  id: 'EBSW1',
  name: '9447130 - Seattle, WA',
  lat: 47.6,
  lon: -122.34,
  type: 'fixed',
  hasMet: true,
  hasCurrents: false,
  hasWaterQuality: false,
};

/**
 * A waterquality="y" station reporting neither met nor currents — the shape no `types` value
 * reached before `water_quality` joined the enum.
 */
const NDBC_WATER_QUALITY_ONLY = {
  id: 'WQON1',
  name: 'Water-quality only station',
  lat: 38.0,
  lon: -76.0,
  type: 'fixed',
  hasMet: false,
  hasCurrents: false,
  hasWaterQuality: true,
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
  hasWaterQuality: false,
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

  it('returns a zero-match search as a success rather than an error', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initCoopsService(null as any, null as any, { applicationId: 'test' });
    initNdbcService();
    vi.spyOn(getCoopsService(), 'getStations').mockResolvedValue([]);
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([]);

    const input = noaaMarineFindStations.input.parse({ query: 'nonexistent_xyz', source: 'all' });
    const result = await noaaMarineFindStations.handler(input, ctx);

    // An empty search is a result, not a failure — the caller reads total_found, not an error string.
    expect(result.stations).toEqual([]);
    expect(result.total_found).toBe(0);
    expect(result.truncated).toBeUndefined();
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
          { ...COOPS_TIDE_STATION, id: 'PUG1616' },
          { ...COOPS_TIDE_STATION, id: 'PUG1616' },
          { ...COOPS_TIDE_STATION, id: 'PUG1616' },
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
    const err = await Promise.resolve(noaaMarineFindStations.handler(input, ctx)).catch(
      (e: unknown) => e,
    );

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
    const err = await Promise.resolve(noaaMarineFindStations.handler(input, ctx)).catch(
      (e: unknown) => e,
    );

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

  it('matches a bare-platform buoy on a types:["buoy"] platform filter without fabricating a capability', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    await mockCatalog({}, [NDBC_NON_MET_BUOY, NDBC_BUOY]);

    const input = noaaMarineFindStations.input.parse({
      source: 'ndbc',
      types: ['buoy'],
      limit: 5,
    });
    const result = await noaaMarineFindStations.handler(input, ctx);

    // buoy is a platform filter; met-capable rows (no platform) are not a match, and the matched
    // bare platform reports an empty capability list + its platform class — never a "buoy" capability.
    expect(result.stations.map((s) => s.station_id)).toEqual(['TFBLK']);
    expect(result.stations[0]!.capabilities).toEqual([]);
    expect(result.stations[0]!.platform).toBe('buoy');
    expect(result.stations[0]!.type).toBeUndefined();
  });

  // --- #15: NDBC currents are reachable via a dedicated current_profile filter ---

  it('reaches an NDBC currents station via types:["current_profile"], not the CO-OPS current filter', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });

    // The CO-OPS `current` filter and the other capability filters must NOT match an NDBC
    // currents station — only `current_profile` (and its `buoy` platform) reach it. Each
    // non-matching filter is a zero-match search, not an error.
    for (const t of ['tide', 'current', 'water_level', 'met', 'water_quality'] as const) {
      await mockCatalog({}, [NDBC_CURRENTS_ONLY]);
      const filtered = noaaMarineFindStations.input.parse({
        source: 'ndbc',
        types: [t],
        limit: 5,
      });
      const missed = await noaaMarineFindStations.handler(filtered, ctx);
      expect(missed.stations).toEqual([]);
      expect(missed.total_found).toBe(0);
    }

    await mockCatalog({}, [NDBC_CURRENTS_ONLY]);
    const input = noaaMarineFindStations.input.parse({
      source: 'ndbc',
      types: ['current_profile'],
      limit: 5,
    });
    const result = await noaaMarineFindStations.handler(input, ctx);
    expect(result.stations[0]!.station_id).toBe('44033');
    expect(result.stations[0]!.capabilities).toEqual(['current_profile']);
    expect(result.stations[0]!.type).toBe('current_profile');
    expect(result.stations[0]!.platform).toBe('buoy');
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
      // type, when present, is always a real data capability — never a platform class, never fabricated.
      if (s.type !== undefined) expect(s.capabilities).toContain(s.type);
      // #13: "buoy" is never a capability — a bare platform reports an empty capability list.
      expect(s.capabilities).not.toContain('buoy');
    }
    // The bare-platform buoy (TFBLK) carries no capability and no type, only its platform class.
    const bare = result.stations.find((s) => s.station_id === 'TFBLK')!;
    expect(bare.capabilities).toEqual([]);
    expect(bare.type).toBeUndefined();
    expect(bare.platform).toBe('buoy');
  });

  // --- #29: query matches CO-OPS station IDs, and an exact ID match leads ---

  it('returns the CO-OPS station for an ID query ahead of the NDBC mirror row', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    await mockCatalog({ tidepredictions: [COOPS_SEATTLE_NAMED] }, [NDBC_COOPS_MIRROR]);

    const input = noaaMarineFindStations.input.parse({
      query: '9447130',
      source: 'all',
      limit: 10,
    });
    const result = await noaaMarineFindStations.handler(input, ctx);

    // The mirror's name opens with the CO-OPS digits, so localeCompare alone ranks it first.
    expect(result.stations.map((s) => s.station_id)).toEqual(['9447130', 'EBSW1']);
    expect(result.stations[0]!.source).toBe('coops');
    expect(result.total_found).toBe(2);
  });

  it('resolves a CO-OPS current station by ID when no NDBC row mirrors it', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    await mockCatalog({ currentpredictions: [COOPS_CURRENT_STATION] }, [NDBC_BUOY]);

    const input = noaaMarineFindStations.input.parse({
      query: 'ACT4176',
      source: 'all',
      limit: 10,
    });
    const result = await noaaMarineFindStations.handler(input, ctx);

    expect(result.stations.map((s) => s.station_id)).toEqual(['ACT4176']);
    expect(result.stations[0]!.capabilities).toEqual(['current']);
  });

  it('matches a CO-OPS station ID case-insensitively', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    await mockCatalog({ currentpredictions: [COOPS_CURRENT_STATION] });

    const input = noaaMarineFindStations.input.parse({ query: 'act4176', source: 'coops' });
    const result = await noaaMarineFindStations.handler(input, ctx);

    expect(result.stations.map((s) => s.station_id)).toEqual(['ACT4176']);
  });

  it('still matches CO-OPS rows by name substring', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    await mockCatalog({ tidepredictions: [COOPS_SEATTLE_NAMED] }, [NDBC_COOPS_MIRROR]);

    const input = noaaMarineFindStations.input.parse({ query: 'Madison St', source: 'all' });
    const result = await noaaMarineFindStations.handler(input, ctx);

    expect(result.stations.map((s) => s.station_id)).toEqual(['9447130']);
  });

  it('still matches NDBC rows by ID and matches names across both sources', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    await mockCatalog({ tidepredictions: [COOPS_SEATTLE_NAMED] }, [NDBC_BUOY, NDBC_COOPS_MIRROR]);

    const byNdbcId = noaaMarineFindStations.input.parse({ query: '46041', source: 'all' });
    expect(
      (await noaaMarineFindStations.handler(byNdbcId, ctx)).stations.map((s) => s.station_id),
    ).toEqual(['46041']);

    await mockCatalog({ tidepredictions: [COOPS_SEATTLE_NAMED] }, [NDBC_BUOY, NDBC_COOPS_MIRROR]);
    const byName = noaaMarineFindStations.input.parse({
      query: 'seattle',
      source: 'all',
      limit: 10,
    });
    const named = await noaaMarineFindStations.handler(byName, ctx);
    expect(named.stations.map((s) => s.source).sort()).toEqual(['coops', 'ndbc']);
  });

  it('narrows an ID query with source, state, types, and proximity rather than bypassing them', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });

    // source: the mirror alone, the CO-OPS row excluded by source.
    await mockCatalog({ tidepredictions: [COOPS_SEATTLE_NAMED] }, [NDBC_COOPS_MIRROR]);
    const bySource = noaaMarineFindStations.input.parse({ query: '9447130', source: 'ndbc' });
    expect(
      (await noaaMarineFindStations.handler(bySource, ctx)).stations.map((s) => s.station_id),
    ).toEqual(['EBSW1']);

    // types: the CO-OPS row carries `tide`, so a `met`-only filter drops it.
    await mockCatalog({ tidepredictions: [COOPS_SEATTLE_NAMED] }, []);
    const byTypes = noaaMarineFindStations.input.parse({
      query: '9447130',
      source: 'coops',
      types: ['met'],
    });
    expect((await noaaMarineFindStations.handler(byTypes, ctx)).total_found).toBe(0);

    // state: a mismatching state removes the row an ID query found.
    await mockCatalog({ tidepredictions: [COOPS_SEATTLE_NAMED] }, []);
    const byState = noaaMarineFindStations.input.parse({ query: '9447130', state: 'CA' });
    expect((await noaaMarineFindStations.handler(byState, ctx)).total_found).toBe(0);

    // proximity: the row sits ~4,000 km outside a 50 km radius around Miami.
    await mockCatalog({ tidepredictions: [COOPS_SEATTLE_NAMED] }, []);
    const byRadius = noaaMarineFindStations.input.parse({
      query: '9447130',
      latitude: 25.8,
      longitude: -80.2,
      radius_km: 50,
      source: 'coops',
    });
    expect((await noaaMarineFindStations.handler(byRadius, ctx)).total_found).toBe(0);
  });

  // --- #28: the NDBC waterquality flag is a filterable water_quality capability ---

  it('reaches a water-quality-only NDBC station via types:["water_quality"]', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    await mockCatalog({}, [NDBC_WATER_QUALITY_ONLY, NDBC_BUOY]);

    const input = noaaMarineFindStations.input.parse({
      source: 'ndbc',
      types: ['water_quality'],
      limit: 5,
    });
    const result = await noaaMarineFindStations.handler(input, ctx);

    // met="n" and currents="n" left this station with no capability at all before #28.
    expect(result.stations.map((s) => s.station_id)).toEqual(['WQON1']);
    expect(result.stations[0]!.capabilities).toEqual(['water_quality']);
    expect(result.stations[0]!.type).toBe('water_quality');
    expect(result.stations[0]!.platform).toBe('fixed');
  });

  it('does not give a waterquality="n" station the water_quality capability', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    await mockCatalog({}, [NDBC_BUOY]);

    const unfiltered = noaaMarineFindStations.input.parse({ source: 'ndbc', limit: 5 });
    const all = await noaaMarineFindStations.handler(unfiltered, ctx);
    expect(all.stations[0]!.capabilities).toEqual(['met']);

    await mockCatalog({}, [NDBC_BUOY]);
    const filtered = noaaMarineFindStations.input.parse({
      source: 'ndbc',
      types: ['water_quality'],
      limit: 5,
    });
    expect((await noaaMarineFindStations.handler(filtered, ctx)).total_found).toBe(0);
  });

  it('keeps met and water_quality as separate filters that do not reach each other', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    await mockCatalog({}, [NDBC_WATER_QUALITY_ONLY, NDBC_BUOY]);

    const metOnly = noaaMarineFindStations.input.parse({
      source: 'ndbc',
      types: ['met'],
      limit: 5,
    });
    expect(
      (await noaaMarineFindStations.handler(metOnly, ctx)).stations.map((s) => s.station_id),
    ).toEqual(['46041']);
  });

  it('lists water_quality alongside met for a station carrying both flags', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    await mockCatalog({}, [{ ...NDBC_BUOY, hasWaterQuality: true, type: 'fixed' }]);

    const input = noaaMarineFindStations.input.parse({
      source: 'ndbc',
      types: ['water_quality'],
      limit: 5,
    });
    const result = await noaaMarineFindStations.handler(input, ctx);

    expect(result.stations[0]!.capabilities).toEqual(['met', 'water_quality']);
    // `type` follows the requested filter, never the array order.
    expect(result.stations[0]!.type).toBe('water_quality');
  });

  // --- #31: a zero-match search is a success carrying a notice and an applied-filter echo ---

  it('carries the empty-search notice and applied-filter echo on structuredContent and content[]', async () => {
    await mockCatalog({ tidepredictions: [COOPS_TIDE_STATION] }, [NDBC_BUOY]);

    const result = await runToolContract(noaaMarineFindStations, {
      state: 'WA',
      source: 'ndbc',
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.total_found).toBe(0);
    expect(structured.stations).toEqual([]);
    // The notice names `state` as what excluded NDBC and gives an actionable recovery.
    expect(structured.notice).toContain('state');
    expect(structured.notice).toContain('source="ndbc"');
    expect(structured.notice).not.toContain('Widen the search by increasing radius_km');
    expect(structured.applied_search).toMatchObject({
      catalogs_read: [],
      source: 'ndbc',
      state: 'WA',
    });

    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('**0 station(s) found** (showing 0)');
    expect(text).toContain('state');
    expect(text).toContain('**Applied search:**');
  });

  it('reads no catalog at all when state and source:"ndbc" cancel out', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initCoopsService(null as any, null as any, { applicationId: 'test' });
    initNdbcService();
    const coopsSpy = vi.spyOn(getCoopsService(), 'getStations').mockResolvedValue([]);
    const ndbcSpy = vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([]);

    const input = noaaMarineFindStations.input.parse({ state: 'WA', source: 'ndbc' });
    const result = await noaaMarineFindStations.handler(input, ctx);

    expect(result.total_found).toBe(0);
    expect(coopsSpy).not.toHaveBeenCalled();
    expect(ndbcSpy).not.toHaveBeenCalled();
  });

  it('does not blame state or types for a zero-match search caused only by the query', async () => {
    await mockCatalog({ tidepredictions: [COOPS_TIDE_STATION] }, [NDBC_BUOY]);

    const result = await runToolContract(noaaMarineFindStations, { query: 'nonexistent_xyz' });
    const structured = result.structuredContent as Record<string, unknown>;

    expect(structured.notice).toContain('nonexistent_xyz');
    expect(structured.notice).not.toContain('state');
    expect(structured.notice).not.toContain('types');
    expect(structured.applied_search).toMatchObject({
      catalogs_read: ['coops', 'ndbc'],
      query: 'nonexistent_xyz',
      source: 'all',
    });
    expect(structured.applied_search).not.toHaveProperty('state');
    expect(structured.applied_search).not.toHaveProperty('types');
    expect(structured.applied_search).not.toHaveProperty('radius_km');
  });

  it('echoes a blank query as omitted rather than as a whitespace search term', async () => {
    await mockCatalog({}, []);

    const result = await runToolContract(noaaMarineFindStations, { query: '   ', source: 'ndbc' });
    const structured = result.structuredContent as Record<string, unknown>;

    expect(structured.total_found).toBe(0);
    expect(structured.applied_search).not.toHaveProperty('query');
  });

  it('echoes radius_km only when a center was given', async () => {
    await mockCatalog({ tidepredictions: [COOPS_TIDE_STATION] }, []);

    const withCenter = await runToolContract(noaaMarineFindStations, {
      latitude: 25,
      longitude: -80,
      source: 'coops',
    });
    expect(withCenter.structuredContent).toMatchObject({
      applied_search: { center: { latitude: 25, longitude: -80 }, radius_km: 100 },
    });
    expect((withCenter.structuredContent as Record<string, unknown>).notice).toContain(
      'radius_km 100',
    );
  });

  it('reports the resolved types and their per-source split on a zero-match search', async () => {
    await mockCatalog({ tidepredictions: [COOPS_TIDE_STATION] }, []);

    const result = await runToolContract(noaaMarineFindStations, {
      source: 'coops',
      types: ['met'],
    });
    const structured = result.structuredContent as Record<string, unknown>;

    expect(structured.applied_search).toMatchObject({
      types: ['met'],
      types_by_source: { coops: [], ndbc: ['met'] },
    });
    expect(structured.notice).toContain('NDBC-only');
  });

  it('leaves a matching search free of any empty-result enrichment', async () => {
    await mockCatalog({ tidepredictions: [COOPS_TIDE_STATION] }, [NDBC_BUOY]);

    const result = await runToolContract(noaaMarineFindStations, {
      query: 'seattle',
      source: 'coops',
    });
    const structured = result.structuredContent as Record<string, unknown>;

    expect(structured.total_found).toBe(1);
    expect(structured).not.toHaveProperty('notice');
    expect(structured).not.toHaveProperty('applied_search');
    expect(structured).not.toHaveProperty('sources');
    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('**1 station(s) found** (showing 1)');
    expect(text).not.toContain('Applied search');
  });

  it('discloses a capped list, and composes that notice with an unread-source notice', async () => {
    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initCoopsService(null as any, null as any, { applicationId: 'test' });
    initNdbcService();
    vi.spyOn(getCoopsService(), 'getStations').mockRejectedValue(new Error('CO-OPS down'));
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      NDBC_BUOY as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      NDBC_CURRENTS_ONLY as any,
    ]);

    const result = await runToolContract(noaaMarineFindStations, { source: 'all', limit: 1 });
    const structured = result.structuredContent as Record<string, unknown>;

    expect(structured.truncated).toBe(true);
    expect(structured.total_found).toBe(2);
    // Both notices survive in one composed string — ctx.enrich.notice() writes `notice`
    // last-wins, so an uncomposed second source would silently erase the first.
    expect(structured.notice).toMatch(/^Showing 1 of 2 matches/);
    expect(structured.notice).toContain('coops');
    expect(structured.sources).toMatchObject({ answered: ['ndbc'], failed: ['coops'] });
    // The cap is disclosed by `truncated`, `stations.length`, `total_found` and the notice —
    // no undeclared shown/cap/ceiling keys, and no stray trailer line for `truncated`.
    expect(structured).not.toHaveProperty('shown');
    expect(structured).not.toHaveProperty('cap');
    expect(structured).not.toHaveProperty('truncationCeiling');
    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('(showing 1 — results truncated, increase limit or narrow filters)');
    expect(text).toContain('Showing 1 of 2 matches');
    expect(text).not.toContain('**truncated:**');
  });

  it('discloses a capped list with the cap notice alone when every catalog answered', async () => {
    await mockCatalog({}, [NDBC_BUOY, NDBC_CURRENTS_ONLY, NDBC_WATER_QUALITY_ONLY]);

    const result = await runToolContract(noaaMarineFindStations, { source: 'ndbc', limit: 2 });
    const structured = result.structuredContent as Record<string, unknown>;

    expect(structured.truncated).toBe(true);
    expect(structured.stations).toHaveLength(2);
    expect(structured.notice).toBe(
      'Showing 2 of 3 matches — raise limit (max 200) or narrow the filters to reach the rest.',
    );
    expect(structured).not.toHaveProperty('sources');
    expect(structured).not.toHaveProperty('applied_search');
    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).not.toContain('**truncated:**');
  });

  it('leaves a list exactly at the limit uncapped, with no notice', async () => {
    await mockCatalog({}, [NDBC_BUOY, NDBC_CURRENTS_ONLY]);

    const result = await runToolContract(noaaMarineFindStations, { source: 'ndbc', limit: 2 });
    const structured = result.structuredContent as Record<string, unknown>;

    expect(structured.total_found).toBe(2);
    expect(structured).not.toHaveProperty('truncated');
    expect(structured).not.toHaveProperty('notice');
  });

  it('declares only applied_search, notice, and sources as enrichment, with truncated on output', () => {
    expect(Object.keys(noaaMarineFindStations.enrichment ?? {}).sort()).toEqual([
      'applied_search',
      'notice',
      'sources',
    ]);
    expect(Object.keys(noaaMarineFindStations.output.shape)).toContain('truncated');
  });

  // --- #21: a rejected fan-out leg is visible, and never reads as an empty search ---

  it('records the failed source on both surfaces when one catalog rejects', async () => {
    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initCoopsService(null as any, null as any, { applicationId: 'test' });
    initNdbcService();
    vi.spyOn(getCoopsService(), 'getStations').mockImplementation(async (type) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type === 'tidepredictions' ? ([COOPS_TIDE_STATION] as any) : [],
    );
    vi.spyOn(getNdbcService(), 'getActiveStations').mockRejectedValue(new Error('NDBC down'));

    const result = await runToolContract(noaaMarineFindStations, {
      query: 'seattle',
      source: 'all',
    });
    const structured = result.structuredContent as Record<string, unknown>;

    expect(result.isError).toBeFalsy();
    expect(structured.total_found).toBe(1);
    expect(structured.sources).toEqual({
      answered: ['coops'],
      attempted: ['coops', 'ndbc'],
      failed: ['ndbc'],
    });
    expect(structured.notice).toContain('ndbc');

    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('**Sources:**');
    expect(text).toContain('failed ndbc');
  });

  it('reports both legs rejecting as an upstream failure, not an empty search', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initCoopsService(null as any, null as any, { applicationId: 'test' });
    initNdbcService();
    vi.spyOn(getCoopsService(), 'getStations').mockRejectedValue(new Error('CO-OPS down'));
    vi.spyOn(getNdbcService(), 'getActiveStations').mockRejectedValue(new Error('NDBC down'));

    const input = noaaMarineFindStations.input.parse({ query: 'seattle', source: 'all' });
    const err = await Promise.resolve(noaaMarineFindStations.handler(input, ctx)).catch(
      (e: unknown) => e,
    );

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'sources_unavailable' },
    });
    const data = (err as { data: Record<string, unknown> }).data;
    expect(JSON.stringify(data)).not.toContain('Widen the search by increasing radius_km');
    expect(data.failed_sources).toEqual(['coops', 'ndbc']);
  });

  it('reports a single-source search whose only catalog rejects as an upstream failure', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });

    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    const { getNdbcService } = await import('@/services/ndbc/ndbc-service.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initCoopsService(null as any, null as any, { applicationId: 'test' });
    initNdbcService();
    vi.spyOn(getCoopsService(), 'getStations').mockResolvedValue([]);
    vi.spyOn(getNdbcService(), 'getActiveStations').mockRejectedValue(new Error('NDBC down'));

    const input = noaaMarineFindStations.input.parse({ source: 'ndbc', query: 'cape' });
    await expect(noaaMarineFindStations.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'sources_unavailable' },
    });
  });

  it('carries no failed-source record when both catalogs answer and nothing matches', async () => {
    await mockCatalog({ tidepredictions: [COOPS_TIDE_STATION] }, [NDBC_BUOY]);

    const result = await runToolContract(noaaMarineFindStations, { query: 'nonexistent_xyz' });
    const structured = result.structuredContent as Record<string, unknown>;

    expect(structured.total_found).toBe(0);
    expect(structured).not.toHaveProperty('sources');
  });

  // --- #26/#27: the CO-OPS prediction class and the current-prediction depth bins ---

  /** PUG1515 — one `currentpredictions` row per depth bin, all harmonic, catalog depths in feet. */
  const COOPS_MULTI_BIN_CURRENT = [
    {
      id: 'PUG1515',
      name: 'West Point, West of',
      lat: 47.662,
      lng: -122.4417,
      currbin: 15,
      depth: 16,
      depthType: 'B',
      type: 'H',
    },
    {
      id: 'PUG1515',
      name: 'West Point, West of',
      lat: 47.662,
      lng: -122.4417,
      currbin: 10,
      depth: 49,
      depthType: 'B',
      type: 'H',
    },
    {
      id: 'PUG1515',
      name: 'West Point, West of',
      lat: 47.662,
      lng: -122.4417,
      currbin: 1,
      depth: 108,
      depthType: 'B',
      type: 'H',
    },
  ];

  /** A station whose bins do not share one class — a station-level class would be wrong for it. */
  const COOPS_MIXED_CLASS_BINS = [
    {
      id: 'BOS1104',
      name: 'Boston Harbor Approach',
      lat: 42.33,
      lng: -70.9,
      currbin: 1,
      depth: 12,
      depthType: 'B',
      type: 'H',
    },
    {
      id: 'BOS1104',
      name: 'Boston Harbor Approach',
      lat: 42.33,
      lng: -70.9,
      currbin: 2,
      depth: null,
      depthType: 'U',
      type: 'W',
    },
  ];

  /** Hungry Harbor — a subordinate tide station deriving its events from Astoria (Tongue Point). */
  const COOPS_SUBORDINATE_TIDE = {
    id: '9440563',
    name: 'Hungry Harbor, Wash.',
    lat: 46.2583,
    lng: -123.848,
    state: 'WA',
    type: 'S',
    reference_id: '9439040',
  };

  it('collapses the per-bin catalog rows into one station row carrying every bin', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    await mockCatalog({ currentpredictions: COOPS_MULTI_BIN_CURRENT });

    const input = noaaMarineFindStations.input.parse({ query: 'PUG1515', source: 'coops' });
    const result = await noaaMarineFindStations.handler(input, ctx);

    expect(result.stations).toHaveLength(1);
    const row = result.stations[0]!;
    expect(row.capabilities).toEqual(['current']);
    expect(row.bins).toEqual([
      { bin: 15, depth: 16, depth_type: 'B', prediction_class: 'harmonic' },
      { bin: 10, depth: 49, depth_type: 'B', prediction_class: 'harmonic' },
      { bin: 1, depth: 108, depth_type: 'B', prediction_class: 'harmonic' },
    ]);
    // The class of a current station lives on its bins, never on the row.
    expect(row.prediction_class).toBeUndefined();
  });

  it('keeps each bin of a mixed-class station on its own class, past the first bin', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    await mockCatalog({ currentpredictions: COOPS_MIXED_CLASS_BINS });

    const input = noaaMarineFindStations.input.parse({ query: 'BOS1104', source: 'coops' });
    const result = await noaaMarineFindStations.handler(input, ctx);

    const bins = result.stations[0]!.bins!;
    expect(bins).toHaveLength(2);
    expect(bins[0]!.prediction_class).toBe('harmonic');
    expect(bins[1]!.prediction_class).toBe('weak_and_variable');
    // A bin CO-OPS publishes no depth for stays null rather than becoming a zero.
    expect(bins[1]!.depth).toBeNull();
    expect(bins[1]!.depth_type).toBe('U');
  });

  it('reports the tide prediction class and reference station on a subordinate tide row', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    await mockCatalog({ tidepredictions: [COOPS_SUBORDINATE_TIDE] });

    const input = noaaMarineFindStations.input.parse({ query: '9440563', source: 'coops' });
    const result = await noaaMarineFindStations.handler(input, ctx);

    const row = result.stations[0]!;
    expect(row.prediction_class).toBe('subordinate');
    expect(row.reference_id).toBe('9439040');
    // A tide station has one catalog row, so it carries no bins.
    expect(row.bins).toBeUndefined();
  });

  it('reports a reference tide station as reference and omits its empty reference_id', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    await mockCatalog({ tidepredictions: [{ ...COOPS_TIDE_STATION, reference_id: '' }] });

    const input = noaaMarineFindStations.input.parse({ query: '9447130', source: 'coops' });
    const result = await noaaMarineFindStations.handler(input, ctx);

    expect(result.stations[0]!.prediction_class).toBe('reference');
    expect(result.stations[0]!.reference_id).toBeUndefined();
  });

  it('passes an unrecognized catalog class code through verbatim rather than dropping it', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    await mockCatalog({
      tidepredictions: [{ ...COOPS_TIDE_STATION, type: 'Z' }],
      currentpredictions: [{ ...COOPS_MULTI_BIN_CURRENT[0]!, type: 'Q' }],
    });

    const input = noaaMarineFindStations.input.parse({ source: 'coops', limit: 10 });
    const result = await noaaMarineFindStations.handler(input, ctx);

    const tide = result.stations.find((s) => s.station_id === '9447130')!;
    const current = result.stations.find((s) => s.station_id === 'PUG1515')!;
    expect(tide.prediction_class).toBe('Z');
    expect(current.bins![0]!.prediction_class).toBe('Q');
  });

  it('carries the prediction class, bins, and reference station onto both surfaces', async () => {
    await mockCatalog({
      tidepredictions: [COOPS_SUBORDINATE_TIDE],
      currentpredictions: COOPS_MULTI_BIN_CURRENT,
    });

    const result = await runToolContract(noaaMarineFindStations, { source: 'coops', limit: 10 });
    expect(result.isError).toBeFalsy();

    const structured = result.structuredContent as {
      stations: { station_id: string; bins?: unknown[]; prediction_class?: string }[];
    };
    expect(structured.stations.find((s) => s.station_id === 'PUG1515')?.bins).toHaveLength(3);
    expect(structured.stations.find((s) => s.station_id === '9440563')?.prediction_class).toBe(
      'subordinate',
    );

    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('subordinate');
    expect(text).toContain('9439040');
    expect(text).toContain('harmonic');
    expect(text).toContain('108');
  });

  it('leaves a water-level-only station without a prediction class', async () => {
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    // The waterlevels catalog publishes no `type` field at all.
    await mockCatalog({
      waterlevels: [{ id: '9440083', name: 'Wauna', lat: 46.16, lng: -123.41, state: 'OR' }],
    });

    const input = noaaMarineFindStations.input.parse({ source: 'coops', limit: 5 });
    const result = await noaaMarineFindStations.handler(input, ctx);

    expect(result.stations[0]!.capabilities).toEqual(['water_level']);
    expect(result.stations[0]!.prediction_class).toBeUndefined();
    expect(result.stations[0]!.bins).toBeUndefined();
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

  it('format renders the NDBC platform class and omits type for a bare platform', () => {
    const output = {
      total_found: 1,
      stations: [
        {
          station_id: 'TFBLK',
          name: '10.0 nm WNW on Blakknes, Iceland',
          source: 'ndbc' as const,
          platform: 'buoy',
          latitude: 65.6,
          longitude: -24.3,
          capabilities: [] as string[],
        },
      ],
    };
    const blocks = noaaMarineFindStations.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Platform:** buoy');
    // No data capability → no "Type:" segment and a "none reported" capability line.
    expect(text).not.toContain('Type:');
    expect(text).toContain('none reported');
  });

  // --- #20: decoded station names must reach both output surfaces ---

  it('surfaces a decoded station name from the live catalog feed', async () => {
    // Drives the real XML parser through the service rather than a pre-decoded fixture —
    // a mocked getActiveStations would never run the decode this pins.
    const ctx = createMockContext({ errors: noaaMarineFindStations.errors });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initCoopsService(null as any, null as any, { applicationId: 'test' });
    initNdbcService();
    const { getCoopsService } = await import('@/services/coops/coops-service.js');
    vi.spyOn(getCoopsService(), 'getStations').mockResolvedValue([]);

    const http = createFetchMock([
      {
        match: (request) => request.url.includes('activestations.xml'),
        respond: new Response(
          `<?xml version="1.0"?><ActiveStations>` +
            `<Station id="62114" lat="58.3" lon="0" name="Tartan &quot;A&quot; AWS" ` +
            `owner="Private Industry Oil Platform" type="oilrig" met="y" currents="n" waterquality="n"/>` +
            `</ActiveStations>`,
          { headers: { 'content-type': 'text/xml' } },
        ),
      },
    ]);

    http.install();
    try {
      const input = noaaMarineFindStations.input.parse({ source: 'ndbc', query: 'Tartan' });
      const result = await noaaMarineFindStations.handler(input, ctx);

      expect(result.stations[0]!.name).toBe('Tartan "A" AWS');
      expect(result.stations[0]!.name).not.toContain('&quot;');

      const text = (noaaMarineFindStations.format!(result)[0] as { text: string }).text;
      expect(text).toContain('Tartan "A" AWS');
      expect(text).not.toContain('&quot;');
    } finally {
      http.restore();
    }
  });
});

// --- #36: a station whose rows carry no state code takes the nearest state-bearing row's state ---

describe('noaaMarineFindStations state resolution through the CO-OPS service', () => {
  let http: FetchMockHarness;

  beforeEach(() => {
    vi.restoreAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initCoopsService(null as any, null as any, { applicationId: 'test' });
    initNdbcService();
    vi.spyOn(getNdbcService(), 'getActiveStations').mockResolvedValue([NDBC_BUOY]);
    http = installCoopsFake(stateCatalogCoops);
  });

  afterEach(() => {
    http.restore();
    vi.useRealTimers();
  });

  interface Row {
    bins?: unknown[];
    source: string;
    state?: string;
    state_derived?: boolean;
    station_id: string;
  }

  async function search(input: Parameters<typeof runToolContract>[1]) {
    const result = await runToolContract(noaaMarineFindStations, input);
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { stations: Row[]; total_found: number };
    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    return { structured, text };
  }

  it('keeps a published state and marks nothing derived (9447130 → WA)', async () => {
    const { structured, text } = await search({ query: '9447130', source: 'coops' });

    expect(structured.stations).toHaveLength(1);
    expect(structured.stations[0]).toMatchObject({ station_id: '9447130', state: 'WA' });
    expect(structured.stations[0]).not.toHaveProperty('state_derived');
    expect(text).toContain('· WA');
    expect(text).not.toContain('derived');
  });

  it('still excludes NDBC under a state filter and never reads the NDBC catalog', async () => {
    const { structured } = await search({ state: 'WA' });

    expect(structured.stations.length).toBeGreaterThan(0);
    expect(structured.stations.every((s) => s.source === 'coops')).toBe(true);
    expect(getNdbcService().getActiveStations).not.toHaveBeenCalled();
  });

  it('returns Washington current stations for { state: "WA", types: ["current"] }', async () => {
    const { structured, text } = await search({ state: 'WA', types: ['current'] });

    expect(structured.stations.map((s) => s.station_id)).toEqual(['PUG1515']);
    const row = structured.stations[0]!;
    expect(row.state).toBe('WA');
    expect(row.state_derived).toBe(true);
    // The derived state rides the collapsed row, which still carries every bin.
    expect(row.bins).toHaveLength(3);
    expect(text).toContain('### West Point, West of (PUG1515)');
    expect(text).toContain('· WA (derived from the nearest state-bearing station)');
  });

  it('gives a stateless tide row within 25 km the nearest state (TWC1165 → WA)', async () => {
    const { structured, text } = await search({ query: 'TWC1165' });

    expect(structured.stations[0]).toMatchObject({
      station_id: 'TWC1165',
      state: 'WA',
      state_derived: true,
    });
    expect(text).toContain('· WA (derived');
  });

  it('includes derived and published rows together under one state filter', async () => {
    const { structured } = await search({ state: 'WA', limit: 50 });

    const byId = Object.fromEntries(structured.stations.map((s) => [s.station_id, s]));
    expect(Object.keys(byId).sort()).toEqual(['9447130', '9449880', 'PUG1515', 'TWC1165']);
    expect(byId['9447130']).not.toHaveProperty('state_derived');
    expect(byId['9449880']).not.toHaveProperty('state_derived');
    expect(byId.PUG1515!.state_derived).toBe(true);
    expect(byId.TWC1165!.state_derived).toBe(true);
  });

  it('leaves PCT0016 without a state, and no state filter returns it', async () => {
    const { structured, text } = await search({ query: 'PCT0016' });

    expect(structured.stations).toHaveLength(1);
    expect(structured.stations[0]).not.toHaveProperty('state');
    expect(structured.stations[0]).not.toHaveProperty('state_derived');
    expect(text).not.toContain('derived');

    for (const code of noaaMarineFindStations.input.shape.state.unwrap().options) {
      const scoped = await search({ query: 'PCT0016', state: code });
      expect(scoped.structured.total_found, code).toBe(0);
    }
  });

  it('never reports a country-name catalog value as a state (1619910, Midway)', async () => {
    const { structured, text } = await search({ query: '1619910' });

    expect(structured.stations[0]).not.toHaveProperty('state');
    expect(text).not.toContain('United States of America');
  });

  it('shows a station its own non-code value (1840000 → FM), and no state filter returns it', async () => {
    const { structured, text } = await search({ query: '1840000' });

    expect(structured.stations).toHaveLength(1);
    expect(structured.stations[0]).toMatchObject({ station_id: '1840000', state: 'FM' });
    expect(structured.stations[0]).not.toHaveProperty('state_derived');
    expect(text).toContain('### CHUUK, Moen Island (1840000)');
    expect(text).toContain('· FM');
    expect(text).not.toContain('derived');

    for (const code of noaaMarineFindStations.input.shape.state.unwrap().options) {
      const scoped = await search({ state: code, limit: 200 });
      expect(
        scoped.structured.stations.map((s) => s.station_id),
        code,
      ).not.toContain('1840000');
    }
  });

  it('resolves the states once per catalog refresh, not per search', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-22T00:00:00Z'));
    const resolve = vi.spyOn(getCoopsService(), 'stationStates');

    await search({ state: 'WA' });
    await search({ query: 'PUG1515' });
    await search({ state: 'WA', types: ['current'] });

    // Three catalog fetches — one per list — and one resolved map, reused by every search.
    expect(callsTo(http, 'catalog')).toHaveLength(3);
    const first = resolve.mock.results[0]!.value;
    expect(resolve.mock.results).toHaveLength(3);
    expect(resolve.mock.results[1]!.value).toBe(first);
    expect(resolve.mock.results[2]!.value).toBe(first);

    // Past the six-hour catalog TTL the lists refetch, and the states are resolved afresh.
    vi.setSystemTime(new Date('2026-09-22T06:00:01Z'));
    await search({ state: 'WA' });

    expect(callsTo(http, 'catalog')).toHaveLength(6);
    const refreshed = resolve.mock.results[3]!.value;
    expect(refreshed).not.toBe(first);
    expect(refreshed).toEqual(first);
  });
});

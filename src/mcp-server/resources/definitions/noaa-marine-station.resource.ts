/**
 * @fileoverview noaa-marine://station/{station_id} resource — metadata for a CO-OPS or NDBC station.
 * @module mcp-server/resources/definitions/noaa-marine-station.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCoopsService } from '@/services/coops/coops-service.js';
import { getNdbcService } from '@/services/ndbc/ndbc-service.js';

export const noaaMarineStationResource = resource('noaa-marine://station/{station_id}', {
  name: 'noaa_marine_station',
  description: `Metadata for a CO-OPS or NDBC station by ID: name, coordinates, source, data capabilities, and — for NDBC — the physical platform class. The type field is the primary data capability, meaning the same thing here as in noaa_marine_find_stations, and is omitted when the station reports no data capability; platform is the NDBC platform class (buoy, fixed, oilrig, dart, tao, usv, other), a separate axis that CO-OPS stations do not carry. CO-OPS station IDs are numeric for tide and water-level stations and alphanumeric for current stations, while NDBC station IDs are 5-character alphanumeric codes — use noaa_marine_find_stations to discover them. A station ID that neither catalog carries is a station_not_found error, distinct from source_unavailable, which says a catalog could not be read and so was never searched.`,
  mimeType: 'application/json',
  cacheHint: { ttlMs: 21_600_000, cacheScope: 'public' },
  params: z.object({
    station_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,20}$/)
      .describe(
        'Station identifier. CO-OPS: numeric (e.g. 9447130) or alphanumeric (e.g. ACT4176). NDBC: e.g. 46041.',
      ),
  }),

  errors: [
    {
      reason: 'station_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Both catalogs were read and neither carries this station ID.',
      recovery:
        'Use noaa_marine_find_stations to look the ID up — query matches station names and IDs on both sources.',
    },
    {
      reason: 'source_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'A station catalog could not be read, and no catalog that was read carries this ID.',
      recovery:
        'Retry in a few moments — the station catalogs are cached for six hours once a fetch succeeds.',
    },
  ],

  async handler(params, ctx) {
    const coopsSvc = getCoopsService();
    const ndbcSvc = getNdbcService();
    const id = params.station_id.toUpperCase();

    // Search CO-OPS lists and NDBC in parallel
    const [coopsResult, ndbcResult] = await Promise.allSettled([
      Promise.all([
        coopsSvc.getStations('tidepredictions', ctx),
        coopsSvc.getStations('currentpredictions', ctx),
        coopsSvc.getStations('waterlevels', ctx),
      ]),
      ndbcSvc.getActiveStations(ctx),
    ]);

    // Check CO-OPS
    if (coopsResult.status === 'fulfilled') {
      const [tide, current, waterLevel] = coopsResult.value;
      const match =
        tide.find((s) => s.id.toUpperCase() === id) ??
        current.find((s) => s.id.toUpperCase() === id) ??
        waterLevel.find((s) => s.id.toUpperCase() === id);

      if (match) {
        // A CO-OPS match came from one of the three lists, so at least one capability is present.
        const caps: string[] = [];
        if (tide.some((s) => s.id.toUpperCase() === id)) caps.push('tide');
        if (current.some((s) => s.id.toUpperCase() === id)) caps.push('current');
        if (waterLevel.some((s) => s.id.toUpperCase() === id)) caps.push('water_level');

        const result: Record<string, unknown> = {
          station_id: match.id,
          name: match.name,
          source: 'coops',
          latitude: match.lat,
          longitude: match.lng,
          capabilities: caps,
        };
        // `type` is the primary data capability — the same axis find_stations reports. The CO-OPS
        // catalog `type` code (R/T/S reference classes) is a different, undocumented axis and is not
        // surfaced here; CO-OPS has no platform class.
        if (caps[0]) result.type = caps[0];
        if (match.state) result.state = match.state;
        return result;
      }
    }

    // Check NDBC
    if (ndbcResult.status === 'fulfilled') {
      const match = ndbcResult.value.find((s) => s.id.toUpperCase() === id);
      if (match) {
        // Data capabilities from the catalog flags only — no fabricated "buoy" when all are off (#13).
        // `current_profile` (NDBC observed ocean currents) is named apart from CO-OPS `current`;
        // `water_quality` is the sub-surface water-column flag. Same derivation as find_stations,
        // so `type` means the same thing on both surfaces (#14).
        const caps: string[] = [];
        if (match.hasMet) caps.push('met');
        if (match.hasCurrents) caps.push('current_profile');
        if (match.hasWaterQuality) caps.push('water_quality');
        const result: Record<string, unknown> = {
          station_id: match.id,
          name: match.name,
          source: 'ndbc',
          latitude: match.lat,
          longitude: match.lon,
          capabilities: caps,
        };
        // `type` is the primary data capability (same axis as find_stations), omitted when the
        // station serves no data. `platform` is the NDBC physical class — a separate axis (#14).
        if (caps[0]) result.type = caps[0];
        if (match.type) result.platform = match.type;
        if (match.owner) result.owner = match.owner;
        return result;
      }
    }

    // No catalog that answered carries the ID. Whether that means "this station does not exist"
    // depends on whether every catalog was actually read — a rejected leg was never searched, so
    // reporting NotFound for it would assert something the handler never checked.
    const unread: string[] = [];
    const answered: string[] = [];
    (coopsResult.status === 'rejected' ? unread : answered).push('coops');
    (ndbcResult.status === 'rejected' ? unread : answered).push('ndbc');

    if (unread.length > 0) {
      const searched =
        answered.length > 0
          ? `it is not in the ${answered.join(' or ')} catalog`
          : 'no catalog could be searched';
      throw ctx.fail(
        'source_unavailable',
        `Station ${params.station_id} could not be resolved: the ${unread.join(' and ')} ${unread.length > 1 ? 'catalogs' : 'catalog'} could not be read, and ${searched}.`,
        {
          ...ctx.recoveryFor('source_unavailable'),
          station_id: params.station_id,
          unread_sources: unread,
        },
      );
    }

    throw ctx.fail(
      'station_not_found',
      `Station ${params.station_id} not found in CO-OPS or NDBC. Use noaa_marine_find_stations to discover valid IDs.`,
      { ...ctx.recoveryFor('station_not_found'), station_id: params.station_id },
    );
  },
});

/**
 * @fileoverview noaa-marine://station/{station_id} resource — metadata for a CO-OPS or NDBC station.
 * @module mcp-server/resources/definitions/noaa-marine-station.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { getCoopsService } from '@/services/coops/coops-service.js';
import { getNdbcService } from '@/services/ndbc/ndbc-service.js';

export const noaaMarineStationResource = resource('noaa-marine://station/{station_id}', {
  name: 'noaa_marine_station',
  description:
    'Metadata for a CO-OPS or NDBC station by ID: name, coordinates, source, data capabilities, and — for NDBC — ' +
    'the physical platform class. `type` is the primary data capability (same meaning as in noaa_marine_find_stations), ' +
    'omitted when the station reports no data capability; `platform` is the NDBC platform class ' +
    '(buoy, fixed, oilrig, dart, tao, usv, other) and is a separate axis, absent for CO-OPS. ' +
    'CO-OPS station IDs are numeric (tide/water-level) or alphanumeric (current stations). ' +
    'NDBC station IDs are 5-character alphanumeric codes. ' +
    'Use noaa_marine_find_stations to discover station IDs.',
  mimeType: 'application/json',
  params: z.object({
    station_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,20}$/)
      .describe(
        'Station identifier. CO-OPS: numeric (e.g. 9447130) or alphanumeric (e.g. ACT4176). NDBC: e.g. 46041.',
      ),
  }),

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
        // Data capabilities from the catalog flags only — no fabricated "buoy" when both are off (#13).
        // `current_profile` (NDBC observed ocean currents) is named apart from CO-OPS `current`.
        const caps: string[] = [];
        if (match.hasMet) caps.push('met');
        if (match.hasCurrents) caps.push('current_profile');
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

    throw notFound(
      `Station ${params.station_id} not found in CO-OPS or NDBC. Use noaa_marine_find_stations to discover valid IDs.`,
      {
        station_id: params.station_id,
      },
    );
  },
});

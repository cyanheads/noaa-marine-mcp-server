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
    'Metadata for a CO-OPS or NDBC station by ID: name, coordinates, source, capabilities, and state. ' +
    'CO-OPS station IDs are numeric (tide/water-level) or alphanumeric (current stations). ' +
    'NDBC station IDs are 5-character alphanumeric codes. ' +
    'Use noaa_marine_find_stations to discover station IDs.',
  mimeType: 'application/json',
  params: z.object({
    station_id: z
      .string()
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
      const capMap = new Map<string, string[]>();

      for (const s of tide) {
        if (s.id.toUpperCase() === id) {
          if (!capMap.has(s.id)) capMap.set(s.id, []);
          const caps = capMap.get(s.id);
          if (caps && !caps.includes('tide')) caps.push('tide');
        }
      }
      for (const s of current) {
        if (s.id.toUpperCase() === id) {
          if (!capMap.has(s.id)) capMap.set(s.id, []);
          const caps = capMap.get(s.id);
          if (caps && !caps.includes('current')) caps.push('current');
        }
      }
      for (const s of waterLevel) {
        if (s.id.toUpperCase() === id) {
          if (!capMap.has(s.id)) capMap.set(s.id, []);
          const caps = capMap.get(s.id);
          if (caps && !caps.includes('water_level')) caps.push('water_level');
        }
      }

      const allStations = [...tide, ...current, ...waterLevel];
      const match = allStations.find((s) => s.id.toUpperCase() === id);
      if (match) {
        const caps = capMap.get(match.id) ?? ['tide'];
        const result: Record<string, unknown> = {
          station_id: match.id,
          name: match.name,
          source: 'coops',
          latitude: match.lat,
          longitude: match.lng,
          capabilities: caps,
        };
        if (match.state) result.state = match.state;
        if (match.type) result.type = match.type;
        return result;
      }
    }

    // Check NDBC
    if (ndbcResult.status === 'fulfilled') {
      const match = ndbcResult.value.find((s) => s.id.toUpperCase() === id);
      if (match) {
        const caps: string[] = [];
        if (match.hasMet) caps.push('met');
        if (match.hasCurrents) caps.push('currents');
        if (caps.length === 0) caps.push('buoy');
        const result: Record<string, unknown> = {
          station_id: match.id,
          name: match.name,
          source: 'ndbc',
          latitude: match.lat,
          longitude: match.lon,
          type: match.type ?? 'buoy',
          capabilities: caps,
        };
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

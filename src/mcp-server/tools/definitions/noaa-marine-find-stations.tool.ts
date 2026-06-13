/**
 * @fileoverview noaa_marine_find_stations tool — multi-source station discovery for CO-OPS and NDBC.
 * @module mcp-server/tools/definitions/noaa-marine-find-stations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCoopsService } from '@/services/coops/coops-service.js';
import { getNdbcService } from '@/services/ndbc/ndbc-service.js';

/** Haversine distance in km between two lat/lon pairs. */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

const STATE_CODES = [
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
  'DC',
  'PR',
  'VI',
  'GU',
  'AS',
  'MP',
] as const;

export const noaaMarineFindStations = tool('noaa_marine_find_stations', {
  title: 'Find Marine Stations',
  description:
    'Find CO-OPS tide/water-level/current stations and NDBC buoys near a location or by name/state. ' +
    'Returns a unified station list with source, type, capabilities, and coordinates. ' +
    'This is the required first step to resolve place names or coordinates to station IDs before calling data tools. ' +
    'CO-OPS station IDs are numeric (e.g. 9447130 for Seattle); current station IDs are alphanumeric (e.g. ACT4176). ' +
    'NDBC buoy IDs are 5-character alphanumeric codes (e.g. 46041). ' +
    'Provide latitude/longitude for proximity search, or query/state for name-based search — both may be combined. ' +
    'Note: CO-OPS current stations are cataloged by monitoring capability, not prediction availability. ' +
    'If noaa_marine_get_currents returns no_predictions for a station, try the next nearest current station.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe(
        'Center latitude in decimal degrees for proximity search. Pair with longitude and optionally radius_km.',
      ),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe(
        'Center longitude in decimal degrees for proximity search. Pair with latitude and optionally radius_km.',
      ),
    radius_km: z
      .number()
      .min(1)
      .max(1000)
      .default(100)
      .describe(
        'Search radius in kilometers when latitude/longitude are provided. Defaults to 100 km.',
      ),
    query: z
      .string()
      .optional()
      .describe(
        'Station name substring to search (case-insensitive token match). E.g. "seattle", "puget sound".',
      ),
    state: z
      .enum(STATE_CODES)
      .optional()
      .describe(
        'Filter by 2-letter US state or territory code (CO-OPS stations only). E.g. "WA", "CA", "PR".',
      ),
    source: z
      .enum(['coops', 'ndbc', 'all'])
      .default('all')
      .describe(
        'Data source to search: coops (tide/water-level/current stations), ndbc (buoys), or all (default).',
      ),
    types: z
      .array(
        z
          .enum(['tide', 'current', 'water_level', 'buoy', 'met'])
          .describe(
            'Station capability type: tide (CO-OPS tide predictions), current (CO-OPS current predictions), ' +
              'water_level (CO-OPS observed water levels), buoy (NDBC buoy), met (NDBC meteorological).',
          ),
      )
      .optional()
      .describe('Filter by station type/capability. Omit to return all types.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(20)
      .describe('Maximum number of stations to return. Defaults to 20.'),
  }),

  output: z.object({
    stations: z
      .array(
        z
          .object({
            station_id: z.string().describe('Station identifier — use this ID with data tools.'),
            name: z.string().describe('Station name.'),
            source: z
              .enum(['coops', 'ndbc'])
              .describe('Data source: coops (CO-OPS) or ndbc (NDBC buoy).'),
            type: z
              .string()
              .describe(
                'Station type/capability string, e.g. "tide", "current", "water_level", "buoy".',
              ),
            latitude: z.number().describe('Station latitude in decimal degrees.'),
            longitude: z.number().describe('Station longitude in decimal degrees.'),
            distance_km: z
              .number()
              .optional()
              .describe(
                'Distance in km from the search center (only present when lat/lon search was used).',
              ),
            state: z
              .string()
              .optional()
              .describe('US state or territory code (CO-OPS stations only).'),
            capabilities: z
              .array(z.string().describe('Capability identifier, e.g. "tide", "water_level".'))
              .describe('List of data products available at this station.'),
          })
          .describe('A single station matching the search criteria.'),
      )
      .describe(
        'Stations matching the search criteria, sorted by distance (if lat/lon provided) or name.',
      ),
    total_found: z
      .number()
      .describe('Total stations matching the filters before the limit was applied.'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when total_found exceeds the limit and not all matching stations are returned. Increase limit or narrow filters to see more.',
      ),
  }),

  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'No stations match the query, location, or filters.',
      recovery:
        'Widen the search by increasing radius_km, removing type filters, or using a broader query.',
    },
  ],

  async handler(input, ctx) {
    const coopsSvc = getCoopsService();
    const ndbcSvc = getNdbcService();

    interface StationResult {
      capabilities: string[];
      distance_km?: number;
      latitude: number;
      longitude: number;
      name: string;
      source: 'coops' | 'ndbc';
      state?: string;
      station_id: string;
      type: string;
    }

    const results: StationResult[] = [];
    const lat = input.latitude;
    const lon = input.longitude;
    const hasLatLon = lat !== undefined && lat !== null && lon !== undefined && lon !== null;

    // Fetch CO-OPS and NDBC lists in parallel
    const includeCoops = input.source === 'all' || input.source === 'coops';
    const includeNdbc = input.source === 'all' || input.source === 'ndbc';

    const [coopsResults, ndbcResult] = await Promise.allSettled([
      includeCoops
        ? Promise.all([
            coopsSvc.getStations('tidepredictions', ctx),
            coopsSvc.getStations('currentpredictions', ctx),
            coopsSvc.getStations('waterlevels', ctx),
          ])
        : Promise.resolve(null),
      includeNdbc ? ndbcSvc.getActiveStations(ctx) : Promise.resolve(null),
    ]);

    // Process CO-OPS stations
    if (coopsResults.status === 'fulfilled' && coopsResults.value) {
      const [tideStations, currentStations, waterLevelStations] = coopsResults.value;
      const tideSet = new Set<string>();
      const currentSet = new Set<string>();
      const waterLevelSet = new Set<string>();

      for (const s of tideStations) tideSet.add(s.id);
      for (const s of currentStations) currentSet.add(s.id);
      for (const s of waterLevelStations) waterLevelSet.add(s.id);

      // Build unique station map — a station can appear in multiple lists
      const allCoops = new Map<string, (typeof tideStations)[0] & { capabilities: string[] }>();

      for (const s of tideStations) {
        if (!allCoops.has(s.id)) allCoops.set(s.id, { ...s, capabilities: [] });
        const entry = allCoops.get(s.id);
        if (entry && !entry.capabilities.includes('tide')) entry.capabilities.push('tide');
      }
      for (const s of currentStations) {
        if (!allCoops.has(s.id)) allCoops.set(s.id, { ...s, capabilities: [] });
        const entry = allCoops.get(s.id);
        if (entry && !entry.capabilities.includes('current')) entry.capabilities.push('current');
      }
      for (const s of waterLevelStations) {
        if (!allCoops.has(s.id)) allCoops.set(s.id, { ...s, capabilities: [] });
        const entry = allCoops.get(s.id);
        if (entry && !entry.capabilities.includes('water_level'))
          entry.capabilities.push('water_level');
      }

      for (const [, s] of allCoops) {
        // Apply type filter
        if (input.types && input.types.length > 0) {
          const hasMatch = input.types.some(
            (t) =>
              (t === 'tide' && tideSet.has(s.id)) ||
              (t === 'current' && currentSet.has(s.id)) ||
              (t === 'water_level' && waterLevelSet.has(s.id)),
          );
          if (!hasMatch) continue;
        }

        // Apply state filter
        if (input.state && s.state !== input.state) continue;

        // Apply name query
        if (input.query) {
          const q = input.query.toLowerCase();
          if (!s.name.toLowerCase().includes(q)) continue;
        }

        const primaryType = s.capabilities[0] ?? 'tide';
        const entry: StationResult = {
          station_id: s.id,
          name: s.name,
          source: 'coops',
          type: primaryType,
          latitude: s.lat,
          longitude: s.lng,
          capabilities: s.capabilities,
        };
        if (s.state) entry.state = s.state;

        if (hasLatLon && lat !== undefined && lon !== undefined) {
          const dist = haversineKm(lat, lon, s.lat, s.lng);
          if (dist > input.radius_km) continue;
          entry.distance_km = Math.round(dist * 10) / 10;
        }

        results.push(entry);
      }
    }

    // Process NDBC stations
    if (ndbcResult.status === 'fulfilled' && ndbcResult.value) {
      for (const s of ndbcResult.value) {
        // Apply type filter
        if (input.types && input.types.length > 0) {
          const hasMatch = input.types.some(
            (t) =>
              (t === 'buoy' || t === 'met') && (s.hasMet || s.type?.toLowerCase().includes('buoy')),
          );
          if (!hasMatch) continue;
        }

        // Apply name query
        if (input.query) {
          const q = input.query.toLowerCase();
          if (!s.name.toLowerCase().includes(q) && !s.id.toLowerCase().includes(q)) continue;
        }

        const capabilities: string[] = [];
        if (s.hasMet) capabilities.push('met');
        if (s.hasCurrents) capabilities.push('currents');
        if (capabilities.length === 0) capabilities.push('buoy');

        const entry: StationResult = {
          station_id: s.id,
          name: s.name,
          source: 'ndbc',
          type: 'buoy',
          latitude: s.lat,
          longitude: s.lon,
          capabilities,
        };

        if (hasLatLon && lat !== undefined && lon !== undefined) {
          const dist = haversineKm(lat, lon, s.lat, s.lon);
          if (dist > input.radius_km) continue;
          entry.distance_km = Math.round(dist * 10) / 10;
        }

        results.push(entry);
      }
    }

    // Sort: by distance if lat/lon provided, otherwise by name
    if (hasLatLon) {
      results.sort((a, b) => (a.distance_km ?? 9999) - (b.distance_km ?? 9999));
    } else {
      results.sort((a, b) => a.name.localeCompare(b.name));
    }

    const total_found = results.length;

    if (total_found === 0) {
      throw ctx.fail('no_results', 'No stations match the specified search criteria.', {
        ...ctx.recoveryFor('no_results'),
      });
    }

    const stations = results.slice(0, input.limit);

    if (stations.length < total_found) {
      ctx.enrich.truncated({ shown: stations.length, cap: input.limit, ceiling: total_found });
    }

    ctx.log.info('Station search complete', {
      total_found,
      returned: stations.length,
      source: input.source,
    });

    return {
      stations,
      total_found,
      ...(stations.length < total_found ? { truncated: true } : {}),
    };
  },

  format: (result) => {
    const header = result.truncated
      ? `**${result.total_found} station(s) found** (showing ${result.stations.length} — results truncated, increase limit or narrow filters)\n`
      : `**${result.total_found} station(s) found** (showing ${result.stations.length})\n`;
    const lines: string[] = [header];
    for (const s of result.stations) {
      const dist = s.distance_km !== undefined ? ` · ${s.distance_km} km` : '';
      const state = s.state ? ` · ${s.state}` : '';
      lines.push(
        `### ${s.name} (${s.station_id})`,
        `**Source:** ${s.source.toUpperCase()} · **Type:** ${s.type}${dist}${state}`,
        `**Coordinates:** ${s.latitude}, ${s.longitude}`,
        `**Capabilities:** ${s.capabilities.join(', ')}`,
        '',
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

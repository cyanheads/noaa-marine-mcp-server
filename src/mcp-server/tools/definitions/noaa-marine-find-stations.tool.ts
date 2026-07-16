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
    'Returns a unified station list with source, data capabilities, coordinates, and — for NDBC — the physical platform class. ' +
    'This is the required first step to resolve place names or coordinates to station IDs before calling data tools. ' +
    'CO-OPS station IDs are numeric (e.g. 9447130 for Seattle); current station IDs are alphanumeric (e.g. ACT4176). ' +
    'NDBC buoy IDs are 5-character alphanumeric codes (e.g. 46041). ' +
    'Two axes are reported separately: `capabilities`/`type` describe the data products a station serves ' +
    '(tide, current, water_level, met, current_profile), while `platform` is the NDBC physical classification ' +
    '(buoy, fixed, oilrig, dart, tao, usv, other). CO-OPS stations carry no platform class. ' +
    'Provide latitude and longitude together for proximity search, or query/state for name-based search — both may be combined. ' +
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
        'Center latitude in decimal degrees for proximity search. Required together with longitude — ' +
          'supplying only one is rejected rather than silently ignored. Optionally pair with radius_km.',
      ),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe(
        'Center longitude in decimal degrees for proximity search. Required together with latitude — ' +
          'supplying only one is rejected rather than silently ignored. Optionally pair with radius_km.',
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
        'Station name substring to match, case-insensitive. E.g. "seattle", "puget sound". ' +
          'NDBC rows also match on station ID. Blank or whitespace-only values are treated as omitted.',
      ),
    state: z
      .enum(STATE_CODES)
      .optional()
      .describe(
        'Filter by 2-letter US state or territory code. Applies to CO-OPS stations only — ' +
          'providing it restricts results to CO-OPS and excludes NDBC buoys (which carry no state). ' +
          'E.g. "WA", "CA", "PR".',
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
          .enum(['tide', 'current', 'water_level', 'met', 'current_profile', 'buoy'])
          .describe(
            "Filter value. Five are data capabilities, matched against a station's capabilities list: " +
              'tide (CO-OPS tide predictions → noaa_marine_get_tide_predictions), ' +
              'current (CO-OPS tidal-current predictions → noaa_marine_get_currents), ' +
              'water_level (CO-OPS observed water levels → noaa_marine_get_water_level), ' +
              'met (NDBC meteorological → noaa_marine_get_conditions), ' +
              'current_profile (NDBC observed ocean-current depth profile → noaa_marine_get_current_profile; ' +
              'note this is a different data product and source than CO-OPS `current`). ' +
              'The sixth, buoy, is a physical-platform filter (NDBC platform class equals buoy), not a data ' +
              'capability — use it to select buoy-class platforms regardless of what data they serve.',
          ),
      )
      .optional()
      .describe(
        'Filter by data capability or NDBC platform class. Every returned station matches at least one requested ' +
          'value — a capability value against its capabilities list, or buoy against its platform class. ' +
          'Omit to return all stations.',
      ),
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
              .optional()
              .describe(
                'The data capability this row leads with — always one of the values in capabilities. When a types ' +
                  'filter of capability values is set this is the first requested capability the station has, so it ' +
                  'never contradicts the filter; otherwise it is the first capability. Omitted when the station has ' +
                  'no data capability (e.g. a bare buoy/fixed platform matched only by a platform filter) — read ' +
                  'platform for its identity. This is a data-product axis, never the physical platform class.',
              ),
            platform: z
              .string()
              .optional()
              .describe(
                'NDBC physical platform class: buoy, fixed, oilrig, dart, tao, usv, or other. A different axis than ' +
                  'type/capabilities (which describe data products). Omitted for CO-OPS stations — CO-OPS publishes ' +
                  'no platform taxonomy.',
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
              .describe(
                'Data products available at this station: any of tide, current, water_level (CO-OPS) or met, ' +
                  'current_profile (NDBC). Empty when the station reports no data capability — platform still identifies it.',
              ),
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
    {
      reason: 'incomplete_coordinates',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Only one of latitude/longitude was supplied — proximity search needs the pair.',
      recovery:
        'Supply both latitude and longitude to search by proximity, or drop both and search by query or state instead.',
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
      platform?: string;
      source: 'coops' | 'ndbc';
      state?: string;
      station_id: string;
      type?: string;
    }

    // A lone latitude or longitude cannot anchor a proximity search. Reject the pair
    // outright rather than silently dropping the distance filter and returning the
    // global list sorted by name, which reads as a successful location search.
    const { latitude: lat, longitude: lon } = input;
    if ((lat === undefined) !== (lon === undefined)) {
      const missing = lat === undefined ? 'latitude' : 'longitude';
      throw ctx.fail(
        'incomplete_coordinates',
        `Proximity search needs both latitude and longitude — ${missing} is missing.`,
        { ...ctx.recoveryFor('incomplete_coordinates') },
      );
    }
    const center = lat !== undefined && lon !== undefined ? { lat, lon } : undefined;

    // Blank/whitespace-only queries carry no search intent — treat them as omitted
    // rather than substring-matching station names that contain runs of spaces.
    const query = input.query?.trim().toLowerCase();

    // An empty types array means the same thing as no types array.
    const typeFilter = input.types?.length ? input.types : undefined;

    /**
     * True when the station carries at least one of the requested filter values among its
     * match tokens. Callers pass a station's data capabilities plus (for NDBC) its platform
     * class, so a `buoy` platform filter matches a bare platform and a `met` filter matches a
     * capability — both flow through one predicate.
     */
    const matchesTypeFilter = (tokens: string[]): boolean =>
      !typeFilter || typeFilter.some((t) => tokens.includes(t));

    /**
     * The data capability a row leads with — always drawn from `capabilities`, never the
     * platform class. Under a capability filter this is the first requested capability the
     * station has, so `type` never contradicts it; a platform-only filter (`buoy`) matches
     * nothing in capabilities, so `type` falls to the first capability, or undefined when the
     * station has none (its platform then carries its identity).
     */
    const primaryTypeFor = (capabilities: string[]): string | undefined =>
      typeFilter?.find((t) => capabilities.includes(t)) ?? capabilities[0];

    const results: StationResult[] = [];

    // Fetch CO-OPS and NDBC lists in parallel.
    // `state` is a CO-OPS-only filter — NDBC buoys carry no state, so a state-scoped
    // search must exclude them (otherwise state-less global buoys flood the results).
    const includeCoops = input.source === 'all' || input.source === 'coops';
    const includeNdbc = (input.source === 'all' || input.source === 'ndbc') && !input.state;

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

      // Build unique station map — a station can appear in multiple lists, and each list
      // it appears in IS one of its capabilities, so membership needs no separate index.
      const allCoops = new Map<string, (typeof tideStations)[0] & { capabilities: string[] }>();
      const addCapability = (stations: typeof tideStations, capability: string) => {
        for (const s of stations) {
          const entry = allCoops.get(s.id) ?? { ...s, capabilities: [] };
          if (!entry.capabilities.includes(capability)) entry.capabilities.push(capability);
          allCoops.set(s.id, entry);
        }
      };
      addCapability(tideStations, 'tide');
      addCapability(currentStations, 'current');
      addCapability(waterLevelStations, 'water_level');

      for (const s of allCoops.values()) {
        if (!matchesTypeFilter(s.capabilities)) continue;
        if (input.state && s.state !== input.state) continue;
        if (query && !s.name.toLowerCase().includes(query)) continue;

        const entry: StationResult = {
          station_id: s.id,
          name: s.name,
          source: 'coops',
          latitude: s.lat,
          longitude: s.lng,
          capabilities: s.capabilities,
        };
        const coopsType = primaryTypeFor(s.capabilities);
        if (coopsType) entry.type = coopsType;
        if (s.state) entry.state = s.state;

        if (center) {
          const dist = haversineKm(center.lat, center.lon, s.lat, s.lng);
          if (dist > input.radius_km) continue;
          entry.distance_km = Math.round(dist * 10) / 10;
        }

        results.push(entry);
      }
    }

    // Process NDBC stations
    if (ndbcResult.status === 'fulfilled' && ndbcResult.value) {
      for (const s of ndbcResult.value) {
        // Data capabilities come only from the NDBC catalog flags — never the platform class.
        // `current_profile` is NDBC observed ocean currents (the .adcp profile
        // noaa_marine_get_current_profile reads), named apart from CO-OPS `current` (tidal-current
        // predictions) so both stay filterable without a one-letter collision. When both flags are
        // off the list stays empty — a bare platform is not a fabricated "buoy" capability (#13).
        const capabilities: string[] = [];
        if (s.hasMet) capabilities.push('met');
        if (s.hasCurrents) capabilities.push('current_profile');

        // Platform class (buoy/fixed/oilrig/dart/tao/usv/other) is a separate axis. Fold it into
        // the tokens the filter matches so a `buoy` platform filter reaches bare platforms; only
        // platform values present in the `types` enum (currently just `buoy`) are ever requestable.
        const platform = s.type;
        const matchTokens = platform ? [...capabilities, platform] : capabilities;

        if (!matchesTypeFilter(matchTokens)) continue;
        if (query && !s.name.toLowerCase().includes(query) && !s.id.toLowerCase().includes(query))
          continue;

        const entry: StationResult = {
          station_id: s.id,
          name: s.name,
          source: 'ndbc',
          latitude: s.lat,
          longitude: s.lon,
          capabilities,
        };
        const ndbcType = primaryTypeFor(capabilities);
        if (ndbcType) entry.type = ndbcType;
        if (platform) entry.platform = platform;

        if (center) {
          const dist = haversineKm(center.lat, center.lon, s.lat, s.lon);
          if (dist > input.radius_km) continue;
          entry.distance_km = Math.round(dist * 10) / 10;
        }

        results.push(entry);
      }
    }

    // Sort: by distance if lat/lon provided, otherwise by name
    if (center) {
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
      const typeStr = s.type ? ` · **Type:** ${s.type}` : '';
      const platformStr = s.platform ? ` · **Platform:** ${s.platform}` : '';
      lines.push(
        `### ${s.name} (${s.station_id})`,
        `**Source:** ${s.source.toUpperCase()}${typeStr}${platformStr}${dist}${state}`,
        `**Coordinates:** ${s.latitude}, ${s.longitude}`,
        `**Capabilities:** ${s.capabilities.length > 0 ? s.capabilities.join(', ') : 'none reported'}`,
        '',
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

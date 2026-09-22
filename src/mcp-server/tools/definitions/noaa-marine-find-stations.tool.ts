/**
 * @fileoverview noaa_marine_find_stations tool — multi-source station discovery for CO-OPS and NDBC.
 * @module mcp-server/tools/definitions/noaa-marine-find-stations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCoopsService, isCoopsThrottled } from '@/services/coops/coops-service.js';
import { currentPredictionClass, tidePredictionClass } from '@/services/coops/prediction-class.js';
import { STATE_CODES } from '@/services/coops/station-state.js';
import { haversineKm } from '@/services/geo.js';
import { getNdbcService } from '@/services/ndbc/ndbc-service.js';

/** Filter values only a CO-OPS row can carry. */
const COOPS_FILTER_VALUES: readonly string[] = ['tide', 'current', 'water_level'];

/** Filter values only an NDBC row can carry — three data capabilities plus the buoy platform token. */
const NDBC_FILTER_VALUES: readonly string[] = ['met', 'current_profile', 'water_quality', 'buoy'];

/**
 * One depth bin a CO-OPS current station publishes predictions for. The catalog lists one
 * row per bin; they collapse onto a single station row as this array so a multi-bin station
 * does not consume several of the caller's result slots.
 */
const CurrentBinSchema = z
  .object({
    bin: z
      .number()
      .describe(
        'CO-OPS bin number — pass it as the bin input of noaa_marine_get_currents. Omitting bin there selects the shallowest bin.',
      ),
    depth: z
      .number()
      .nullable()
      .describe(
        "Bin depth in FEET. The catalog publishes one figure with no unit switch, unlike the depth noaa_marine_get_currents echoes, which follows that call's units. Null when CO-OPS publishes no depth for the bin, which is usual where depth_type is U.",
      ),
    depth_type: z
      .string()
      .optional()
      .describe(
        'CO-OPS depth-reference code as published: B, S, or U. A U bin usually carries no depth. Omitted when the catalog row has none.',
      ),
    prediction_class: z
      .string()
      .optional()
      .describe(
        "CO-OPS prediction class for this bin: harmonic (predicted from the bin's own harmonic analysis) or subordinate (derived by offsets from a reference station) both serve the normal flood/ebb/slack series, while weak_and_variable may instead answer noaa_marine_get_currents with a coverage statement and no events, or report that no predictions are published at all. The class is per bin because one station can mix classes across its bins. An unrecognized catalog code is passed through verbatim.",
      ),
  })
  .describe(
    'One depth bin CO-OPS publishes current predictions for at this station, with its depth and prediction class.',
  );
type CurrentBin = z.infer<typeof CurrentBinSchema>;

/**
 * The narrowing dimensions the handler applied, echoed on a zero-match search so the
 * caller can tell an unsatisfiable filter combination from a genuine miss.
 */
const AppliedSearchSchema = z.object({
  catalogs_read: z
    .array(z.string().describe('Catalog name: coops or ndbc.'))
    .describe(
      'Catalogs this search actually fetched. Empty when source and state cancelled each other out and no catalog was read.',
    ),
  center: z
    .object({
      latitude: z.number().describe('Center latitude the proximity filter used.'),
      longitude: z.number().describe('Center longitude the proximity filter used.'),
    })
    .optional()
    .describe('Proximity-search center, present only when latitude and longitude were supplied.'),
  query: z
    .string()
    .optional()
    .describe(
      'The name/ID substring as the server used it — trimmed and lowercased. Omitted when no query was supplied or it was blank.',
    ),
  radius_km: z
    .number()
    .optional()
    .describe(
      'Radius bound in km, present only when a center was given. Applies whenever a center is present and defaults to 100 km.',
    ),
  source: z.string().describe('The source filter applied: coops, ndbc, or all.'),
  state: z
    .string()
    .optional()
    .describe(
      "The state filter applied, matched against each station's resolved state: its own catalog code, or for a station publishing none the state of the nearest state-bearing CO-OPS tide or water-level station within 25 km. Restricts results to CO-OPS and excludes NDBC.",
    ),
  types: z
    .array(z.string().describe('A requested capability or platform filter value.'))
    .optional()
    .describe('The resolved types filter. Omitted when no types filter narrowed the search.'),
  types_by_source: z
    .object({
      coops: z
        .array(z.string().describe('CO-OPS-only filter value.'))
        .describe('Requested values only a CO-OPS row can carry.'),
      ndbc: z
        .array(z.string().describe('NDBC-only filter value.'))
        .describe('Requested values only an NDBC row can carry.'),
    })
    .optional()
    .describe(
      'The requested types split by the source that can carry them — every value belongs to exactly one source, so a single-source types filter reduces the search to that source.',
    ),
});
type AppliedSearch = z.infer<typeof AppliedSearchSchema>;

/** Which station catalogs this search tried to read, and how each one answered. */
const SourceReportSchema = z.object({
  answered: z
    .array(z.string().describe('Catalog name: coops or ndbc.'))
    .describe('Catalogs that returned a station list — the results cover these only.'),
  attempted: z
    .array(z.string().describe('Catalog name: coops or ndbc.'))
    .describe('Catalogs this search needed, after source and state decided which to read.'),
  failed: z
    .array(z.string().describe('Catalog name: coops or ndbc.'))
    .describe('Catalogs whose fetch rejected. A station served only by one of these is missing.'),
});
type SourceReport = z.infer<typeof SourceReportSchema>;

/**
 * Explains a zero-match search from the dimensions that were actually applied. Every clause
 * names a filter the handler used, so an unsatisfiable combination reads differently from a
 * genuine miss and the recovery points at the filter worth changing.
 */
function describeEmptySearch(applied: AppliedSearch): string {
  if (applied.catalogs_read.length === 0) {
    return [
      'No catalog was searched: state is a CO-OPS-only filter that excludes NDBC buoys, and',
      `source="${applied.source}" excludes CO-OPS, so the two leave nothing to read.`,
      `Drop state to reach NDBC buoys by query or coordinates, or keep state="${applied.state}" and set source="coops".`,
    ].join(' ');
  }

  const applied_clauses: string[] = [];
  const widen: string[] = [];

  if (applied.state) {
    applied_clauses.push(
      `state="${applied.state}" restricted the search to CO-OPS and excluded NDBC buoys, which carry no state`,
    );
    widen.push('drop state and search by query or coordinates to reach NDBC buoys');
  }

  if (applied.types && applied.types_by_source) {
    const list = applied.types.map((t) => `"${t}"`).join(', ');
    const { coops, ndbc } = applied.types_by_source;
    if (ndbc.length === 0) {
      applied_clauses.push(`types ${list} are CO-OPS-only values, so no NDBC row can carry them`);
    } else if (coops.length === 0) {
      applied_clauses.push(`types ${list} are NDBC-only values, so no CO-OPS row can carry them`);
    } else {
      applied_clauses.push(`types ${list} kept only stations carrying one of those values`);
    }
    widen.push('drop types or request another capability');
  }

  if (applied.query) {
    applied_clauses.push(
      `query "${applied.query}" matched no station name or ID in ${applied.catalogs_read.join(' or ')}`,
    );
    widen.push('shorten the query or check its spelling');
  }

  if (applied.center && applied.radius_km !== undefined) {
    applied_clauses.push(
      `radius_km ${applied.radius_km} bounded the search around ${applied.center.latitude}, ${applied.center.longitude} — this bound applies whenever a center is given and defaults to 100 km`,
    );
    widen.push('increase radius_km (max 1000)');
  }

  const head =
    applied_clauses.length > 0
      ? `No station matched. Applied: ${applied_clauses.join('; ')}.`
      : `No station matched, and no narrowing filter was applied — ${applied.catalogs_read.join(' and ')} returned no stations at all.`;
  return widen.length > 0 ? `${head} To widen: ${widen.join(', or ')}.` : head;
}

export const noaaMarineFindStations = tool('noaa_marine_find_stations', {
  title: 'Find Marine Stations',
  description: `Find CO-OPS tide, water-level and current stations and NDBC buoys near a location, by name, or by station ID, returning a unified list with source, data capabilities, coordinates, and — for NDBC — the physical platform class. This is the required first step for resolving a place name, a coordinate pair, or a bare station number to the station IDs the data tools take: CO-OPS tide and water-level IDs are numeric (e.g. 9447130 for Seattle), CO-OPS current IDs are alphanumeric (e.g. ACT4176), and NDBC buoy IDs are 5-character alphanumeric codes (e.g. 46041). Two axes are reported separately — capabilities and type name the data products a station serves (tide, current, water_level, met, current_profile, water_quality), while platform is the NDBC physical classification (buoy, fixed, oilrig, dart, tao, usv, other) that CO-OPS stations do not carry. Supply latitude and longitude together for a proximity search, or query for a name-or-ID substring matched against both sources, or state for CO-OPS coverage in one state; the filters combine, and results lead with an exact ID match unless a proximity search is ordering them by distance. A search that matches nothing is a success with total_found: 0 carrying an echo of the filters that were applied, and a search whose catalogs did not all answer says which source is missing. CO-OPS prediction stations carry a third axis as well, prediction_class, which says what a station can actually answer: a tide station is either reference, serving both hilo and the 6-minute curve, or subordinate, serving hilo only, while a current station carries its class per depth bin in bins[] — a harmonic or subordinate bin serves the normal flood/ebb/slack series, and a weak_and_variable bin may instead answer noaa_marine_get_currents with a coverage statement and no events, or report that CO-OPS publishes no predictions for it at all, so prefer a harmonic bin when one is in range.`,
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
        'Station name or station ID substring to match, case-insensitive, on both sources. ' +
          'E.g. "seattle", "puget sound", "9447130", "46041". A station whose ID matches exactly is ' +
          'returned ahead of name matches, unless latitude/longitude were supplied — a proximity ' +
          'search orders by distance instead. Blank or whitespace-only values are treated as omitted.',
      ),
    state: z
      .enum(STATE_CODES)
      .optional()
      .describe(
        'Filter by 2-letter US state or territory code. Applies to CO-OPS stations only — ' +
          'providing it restricts results to CO-OPS and excludes NDBC buoys (which carry no state). ' +
          'A station matches on its own catalog code, or — when its catalog rows carry none, as with every current station — on the state of the nearest state-bearing CO-OPS tide or water-level station within 25 km, which can be wrong on waters shared across a state or national border. ' +
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
          .enum([
            'tide',
            'current',
            'water_level',
            'met',
            'current_profile',
            'water_quality',
            'buoy',
          ])
          .describe(
            "Filter value. Six are data capabilities, matched against a station's capabilities list: " +
              'tide (CO-OPS tide predictions → noaa_marine_get_tide_predictions), ' +
              'current (CO-OPS tidal-current predictions → noaa_marine_get_currents), ' +
              'water_level (CO-OPS observed water levels → noaa_marine_get_water_level), ' +
              'met (NDBC meteorological → noaa_marine_get_conditions), ' +
              'current_profile (NDBC observed ocean-current depth profile → noaa_marine_get_current_profile; ' +
              'note this is a different data product and source than CO-OPS `current`), ' +
              'water_quality (NDBC sub-surface water-column sensors → noaa_marine_get_ocean_observations). ' +
              'The seventh, buoy, is a physical-platform filter (NDBC platform class equals buoy), not a data ' +
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
              .describe(
                "US state or territory code (CO-OPS stations only): the station's own catalog code, or — when its catalog rows carry none, as with every current station — the state of the nearest state-bearing CO-OPS tide or water-level station within 25 km, marked by state_derived. A derived state can be wrong on waters shared across a state or national border. When neither applies, the station's own non-code catalog value (e.g. FM) is shown as published and unmarked — no state filter returns such a station, since the filter takes codes only. Omitted when the station publishes nothing at all and no state-bearing station is that close.",
              ),
            state_derived: z
              .boolean()
              .optional()
              .describe(
                "True when state was derived from the nearest state-bearing CO-OPS tide or water-level station within 25 km, because the station's own catalog rows carry no state code. Omitted when state is the station's own.",
              ),
            capabilities: z
              .array(z.string().describe('Capability identifier, e.g. "tide", "water_level".'))
              .describe(
                'Data products available at this station: any of tide, current, water_level (CO-OPS) or met, ' +
                  'current_profile, water_quality (NDBC). Empty when the station reports no data capability — ' +
                  'platform still identifies it.',
              ),
            prediction_class: z
              .string()
              .optional()
              .describe(
                'CO-OPS TIDE-prediction class: reference (predicted from the station\'s own harmonic analysis, serving both hilo and the 6-minute curve) or subordinate (high and low events derived as offsets from a reference station, hilo only — noaa_marine_get_tide_predictions rejects interval="6min" for it). A third axis beside type/capabilities (data products) and platform (NDBC physical class). Omitted for a station with no tide-prediction row; a current station carries its class per bin in bins[], where subordinate means something different. An unrecognized catalog code is passed through verbatim.',
              ),
            reference_id: z
              .string()
              .optional()
              .describe(
                'The reference station a subordinate tide station derives its offsets from — the station to request a 6-minute curve from. Omitted for a reference station and for any station with no tide-prediction row.',
              ),
            bins: z
              .array(CurrentBinSchema)
              .optional()
              .describe(
                'Depth bins this current station publishes predictions for, in the order CO-OPS publishes them. Each bin has its own depth and prediction class, and its bin number is what noaa_marine_get_currents takes as bin. Omitted for a station with no current-prediction rows.',
              ),
          })
          .describe('A single station matching the search criteria.'),
      )
      .describe(
        'Stations matching the search criteria, sorted by distance (if lat/lon provided) or by exact ID match then name. Empty when nothing matched.',
      ),
    total_found: z
      .number()
      .describe(
        'Total stations matching the filters before the limit was applied. Zero when nothing matched.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when total_found exceeds the limit and not all matching stations are returned. Increase limit or narrow filters to see more.',
      ),
  }),

  enrichment: {
    applied_search: AppliedSearchSchema.optional().describe(
      'The narrowing dimensions this search applied, echoed when nothing matched so the caller can see which filter emptied the result.',
    ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance about the result set: why a search matched nothing, which catalog did not answer, or that the list was capped.',
      ),
    sources: SourceReportSchema.optional().describe(
      'Which station catalogs were attempted, answered, and failed. Present only when a catalog fetch rejected, so a partial result set is never read as a complete one.',
    ),
  },

  enrichmentTrailer: {
    applied_search: {
      render: (v: AppliedSearch) => {
        const parts = [
          `source=${v.source}`,
          `catalogs read: ${v.catalogs_read.join(', ') || 'none'}`,
        ];
        if (v.state) parts.push(`state=${v.state}`);
        if (v.types) parts.push(`types=[${v.types.join(', ')}]`);
        if (v.query) parts.push(`query="${v.query}"`);
        if (v.center && v.radius_km !== undefined) {
          parts.push(`within ${v.radius_km} km of ${v.center.latitude}, ${v.center.longitude}`);
        }
        return `**Applied search:** ${parts.join(' · ')}`;
      },
    },
    sources: {
      render: (v: SourceReport) =>
        `**Sources:** attempted ${v.attempted.join(', ')} · answered ${v.answered.join(', ') || 'none'} · failed ${v.failed.join(', ') || 'none'}`,
    },
  },

  errors: [
    {
      reason: 'incomplete_coordinates',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Only one of latitude/longitude was supplied — proximity search needs the pair.',
      recovery:
        'Supply both latitude and longitude to search by proximity, or drop both and search by query or state instead.',
    },
    {
      reason: 'sources_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Every station catalog this search needed failed to load, so no station list could be searched.',
      recovery:
        'Retry the search in a few moments — a catalog is cached for six hours once a fetch succeeds.',
    },
  ],

  async handler(input, ctx) {
    const coopsSvc = getCoopsService();
    const ndbcSvc = getNdbcService();

    interface StationResult {
      bins?: CurrentBin[];
      capabilities: string[];
      distance_km?: number;
      latitude: number;
      longitude: number;
      name: string;
      platform?: string;
      prediction_class?: string;
      reference_id?: string;
      source: 'coops' | 'ndbc';
      state?: string;
      state_derived?: boolean;
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
    const query = input.query?.trim().toLowerCase() || undefined;

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
     * True when the station's name or ID carries the query substring. CO-OPS IDs are what tide
     * tables and charts print, so an ID query must reach them the way it already reaches NDBC
     * IDs — both sources run the same predicate so the two can't drift apart.
     */
    const matchesQuery = (name: string, id: string): boolean =>
      !query || name.toLowerCase().includes(query) || id.toLowerCase().includes(query);

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
    /** `source:id` of every row whose station ID equals the query exactly — these lead the list. */
    const exactIdMatches = new Set<string>();

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

    // A rejected leg is a source the caller never got to search. Record it rather than
    // letting the surviving source's rows read as the whole catalog.
    const attempted: string[] = [];
    const failed: string[] = [];
    if (includeCoops) {
      attempted.push('coops');
      if (coopsResults.status === 'rejected') failed.push('coops');
    }
    if (includeNdbc) {
      attempted.push('ndbc');
      if (ndbcResult.status === 'rejected') failed.push('ndbc');
    }
    const answered = attempted.filter((s) => !failed.includes(s));

    // Every catalog the search needed is down. Zero rows here is an upstream failure, not an
    // empty search, so it must not be reported as one.
    if (attempted.length > 0 && answered.length === 0) {
      // A throttled CO-OPS leg clears on its own after a couple of minutes, and retrying
      // "in a few moments" only re-sends into the block — so the hint names the wait instead.
      const coopsThrottled =
        coopsResults.status === 'rejected' && isCoopsThrottled(coopsResults.reason);
      throw ctx.fail(
        'sources_unavailable',
        `The ${failed.join(' and ')} station ${failed.length > 1 ? 'catalogs' : 'catalog'} could not be read, so no station list was searched.`,
        {
          ...(coopsThrottled
            ? {
                recovery: {
                  hint: 'CO-OPS is temporarily refusing requests from this server after a burst of calls. Wait a couple of minutes before searching again, and space successive calls rather than sending them back to back.',
                },
              }
            : ctx.recoveryFor('sources_unavailable')),
          failed_sources: failed,
        },
      );
    }

    // Process CO-OPS stations
    if (coopsResults.status === 'fulfilled' && coopsResults.value) {
      const [tideStations, currentStations, waterLevelStations] = coopsResults.value;
      const states = coopsSvc.stationStates({
        tide: tideStations,
        current: currentStations,
        waterLevel: waterLevelStations,
      });

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

      // The prediction class sits on a different axis in each catalog, so each is read from
      // its own rows rather than from whichever row landed in the merged map first.
      const tideRowById = new Map(tideStations.map((s) => [s.id, s]));

      // `currentpredictions` publishes one row per depth bin, so a multi-bin station appears
      // several times. Collect the bins onto one row, each keeping its own depth and class —
      // stations that mix classes across their bins have no single station-level class.
      const binsById = new Map<string, CurrentBin[]>();
      for (const s of currentStations) {
        if (s.currbin === undefined) continue;
        const bin: CurrentBin = { bin: s.currbin, depth: s.depth ?? null };
        if (s.depthType) bin.depth_type = s.depthType;
        const binClass = currentPredictionClass(s.type);
        if (binClass) bin.prediction_class = binClass;
        const bins = binsById.get(s.id);
        if (bins) bins.push(bin);
        else binsById.set(s.id, [bin]);
      }

      for (const s of allCoops.values()) {
        if (!matchesTypeFilter(s.capabilities)) continue;
        const resolved = states.get(s.id);
        if (input.state && resolved?.state !== input.state) continue;
        if (!matchesQuery(s.name, s.id)) continue;

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
        if (resolved) {
          entry.state = resolved.state;
          if (resolved.derived) entry.state_derived = true;
        }

        const tideRow = tideRowById.get(s.id);
        const predictionClass = tidePredictionClass(tideRow?.type);
        if (predictionClass) entry.prediction_class = predictionClass;
        // A reference station's row carries `reference_id` as an empty string.
        if (tideRow?.reference_id) entry.reference_id = tideRow.reference_id;
        const bins = binsById.get(s.id);
        if (bins && bins.length > 0) entry.bins = bins;

        if (center) {
          const dist = haversineKm(center.lat, center.lon, s.lat, s.lng);
          if (dist > input.radius_km) continue;
          entry.distance_km = Math.round(dist * 10) / 10;
        }

        if (query && s.id.toLowerCase() === query) exactIdMatches.add(`coops:${s.id}`);
        results.push(entry);
      }
    }

    // Process NDBC stations
    if (ndbcResult.status === 'fulfilled' && ndbcResult.value) {
      for (const s of ndbcResult.value) {
        // Data capabilities come only from the NDBC catalog flags — never the platform class.
        // `current_profile` is NDBC observed ocean currents (the .adcp profile
        // noaa_marine_get_current_profile reads), named apart from CO-OPS `current` (tidal-current
        // predictions) so both stay filterable without a one-letter collision. `water_quality` is
        // the sub-surface water-column flag noaa_marine_get_ocean_observations reads. When every
        // flag is off the list stays empty — a bare platform is not a fabricated "buoy" capability (#13).
        const capabilities: string[] = [];
        if (s.hasMet) capabilities.push('met');
        if (s.hasCurrents) capabilities.push('current_profile');
        if (s.hasWaterQuality) capabilities.push('water_quality');

        // Platform class (buoy/fixed/oilrig/dart/tao/usv/other) is a separate axis. Fold it into
        // the tokens the filter matches so a `buoy` platform filter reaches bare platforms; only
        // platform values present in the `types` enum (currently just `buoy`) are ever requestable.
        const platform = s.type;
        const matchTokens = platform ? [...capabilities, platform] : capabilities;

        if (!matchesTypeFilter(matchTokens)) continue;
        if (!matchesQuery(s.name, s.id)) continue;

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

        if (query && s.id.toLowerCase() === query) exactIdMatches.add(`ndbc:${s.id}`);
        results.push(entry);
      }
    }

    // Sort: by distance if lat/lon provided, otherwise exact ID matches first, then by name.
    // NDBC mirrors CO-OPS gauges under names that start with the CO-OPS number, so a plain
    // name sort puts the mirror ahead of the station that actually carries the queried ID.
    if (center) {
      results.sort((a, b) => (a.distance_km ?? 9999) - (b.distance_km ?? 9999));
    } else {
      const idRank = (r: StationResult) =>
        exactIdMatches.has(`${r.source}:${r.station_id}`) ? 0 : 1;
      results.sort((a, b) => idRank(a) - idRank(b) || a.name.localeCompare(b.name));
    }

    const total_found = results.length;
    const stations = results.slice(0, input.limit);
    const truncated = stations.length < total_found;

    // One notice reaches the caller, so every source of guidance composes into it —
    // ctx.enrich.notice() writes `notice` last-wins and would otherwise erase the rest.
    const notices: string[] = [];

    if (failed.length > 0) {
      const report: SourceReport = { answered, attempted, failed };
      ctx.enrich({ sources: report });
      notices.push(
        `The ${failed.join(' and ')} ${failed.length > 1 ? 'catalogs' : 'catalog'} could not be read, so these results cover ${answered.join(' and ')} only — a station carried only by ${failed.join(' or ')} is missing from them.`,
      );
    }

    if (total_found === 0) {
      const applied: AppliedSearch = {
        catalogs_read: answered,
        source: input.source,
        ...(center ? { center: { latitude: center.lat, longitude: center.lon } } : {}),
        ...(center ? { radius_km: input.radius_km } : {}),
        ...(query ? { query } : {}),
        ...(input.state ? { state: input.state } : {}),
        ...(typeFilter
          ? {
              types: [...typeFilter],
              types_by_source: {
                coops: typeFilter.filter((t) => COOPS_FILTER_VALUES.includes(t)),
                ndbc: typeFilter.filter((t) => NDBC_FILTER_VALUES.includes(t)),
              },
            }
          : {}),
      };
      ctx.enrich({ applied_search: applied });
      notices.push(describeEmptySearch(applied));
    }

    // The cap itself is on output as `truncated`, beside `stations.length` and `total_found`;
    // the notice carries the guidance for reaching the rest.
    if (truncated) {
      notices.unshift(
        `Showing ${stations.length} of ${total_found} matches — raise limit (max 200) or narrow the filters to reach the rest.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('Station search complete', {
      total_found,
      returned: stations.length,
      source: input.source,
      failed_sources: failed,
    });

    return {
      stations,
      total_found,
      ...(truncated ? { truncated: true } : {}),
    };
  },

  format: (result) => {
    const header = result.truncated
      ? `**${result.total_found} station(s) found** (showing ${result.stations.length} — results truncated, increase limit or narrow filters)\n`
      : `**${result.total_found} station(s) found** (showing ${result.stations.length})\n`;
    const lines: string[] = [header];
    for (const s of result.stations) {
      const dist = s.distance_km !== undefined ? ` · ${s.distance_km} km` : '';
      const state = s.state
        ? ` · ${s.state}${s.state_derived ? ' (derived from the nearest state-bearing station)' : ''}`
        : '';
      const typeStr = s.type ? ` · **Type:** ${s.type}` : '';
      const platformStr = s.platform ? ` · **Platform:** ${s.platform}` : '';
      const classStr = s.prediction_class ? ` · **Prediction class:** ${s.prediction_class}` : '';
      lines.push(
        `### ${s.name} (${s.station_id})`,
        `**Source:** ${s.source.toUpperCase()}${typeStr}${platformStr}${classStr}${dist}${state}`,
        `**Coordinates:** ${s.latitude}, ${s.longitude}`,
        `**Capabilities:** ${s.capabilities.length > 0 ? s.capabilities.join(', ') : 'none reported'}`,
      );
      if (s.bins && s.bins.length > 0) {
        const bins = s.bins.map((b) => {
          const depth = b.depth !== null ? `${b.depth} ft` : 'depth not published';
          const depthType = b.depth_type ? `, ${b.depth_type}` : '';
          const binClass = b.prediction_class ? `, ${b.prediction_class}` : '';
          return `${b.bin} (${depth}${depthType}${binClass})`;
        });
        lines.push(`**Current bins:** ${bins.join(' · ')}`);
      }
      if (s.reference_id) {
        lines.push(`**Reference station:** ${s.reference_id}`);
      }
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

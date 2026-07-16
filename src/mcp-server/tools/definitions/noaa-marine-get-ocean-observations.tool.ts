/**
 * @fileoverview noaa_marine_get_ocean_observations tool — sub-surface water-column observations from an NDBC station.
 * @module mcp-server/tools/definitions/noaa-marine-get-ocean-observations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getNdbcService } from '@/services/ndbc/ndbc-service.js';

export const noaaMarineGetOceanObservations = tool('noaa_marine_get_ocean_observations', {
  title: 'Get Ocean Observations',
  description:
    "Live sub-surface oceanographic observations from an NDBC station's water-quality sensors: at each " +
    'reported depth, water temperature, conductivity, salinity, dissolved oxygen (both saturation percent ' +
    'and concentration in ppm), chlorophyll, turbidity, pH, and redox potential. This is the water-column ' +
    'counterpart to noaa_marine_get_conditions, which returns surface meteorological and wave data (wind, ' +
    'waves, sea-surface temperature) — use this tool for what the water is doing below the surface, that ' +
    'one for weather and sea state at the buoy. Returns the most recent observation as one reading per ' +
    'reported depth; most stations report a single depth, but some report several at the same time. Sensor ' +
    'coverage is sparse — most stations populate only water temperature and salinity — and any value the ' +
    'station did not report comes back null rather than a fabricated zero. Latitude and longitude are null ' +
    'when the station is absent from the NDBC active-stations list. Sub-surface sensors are on only a subset ' +
    'of NDBC stations and are not marked by any station-catalog flag, so no capability filter guarantees ' +
    'coverage: call this on candidate NDBC station IDs from noaa_marine_find_stations with source="ndbc", ' +
    'and expect the observations_not_found error on the many stations that serve no .ocean file.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    station_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,20}$/)
      .describe(
        'NDBC station ID (5-character alphanumeric, e.g. "44033" or "TIBC1"). ' +
          'Obtain candidate IDs from noaa_marine_find_stations with source="ndbc" — ocean-sensor ' +
          'coverage is not flagged in the catalog, so this is a best-effort call on any NDBC station.',
      ),
  }),

  output: z.object({
    station_id: z.string().describe('Station ID echoed from the request — for chaining.'),
    station_name: z.string().describe('Station name from the NDBC active stations list.'),
    latitude: z
      .number()
      .nullable()
      .describe(
        'Station latitude in decimal degrees. Null when the station is absent from the NDBC active-stations list — the .ocean feed carries observations but no coordinates.',
      ),
    longitude: z
      .number()
      .nullable()
      .describe(
        'Station longitude in decimal degrees. Null when the station is absent from the NDBC active-stations list.',
      ),
    observed_at: z.string().describe('ISO 8601 UTC timestamp of the observation.'),
    source: z.string().describe('Data source — always "ndbc" for this tool.'),
    reading_count: z
      .number()
      .describe('Number of per-depth readings in the latest observation (usually 1).'),
    readings: z
      .array(
        z
          .object({
            depth_m: z.number().describe('Measurement depth below the surface in meters (DEPTH).'),
            water_temp_c: z
              .number()
              .nullable()
              .describe('Water temperature in °C (OTMP). Null when the station did not report it.'),
            conductivity_ms_cm: z
              .number()
              .nullable()
              .describe('Conductivity in mS/cm (COND). Null when the station did not report it.'),
            salinity_psu: z
              .number()
              .nullable()
              .describe(
                'Salinity in practical salinity units (SAL). Null when the station did not report it.',
              ),
            oxygen_percent: z
              .number()
              .nullable()
              .describe(
                'Dissolved-oxygen saturation in percent (O2%). Null when the station did not report it.',
              ),
            oxygen_ppm: z
              .number()
              .nullable()
              .describe(
                'Dissolved-oxygen concentration in ppm (O2PPM). Null when the station did not report it.',
              ),
            chlorophyll_ug_l: z
              .number()
              .nullable()
              .describe(
                'Chlorophyll concentration in µg/l (CLCON). Null when the station did not report it.',
              ),
            turbidity_ftu: z
              .number()
              .nullable()
              .describe(
                'Turbidity in Formazin Turbidity Units (TURB). Null when the station did not report it.',
              ),
            ph: z
              .number()
              .nullable()
              .describe('pH, dimensionless (PH). Null when the station did not report it.'),
            redox_mv: z
              .number()
              .nullable()
              .describe(
                'Oxidation-reduction (redox) potential in mV (EH). Null when the station did not report it.',
              ),
          })
          .describe('Water-column sensor readings at a single depth.'),
      )
      .describe(
        'Per-depth readings sharing the most recent observation timestamp, in NDBC source order.',
      ),
  }),

  errors: [
    {
      reason: 'observations_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'NDBC returned 404 for the station — no .ocean oceanographic file exists for it.',
      recovery:
        'Oceanographic sensors are on only a subset of NDBC stations with no station-catalog flag to filter on — browse other NDBC stations with noaa_marine_find_stations using source="ndbc" and try their IDs.',
    },
    {
      reason: 'no_ocean_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'The .ocean file exists but has no usable data rows — station offline or every depth row missing.',
      recovery:
        'This station may be temporarily offline — try another NDBC station from noaa_marine_find_stations with source="ndbc".',
    },
  ],

  async handler(input, ctx) {
    const ndbcSvc = getNdbcService();

    // Station metadata for name/coordinates.
    const stations = await ndbcSvc.getActiveStations(ctx);
    const meta = stations.find((s) => s.id.toUpperCase() === input.station_id.toUpperCase());

    let observation: Awaited<ReturnType<typeof ndbcSvc.fetchOceanObservations>>;
    try {
      observation = await ndbcSvc.fetchOceanObservations(input.station_id, ctx);
    } catch (err) {
      // A missing .ocean file and an existing-but-empty one both surface as NotFound:
      // fetchWithTimeout throws a bare 404 (data.statusCode: 404, no reason) before the
      // service's own check runs, while the service's notFound() for an existing-but-empty
      // file carries data.reason: 'no_ocean_data'. Inspect the reason so an offline station
      // isn't mislabeled as one that serves no ocean data at all.
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        const reason = (err.data as Record<string, unknown> | undefined)?.reason;
        if (reason === 'no_ocean_data') {
          throw ctx.fail(
            'no_ocean_data',
            `NDBC station ${input.station_id} reported no usable oceanographic data — the .ocean file exists but every depth row is missing (station offline or sensor failure).`,
            { ...ctx.recoveryFor('no_ocean_data') },
          );
        }
        throw ctx.fail(
          'observations_not_found',
          `NDBC has no oceanographic (.ocean) file for station ${input.station_id} — sub-surface sensors are on only a subset of NDBC stations. Use noaa_marine_find_stations with source="ndbc" to browse other station IDs to try.`,
          { ...ctx.recoveryFor('observations_not_found') },
        );
      }
      throw err;
    }

    ctx.log.info('NDBC ocean observations fetched', {
      station_id: input.station_id,
      observed_at: observation.observedAt,
      reading_count: observation.readings.length,
    });

    return {
      station_id: input.station_id.toUpperCase(),
      station_name: meta?.name ?? input.station_id,
      latitude: meta?.lat ?? null,
      longitude: meta?.lon ?? null,
      observed_at: observation.observedAt,
      source: 'ndbc',
      reading_count: observation.readings.length,
      readings: observation.readings.map((r) => ({
        depth_m: r.depthM,
        water_temp_c: r.waterTempC,
        conductivity_ms_cm: r.conductivityMsCm,
        salinity_psu: r.salinityPsu,
        oxygen_percent: r.oxygenPercent,
        oxygen_ppm: r.oxygenPpm,
        chlorophyll_ug_l: r.chlorophyllUgL,
        turbidity_ftu: r.turbidityFtu,
        ph: r.ph,
        redox_mv: r.redoxMv,
      })),
    };
  },

  format: (result) => {
    const fmt = (v: number | null, unit: string) => (v !== null ? `${v} ${unit}` : 'not reported');
    const lines: string[] = [
      `## Ocean Observations — ${result.station_name} (${result.station_id})`,
      `**Observed at:** ${result.observed_at} · **Source:** ${result.source} · **Depths:** ${result.reading_count}`,
      `**Location:** ${result.latitude ?? 'unknown'}, ${result.longitude ?? 'unknown'}`,
    ];
    for (const r of result.readings) {
      lines.push(
        '',
        `### Depth ${r.depth_m} m`,
        `Water temp: ${fmt(r.water_temp_c, '°C')} · Conductivity: ${fmt(r.conductivity_ms_cm, 'mS/cm')} · Salinity: ${fmt(r.salinity_psu, 'psu')}`,
        `Oxygen: ${fmt(r.oxygen_percent, '%')} saturation · ${fmt(r.oxygen_ppm, 'ppm')}`,
        `Chlorophyll: ${fmt(r.chlorophyll_ug_l, 'µg/l')} · Turbidity: ${fmt(r.turbidity_ftu, 'FTU')} · pH: ${r.ph ?? 'not reported'} · Redox: ${fmt(r.redox_mv, 'mV')}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

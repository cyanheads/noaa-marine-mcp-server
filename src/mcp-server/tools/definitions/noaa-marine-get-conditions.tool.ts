/**
 * @fileoverview noaa_marine_get_conditions tool — live NDBC buoy marine conditions.
 * @module mcp-server/tools/definitions/noaa-marine-get-conditions.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getNdbcService } from '@/services/ndbc/ndbc-service.js';
import type { NdbcColumnGroup } from '@/services/ndbc/types.js';

/**
 * The output fields each resolved column block fills. The stale-reading notice names these
 * rather than the internal block name, so the caller reads it against the payload it holds.
 */
const GROUP_FIELDS: Record<NdbcColumnGroup, string> = {
  atmosphere: 'pressure_hpa, air_temp_c, dew_point_c',
  tide: 'tide_ft',
  visibility: 'visibility_nmi',
  water: 'water_temp_c',
  wave: 'wave_height_m, dominant_period_sec, average_period_sec, mean_wave_direction_deg',
  wind: 'wind_direction_deg, wind_speed_ms, gust_speed_ms',
};

export const noaaMarineGetConditions = tool('noaa_marine_get_conditions', {
  title: 'Get Marine Conditions',
  description: `Live marine conditions from an NDBC buoy: wave height, period and direction, wind speed, gust and direction, sea-surface temperature, air temperature, barometric pressure, and dew point. All values are SI units — wind in m/s, wave height in m, pressure in hPa, temperatures in °C — except TIDE, which is in feet, and VIS, in nautical miles, both rarely populated at offshore buoys; a numeric field is null when the buoy sensor did not report a value, which is normal offshore. Row cadence varies by station from 5 to 60 minutes, so observed_at can be that old, and NDBC writes each block of columns on its own cycle, so any block can resolve from an earlier row within 90 minutes of observed_at. Waves carry their own waves_observed_at, null when no wave sample falls inside that window, and any other block read from an earlier row is named with its measurement time in the response notice. Use noaa_marine_find_stations with source="ndbc" and types=["met"] to find station IDs near a location, since met-flagged stations are the ones most likely to serve live conditions: roughly a third of active NDBC stations report neither meteorological nor current data, most of those have no observation file, and omitting the types filter surfaces station IDs this tool cannot read.`,
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    station_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,20}$/)
      .describe(
        'NDBC buoy station ID (5-character alphanumeric, e.g. "46041" for Cape Elizabeth). ' +
          'Obtain from noaa_marine_find_stations with source="ndbc" and types=["met"].',
      ),
  }),

  output: z.object({
    station_id: z.string().describe('Station ID echoed from the request — for chaining.'),
    station_name: z.string().describe('Station name from the NDBC active stations list.'),
    latitude: z
      .number()
      .nullable()
      .describe(
        'Station latitude in decimal degrees. Null when the station is absent from the NDBC active-stations list — the realtime feed carries observations but no coordinates.',
      ),
    longitude: z
      .number()
      .nullable()
      .describe(
        'Station longitude in decimal degrees. Null when the station is absent from the NDBC active-stations list.',
      ),
    observed_at: z
      .string()
      .describe(
        'ISO 8601 UTC timestamp of the newest data row. Always a valid instant — a row whose upstream time columns are malformed is rejected rather than timestamped with the current time. A sensor block NDBC wrote on an earlier row was measured before this time: waves report theirs in waves_observed_at, and any other block is named with its own time in the notice.',
      ),
    source: z.string().describe('Data source — always "ndbc" for this tool.'),
    wind_direction_deg: z
      .number()
      .nullable()
      .describe('Wind direction in degrees true (0–360). Null if not reported by the buoy.'),
    wind_speed_ms: z.number().nullable().describe('Wind speed in m/s. Null if not reported.'),
    gust_speed_ms: z.number().nullable().describe('Wind gust speed in m/s. Null if not reported.'),
    wave_height_m: z
      .number()
      .nullable()
      .describe('Significant wave height in meters. Null if not reported.'),
    dominant_period_sec: z
      .number()
      .nullable()
      .describe('Dominant wave period in seconds. Null if not reported.'),
    average_period_sec: z
      .number()
      .nullable()
      .describe('Average wave period in seconds. Null if not reported.'),
    mean_wave_direction_deg: z
      .number()
      .nullable()
      .describe('Mean wave direction in degrees true. Null if not reported.'),
    waves_observed_at: z
      .string()
      .nullable()
      .describe(
        'ISO 8601 UTC timestamp of the row the four wave fields were read from. NDBC runs its wave pass on a slower cycle than the met row, so this can be older than observed_at; it applies to all four wave fields, which are never sampled apart. Null when no wave sample falls inside the 90-minute look-back window, including when the buoy has no wave sensor.',
      ),
    pressure_hpa: z
      .number()
      .nullable()
      .describe('Atmospheric pressure in hPa. Null if not reported.'),
    air_temp_c: z.number().nullable().describe('Air temperature in °C. Null if not reported.'),
    water_temp_c: z
      .number()
      .nullable()
      .describe('Sea-surface temperature in °C. Null if not reported.'),
    dew_point_c: z
      .number()
      .nullable()
      .describe('Dew point temperature in °C. Null if not reported.'),
    visibility_nmi: z
      .number()
      .nullable()
      .describe(
        'Visibility in nautical miles. NOTE: always in nautical miles regardless of other unit settings. Null if not reported.',
      ),
    tide_ft: z
      .number()
      .nullable()
      .describe(
        'Tide height in feet. NOTE: always in feet regardless of other unit settings. Rarely populated at offshore buoys. Null if not reported.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present when a sensor block other than waves was read from a row older than observed_at, naming each such block, the output fields it fills, and the time those values were measured. Absent when every block outside the wave columns came from the newest row.',
      ),
  },

  errors: [
    {
      reason: 'buoy_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'NDBC returned 404 for the station ID.',
      recovery:
        'Find a conditions-capable station with noaa_marine_find_stations using source="ndbc" and types=["met"] — an unfiltered NDBC search returns stations that have no observation file.',
    },
    {
      reason: 'no_sensor_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'Buoy file exists but all sensor fields are MM (missing) — buoy offline or sensor failure.',
      recovery:
        'This station may be temporarily offline — try a nearby one from noaa_marine_find_stations with source="ndbc" and types=["met"].',
    },
  ],

  async handler(input, ctx) {
    const ndbcSvc = getNdbcService();

    // Get station metadata for name/coordinates
    const stations = await ndbcSvc.getActiveStations(ctx);
    const meta = stations.find((s) => s.id.toUpperCase() === input.station_id.toUpperCase());

    let obs: Awaited<ReturnType<typeof ndbcSvc.fetchObservation>>;
    try {
      obs = await ndbcSvc.fetchObservation(input.station_id, ctx);
    } catch (err) {
      // Both a genuine missing buoy and an offline/sensor-failure buoy surface as
      // code NotFound: fetchWithTimeout throws a bare 404 (data.status: 404, no
      // reason) before the service's own check runs, while the service's notFound()
      // for an existing-but-empty file carries data.reason: 'no_sensor_data'. Inspect
      // the reason so a sensorless buoy isn't mislabeled as an invalid station ID.
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        const reason = (err.data as Record<string, unknown> | undefined)?.reason;
        if (reason === 'no_sensor_data') {
          throw ctx.fail(
            'no_sensor_data',
            `NDBC buoy ${input.station_id} reported no usable sensor data — the buoy file exists but every sensor value is missing (buoy offline or sensor failure).`,
            { ...ctx.recoveryFor('no_sensor_data') },
          );
        }
        throw ctx.fail(
          'buoy_not_found',
          `NDBC has no observation file for station ${input.station_id} — use noaa_marine_find_stations with source="ndbc" and types=["met"] to find a conditions-capable station.`,
          { ...ctx.recoveryFor('buoy_not_found') },
        );
      }
      throw err;
    }

    // A block resolved from an earlier row was measured before observed_at. The wave block
    // reports its own age on `output` as waves_observed_at, so only the blocks whose age no
    // output field carries need saying here — that keeps the rule "disclose an age the payload
    // does not already state" rather than an exemption list.
    const undisclosed = obs.staleGroups.filter((g) => g.group !== 'wave');
    if (undisclosed.length > 0) {
      const measured = undisclosed
        .map((g) => `${GROUP_FIELDS[g.group]} at ${g.observedAt}`)
        .join('; ');
      ctx.enrich.notice(
        `Measured before observed_at (${obs.observedAt}) — ${measured}. NDBC writes each block of columns on its own cycle, so a block is read from the most recent row within 90 minutes that carried it.`,
      );
    }

    ctx.log.info('NDBC conditions fetched', {
      station_id: input.station_id,
      observed_at: obs.observedAt,
      stale_groups: obs.staleGroups.map((g) => g.group),
    });

    return {
      station_id: input.station_id.toUpperCase(),
      station_name: meta?.name ?? input.station_id,
      // A station ID is an honest label for a station; a coordinate pair is not — a station
      // with no catalog entry has unknown coordinates, not a position in the Gulf of Guinea.
      latitude: meta?.lat ?? null,
      longitude: meta?.lon ?? null,
      observed_at: obs.observedAt,
      source: 'ndbc',
      wind_direction_deg: obs.windDirectionDeg,
      wind_speed_ms: obs.windSpeedMs,
      gust_speed_ms: obs.gustSpeedMs,
      wave_height_m: obs.waveHeightM,
      dominant_period_sec: obs.dominantPeriodSec,
      average_period_sec: obs.averagePeriodSec,
      mean_wave_direction_deg: obs.meanWaveDirectionDeg,
      waves_observed_at: obs.wavesObservedAt,
      pressure_hpa: obs.pressureHpa,
      air_temp_c: obs.airTempC,
      water_temp_c: obs.waterTempC,
      dew_point_c: obs.dewPointC,
      visibility_nmi: obs.visibilityNmi,
      tide_ft: obs.tideFt,
    };
  },

  format: (result) => {
    const fmt = (v: number | null, unit: string) => (v !== null ? `${v} ${unit}` : 'not reported');

    const lines: string[] = [
      `## Marine Conditions — ${result.station_name} (${result.station_id})`,
      `**Observed at:** ${result.observed_at} · **Source:** ${result.source}`,
      `**Location:** ${result.latitude ?? 'unknown'}, ${result.longitude ?? 'unknown'}`,
      '',
      '### Wind',
      `Direction: ${fmt(result.wind_direction_deg, '°T')} · Speed: ${fmt(result.wind_speed_ms, 'm/s')} · Gust: ${fmt(result.gust_speed_ms, 'm/s')}`,
      '',
      '### Waves',
      `Height: ${fmt(result.wave_height_m, 'm')} · Dominant period: ${fmt(result.dominant_period_sec, 's')} · Avg period: ${fmt(result.average_period_sec, 's')}`,
      `Direction: ${fmt(result.mean_wave_direction_deg, '°T')}`,
      `Sampled at: ${result.waves_observed_at ?? 'not reported'}`,
      '',
      '### Atmospheric',
      `Pressure: ${fmt(result.pressure_hpa, 'hPa')} · Air temp: ${fmt(result.air_temp_c, '°C')} · Dew point: ${fmt(result.dew_point_c, '°C')}`,
      '',
      '### Water',
      `Sea surface temp: ${fmt(result.water_temp_c, '°C')}`,
    ];

    if (result.visibility_nmi !== null) {
      lines.push(`Visibility: ${result.visibility_nmi} nmi`);
    }
    if (result.tide_ft !== null) {
      lines.push(`Tide: ${result.tide_ft} ft`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

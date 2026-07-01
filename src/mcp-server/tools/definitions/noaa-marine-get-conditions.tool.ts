/**
 * @fileoverview noaa_marine_get_conditions tool — live NDBC buoy marine conditions.
 * @module mcp-server/tools/definitions/noaa-marine-get-conditions.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getNdbcService } from '@/services/ndbc/ndbc-service.js';

export const noaaMarineGetConditions = tool('noaa_marine_get_conditions', {
  title: 'Get Marine Conditions',
  description:
    'Live marine conditions from an NDBC buoy: wave height/period/direction, wind speed/gust/direction, ' +
    'sea-surface temperature, air temperature, barometric pressure, and dew point. ' +
    'All values are SI units — wind in m/s, wave height in m, pressure in hPa, temperatures in °C. ' +
    'Exceptions: TIDE is in feet and VIS is in nautical miles (rarely populated at offshore buoys). ' +
    'Numeric fields are null when the buoy sensor did not report a value — this is normal for offshore buoys. ' +
    'Observations are updated approximately every 10 minutes; data may be 10–20 minutes old. ' +
    'Use noaa_marine_find_stations with source="ndbc" to find buoy station IDs near a location.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    station_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,20}$/)
      .describe(
        'NDBC buoy station ID (5-character alphanumeric, e.g. "46041" for Cape Elizabeth). ' +
          'Obtain from noaa_marine_find_stations with source="ndbc".',
      ),
  }),

  output: z.object({
    station_id: z.string().describe('Station ID echoed from the request — for chaining.'),
    station_name: z.string().describe('Station name from the NDBC active stations list.'),
    latitude: z.number().describe('Station latitude in decimal degrees.'),
    longitude: z.number().describe('Station longitude in decimal degrees.'),
    observed_at: z.string().describe('ISO 8601 UTC timestamp of the observation row used.'),
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

  errors: [
    {
      reason: 'buoy_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'NDBC returned 404 for the station ID.',
      recovery:
        'Verify the station ID using noaa_marine_find_stations with source="ndbc" and try again.',
    },
    {
      reason: 'no_sensor_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'Buoy file exists but all sensor fields are MM (missing) — buoy offline or sensor failure.',
      recovery:
        'The buoy may be temporarily offline. Try a nearby buoy via noaa_marine_find_stations.',
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
      // code NotFound: fetchWithTimeout throws a bare 404 (data.statusCode: 404, no
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
          `NDBC buoy ${input.station_id} not found — verify the ID with noaa_marine_find_stations.`,
          { ...ctx.recoveryFor('buoy_not_found') },
        );
      }
      throw err;
    }

    ctx.log.info('NDBC conditions fetched', {
      station_id: input.station_id,
      observed_at: obs.observedAt,
    });

    return {
      station_id: input.station_id.toUpperCase(),
      station_name: meta?.name ?? input.station_id,
      latitude: meta?.lat ?? 0,
      longitude: meta?.lon ?? 0,
      observed_at: obs.observedAt,
      source: 'ndbc',
      wind_direction_deg: obs.windDirectionDeg,
      wind_speed_ms: obs.windSpeedMs,
      gust_speed_ms: obs.gustSpeedMs,
      wave_height_m: obs.waveHeightM,
      dominant_period_sec: obs.dominantPeriodSec,
      average_period_sec: obs.averagePeriodSec,
      mean_wave_direction_deg: obs.meanWaveDirectionDeg,
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
      `**Location:** ${result.latitude}, ${result.longitude}`,
      '',
      '### Wind',
      `Direction: ${fmt(result.wind_direction_deg, '°T')} · Speed: ${fmt(result.wind_speed_ms, 'm/s')} · Gust: ${fmt(result.gust_speed_ms, 'm/s')}`,
      '',
      '### Waves',
      `Height: ${fmt(result.wave_height_m, 'm')} · Dominant period: ${fmt(result.dominant_period_sec, 's')} · Avg period: ${fmt(result.average_period_sec, 's')}`,
      `Direction: ${fmt(result.mean_wave_direction_deg, '°T')}`,
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

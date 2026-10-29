/**
 * @fileoverview noaa_marine_get_conditions tool — live NDBC buoy marine conditions.
 * @module mcp-server/tools/definitions/noaa-marine-get-conditions.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getNdbcService, type NdbcService } from '@/services/ndbc/ndbc-service.js';
import type { NdbcColumnGroup, NdbcObservation } from '@/services/ndbc/types.js';

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

/** A realtime read the handler branches on: an observation, no file, or a file with every sensor MM. */
type ObservationRead =
  | { kind: 'read'; obs: NdbcObservation }
  | { kind: 'missing' }
  | { kind: 'no_sensor_data' };

/**
 * Read a station's realtime file. Both NotFound outcomes come back as results rather than throws:
 * fetchWithTimeout's bare 404 (no file) is `missing`, and the service's notFound() for a file whose
 * every sensor is MM carries data.reason `no_sensor_data` — telling them apart keeps a sensorless
 * buoy from being reported as an invalid ID. Every other failure propagates.
 */
async function readObservation(
  svc: NdbcService,
  stationId: string,
  ctx: Context,
): Promise<ObservationRead> {
  try {
    return { kind: 'read', obs: await svc.fetchObservation(stationId, ctx) };
  } catch (err) {
    if (!(err instanceof McpError) || err.code !== JsonRpcErrorCode.NotFound) throw err;
    const reason = (err.data as Record<string, unknown> | undefined)?.reason;
    return reason === 'no_sensor_data' ? { kind: 'no_sensor_data' } : { kind: 'missing' };
  }
}

export const noaaMarineGetConditions = tool('noaa_marine_get_conditions', {
  title: 'Get Marine Conditions',
  description: `Live marine conditions from an NDBC buoy: wave height, period and direction, wind speed, gust and direction, sea-surface temperature, air temperature, barometric pressure, and dew point. All values are SI units — wind in m/s, wave height in m, pressure in hPa, temperatures in °C — except TIDE, which is in feet, and VIS, in nautical miles, both rarely populated at offshore buoys; a numeric field is null when the buoy sensor did not report a value, which is normal offshore. Row cadence varies by station from 5 to 60 minutes, so observed_at can be that old, and NDBC writes each block of columns on its own cycle, so any block can resolve from an earlier row within 90 minutes of observed_at. Waves carry their own waves_observed_at, null when no wave sample falls inside that window, and any other block read from an earlier row is named with its measurement time in the response notice. Use noaa_marine_find_stations with source="ndbc" and types=["met"] to find station IDs near a location, since met-flagged stations are the ones most likely to serve live conditions: roughly a third of active NDBC stations report neither meteorological nor current data, most of those have no observation file, and omitting the types filter surfaces station IDs this tool cannot read. A 7-digit CO-OPS station ID also works when NDBC relays that gauge's met sensors under a station of its own: the response reads the relay, returns its ID as station_id with its name and coordinates, and returns the requested ID as coops_station_id; a gauge NDBC does not relay fails buoy_not_found.`,
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    station_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,20}$/)
      .describe(
        'NDBC station ID (e.g. "46041" for Cape Elizabeth). Obtain from noaa_marine_find_stations with source="ndbc" and types=["met"]. A 7-digit CO-OPS station ID (e.g. "8654467") also works when NDBC relays that gauge\'s met sensors under a station ID of its own.',
      ),
  }),

  output: z.object({
    station_id: z
      .string()
      .describe(
        "ID of the NDBC station these observations come from: the requested ID, uppercased, or — when a CO-OPS station ID was requested — the NDBC station that relays that gauge's met sensors.",
      ),
    coops_station_id: z
      .string()
      .optional()
      .describe(
        'The CO-OPS station ID that was requested, present only when it was read through the NDBC relay in station_id. Use it with the CO-OPS tools (tides, water level, currents); use station_id for NDBC reads. Absent when station_id is the ID requested.',
      ),
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
        'Present when a CO-OPS station ID was read through its NDBC relay (naming both IDs), when a sensor block other than waves was read from a row older than observed_at (naming each such block, the output fields it fills, and the time those values were measured), or both, in one string. Absent for a station read under its own ID whose blocks outside the wave columns all came from the newest row.',
      ),
  },

  errors: [
    {
      reason: 'buoy_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'NDBC has no observation file for the station ID and no NDBC station relays it as a CO-OPS gauge; the NDBC station relaying the CO-OPS ID has no observation file either; or several NDBC stations relay it and the met flag does not single one out.',
      recovery:
        'Find a conditions-capable station with noaa_marine_find_stations using source="ndbc" and types=["met"] — an unfiltered NDBC search returns stations that have no observation file, and a CO-OPS gauge NDBC does not relay has no conditions here.',
    },
    {
      reason: 'no_sensor_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'Buoy file exists but all sensor fields are MM (missing) — buoy offline or sensor failure. Also raised for the NDBC relay of a CO-OPS station ID, naming both IDs.',
      recovery:
        'This station may be temporarily offline — try a nearby one from noaa_marine_find_stations with source="ndbc" and types=["met"].',
    },
  ],

  async handler(input, ctx) {
    const ndbcSvc = getNdbcService();
    const requestedId = input.station_id.toUpperCase();

    // Get station metadata for name/coordinates
    const stations = await ndbcSvc.getActiveStations(ctx);
    let station = stations.find((s) => s.id.toUpperCase() === requestedId);
    let stationId = requestedId;
    let coopsStationId: string | undefined;

    let read = await readObservation(ndbcSvc, input.station_id, ctx);
    if (read.kind === 'no_sensor_data') {
      throw ctx.fail(
        'no_sensor_data',
        `NDBC buoy ${input.station_id} reported no usable sensor data — the buoy file exists but every sensor value is missing (buoy offline or sensor failure).`,
      );
    }

    if (read.kind === 'missing') {
      // NDBC relays the met sensors of many CO-OPS gauges under a station ID of its own, named
      // after the gauge's number. Only a miss looks for one, so a hit costs no extra request.
      const relays = ndbcSvc.findCoopsRelays(requestedId, stations);
      if (relays.length === 0) {
        throw ctx.fail(
          'buoy_not_found',
          `NDBC has no observation file for station ${input.station_id} — use noaa_marine_find_stations with source="ndbc" and types=["met"] to find a conditions-capable station.`,
        );
      }
      const metRelays = relays.filter((s) => s.hasMet);
      const relay =
        relays.length === 1 ? relays[0] : metRelays.length === 1 ? metRelays[0] : undefined;
      if (!relay) {
        throw ctx.fail(
          'buoy_not_found',
          `CO-OPS station ${requestedId} is relayed by more than one NDBC station (${relays.map((s) => s.id).join(', ')}) and the met flag does not single one out — call this tool with one of those station IDs.`,
        );
      }

      read = await readObservation(ndbcSvc, relay.id, ctx);
      if (read.kind === 'missing') {
        throw ctx.fail(
          'buoy_not_found',
          `NDBC has no observation file for station ${relay.id}, the NDBC relay of CO-OPS station ${requestedId} — use noaa_marine_find_stations with source="ndbc" and types=["met"] to find a conditions-capable station.`,
        );
      }
      if (read.kind === 'no_sensor_data') {
        throw ctx.fail(
          'no_sensor_data',
          `NDBC buoy ${relay.id}, the NDBC relay of CO-OPS station ${requestedId}, reported no usable sensor data — the buoy file exists but every sensor value is missing (buoy offline or sensor failure).`,
        );
      }
      station = relay;
      stationId = relay.id;
      coopsStationId = requestedId;
    }
    const { obs } = read;

    // `notice` is one field, and each write replaces the last, so every sentence joins into one.
    const notices: string[] = [];
    if (coopsStationId !== undefined) {
      notices.push(
        `CO-OPS station ${coopsStationId} read through its NDBC relay ${escapeMarkdownInline(stationId)}.`,
      );
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
      notices.push(
        `Measured before observed_at (${obs.observedAt}) — ${measured}. NDBC writes each block of columns on its own cycle, so a block is read from the most recent row within 90 minutes that carried it.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('NDBC conditions fetched', {
      station_id: stationId,
      coops_station_id: coopsStationId,
      observed_at: obs.observedAt,
      stale_groups: obs.staleGroups.map((g) => g.group),
    });

    return {
      station_id: stationId,
      ...(coopsStationId !== undefined && { coops_station_id: coopsStationId }),
      station_name: station?.name ?? input.station_id,
      // A station ID is an honest label for a station; a coordinate pair is not — a station
      // with no catalog entry has unknown coordinates, not a position in the Gulf of Guinea.
      latitude: station?.lat ?? null,
      longitude: station?.lon ?? null,
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
      `## Marine Conditions — ${escapeMarkdownInline(result.station_name)} (${escapeMarkdownInline(result.station_id)})`,
      `**Observed at:** ${result.observed_at} · **Source:** ${result.source}`,
      `**Location:** ${result.latitude ?? 'unknown'}, ${result.longitude ?? 'unknown'}`,
    ];
    if (result.coops_station_id !== undefined) {
      lines.push(
        `**CO-OPS station:** ${escapeMarkdownInline(result.coops_station_id)} (met sensors relayed by NDBC station ${escapeMarkdownInline(result.station_id)})`,
      );
    }
    lines.push(
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
    );

    if (result.visibility_nmi !== null) {
      lines.push(`Visibility: ${result.visibility_nmi} nmi`);
    }
    if (result.tide_ft !== null) {
      lines.push(`Tide: ${result.tide_ft} ft`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

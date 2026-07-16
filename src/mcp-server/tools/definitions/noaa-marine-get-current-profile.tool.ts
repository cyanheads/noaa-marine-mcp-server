/**
 * @fileoverview noaa_marine_get_current_profile tool — observed depth-binned currents from an NDBC ADCP buoy.
 * @module mcp-server/tools/definitions/noaa-marine-get-current-profile.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getNdbcService } from '@/services/ndbc/ndbc-service.js';

export const noaaMarineGetCurrentProfile = tool('noaa_marine_get_current_profile', {
  title: 'Get Ocean Current Profile',
  description:
    'Observed ocean-current depth profile from an NDBC ADCP buoy: the most recent measurement of ' +
    'current speed and direction at each depth bin. Returns depth in meters, direction in degrees ' +
    'true (the direction the current flows toward), and speed in cm/s. Distinct from ' +
    'noaa_marine_get_currents, which returns CO-OPS tidal-current predictions (forecast max flood/ebb/slack) ' +
    'rather than these observed acoustic-Doppler measurements. A depth bin is reported whenever NDBC ' +
    'gives it a depth; its direction or speed is null when the sensor did not report that component. ' +
    'Use noaa_marine_find_stations with source="ndbc" and types=["current_profile"] to find station IDs — ' +
    'most NDBC stations serve no ADCP profile, so an unfiltered search returns IDs this tool cannot read.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    station_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,20}$/)
      .describe(
        'NDBC station ID (5-character alphanumeric, e.g. "44033"). ' +
          'Obtain from noaa_marine_find_stations with source="ndbc" and types=["current_profile"].',
      ),
  }),

  output: z.object({
    station_id: z.string().describe('Station ID echoed from the request — for chaining.'),
    station_name: z.string().describe('Station name from the NDBC active stations list.'),
    latitude: z
      .number()
      .nullable()
      .describe(
        'Station latitude in decimal degrees. Null when the station is absent from the NDBC active-stations list — the ADCP feed carries current data but no coordinates.',
      ),
    longitude: z
      .number()
      .nullable()
      .describe(
        'Station longitude in decimal degrees. Null when the station is absent from the NDBC active-stations list.',
      ),
    observed_at: z.string().describe('ISO 8601 UTC timestamp of the observation.'),
    source: z.string().describe('Data source — always "ndbc" for this tool.'),
    bin_count: z.number().describe('Number of depth bins in the profile.'),
    bins: z
      .array(
        z
          .object({
            depth_m: z.number().describe('Bin depth below the surface in meters.'),
            direction_deg: z
              .number()
              .nullable()
              .describe(
                'Direction the current flows toward, in degrees true (0–360). Null if not reported for this bin.',
              ),
            speed_cm_s: z
              .number()
              .nullable()
              .describe('Current speed in cm/s. Null if not reported for this bin.'),
          })
          .describe('A single depth-bin current measurement.'),
      )
      .describe('Depth-binned current measurements, shallowest first (NDBC source order).'),
  }),

  errors: [
    {
      reason: 'profile_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'NDBC returned 404 for the station — no ADCP current-profile file exists for it.',
      recovery:
        'Find a current-profile-capable station with noaa_marine_find_stations using source="ndbc" and types=["current_profile"] — most NDBC stations serve no ADCP profile.',
    },
    {
      reason: 'no_current_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'The ADCP file exists but has no usable data rows — profiler offline or every bin missing.',
      recovery:
        'This station may be temporarily offline — try another from noaa_marine_find_stations with source="ndbc" and types=["current_profile"].',
    },
  ],

  async handler(input, ctx) {
    const ndbcSvc = getNdbcService();

    // Station metadata for name/coordinates.
    const stations = await ndbcSvc.getActiveStations(ctx);
    const meta = stations.find((s) => s.id.toUpperCase() === input.station_id.toUpperCase());

    let profile: Awaited<ReturnType<typeof ndbcSvc.fetchCurrentProfile>>;
    try {
      profile = await ndbcSvc.fetchCurrentProfile(input.station_id, ctx);
    } catch (err) {
      // A missing ADCP file and an empty/offline profiler both surface as NotFound:
      // fetchWithTimeout throws a bare 404 (data.statusCode: 404, no reason) before the
      // service's own check runs, while the service's notFound() for an existing-but-empty
      // file carries data.reason: 'no_current_data'. Inspect the reason so an offline
      // profiler isn't mislabeled as a station that serves no ADCP data at all.
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        const reason = (err.data as Record<string, unknown> | undefined)?.reason;
        if (reason === 'no_current_data') {
          throw ctx.fail(
            'no_current_data',
            `NDBC station ${input.station_id} reported no usable current data — the ADCP file exists but every depth bin is missing (profiler offline or sensor failure).`,
            { ...ctx.recoveryFor('no_current_data') },
          );
        }
        throw ctx.fail(
          'profile_not_found',
          `NDBC has no ADCP current-profile file for station ${input.station_id} — use noaa_marine_find_stations with source="ndbc" and types=["current_profile"] to find a current-profile-capable station.`,
          { ...ctx.recoveryFor('profile_not_found') },
        );
      }
      throw err;
    }

    ctx.log.info('NDBC current profile fetched', {
      station_id: input.station_id,
      observed_at: profile.observedAt,
      bin_count: profile.bins.length,
    });

    return {
      station_id: input.station_id.toUpperCase(),
      station_name: meta?.name ?? input.station_id,
      latitude: meta?.lat ?? null,
      longitude: meta?.lon ?? null,
      observed_at: profile.observedAt,
      source: 'ndbc',
      bin_count: profile.bins.length,
      bins: profile.bins.map((b) => ({
        depth_m: b.depthM,
        direction_deg: b.directionDeg,
        speed_cm_s: b.speedCmS,
      })),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Ocean Current Profile — ${result.station_name} (${result.station_id})`,
      `**Observed at:** ${result.observed_at} · **Source:** ${result.source} · **Bins:** ${result.bin_count}`,
      `**Location:** ${result.latitude ?? 'unknown'}, ${result.longitude ?? 'unknown'}`,
      '',
      '| Depth (m) | Direction (°T) | Speed (cm/s) |',
      '|---:|---:|---:|',
    ];
    for (const b of result.bins) {
      const dir = b.direction_deg !== null ? `${b.direction_deg}` : 'not reported';
      const spd = b.speed_cm_s !== null ? `${b.speed_cm_s}` : 'not reported';
      lines.push(`| ${b.depth_m} | ${dir} | ${spd} |`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

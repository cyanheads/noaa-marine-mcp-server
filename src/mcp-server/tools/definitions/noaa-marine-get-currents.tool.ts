/**
 * @fileoverview noaa_marine_get_currents tool — tidal current predictions from CO-OPS.
 * @module mcp-server/tools/definitions/noaa-marine-get-currents.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getCoopsService, isCoopsBodyError } from '@/services/coops/coops-service.js';

function parseDateStr(s: string): Date {
  return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
}

export const noaaMarineGetCurrents = tool('noaa_marine_get_currents', {
  title: 'Get Tidal Currents',
  description:
    'Tidal current predictions for a CO-OPS current station: max flood/ebb speeds, slack times, and directions. ' +
    'Defaults to MAX_SLACK interval — the practical planning view showing when currents peak and when slack water occurs. ' +
    'Optionally returns 6-minute continuous predictions for detailed analysis. ' +
    'Current station IDs use alphanumeric format (e.g. ACT4176), distinct from numeric tide/water-level IDs. ' +
    'Date range is limited to 1 year per request. ' +
    'Use noaa_marine_find_stations with types=["current"] to obtain valid current station IDs.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    station_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,20}$/)
      .describe(
        'CO-OPS current station ID (alphanumeric, e.g. "ACT4176"). ' +
          'Obtain from noaa_marine_find_stations with types=["current"].',
      ),
    begin_date: z
      .string()
      .regex(/^\d{8}$/)
      .describe('Start date in YYYYMMDD format, e.g. "20240601".'),
    end_date: z
      .string()
      .regex(/^\d{8}$/)
      .describe('End date in YYYYMMDD format (inclusive), e.g. "20240607".'),
    time_zone: z
      .enum(['lst_ldt', 'gmt', 'lst'])
      .default('lst_ldt')
      .describe(
        'Time zone for returned timestamps. lst_ldt = local standard/daylight time (default); ' +
          'gmt = UTC; lst = local standard time year-round.',
      ),
    units: z
      .enum(['english', 'metric'])
      .default('english')
      .describe('Unit system: english = knots; metric = m/s.'),
    interval: z
      .enum(['MAX_SLACK', '6min'])
      .default('MAX_SLACK')
      .describe(
        'Prediction interval: MAX_SLACK (default) returns max flood, max ebb, and slack water events — ' +
          'ideal for passage planning. 6min returns a continuous current curve.',
      ),
  }),

  output: z.object({
    station_id: z.string().describe('Station ID echoed from the request — for chaining.'),
    station_name: z.string().describe('Station name as returned by CO-OPS.'),
    units: z.string().describe('Speed units: "english" (knots) or "metric" (m/s).'),
    events: z
      .array(
        z
          .object({
            time: z.string().describe('Event datetime in the requested time zone.'),
            type: z
              .enum(['flood', 'ebb', 'slack'])
              .describe(
                'Current event type: flood (onshore/inbound flow), ebb (offshore/outbound flow), or slack (near-zero current).',
              ),
            speed: z
              .number()
              .optional()
              .describe('Current speed in the requested units. Absent for slack events.'),
            direction: z
              .number()
              .optional()
              .describe('True bearing direction in degrees (0–360). Absent for slack events.'),
          })
          .describe('A single max flood, max ebb, or slack current event.'),
      )
      .optional()
      .describe('Max flood, max ebb, and slack events. Present for MAX_SLACK interval.'),
    predictions: z
      .array(
        z
          .object({
            time: z.string().describe('Prediction datetime in the requested time zone.'),
            speed: z.number().describe('Current speed in the requested units.'),
            direction: z
              .number()
              .nullable()
              .describe(
                'True bearing direction in degrees (0–360). Null when CO-OPS does not report direction for this station type.',
              ),
          })
          .describe('A single 6-minute current prediction.'),
      )
      .optional()
      .describe('6-minute continuous current predictions. Present for 6min interval.'),
  }),

  errors: [
    {
      reason: 'station_not_found',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'CO-OPS returned an error for the station ID — current stations require alphanumeric IDs.',
      recovery:
        'Use noaa_marine_find_stations with types=["current"] to obtain a valid current station ID like ACT4176.',
    },
    {
      reason: 'date_range_exceeded',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Requested date range exceeds the 1-year CO-OPS limit.',
      recovery: 'Split the request into multiple calls each spanning at most 1 year.',
    },
    {
      reason: 'no_predictions',
      code: JsonRpcErrorCode.NotFound,
      when: 'Station exists but CO-OPS returned no current-prediction data for the date range.',
      recovery:
        'The station may be inactive or not a prediction station. Try a different station from noaa_marine_find_stations.',
    },
  ],

  async handler(input, ctx) {
    const begin = parseDateStr(input.begin_date);
    const end = parseDateStr(input.end_date);
    const diffDays = (end.getTime() - begin.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays > 365) {
      throw ctx.fail(
        'date_range_exceeded',
        `Date range of ${Math.ceil(diffDays)} days exceeds the 1-year limit.`,
        { ...ctx.recoveryFor('date_range_exceeded') },
      );
    }

    const svc = getCoopsService();

    // Fetch station list (for name resolution) and predictions in parallel.
    // CO-OPS currents_predictions API does not return station metadata — station list is best-effort.
    const [currentStations, predResult] = await Promise.allSettled([
      svc.getStations('currentpredictions', ctx),
      svc.fetchCurrentPredictions(
        {
          station: input.station_id,
          begin_date: input.begin_date,
          end_date: input.end_date,
          time_zone: input.time_zone,
          units: input.units,
          interval: input.interval,
        },
        ctx,
      ),
    ]);

    const stationMeta =
      currentStations.status === 'fulfilled'
        ? currentStations.value.find((s) => s.id === input.station_id)
        : undefined;

    if (predResult.status === 'rejected') {
      const err = predResult.reason;
      // CO-OPS body-level errors carry a typed coopsReason — map to contract reasons.
      if (isCoopsBodyError(err)) {
        if (err.coopsReason === 'no_predictions') {
          throw ctx.fail(
            'no_predictions',
            `No current prediction data for station ${input.station_id} — the station may be inactive or not a prediction station.`,
            { ...ctx.recoveryFor('no_predictions') },
          );
        }
        // station_error or no_data → station_not_found
        throw ctx.fail(
          'station_not_found',
          `CO-OPS does not have current data for station ${input.station_id} — use noaa_marine_find_stations with types=["current"] to find a valid station.`,
          { ...ctx.recoveryFor('station_not_found') },
        );
      }
      // CO-OPS HTTP 400 — invalid station ID before response body is parsed.
      if (err instanceof McpError) {
        const statusCode = (err.data as Record<string, unknown> | undefined)?.statusCode;
        if (statusCode === 400) {
          throw ctx.fail(
            'station_not_found',
            `CO-OPS rejected station ${input.station_id} — current stations need alphanumeric IDs. Use noaa_marine_find_stations with types=["current"].`,
            { ...ctx.recoveryFor('station_not_found') },
          );
        }
      }
      throw err;
    }

    const result = predResult.value;

    if (input.interval === 'MAX_SLACK') {
      const raw = result.events ?? [];
      if (raw.length === 0) {
        throw ctx.fail(
          'no_predictions',
          `No current predictions for station ${input.station_id} in the date range.`,
          { ...ctx.recoveryFor('no_predictions') },
        );
      }

      const events = raw.map((e) => {
        const typeRaw = (e.Type ?? '').toLowerCase();
        const type: 'flood' | 'ebb' | 'slack' = typeRaw.includes('flood')
          ? 'flood'
          : typeRaw.includes('ebb')
            ? 'ebb'
            : 'slack';

        const entry: {
          time: string;
          type: 'flood' | 'ebb' | 'slack';
          speed?: number;
          direction?: number;
        } = {
          time: e.Time,
          type,
        };
        if (e.Velocity_Major) {
          const speed = Number.parseFloat(e.Velocity_Major);
          if (!Number.isNaN(speed)) entry.speed = Math.abs(speed);
        }
        const dirStr =
          type === 'flood' ? e.meanFloodDir : type === 'ebb' ? e.meanEbbDir : undefined;
        if (dirStr) {
          const dir = Number.parseFloat(dirStr);
          if (!Number.isNaN(dir)) entry.direction = dir;
        }
        return entry;
      });

      ctx.log.info('Current predictions (MAX_SLACK) fetched', {
        station_id: input.station_id,
        event_count: events.length,
      });

      return {
        station_id: input.station_id,
        station_name: stationMeta?.name ?? result.stationName,
        units: input.units,
        events,
      };
    }

    // 6-min interval
    const raw6 = result.predictions ?? [];
    if (raw6.length === 0) {
      throw ctx.fail(
        'no_predictions',
        `No 6-min current predictions for station ${input.station_id} in the date range.`,
        { ...ctx.recoveryFor('no_predictions') },
      );
    }

    const predictions = raw6.map((p) => ({
      time: p.Time,
      speed: Math.abs(Number.parseFloat(p.Velocity_Major ?? '0')),
      direction: p.Direction != null ? Number.parseFloat(p.Direction) : null,
    }));

    ctx.log.info('Current predictions (6min) fetched', {
      station_id: input.station_id,
      count: predictions.length,
    });

    return {
      station_id: input.station_id,
      station_name: stationMeta?.name ?? result.stationName,
      units: input.units,
      predictions,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Tidal Currents — ${result.station_name} (${result.station_id})`,
      `**Units:** ${result.units}`,
      '',
    ];

    if (result.events && result.events.length > 0) {
      lines.push(`**Events** (${result.events.length} max/slack events):`);
      for (const e of result.events) {
        const speed =
          e.speed !== undefined ? ` ${e.speed} ${result.units === 'metric' ? 'm/s' : 'kt'}` : '';
        const dir = e.direction !== undefined ? ` @${e.direction}°` : '';
        lines.push(`${e.time}: ${e.type}${speed}${dir}`);
      }
    }

    if (result.predictions && result.predictions.length > 0) {
      lines.push(`**6-min predictions** (${result.predictions.length} records):`);
      const toShow = result.predictions.slice(0, 10);
      for (const p of toShow) {
        const dirStr = p.direction != null ? ` @${p.direction}°` : '';
        lines.push(`${p.time}: ${p.speed} ${result.units === 'metric' ? 'm/s' : 'kt'}${dirStr}`);
      }
      if (result.predictions.length > 10) {
        lines.push(`... and ${result.predictions.length - 10} more`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

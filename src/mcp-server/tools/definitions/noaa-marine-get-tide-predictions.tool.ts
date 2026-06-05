/**
 * @fileoverview noaa_marine_get_tide_predictions tool — high/low tide predictions from CO-OPS.
 * @module mcp-server/tools/definitions/noaa-marine-get-tide-predictions.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCoopsService } from '@/services/coops/coops-service.js';

/** Parse YYYYMMDD → Date for range validation. */
function parseDateStr(s: string): Date {
  return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
}

export const noaaMarineGetTidePredictions = tool('noaa_marine_get_tide_predictions', {
  title: 'Get Tide Predictions',
  description:
    'High/low tide predictions for a CO-OPS tide station over a date range. ' +
    'Returns time, height, and tide type (H=high, L=low) for each event when using the default hilo interval, ' +
    'or 6-minute interval predictions for a detailed tide curve. ' +
    'Datum defaults to MLLW (mean lower low water — standard for US nautical charts). ' +
    'Date range is limited to 1 year per request; split longer ranges across multiple calls. ' +
    'Use noaa_marine_find_stations first to resolve a station name or location to a numeric station ID.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    station_id: z
      .string()
      .describe(
        'CO-OPS tide station ID (numeric, e.g. "9447130" for Seattle). ' +
          'Obtain from noaa_marine_find_stations with types=["tide"].',
      ),
    begin_date: z
      .string()
      .regex(/^\d{8}$/)
      .describe('Start date in YYYYMMDD format, e.g. "20240601".'),
    end_date: z
      .string()
      .regex(/^\d{8}$/)
      .describe('End date in YYYYMMDD format (inclusive), e.g. "20240607".'),
    datum: z
      .enum(['MLLW', 'MHHW', 'MSL', 'MTL', 'MHW', 'MLW', 'CD', 'STND'])
      .default('MLLW')
      .describe(
        'Tidal datum reference plane. MLLW (default) is the US nautical chart datum. ' +
          'MSL = mean sea level; MHHW = mean higher high water (flooding reference).',
      ),
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
      .describe('Unit system for heights: english = feet; metric = meters.'),
    interval: z
      .enum(['hilo', '6min'])
      .default('hilo')
      .describe(
        'Prediction interval: hilo (default) returns only high and low tide events; ' +
          '6min returns a continuous prediction curve at 6-minute intervals.',
      ),
  }),

  output: z.object({
    station_id: z.string().describe('Station ID echoed from the request — for chaining.'),
    station_name: z
      .string()
      .describe('Station name as returned by CO-OPS — confirms the correct station was queried.'),
    datum: z
      .string()
      .describe('Tidal datum used (e.g. MLLW) — echoed for correct interpretation of heights.'),
    units: z.string().describe('Height units: "english" (feet) or "metric" (meters).'),
    predictions: z
      .array(
        z
          .object({
            time: z
              .string()
              .describe(
                'Prediction datetime in the requested time zone (YYYY-MM-DD HH:MM format).',
              ),
            height: z
              .number()
              .describe(
                'Predicted water height in the requested units (feet or meters) relative to the datum.',
              ),
            type: z
              .string()
              .optional()
              .describe('Tide type: H = high tide, L = low tide (only present for hilo interval).'),
          })
          .describe('A single tide prediction event.'),
      )
      .describe('Tide predictions for the requested date range.'),
  }),

  errors: [
    {
      reason: 'station_not_found',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'CO-OPS returned an error for the station ID — likely wrong type or invalid ID.',
      recovery:
        'Use noaa_marine_find_stations with types=["tide"] to obtain a valid tide station ID.',
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
      when: 'Station exists but CO-OPS returned no prediction data for the date range.',
      recovery:
        'The station may be inactive or not a prediction station. Try a different station ID from noaa_marine_find_stations.',
    },
  ],

  async handler(input, ctx) {
    // Validate date range ≤ 1 year
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
    let result: {
      predictions: Array<{ t: string; v: string; type?: string }>;
      stationName: string;
    };

    try {
      result = await svc.fetchTidePredictions(
        {
          station: input.station_id,
          begin_date: input.begin_date,
          end_date: input.end_date,
          datum: input.datum,
          time_zone: input.time_zone,
          units: input.units,
          interval: input.interval,
        },
        ctx,
      );
    } catch (err) {
      // CO-OPS station errors surface as ServiceUnavailable with message containing "error:"
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('CO-OPS error:')) {
        throw ctx.fail('station_not_found', `CO-OPS rejected station ${input.station_id}: ${msg}`, {
          ...ctx.recoveryFor('station_not_found'),
        });
      }
      throw err;
    }

    if (!result.predictions || result.predictions.length === 0) {
      throw ctx.fail(
        'no_predictions',
        `No predictions returned for station ${input.station_id} in the requested date range.`,
        { ...ctx.recoveryFor('no_predictions') },
      );
    }

    const predictions = result.predictions.map((p) => {
      const entry: { time: string; height: number; type?: string } = {
        time: p.t,
        height: Number.parseFloat(p.v),
      };
      if (p.type) entry.type = p.type;
      return entry;
    });

    ctx.log.info('Tide predictions fetched', {
      station_id: input.station_id,
      count: predictions.length,
      interval: input.interval,
    });

    return {
      station_id: input.station_id,
      station_name: result.stationName,
      datum: input.datum,
      units: input.units,
      predictions,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Tide Predictions — ${result.station_name} (${result.station_id})`,
      `**Datum:** ${result.datum} · **Units:** ${result.units}`,
      '',
    ];

    for (const p of result.predictions) {
      const typeStr = p.type
        ? ` [${p.type === 'H' ? 'HIGH' : p.type === 'L' ? 'LOW' : p.type}]`
        : '';
      lines.push(`${p.time}${typeStr}: ${p.height} ${result.units === 'metric' ? 'm' : 'ft'}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
